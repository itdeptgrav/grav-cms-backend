// models/CMS_Models/StorePurchase/SpApprovalPolicy.js
//
// Store & Purchase — Chunk 1. WHO MAY APPROVE WHAT, AND UP TO HOW MUCH.
//
// ── A FOUNDATION, NOT A WORKFLOW ────────────────────────────────────────────
// Chunk 1 does not invent a procurement workflow. This model exists so that
// the ONE approval transition that already exists — a purchase order moving
// DRAFT → ISSUED, which today stamps `approvedBy` from whoever called it with
// no check at all — can have its authority moved server-side without waiting
// for the requisition and sourcing chain that Chunks 4–6 will build.
//
// ── AMBIGUITY IS REFUSED, NOT RESOLVED ──────────────────────────────────────
// Two active rules that both match one document is a configuration mistake,
// and picking "the first" or "the narrowest" would hide it. The resolver
// returns AMBIGUOUS and the caller refuses the transition, which is the safe
// direction: a buyer told to fix the policy is better than money approved by
// a rule nobody meant to write.
"use strict";

const mongoose = require("mongoose");

const approvalLevelSchema = new mongoose.Schema(
  {
    /* 1-based, ordered. Level 2 cannot act before level 1 has. */
    level: { type: Number, required: true, min: 1 },

    /* Either is sufficient to define who may act at this level; the
       capability is preferred because it survives a role rename. */
    requiredCapability: { type: String, trim: true, default: "" },
    requiredRole: { type: String, trim: true, default: "" },

    label: { type: String, trim: true, default: "" },
  },
  { _id: false },
);

const approvalPolicySchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Server vocabulary — "PURCHASE_ORDER", "REQUISITION", … */
    documentType: { type: String, required: true, trim: true, index: true },

    /* Amount band, inclusive lower bound, exclusive upper. `maxAmount: null`
       means "and above", which every complete policy set needs exactly one of
       per document type. */
    minAmount: { type: Number, default: 0, min: 0 },
    maxAmount: { type: Number, default: null },

    levels: {
      type: [approvalLevelSchema],
      validate: {
        validator: (v) => Array.isArray(v) && v.length > 0,
        message: "An approval policy needs at least one level.",
      },
    },

    /* An emergency policy is deliberately a SEPARATE rule rather than a flag
       on the ordinary one: "emergency" must never mean "unapproved", it means
       a different, recorded authority. Emergency and ordinary rules do not
       collide with each other in resolution. */
    isEmergencyPolicy: { type: Boolean, default: false, index: true },

    effectiveFrom: { type: Date, default: null },
    effectiveTo: { type: Date, default: null },
    isActive: { type: Boolean, default: true, index: true },

    note: { type: String, trim: true, default: "" },
    createdBy: { type: mongoose.Schema.Types.ObjectId },
    createdByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "sp_approval_policies" },
);

approvalPolicySchema.index({ companyId: 1, documentType: 1, isActive: 1 });

approvalPolicySchema.pre("validate", function (next) {
  if (this.maxAmount !== null && this.maxAmount !== undefined && this.maxAmount <= this.minAmount) {
    return next(new Error("maxAmount must be greater than minAmount."));
  }
  if (this.effectiveFrom && this.effectiveTo && this.effectiveTo <= this.effectiveFrom) {
    return next(new Error("effectiveTo must be after effectiveFrom."));
  }
  for (const lvl of this.levels || []) {
    if (!lvl.requiredCapability && !lvl.requiredRole) {
      return next(new Error("Each approval level needs a required capability or role."));
    }
  }
  next();
});

module.exports =
  mongoose.models.SpApprovalPolicy ||
  mongoose.model("SpApprovalPolicy", approvalPolicySchema);
