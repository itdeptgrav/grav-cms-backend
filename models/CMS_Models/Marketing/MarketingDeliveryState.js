// models/CMS_Models/Marketing/MarketingDeliveryState.js
//
// WHAT HAPPENED THE LAST TIME GRAV TRIED TO PUT THIS PERSON INTO MAUTIC.
//
// ── WHY THIS IS NOT A FEW FIELDS ON THE IDENTITY MAPPING ───────────────────
// `MarketingIdentity.externals[]` already carries `lastSyncedAt` and
// `lastSyncError`, and that was the obvious place to grow this. It is the wrong
// place, for one decisive reason: **an external mapping entry does not exist
// until a remote write has succeeded.** The failures an operator most needs to
// see are exactly the ones that happened before Mautic ever returned a contact
// id — an unreachable instance, a refused credential, a rejected write — and
// every one of those would have had nowhere to be recorded.
//
// So delivery state is keyed on the person, not on the link: one row per
// company + GRAV person, created on the FIRST attempt whether or not that
// attempt reaches Mautic. The mapping stays the authority on which Mautic
// contact a person is; `mauticContactId` here is a denormalised copy so that
// "which of these failures already have a contact" is one query rather than a
// join across an array.
//
// ── THE STORED STATE IS TIME-INDEPENDENT ───────────────────────────────────
// `health` never says "retry due". A row that said so would become wrong as the
// clock moved, with no write to blame and nothing to correct it. The stored
// state is `RETRY_SCHEDULED` plus a `nextAttemptAt`; the waiting/due split is
// derived at read time. See constants/marketing.js DELIVERY_EFFECTIVE_HEALTH.
//
// ── WHAT IS DELIBERATELY NOT STORED ────────────────────────────────────────
// No credentials. No raw Mautic response body — a provider's error body has
// been known to echo a credential back, and it is also unbounded. No stack
// traces. No email address, no name, no company: the identity row holds those,
// and an operator screen masks them from there. A delivery-state row is about
// an ATTEMPT, and a row that also carried the person would be a second copy of
// personal data that outlives their deletion.
"use strict";

const mongoose = require("mongoose");

const {
  DELIVERY_HEALTH_CODES,
  DELIVERY_REASON_CODES,
  DELIVERY_FAILURE_CLASS_CODES,
} = require("../../../constants/marketing");

/* The single failure currently standing against this person. Replaced on each
   new failure and CLEARED on success — it answers "what is wrong now", not
   "what has ever been wrong". The history of attempts is the counters below
   plus the application log; a per-attempt error collection would be an
   unbounded audit trail of provider noise, which is not what an operator
   reads. */
const activeErrorSchema = new mongoose.Schema(
  {
    /* The stable reason an operator groups by (DELIVERY_REASONS), not the raw
       provider code it was classified from. */
    reasonCode: { type: String, enum: DELIVERY_REASON_CODES, required: true },
    /* The upstream code that produced it, kept because an engineer reading a
       report needs to get back to the cause. Still a code, never a body. */
    sourceCode: { type: String, trim: true, default: "" },
    failureClass: { type: String, enum: DELIVERY_FAILURE_CLASS_CODES, required: true },
    /* A sentence written FOR AN OPERATOR. Truncated, because the point of a
       bound is that it holds when the provider is having a bad day. */
    message: { type: String, trim: true, default: "", maxlength: 500 },
    at: { type: Date, required: true },
    /* Which attempt produced it, so "failed on attempt 7 of 8" is readable. */
    attemptNo: { type: Number, default: 0, min: 0 },
  },
  { _id: false },
);

/* A worker's lease on this row. Held while one projection is in flight so a
   second worker skips it rather than racing it into a duplicate Mautic
   contact. Expiry rather than a release-only lock: a crashed worker must not
   strand the row. */
const claimSchema = new mongoose.Schema(
  {
    token: { type: String, trim: true, default: "" },
    at: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
    /* Free text naming the worker, for a human reading a stuck row. */
    by: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const deliverySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    /* The canonical opaque GRAV person identity, same key MarketingIdentity and
       MarketingConsent use. Never an email address (product plan §10). */
    gravPersonKey: { type: String, required: true, trim: true },

    /* NEVER_ATTEMPTED only while `attempts` is 0. The moment an attempt opens
       this becomes IN_FLIGHT, so "nothing has been tried" and "something was
       tried and we never heard back" are different rows rather than the same
       one. */
    health: {
      type: String, enum: DELIVERY_HEALTH_CODES, required: true, default: "NEVER_ATTEMPTED",
    },

    /* ── COUNTERS AND TIMES ───────────────────────────────────────────────
       `attempts` counts every attempt ever made, including the ones that
       succeeded; `retryCount` counts only consecutive transient failures and is
       what the backoff is computed from, so a success resets it and a long-lived
       record does not inherit a punitive delay from a bad week last month. */
    attempts: { type: Number, default: 0, min: 0 },
    retryCount: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastSuccessfulSyncAt: { type: Date, default: null },
    /* Set when an attempt starts and cleared when it ends. A row with this set
       and `lastAttemptAt` long past is a crashed attempt, which is exactly what
       a reconciliation should surface — and is the reason success is never
       inferred from the absence of an error. */
    inFlightSince: { type: Date, default: null },
    lastOutcome: { type: String, enum: ["SUCCESS", "FAILURE", null], default: null },

    nextAttemptAt: { type: Date, default: null },

    activeError: { type: activeErrorSchema, default: null },

    /* Denormalised from MarketingIdentity.externals, which remains the
       authority. Empty string, not null, so a sparse-style query reads the same
       for a row that has never been linked and one whose link was removed. */
    mauticContactId: { type: String, trim: true, default: "" },

    /* When health is BLOCKED_CONSENT, which consent reason — the vocabulary
       from CONSENT_INELIGIBLE_REASONS. Copied rather than re-resolved so a
       report does not have to query consent per row, and refreshed on every
       attempt so it cannot go stale silently. */
    consentReasonCode: { type: String, trim: true, default: "" },

    claim: { type: claimSchema, default: () => ({}) },
  },
  { timestamps: true, collection: "marketing_delivery_state" },
);

/* ONE ROW PER PERSON PER COMPANY. The upsert in the service relies on this, and
   it is what stops two concurrent first attempts creating two states. */
deliverySchema.index({ companyId: 1, gravPersonKey: 1 }, { unique: true });
/* The Data Health grouping read. */
deliverySchema.index({ companyId: 1, health: 1, nextAttemptAt: 1 });
/* The retry runner's claim scan: scheduled rows whose time has come, oldest
   first, with the claim state in the index so an unclaimed row is found without
   fetching. */
deliverySchema.index({ companyId: 1, health: 1, nextAttemptAt: 1, "claim.expiresAt": 1 });

/* ── CONTRADICTORY COMBINATIONS ARE REFUSED ON EVERY WRITE PATH ─────────────
   ── THE BUG THIS SHAPE FIXES ─────────────────────────────────────────────
   These rules were first written as a `pre("validate")` hook alone. Mongoose
   runs document middleware for `create()` and `save()` and NOT for
   `findOneAndUpdate()` — and `findOneAndUpdate` is what every write in
   marketingDelivery.service.js uses, because the settle operations need an
   atomic conditional update. So the invariants were enforced against the
   mechanism the tests used and bypassed by the mechanism production used, which
   is the worst possible arrangement: a claim of safety that holds only where it
   is being watched.

   One pure function, called from both hooks. The update hook costs one extra
   read per delivery write to know the state being merged into; that is a price
   worth paying on a collection written once per projection attempt, and the
   alternative — validating only the fields the update happens to mention — is
   how a rule quietly stops covering the case it was written for. */

/** @returns {string|null} the violation, or null when the state is coherent. */
function invariantViolation(d) {
  const attempts = Number(d.attempts) || 0;

  if (d.health === "NEVER_ATTEMPTED" && attempts > 0) {
    return "Delivery state cannot be NEVER_ATTEMPTED after an attempt.";
  }
  if (d.health === "IN_FLIGHT") {
    if (!d.inFlightSince) return "Delivery state cannot be IN_FLIGHT without inFlightSince.";
    if (attempts < 1) return "Delivery state cannot be IN_FLIGHT before an attempt has been counted.";
    if (d.nextAttemptAt) return "An in-flight attempt must not also have a retry scheduled.";
  }
  if (d.health === "SYNCHRONIZED") {
    if (d.activeError) return "Delivery state cannot be SYNCHRONIZED and still carry an active error.";
    if (!d.lastSuccessfulSyncAt) return "Delivery state cannot be SYNCHRONIZED without a successful sync time.";
    if (d.nextAttemptAt) return "Delivery state cannot be SYNCHRONIZED and have a retry scheduled.";
    if (d.inFlightSince) return "Delivery state cannot be SYNCHRONIZED with an attempt still open.";
  }
  if (d.health === "RETRY_SCHEDULED") {
    if (!d.nextAttemptAt) return "Delivery state cannot be RETRY_SCHEDULED without a nextAttemptAt.";
    if (!d.activeError) return "Delivery state cannot be RETRY_SCHEDULED without the error that scheduled it.";
    if (d.inFlightSince) return "A scheduled retry must not also have an attempt open.";
  }
  if (d.health === "BLOCKED_TERMINAL" && d.nextAttemptAt) {
    return "A terminally blocked delivery must not have a retry scheduled.";
  }
  if (d.health === "BLOCKED_CONSENT" && d.nextAttemptAt) {
    return "A consent-blocked delivery must not have a retry scheduled — only the person can change it.";
  }
  return null;
}

/* create() and save(). */
deliverySchema.pre("validate", function refuseContradictions(next) {
  const bad = invariantViolation(this);
  return bad ? next(new Error(bad)) : next();
});

/* findOneAndUpdate() and updateOne() — the paths the service uses. The current
   document is read so the merged result is checked, not just the fragment the
   update happens to mention. An upsert with no existing document validates the
   update alone, which is the whole of the intended state in that case. */
for (const op of ["findOneAndUpdate", "updateOne"]) {
  deliverySchema.pre(op, async function refuseContradictoryUpdate() {
    const update = this.getUpdate() || {};
    const set = { ...(update.$set || {}), ...(update.$setOnInsert || {}) };
    /* Nothing this rule set cares about is changing. */
    const TOUCHED = ["health", "nextAttemptAt", "activeError", "lastSuccessfulSyncAt", "inFlightSince", "attempts"];
    if (!TOUCHED.some((f) => f in set) && !update.$inc?.attempts) return;

    const current = await this.model.findOne(this.getQuery()).lean();
    const merged = { ...(current || {}), ...set };
    if (update.$inc?.attempts) {
      merged.attempts = (Number(current?.attempts) || 0) + Number(update.$inc.attempts);
    }
    /* `$unset`/null-through-$set both arrive in `set` as null, which the rules
       already read as absent. */
    const bad = invariantViolation(merged);
    if (bad) throw new Error(bad);
  });
}

const MarketingDeliveryState = mongoose.models.MarketingDeliveryState
  || mongoose.model("MarketingDeliveryState", deliverySchema);

module.exports = MarketingDeliveryState;
/* Exported so the service and its tests assert against the SAME rule the
   database enforces, rather than a second copy that can drift from it. */
module.exports.invariantViolation = invariantViolation;
