// models/CMS_Models/Marketing/MarketingAdvertisingLead.js
//
// ONE ENQUIRY SOMEBODY SUBMITTED, AS IT ARRIVED.
//
// ── EVIDENCE, NOT A WORKING RECORD ─────────────────────────────────────────
// This is what a person typed into a form at a moment. It is append-only, and
// deliberately carries no processing state: no "identity resolved", no "consent
// written", no "handed to Sales". Those are things GRAV LATER DECIDED, and a
// decision stored on the evidence it was drawn from can be revised until the
// evidence appears to have always said so.
//
// They belong on projections and receipts beside this row. The rule is worth
// stating because the pressure to add one field — just a status, just a flag —
// is constant and the first one is the only one anybody argues about.
//
// ── WHAT IS NOT HERE, AND WHY EACH ONE WOULD BE A PROBLEM ──────────────────
// The raw body: it contains the webhook key, so keeping it would put a working
// credential in every backup.
//   `column_name`: Google marks it deprecated and it may be absent or wrong.
// Storing it invites somebody to read a field by its label later.
//   The route token: it is the address anybody who holds it can post leads to.
//   Request headers: they carry whatever a sender chose to attach.
//   The advertising account number: this row is read by marketers.
//
// ── AND THE PROVIDER IDS THAT ARE HERE ARE BACKEND-ONLY ────────────────────
// `providerSubmissionId` is the deduplication fence and has to be here.
// `providerCampaignId` and `providerFormId` are correlation. All three are
// `select: false`, so a careless `.find()` does not carry them into a response.
"use strict";

const mongoose = require("mongoose");

/* Digits, as an int64 arrives. A Mongo Number is a double and would alter the
   last digits of a large id without saying so. */
const providerId = () => ({
  type: String,
  trim: true,
  default: "",
  validate: {
    validator: (v) => v === "" || /^\d{1,20}$/.test(v),
    message: "A provider identifier is stored as digits, exactly as the channel sent them.",
  },
  select: false,
});

/* ── WHAT SOMEBODY TYPED ABOUT THEMSELVES ───────────────────────────────────
   The question travels with the answer, because "201-500" means nothing
   without "What size is your company?" — and `selfReported` travels with both,
   because Google checks none of it against an employer or a registry. */
const answerSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 80 },
    question: { type: String, required: true, trim: true, maxlength: 300 },
    answer: { type: String, required: true, trim: true, maxlength: 2000 },
    selfReported: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

/* An answer to a question GRAV does not recognise. Kept verbatim and NOT
   interpreted: guessing its meaning from a deprecated label would record an
   answer to a question nobody asked. */
const unmappedSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, trim: true, maxlength: 80 },
    answer: { type: String, required: true, trim: true, maxlength: 2000 },
    selfReported: { type: Boolean, required: true, default: true },
    needsReview: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

const leadSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },

    /* GRAV's own public identity for this submission. What a marketer sees and
       what a URL carries — never the database id, never Google's. */
    submissionRef: { type: String, required: true, trim: true },

    channel: { type: String, required: true, trim: true, default: "google_ads" },

    campaignDraftId: { type: mongoose.Schema.Types.ObjectId, required: true },
    draftRef: { type: String, required: true, trim: true },
    approvedRevision: { type: Number, required: true, min: 1 },
    deploymentId: { type: mongoose.Schema.Types.ObjectId, default: null },
    bindingId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* ── THE DEDUPLICATION FENCE ─────────────────────────────────────────
       Google's own id for the submission. Delivery is explicitly
       at-least-once, so this arriving twice is expected rather than
       exceptional, and the unique index below is what makes the second one
       free. */
    providerSubmissionId: { type: String, required: true, trim: true, select: false },
    providerCampaignId: providerId(),
    providerFormId: providerId(),

    /* When the person submitted, as Google reported it. Distinct from when
       GRAV received it — a recovery sweep can deliver a week-old submission
       after a newer one, and ordering by arrival would put them backwards. */
    submittedAt: { type: Date, default: null },
    receivedAt: { type: Date, required: true, default: Date.now },

    /* ── THE CONTACT DETAILS, EACH UNDER GRAV'S OWN NAME ─────────────────
       A closed set. `column_id` decided which field each one is; the
       deprecated label never entered the decision and is not stored. */
    contact: {
      fullName: { type: String, trim: true, default: "" },
      firstName: { type: String, trim: true, default: "" },
      lastName: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, lowercase: true, default: "" },
      workEmail: { type: String, trim: true, lowercase: true, default: "" },
      phone: { type: String, trim: true, default: "" },
      workPhone: { type: String, trim: true, default: "" },
      postalCode: { type: String, trim: true, default: "" },
      streetAddress: { type: String, trim: true, default: "" },
      city: { type: String, trim: true, default: "" },
      region: { type: String, trim: true, default: "" },
      country: { type: String, trim: true, default: "" },
      companyName: { type: String, trim: true, default: "" },
      jobTitle: { type: String, trim: true, default: "" },
    },

    answers: { type: [answerSchema], default: [] },
    unmapped: { type: [unmappedSchema], default: [] },

    /* The one thing Google itself checked — that a phone line answers. Not
       that a person, an employer or a job is what somebody said it is. */
    phoneVerified: { type: Boolean, default: null },

    clickId: { type: String, trim: true, default: "" },
    leadSource: { type: String, trim: true, default: "" },
    leadStage: { type: String, trim: true, default: "" },
    apiVersion: { type: String, trim: true, default: "" },

    /* How it reached GRAV. `recovery` is not reachable in this chunk and the
       enum carries it so the reconciliation sweep needs no migration. */
    ingestionOrigin: { type: String, enum: ["delivery", "recovery"], required: true, default: "delivery" },

    /* Production, always. A test delivery never reaches this collection — it
       has its own, with no person on it. Recorded rather than implied so a
       query cannot accidentally include one if that ever changes. */
    classification: { type: String, enum: ["production"], required: true, default: "production" },
  },
  { timestamps: true, collection: "marketing_advertising_leads", strict: "throw" },
);

/* ── ONE SUBMISSION, ONCE, PER COMPANY ──────────────────────────────────────
   Company first, so two companies receiving the same provider id — which is
   possible and must work — create two independent records rather than
   colliding. */
leadSchema.index({ companyId: 1, channel: 1, providerSubmissionId: 1 }, { unique: true });
leadSchema.index({ companyId: 1, submissionRef: 1 }, { unique: true });
leadSchema.index({ companyId: 1, receivedAt: -1 });
leadSchema.index({ companyId: 1, campaignDraftId: 1, receivedAt: -1 });

/* ── APPEND-ONLY, ON EVERY PATH ─────────────────────────────────────────────
   A `pre("save")` hook alone leaves `updateOne`, `bulkWrite` and the rest wide
   open, and bulk operations are exactly how a well-meaning migration edits a
   million rows at once.

   This is evidence of what somebody typed. If it can be edited, it is no
   longer evidence of anything. */
const APPEND_ONLY = "marketing_advertising_leads is append-only: a submitted enquiry is evidence of what somebody typed, and evidence that can be edited is not evidence.";

const refuse = function refuseMutation(next) { next(new Error(APPEND_ONLY)); };

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndUpdate", "findByIdAndDelete",
]) {
  leadSchema.pre(op, refuse);
}

leadSchema.pre("save", function refuseRewrite(next) {
  if (!this.isNew) return refuse(next);
  return next();
});

/* `bulkWrite` and `insertMany` do not fire the query middleware above, so they
   are guarded where they actually run: an insert-only bulk is allowed, and
   anything else is refused. */
leadSchema.pre("bulkWrite", function refuseBulkMutation(next, ops) {
  const operations = Array.isArray(ops) ? ops : [];
  const mutating = operations.filter((o) => !Object.prototype.hasOwnProperty.call(o || {}, "insertOne"));
  if (mutating.length) return next(new Error(APPEND_ONLY));
  return next();
});

const MarketingAdvertisingLead = mongoose.models.MarketingAdvertisingLead
  || mongoose.model("MarketingAdvertisingLead", leadSchema);

/* ═══════════════════════════════════════════════════════════════════════════
   A TEST DELIVERY — PROOF IT WORKED, AND NOBODY IN IT
   ═══════════════════════════════════════════════════════════════════════════
   Google sends these from a button in the advertising interface, carrying
   "John Doe" and "+11234567890". Somebody checking a connection wants to know
   the delivery arrived and verified. Nobody wants a fictional person in the
   Marketing records, and nobody should be ringing that number.

   So a test delivery is recorded as four facts and no person: which binding,
   when, which schema version, and that verification passed. The sample name,
   email and phone are dropped before anything is written. */
const testDeliverySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    bindingId: { type: mongoose.Schema.Types.ObjectId, required: true },
    channel: { type: String, required: true, trim: true, default: "google_ads" },

    /* Google's id for the test submission — so a repeated test is idempotent
       too, and does not fill the collection with one button press. */
    providerSubmissionId: { type: String, required: true, trim: true, select: false },

    receivedAt: { type: Date, required: true, default: Date.now },
    apiVersion: { type: String, trim: true, default: "" },
    verified: { type: Boolean, required: true, default: true },

    classification: { type: String, enum: ["test"], required: true, default: "test" },
  },
  { timestamps: true, collection: "marketing_advertising_lead_tests", strict: "throw" },
);

testDeliverySchema.index({ companyId: 1, providerSubmissionId: 1 }, { unique: true });
testDeliverySchema.index({ companyId: 1, bindingId: 1, receivedAt: -1 });

/* ── AND NO PERSON MAY BE ADDED LATER ───────────────────────────────────────
   `strict: "throw"` refuses an unknown field, so a future edit that tries to
   keep "just the email, for debugging" fails at the write. */
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "deleteMany"]) {
  testDeliverySchema.pre(op, function refuseTestMutation(next) {
    next(new Error("marketing_advertising_lead_tests is append-only."));
  });
}

const MarketingAdvertisingLeadTest = mongoose.models.MarketingAdvertisingLeadTest
  || mongoose.model("MarketingAdvertisingLeadTest", testDeliverySchema);

module.exports = {
  MarketingAdvertisingLead,
  MarketingAdvertisingLeadTest,
  APPEND_ONLY,
};
