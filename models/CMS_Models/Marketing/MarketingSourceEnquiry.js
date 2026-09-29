// models/CMS_Models/Marketing/MarketingSourceEnquiry.js
//
// AN ENQUIRY PULLED FROM A LEAD SOURCE THAT IS NOT AN ADVERTISING CAMPAIGN.
//
// ── WHY NOT MarketingAdvertisingLead ───────────────────────────────────────
// That record is evidence of a Google lead form GRAV itself published: it
// requires a campaign plan, an approved revision and a delivery binding. An
// IndiaMART enquiry has none of those, and inventing them would make a
// marketplace enquiry look like the answer to a campaign GRAV ran. So a lead
// source gets its own record, and the inbox reads both.
//
// ── APPEND-ONLY ────────────────────────────────────────────────────────────
// This is what the source sent, at the moment GRAV fetched it. The same
// enquiry fetched again (overlapping windows, a retried check, a lost
// response) is recognised by the source's own key and never written twice,
// and never overwritten: the first copy stands.
//
// ── NOTHING FOLLOWS FROM IT ────────────────────────────────────────────────
// No person, consent, Sales Lead, Sales enquiry, journey, activity or handover
// is created from this record. It carries no permission field at all, because
// the source never asked.
"use strict";

const mongoose = require("mongoose");

const text = (max) => ({ type: String, trim: true, maxlength: max, default: "" });

const contactSchema = new mongoose.Schema(
  {
    fullName: text(200),
    /* True when the source filled the name with its own placeholder
       ("IndiaMART Buyer"). The placeholder is not stored as a name. */
    nameIsPlaceholder: { type: Boolean, default: false },
    companyName: text(300),
    phone: text(40),
    phoneAlt: text(40),
    landline: text(40),
    landlineAlt: text(40),
    email: text(254),
    emailAlt: text(254),
    streetAddress: text(500),
    city: text(120),
    region: text(120),
    postalCode: text(20),
    country: text(8),
  },
  { _id: false, strict: "throw" },
);

const contextSchema = new mongoose.Schema(
  {
    subject: text(500),
    productName: text(300),
    categoryName: text(300),
    message: text(5000),
    callDurationSeconds: { type: Number, min: 0, default: null },
    receiverPhone: text(40),
  },
  { _id: false, strict: "throw" },
);

const sourceEnquirySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    /* GRAV's own reference: the only identifier that leaves the server. */
    submissionRef: { type: String, required: true, match: /^MSE-[a-f0-9]{16}$/ },
    source: { type: String, enum: ["indiamart"], required: true },
    /* The source's own id for the enquiry (IndiaMART's UNIQUE_QUERY_ID). The
       deduplication key; never selected into a response. */
    externalEventKey: { type: String, required: true, maxlength: 64, select: false },

    kind: { type: String, enum: ["buyer_enquiry", "purchased_lead", "catalog_view", "unclassified"], required: true },
    /* The source's type code as sent (IndiaMART's QUERY_TYPE), for the record. */
    sourceType: text(16),

    /* When the buyer made the enquiry, if the source's time could be read. */
    submittedAt: { type: Date, default: null },
    /* The source's time exactly as sent, so an unreadable one is not lost. */
    submittedAtText: text(40),
    receivedAt: { type: Date, required: true },

    contact: { type: contactSchema, default: () => ({}) },
    context: { type: contextSchema, default: () => ({}) },

    /* How GRAV came to hold it. Never a key, a URL or a request. */
    provenance: {
      type: new mongoose.Schema(
        {
          method: { type: String, enum: ["pull_api"], required: true },
          windowFrom: { type: Date, required: true },
          windowTo: { type: Date, required: true },
          pulledAt: { type: Date, required: true },
        },
        { _id: false, strict: "throw" },
      ),
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: "marketing_source_enquiries", strict: "throw" },
);

/* Dedupe: one record per source enquiry per company. */
sourceEnquirySchema.index({ companyId: 1, source: 1, externalEventKey: 1 }, { unique: true });
sourceEnquirySchema.index({ companyId: 1, submissionRef: 1 }, { unique: true });
sourceEnquirySchema.index({ companyId: 1, receivedAt: -1 });

const APPEND_ONLY = "marketing_source_enquiries is append-only: it records what a lead source sent, and a record that can be edited records nothing.";
const refuse = function refuseMutation(next) { next(new Error(APPEND_ONLY)); };

for (const op of [
  "updateOne", "updateMany", "findOneAndUpdate", "findOneAndReplace", "replaceOne",
  "deleteOne", "deleteMany", "findOneAndDelete", "findByIdAndUpdate", "findByIdAndDelete",
]) {
  sourceEnquirySchema.pre(op, refuse);
}

sourceEnquirySchema.pre("save", function refuseRewrite(next) {
  if (!this.isNew) return refuse(next);
  return next();
});

sourceEnquirySchema.pre("bulkWrite", function refuseBulkMutation(next, ops) {
  const operations = Array.isArray(ops) ? ops : [];
  const mutating = operations.filter((o) => !Object.prototype.hasOwnProperty.call(o || {}, "insertOne"));
  if (mutating.length) return next(new Error(APPEND_ONLY));
  return next();
});

const MarketingSourceEnquiry = mongoose.models.MarketingSourceEnquiry
  || mongoose.model("MarketingSourceEnquiry", sourceEnquirySchema);

module.exports = { MarketingSourceEnquiry };
