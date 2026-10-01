// services/sales/commercialReview.service.js
//
// THE COMMERCIAL DECISION ON A PREPARED ESTIMATE.
//
// ── WHOSE DECISION THIS IS ──────────────────────────────────────────────────
// Sales prepares an estimate from the enquiry, asks for it to be reviewed, and
// somebody decides whether it may be quoted. All three are commercial acts and
// all three belong here — not in the Costing workspace, which is an engine and
// is being retired.
//
// ── WHAT THIS SERVICE DOES NOT DO ───────────────────────────────────────────
// It does not calculate. Not a cost, not a floor, not a standing. Every figure
// it reads was FROZEN onto the version when the estimate was prepared, and it
// is read back exactly as frozen — because a decision has to be about the
// thing that was reviewed, and a floor recomputed at decision time could
// differ from the one the reviewer was shown.
//
// It does not write a version status either. `centralCosting/lifecycle` is the
// one legitimate writer of `CostingVersion.status`, and it is transactional:
// state and evidence commit together or neither does. This service decides WHO
// may do WHAT and delegates the move.
//
// ── AND IT ADDS NO FIFTH VERSION STATE ──────────────────────────────────────
// "Awaiting an executive exception" is a property of the REVIEW, not of the
// version. A below-floor proposal sits at `IN_REVIEW` like any other; what
// makes it await an executive is the frozen standing on the version somebody
// submitted. That is durable and reconstructible from records alone — the
// version, its frozen standing, and the immutable transitions — and it is
// never inferred from the Board's policy today, which may have moved since.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");
const { CAPABILITIES } = require("../centralCosting/capabilities");
const lifecycle = require("../centralCosting/lifecycle.service");
const preparation = require("./costingPreparation.service");

const C = CAPABILITIES;
const str = (v) => String(v ?? "").trim();
const num = (v) => (v === null || v === undefined ? null : Number(v));
const model = (name, path) => (mongoose.models[name] || require(path));
const CostingVersion = () => model("CostingVersion", "../../models/CMS_Models/Costing/CostingVersion");
const CostingTransition = () => model("CostingTransition", "../../models/CMS_Models/Costing/CostingTransition");

/** The minimum a reason must say to be a reason at all. */
const MIN_REASON = lifecycle.MIN_NOTE;

/**
 * THE REVIEW'S OWN STATES.
 *
 * Derived from the version and its evidence, never stored as a fifth status.
 */
const REVIEW = Object.freeze({
  /* Nothing prepared, or prepared and not yet asked about. */
  NOT_SUBMITTED: "NOT_SUBMITTED",
  /* Submitted, at or above the floor — an ordinary approver may decide. */
  AWAITING_COMMERCIAL_APPROVAL: "AWAITING_COMMERCIAL_APPROVAL",
  /* Submitted, below the floor — only an executive may decide. */
  AWAITING_EXECUTIVE_EXCEPTION: "AWAITING_EXECUTIVE_EXCEPTION",
  /* Sent back with a reason; Sales may correct and resubmit. */
  RETURNED: "RETURNED",
  APPROVED: "APPROVED",
});

/** Why a version cannot enter the commercial workflow at all. */
const BLOCKED = Object.freeze({
  NO_ESTIMATE: "NO_ESTIMATE",
  NOT_CALCULATED: "NOT_CALCULATED",
  INPUTS_CHANGED: "INPUTS_CHANGED",
  INPUTS_INCOMPLETE: "INPUTS_INCOMPLETE",
  NO_PROPOSED_PRICE: "NO_PROPOSED_PRICE",
  NO_STANDING: "NO_STANDING",
  POLICY_MISSING: "POLICY_MISSING",
  HISTORICAL_CONTRACT: "HISTORICAL_CONTRACT",
  /* Freshness could not be established at all — the resolver or a source
     behind it failed. Distinct from "the sources changed": one is an answer,
     the other is the absence of one, and only the first is safe to act on. */
  FRESHNESS_UNAVAILABLE: "FRESHNESS_UNAVAILABLE",
});

const CODES = Object.freeze({
  FORBIDDEN: "COSTING_REVIEW_FORBIDDEN",
  NOT_REVIEWABLE: "COSTING_REVIEW_NOT_REVIEWABLE",
  REASON_REQUIRED: "COSTING_REVIEW_REASON_REQUIRED",
  EXCEPTION_REQUIRED: "COSTING_REVIEW_EXCEPTION_REQUIRED",
  NOT_AN_EXCEPTION: "COSTING_REVIEW_NOT_AN_EXCEPTION",
  STALE_VERSION: "COSTING_REVIEW_STALE_VERSION",
  /* The sources behind THIS version moved. Distinct from STALE_VERSION,
     which is "a newer version exists" — two different problems with two
     different fixes: refresh the estimate, or go and read the new one. */
  STALE_INPUTS: "COSTING_REVIEW_STALE_INPUTS",
  FRESHNESS_UNAVAILABLE: "COSTING_REVIEW_FRESHNESS_UNAVAILABLE",
  VERSION_REQUIRED: "COSTING_REVIEW_VERSION_REQUIRED",
  KEY_REQUIRED: "COSTING_REVIEW_KEY_REQUIRED",
  WRONG_STATE: "COSTING_REVIEW_WRONG_STATE",
});

/* ══ READING THE FROZEN DECISION SUBJECT ═════════════════════════════════ */

/**
 * WHAT WAS FROZEN, AND WHETHER IT CAN BE DECIDED AT ALL.
 *
 * ── THE PRIMARY SCENARIO DECIDES ────────────────────────────────────────────
 * A version prices several quantities and Sales proposes a price against the
 * one they are quoting. That is the primary scenario, marked when the brief
 * was confirmed. Judging the whole version by, say, its cheapest quantity
 * would let a below-floor quotation through on the strength of a run size
 * nobody is selling.
 */
function subjectOf(version) {
  if (!version) return { ok: false, reason: BLOCKED.NO_ESTIMATE };

  const scenarios = version.scenarios || [];
  if (!scenarios.length || !version.calculation?.engineVersion) {
    return { ok: false, reason: BLOCKED.NOT_CALCULATED };
  }

  const primary = scenarios.find((s) => s.isPrimary) || scenarios[0];
  const key = str(primary?.key);

  /* ── A HISTORICAL BAND VERSION IS NOT REVIEWABLE HERE ────────────────
     It was judged against a margin band that is retired. The new workflow
     asks "is this at or above the floor", and that question was never put to
     it. Refused rather than translated: `BELOW_MINIMUM` is not `BELOW_FLOOR`,
     and treating one as the other would approve a price under a rule nobody
     applied to it. It stays readable as history. */
  if (!primary?.floor) {
    return primary?.prices?.minimum
      ? { ok: false, reason: BLOCKED.HISTORICAL_CONTRACT, scenarioKey: key }
      : { ok: false, reason: BLOCKED.NOT_CALCULATED, scenarioKey: key };
  }

  const floorPriceMinor = num(primary.floor.floorPriceMinor);
  if (floorPriceMinor === null) {
    return { ok: false, reason: BLOCKED.INPUTS_INCOMPLETE, scenarioKey: key };
  }

  const row = (version.commercial?.bridge || [])
    .find((b) => str(b.scenarioKey) === key) || null;
  const proposedPriceMinor = num(
    (version.commercial?.proposedPrices || []).find((p) => str(p.scenarioKey) === key)?.priceExclTaxMinor,
  );

  /* Nothing to decide about. A review is a decision on a PRICE. */
  if (proposedPriceMinor === null) {
    return { ok: false, reason: BLOCKED.NO_PROPOSED_PRICE, scenarioKey: key };
  }

  const standing = row ? str(row.standing) || null : null;
  if (!standing) return { ok: false, reason: BLOCKED.NO_STANDING, scenarioKey: key };
  if (standing === "POLICY_MISSING") {
    return { ok: false, reason: BLOCKED.POLICY_MISSING, scenarioKey: key };
  }
  /* A retired band standing on a floor-shaped version — mixed evidence, and
     not a case this workflow may guess about. */
  if (standing !== "AT_OR_ABOVE_FLOOR" && standing !== "BELOW_FLOOR") {
    return { ok: false, reason: BLOCKED.HISTORICAL_CONTRACT, scenarioKey: key };
  }

  return {
    ok: true,
    scenarioKey: key,
    standing,
    floorPriceMinor,
    proposedPriceMinor,
    /* The one thing that decides WHOSE decision it is. */
    needsException: standing === "BELOW_FLOOR",
  };
}

/** Every transition on this version, oldest first — the audit trail. */
async function evidenceFor(ctx, version) {
  if (!version) return [];
  return CostingTransition().find({
    companyId: ctx.companyId,
    versionId: version._id,
  }).sort({ at: 1 }).lean();
}

/** Which review state the version and its evidence describe. */
function reviewStateOf(version, subject) {
  if (!version) return REVIEW.NOT_SUBMITTED;
  if (version.status === "APPROVED" || version.status === "SUPERSEDED") return REVIEW.APPROVED;
  if (version.status === "IN_REVIEW") {
    return subject.ok && subject.needsException
      ? REVIEW.AWAITING_EXECUTIVE_EXCEPTION
      : REVIEW.AWAITING_COMMERCIAL_APPROVAL;
  }
  /* A DRAFT that carries a return reason was sent back; one that does not has
     simply never been submitted. */
  return version.lifecycle?.returnedAt ? REVIEW.RETURNED : REVIEW.NOT_SUBMITTED;
}

/* ══ AUTHORITY ═══════════════════════════════════════════════════════════ */

const holds = (ctx, cap) => Boolean(ctx?.capabilitySet?.has?.(cap));

function assertMay(ctx, cap, what) {
  if (holds(ctx, cap)) return;
  throw fail(CODES.FORBIDDEN, `You do not have permission to ${what}.`, {
    reason: "NOT_GRANTED", required: cap,
  });
}

/* ══ THE COMMANDS ════════════════════════════════════════════════════════ */

/**
 * Load the exact version a decision names, and refuse a stale one.
 *
 * ── WHY THE CALLER MUST NAME THE VERSION ────────────────────────────────────
 * A decision is about a specific set of figures. Between somebody reading a
 * proposal and deciding on it, Sales may have refreshed the estimate — and
 * approving "the latest" would approve figures the approver never saw. So the
 * request carries the version it is about, and a newer one is a refusal rather
 * than a silent substitution.
 */
function assertVersionNamed(versionId) {
  /* ── THE COMMAND MUST NAME ITS SUBJECT ───────────────────────────────
     Checked before anything is read. Falling back to "the latest" would
     silently decide on figures the caller never saw — which is the exact
     substitution the version identity exists to prevent, and it would be
     invisible: the decision would succeed and look correct. */
  const id = str(versionId);
  if (!id || !mongoose.Types.ObjectId.isValid(id)) {
    throw fail(
      CODES.VERSION_REQUIRED,
      "Name the estimate version this decision is about.",
      { reason: "VERSION_ID_REQUIRED", field: "versionId" },
    );
  }
  return id;
}

/**
 * LOAD THE VERSION THE COMMAND NAMED — and nothing else.
 *
 * ── BY ID, SCOPED TO THE COMPANY AND THE COSTING ────────────────────────────
 * Not "the latest". The named version is fetched directly so a retry can be
 * matched against its receipt even after somebody has prepared a newer one —
 * see the ordering in the commands.
 *
 * A version belonging to another company, or to another costing, answers
 * exactly as one that never existed. Missing and foreign are the same answer,
 * because a distinguishable refusal is an oracle for records the caller may
 * not see.
 */
async function loadNamedVersion(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "", versionId }) {
  const id = assertVersionNamed(versionId);

  const costing = await preparation.findCosting(ctx, {
    enquiryId, product: str(product), sampleStyleId: str(sampleStyleId),
    /* A historical costing filed under the bare name is adopted only where
       that name is unambiguous — see `findCosting`. Two colourways never
       share one review state. */
    nameIsUnique: await preparation.nameIsUniqueOn(ctx, enquiryId, str(product)),
  });
  if (!costing) throw fail("NOT_FOUND", "That estimate was not found.");

  const version = await CostingVersion().findOne({
    _id: id,
    companyId: ctx.companyId,
    costingId: costing._id,
  }).lean();
  if (!version) throw fail("NOT_FOUND", "That estimate was not found.");

  return { costing, version };
}

/**
 * IS THE NAMED VERSION STILL THE CURRENT ONE?
 *
 * ── ASKED AFTER THE RECEIPT, NEVER BEFORE ───────────────────────────────────
 * A decision is about a specific set of figures, so deciding on a superseded
 * version is refused. But a RETRY of a decision already taken is not a new
 * decision — it is a caller asking what happened — and refusing it because
 * somebody has since prepared a newer version would lose the answer to a
 * request that already succeeded.
 *
 * So the commands consult the receipt first and only reach this when there is
 * genuinely nothing recorded.
 */
async function assertCurrentVersion(ctx, costing, version) {
  const { latest } = await preparation.versionsOf(ctx, costing._id);
  if (latest && String(latest._id) !== String(version._id)) {
    throw fail(
      CODES.STALE_VERSION,
      "This estimate has been prepared again since it was read. Review the current one.",
      {
        reason: "NEWER_VERSION_EXISTS",
        submittedVersionId: String(version._id),
        currentVersionNumber: latest.versionNumber,
      },
    );
  }
}

/**
 * HAVE THE SOURCES BEHIND THIS VERSION MOVED SINCE IT WAS PREPARED?
 *
 * ── RESOLVED THROUGH THE ONE FINGERPRINT, NEVER RECOMPUTED HERE ─────────────
 * `costingPreparation.resolve` compares the fingerprint frozen on the version
 * against the one today's sources produce. This asks it and reads the answer;
 * it does not assemble anything and does not learn what changed beyond the
 * labels Sales is already shown.
 *
 * ── AND IT FAILS CLOSED ─────────────────────────────────────────────────────
 * An earlier version swallowed every resolver failure and answered "not
 * stale", which is the most dangerous possible default: a database blip, a
 * missing source or a thrown assembly would all read as "verified current",
 * and a decision would be taken on figures nobody checked.
 *
 * Not knowing is its own answer, and it is reported as one — `ok: false`.
 *
 * ── AND IT IS A DIFFERENT PROBLEM FROM A NEWER VERSION ──────────────────────
 * "Somebody prepared this again" is `STALE_VERSION` and the fix is to read the
 * new one. "The consumption behind this estimate changed" is `STALE_INPUTS`
 * and the fix is to refresh. Collapsing them would tell half the callers to do
 * the wrong thing.
 */
async function freshnessFor(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "" }) {
  let resolved;
  try {
    resolved = await preparation.resolve(ctx, { enquiryId, product: str(product) });
  } catch (err) {
    return { ok: false, stale: false, changed: [], cause: err };
  }

  const freshness = resolved?.freshness || null;
  /* A resolver that returned nothing has not established freshness either. */
  if (!freshness) return { ok: false, stale: false, changed: [], cause: null };

  return {
    ok: true,
    stale: freshness.stale === true,
    /* Which facts moved, by NAME and owner — never their values. */
    changed: (freshness.changed || []).map((c) => ({ label: c.label, owner: c.owner })),
  };
}

function assertFresh(fresh) {
  if (!fresh.ok) {
    /* ── A TYPED REFUSAL, NOT THE UNDERLYING ERROR ────────────────────
       Whatever failed underneath is an internal detail; what the caller
       needs is that the decision cannot be taken yet, and that trying again
       is reasonable. The original is never published. */
    throw fail(
      CODES.FRESHNESS_UNAVAILABLE,
      "Whether this estimate is still current could not be checked just now. Try again in a moment.",
      { reason: BLOCKED.FRESHNESS_UNAVAILABLE, retryable: true },
    );
  }
  if (!fresh.stale) return;
  throw fail(
    CODES.STALE_INPUTS,
    "The inputs behind this estimate have changed since it was prepared. Refresh it, then decide on the new figures.",
    { reason: BLOCKED.INPUTS_CHANGED, changed: fresh.changed },
  );
}

/**
 * The one action key, demanded rather than invented.
 *
 * ── WHY NOT MINT ONE SERVER-SIDE ────────────────────────────────────────────
 * A generated key would make the retry guarantee a fiction: the retry of a
 * lost response would arrive with a DIFFERENT key, match no receipt, and be
 * taken as a second decision. The key has to come from the caller for replay
 * to mean anything, so its absence is refused rather than papered over.
 */
function assertActionKey(actionKey) {
  const key = str(actionKey);
  if (key) return key;
  throw fail(
    CODES.KEY_REQUIRED,
    "Send an Idempotency-Key with this decision, so a lost response can be retried safely.",
    { reason: "IDEMPOTENCY_KEY_REQUIRED", field: "Idempotency-Key" },
  );
}

/** Derive the idempotency target the lifecycle service records against. */
const targetFor = (costingId, versionId) => `costing:${costingId}:version:${versionId}`;

/**
 * SUBMIT A PREPARED ESTIMATE FOR COMMERCIAL REVIEW.
 *
 * A request, not a decision. It commits the company to nothing, so an editor
 * may make it — but it must name a reviewable version, because asking for a
 * decision on figures nobody can decide about wastes the reviewer's time and
 * produces a queue item that cannot be cleared.
 */
async function submit(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "", versionId, actionKey = "", actor = {} } = {}) {
  assertVersionNamed(versionId);
  const key = assertActionKey(actionKey);
  assertMay(ctx, C.COMMERCIAL_SUBMIT, "submit an estimate for review");

  const { costing, version } = await loadNamedVersion(ctx, { enquiryId, product, productLineRef, sampleStyleId, versionId });
  const target = targetFor(costing._id, version._id);

  /* ── THE RECEIPT FIRST, BEFORE FRESHNESS OR STATE ────────────────────
     A retry after a lost response carries the same key and must replay. If
     freshness or state were checked first, a source that moved between the
     original request and the retry — or the state the original request
     itself produced — would refuse the retry and lose the answer. */
  const replay = await recordedDecision(ctx, { costing, version, operation: "SUBMIT", key, target });
  if (replay) return { outcome: "REPLAYED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };

  /* Nothing recorded, so this is a NEW decision — and a new decision may
     only be taken on the current version. */
  await assertCurrentVersion(ctx, costing, version);
  assertFresh(await freshnessFor(ctx, { enquiryId, product, productLineRef, sampleStyleId }));
  const subject = subjectOf(version);
  if (!subject.ok) {
    throw fail(CODES.NOT_REVIEWABLE, notReviewableMessage(subject.reason), {
      reason: subject.reason, versionNumber: version.versionNumber,
    });
  }

  const out = await lifecycle.submitForReview({
    companyId: ctx.companyId,
    costingId: costing._id,
    versionId: version._id,
    actor,
    note: "",
    idempotencyKey: key,
    target,
  });

  return { outcome: out.replayed ? "REPLAYED" : "SUBMITTED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };
}

/**
 * THE ORDINARY DECISION — approve a proposal at or above the floor.
 *
 * A below-floor price is refused here by name, naming the authority it needs.
 * This is the check that makes the floor a rule: an approver who could clear
 * it would make management's decision a suggestion.
 */
async function approve(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "", versionId, note = "", actionKey = "", actor = {} } = {}) {
  assertVersionNamed(versionId);
  const key = assertActionKey(actionKey);
  assertMay(ctx, C.COMMERCIAL_APPROVE, "approve an estimate");

  const { costing, version } = await loadNamedVersion(ctx, { enquiryId, product, productLineRef, sampleStyleId, versionId });
  const target = targetFor(costing._id, version._id);
  const reason = str(note) || "Approved: at or above the company floor.";

  const replay = await recordedDecision(ctx, {
    costing, version, operation: "APPROVE", key, target, note: reason,
  });
  if (replay) return { outcome: "REPLAYED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };

  /* Nothing recorded, so this is a NEW decision — and a new decision may
     only be taken on the current version. */
  await assertCurrentVersion(ctx, costing, version);
  assertFresh(await freshnessFor(ctx, { enquiryId, product, productLineRef, sampleStyleId }));
  const subject = assertDecidable(version);

  if (subject.needsException) {
    throw fail(
      CODES.EXCEPTION_REQUIRED,
      "This price is below the floor, so it cannot be approved here. It needs an executive exception with a reason.",
      {
        reason: "BELOW_FLOOR", standing: subject.standing,
        required: C.COMMERCIAL_EXCEPTION,
        reviewState: REVIEW.AWAITING_EXECUTIVE_EXCEPTION,
      },
    );
  }

  const out = await lifecycle.approve({
    companyId: ctx.companyId,
    costingId: costing._id,
    versionId: version._id,
    actor,
    note: reason,
    idempotencyKey: key,
    target,
  });

  return { outcome: out.replayed ? "REPLAYED" : "APPROVED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };
}

/**
 * THE EXECUTIVE EXCEPTION — approve a price BELOW the company's own floor.
 *
 * The reason is mandatory and is the whole point: it is the record of why the
 * company sold below what management said it sells at.
 */
async function approveException(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "", versionId, reason = "", actionKey = "", actor = {} } = {}) {
  assertVersionNamed(versionId);
  const key = assertActionKey(actionKey);
  assertMay(ctx, C.COMMERCIAL_EXCEPTION, "decide a below-floor exception");

  const clean = str(reason);
  if (clean.length < MIN_REASON) {
    throw fail(
      CODES.REASON_REQUIRED,
      "Say why the company is selling below its own floor. This reason is the record of the exception.",
      { minimumLength: MIN_REASON, field: "reason" },
    );
  }

  const { costing, version } = await loadNamedVersion(ctx, { enquiryId, product, productLineRef, sampleStyleId, versionId });
  const target = targetFor(costing._id, version._id);

  const replay = await recordedDecision(ctx, {
    costing, version, operation: "APPROVE", key, target, note: clean,
  });
  if (replay) return { outcome: "REPLAYED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };

  /* Nothing recorded, so this is a NEW decision — and a new decision may
     only be taken on the current version. */
  await assertCurrentVersion(ctx, costing, version);
  assertFresh(await freshnessFor(ctx, { enquiryId, product, productLineRef, sampleStyleId }));
  const subject = assertDecidable(version);

  /* ── AN EXCEPTION TO NOTHING IS NOT AN EXCEPTION ─────────────────────
     Approving an at-or-above-floor price through the exception door would
     record a waiver of a floor that was never breached, and would let the
     executive path quietly become the ordinary one. */
  if (!subject.needsException) {
    throw fail(
      CODES.NOT_AN_EXCEPTION,
      "This price is at or above the floor, so it does not need an exception. Approve it in the ordinary way.",
      { reason: "NOT_BELOW_FLOOR", standing: subject.standing, reviewState: REVIEW.AWAITING_COMMERCIAL_APPROVAL },
    );
  }

  const out = await lifecycle.approve({
    companyId: ctx.companyId,
    costingId: costing._id,
    versionId: version._id,
    actor,
    note: clean,
    idempotencyKey: key,
    target,
  });

  return {
    outcome: out.replayed ? "REPLAYED" : "APPROVED_BY_EXCEPTION",
    ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })),
  };
}

/**
 * RETURN IT TO SALES, WITH A REASON.
 *
 * One verb for both reviewers. An ordinary approver returns an at-or-above
 * proposal; an executive returns a below-floor one. Which of them may act is
 * decided by the standing, exactly as approval is — so a return cannot be used
 * to sidestep the authority split.
 */
async function returnToSales(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "", versionId, reason = "", actionKey = "", actor = {} } = {}) {
  const clean = str(reason);
  if (clean.length < MIN_REASON) {
    throw fail(
      CODES.REASON_REQUIRED,
      "Say why this is being returned. Sales sees this reason and it is the only instruction they get.",
      { minimumLength: MIN_REASON, field: "reason" },
    );
  }
  assertVersionNamed(versionId);
  const key = assertActionKey(actionKey);

  /* ── NEITHER GRANT AT ALL IS REFUSED BEFORE ANYTHING IS READ ─────────
     WHICH of the two applies depends on the standing, so the precise check
     happens below. Somebody holding neither is turned away here rather than
     after the sources have been resolved on their behalf. */
  if (!holds(ctx, C.COMMERCIAL_APPROVE) && !holds(ctx, C.COMMERCIAL_EXCEPTION)) {
    throw fail(CODES.FORBIDDEN, "You do not have permission to return an estimate to Sales.", {
      reason: "NOT_GRANTED", required: C.COMMERCIAL_APPROVE,
    });
  }

  const { costing, version } = await loadNamedVersion(ctx, { enquiryId, product, productLineRef, sampleStyleId, versionId });
  const target = targetFor(costing._id, version._id);

  const replay = await recordedDecision(ctx, {
    costing, version, operation: "RETURN", key, target, note: clean,
  });
  if (replay) return { outcome: "REPLAYED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };

  /* Nothing recorded, so this is a NEW decision — and a new decision may
     only be taken on the current version. */
  await assertCurrentVersion(ctx, costing, version);
  assertFresh(await freshnessFor(ctx, { enquiryId, product, productLineRef, sampleStyleId }));
  const subject = assertDecidable(version);

  if (subject.needsException) {
    assertMay(ctx, C.COMMERCIAL_EXCEPTION, "decide a below-floor proposal");
  } else {
    assertMay(ctx, C.COMMERCIAL_APPROVE, "return an estimate to Sales");
  }

  const out = await lifecycle.returnToSales({
    companyId: ctx.companyId,
    costingId: costing._id,
    versionId: version._id,
    actor,
    reason: clean,
    idempotencyKey: key,
    target,
  });

  return { outcome: out.replayed ? "REPLAYED" : "RETURNED", ...(await stateFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })) };
}

/** Ask the lifecycle whether this exact action is already recorded. */
const recordedDecision = (ctx, { costing, version, operation, key, target, note = "" }) =>
  lifecycle.findRecordedDecision({
    companyId: ctx.companyId,
    costingId: costing._id,
    versionId: version._id,
    operation,
    idempotencyKey: key,
    note,
    target,
  });


/**
 * Shared by every decision: the version must be decidable at all.
 *
 * ── AND THE STATUS IS DELIBERATELY NOT CHECKED HERE ─────────────────────────
 * `lifecycle` owns it, and it checks the idempotency receipt BEFORE the state.
 * That order matters: a retry after a lost response carries the same action
 * key and must REPLAY the decision, not be told the estimate is already
 * approved. Refusing here first would turn every recovered retry into a
 * conflict, which is the failure mode idempotency exists to prevent.
 *
 * What is checked here is what the lifecycle cannot know: whether this is a
 * proposal the commercial workflow may decide about at all.
 */
function assertDecidable(version) {
  const subject = subjectOf(version);
  if (!subject.ok) {
    throw fail(CODES.NOT_REVIEWABLE, notReviewableMessage(subject.reason), {
      reason: subject.reason, versionNumber: version.versionNumber,
    });
  }
  return subject;
}

function notReviewableMessage(reason) {
  switch (reason) {
    case BLOCKED.NO_ESTIMATE: return "No estimate has been prepared for this product yet.";
    case BLOCKED.NOT_CALCULATED: return "This estimate has not been calculated, so there is no price to decide on.";
    case BLOCKED.INPUTS_INCOMPLETE: return "This estimate has no floor price, so it cannot be judged against one.";
    case BLOCKED.NO_PROPOSED_PRICE: return "No selling price has been proposed, so there is nothing to approve.";
    case BLOCKED.NO_STANDING: return "This estimate has not been judged against the floor yet. Refresh it and try again.";
    case BLOCKED.POLICY_MISSING: return "No approved pricing policy exists, so this price cannot be judged.";
    case BLOCKED.HISTORICAL_CONTRACT:
      return "This estimate was priced under the retired margin band. It stays readable as history and cannot be approved here.";
    case BLOCKED.INPUTS_CHANGED: return "The inputs behind this estimate have changed. Refresh it and submit again.";
    case BLOCKED.FRESHNESS_UNAVAILABLE:
      return "Whether this estimate is still current could not be checked just now. Try again in a moment.";
    default: return "This estimate cannot be reviewed.";
  }
}

const wrongStateMessage = (status, verb) => ({
  DRAFT: `This estimate is not under review, so it cannot be ${verb}.`,
  IN_REVIEW: "This estimate is already under review.",
  APPROVED: "This estimate has already been approved.",
  SUPERSEDED: "A newer estimate has replaced this one.",
}[status] || `This estimate cannot be ${verb}.`);

/* ══ THE NARROW FRONTEND CONTRACT ════════════════════════════════════════ */

/**
 * WHAT A SALES SCREEN MAY KNOW ABOUT THE REVIEW.
 *
 * ── BUILT FIELD BY FIELD, LIKE THE ESTIMATE PROJECTION ──────────────────────
 * A field that is not written cannot leak, and a field added to a version
 * later does not silently start travelling. Nothing here is read from the
 * cost build-up, the policy snapshot or any department's evidence.
 *
 * The floor PRICE crosses because Sales already receives it — it is what they
 * quote against. The markup that produced it, the true cost and the markup
 * amount do not, and are not read.
 */
async function stateFor(ctx, { enquiryId, product, productLineRef = "", sampleStyleId = "" } = {}) {
  const costing = await preparation.findCosting(ctx, {
    enquiryId, product: str(product), sampleStyleId: str(sampleStyleId),
    /* A historical costing filed under the bare name is adopted only where
       that name is unambiguous — see `findCosting`. Two colourways never
       share one review state. */
    nameIsUnique: await preparation.nameIsUniqueOn(ctx, enquiryId, str(product)),
  });
  const { latest } = costing
    ? await preparation.versionsOf(ctx, costing._id)
    : { latest: null };

  let subject = subjectOf(latest);
  const lc = latest?.lifecycle || {};

  /* ── A STALE VERSION IS NOT DECIDABLE, WHATEVER ELSE IT IS ───────────
     The sources behind it moved after it was frozen, so approving it would
     approve figures the company no longer stands behind. Reported as the
     blocking reason and with every permission false, so the screen offers
     nothing the commands would refuse. */
  const fresh = latest
    ? await freshnessFor(ctx, { enquiryId, product, productLineRef, sampleStyleId })
    : { ok: true, stale: false, changed: [] };
  if (!fresh.ok) {
    /* Truthful rather than reassuring: the screen says freshness could not
       be checked, and offers nothing. */
    subject = { ok: false, reason: BLOCKED.FRESHNESS_UNAVAILABLE };
  } else if (fresh.stale) {
    subject = { ok: false, reason: BLOCKED.INPUTS_CHANGED };
  }

  const state = reviewStateOf(latest, subject);

  const mayApprove = holds(ctx, C.COMMERCIAL_APPROVE);
  const mayExcept = holds(ctx, C.COMMERCIAL_EXCEPTION);
  const decidable = subject.ok && latest?.status === "IN_REVIEW";
  const mine = subject.needsException ? mayExcept : mayApprove;

  return {
    reviewState: state,
    /* Which decision this proposal needs, said plainly rather than left to be
       inferred from a capability the screen cannot see. */
    requires: subject.ok
      ? (subject.needsException ? "EXECUTIVE_EXCEPTION" : "COMMERCIAL_APPROVAL")
      : null,
    /* Why it cannot be reviewed, where it cannot. */
    blockedReason: subject.ok ? null : subject.reason,
    blockedMessage: subject.ok ? null : notReviewableMessage(subject.reason),
    /* Which facts moved, by name and owner — never their values. Empty
       unless the version is stale. */
    changed: fresh.changed,

    version: latest
      ? { versionId: String(latest._id), versionNumber: latest.versionNumber, status: latest.status }
      : null,

    /* ── THE FROZEN COMMERCIAL FACTS, AND ONLY THOSE ─────────────────
       The standing and the floor Sales is already entitled to. Never the
       markup percentage, the markup amount or the true cost — floor minus
       markup is the cost, so the amount is as confidential as the cost. */
    floor: subject.ok
      ? {
        standing: subject.standing,
        floorPriceMinor: subject.floorPriceMinor,
        proposedPriceMinor: subject.proposedPriceMinor,
        scenarioKey: subject.scenarioKey,
      }
      : null,

    /* Who did what, and when. Display names, never emails or actor ids. */
    submittedAt: lc.submittedAt || null,
    submittedByName: str(lc.submittedByName) || null,
    returnedAt: lc.returnedAt || null,
    returnedByName: str(lc.returnedByName) || null,
    returnReason: str(lc.returnReason) || null,
    decidedAt: lc.approvedAt || null,
    decidedByName: str(lc.approvedByName) || null,
    /* The approver's reason — which for a below-floor approval IS the
       exception, and is the record Sales is entitled to see. */
    decisionReason: str(lc.approvalNote) || null,

    /* ── WHAT THIS CALLER MAY DO ─────────────────────────────────────
       Published so a screen can stop offering an action the server would
       refuse. It is not the control: every command re-checks its own
       capability, and a client that ignored this meets a typed 403. */
    permitted: {
      submit: Boolean(holds(ctx, C.COMMERCIAL_SUBMIT) && subject.ok && latest?.status === "DRAFT"),
      approve: Boolean(decidable && !subject.needsException && mayApprove),
      return: Boolean(decidable && mine),
      approveException: Boolean(decidable && subject.needsException && mayExcept),
    },
  };
}

module.exports = {
  REVIEW, BLOCKED, CODES, MIN_REASON,
  subjectOf, reviewStateOf, evidenceFor, stateFor,
  submit, approve, approveException, returnToSales,
};
