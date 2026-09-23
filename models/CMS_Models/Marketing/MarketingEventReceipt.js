// models/CMS_Models/Marketing/MarketingEventReceipt.js
//
// WHAT GRAV DID ABOUT AN OBSERVATION — THE MUTABLE HALF OF THE PAIR.
//
// ── WHY THE OBSERVATION COULD NOT HOLD THIS ────────────────────────────────
// `MarketingIntentEvent` is evidence: a statement about a moment that has
// already happened. Processing state is the opposite — it changes, repeatedly,
// as identity resolves, suppression applies and an Activity is written. Putting
// the two in one row means the evidence is in a record that gets edited, and a
// record that gets edited is not evidence.
//
// The first version did exactly that: it wrote `usedInHandoverRef` onto
// recorded events, in a schema whose own header called them immutable. So the
// workflow state moved here, and the ledger became immutable in fact rather
// than in comment.
//
// ── ONE RECEIPT PER OBSERVATION ────────────────────────────────────────────
// Keyed on the same (company, source, source event id) the ledger is keyed on,
// so a replay finds the receipt its first delivery created and resumes whatever
// that delivery did not finish, instead of repeating what it did.
//
// ── IT CARRIES NO EVIDENCE OF ITS OWN ──────────────────────────────────────
// No payload, no personal data beyond the person key the event already
// resolved. To read what happened, read the event; this says only what was done
// about it.
"use strict";

const mongoose = require("mongoose");

const {
  EVENT_PROCESSING_STATE_CODES,
  EVENT_IGNORED_REASON_CODES,
} = require("../../../constants/marketing");

const stepSchema = (extra = {}) => ({
  state: { type: String, trim: true, default: "" },
  at: { type: Date, default: null },
  attempts: { type: Number, default: 0, min: 0 },
  /* An operator sentence. Never a provider body and never a stack. */
  error: { type: String, trim: true, default: "", maxlength: 400 },
  ...extra,
});

const receiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    source: { type: String, trim: true, required: true, default: "mautic" },
    sourceEventId: { type: String, trim: true, required: true },
    /* The observation this is about. Identity only — the receipt never copies
       what the event says. */
    eventId: { type: mongoose.Schema.Types.ObjectId, required: true },
    kind: { type: String, trim: true, required: true },
    occurredAt: { type: Date, required: true },

    /* The overall answer to "is anything still owed on this event". Derived
       from the steps below by the processing service, and stored so Data Health
       can group without recomputing per row. */
    state: {
      type: String, enum: EVENT_PROCESSING_STATE_CODES, required: true, default: "RECORDED",
    },
    ignoredReason: { type: String, enum: [...EVENT_IGNORED_REASON_CODES, ""], default: "" },

    /* ── LATE IDENTITY RESOLUTION LIVES HERE ──────────────────────────────
       The event records who was resolvable when it arrived. This records who is
       resolvable now, which may be more, and updating it rewrites no evidence. */
    gravPersonKey: { type: String, trim: true, default: "" },
    resolvedBy: {
      type: String,
      enum: ["external_mapping", "canonical_identity", "unresolved", ""],
      default: "",
    },
    resolvedAt: { type: Date, default: null },

    /* ── THE TWO SIDE EFFECTS, TRACKED SEPARATELY ─────────────────────────
       Separately because they fail independently: suppression can succeed while
       an Activity write fails, and reporting one number for both would hide
       whichever half is broken. */
    suppression: stepSchema({
      /* The deterministic command key handed to the consent service, so a replay
         reuses it and the consent history stays idempotent. */
      commandKey: { type: String, trim: true, default: "" },
      /* ── WHEN THE COMMAND WAS LEGITIMATELY REPLACED ─────────────────────
         An unsubscribe followed by a genuine opt-in leaves this command durably
         in history with a later revision standing over it. That is settled, not
         failed, and these two fields preserve WHAT replaced it — so nobody
         later reads "superseded" as "we lost the suppression". */
      supersededByState: { type: String, trim: true, default: "" },
      supersededByRevision: { type: Number, default: null },
    }),
    activity: stepSchema({
      activityId: { type: mongoose.Schema.Types.ObjectId, default: null },
      /* Which canonical Sales record it was attached to. Identity only — no
         lifecycle state, which Marketing has no business holding. */
      salesRecordType: { type: String, trim: true, default: "" },
      salesRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
    }),

    /* Set when this observation was used to build a Prospect handover. The
       field that used to sit on the immutable event. */
    usedInHandoverRef: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "marketing_event_receipts" },
);

/* ONE RECEIPT PER OBSERVATION, PER COMPANY. Same shape as the ledger's own
   replay key, so the two cannot disagree about what "the same event" means. */
receiptSchema.index({ companyId: 1, source: 1, sourceEventId: 1 }, { unique: true });
/* The Data Health read: what is still owed, oldest first. */
receiptSchema.index({ companyId: 1, state: 1, occurredAt: 1 });
/* Everything still owed for one person. */
receiptSchema.index({ companyId: 1, gravPersonKey: 1, occurredAt: -1 });

/** The states that mean somebody or something still has work to do. */
const UNFINISHED_STATES = Object.freeze([
  "IDENTITY_UNRESOLVED", "SUPPRESSION_PENDING", "SUPPRESSION_FAILED",
  "ACTIVITY_PENDING", "ACTIVITY_FAILED",
]);

module.exports = mongoose.models.MarketingEventReceipt
  || mongoose.model("MarketingEventReceipt", receiptSchema);
module.exports.UNFINISHED_STATES = UNFINISHED_STATES;
