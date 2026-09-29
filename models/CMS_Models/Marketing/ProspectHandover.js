// models/CMS_Models/Marketing/ProspectHandover.js
//
// THE HANDOVER IS A BUSINESS RECORD, NOT A CONTACT EXPORT.
//
// One document per submission. It carries everything Sales needs to decide
// without opening Mautic, and nothing Sales would then have to maintain: no
// lifecycle state, no requirement, no commercial figure, no conversation.
//
// ── WHY MARKETING KEEPS ITS OWN COPY ───────────────────────────────────────
// Sales receives this and keeps a receipt of its own (models/CMS_Models/Sales/
// MarketingProspectIntake.js). Two records for one handover is deliberate and
// is the same arrangement Sales and Merchandising already use: each
// application owns the record it can be asked about. Marketing must be able to
// answer "what did we send, on what evidence" after Sales has archived the
// Prospect, and Sales must be able to answer "what were we told" without
// reading a Marketing collection.
//
// ── WHAT IT MAY NEVER GROW ─────────────────────────────────────────────────
// A field naming a Lead qualification state, an Enquiry, a Sales Journey, a
// quotation, a price or an order. Marketing does not model the commercial
// lifecycle (ADR-004), and the moment this record could describe one, the
// question "which system is right" has two answers.
"use strict";

const mongoose = require("mongoose");

const {
  HANDOVER_STATE_CODES,
  SALES_DECISION_CODES,
  CONSENT_STATE_CODES,
  FIT_BAND_CODES,
  INTENT_BAND_CODES,
  RECOMMENDED_ACTION_CODES,
  INTENT_EVENT_KIND_CODES,
} = require("../../../constants/marketing");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/* One marketing activity, with the time it happened. Concise evidence, not the
   raw event stream: the plan is explicit that Sales gets "concise engagement
   evidence, not raw event noise", and the ledger keeps the rest. */
const activitySchema = new mongoose.Schema(
  {
    kind: { type: String, enum: INTENT_EVENT_KIND_CODES, required: true },
    occurredAt: { type: Date, required: true },
    campaignName: { type: String, trim: true, default: "" },
    assetName: { type: String, trim: true, default: "" },
    detail: { type: String, trim: true, default: "" },
    /* The ledger row this line came from — so a reader can get back to the
       evidence, and so the same observation cannot be counted twice. */
    sourceEventId: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

/* WHERE ENRICHED DATA CAME FROM, IN THE PROVIDER'S OWN NAME.
   Requirement: external discovery data passes through a provider-neutral GRAV
   boundary and never touches Mautic. Storing the provider by name is what
   makes that auditable after the fact — an unattributed field is one nobody
   can withdraw, correct or challenge. */
const provenanceSchema = new mongoose.Schema(
  {
    provider: { type: String, trim: true, required: true },
    providerRecordId: { type: String, trim: true, default: "" },
    retrievedAt: { type: Date, required: true },
    fields: [{ type: String, trim: true }],
    /* Never the provider's raw response: it is somebody else's copy of a
       person's data and this is not its system of record. A reference to the
       fetch is enough to ask them again. */
    lookupReference: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const handoverSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* Server-minted, human-quotable, immutable. The identity Sales quotes back
       and the key both intake ledgers deduplicate on. */
    handoverRef: { type: String, required: true, unique: true, immutable: true, trim: true },

    state: { type: String, enum: HANDOVER_STATE_CODES, default: "AWAITING_REVIEW", index: true },

    /* ── THE ORGANISATION ─────────────────────────────────────────────── */
    company: {
      name: { type: String, trim: true, default: "" },
      website: { type: String, trim: true, default: "" },
      /* Derived from the website or the work email — the identifier duplicate
         matching actually uses, kept beside the thing it was derived from. */
      domain: { type: String, trim: true, lowercase: true, default: "" },
      country: { type: String, trim: true, default: "" },
      sizeBand: { type: String, trim: true, default: "" },
      industry: { type: String, trim: true, default: "" },
    },

    /* ── THE PERSON ───────────────────────────────────────────────────── */
    person: {
      firstName: { type: String, trim: true, default: "" },
      lastName: { type: String, trim: true, default: "" },
      jobTitle: { type: String, trim: true, default: "" },
      /* WORK contact details only. A personal address collected by a marketing
         form is not a business contact detail and is not what a salesperson
         should call. */
      workEmail: { type: String, trim: true, lowercase: true, default: "" },
      workPhone: { type: String, trim: true, default: "" },
      linkedinUrl: { type: String, trim: true, default: "" },
    },

    /* ── WHERE IT CAME FROM ───────────────────────────────────────────── */
    marketing: {
      sourceSystem: { type: String, trim: true, default: "mautic" },
      source: { type: String, trim: true, default: "" },
      campaignId: { type: String, trim: true, default: "" },
      campaignName: { type: String, trim: true, default: "" },
      assetName: { type: String, trim: true, default: "" },
      firstSeenAt: { type: Date, default: null },
      lastEngagedAt: { type: Date, default: null },
    },

    provenance: { type: [provenanceSchema], default: [] },

    /* ── PERMISSION AND COMMUNICATION STATE ───────────────────────────── */
    permission: {
      emailConsent: { type: String, enum: CONSENT_STATE_CODES, default: "unknown" },
      phoneConsent: { type: String, enum: CONSENT_STATE_CODES, default: "unknown" },
      capturedAt: { type: Date, default: null },
      capturedSource: { type: String, trim: true, default: "" },
      noticeVersion: { type: String, trim: true, default: "" },
      suppressed: { type: Boolean, default: false },
      suppressionReason: { type: String, trim: true, default: "" },
      /* Set when Sales accepts. Acquisition messaging stops at that moment —
         the plan's "acquisition campaigns pause immediately". */
      acquisitionPausedAt: { type: Date, default: null },
    },

    activities: { type: [activitySchema], default: [] },
    topicsOfInterest: [{ type: String, trim: true }],

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

    /* ── THE ASSESSMENTS, WITH THEIR REASONS ──────────────────────────── */
    assessment: {
      accountFit: { type: String, enum: FIT_BAND_CODES, default: "unknown" },
      accountFitFactors: [{ type: String, trim: true }],
      intent: { type: String, enum: INTENT_BAND_CODES, default: "low" },
      intentFactors: [{ type: String, trim: true }],
      /* Plain language, written for a salesperson, not a scoring model. */
      handoverReason: { type: String, trim: true, required: true },
      recommendedAction: { type: String, enum: RECOMMENDED_ACTION_CODES, required: true },
      /* How old the newest piece of evidence was when this was assessed. A
         recommendation without freshness is a recommendation that cannot be
         distrusted. */
      evidenceFreshnessHours: { type: Number, default: null },
      /* The rule set that produced the bands, so a later change to the rules
         does not silently rewrite what an old handover claimed. */
      rulesVersion: { type: String, trim: true, default: "" },
    },

    /* ── DUPLICATE-MATCHING IDENTIFIERS ───────────────────────────────── */
    matchKeys: {
      normalizedEmail: { type: String, trim: true, lowercase: true, default: "" },
      normalizedPhone: { type: String, trim: true, default: "" },
      companyDomain: { type: String, trim: true, lowercase: true, default: "" },
      normalizedCompanyName: { type: String, trim: true, default: "" },
      externalContactId: { type: String, trim: true, default: "" },
    },

    /* The ledger rows this handover was built from. Identity only. */
    sourceEventIds: [{ type: String, trim: true }],

    submittedAt: { type: Date, default: null },
    submittedBy: actorRef(),

    /* ── WHAT SALES SAID ──────────────────────────────────────────────────
       Written ONLY by services/marketing/salesOutcomeIntake.service.js, from a
       delivered Sales event. Marketing never fills these in on its own — a
       decision Marketing recorded for itself is not a decision. */
    outcome: {
      decision: { type: String, enum: SALES_DECISION_CODES, default: undefined },
      decidedAt: { type: Date, default: null },
      decidedBy: actorRef(),
      reason: { type: String, trim: true, default: "" },
      /* Only on a return: what Sales wants nurtured, and when to look again. */
      nurtureTopic: { type: String, trim: true, default: "" },
      revisitAt: { type: Date, default: null },
      /* Identity of the Sales record, so Marketing can LINK to the canonical
         Prospect rather than copy it. No lifecycle state is stored beside it. */
      salesRecordType: { type: String, trim: true, default: "" },
      salesRecordId: { type: mongoose.Schema.Types.ObjectId, default: null },
      salesRecordRef: { type: String, trim: true, default: "" },
    },

    /* Why a submission never left Marketing, when state is BLOCKED. */
    blockedReason: { type: String, trim: true, default: "" },

    correlationId: { type: String, trim: true, required: true },
  },
  { timestamps: true, collection: "marketing_prospect_handovers" },
);

/* The Marketing inbox read: this company's handovers by state, newest first. */
handoverSchema.index({ companyId: 1, state: 1, createdAt: -1 });
/* "Have we already handed this person over?" — asked before every submission. */
handoverSchema.index({ companyId: 1, "matchKeys.normalizedEmail": 1, createdAt: -1 });

module.exports = mongoose.models.MarketingProspectHandover
  || mongoose.model("MarketingProspectHandover", handoverSchema);
