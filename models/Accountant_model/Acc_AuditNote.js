// models/Accountant_model/Acc_AuditNote.js
//
// Audit notes — a viewer/auditor flags something for the team to fix.
//
// Lifecycle:
//   open → in_progress → resolved → verified   (done)
//                                  → rejected   (reason given, loops back)
//        rejected → in_progress → resolved → verified | rejected → …
//
// Each note carries a thread[] of actions so there's a full audit trail.
// A note can optionally target a specific entity (ledger, voucher, group)
// or stand alone as a general observation.

const mongoose = require("mongoose");

const auditNoteThreadSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "created", // viewer opened the note
        "commented", // anyone added a comment
        "acknowledged", // editor/admin marked "working on it"
        "resolved", // editor/admin says "fixed"
        "verified", // viewer confirms the fix is correct
        "rejected", // viewer says "not fixed" with a reason
        "reopened", // auto-set when rejected (status → in_progress)
      ],
      required: true,
    },
    body: { type: String, default: "" }, // comment text / rejection reason
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    userName: { type: String, default: "" },
    userRole: { type: String, default: "" },
  },
  { timestamps: true, _id: true },
);

const auditNoteSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Organization",
      required: true,
      index: true,
    },
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },

    // Optional target — if set, this note is attached to a specific entity.
    // If absent, it's a general/freestanding observation.
    target: {
      type: {
        type: String,
        enum: ["ledger", "voucher", "group", "general", "payroll"],
        default: "general",
      },
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, default: "" }, // snapshot for display
      extra: { type: String, default: "" }, // e.g. group name, voucher number
    },

    // The initial subject line / flag description
    title: { type: String, required: true, trim: true },

    status: {
      type: String,
      enum: ["open", "in_progress", "resolved", "verified", "rejected"],
      default: "open",
      index: true,
    },

    priority: {
      type: String,
      enum: ["low", "medium", "high", "critical"],
      default: "medium",
    },

    // Full conversation thread — every action + comment in order
    thread: [auditNoteThreadSchema],

    // Who created it
    createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    createdByName: { type: String, default: "" },
    createdByRole: { type: String, default: "" },

    // Who last acted on it
    lastActedByName: { type: String, default: "" },
    lastActedAt: { type: Date },

    // Resolved / verified tracking
    resolvedByName: { type: String, default: "" },
    resolvedAt: { type: Date },
    verifiedByName: { type: String, default: "" },
    verifiedAt: { type: Date },
  },
  {
    timestamps: true,
    collection: "acc_audit_notes",
  },
);

// Compound index for "show me all notes on this ledger"
auditNoteSchema.index({ "target.type": 1, "target.id": 1 });
// For listing by status across an org
auditNoteSchema.index({ organizationId: 1, status: 1, updatedAt: -1 });

module.exports =
  mongoose.models.Acc_AuditNote ||
  mongoose.model("Acc_AuditNote", auditNoteSchema);
