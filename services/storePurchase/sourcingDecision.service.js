// services/storePurchase/sourcingDecision.service.js
//
// STORE'S SOURCING DECISIONS, AND THE QUEUE OF ONES STILL TO MAKE.
//
// ── THE OWNERSHIP THIS MOVES ────────────────────────────────────────────────
// Several quotations can price the same requirement. Choosing between them
// weighs lead time, capacity, quality history, terms and the relationship —
// every one of which is Store's, and none of which is in a rate. The choice
// was being made in Central Costing because that is where the ambiguity became
// visible; visibility is not ownership.
//
// So Costing REPORTS the ambiguity and Store RESOLVES it. Costing then reads
// the resolution and gets on with arithmetic, which is the only thing it was
// ever supposed to be doing.
//
// ── ONE AUTHORITY, TWO READERS ──────────────────────────────────────────────
// The queue below does not have its own idea of what is ambiguous. It runs the
// SAME assembly a costing runs and collects the gaps it reports. A second
// implementation would be a second answer to "is this decided", and the only
// way to discover they disagreed would be a costing that stayed blocked while
// Store's screen said it was done.
//
// ── AND IT NEVER PICKS ──────────────────────────────────────────────────────
// Nothing here sorts candidates, marks one recommended, or breaks a tie. The
// cheapest quotation is not the right one often enough to automate, and a
// default is a decision with nobody's name on it.
"use strict";

const mongoose = require("mongoose");

const SourcingDecision = require("../../models/CMS_Models/Inventory/Sourcing/SourcingDecision");
const { fail } = require("./errors");

const str = (v) => String(v ?? "").trim();
const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

/**
 * The gap keys the assembly uses for "several quotations apply".
 *
 * Read from the assembly's own vocabulary rather than re-spelled, so a family
 * that gains a quotation register appears in this queue by existing rather
 * than by somebody remembering to add it here.
 */
const CHOICE_PREFIXES = Object.freeze([
  "quotation:",          // materials and packaging
  "service-quotation:",  // outside services and development bought outside
  "freight-quotation:",  // a lane with more than one carrier
]);

/**
 * A gap Store can actually answer.
 *
 * ── WHY THE THRESHOLD IS ONE, NOT TWO ───────────────────────────────────────
 * "Several quotations apply" is the obvious case, and the first version of
 * this required two candidates. That was wrong in the case that matters most:
 * a decision goes stale — the chosen quotation is withdrawn — and only one
 * candidate is left. Requiring two filtered that gap out of the queue, so
 * Store was never asked, while the costing went on refusing.
 *
 * The assembly only emits one of these when it could NOT resolve the
 * requirement itself. So any quotation gap carrying a candidate is an open
 * decision by construction, and counting them is a second opinion about
 * something the assembly already decided.
 *
 * A gap with NO candidates stays out: "nobody has quoted this" is a job for
 * whoever writes quotations, not a choice between them.
 */
const isChoiceGap = (m) =>
  Boolean(m && m.lineKey)
  && CHOICE_PREFIXES.some((p) => String(m.key || "").startsWith(p))
  && Array.isArray(m.candidates) && m.candidates.length >= 1;

/**
 * Which register a line key belongs to, and what its subject is.
 *
 * ── DERIVED FROM THE KEY, NOT SENT ──────────────────────────────────────────
 * The assembly mints these keys from the record it read, so the key already
 * carries the subject. Taking the subject from the request instead would let a
 * caller claim a decision about one item is about another — and the offer they
 * then chose would be validated against the subject they named rather than the
 * one the costing needs.
 */
const SUBJECTS = Object.freeze([
  { test: /^mat:/, kind: "MATERIAL", offerKind: "SUPPLIER_OFFER" },
  { test: /^pkg:/, kind: "PACKAGING", offerKind: "SUPPLIER_OFFER" },
  { test: /^dev:/, kind: "DEVELOPMENT", offerKind: "SERVICE_SUPPLIER_OFFER" },
  { test: /^svc:/, kind: "SERVICE", offerKind: "SERVICE_SUPPLIER_OFFER" },
  { test: /^freight:/, kind: "FREIGHT", offerKind: "FREIGHT_OFFER" },
]);

const kindOfLineKey = (lineKey) =>
  SUBJECTS.find((s) => s.test.test(String(lineKey || ""))) || null;

function assertContext(ctx) {
  if (!ctx || !ctx.companyId) {
    throw fail("VALIDATION", "A sourcing decision needs a company context.", {
      reason: "COMPANY_CONTEXT_REQUIRED",
    });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * WHAT CENTRAL COSTING READS
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * The active decisions for one costing, as `{ [lineKey]: offerId }`.
 *
 * ── THE SAME SHAPE `quotationChoices` HAD, AND THAT IS DELIBERATE ───────────
 * The assembly already knew how to consume a map of line keys to offer ids,
 * and — crucially — already revalidated every one of them against the live
 * register at the costing's own quantities before using it. That check is the
 * whole of the invalidation contract, and it was written for a map the browser
 * sent. Feeding it a map Store recorded changes where the decision comes from
 * without changing what happens to a stale one.
 *
 * So: a decision naming a quotation that is no longer applicable does not
 * price anything. It comes back as an unresolved gap, owned by Store, with the
 * current candidates attached — which is precisely what "becomes unresolved,
 * not silently substituted" means.
 */
async function decisionsFor(ctx, costingId) {
  assertContext(ctx);
  if (!isId(costingId)) return {};
  const rows = await SourcingDecision.find({
    companyId: oid(ctx.companyId),
    costingId: oid(costingId),
    state: "ACTIVE",
  }).lean();
  return Object.fromEntries(rows.map((r) => [r.lineKey, String(r.offerId)]));
}

/** The decisions themselves, for a screen that shows who chose what and when. */
async function decisionRecordsFor(ctx, costingId) {
  assertContext(ctx);
  if (!isId(costingId)) return [];
  return SourcingDecision.find({
    companyId: oid(ctx.companyId),
    costingId: oid(costingId),
    state: "ACTIVE",
  }).sort({ decidedAt: -1 }).lean();
}

/* ══════════════════════════════════════════════════════════════════════════
 * WHAT STORE DECIDES
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Record Store's choice for one requirement.
 *
 * ── THE OFFER IS PROVED AGAINST THE REQUIREMENT, NOT ACCEPTED ───────────────
 * The caller sends a costing, a line key and an offer id. Everything else —
 * which subject that line is about, whether the offer applies to it, what
 * quantity it was judged at, who is deciding — is established here, from the
 * assembly and the session.
 *
 * An offer that is not among the candidates the assembly would offer is
 * refused. Otherwise this would be a way to attach any quotation in the
 * register to any line: the costing would then re-validate it and report an
 * unresolved gap, so nothing wrong would be CALCULATED — but Store would have
 * a screen saying the decision was made and a costing saying it was not.
 */
async function record(ctx, { costingId, lineKey, offerId, note = "" } = {}) {
  assertContext(ctx);

  const key = str(lineKey);
  if (!key) {
    throw fail("VALIDATION", "Say which requirement this decision is for.", {
      field: "lineKey", reason: "LINE_KEY_REQUIRED",
    });
  }
  if (!isId(offerId)) {
    throw fail("VALIDATION", "Choose a quotation.", {
      field: "offerId", reason: "OFFER_ID_REQUIRED",
    });
  }
  const kind = kindOfLineKey(key);
  if (!kind) {
    throw fail("VALIDATION", "That is not a requirement a quotation can be chosen for.", {
      field: "lineKey", reason: "LINE_KEY_UNKNOWN", lineKey: key,
    });
  }

  /* ── THE OPEN DECISION, AS THE COSTING SEES IT ─────────────────────────
     Re-derived here rather than trusted from the request: the candidate list
     is a fact about the register at this moment, and one the browser was
     shown some time ago. */
  const open = await openDecisionsForCosting(ctx, costingId);
  const gap = open.decisions.find((d) => d.lineKey === key);
  if (!gap) {
    throw fail(
      "SOURCING_DECISION_NOT_OPEN",
      "This requirement is not waiting for a sourcing decision. It may have been decided already, or the costing may have changed.",
      { reason: "NOT_OPEN", lineKey: key, costingId: str(costingId) },
    );
  }

  const candidate = gap.candidates.find((c) => String(c.offerId) === str(offerId));
  if (!candidate) {
    throw fail(
      "SOURCING_DECISION_OFFER_NOT_APPLICABLE",
      "That quotation does not apply to this requirement at these quantities.",
      {
        reason: "OFFER_NOT_APPLICABLE",
        lineKey: key,
        offerId: str(offerId),
        applicable: gap.candidates.map((c) => String(c.offerId)),
      },
    );
  }

  /* Supersede rather than overwrite: who chose what, and what it was changed
     to, is the part of a sourcing decision an auditor asks about. */
  await SourcingDecision.updateMany(
    { companyId: oid(ctx.companyId), costingId: oid(costingId), lineKey: key, state: "ACTIVE" },
    { $set: { state: "WITHDRAWN" } },
  );

  return SourcingDecision.create({
    companyId: oid(ctx.companyId),
    costingId: oid(costingId),
    lineKey: key,
    subject: { ...(gap.subject || {}), kind: kind.kind },
    offerId: oid(offerId),
    offerKind: kind.offerKind,
    context: {
      judgedQuantity: str(gap.judged?.quantity),
      judgedUom: str(gap.judged?.uom),
      asOf: gap.judged?.asOf || null,
      currency: str(candidate.currency),
      offerRevision: candidate.revision ?? null,
      quotationReference: str(candidate.quotationReference),
      supplierName: str(candidate.supplierName),
      candidateCount: gap.candidates.length,
    },
    state: "ACTIVE",
    /* From the session. Never from the body. */
    decidedByActorId: str(ctx.actorId),
    decidedByActorName: str(ctx.actorName),
    decidedAt: new Date(),
    note: str(note).slice(0, 500),
  });
}

/**
 * Take a decision back.
 *
 * Not a delete: the costing goes back to reporting the requirement as
 * unresolved, and the withdrawn row stays readable beside whatever replaces
 * it. A supplier choice that was reversed is a thing people ask about.
 */
async function withdraw(ctx, { costingId, lineKey } = {}) {
  assertContext(ctx);
  const key = str(lineKey);
  const res = await SourcingDecision.updateMany(
    { companyId: oid(ctx.companyId), costingId: oid(costingId), lineKey: key, state: "ACTIVE" },
    { $set: { state: "WITHDRAWN" } },
  );
  if (!res.modifiedCount) {
    throw fail("SOURCING_DECISION_NOT_FOUND", "There is no active decision for that requirement.", {
      reason: "NOT_FOUND", lineKey: key,
    });
  }
  return { withdrawn: res.modifiedCount };
}

/* ══════════════════════════════════════════════════════════════════════════
 * THE QUEUE
 * ═════════════════════════════════════════════════════════════════════════ */

/**
 * Every gap in one costing that is waiting for a sourcing decision.
 *
 * ── RUN THROUGH THE ASSEMBLY, NOT A QUERY ───────────────────────────────────
 * "Which requirements have several applicable quotations" is not answerable
 * from any collection: it depends on the technical record, the run sizes, the
 * effective dates, the units, the minimums and the tiers, all resolved
 * together. The assembly is the thing that resolves them, so the queue asks
 * it — and cannot therefore disagree with the costing about what is open.
 */
async function openDecisionsForCosting(ctx, costingId, { costing = null } = {}) {
  assertContext(ctx);
  const Costing = require("../../models/CMS_Models/Costing/Costing");
  const doc = costing || await Costing.findOne({
    _id: oid(costingId), companyId: oid(ctx.companyId),
  }).lean();
  /* Missing and foreign are the same answer, as everywhere else — a company
     may not learn which costing ids are real by asking about them. */
  if (!doc) {
    throw fail("SOURCING_DECISION_COSTING_NOT_FOUND", "That costing is not available.", {
      reason: "NOT_FOUND",
    });
  }

  const assembly = require("../centralCosting/assembly.service");
  const policyService = require("../centralCosting/policy.service");
  const scenarios = await scenariosFor(ctx, doc);

  let assembled;
  try {
    const { policy } = await policyService.getPolicy(ctx);
    assembled = await assembly.assembleLines(ctx, doc, {
      styleId: null,
      policy,
      scenarios,
      /* ── THE QUEUE ASKS WHAT IS OPEN ──────────────────────────────────
         Reading the decisions in would resolve them and report nothing —
         right for a costing, useless for the screen whose job is to show
         them. So this reads NONE, and the decisions already recorded are
         fetched separately below and matched against what came back. A gap
         that reappears with a decision against it is a stale one, and saying
         which is most of what this screen is for. */
      sourcingDecisionsFor: async () => ({}),
    });
  } catch (err) {
    /* A costing with no technical record yet has no requirements to source,
       which is a fact about the costing rather than an error here. */
    if (err?.code === "COSTING_AWAITING_SOURCE") {
      return { costing: doc, decisions: [], unavailable: err.code };
    }
    throw err;
  }

  const decided = await decisionRecordsFor(ctx, doc._id);
  const byLine = new Map(decided.map((d) => [d.lineKey, d]));

  const decisions = (assembled.missing || [])
    .filter(isChoiceGap)
    .map((m) => ({
      lineKey: m.lineKey,
      key: m.key,
      kind: kindOfLineKey(m.lineKey)?.kind || null,
      description: m.message,
      /* Attached by the assembly, where the line was in hand. */
      subject: m.sourcingSubject || null,
      judged: {
        quantity: m.sourcingSubject?.quantity ?? null,
        uom: m.sourcingSubject?.uom ?? null,
        asOf: m.sourcingSubject?.asOf ?? null,
        /* Which run size the verdict was reached at — a quotation excluded
           for a minimum was excluded at a particular quantity, and a refusal
           that does not say which leaves the reader guessing. */
        scenarioKey: m.judgedAt?.scenarioKey ?? null,
        outputQuantity: m.judgedAt?.outputQuantity ?? null,
      },
      candidates: m.candidates || [],
      excluded: m.excluded || [],
      /* A decision that exists but no longer resolves the gap — see the
         filter below, which is what decides that. */
      staleDecision: byLine.has(m.lineKey)
        ? {
          offerId: String(byLine.get(m.lineKey).offerId),
          supplierName: byLine.get(m.lineKey).context?.supplierName || "",
          decidedByActorName: byLine.get(m.lineKey).decidedByActorName || "",
          decidedAt: byLine.get(m.lineKey).decidedAt || null,
          judgedQuantity: byLine.get(m.lineKey).context?.judgedQuantity || "",
        }
        : null,
    }))
    /* ── A DECISION THAT STILL HOLDS IS NOT AN OPEN ONE ─────────────────
       The assembly above was asked what is open with NO decisions applied,
       so every ambiguous requirement comes back — including the ones Store
       already settled. Matching them up here rather than there is what lets
       this screen tell the two apart:

         · the recorded offer is still among the candidates → settled, and it
           leaves the queue;
         · it is not → the decision has gone stale, the requirement is open
           again, and `staleDecision` says what it was and who made it.

       Which is the difference between "choose again" and "choose again,
       because the quotation you picked in September was withdrawn". */
    .filter((d) => {
      if (!d.staleDecision) return true;
      const stillApplies = d.candidates
        .some((c) => String(c.offerId) === String(d.staleDecision.offerId));
      if (stillApplies) return false;
      return true;
    });

  return { costing: doc, decisions, decided };
}

/* `subjectFromGap` lived here, reconstructing the subject from the assembled
   line. The assembly attaches `sourcingSubject` to the gap itself now — one
   place, where the line is in hand and the kind is already known — so there is
   nothing left to reconstruct, and no second implementation to drift. */

/**
 * The run sizes to judge applicability at.
 *
 * The costing's own latest calculated scenarios, because that is what the
 * costing will be priced for. A costing nobody has costed yet has none, and
 * the assembly then reports candidates without a quantity verdict — which is
 * honest: nothing has been ruled out because nothing has been asked.
 */
async function scenariosFor(ctx, costing) {
  const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
  const latest = await CostingVersion.findOne({
    companyId: oid(ctx.companyId), costingId: costing._id,
  }).sort({ versionNumber: -1 }).lean();
  return (latest?.scenarios || [])
    .map((s) => ({ key: s.key, quantity: s.quantity, isPrimary: s.isPrimary }))
    .filter((s) => s.quantity);
}

/**
 * Every open sourcing decision in the company.
 *
 * ── BOUNDED, AND IT SAYS SO ─────────────────────────────────────────────────
 * Each costing costs an assembly — several register reads and a technical
 * record — so the queue is capped and reports what it did not reach. A screen
 * that silently stopped at fifty would read as "nothing else to do", which is
 * the one thing a work queue must never say falsely.
 */
async function openQueue(ctx, { limit = 25 } = {}) {
  assertContext(ctx);
  const Costing = require("../../models/CMS_Models/Costing/Costing");

  const cap = Math.min(Math.max(Number(limit) || 25, 1), 50);
  /* Only costings somebody could still act on. An approved one is frozen and
     a superseded one is history; neither is waiting for a decision. */
  const costings = await Costing.find({
    companyId: oid(ctx.companyId),
    isArchived: { $ne: true },
    status: { $in: ["DRAFT", "IN_REVIEW"] },
  }).sort({ updatedAt: -1 }).limit(cap + 1).lean();

  const scanned = costings.slice(0, cap);
  const rows = [];
  const unreadable = [];

  for (const costing of scanned) {
    try {
      const { decisions } = await openDecisionsForCosting(ctx, costing._id, { costing });
      for (const d of decisions) {
        rows.push({
          ...d,
          costingId: String(costing._id),
          costingLabel: costing.contextSnapshot?.label || costing.context?.externalKey || "",
        });
      }
    } catch (err) {
      /* One unreadable costing must not empty the queue. */
      unreadable.push({ costingId: String(costing._id), reason: err?.code || "UNREADABLE" });
    }
  }

  return {
    decisions: rows,
    scannedCostings: scanned.length,
    /* Named, not implied. */
    moreCostingsNotScanned: costings.length > cap,
    unreadable,
  };
}

module.exports = {
  CHOICE_PREFIXES,
  kindOfLineKey,
  decisionsFor,
  decisionRecordsFor,
  record,
  withdraw,
  openDecisionsForCosting,
  openQueue,
};
