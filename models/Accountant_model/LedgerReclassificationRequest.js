// models/Accountant_model/LedgerReclassificationRequest.js
//
// PROPOSED MOVES for ledgers on the Chart of Accounts / Balance Sheet.
//
// A user drags a ledger from one group to another (or reorders within a
// group). If they have post-directly permission (owner/approver), the
// change applies immediately. Otherwise this collection records the
// proposal until an approver reviews it.
//
// Workflow
// ────────
//   editor drags ledger → POST /api/accountant/ledger-reclass/propose
//                       → status="pending_approval"
//   owner/approver approves
//                       → server updates TallyLedger.groupId / groupOrder
//                       → request marked status="approved", applied: true
//   owner/approver rejects
//                       → request marked status="rejected"
//
// When approved, the actual ledger fields written are:
//   groupId      → toGroupId
//   groupName    → cached from the destination group
//   nature       → inherited from destination group (this is why cross-
//                  category drags need a warning — nature changes too)
//   groupOrder   → newOrder if supplied
//   reclassifiedAt, reclassifiedBy, reclassificationCount → audit
//
// Visibility on the Balance Sheet
// ───────────────────────────────
// Pending requests are visible:
//   - to the creator (editor): the ledger appears in its NEW location
//                              with a "pending" badge (overlay applied
//                              client-side, server still reports OLD)
//   - to approvers/owners:     visible in the Approvals queue
//   - to everyone else:        invisible; ledger appears in OLD location
//
// 4-eyes: creator can't approve their own request.

const mongoose = require("mongoose");

const ledgerReclassSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantOrganization",
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCompany",
      required: true,
      index: true,
    },

    ledgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyLedger",
      required: true,
      index: true,
    },
    // Denormalised — survives if ledger is later renamed/deleted
    ledgerName: { type: String, default: "" },

    // Source — captured at propose time. If the ledger has already moved
    // by the time we apply (race condition), we still apply using
    // toGroupId — but log that the source mismatches.
    fromGroupId: { type: mongoose.Schema.Types.ObjectId, ref: "TallyGroup" },
    fromGroupName: { type: String, default: "" },
    fromNature: {
      type: String,
      enum: ["asset", "liability", "equity", "revenue", "expense"],
    },

    // Destination
    toGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyGroup",
      required: true,
    },
    toGroupName: { type: String, default: "" },
    toNature: {
      type: String,
      enum: ["asset", "liability", "equity", "revenue", "expense"],
    },

    // Optional: position within destination group. If null, the ledger
    // is appended (sort-key = max+gap). If set, the dest group's other
    // ledgers shift to make room.
    newOrder: { type: Number, default: null },

    // True if source and destination groups have different `nature` (e.g.
    // liability → equity). UI flagged this and the user confirmed.
    isCrossCategory: { type: Boolean, default: false },

    // Workflow
    status: {
      type: String,
      enum: ["pending_approval", "approved", "rejected", "void"],
      required: true,
      default: "pending_approval",
      index: true,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
      required: true,
    },
    createdByName: { type: String, default: "" },
    createdByRole: { type: String, default: "" },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "AccountantUser" },
    reviewedByName: { type: String, default: "" },
    reviewedAt: { type: Date },
    reviewNote: { type: String, default: "" },

    appliedAt: { type: Date }, // when the actual ledger field write happened
    notes: { type: String, default: "" },
  },
  { timestamps: true, collection: "accountant_ledger_reclass_requests" },
);

ledgerReclassSchema.index({ organizationId: 1, status: 1, createdAt: -1 });
ledgerReclassSchema.index({ companyId: 1, ledgerId: 1, status: 1 });

const LedgerReclassificationRequest =
  mongoose.models.LedgerReclassificationRequest ||
  mongoose.model("LedgerReclassificationRequest", ledgerReclassSchema);

module.exports = LedgerReclassificationRequest;
