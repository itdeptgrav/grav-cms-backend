// models/Accountant_model/Acc_CashFlowAdjustment.js
//
// CASH FLOW ADJUSTMENT — manually-entered "Particulars" rows on the
// Cash Flow report.
//
// Why a separate collection rather than a tag on Acc_Voucher?
// Cash Flow adjustments are NOT real ledger postings. They're manual
// classifications the accountant adds to reconcile/explain non-voucher
// cash movements (e.g. opening cash brought forward, year-end
// adjustments, owner contributions reclassified, etc.). Posting them
// as TallyVouchers would double-count on the P&L / Trial Balance.
//
// Lifecycle:
//   • Owner / Approver creates → status = "posted" immediately
//   • Editor creates → status = "pending_approval"
//   • Approver approves → status = "posted"
//   • Approver rejects  → status = "rejected"
//   • Anyone with edit rights deletes → status = "void" (soft delete)
//
// Filtering convention: the report includes adjustments where
// (periodStart, periodEnd) overlaps the report's period; if either
// is null, that bound is treated as open. The fyTag is a denormalised
// helper for quick FY filtering (e.g. "2026-27").
//
// Section codes:
//   "A" — Operating Activities (CFO)
//   "B" — Investing Activities (CFI)
//   "C" — Financing Activities (CFF)
//   "R" — Reconciliation / non-cash adjustments
//
// The route does role-based pre-validation; this schema doesn't enforce
// approval rules. Schema-level validation is just for data integrity.

const mongoose = require("mongoose");

const cashFlowAdjustmentSchema = new mongoose.Schema(
  {
    // Org scoping — every read goes through req.user.organizationId so
    // a sub-account from Org X can never see Org Y's adjustments. Index
    // for fast org-scoped lookups.
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantOrg",
      required: true,
      index: true,
    },

    // Cash-flow section the row sits under
    section: {
      type: String,
      enum: ["A", "B", "C", "R"],
      required: true,
    },

    // Display label as it appears on the report (e.g. "Owner's capital
    // contribution", "FD broken — re-classed")
    label: {
      type: String,
      required: true,
      trim: true,
      maxlength: 200,
    },

    // Signed amount. Inflows positive, outflows negative. The cash-flow
    // report aggregates these directly without further sign-flipping.
    amount: { type: Number, required: true },

    // Optional FY tag for quick filtering on the cash-flow page. Format
    // "YYYY-YY", e.g. "2026-27". Not required since periodStart/End
    // also let us bound by date.
    fyTag: { type: String, trim: true, default: "" },

    // Period this adjustment applies to. The report's filter checks
    // for overlap; either end can be null = open-ended.
    periodStart: { type: Date },
    periodEnd:   { type: Date },

    // Free-text notes — appears on hover / in the audit log
    notes: { type: String, trim: true, default: "" },

    // Lifecycle status
    status: {
      type: String,
      enum: ["pending_approval", "posted", "rejected", "void"],
      default: "pending_approval",
      index: true,
    },

    // Creation audit
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_User",
      required: true,
    },
    createdByName: { type: String, trim: true, default: "" },
    createdByRole: { type: String, trim: true, default: "" },

    // Approval / rejection audit
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_User",
    },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt:     { type: Date },
    reviewNote:     { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "acc_cashflow_adjustments" },
);

// Compound index for the most common query (list by org + period overlap).
// `periodStart` and `periodEnd` separately doesn't help since the route
// queries by both, so a compound (org, status, periodStart) covers the
// hot path.
cashFlowAdjustmentSchema.index({ organizationId: 1, status: 1, periodStart: 1 });

module.exports = mongoose.model("Acc_CashFlowAdjustment", cashFlowAdjustmentSchema);
