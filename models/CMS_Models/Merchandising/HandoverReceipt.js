// models/CMS_Models/Merchandising/HandoverReceipt.js
//
// MERCHANDISING'S DECISION ON ONE HANDOVER VERSION.
//
// ── RECEIVER-OWNED, AND WHY THAT MATTERS ────────────────────────────────────
// Sales states; Merchandising decides. The version record is Sales' and the
// receipt is Merchandising's, so neither app ever writes the other's half of
// the exchange — a new Sales version cannot overwrite what Merchandising
// decided about the old one, because the decision lives here and Sales has no
// door onto it.
//
// One receipt per version, database-enforced. A receipt is created when a
// decision is taken (accept, or request clarification); a version nobody has
// decided on has no receipt, and the API reports it as PENDING — absence of a
// decision IS the pending state, not a row claiming one.
//
// SUPERSEDED and CANCELLED_BY_SALES are in the state enum because a decision
// row's standing changes when Sales moves: a clarification request against
// version 1 is settled the moment version 2 issues, and the receipt records
// that settlement rather than looking eternally unanswered.
//
// ── AND THERE IS NO "DECLINED" ──────────────────────────────────────────────
// Deliberately absent from the enum, the service and every screen.
// Merchandising cannot reject a commercial order — it can accept the
// execution brief or say precisely what stops it from accepting, and the
// commercial resolution (a revised version, or cancellation) is Sales' to
// make. An enum value here would be the first step of a workflow the
// ownership table forbids.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/** The structured reasons a clarification request must choose from. */
const CLARIFICATION_CATEGORIES = Object.freeze([
  "MISSING_EXECUTION_INFORMATION",
  "QUANTITY_OR_DELIVERY_MISMATCH",
  "PACKING_TESTING_REQUIREMENT_UNCLEAR",
  "FACTORY_CAPABILITY_MISMATCH",
  "OTHER",
]);

const handoverReceiptSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true,
    },
    handoverVersionId: {
      type: mongoose.Schema.Types.ObjectId, ref: "SalesHandoverVersion",
      required: true, immutable: true,
    },
    handoverRef: { type: String, trim: true, required: true },
    handoverLineRef: { type: String, trim: true, required: true },
    /* The version number decided on, denormalised so the history reads
       without a join. */
    sourceVersionNo: { type: Number, required: true },

    state: {
      type: String,
      enum: ["PENDING", "ACCEPTED", "CLARIFICATION_REQUESTED", "SUPERSEDED", "CANCELLED_BY_SALES"],
      required: true,
    },

    clarification: {
      category: { type: String, enum: CLARIFICATION_CATEGORIES, default: undefined },
      reason: { type: String, trim: true, maxlength: 2000, default: undefined },
    },

    /* Set on acceptance: the file this decision produced or re-pointed. */
    executionFileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "MerchandisingExecutionFile", default: null,
    },

    decidedBy: actorRef(),
    decidedAt: { type: Date },
    /* One correlation identity per decision, carried onto the audit event and
       any outbox entry the same transaction writes. */
    correlationId: { type: String, trim: true, required: true },
  },
  { timestamps: true },
);

/* One decision record per version. The database, not the code path, is what
   stops two decisions racing onto one statement. */
handoverReceiptSchema.index({ companyId: 1, handoverVersionId: 1 }, { unique: true });
handoverReceiptSchema.index({ companyId: 1, handoverRef: 1, handoverLineRef: 1, createdAt: 1 });

handoverReceiptSchema.statics.CLARIFICATION_CATEGORIES = CLARIFICATION_CATEGORIES;

module.exports = mongoose.models.MerchandisingHandoverReceipt
  || mongoose.model("MerchandisingHandoverReceipt", handoverReceiptSchema);
