"use strict";
/**
 * services/centralCosting/lifecycle.service.js
 *
 * Central Costing — Chunk 6A. THE ONLY PLACE A VERSION'S STATUS MOVES.
 *
 * ── WHY ONE SERVICE AND NOT A ROUTE HANDLER ─────────────────────────────────
 * A lifecycle transition is four writes that have to agree: the version's
 * status, the version's lifecycle record, the immutable evidence, and — on an
 * approval — the parent's approved-version pointer and the previous approved
 * version's supersession. Scattered across routers, any one of them could be
 * added later without the others, and the failure would be a costing that
 * says APPROVED with no approver on it, or two versions both claiming to be
 * the current commercial one.
 *
 * So the routers ask this file, and this file is the only caller of
 * `beginLifecycleTransition`. Grepping for that name finds exactly one answer
 * to "what can change a costing's status".
 *
 * ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
 * It never calculates. Not a subtotal, not a price, not a margin. Approval
 * PUBLISHES a figure the engine computed when the version was created and
 * froze; it does not recompute one from today's masters, because a version
 * approved in September must not quietly become a different number in October
 * when a supplier's rate changes. `assertStillApprovable` re-reads the frozen
 * facts to confirm they are intact and complete — that is a check, not a
 * recalculation, and it is the difference between "this is still the number
 * you reviewed" and "here is a new number nobody reviewed".
 */

const crypto = require("crypto");
const mongoose = require("mongoose");

const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingTransition = require("../../models/CMS_Models/Costing/CostingTransition");
const { fail } = require("../storePurchase/errors");

const { VERSION_TRANSITIONS, beginLifecycleTransition } = CostingVersion;

/* ── STABLE REFUSAL CODES ────────────────────────────────────────────────────
 * Named constants rather than literals, because a client branches on these and
 * a typo in one router would be a refusal nobody could handle. Each says what
 * is wrong in a way the person reading it can act on. */
const CODES = Object.freeze({
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  /* The transition is not one this state offers — DRAFT → APPROVED asks to
     skip a review that is the whole point of the lifecycle. */
  INVALID_TRANSITION: "COSTING_INVALID_TRANSITION",
  /* The version moved under the caller since they read it. */
  VERSION_STATE_CONFLICT: "COSTING_VERSION_STATE_CONFLICT",
  /* Somebody else's approval landed first and this one would create a second
     current approved version. */
  APPROVAL_RACE: "COSTING_APPROVAL_CONFLICT",
  NOTE_REQUIRED: "COSTING_APPROVAL_NOTE_REQUIRED",
  NOT_CALCULATED: "COSTING_VERSION_NOT_CALCULATED",
  POLICY_REQUIRED: "COSTING_POLICY_REQUIRED",
  FROZEN_FACTS_INCOMPLETE: "COSTING_FROZEN_FACTS_INCOMPLETE",
  /* Chunk 4C — a cost family nobody has answered. Distinct from
     FROZEN_FACTS_INCOMPLETE, which is about a missing PRICE. */
  COST_INCOMPLETE: "COSTING_COST_INCOMPLETE",
  /* The deployment cannot give this operation atomicity, so it is refused
     BEFORE anything is written rather than attempted in pieces. Retryable:
     the same request against a replica set succeeds unchanged. */
  TRANSACTION_REQUIRED: "COSTING_APPROVAL_TRANSACTION_REQUIRED",
  /* One key, two different requests. */
  KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
});

const notFound = () => fail(CODES.NOT_FOUND, "That costing was not found.");


/** The shortest note that is a reason rather than a keystroke. */
const MIN_NOTE = 8;

/**
 * Is this move one the lifecycle offers at all?
 *
 * Refused by NAME, so a caller learns it asked for something impossible
 * instead of watching a write succeed and change nothing.
 */
function assertTransitionAllowed(from, to) {
  const allowed = VERSION_TRANSITIONS[from] || [];
  if (!allowed.includes(to)) {
    throw fail(
      CODES.INVALID_TRANSITION,
      `A ${String(from).toLowerCase().replace("_", " ")} version cannot move straight to ${String(to).toLowerCase().replace("_", " ")}.`,
      { from, to, allowed },
    );
  }
}

/**
 * Is the FROZEN version still a thing that can be approved?
 *
 * ── A CHECK, NOT A RECALCULATION ────────────────────────────────────────────
 * Everything read here is the version's own stored content: whether the engine
 * ran, whether it produced the scenarios and prices being approved, and which
 * policy revision it was calculated against. Nothing consults today's item
 * rates, today's supplier prices or today's policy — a version approved in
 * September must be the number that was reviewed, not a fresh one computed
 * from October's masters and presented as though somebody had looked at it.
 *
 * The check exists because a version CAN be incomplete: a draft created before
 * a policy existed, or one whose calculation failed, is frozen and unusable,
 * and approving it would publish an empty price break as a commercial answer.
 */
/**
 * Was every cost family addressed on THIS FROZEN VERSION?
 *
 * ── THE FROZEN SNAPSHOT, NEVER TODAY'S MASTERS ─────────────────────────────
 * Read from `version.completeness` and nothing else. Re-assessing against live
 * policy or supplier data would mean a version that was complete when it was
 * submitted could fail approval because somebody changed a policy in between —
 * or, worse, an incomplete one could pass because a master moved. Approval
 * judges the thing being approved.
 *
 * ── AND A VERSION FROZEN BEFORE THIS EXISTED IS NOT COMPLETE ───────────────
 * Absent is not complete. A version calculated before coverage was assessed
 * was never assessed, and letting it through would make the rule optional for
 * exactly the versions nobody has checked. It is refused with a different
 * reason, because the fix is different: recalculate, do not hunt for a gap.
 */
function assertCostCoverage(version, { operation }) {
  const c = version.completeness;
  if (!c) {
    throw fail(
      CODES.COST_INCOMPLETE,
      "This version was calculated before cost completeness was recorded, so it cannot be "
      + "reviewed or approved as a complete cost. Calculate it again to assess it.",
      { reason: "COMPLETENESS_NOT_RECORDED", operation, outstanding: [] },
    );
  }
  if (c.costComplete === true) return;

  const outstanding = (c.families || [])
    .filter((f) => f.state === "NEEDS_INPUT" || f.state === "SOURCE_UNAVAILABLE")
    .map((f) => ({ key: f.key, label: f.label, state: f.state, reason: f.reason || null }));

  /* ── EVERY GAP, IN ONE RESPONSE ───────────────────────────────────────
     Not the first one found. Being told about packaging, fixing it, and then
     being told about freight is how a submission takes five attempts. */
  throw fail(
    CODES.COST_INCOMPLETE,
    outstanding.length === 1
      ? `This costing cannot be reviewed yet: ${outstanding[0].label.toLowerCase()} has not been addressed.`
      : `This costing cannot be reviewed yet: ${outstanding.length} cost families have not been addressed.`,
    { reason: "COST_BUILD_INCOMPLETE", operation, outstanding },
  );
}

function assertStillApprovable(version) {
  const scenarios = version.scenarios || [];
  const calculated = Boolean(version.calculation?.engineVersion)
    && scenarios.some((s) => s.unitCostMinor !== undefined && s.unitCostMinor !== null);
  if (!calculated) {
    throw fail(
      CODES.NOT_CALCULATED,
      "This version has not been calculated, so there is no price to approve.",
    );
  }
  if (!version.policySnapshot) {
    throw fail(
      CODES.POLICY_REQUIRED,
      "This version was calculated with no company costing policy, so no selling price was produced.",
    );
  }
  if (!scenarios.length) {
    throw fail(CODES.FROZEN_FACTS_INCOMPLETE, "This version has no quantities to price.");
  }

  /* ── EVERY SCENARIO, NOT "AT LEAST ONE" ─────────────────────────────────
     The first version accepted a version where ANY scenario carried a
     minimum price. Approval publishes ALL of them, so a two-quantity costing
     could go out with one quantity priced and the other empty — and an empty
     price break reads on the Sales side as "priced at nothing" rather than
     "not priced". Approval either publishes a complete commercial answer or
     publishes nothing.

     A stored zero stays valid: a policy may legitimately permit it, and
     `present()` is what separates it from a figure nobody produced. */
  const seen = new Set();
  const problems = [];

  /* ── ONE CURRENCY, AND IT MUST BE THE ONE THAT WAS PRICED ────────────────
     Prices inherit the version's `baseCurrency`, so the only way they can be
     inconsistent is for the version and the policy it was calculated against
     to disagree — which would mean the margins that produced these prices
     were the rules for different money. */
  const currency = version.baseCurrency;
  const policyCurrency = version.policySnapshot?.baseCurrency;
  if (!currency) {
    problems.push({ reason: "VERSION_CURRENCY_MISSING" });
  } else if (policyCurrency && String(policyCurrency) !== String(currency)) {
    problems.push({
      reason: "CURRENCY_MISMATCH", currency, policyCurrency,
    });
  }

  for (const sc of scenarios) {
    const where = sc.key || "(unnamed)";
    if (!sc.key) problems.push({ scenario: where, reason: "SCENARIO_KEY_MISSING" });
    else if (seen.has(sc.key)) problems.push({ scenario: where, reason: "SCENARIO_KEY_DUPLICATE" });
    seen.add(sc.key);

    /* The cost the price was built on. A price with no unit cost behind it
       cannot be checked against anything. */
    if (!safeMinor(sc.unitCostMinor)) {
      problems.push({ scenario: where, reason: "UNIT_COST_MISSING" });
    }

    /* ── WHICH PRICE THIS VERSION HAS IS A FACT ABOUT THE VERSION ────
       A version priced under the markup policy carries one floor; one frozen
       under the retired band carries three tiers. Checked by asking which it
       HAS rather than by preferring one: demanding a floor from a version
       approved in March would make a historical record unpublishable, and
       demanding tiers from a new one would demand prices the company no
       longer calculates. */
    if (sc.floor) {
      if (!safeMinor(sc.floor.floorPriceMinor)) {
        problems.push({ scenario: where, reason: "FLOOR_PRICE_MISSING" });
      }
      /* A floor with no markup behind it cannot be checked against the
         decision that set it. */
      if (!sc.floor.floorMarkupPercent) {
        problems.push({ scenario: where, reason: "FLOOR_MARKUP_MISSING" });
      }
      /* ── AND IT MUST NOT CARRY BOTH ───────────────────────────────
         A version holding a floor AND a band offers two different answers to
         "what is this priced at", and whichever a reader picked would be
         defensible. Refused here rather than left to the reader. */
      if (sc.prices?.minimum || sc.prices?.target || sc.prices?.preferred) {
        problems.push({ scenario: where, reason: "PRICING_CONTRACT_AMBIGUOUS" });
      }
      continue;
    }

    for (const tier of ["minimum", "target", "preferred"]) {
      const p = sc.prices?.[tier];
      if (!p || !safeMinor(p.priceMinor)) {
        problems.push({ scenario: where, reason: `PRICE_MISSING`, tier });
        continue;
      }
      /* ── A PRICE CARRIES NO CURRENCY OF ITS OWN ────────────────────
         `priceSchema` has `requestedMarginPercent`, `priceMinor` and
         `effectiveMarginPercent` — and nothing else. A per-price currency
         check read a field that does not exist, so it was dead code that
         could never fire, and the test written for it passed against an
         undefined value.

         The currency consistency that IS available is checked once below,
         where it is a real fact the frozen version carries. */
    }
  }

  if (problems.length) {
    throw fail(
      CODES.FROZEN_FACTS_INCOMPLETE,
      "This version's calculated selling prices are incomplete, so there is nothing safe to publish.",
      { problems: problems.slice(0, 20), scenarios: scenarios.length },
    );
  }

  return { policyRevision: version.policySnapshot.revision ?? 0 };
}

/* Minor units are integers and must stay exactly summable — beyond 2^53
   addition silently stops being exact, and a price that cannot be summed is
   not a price. Missing is not zero, and zero is not missing. */
const safeMinor = (v) =>
  v !== null && v !== undefined && typeof v === "number" && Number.isSafeInteger(v);

/** The version, in this company, by id — or the one indistinguishable 404. */
async function loadVersion({ companyId, costingId, versionId, session = null }) {
  if (!mongoose.Types.ObjectId.isValid(String(versionId))) throw notFound();
  const q = CostingVersion.findOne({
    companyId,
    costingId,
    _id: new mongoose.Types.ObjectId(String(versionId)),
  });
  if (session) q.session(session);
  const version = await q;
  /* A version in another company, a version of another costing and a version
     that never existed are ONE answer. A 403 for a foreign id confirms the id
     exists, which is the disclosure the company boundary exists to prevent. */
  if (!version) throw notFound();
  return version;
}

/** One transition record. Append-only; the model refuses everything else. */
const recordTransition = (doc, session) =>
  (session
    ? CostingTransition.create([doc], { session }).then((r) => r[0])
    : CostingTransition.create(doc));

/* ── EVERY LIFECYCLE WRITE IS TRANSACTIONAL, OR IT DOES NOT HAPPEN ══════════
 *
 * ── CORRECTING WHAT THIS FILE PREVIOUSLY CLAIMED ────────────────────────────
 * The first version said the ordering made a crash "survivable". It did not.
 * Two things were wrong and both could expose partial commercial state:
 *
 *   · SUBMIT saved the version as IN_REVIEW and created the evidence
 *     afterwards. A failure between them left a version in review with no
 *     immutable record of anybody having submitted it — which is precisely
 *     the "decision and state must agree" rule this service exists to keep.
 *   · APPROVE wrote supersede → approve → pointer → evidence. A failure after
 *     the second step left an APPROVED version that every retry then refused
 *     as "already approved", with no pointer and no evidence. The comment
 *     saying it could be fixed by approving again was false.
 *   · And with no previously approved row to contend over, two concurrent
 *     FIRST approvals had nothing to serialise on and could both succeed.
 *
 * The fix is not a cleverer ordering. There is no ordering of four writes
 * that is safe without atomicity, so atomicity is REQUIRED: a deployment
 * without transactions is refused before the first write, with a stable
 * retryable code. A costing that cannot be approved is a visible problem
 * somebody fixes; a costing that is half approved is not.
 */
const isTransactionUnsupported = (e) =>
  /Transaction numbers are only allowed|Transactions are not supported|replica set member or mongos/i
    .test(String(e?.message || ""));

async function inTransaction(work, { operation }) {
  const session = await mongoose.startSession().catch(() => null);
  if (!session) {
    throw fail(CODES.TRANSACTION_REQUIRED,
      `${operation} needs a database that supports transactions, so that the decision and its record are written together.`);
  }
  try {
    session.startTransaction();
    const out = await work(session);
    await session.commitTransaction();
    return out;
  } catch (e) {
    try { await session.abortTransaction(); } catch (_) {}
    /* A session is not a transaction: a standalone hands one out and then
       refuses the first write inside it. Discovered by trying, and reported
       as the deployment problem it is — never quietly retried without one. */
    if (isTransactionUnsupported(e)) {
      throw fail(CODES.TRANSACTION_REQUIRED,
        `${operation} needs a database that supports transactions, so that the decision and its record are written together.`);
    }
    throw e;
  } finally {
    session.endSession();
  }
}

/** The canonical fingerprint of what was asked. Server-derived. */
const hashRequest = (payload) =>
  crypto.createHash("sha256").update(JSON.stringify(payload ?? null)).digest("hex");

/**
 * Has this exact ACTION already been performed with this exact key?
 *
 * The operation is part of the question, so a Submit receipt can never answer
 * an Approve. Where a receipt exists but describes a DIFFERENT request, the
 * answer is a conflict rather than a replay — otherwise the second question
 * is answered with the first one's result, and the words on the record are
 * not the words the approver used.
 */
async function findReceipt({ companyId, costingId, versionId, operation, idempotencyKey, requestHash, target, session = null }) {
  if (!idempotencyKey) return null;
  const q = CostingTransition.findOne({ companyId, costingId, versionId, operation, idempotencyKey });
  if (session) q.session(session);
  const found = await q.lean();
  if (!found) return null;
  if ((found.requestHash || "") !== (requestHash || "") || (found.target || "") !== (target || "")) {
    /* Survives the temporary bookkeeping row's expiry, because it is read
       from the transition itself. */
    throw fail(CODES.KEY_REUSED,
      "That key was already used for a different request on this version.",
      { operation });
  }
  return found;
}

/**
 * HAS THIS EXACT ACTION ALREADY BEEN RECORDED? — a read-only preflight.
 *
 * ── WHY A CALLER OUTSIDE THIS FILE NEEDS TO ASK ─────────────────────────────
 * Every verb below checks its receipt BEFORE it checks the version's state,
 * because a retry after a lost response must replay rather than be told the
 * decision has already been taken. A caller that runs its own preconditions
 * first — "is this still fresh", "is it still under review" — would defeat
 * that ordering and turn every recovered retry into a conflict.
 *
 * So the ordering is published rather than reimplemented: ask this first, and
 * if it answers, replay. It writes nothing, takes no session and moves no
 * status — the authority to change a version's state stays in this file, which
 * is the whole reason `beginLifecycleTransition` is armed here and nowhere.
 *
 * A key reused with a DIFFERENT payload still throws, exactly as it does
 * inside a transaction: the refusal is a property of the key, not of when it
 * is asked about.
 *
 * @returns {Promise<object|null>} the recorded transition, or null
 */
async function findRecordedDecision({
  companyId, costingId, versionId, operation, idempotencyKey = "", note = "", target = "",
} = {}) {
  if (!idempotencyKey) return null;
  /* Hashed the way each verb hashes it — one trimmed, capped note. Computing
     it here rather than accepting a hash keeps the shape in one place. */
  const clean = String(note || "").trim().slice(0, 2000);
  return findReceipt({
    companyId, costingId, versionId, operation,
    idempotencyKey, requestHash: hashRequest({ note: clean }), target,
  });
}

/* ══ SUBMIT FOR REVIEW ═══════════════════════════════════════════════════════
 *
 * `DRAFT → IN_REVIEW`. The editor's act: "this is the number I want approved."
 * It publishes nothing and prices nothing — which is exactly what the screen
 * has to say, because calculating a version has always felt like finishing.
 */
async function submitForReview({
  companyId, costingId, versionId, actor = {}, note = "", idempotencyKey = "", requestId = "", target = "",
} = {}) {
  const clean = String(note || "").trim().slice(0, 2000);
  const requestHash = hashRequest({ note: clean });

  /* ── STATE AND EVIDENCE, OR NEITHER ─────────────────────────────────────
     Both writes are inside one transaction. The first version saved the
     version and created the record afterwards, so a failure between them
     left a version IN_REVIEW that nobody could be shown to have submitted —
     a best-effort audit write described as evidence. */
  return inTransaction(async (session) => {
    const replay = await findReceipt({
      companyId, costingId, versionId, operation: "SUBMIT",
      idempotencyKey, requestHash, target, session,
    });
    if (replay) return { replayed: true, transition: replay };

    const version = await loadVersion({ companyId, costingId, versionId, session });

    if (version.status !== "DRAFT") {
      if (version.status === "IN_REVIEW") {
        throw fail(CODES.VERSION_STATE_CONFLICT, "This version is already in review.", {
          status: version.status,
        });
      }
      assertTransitionAllowed(version.status, "IN_REVIEW");
    }

    /* A version may stay a DRAFT for ever while incomplete — that is what a
       draft is for. Asking for review is the claim this checks. */
    assertCostCoverage(version, { operation: "SUBMIT" });

    const at = new Date();
    version.status = "IN_REVIEW";
    version.lifecycle = {
      ...(version.lifecycle?.toObject?.() || version.lifecycle || {}),
      submittedBy: String(actor.id || ""),
      submittedByName: actor.name || "",
      submittedAt: at,
      ...(clean ? { submissionNote: clean } : {}),
      /* ── AND A PREVIOUS RETURN IS CLEARED ────────────────────────────
         Resubmitting answers the return. Leaving the reason set would show
         a version under review still carrying the objection it was sent
         back for — the immutable RETURN transition keeps that history. */
      returnedBy: "",
      returnedByName: "",
      returnedAt: null,
      returnReason: "",
    };
    beginLifecycleTransition(version);
    await version.save({ session });

    const transition = await recordTransition({
      companyId, costingId, versionId: version._id, versionNumber: version.versionNumber,
      kind: "SUBMIT", fromStatus: "DRAFT", toStatus: "IN_REVIEW",
      actorId: String(actor.id || ""), actorName: actor.name || "", actorEmail: actor.email || "",
      at, note: clean,
      policyRevision: version.policySnapshot?.revision ?? null,
      operation: "SUBMIT", idempotencyKey: idempotencyKey || "",
      target: target || "", requestHash, requestId: requestId || "",
    }, session);

    /* Not reported as done until the record is durable — the commit is what
       makes both true together, and it happens after this returns. */
    return { replayed: false, version, transition };
  }, { operation: "Submitting a costing for review" });
}

/* ══ RETURN ══════════════════════════════════════════════════════════════════
 *
 * `IN_REVIEW → DRAFT`, with a reason, and the evidence in the same commit.
 *
 * ── THE TRANSITION THAT WAS DECLARED AND NEVER BUILT ────────────────────────
 * `VERSION_TRANSITIONS` has offered `IN_REVIEW → DRAFT` since the lifecycle
 * was written, and `TRANSITION_KINDS` has held `RETURN` — but no service
 * implemented it. A reviewer who disagreed had nothing to press: the version
 * sat in review, and the only way onward was to prepare another one, which
 * left no record of why the first was not taken.
 *
 * ── THE REASON IS THE POINT, NOT A FORMALITY ────────────────────────────────
 * A return is addressed TO somebody: it is the only message Sales gets telling
 * them what to change. Returning without one produces a version in DRAFT that
 * nobody knows what to do with, so the reason is mandatory and held to the
 * same minimum length as an approval note.
 */
async function returnToSales({
  companyId, costingId, versionId, actor = {}, reason = "", idempotencyKey = "", requestId = "", target = "",
} = {}) {
  /* Checked before anything is loaded, so a refusal for a missing reason
     cannot be mistaken for a refusal about the version. */
  const clean = String(reason || "").trim();
  if (clean.length < MIN_NOTE) {
    throw fail(
      CODES.NOTE_REQUIRED,
      "Say why this is being returned. Sales sees this reason and it is the only instruction they get.",
      { minimumLength: MIN_NOTE, field: "reason" },
    );
  }
  const requestHash = hashRequest({ note: clean });

  return inTransaction(async (session) => {
    const replay = await findReceipt({
      companyId, costingId, versionId, operation: "RETURN",
      idempotencyKey, requestHash, target, session,
    });
    if (replay) return { replayed: true, transition: replay };

    const version = await loadVersion({ companyId, costingId, versionId, session });

    if (version.status !== "IN_REVIEW") {
      /* Already back with Sales — the retry of a return that landed. Reported
         by name rather than as a generic conflict, because the caller's
         intent has in fact been achieved. */
      if (version.status === "DRAFT") {
        throw fail(CODES.VERSION_STATE_CONFLICT, "This version is already back with Sales.", {
          status: version.status,
        });
      }
      /* APPROVED or SUPERSEDED — a decision has been taken and a return
         would silently unmake it. */
      assertTransitionAllowed(version.status, "DRAFT");
    }

    const at = new Date();
    version.status = "DRAFT";
    version.lifecycle = {
      ...(version.lifecycle?.toObject?.() || version.lifecycle || {}),
      returnedBy: String(actor.id || ""),
      returnedByName: actor.name || "",
      returnedAt: at,
      returnReason: clean,
      /* ── AND THE SUBMISSION IS CLEARED ───────────────────────────────
         It is a draft again. Leaving `submittedAt` set would make a version
         that is back with Sales read as still under review on any screen
         that shows the lifecycle block. */
      submittedBy: "",
      submittedByName: "",
      submittedAt: null,
    };
    beginLifecycleTransition(version);
    await version.save({ session });

    const transition = await recordTransition({
      companyId, costingId, versionId: version._id, versionNumber: version.versionNumber,
      kind: "RETURN", fromStatus: "IN_REVIEW", toStatus: "DRAFT",
      actorId: String(actor.id || ""), actorName: actor.name || "", actorEmail: actor.email || "",
      at, note: clean,
      policyRevision: version.policySnapshot?.revision ?? null,
      operation: "RETURN", idempotencyKey: idempotencyKey || "",
      target: target || "", requestHash, requestId: requestId || "",
    }, session);

    return { replayed: false, version, transition };
  }, { operation: "Returning a costing to Sales" });
}

/* ══ APPROVE ═════════════════════════════════════════════════════════════════
 *
 * `IN_REVIEW → APPROVED`, and in the same commit: the previous approved
 * version to `SUPERSEDED`, the parent's pointer to this one, and the evidence.
 *
 * ── TRANSACTIONAL, OR REFUSED BEFORE ANYTHING IS WRITTEN ────────────────────
 * Between "v2 is approved" and "v1 is superseded" there is a moment when two
 * versions both say APPROVED, and nothing on any screen would reveal it. An
 * earlier version of this file claimed a careful ORDERING made that
 * survivable. It did not: a failure after the approve write left an APPROVED
 * version with no pointer and no evidence, which every retry then refused as
 * "already approved" — unrecoverable, and described in a comment as the
 * opposite.
 *
 * There is no ordering of four writes that is safe without atomicity. So the
 * deployment must supply a transaction and is refused with a retryable
 * `COSTING_APPROVAL_TRANSACTION_REQUIRED` before the first write if it cannot.
 * Partial commercial state is never exposed.
 */
async function approve({
  companyId, costingId, versionId, actor = {}, note = "", idempotencyKey = "", requestId = "", target = "",
} = {}) {
  /* ── A REASON, NOT A KEYSTROKE ────────────────────────────────────────────
     Checked before anything is loaded, so a refusal for a missing note cannot
     be mistaken for a refusal about the version. */
  const reason = String(note || "").trim();
  if (reason.length < MIN_NOTE) {
    throw fail(
      CODES.NOTE_REQUIRED,
      "An approval needs a short reason — what was checked, or why this price is right.",
      { minimumLength: MIN_NOTE },
    );
  }
  const clean = reason.slice(0, 2000);
  const requestHash = hashRequest({ note: clean });

  /* ── FOUR WRITES, ONE COMMIT ──────────────────────────────────────────────
     Supersede the previous approved version, approve this one, move the
     parent's pointer, record the evidence. There is no ordering of those four
     that is safe without atomicity — a failure after the second leaves an
     APPROVED version with no pointer and no evidence, which every retry then
     refuses as "already approved". So the deployment must supply a
     transaction, and is refused before the first write if it cannot.

     It is also what serialises two concurrent FIRST approvals: with no
     previously approved row to contend over, nothing else would. */
  return inTransaction(async (session) => {
    const replay = await findReceipt({
      companyId, costingId, versionId, operation: "APPROVE",
      idempotencyKey, requestHash, target, session,
    });
    if (replay) return { replayed: true, transition: replay };

    const version = await loadVersion({ companyId, costingId, versionId, session });

    if (version.status !== "IN_REVIEW") {
      if (version.status === "APPROVED") {
        throw fail(CODES.VERSION_STATE_CONFLICT, "This version is already approved.", {
          status: version.status,
        });
      }
      /* DRAFT → APPROVED lands here and is refused BY NAME: the review step
         is the control, and skipping it is what this lifecycle prevents. */
      assertTransitionAllowed(version.status, "APPROVED");
    }

    /* ── AND AGAIN AT APPROVAL ────────────────────────────────────────
       Not only at submit. A version already sitting IN_REVIEW from before
       this rule existed would otherwise walk straight through the gate it was
       never held to — the rule would apply to everything except the versions
       that predate it, which is the set most likely to need it. */
    assertCostCoverage(version, { operation: "APPROVE" });

    const { policyRevision } = assertStillApprovable(version);

    const costing = await Costing.findOne({ companyId, _id: costingId }).session(session);
    if (!costing) throw notFound();

    const at = new Date();

    /* ── 1 · THE PREVIOUS APPROVED VERSION STEPS DOWN ────────────────────── */
    const previous = await CostingVersion.findOne({
      companyId, costingId, status: "APPROVED", _id: { $ne: version._id },
    }).session(session);

    if (previous) {
      /* A LATER version cannot be superseded by an EARLIER one — approving v1
         after v2 is live would quietly demote the newer answer. */
      if (previous.versionNumber > version.versionNumber) {
        throw fail(
          CODES.APPROVAL_RACE,
          `Version ${previous.versionNumber} is already approved, so version ${version.versionNumber} cannot replace it.`,
          { approvedVersionNumber: previous.versionNumber, attemptedVersionNumber: version.versionNumber },
        );
      }
      previous.status = "SUPERSEDED";
      previous.lifecycle = {
        ...(previous.lifecycle?.toObject?.() || previous.lifecycle || {}),
        supersededByVersionId: version._id,
        supersededByVersionNumber: version.versionNumber,
        supersededAt: at,
      };
      beginLifecycleTransition(previous);
      await previous.save({ session });

      await recordTransition({
        companyId, costingId, versionId: previous._id, versionNumber: previous.versionNumber,
        kind: "SUPERSEDE", fromStatus: "APPROVED", toStatus: "SUPERSEDED",
        actorId: String(actor.id || ""), actorName: actor.name || "", actorEmail: actor.email || "",
        at, note: `Replaced by version ${version.versionNumber}.`,
        policyRevision,
        /* No key and no operation: nobody REQUESTED this, it is a
           consequence — and giving it a key would collide with the approval's
           own receipt in the unique index. */
        operation: "", idempotencyKey: "", target: "", requestHash: "",
        requestId: requestId || "",
        causedByVersionId: version._id, causedByVersionNumber: version.versionNumber,
      }, session);
    }

    /* ── 2 · THIS VERSION BECOMES THE COMMERCIAL ONE ──────────────────────── */
    version.status = "APPROVED";
    version.lifecycle = {
      ...(version.lifecycle?.toObject?.() || version.lifecycle || {}),
      approvedBy: String(actor.id || ""),
      approvedByName: actor.name || "",
      approvedAt: at,
      approvalNote: clean,
      policyRevisionAtApproval: policyRevision,
    };
    beginLifecycleTransition(version);
    await version.save({ session });

    /* ── 3 · AND THE PARENT POINTS AT IT ────────────────────────────────── */
    costing.approvedVersionId = version._id;
    costing.approvedVersionNumber = version.versionNumber;
    costing.approvedAt = at;
    await costing.save({ session });

    /* ── 4 · THE EVIDENCE, IN THE SAME COMMIT ───────────────────────────── */
    const transition = await recordTransition({
      companyId, costingId, versionId: version._id, versionNumber: version.versionNumber,
      kind: "APPROVE", fromStatus: "IN_REVIEW", toStatus: "APPROVED",
      actorId: String(actor.id || ""), actorName: actor.name || "", actorEmail: actor.email || "",
      at, note: clean, policyRevision,
      operation: "APPROVE", idempotencyKey: idempotencyKey || "",
      target: target || "", requestHash, requestId: requestId || "",
    }, session);

    return { replayed: false, version, costing, transition };
  }, { operation: "Approving a costing version" });
}

/**
 * The history of one costing's decisions, newest first.
 *
 * Read-only, and company-scoped in the query rather than after it.
 */
const history = ({ companyId, costingId, limit = 50 }) =>
  CostingTransition.find({ companyId, costingId })
    .sort({ at: -1 })
    .limit(Math.min(200, Math.max(1, Number(limit) || 50)))
    .lean();

module.exports = {
  CODES, MIN_NOTE,
  assertTransitionAllowed, assertStillApprovable,
  submitForReview, approve, returnToSales, history,
  /* Read-only. See the comment above it. */
  findRecordedDecision,
};
