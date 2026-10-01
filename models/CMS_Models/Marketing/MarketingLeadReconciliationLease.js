// models/CMS_Models/Marketing/MarketingLeadReconciliationLease.js
//
// ONE RECONCILIATION PER COMPANY AT A TIME.
//
// The scheduler, a second server instance and an administrator's manual run can
// all ask for the same company at once. None of them would duplicate an enquiry
// — deduplication sees to that — but they would double the calls to Google and
// race over the cursor. This row is the fence: taken atomically, released in a
// `finally`, and presumed dead after `leaseUntil` so a crashed run cannot hold
// the company for ever.
"use strict";

const mongoose = require("mongoose");

const leaseSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    leaseUntil: { type: Date, default: null },
    /* Which door started the run. Not a person, not an id. */
    startedBy: { type: String, enum: ["scheduler", "manual", ""], default: "" },
    startedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "marketing_lead_reconciliation_leases", strict: "throw" },
);

leaseSchema.index({ companyId: 1 }, { unique: true });

const MarketingLeadReconciliationLease = mongoose.models.MarketingLeadReconciliationLease
  || mongoose.model("MarketingLeadReconciliationLease", leaseSchema);

module.exports = { MarketingLeadReconciliationLease };
