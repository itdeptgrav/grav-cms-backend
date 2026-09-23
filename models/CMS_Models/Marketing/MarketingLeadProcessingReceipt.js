// models/CMS_Models/Marketing/MarketingLeadProcessingReceipt.js
//
// WHAT GRAV DID WITH ONE SUBMITTED ENQUIRY.
//
// ── SEPARATE FROM THE EVIDENCE, ON PURPOSE ─────────────────────────────────
// The submission is immutable: it is what somebody typed. This is mutable: it
// is what GRAV decided, and decisions get revised, retried and reviewed.
//
// Keeping them apart is the point. A processing flag written onto the evidence
// would make the evidence editable, and evidence that can be edited is not
// evidence — six months on, nobody could tell whether a field said what the
// person typed or what a later process concluded.
//
// ── IT CARRIES REFERENCES, NEVER CONTENTS ──────────────────────────────────
// No contact details, no answers, no provider identifiers, no payload, no
// driver error. A receipt is read by operators, exported into monitoring, and
// quoted in support tickets — every one of those is a place a person's email
// address should not appear, and a reason code carries the same information
// without carrying them.
//
// ── AND IT IS THE RESUME POINT ─────────────────────────────────────────────
// `stage` says which effects are already done. A worker that dies mid-way is
// restarted and continues at the first unfinished one, repeating none of the
// finished ones — which only works because each effect is recorded here the
// moment it succeeds, not in a batch at the end.
"use strict";

const mongoose = require("mongoose");

const {
  STAGE_CODES, REASON_CODES, CONTRACT_VERSION,
} = require("../../../constants/marketingLeadProcessing");

const receiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* The submission this describes. A reference — nothing is copied from it. */
    leadId: { type: mongoose.Schema.Types.ObjectId, required: true },
    submissionRef: { type: String, required: true, trim: true },

    /* ── PART OF THE IDENTITY, NOT JUST A LABEL ──────────────────────────
       If the processing rules change — what counts as agreement, which
       identifiers may match — an old receipt describes a decision made under
       the old rules. Reprocessing under new ones is a different question, and
       the version makes it a new receipt rather than a quiet overwrite of a
       conclusion somebody may have acted on. */
    contractVersion: { type: Number, required: true, default: CONTRACT_VERSION },

    stage: { type: String, enum: STAGE_CODES, required: true, default: "pending_identity", index: true },
    /* A stable code from the closed list. Never prose assembled from what
       somebody submitted. */
    reason: { type: String, enum: [...REASON_CODES, ""], default: "" },

    /* ── WHAT EACH EFFECT PRODUCED, RECORDED AS IT SUCCEEDS ──────────────
       These are what make a resume safe. `gravPersonKey` is GRAV's own opaque
       person identity, not an email address. */
    gravPersonKey: { type: String, trim: true, default: "" },
    identityCreated: { type: Boolean, default: false },
    identityResolvedAt: { type: Date, default: null },

    /* The stable source-event identity used for the engagement, so a replay
       recognises its own previous work rather than adding a second one. */
    engagementEventKey: { type: String, trim: true, default: "" },
    engagementRecordedAt: { type: Date, default: null },

    consentEvaluatedAt: { type: Date, default: null },
    consentRecorded: { type: Boolean, default: false },

    completedAt: { type: Date, default: null },

    /* ── FOR OPERATORS, AND NEVER PUBLISHED ──────────────────────────────
       A count, not a log of failures. The failure detail goes to the server
       log; a receipt that accumulated driver errors would become the thing
       nobody dares show anybody. */
    attempts: { type: Number, default: 0, min: 0 },
    lastAttemptAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "marketing_lead_processing_receipts", strict: "throw" },
);

/* ── ONE RECEIPT PER SUBMISSION PER CONTRACT VERSION ────────────────────────
   The fence that makes the whole thing idempotent: two workers racing on one
   submission produce one receipt, and the loser reads the winner's. */
receiptSchema.index(
  { companyId: 1, leadId: 1, contractVersion: 1 },
  { unique: true },
);
receiptSchema.index({ companyId: 1, stage: 1, updatedAt: -1 });

/* ── NOTHING FROM THE PERSON MAY BE WRITTEN HERE ────────────────────────────
   `strict: "throw"` refuses a field outside the schema already. This names the
   ones somebody would reach for while debugging — "just the email, so I can
   see which one it was" — so the refusal explains itself. */
const FORBIDDEN_FIELDS = Object.freeze([
  "email", "phone", "contact", "answers", "unmapped", "payload", "rawPayload",
  "providerSubmissionId", "providerCampaignId", "providerFormId",
  "google_key", "error", "stack", "driverError",
]);

receiptSchema.pre("save", function refuseContents(next) {
  for (const field of FORBIDDEN_FIELDS) {
    if (this.get(field) !== undefined) {
      return next(new Error(
        `A processing receipt carries references and reason codes, not contents: ${field} cannot be written here.`,
      ));
    }
  }
  return next();
});

/* ── WHAT A SCREEN MAY SEE ──────────────────────────────────────────────────
   Field by field, and deliberately not the stage name, the attempt count or
   the reason code. Those describe GRAV's machinery; a marketer needs to know
   what happened to their enquiry. */
receiptSchema.methods.publicView = function publicView() {
  const states = [];

  if (this.gravPersonKey) {
    states.push(this.identityCreated ? "new_person_created" : "matched_existing_person");
  }
  if (this.stage === "needs_human_review") states.push("needs_identity_review");
  if (this.engagementRecordedAt) states.push("engagement_recorded");
  if (this.consentEvaluatedAt) {
    states.push(this.consentRecorded
      ? "marketing_permission_recorded"
      : "no_marketing_permission_recorded");
  }
  if (!this.completedAt && this.stage !== "needs_human_review") {
    states.push("processing_incomplete");
  }

  return {
    submissionRef: this.submissionRef,
    states,
    finished: Boolean(this.completedAt),
    updatedAt: this.updatedAt,
  };
};

const MarketingLeadProcessingReceipt = mongoose.models.MarketingLeadProcessingReceipt
  || mongoose.model("MarketingLeadProcessingReceipt", receiptSchema);

module.exports = { MarketingLeadProcessingReceipt, FORBIDDEN_FIELDS };
