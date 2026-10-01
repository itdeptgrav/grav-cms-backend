// routes/CMS_Routes/Marketing/campaignIntelligence.js
//   → mounted at /api/cms/marketing
//
// THE CAMPAIGN HEALTH ADVISER.
//
//   GET  /campaign-drafts/:id/health                 what GRAV already knows
//   POST /campaign-drafts/:id/health/generate        ask for an explanation
//   POST /campaign-drafts/:id/health/dismiss         reject one, with a reason
//   GET  /campaign-drafts/:id/health/history         what has been said before
//   GET  /intelligence/usage                         how much allowance is left
//
// ── THE BROWSER NEVER REACHES THE MODEL ────────────────────────────────────
// There is no key in any response, no proxy route, no signed URL and no
// client-side SDK — and no environment-variable name either, because naming
// server infrastructure in an API response is of no use to a marketer and of
// some use to everybody else. A browser talks to GRAV; GRAV talks to the
// gateway; the gateway is the only thing on the Marketing surface that has seen
// the key.
//
// ── GENERATION IS AN EXPLICIT ACT ──────────────────────────────────────────
// Reading costs nothing and contacts nobody. Generating is its own route, its
// own verb and its own authorisation — because a model call has a cost and a
// rate limit, and a dashboard that generates on render is how a day's allowance
// disappears before anybody has read anything.
//
// ── AND NOTHING HERE CAN ACT ───────────────────────────────────────────────
// The adviser produces words and citations. This router imports no deployment
// service, no write client and no Sales model, so the most any answer can
// produce is a suggestion that a person looks at something.
"use strict";

const express = require("express");

const router = express.Router();

const marketingAuth = require("../../../Middlewear/MarketingAuthMiddlewear");
const membership = require("../../../services/companyContext/companyMembership.service");
const { fail } = require("../../../services/storePurchase/errors");
const providerPrivacy = require("../../../services/marketing/providerPrivacy");

const sendError = (res, err) => providerPrivacy.sendMarketingError(res, err);
const handle = providerPrivacy.handleMarketing({ surface: "marketing" });

const drafts = require("../../../services/marketing/campaignDrafts/campaignDraft.service");
const adviser = require("../../../services/marketing/intelligence/campaignHealthAdviser.service");
const gateway = require("../../../services/ai/gravAiGateway.service");
const {
  OPERATION,
  ALLOWED_RECOMMENDATIONS,
  CONFIDENCE_LEVELS,
  COST_POLICY,
} = (() => ({
  ...require("../../../constants/marketingCampaignHealth"),
  COST_POLICY: require("../../../constants/gravAi").COST_POLICY,
}))();

const str = (v) => String(v ?? "").trim();

async function companyFor(req) {
  if (req.__marketingCompanyId) return req.__marketingCompanyId;
  const { companyId } = await membership.resolveCompanyForActor(req.user, {
    requestedCompanyId: null,
    domainLabel: "Marketing",
    fail,
  });
  req.__marketingCompanyId = companyId;
  return companyId;
}

/* ── WHO MAY SPEND THE ALLOWANCE ────────────────────────────────────────────
   Any authenticated Marketing user who may read the plan may ask for its
   explanation. Campaign Health is a marketer-facing feature: restricting
   generation to administrators left the people it was built for able to read
   only whatever an administrator had thought to ask for, which is not the
   feature.

   What holds the cost down is not the role. It is that generation is an
   explicit POST that nothing calls on a page load, that identical evidence
   reuses the stored answer without a second call, and that a per-company daily
   request and token ceiling is checked before anything is transmitted. Those
   are structural; a role check is not, and it was buying nothing the ceilings
   were not already buying.

   Dismissing is not restricted either: the person best placed to say a
   suggestion is wrong is the marketer it was written for, and a dismissal
   trail that only captures administrators captures the wrong half of the
   evidence.

   The usage dashboard STAYS administrator-only. Spending your company's
   allowance on your own campaign is ordinary work; reading every company-wide
   consumption figure is an operator's view. */
const isAdministrator = (user) => Boolean(user?.isAdmin) || ["admin", "ceo"].includes(str(user?.role));

router.use(express.json({ limit: "16kb" }));
router.use(marketingAuth);

const planFor = (companyId, campaignDraftId) => drafts.loadForDeployment({
  companyId, campaignDraftId: str(campaignDraftId),
});

const onlyFields = (body, allowed, what) => {
  const obj = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const unknown = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (unknown.length) {
    throw fail("VALIDATION",
      `${what} accepts ${allowed.join(", ")}. ${unknown.join(", ")} ${unknown.length === 1 ? "is" : "are"} not part of it.`,
      { unknown });
  }
  return obj;
};

/* The vocabulary a screen needs to render without hard-coding anything. */
const vocabulary = () => ({
  recommendationTypes: ALLOWED_RECOMMENDATIONS.map((r) => ({
    code: r.code, label: r.label, means: r.means,
  })),
  confidenceLevels: CONFIDENCE_LEVELS.map((c) => ({ code: c.code, label: c.label, means: c.means })),
});

/**
 * GET /campaign-drafts/:campaignDraftId/health
 *
 * ── READING CONTACTS NOBODY ────────────────────────────────────────────────
 * No model call, no advertising channel, no tokens. It returns the stored
 * explanation, whether one is possible, and whether the one stored still
 * matches today's figures.
 */
router.get("/campaign-drafts/:campaignDraftId/health", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const plan = await planFor(companyId, req.params.campaignDraftId);

  const view = await adviser.current({ companyId, plan });

  return res.json({
    success: true,
    /* ── THREE DIFFERENT "NO"s ─────────────────────────────────────────────
       Not set up, not enough data, and nobody has asked — each leads somewhere
       different, and a screen showing one message for all three sends somebody
       to check a key that was fine. */
    intelligenceAvailable: view.intelligenceAvailable,
    intelligenceUnavailableReason: view.intelligenceUnavailableReason,
    evidenceSufficient: view.evidenceSufficient,
    evidenceMessage: view.evidenceMessage,
    freshness: view.freshness,
    analysis: view.analysis,
    generatedAt: view.generatedAt,
    /* So a screen can say "this explains last week's figures" rather than
       implying it is live. */
    analysisIsOfCurrentEvidence: view.analysisIsOfCurrentEvidence,
    vocabulary: vocabulary(),
    means: "This is what the assistant said last time it was asked. Reading this page asks it nothing and costs nothing.",
    /* Stated on every response. */
    assistantCanChangeAnything: false,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/health/generate
 *
 * Body: `{}` — nothing. A caller cannot supply a model, a prompt, a
 * temperature, a window or any generation setting, because every one of those
 * would turn a narrow, auditable capability into a general one.
 *
 * Open to any authenticated Marketing user who may read the plan. Never runs on
 * a page load; reuses an existing answer when the evidence has not moved; and
 * the per-company daily ceiling is checked before anything is transmitted.
 */
router.post("/campaign-drafts/:campaignDraftId/health/generate", handle(async (req, res) => {
  const companyId = await companyFor(req);

  /* Authorisation is the Marketing membership `marketingAuth` already
     established, plus the company and plan checks in `planFor` below. There is
     no further role gate: see the note above. */
  onlyFields(req.body, [], "Generating an explanation");
  const plan = await planFor(companyId, req.params.campaignDraftId);

  const out = await adviser.generate({ companyId, plan, user: req.user });

  return res.json({
    success: true,
    generated: out.generated,
    /* So a caller can tell "we reused the stored one" from "we asked again",
       which is the difference between a free action and a billed one. */
    reused: out.reused,
    modelCalled: out.modelCalled,
    evidenceSufficient: out.evidenceSufficient,
    reason: out.reason || null,
    /* GRAV's own wording, always. A provider message, status or stack never
       reaches here — it went to the server log. */
    message: out.message || null,
    freshness: out.freshness,
    analysis: out.analysis,
    generatedAt: out.generatedAt || null,
    usage: out.usage || null,
    vocabulary: vocabulary(),
    assistantCanChangeAnything: false,
  });
}));

/**
 * POST /campaign-drafts/:campaignDraftId/health/dismiss
 *
 * Body: `{ analysisId, reason, recommendationType? }`
 *
 * ── THE REASON IS REQUIRED ─────────────────────────────────────────────────
 * §9 requires evaluation to include harmful recommendations, not only accepted
 * ones. A dismissal with no reason records that somebody disagreed and loses
 * the only part worth keeping.
 */
router.post("/campaign-drafts/:campaignDraftId/health/dismiss", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const body = onlyFields(req.body, ["analysisId", "reason", "recommendationType"], "Dismissing a suggestion");
  const plan = await planFor(companyId, req.params.campaignDraftId);

  const out = await adviser.dismiss({
    companyId,
    plan,
    analysisId: str(body.analysisId),
    recommendationType: str(body.recommendationType),
    reason: str(body.reason),
    user: req.user,
  });

  return res.json({ success: true, ...out });
}));

/** GET /campaign-drafts/:campaignDraftId/health/history?limit=… */
router.get("/campaign-drafts/:campaignDraftId/health/history", handle(async (req, res) => {
  const companyId = await companyFor(req);
  const plan = await planFor(companyId, req.params.campaignDraftId);

  const out = await adviser.history({ companyId, plan, limit: req.query.limit });

  return res.json({
    success: true,
    ...out,
    means: "Every explanation the assistant has given for this plan, and every reason somebody gave for rejecting one.",
  });
}));

/**
 * GET /intelligence/usage
 *
 * ── TOKENS, NOT MONEY ──────────────────────────────────────────────────────
 * Provider pricing changes independently of this software. A hard-coded rate
 * would be wrong the week it changed, and a figure labelled in rupees that is
 * wrong is worse than an honest token count.
 */
router.get("/intelligence/usage", handle(async (req, res) => {
  const companyId = await companyFor(req);

  if (!isAdministrator(req.user)) {
    throw fail("FORBIDDEN", "Assistant usage is an administrator's view.");
  }

  const usage = await gateway.usageFor({ companyId, operation: OPERATION });
  const available = gateway.availability(OPERATION);

  return res.json({
    success: true,
    intelligenceAvailable: available.available === true,
    intelligenceUnavailableReason: available.available ? null : available.reason,
    operation: OPERATION,
    date: usage.date,
    used: usage.used,
    limits: usage.limits,
    requestsRemaining: usage.requestsRemaining,
    tokensRemaining: usage.tokensRemaining,
    withinLimits: usage.withinLimits,
    estimatedCurrencyCost: null,
    costMeans: COST_POLICY.why,
  });
}));

const BODY_PARSER_TYPES = new Set(["entity.parse.failed", "entity.too.large"]);

router.use((err, req, res, next) => {
  if (!err || !BODY_PARSER_TYPES.has(err.type)) return next(err);
  return sendError(res, fail("VALIDATION",
    err.type === "entity.too.large"
      ? "That request was too large."
      : "That request body could not be read as JSON."));
});

module.exports = router;
