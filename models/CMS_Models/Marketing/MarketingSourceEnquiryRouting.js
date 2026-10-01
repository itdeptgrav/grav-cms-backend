// models/CMS_Models/Marketing/MarketingSourceEnquiryRouting.js
//
// WHAT GRAV DID WITH ONE LEAD-SOURCE ENQUIRY: SENT IT TO SALES, HELD IT FOR A
// PERSON, OR KEPT IT OUT — AND WHY.
//
// ── ONE ROW PER ENQUIRY, EVER ──────────────────────────────────────────────
// Unique on (company, enquiry). The row is created once, claimed atomically by
// whichever worker routes it, and carries the handover it produced. A retry, a
// second worker, a crashed worker or a second pull of the same enquiry all
// land on this same row, so an enquiry can produce at most one handover — and
// the handover's own correlation id (derived from this enquiry) and Sales'
// receipt ledger (unique per handover) close the remaining doors.
//
// ── WHY NOT A FIELD ON THE ENQUIRY ─────────────────────────────────────────
// The enquiry is append-only evidence of what the source sent. What GRAV
// decided about it is workflow state, and changes; it lives here.
//
// ── NOTHING SECRET, NOTHING PERSONAL ───────────────────────────────────────
// No contact detail, no source id, no key. A reviewer's supplied company or
// contact name is kept, because it is what was handed over in their name.
"use strict";

const mongoose = require("mongoose");

const I = require("../../../constants/marketingIndiamart");

const routingSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    enquiryId: { type: mongoose.Schema.Types.ObjectId, required: true },
    submissionRef: { type: String, required: true, trim: true },
    source: { type: String, enum: ["indiamart"], required: true },
    kind: { type: String, trim: true, default: "" },

    state: { type: String, enum: I.ROUTING_STATE_CODES, default: "pending" },
    reason: { type: String, enum: [...I.HOLD_REASON_CODES, ""], default: "" },
    /* A GRAV sentence (the handover's own refusal, or the rejected field). */
    reasonDetail: { type: String, trim: true, default: "", maxlength: 500 },

    handoverRef: { type: String, trim: true, default: "" },
    handoverId: { type: mongoose.Schema.Types.ObjectId, default: null },
    correlationId: { type: String, trim: true, default: "" },
    sentAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    deliveryAttempts: { type: Number, default: 0 },

    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: null },
    lastErrorCode: { type: String, trim: true, default: "" },

    claimToken: { type: String, default: "" },
    claimUntil: { type: Date, default: null },

    decidedAt: { type: Date, default: null },
    /* ── A REVIEWER-CONFIRMED ENQUIRY TIME ─────────────────────────────────
       Only when the source's time text could not be read, or was impossible.
       The source's text stays untouched on the enquiry. Kept apart from
       `review` so a later release (e.g. supplying a company) cannot erase who
       confirmed the time and how. Set once. */
    timeConfirmation: {
      type: new mongoose.Schema(
        {
          submittedAt: { type: Date, required: true },
          fromReason: { type: String, trim: true, required: true },
          at: { type: Date, required: true },
          by: {
            id: { type: String, trim: true, default: "" },
            name: { type: String, trim: true, default: "" },
          },
          note: { type: String, trim: true, required: true, maxlength: 500 },
        },
        { _id: false },
      ),
      default: null,
    },
    /* An explicit review. `override` is only what the reason allows. */
    review: {
      type: new mongoose.Schema(
        {
          action: { type: String, enum: ["release", "dismiss"], required: true },
          at: { type: Date, required: true },
          by: {
            id: { type: String, trim: true, default: "" },
            name: { type: String, trim: true, default: "" },
          },
          fromReason: { type: String, trim: true, default: "" },
          note: { type: String, trim: true, default: "", maxlength: 500 },
          override: {
            companyName: { type: String, trim: true, default: "", maxlength: 300 },
            contactName: { type: String, trim: true, default: "", maxlength: 200 },
            confirmBuyerEnquiry: { type: Boolean, default: false },
            usePhoneOnly: { type: Boolean, default: false },
          },
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true, collection: "marketing_source_enquiry_routings", strict: "throw" },
);

routingSchema.index({ companyId: 1, enquiryId: 1 }, { unique: true });
routingSchema.index({ companyId: 1, submissionRef: 1 }, { unique: true });
routingSchema.index({ companyId: 1, state: 1, nextAttemptAt: 1, createdAt: 1 });

const MarketingSourceEnquiryRouting = mongoose.models.MarketingSourceEnquiryRouting
  || mongoose.model("MarketingSourceEnquiryRouting", routingSchema);

module.exports = { MarketingSourceEnquiryRouting };
