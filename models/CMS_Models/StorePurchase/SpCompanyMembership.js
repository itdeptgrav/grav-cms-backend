// models/CMS_Models/StorePurchase/SpCompanyMembership.js
//
// Store & Purchase — Chunk 1. WHICH COMPANY A PERSON BELONGS TO.
//
// ── WHY THIS HAD TO EXIST ───────────────────────────────────────────────────
// Nothing in the CMS identity chain carries a company. Employee, DeptUser,
// DepartmentRole and the JWT all describe WHO somebody is and WHAT they may
// do, and none of them says WHOSE BOOKS they work in. Chunk 0 measured the
// consequence: not one Store/Purchase collection is company-scoped, and the
// one flow that needs a company (the MRF fulfilment decision) resolves it by
// refusing to act unless exactly one company exists.
//
// A tenant boundary cannot be built on an inference from the document being
// read — that is circular, and it is exactly how cross-company reads happen.
// So membership becomes a record somebody sets deliberately.
//
// ── MATCHED BY EMAIL *OR* EMPLOYEE REFERENCE, FOR THE REASON DepartmentRole
//    ALREADY GIVES ─────────────────────────────────────────────────────────
// A person can be an Employee, a DeptUser or an accounting-only account, and
// which one they sign in as is decided at sign-in. Email is the one thing all
// three share. `employeeRef` is kept alongside it because an email can change
// while the payroll record does not, and a membership that survives neither
// is worse than one that survives either.
"use strict";

const mongoose = require("mongoose");

const membershipSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    /* At least one of these must identify the person — enforced in the
       pre-validate hook below rather than by making either required, because
       which one an administrator has to hand differs. */
    email: { type: String, trim: true, lowercase: true, index: true },
    employeeRef: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", index: true },

    /* Display snapshot. Never the authority — the refs above are. Held so a
       membership list reads without a join per row. */
    personName: { type: String, trim: true, default: "" },

    /* Sites this person may act at within this company. EMPTY means "no site
       restriction", which is the correct answer today: Store/Purchase has no
       site model, so every current document type is site-optional. It does
       NOT mean "every site" — when sites arrive, an empty list stays
       unrestricted only for site-optional documents. */
    siteIds: [{ type: mongoose.Schema.Types.ObjectId }],

    isActive: { type: Boolean, default: true, index: true },

    /* Who granted this, and when. A membership is an access decision. */
    grantedBy: { type: mongoose.Schema.Types.ObjectId },
    grantedByName: { type: String, trim: true, default: "" },
    grantedAt: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "sp_company_memberships" },
);

/* One membership per person per company. Sparse on each identifier so a row
   carrying only an email does not collide with every other email-less row. */
membershipSchema.index({ companyId: 1, email: 1 }, { unique: true, sparse: true });
membershipSchema.index({ companyId: 1, employeeRef: 1 }, { unique: true, sparse: true });

membershipSchema.pre("validate", function (next) {
  if (!this.email && !this.employeeRef) {
    return next(new Error("A membership must identify the person by email or employeeRef."));
  }
  next();
});

module.exports =
  mongoose.models.SpCompanyMembership ||
  mongoose.model("SpCompanyMembership", membershipSchema);
