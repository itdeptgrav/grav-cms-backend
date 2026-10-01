// models/CMS_Models/Marketing/MarketingAcquisitionHold.js
//
// ONE DURABLE COMMAND: STOP ACQUISITION FOR THIS ONE PERSON.
//
// ── THE LIE THIS RECORD EXISTS TO REMOVE ───────────────────────────────────
// Acceptance used to write `ProspectHandover.permission.acquisitionPausedAt`
// immediately, in the same save as the decision, while the comment beside it
// admitted that "the Mautic-side campaign removal is a later chunk's outbound
// work". So the handover claimed a completed fact — acquisition has stopped —
// that nothing had done. A salesperson reading the Prospect was told the person
// was out of the campaign while the campaign was still sending to them.
//
// The request and the confirmation are therefore two different facts, and they
// live in two different places: the request is this row, the confirmation is
// `confirmedAt` on this row, and `acquisitionPausedAt` on the handover is
// written from `confirmedAt` and never before it.
//
// ── WHY A ROW PER HANDOVER, NOT PER PERSON ─────────────────────────────────
// The command is owed because of a DECISION, and decisions are per handover.
// Two handovers for the same person, accepted a month apart, are two commands;
// collapsing them onto the person would lose which decision was never carried
// out. The unique index is therefore (companyId, handoverRef) — that pair IS the
// idempotency key requirement 1 asks for, enforced by the database rather than
// by a read-then-write check that two workers can both pass.
//
// ── WHY IT IS NOT A MarketingDeliveryState ─────────────────────────────────
// Delivery state answers "is this person projected into Mautic", one row per
// person, and it is keyed and indexed for exactly that. This answers "was the
// stop Sales asked for actually carried out", which has a different key, a
// different lifecycle, a different audience and an evidence set delivery state
// has no field for. Sharing the row would have made `health: SYNCHRONIZED`
// mean two unrelated things at once. The RETRY MACHINERY is shared, though —
// the same classification table, the same bounded backoff, the same lease
// fence — because that part genuinely is the same problem.
//
// ── WHAT IS DELIBERATELY NOT STORED ────────────────────────────────────────
// No consent state: canonical consent is MarketingConsent's, this command must
// never change it, and a copy here would be a second answer to a question that
// already has one. No email, name or company — the identity row holds those.
// No raw Mautic response body, no stack trace, no credentials, for the reasons
// MarketingDeliveryState sets out at length.
"use strict";

const mongoose = require("mongoose");

const {
  ACQUISITION_HOLD_STATE_CODES,
  ACQUISITION_HOLD_REASON_CODES,
  ACQUISITION_HOLD_SUPERSEDED_BY_CODES,
  DELIVERY_REASON_CODES,
  DELIVERY_FAILURE_CLASS_CODES,
} = require("../../../constants/marketing");

/* The single failure currently standing against this command. Replaced on each
   new failure and cleared on success: "what is wrong now", not "what has ever
   been wrong". Same shape as delivery state's, on purpose — an operator reading
   both screens should not have to learn two vocabularies. */
const activeErrorSchema = new mongoose.Schema(
  {
    reasonCode: { type: String, enum: DELIVERY_REASON_CODES, required: true },
    sourceCode: { type: String, trim: true, default: "" },
    failureClass: { type: String, enum: DELIVERY_FAILURE_CLASS_CODES, required: true },
    message: { type: String, trim: true, default: "", maxlength: 500 },
    at: { type: Date, required: true },
    attemptNo: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/* ── WHAT WAS ACTUALLY CHANGED IN MAUTIC, AND WHAT WAS READ BACK ────────────
   Identity only: the segment and campaign ids this person was removed from.
   Not names — a name is Mautic's to rename — and not the memberships of anyone
   else. This is the evidence that the stop happened, and it is what makes
   requirement 2 auditable: a row that lists per-contact removals cannot be
   confused with one that paused a campaign. */
const evidenceSchema = new mongoose.Schema(
  {
    holdFieldSet: { type: Boolean, default: false },
    segmentsRemoved: [{ type: String, trim: true }],
    campaignsRemoved: [{ type: String, trim: true }],
    /* What the verification read back AFTER the removals. Zero of each is what
       APPLIED means; anything else is a failure however cheerful the write
       responses were. */
    segmentsRemainingAfter: { type: Number, default: null },
    campaignsRemainingAfter: { type: Number, default: null },
    /* How many memberships were deliberately NOT touched. The restraint is as
       much a part of the evidence as the removals: it is what shows a service or
       nurture path survived an acceptance. */
    segmentsLeftAlone: { type: Number, default: null },
    campaignsLeftAlone: { type: Number, default: null },

    /* ── THE SCOPE THIS COMMAND ACTUALLY USED ───────────────────────────────
       Stored, not re-derived. "Which segments count as acquisition" is
       configuration, and configuration changes; a reader asking what this
       command did six months from now must get the answer that was true when it
       ran, not the answer the current environment would give. */
    scope: {
      segments: [{ id: String, alias: String, name: String, _id: false }],
      campaigns: [{ id: String, alias: String, name: String, _id: false }],
      declaredSegments: [{ type: String, trim: true }],
      declaredCampaigns: [{ type: String, trim: true }],
      resolvedAt: { type: Date, default: null },
    },

    /* The registered acquisition segments proved to carry the standing
       `grav_acquisition_hold != 1` exclusion, and the subset this command had to
       add it to. Future enrolment is prevented by these, not by the flag alone. */
    exclusionsGuarded: [{ type: String, trim: true }],
    exclusionsAdded: [{ type: String, trim: true }],

    verifiedAt: { type: Date, default: null },
  },
  { _id: false },
);

/* A worker's lease, so two sweeps cannot both drive the same command into
   Mautic. Expiry rather than release-only: a crashed worker must not strand it. */
const claimSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, default: "" },
    at: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    by: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const holdSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* The decision this command exists because of. Immutable: a command that
       could be re-pointed at another handover would be a command nobody could
       audit. */
    handoverRef: { type: String, required: true, trim: true, immutable: true },
    handoverId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* The canonical opaque GRAV identity, never an email address (plan §10). */
    gravPersonKey: { type: String, required: true, trim: true },
    /* Denormalised from MarketingIdentity.externals, which stays the authority.
       Empty until the identity is resolved — a command can be owed for somebody
       Mautic has never been told about. */
    mauticContactId: { type: String, trim: true, default: "" },

    reason: { type: String, enum: ACQUISITION_HOLD_REASON_CODES, required: true },
    /* When SALES decided, not when Marketing noticed. Used for "how long has
       this been owed", which is a question about Sales' expectation. */
    decidedAt: { type: Date, default: null },
    requestedAt: { type: Date, required: true },

    state: {
      type: String, enum: ACQUISITION_HOLD_STATE_CODES, required: true, default: "REQUESTED", index: true,
    },

    /* ── ATTEMPTS ─────────────────────────────────────────────────────────
       `attempts` counts every attempt; `retryCount` counts only consecutive
       transient failures and is what the backoff is computed from, so one bad
       afternoon does not leave a permanent punitive delay. */
    attempts: { type: Number, default: 0, min: 0 },
    retryCount: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    /* Set when an attempt opens, cleared when it settles. An old value with no
       settle is a crashed attempt — which is exactly what recovery must find,
       and the reason success is never inferred from the absence of an error. */
    inFlightSince: { type: Date, default: null },
    nextAttemptAt: { type: Date, default: null },

    /* THE ONLY THING THAT MAY POPULATE `acquisitionPausedAt`. Written after
       Mautic has been changed and read back, never from a write's own 200. */
    confirmedAt: { type: Date, default: null },

    activeError: { type: activeErrorSchema, default: null },
    evidence: { type: evidenceSchema, default: () => ({}) },

    supersededBy: {
      reason: { type: String, enum: ACQUISITION_HOLD_SUPERSEDED_BY_CODES, default: undefined },
      at: { type: Date, default: null },
      /* When a newer hold superseded this one, which. Identity only. */
      handoverRef: { type: String, trim: true, default: "" },
    },

    claim: { type: claimSchema, default: () => ({}) },
  },
  { timestamps: true, collection: "marketing_acquisition_holds" },
);

/* ── THE IDEMPOTENCY KEY ────────────────────────────────────────────────────
   One command per decision per company. Two deliveries of the same Sales
   decision, or three replays of it, collide here rather than in a read-then-
   write race — which is requirement 7, enforced by the database. */
holdSchema.index({ companyId: 1, handoverRef: 1 }, { unique: true });
/* The recovery sweep: this company's unfinished commands whose time has come,
   with the claim state in the index so an unclaimed one is found without a
   fetch. Company first, always — requirement 8 starts with the index. */
holdSchema.index({ companyId: 1, state: 1, nextAttemptAt: 1, "claim.expiresAt": 1 });
/* "Does this person already have a hold, and is it applied?" — the supersession
   check, and the Data Health per-person read. */
holdSchema.index({ companyId: 1, gravPersonKey: 1, state: 1 });

/* ── CONTRADICTORY COMBINATIONS ARE REFUSED ON EVERY WRITE PATH ─────────────
   One pure function, called from the document hook AND the update hook, because
   the service uses `findOneAndUpdate` for its fenced settles and mongoose does
   not run document middleware for those. Enforcing a rule only on the path the
   tests happen to use is the failure mode MarketingDeliveryState documents. */

/** @returns {string|null} the violation, or null when the state is coherent. */
function invariantViolation(d) {
  const attempts = Number(d.attempts) || 0;

  if (d.state === "APPLIED") {
    if (!d.confirmedAt) {
      return "An applied acquisition hold must carry the time Mautic confirmed it.";
    }
    if (d.activeError) return "An applied acquisition hold cannot still carry an active error.";
    if (d.nextAttemptAt) return "An applied acquisition hold must not have a retry scheduled.";
    if (d.inFlightSince) return "An applied acquisition hold must not have an attempt still open.";
    if (attempts < 1) return "An acquisition hold cannot be applied without an attempt.";
  }
  /* `confirmedAt` is the fact "Mautic stopped it". Nothing else may set it —
     otherwise the honest timestamp this whole record exists to protect could be
     written by a REQUESTED row and we would be back where we started. */
  if (d.state !== "APPLIED" && d.confirmedAt) {
    return `An acquisition hold that is ${d.state} cannot carry a confirmation time.`;
  }
  if (d.state === "FAILED") {
    if (!d.activeError) return "A failed acquisition hold must carry the error that failed it.";
    if (d.inFlightSince) return "A failed acquisition hold must not have an attempt still open.";
  }
  if (d.state === "SUPERSEDED") {
    if (d.nextAttemptAt) return "A superseded acquisition hold must not have a retry scheduled.";
    if (d.inFlightSince) return "A superseded acquisition hold must not have an attempt still open.";
    if (!d.supersededBy?.reason) return "A superseded acquisition hold must say what superseded it.";
  }
  if (d.state === "REQUESTED" && d.nextAttemptAt && d.inFlightSince) {
    return "A requested acquisition hold cannot be in flight and scheduled at once.";
  }
  return null;
}

holdSchema.pre("validate", function refuseContradictions(next) {
  const bad = invariantViolation(this);
  return bad ? next(new Error(bad)) : next();
});

for (const op of ["findOneAndUpdate", "updateOne"]) {
  holdSchema.pre(op, async function refuseContradictoryUpdate() {
    const update = this.getUpdate() || {};
    const set = { ...(update.$set || {}), ...(update.$setOnInsert || {}) };
    const TOUCHED = [
      "state", "confirmedAt", "activeError", "nextAttemptAt", "inFlightSince", "attempts",
      "supersededBy", "supersededBy.reason",
    ];
    if (!TOUCHED.some((f) => f in set) && !update.$inc?.attempts) return;

    const current = await this.model.findOne(this.getQuery()).lean();
    const merged = { ...(current || {}), ...set };
    /* Dotted paths arrive flat; the rules read `supersededBy.reason`. */
    if ("supersededBy.reason" in set) {
      merged.supersededBy = { ...(merged.supersededBy || {}), reason: set["supersededBy.reason"] };
    }
    if (update.$inc?.attempts) {
      merged.attempts = (Number(current?.attempts) || 0) + Number(update.$inc.attempts);
    }
    const bad = invariantViolation(merged);
    if (bad) throw new Error(bad);
  });
}

const MarketingAcquisitionHold = mongoose.models.MarketingAcquisitionHold
  || mongoose.model("MarketingAcquisitionHold", holdSchema);

module.exports = MarketingAcquisitionHold;
/* Exported so the service and its tests assert against the SAME rule the
   database enforces, rather than a second copy that can drift from it. */
module.exports.invariantViolation = invariantViolation;
