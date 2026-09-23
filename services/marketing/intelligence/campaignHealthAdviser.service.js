// services/marketing/intelligence/campaignHealthAdviser.service.js
//
// THE CAMPAIGN HEALTH ADVISER: EVIDENCE IN, A CHECKED EXPLANATION OUT.
//
// ── THE ORDER IS THE SAFETY ────────────────────────────────────────────────
//   1. Read the performance GRAV already has. No channel is contacted.
//   2. Calculate the evidence, deterministically. No model is involved.
//   3. Not enough settled data? Stop. No model call, no tokens, no analysis.
//   4. Already answered this exact question? Return the stored answer.
//   5. Only now ask the model, through the gateway, which checks the packet,
//      the ceiling and the allow-list before anything leaves the process.
//   6. Validate the answer against a schema GRAV wrote.
//   7. Check every citation against evidence GRAV supplied.
//   8. Check every sentence for a claim GRAV will not make in its own voice.
//   9. Only then store it, and supersede whatever it replaces.
//
// Step 3 is before step 5 because an explanation of two days of noise is still
// an explanation somebody acts on. Step 4 is before step 5 because the same
// question asked twice should not cost twice.
//
// ── AND NOTHING THE MODEL SAYS CAN DO ANYTHING ─────────────────────────────
// This service imports no write client, no deployment service, no Sales model
// and no campaign-plan mutator. The result is words and citations. The most it
// can produce is a suggestion that a person looks at something.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../../storePurchase/errors");
const gateway = require("../../ai/gravAiGateway.service");
const evidenceEvaluator = require("./campaignHealthEvidence");
const reportService = require("../performance/campaignReport.service");
const identity = require("./analysisIdentity");
const {
  MarketingCampaignAnalysis,
  MarketingCampaignAnalysisDismissal,
} = require("../../../models/CMS_Models/Marketing/MarketingCampaignAnalysis");
const {
  OPERATION,
  PROMPT_VERSION,
  SYSTEM_PROMPT,
  ALLOWED_RECOMMENDATION_CODES,
  FORBIDDEN_RECOMMENDATION_CODES,
  FORBIDDEN_PHRASES,
  CONFIDENCE_CODES,
  WINDOW,
  HEALTH_CODES: H,
} = require("../../../constants/marketingCampaignHealth");

const str = (v) => String(v ?? "").trim();

const assertCompany = (companyId) => {
  const raw = str(companyId);
  if (!mongoose.Types.ObjectId.isValid(raw)) {
    throw fail("VALIDATION", "An analysis belongs to a company.", { field: "companyId" });
  }
  return new mongoose.Types.ObjectId(raw);
};

/* ═══════════════════════════════════════════════════════════════════════════
   VALIDATING WHAT THE MODEL SAID
   ───────────────────────────────────────────────────────────────────────────
   Structural first, then semantic. A model that returned the right shape with
   a forbidden action inside it has passed every JSON check ever written, so the
   shape is where this starts and not where it ends.
   ═══════════════════════════════════════════════════════════════════════════ */

const isText = (v, max) => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function validate(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "malformed_output", detail: "not an object" };
  }

  /* ── EXACTLY THESE KEYS ────────────────────────────────────────────────
     An extra key is refused rather than ignored. A model that added
     `suggestedBudget` has decided to answer a different question, and quietly
     dropping it would hide that it tried. */
  const allowed = new Set([
    "headline", "summary", "observations", "recommendations",
    "confidence", "uncertainty", "missingInformation", "evidenceReferences",
  ]);
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extra.length) {
    return { ok: false, reason: "malformed_output", detail: `unexpected: ${extra.join(", ")}` };
  }

  if (!isText(raw.headline, 200)) return { ok: false, reason: "malformed_output", detail: "headline" };
  if (!isText(raw.summary, 2000)) return { ok: false, reason: "malformed_output", detail: "summary" };
  if (!CONFIDENCE_CODES.includes(str(raw.confidence))) {
    return { ok: false, reason: "malformed_output", detail: "confidence" };
  }
  if (raw.uncertainty !== undefined && raw.uncertainty !== null && typeof raw.uncertainty !== "string") {
    return { ok: false, reason: "malformed_output", detail: "uncertainty" };
  }

  /* ── EVERY STATEMENT CITES SOMETHING ───────────────────────────────────
     The ids are checked against GRAV's own list by the gateway; what is checked
     here is that there ARE any. A statement citing nothing is an assertion, and
     an assertion is what the whole design exists to prevent. */
  const checkCited = (list, what, typed) => {
    if (!Array.isArray(list)) return { ok: false, reason: "malformed_output", detail: what };
    for (const item of list) {
      if (!item || typeof item !== "object") return { ok: false, reason: "malformed_output", detail: what };
      if (!isText(item.text, 600)) return { ok: false, reason: "malformed_output", detail: `${what}.text` };
      if (!Array.isArray(item.evidenceRefs) || !item.evidenceRefs.length) {
        return { ok: false, reason: "malformed_output", detail: `${what}.evidenceRefs` };
      }
      if (typed) {
        const type = str(item.type);
        /* ── A FORBIDDEN ACTION REJECTS THE WHOLE ANSWER ────────────────
           Not just the offending recommendation. A model that proposed pausing
           a campaign has misunderstood its role, and the paragraphs around that
           suggestion were written under the same misunderstanding. */
        if (FORBIDDEN_RECOMMENDATION_CODES.includes(type)) {
          return { ok: false, reason: "forbidden_output", detail: type };
        }
        if (!ALLOWED_RECOMMENDATION_CODES.includes(type)) {
          return { ok: false, reason: "forbidden_output", detail: `unknown type: ${type}` };
        }
      }
    }
    return { ok: true };
  };

  const obs = checkCited(raw.observations, "observations", false);
  if (!obs.ok) return obs;
  const recs = checkCited(raw.recommendations, "recommendations", true);
  if (!recs.ok) return recs;

  if (raw.missingInformation !== undefined) {
    if (!Array.isArray(raw.missingInformation)
      || raw.missingInformation.some((m) => typeof m !== "string" || m.length > 300)) {
      return { ok: false, reason: "malformed_output", detail: "missingInformation" };
    }
  }

  /* ── AND NO CLAIM GRAV WILL NOT MAKE IN ITS OWN VOICE ──────────────────
     The type allow-list catches a forbidden ACTION. This catches a forbidden
     CLAIM, which arrives inside ordinary prose and passes every structural
     check: "this will improve conversions" is a promise, and "the decline is
     caused by creative fatigue" is a causal claim two periods of aggregates
     cannot support.

     Conservative on purpose. A false positive costs one regenerated analysis; a
     false negative is GRAV publishing a promise in its own product. */
  const prose = [
    raw.headline, raw.summary, str(raw.uncertainty),
    ...(raw.observations || []).map((o) => o.text),
    ...(raw.recommendations || []).map((r) => r.text),
  ].join("\n");

  for (const phrase of FORBIDDEN_PHRASES) {
    if (phrase.test(prose)) {
      return { ok: false, reason: "forbidden_output", detail: "a claim GRAV does not make" };
    }
  }

  return {
    ok: true,
    value: {
      headline: raw.headline.trim(),
      summary: raw.summary.trim(),
      observations: raw.observations.map((o) => ({
        text: o.text.trim(),
        evidenceRefs: o.evidenceRefs.map(str),
      })),
      recommendations: raw.recommendations.map((r) => ({
        type: str(r.type),
        text: r.text.trim(),
        evidenceRefs: r.evidenceRefs.map(str),
      })),
      confidence: str(raw.confidence),
      uncertainty: str(raw.uncertainty),
      missingInformation: (raw.missingInformation || []).map(str),
    },
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
   THE CAPABILITY
   ═══════════════════════════════════════════════════════════════════════════ */

/** What GRAV knows about this plan's health, without asking anybody. */
async function current({ companyId, plan, env = process.env }, deps = {}) {
  const company = assertCompany(companyId);

  const analysis = await MarketingCampaignAnalysis.findOne({
    companyId: company,
    campaignDraftId: plan._id,
    approvedRevision: plan.revision,
    status: "current",
  }).lean();

  const available = gateway.availability(OPERATION, env);
  const { report, evidence } = await assemble({ companyId: company, plan, deps });

  return {
    /* ── THREE DIFFERENT "NO"s, AND THEY ARE NOT THE SAME ────────────────
       Intelligence is not set up. There is not enough data. Nobody has asked
       yet. Each leads somewhere different, and collapsing them sends somebody
       to check a key that was fine. */
    intelligenceAvailable: available.available === true,
    intelligenceUnavailableReason: available.available ? null : available.reason,
    evidenceSufficient: evidence.sufficient === true,
    evidenceMessage: evidence.sufficient ? null : evidence.message,
    freshness: report?.freshness || null,
    analysis: analysis ? publicAnalysis(analysis, company, env) : null,
    generatedAt: analysis?.generatedAt || null,
    /* Present so a screen can say "this explains figures from last Tuesday"
       rather than implying it is live. */
    analysisIsOfCurrentEvidence: Boolean(analysis)
      && evidence.sufficient
      && analysis.inputFingerprint === evidence.fingerprint
      && analysis.promptVersion === PROMPT_VERSION,
  };
}

/* The performance report and the evidence derived from it. Shared by the read
   and the generate paths so they cannot disagree about whether there is enough
   data. */
async function assemble({ companyId, plan, deps }) {
  const endDate = deps.endDate || new Date().toISOString().slice(0, 10);
  const startDate = deps.startDate
    || new Date(Date.parse(`${endDate}T00:00:00Z`) - (WINDOW.LOOKBACK_DAYS - 1) * 86400000)
      .toISOString().slice(0, 10);

  const report = await reportService.report({
    companyId, campaignDraftId: plan._id, draftRef: plan.draftRef, startDate, endDate,
  });

  const evidence = evidenceEvaluator.evaluate({
    report,
    plan: {
      objective: plan.objective,
      approvedRevision: plan.revision,
      state: plan.state,
    },
  });

  return { report, evidence };
}

/**
 * Ask for an explanation — or return the one that already answers this.
 *
 * Generation is an explicit user action. Nothing here runs on a page load or on
 * a performance refresh: a model call is a cost and a rate limit, and a
 * dashboard that generates on render is how an allowance disappears before
 * anybody has read anything.
 */
async function generate({ companyId, plan, user, env = process.env }, deps = {}) {
  const company = assertCompany(companyId);

  /* ── 1 AND 2. FIGURES, THEN EVIDENCE. NO MODEL YET. ───────────────────── */
  const { report, evidence } = await assemble({ companyId: company, plan, deps });

  /* ── 3. NOT ENOUGH SETTLED DATA IS A COMPLETE ANSWER ──────────────────── */
  if (!evidence.sufficient) {
    return {
      generated: false,
      reused: false,
      reason: H.INSUFFICIENT_COVERAGE,
      evidenceSufficient: false,
      message: evidence.message,
      freshness: report?.freshness || null,
      analysis: null,
      /* Stated so nobody wonders whether tokens were spent finding this out. */
      modelCalled: false,
    };
  }

  /* ── 4. THE SAME QUESTION, ALREADY ANSWERED ───────────────────────────── */
  const existing = await MarketingCampaignAnalysis.findOne({
    companyId: company,
    campaignDraftId: plan._id,
    approvedRevision: plan.revision,
    inputFingerprint: evidence.fingerprint,
    promptVersion: PROMPT_VERSION,
    status: "current",
  }).lean();

  if (existing) {
    return {
      generated: false,
      reused: true,
      evidenceSufficient: true,
      freshness: report?.freshness || null,
      analysis: publicAnalysis(existing, company, env),
      generatedAt: existing.generatedAt,
      modelCalled: false,
      means: "The figures have not changed since this was written, so GRAV reused it rather than asking again.",
    };
  }

  /* ── 5. THE MODEL, THROUGH THE GATEWAY ────────────────────────────────
     Which checks the operation, the configuration, today's allowance, the
     packet's contents and its size — in that order — before anything leaves the
     process. */
  const answer = await gateway.run({
    companyId: company,
    operation: OPERATION,
    packet: { ...evidence.packet, __systemPrompt: SYSTEM_PROMPT },
    evidenceIds: evidence.evidenceIds,
    validate,
  }, { ...deps, env });

  if (!answer.ok) {
    /* Calm. Ordinary Marketing is unaffected, and the wording is GRAV's. */
    return {
      generated: false,
      reused: false,
      evidenceSufficient: true,
      reason: answer.reason,
      message: answer.message,
      freshness: report?.freshness || null,
      analysis: null,
      modelCalled: !["not_configured", "limit_reached", "unsafe_input", "input_too_large", "operation_unknown"]
        .includes(answer.reason),
      usage: answer.usage || null,
    };
  }

  /* ── 9. STORE IT, AND SUPERSEDE WHAT IT REPLACES ──────────────────────── */
  const stored = await store({
    company, plan, evidence, report, answer, user,
  });

  return {
    generated: true,
    reused: false,
    evidenceSufficient: true,
    freshness: report?.freshness || null,
    analysis: publicAnalysis(stored, company, env),
    generatedAt: stored.generatedAt,
    modelCalled: true,
    usage: answer.usage,
  };
}

/* ── ONE CURRENT ANALYSIS, AND A TRAIL BEHIND IT ────────────────────────────
   The previous current row is superseded first, then the new one is written —
   in that order, because the unique partial index allows exactly one `current`
   per plan revision and a failure between the two leaves zero rather than two.
   Zero is a screen that says "generate one"; two is a screen showing
   contradictory advice with nothing saying which to believe. */
async function store({ company, plan, evidence, report, answer, user }) {
  const previous = await MarketingCampaignAnalysis.findOneAndUpdate(
    {
      companyId: company,
      campaignDraftId: plan._id,
      approvedRevision: plan.revision,
      status: "current",
    },
    { $set: { status: "superseded", supersededAt: new Date() } },
    { new: false },
  );

  const created = await MarketingCampaignAnalysis.create({
    companyId: company,
    campaignDraftId: plan._id,
    draftRef: plan.draftRef,
    approvedRevision: plan.revision,
    inputFingerprint: evidence.fingerprint,
    evidencePacket: evidence.packet,
    evidenceIds: evidence.evidenceIds,
    performanceFreshness: {
      code: str(report?.freshness?.code),
      observedAt: report?.freshness?.observedAt || null,
    },
    provider: answer.provider,
    model: answer.model,
    promptVersion: answer.promptVersion,
    ...answer.result,
    tokenUsage: answer.usage,
    generatedAt: new Date(),
    requestedBy: {
      id: new mongoose.Types.ObjectId(String(user?.id)),
      name: str(user?.name),
      role: str(user?.role),
      at: new Date(),
    },
    status: "current",
  });

  if (previous) {
    await MarketingCampaignAnalysis.updateOne(
      { _id: previous._id, companyId: company },
      { $set: { supersededBy: created._id } },
    );
  }

  return created.toObject();
}

/**
 * Record that a person rejected a recommendation, and why.
 *
 * ── THE REASON IS REQUIRED AND IS FREE TEXT ────────────────────────────────
 * §9 requires evaluation to include harmful recommendations, not only accepted
 * ones. An enum of dismissal reasons would collect the ones somebody
 * anticipated, and the useful signal is always the one nobody did.
 */
async function dismiss({ companyId, plan, analysisId, recommendationType = "", reason, user, env = process.env }) {
  const company = assertCompany(companyId);

  if (!str(reason)) {
    throw fail("VALIDATION",
      "Dismissing a suggestion needs a reason. GRAV keeps them so the assistant can be judged on what it got wrong, not only on what people accepted.",
      { field: "reason", code: H.REASON_REQUIRED });
  }

  const { analysisId: internal } = identity.decodeAnalysisId(analysisId, { companyId: str(company) }, env);

  const analysis = await MarketingCampaignAnalysis.findOne({
    _id: internal, companyId: company, campaignDraftId: plan._id,
  });
  if (!analysis) {
    throw fail("NOT_FOUND", "That analysis could not be found.", { field: "analysisId", code: H.ANALYSIS_NOT_FOUND });
  }

  /* Append-only, always — even for an analysis already superseded or already
     dismissed. A second dismissal is a second person's opinion, and both are
     evidence. */
  await MarketingCampaignAnalysisDismissal.create({
    companyId: company,
    analysisId: analysis._id,
    campaignDraftId: plan._id,
    approvedRevision: analysis.approvedRevision,
    recommendationType: str(recommendationType),
    reason: str(reason).slice(0, 1000),
    actor: {
      id: new mongoose.Types.ObjectId(String(user?.id)),
      name: str(user?.name),
      role: str(user?.role),
      at: new Date(),
    },
    at: new Date(),
    dismissedHeadline: analysis.headline,
    promptVersion: analysis.promptVersion,
    model: analysis.model,
  });

  /* The row's own status moves only if it was the current one. A superseded
     analysis stays superseded: it was already replaced, and marking it
     dismissed would lose which of the two things happened. */
  if (analysis.status === "current") {
    await MarketingCampaignAnalysis.updateOne(
      { _id: analysis._id, companyId: company, status: "current" },
      { $set: { status: "dismissed" } },
    );
  }

  return {
    dismissed: true,
    means: "Recorded. This suggestion will not be shown as current, and the reason is kept so the assistant can be judged on it.",
  };
}

/** A limited history: what was said, when, under which prompt. */
async function history({ companyId, plan, limit = 10, env = process.env }) {
  const company = assertCompany(companyId);

  const rows = await MarketingCampaignAnalysis
    .find({ companyId: company, campaignDraftId: plan._id })
    .sort({ generatedAt: -1 })
    .limit(Math.min(Math.max(Number(limit) || 10, 1), 50))
    .lean();

  const dismissals = await MarketingCampaignAnalysisDismissal
    .find({ companyId: company, campaignDraftId: plan._id })
    .sort({ at: -1 })
    .limit(50)
    .lean();

  const byAnalysis = new Map();
  for (const d of dismissals) {
    const key = String(d.analysisId);
    if (!byAnalysis.has(key)) byAnalysis.set(key, []);
    byAnalysis.get(key).push({
      at: d.at, by: d.actor?.name || "", reason: d.reason,
      recommendationType: d.recommendationType || null,
    });
  }

  return {
    analyses: rows.map((r) => ({
      analysisId: identity.encodeAnalysisId({ companyId: str(company), analysisId: str(r._id) }, env),
      approvedRevision: r.approvedRevision,
      headline: r.headline,
      confidence: r.confidence,
      status: r.status,
      generatedAt: r.generatedAt,
      /* Which instruction produced it. Two analyses under different prompt
         versions are not comparable, and a history that hid that would invite
         somebody to compare them. */
      promptVersion: r.promptVersion,
      recommendationTypes: (r.recommendations || []).map((x) => x.type),
      dismissals: byAnalysis.get(String(r._id)) || [],
    })),
  };
}

/* ── THE PUBLIC VIEW ────────────────────────────────────────────────────────
   Field by field. No database id, no raw packet internals beyond the facts
   themselves, no provider error, no key. The model and prompt version DO travel:
   a reader judging an explanation is entitled to know what wrote it. */
function publicAnalysis(doc, companyId, env = process.env) {
  return {
    analysisId: identity.encodeAnalysisId({ companyId: str(companyId), analysisId: str(doc._id) }, env),
    approvedRevision: doc.approvedRevision,
    headline: doc.headline,
    summary: doc.summary,
    observations: (doc.observations || []).map((o) => ({ text: o.text, evidenceRefs: o.evidenceRefs })),
    recommendations: (doc.recommendations || []).map((r) => ({
      type: r.type, text: r.text, evidenceRefs: r.evidenceRefs,
    })),
    confidence: doc.confidence,
    uncertainty: doc.uncertainty || "",
    missingInformation: doc.missingInformation || [],
    /* The facts behind it, so a reader can check a sentence against the number
       it cites rather than taking the sentence's word for it. */
    evidence: doc.evidencePacket?.deployments || [],
    performanceFreshness: doc.performanceFreshness || null,
    generatedAt: doc.generatedAt,
    status: doc.status,
    producedBy: { model: doc.model, promptVersion: doc.promptVersion },
    /* Tokens, never money. */
    usage: doc.tokenUsage || null,
    /* Stated on every analysis: this is a suggestion that somebody looks at
       something, and nothing here changed anything. */
    changedAnything: false,
    canActOnItsOwn: false,
  };
}

module.exports = {
  current,
  generate,
  dismiss,
  history,
  publicAnalysis,
  /* Exported for the suites that prove the validation without a model. */
  __internals: { validate, assemble },
};
