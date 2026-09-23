// models/CMS_Models/Marketing/MarketingEvent.js
//
// WHAT MARKETING OBSERVED, WHAT IT DID, AND WHAT IT STILL HAS TO ANNOUNCE.
//
// Three collections, one file, mirroring the arrangement Sales already uses
// for its Merchandising handover (models/CMS_Models/Sales/SalesHandoverEvent.js
// — read that first; this is the same mechanism pointed the other way).
//
//   INTENT LEDGER  (`marketing_intent_events`)
//     Every marketing observation Mautic sends, exactly once. Immutable: an
//     event is a statement about a moment that has already happened, and
//     editing one would be rewriting the past. The unique index on
//     (source, sourceEventId) is what makes a webhook replay free — the second
//     delivery of the same event is a duplicate-key error, which is an answer,
//     not a failure.
//
//   AUDIT   (`marketing_audit_events`)
//     Append-only. What Marketing did about those observations, who or what
//     did it, when, and why. Nothing updates a row and nothing deletes one.
//
//   OUTBOX  (`marketing_outbox_events`)
//     Delivery bookkeeping toward Sales, written beside the handover it
//     announces. A row stays PENDING until the Sales receiver confirms it has
//     applied the event; a failed attempt leaves it PENDING to be retried.
//     Not a message broker, not a daemon, and not a transaction spanning both
//     applications — see salesHandoverDelivery.service.js for why each of
//     those was refused.
"use strict";

const mongoose = require("mongoose");

const {
  INTENT_EVENT_KIND_CODES,
  MARKETING_EVENT_KINDS,
  BOUNCE_CLASS_CODES,
} = require("../../../constants/marketing");

const KIND_VALUES = Object.freeze(Object.values(MARKETING_EVENT_KINDS));

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* ═══ 1. THE INTENT LEDGER ═════════════════════════════════════════════════ */

const intentEventSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* WHICH SYSTEM SAID SO. "mautic" today; the field exists so a second
       marketing source cannot be added by overloading the id space of the
       first. */
    source: { type: String, trim: true, required: true, default: "mautic" },
    /* The DETERMINISTIC key derived from the provider's own immutable facts —
       see services/marketing/mauticWebhookContract.js `sourceEventKey()` for how
       each kind derives one and why. Required, because an event we cannot name
       is an event we cannot deduplicate, and an intake that cannot deduplicate
       creates duplicate suppression history and duplicate CRM Activity. */
    sourceEventId: { type: String, trim: true, required: true },

    kind: { type: String, enum: INTENT_EVENT_KIND_CODES, required: true },

    /* WHO IT WAS ABOUT, in the source system's terms. */
    externalContactId: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },

    /* ── THE IDENTITY AS RESOLVED AT THE MOMENT OF RECORDING ──────────────
       Written once, at intake, and never again. A person who becomes
       resolvable later does NOT get this row rewritten — the observation is a
       statement about what was known when it arrived, and editing it would
       destroy the only evidence of what the system actually knew. Late
       resolution lands on the receipt (MarketingEventReceipt), which is the
       mutable half of the pair. */
    gravPersonKey: { type: String, trim: true, default: "" },

    campaignId: { type: String, trim: true, default: "" },
    campaignName: { type: String, trim: true, default: "" },
    assetName: { type: String, trim: true, default: "" },
    topics: [{ type: String, trim: true }],

    /* Hard / soft / unknown, on a bounce. Retained because the two ends mean
       opposite things and `unknown` means neither may be claimed. */
    bounceClass: { type: String, enum: [...BOUNCE_CLASS_CODES, ""], default: "" },
    /* The provider's own status verbs on a subscription change, kept because
       "contactable → unsubscribed" and "bounced → contactable" are different
       stories and only the pair tells which. */
    previousStatus: { type: String, trim: true, default: "" },
    newStatus: { type: String, trim: true, default: "" },

    /* ── WHEN IT HAPPENED versus WHEN WE HEARD ────────────────────────────
       `occurredAt` is the ONLY chronology. `receivedAt` is an ingestion fact
       and is used for ingestion operations alone — a retry sweep can deliver a
       week-old event after a newer one, and ordering by arrival would let the
       older one win. */
    occurredAt: { type: Date, required: true, index: true },
    receivedAt: { type: Date, default: Date.now },

    /* ── BOUNDED, REDACTED EVIDENCE ───────────────────────────────────────
       This replaced a `Mixed` field that stored the provider's entire item. A
       single Mautic open event is over eight kilobytes of contact-field
       descriptors; storing it meant an unbounded copy of somebody's personal
       data living in an immutable row that outlives their deletion request, in
       a collection nobody would think to look in.

       What is kept is what an investigation actually needs: the provider's own
       identifiers and times, the asset and status names, and the KEYS of any
       form answers. Not the answers. Not the contact record. Never a header,
       a cookie or a credential — none of which are read from the request in
       the first place. Bounded by the schema so a talkative provider cannot
       make it unbounded later. */
    evidence: {
      providerRecordType: { type: String, trim: true, default: "", maxlength: 40 },
      providerRecordId: { type: String, trim: true, default: "", maxlength: 64 },
      providerEventType: { type: String, trim: true, default: "", maxlength: 80 },
      providerTimestamp: { type: String, trim: true, default: "", maxlength: 40 },
      emailId: { type: String, trim: true, default: "", maxlength: 64 },
      formId: { type: String, trim: true, default: "", maxlength: 64 },
      url: { type: String, trim: true, default: "", maxlength: 500 },
      /* Field NAMES only. A form's answers are the person's words and belong
         to the handover package that a marketer deliberately assembles, not to
         a telemetry row. */
      resultKeys: [{ type: String, trim: true, maxlength: 64 }],
      /* The provider's own reason text on a bounce, truncated. This is where a
         hard/soft classification came from and an operator has to be able to
         see it. */
      reasonText: { type: String, trim: true, default: "", maxlength: 300 },
    },
  },
  { timestamps: true, collection: "marketing_intent_events" },
);

/* ── REPLAY SAFETY, SCOPED TO THE COMPANY ───────────────────────────────────
   This index was `{source, sourceEventId}` — GLOBAL. One Mautic instance per
   GRAV organisation makes a collision unlikely, and "unlikely" is not the
   standard a uniqueness constraint is held to: two companies each running their
   own Mautic both number their submissions from 1, and the second company's
   first form submission would have been silently swallowed as a duplicate of
   the first company's. Tenant scope belongs in the key. */
intentEventSchema.index({ companyId: 1, source: 1, sourceEventId: 1 }, { unique: true });
/* One person's recent evidence, newest by OCCURRENCE. */
intentEventSchema.index({ companyId: 1, gravPersonKey: 1, occurredAt: -1 });
intentEventSchema.index({ companyId: 1, externalContactId: 1, occurredAt: -1 });
intentEventSchema.index({ companyId: 1, email: 1, occurredAt: -1 });
/* The ingestion sweep: what arrived, in arrival order. `receivedAt` appears in
   exactly this one index, and nowhere in a chronology read. */
intentEventSchema.index({ companyId: 1, receivedAt: -1 });

/* ── IMMUTABLE, ENFORCED ────────────────────────────────────────────────────
   It was not. The schema said "immutable: an event is a statement about a
   moment that has already happened" and enforced nothing, and the intake
   service then wrote `usedInHandoverRef` onto recorded rows — workflow state,
   edited into evidence, exactly the thing the comment forbade. That field is
   gone; the handover link lives on MarketingEventReceipt.

   Same enforcement as MarketingConsentHistory and SpActionHistory: every
   mutating door, plus a re-save of a loaded document. */
const EVENT_IMMUTABLE = new Error(
  "MarketingIntentEvent is append-only: an observation cannot be updated or deleted.",
);

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace",
  "replaceOne", "deleteOne", "deleteMany", "findOneAndDelete", "remove",
]) {
  intentEventSchema.pre(op, function refuseEventWrite(next) { next(EVENT_IMMUTABLE); });
}
intentEventSchema.pre("save", function refuseEventResave(next) {
  if (!this.isNew) return next(EVENT_IMMUTABLE);
  return next();
});

/* ═══ 2. THE AUDIT TRAIL ═══════════════════════════════════════════════════ */

const auditSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    handoverRef: { type: String, trim: true, required: true },
    handoverId: { type: mongoose.Schema.Types.ObjectId, default: null },

    action: { type: String, trim: true, required: true },
    /* Absent when the act was the system's own — receiving a Sales decision is
       observed, not performed, and inventing a marketer for it would be a
       false attribution. */
    actor: actorRef(),
    at: { type: Date, required: true },
    reason: { type: String, trim: true, default: "" },

    previousState: { type: String, trim: true, default: "" },
    resultingState: { type: String, trim: true, default: "" },
    correlationId: { type: String, trim: true, required: true, index: true },

    /* ── THE IDENTITY OF A ONE-TIME AUDIT FACT ──────────────────────────────
       Most lines on this trail are legitimately repeated: one per
       acquisition-hold attempt, and an attempt that failed twice must show
       twice. A few are not. "Marketing learned that Sales accepted this
       handover" happens exactly once however many times the decision is
       redelivered, and the `exists()`-then-`create()` that used to guard it
       could be run twice concurrently and write two identical rows.

       So a line that is a one-time fact carries a key, and the database refuses
       the second one. Lines without a key are unconstrained, which is what
       keeps the per-attempt history intact. Absent rather than empty string:
       the partial index below only covers documents where this is a string, so
       an unkeyed line is not in the index at all. */
    dedupeKey: { type: String, trim: true, default: undefined },

    details: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true, collection: "marketing_audit_events" },
);

/* One handover's whole story, oldest first. */
auditSchema.index({ companyId: 1, handoverRef: 1, at: 1, _id: 1 });
/* ONE LINE PER ONE-TIME FACT PER COMPANY, enforced rather than checked.
   Partial, so the repeated per-attempt lines — which carry no `dedupeKey` — are
   not covered by it and may recur as often as the attempts did. Additive: every
   row written before this existed has no key and stays outside the index. */
auditSchema.index(
  { companyId: 1, dedupeKey: 1 },
  { unique: true, partialFilterExpression: { dedupeKey: { $type: "string" } } },
);

/* ═══ 3. THE OUTBOX TOWARD SALES ═══════════════════════════════════════════ */

const outboxSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: KIND_VALUES, required: true },

    /* IDENTITY AND NOTHING ELSE. The Sales receiver reads the authoritative
       handover by reference, so there is exactly one statement of what was
       handed over and no chance of a stale copy of it travelling separately.
       This is the same rule the Sales→Merchandising outbox keeps. */
    payload: {
      handoverId: { type: mongoose.Schema.Types.ObjectId, required: true },
      handoverRef: { type: String, trim: true, required: true },
    },

    occurredAt: { type: Date, required: true, index: true },
    actor: actorRef(),
    correlationId: { type: String, trim: true, required: true },

    status: { type: String, enum: ["PENDING", "DELIVERED"], default: "PENDING", index: true },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: { type: Date, default: null },
    lastError: { type: String, trim: true, default: "" },
    deliveredAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "marketing_outbox_events" },
);

/* One announcement per act per kind. A retried submission reuses its
   correlation identity and cannot enqueue the same announcement twice. */
outboxSchema.index({ correlationId: 1, kind: 1 }, { unique: true });
/* The retry sweep: undelivered events, oldest first. */
outboxSchema.index({ status: 1, occurredAt: 1, _id: 1 });

module.exports = {
  EVENT_IMMUTABLE_MESSAGE: EVENT_IMMUTABLE.message,
  MarketingIntentEvent: mongoose.models.MarketingIntentEvent
    || mongoose.model("MarketingIntentEvent", intentEventSchema),
  MarketingAuditEvent: mongoose.models.MarketingAuditEvent
    || mongoose.model("MarketingAuditEvent", auditSchema),
  MarketingOutboxEvent: mongoose.models.MarketingOutboxEvent
    || mongoose.model("MarketingOutboxEvent", outboxSchema),
};
