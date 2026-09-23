// models/CMS_Models/Sales/MarketingProspectIntake.js
//
// WHAT SALES RECEIVED FROM MARKETING, AND WHAT SALES DECIDED ABOUT IT.
//
// Two collections, mirroring models/CMS_Models/Sales/SalesHandoverEvent.js
// pointed the other way round: there, Sales publishes and Merchandising
// receives; here, Marketing publishes and Sales receives.
//
//   RECEIPT (`marketing_handover_receipts`)
//     The Sales handover inbox, and the intake ledger, in one row. Those are
//     usually separate things, and here they genuinely are not: the inbox item
//     IS the record of having received the event, the decision on it IS the
//     record of having acted, and splitting them would mean two rows that can
//     disagree about whether a handover was received.
//
//     Unique on (companyId, handoverRef). That index is the whole idempotency
//     guarantee: a redelivered Marketing event finds the row and changes
//     nothing, and no second Prospect is created for it. The Lead carries a
//     matching partial unique index for the same reason — a guarantee about
//     events and a guarantee about state are different guarantees.
//
//   OUTCOME OUTBOX (`sales_marketing_outcome_outbox`)
//     Sales' announcement of its decision, back to Marketing. Written in the
//     same operation as the decision it announces, so a recorded decision
//     always has an announcement waiting. PENDING until Marketing's receiver
//     confirms; a failed attempt leaves it PENDING.
//
// ── WHAT THIS RECEIPT MUST NEVER GROW ──────────────────────────────────────
// A field that Marketing would then need in order to work. Sales owns the
// decision; Marketing learns it through the outbox. A Marketing read of this
// collection would be Marketing reaching into Sales' database, which is the
// arrangement ADR-004 exists to prevent.
"use strict";

const mongoose = require("mongoose");

const {
  SALES_DECISION_CODES,
  CONSENT_STATE_CODES,
  FIT_BAND_CODES,
  INTENT_BAND_CODES,
  RECOMMENDED_ACTION_CODES,
  SALES_OUTCOME_EVENT_KINDS,
} = require("../../../constants/marketing");

const OUTCOME_KIND_VALUES = Object.freeze(Object.values(SALES_OUTCOME_EVENT_KINDS));

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* The handover package as Sales received it. A snapshot, deliberately: it is
   what Sales was told at the time, and it must not change afterwards because
   Marketing learned something new. A newer view of the person arrives as a
   new handover. */
const packageSchema = new mongoose.Schema(
  {
    company: {
      name: { type: String, trim: true, default: "" },
      website: { type: String, trim: true, default: "" },
      domain: { type: String, trim: true, lowercase: true, default: "" },
      country: { type: String, trim: true, default: "" },
      sizeBand: { type: String, trim: true, default: "" },
      industry: { type: String, trim: true, default: "" },
    },
    person: {
      firstName: { type: String, trim: true, default: "" },
      lastName: { type: String, trim: true, default: "" },
      jobTitle: { type: String, trim: true, default: "" },
      workEmail: { type: String, trim: true, lowercase: true, default: "" },
      workPhone: { type: String, trim: true, default: "" },
      linkedinUrl: { type: String, trim: true, default: "" },
    },
    marketing: {
      sourceSystem: { type: String, trim: true, default: "" },
      source: { type: String, trim: true, default: "" },
      campaignId: { type: String, trim: true, default: "" },
      campaignName: { type: String, trim: true, default: "" },
      assetName: { type: String, trim: true, default: "" },
      firstSeenAt: { type: Date, default: null },
      lastEngagedAt: { type: Date, default: null },
    },
    provenance: [{
      provider: { type: String, trim: true },
      providerRecordId: { type: String, trim: true },
      retrievedAt: { type: Date },
      fields: [{ type: String, trim: true }],
      _id: false,
    }],
    permission: {
      emailConsent: { type: String, enum: CONSENT_STATE_CODES, default: "unknown" },
      phoneConsent: { type: String, enum: CONSENT_STATE_CODES, default: "unknown" },
      capturedAt: { type: Date, default: null },
      capturedSource: { type: String, trim: true, default: "" },
      noticeVersion: { type: String, trim: true, default: "" },
      suppressed: { type: Boolean, default: false },
    },
    /* ── THE SOURCE ENQUIRY, WHEN THE HANDOVER CAME FROM ONE ─────────────
       Additive (IndiaMART routing, 2026-09-22). A buyer enquiry pulled from a
       lead source carries the buyer's own request — what they asked about, in
       their words, and when — which the campaign fields above cannot hold.
       Null for every Mautic handover. `sourceRef` is GRAV's own reference
       (MSE-…), never the source's id. */
    sourceEnquiry: {
      type: new mongoose.Schema({
        source: { type: String, trim: true, default: "" },
        sourceRef: { type: String, trim: true, default: "" },
        channel: { type: String, trim: true, default: "" },
        /* The source's own classification (IndiaMART: buyer_enquiry, …). */
        kind: { type: String, trim: true, default: "" },
        submittedAt: { type: Date, default: null },
        /* The time exactly as the source wrote it, always kept. */
        submittedAtText: { type: String, trim: true, default: "", maxlength: 40 },
        /* Where `submittedAt` came from: read from the source's own text, or
           confirmed by a named reviewer because the text could not be read.
           Never inferred. */
        submittedAtProvenance: { type: String, enum: ["", "source", "reviewer_confirmed"], default: "" },
        submittedAtConfirmedBy: { type: String, trim: true, default: "" },
        submittedAtConfirmedAt: { type: Date, default: null },
        submittedAtConfirmationNote: { type: String, trim: true, default: "", maxlength: 500 },
        receivedAt: { type: Date, default: null },
        subject: { type: String, trim: true, default: "", maxlength: 500 },
        productName: { type: String, trim: true, default: "", maxlength: 300 },
        categoryName: { type: String, trim: true, default: "", maxlength: 300 },
        message: { type: String, trim: true, default: "", maxlength: 5000 },
        callDurationSeconds: { type: Number, default: null },
      }, { _id: false }),
      default: null,
    },
    activities: [{
      kind: { type: String, trim: true },
      occurredAt: { type: Date },
      campaignName: { type: String, trim: true },
      assetName: { type: String, trim: true },
      detail: { type: String, trim: true },
      _id: false,
    }],
    topicsOfInterest: [{ type: String, trim: true }],
    assessment: {
      accountFit: { type: String, enum: FIT_BAND_CODES, default: "unknown" },
      accountFitFactors: [{ type: String, trim: true }],
      intent: { type: String, enum: INTENT_BAND_CODES, default: "low" },
      intentFactors: [{ type: String, trim: true }],
      handoverReason: { type: String, trim: true, default: "" },
      recommendedAction: { type: String, enum: RECOMMENDED_ACTION_CODES },
      evidenceFreshnessHours: { type: Number, default: null },
      rulesVersion: { type: String, trim: true, default: "" },
    },
    matchKeys: {
      normalizedEmail: { type: String, trim: true, lowercase: true, default: "" },
      normalizedPhone: { type: String, trim: true, default: "" },
      companyDomain: { type: String, trim: true, lowercase: true, default: "" },
      normalizedCompanyName: { type: String, trim: true, default: "" },
      externalContactId: { type: String, trim: true, default: "" },
    },
  },
  { _id: false },
);

const receiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    handoverRef: { type: String, trim: true, required: true, immutable: true },
    /* The Marketing record's id. Stored for correlation in an incident; never
       used to read the Marketing collection from Sales code. */
    sourceHandoverId: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceEventId: { type: mongoose.Schema.Types.ObjectId, default: null },
    correlationId: { type: String, trim: true, required: true, index: true },

    receivedAt: { type: Date, default: Date.now },
    submittedAt: { type: Date, default: null },

    package: { type: packageSchema, required: true },

    /* ── WHAT THE INTAKE DID ─────────────────────────────────────────────
       CREATED  a new Prospect was created for this person.
       LINKED   a strong existing match was found, so no Prospect was created
                and the handover is attached to the record Sales already has.
       Never anything else: an intake that cannot do one of these two has
       failed, and a failed intake leaves the outbox row PENDING. */
    intakeOutcome: { type: String, enum: ["CREATED", "LINKED"], required: true },
    /* The Prospect this handover produced, or the record it was linked to. */
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null, index: true },
    leadRef: { type: String, trim: true, default: "" },
    linkedRecordType: { type: String, trim: true, default: "" },
    linkedRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* The duplicate candidates the intake saw, kept so a salesperson reviewing
       the handover sees what the machine saw rather than re-running it. */
    duplicateCandidates: { type: mongoose.Schema.Types.Mixed, default: [] },

    /* ── THE SALES DECISION ──────────────────────────────────────────────
       Absent until a salesperson answers. Written only by
       services/sales/marketingHandoverDecision.service.js. */
    decision: { type: String, enum: SALES_DECISION_CODES, default: undefined, index: true },
    decidedAt: { type: Date, default: null },
    decidedBy: actorRef(),
    decisionReason: { type: String, trim: true, default: "" },
    nurtureTopic: { type: String, trim: true, default: "" },
    revisitAt: { type: Date, default: null },
    /* On a link-duplicate decision: the record Sales says this really is. */
    duplicateOfType: { type: String, trim: true, default: "" },
    duplicateOfId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* On an accept: who now owns the personal contact. */
    assignedTo: { type: mongoose.Schema.Types.ObjectId, default: null },
    assignedToName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "marketing_handover_receipts" },
);

/* THE IDEMPOTENCY GUARANTEE. One receipt per handover per company, for ever. */
receiptSchema.index({ companyId: 1, handoverRef: 1 }, { unique: true });
/* The Sales inbox read: undecided handovers first, newest first. */
receiptSchema.index({ companyId: 1, decision: 1, receivedAt: -1 });

const outcomeOutboxSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: { type: String, enum: OUTCOME_KIND_VALUES, required: true },

    payload: {
      handoverRef: { type: String, trim: true, required: true },
      receiptId: { type: mongoose.Schema.Types.ObjectId, required: true },
      decision: { type: String, enum: SALES_DECISION_CODES, required: true },
      reason: { type: String, trim: true, default: "" },
      nurtureTopic: { type: String, trim: true, default: "" },
      revisitAt: { type: Date, default: null },
      /* Identity of the Sales record the decision points at, so Marketing can
         link to it. Never its lifecycle state, and never its commercial
         detail — Marketing has no business holding either. */
      salesRecordType: { type: String, trim: true, default: "" },
      salesRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
      salesRecordRef: { type: String, trim: true, default: "" },
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
  { timestamps: true, collection: "sales_marketing_outcome_outbox" },
);

/* One announcement per decision. A retried decision cannot enqueue twice. */
/* ── ONE ANNOUNCEMENT PER ACT PER KIND, PER COMPANY ────────────────────────
   The company comes first because this row is company-owned and every read of
   it is company-scoped. Without it the constraint was global: two companies
   whose handover references collided — and `handoverRef` is minted per company,
   so they can — would have had the second company's announcement REFUSED by the
   first company's row, and `ensureOutcomeEvent` would then have read the first
   company's event back and called it the second's. A cross-tenant read and a
   suppressed announcement from one missing key.

   ── THE OLD INDEX DOES NOT DISAPPEAR WITH THIS LINE ──────────────────────
   Changing a Mongoose declaration creates the new index; it never drops the old
   one, and `correlationId_1_kind_1` stays in place enforcing the global rule
   until something removes it. That removal is a bounded, checked migration:
   scripts/migrations/marketing-outbox-company-scoped-index.js. */
outcomeOutboxSchema.index({ companyId: 1, correlationId: 1, kind: 1 }, { unique: true });
outcomeOutboxSchema.index({ status: 1, occurredAt: 1, _id: 1 });

module.exports = {
  MarketingHandoverReceipt: mongoose.models.MarketingHandoverReceipt
    || mongoose.model("MarketingHandoverReceipt", receiptSchema),
  SalesMarketingOutcomeOutboxEvent: mongoose.models.SalesMarketingOutcomeOutboxEvent
    || mongoose.model("SalesMarketingOutcomeOutboxEvent", outcomeOutboxSchema),
};
