// models/CMS_Models/Inventory/Services/Service.js
//
// THE SERVICE MASTER.
//
// ── WHY THIS IS NOT AN ITEM ─────────────────────────────────────────────────
// A repair, an AMC, a month of transport or a software subscription is bought,
// classified and budgeted exactly like a material — and is nothing like one
// once it arrives. It has no quantity on a shelf, no warehouse, no variant, no
// reorder level, no barcode and no goods receipt. Putting services into
// `RawItem` to reuse the purchasing screens would give every service a stock
// balance that can only ever be wrong, and the wrongness would spread into
// stock valuation and reorder reports.
//
// So this is a separate, deliberately small master. It answers what we buy,
// how a supplier describes it, how it is billed, how it is taxed, which head
// normally pays for it, and who normally supplies it. Nothing else.
//
// ── WHAT THE DEFAULTS ARE, AND ARE NOT ──────────────────────────────────────
// `defaultRate` is an estimate for planning, NOT an approved cost and not an
// invoice price. `budgetLedgerId` is a starting classification, NOT a budget
// approval or a commitment. `preferredVendorId` is a default, NOT a forced
// supplier. `recurring` records the terms a contract is usually on; it creates
// nothing on its own. Every one of those distinctions is stated on the form
// too, because a field called "default rate" is otherwise read as the price.

const mongoose = require("mongoose");

const RECURRING_FREQUENCIES = ["NONE", "MONTHLY", "QUARTERLY", "HALF_YEARLY", "YEARLY"];
const STATUSES = ["ACTIVE", "INACTIVE"];

const serviceSchema = new mongoose.Schema(
  {
    /* Ownership, from the resolved session context only — never the body. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Server-generated and quoted on paperwork, so it is never taken from a
       caller and never changes once orders refer to it. */
    serviceCode: { type: String, required: true, trim: true, uppercase: true },

    name: { type: String, required: true, trim: true, maxlength: 200 },
    /* Compared case-insensitively inside one company; two companies may each
       have their own "Annual Maintenance". */
    nameNormalised: { type: String, default: "" },

    /* Practical text for now. A Category Master is a later decision, and
       inventing an enum here would fix a vocabulary nobody has agreed. */
    category: { type: String, trim: true, default: "", maxlength: 120 },
    description: { type: String, trim: true, default: "", maxlength: 5000 },

    /* How the supplier bills it — per month, per visit, per trip, per licence.
       Text, not a UOM reference: service billing units are not the stock units
       in the Unit Master and forcing them together would corrupt both. */
    billingUnit: { type: String, trim: true, default: "", maxlength: 60 },

    /* Tax treatment that normally applies. SAC is the services counterpart of
       HSN; optional, because it is often not known when the service is first
       registered. */
    sacCode: { type: String, trim: true, default: "", maxlength: 20 },
    defaultGstRate: { type: Number, default: null, min: 0, max: 100 },

    /* Planning guidance. NOT a price, NOT an approved cost. */
    defaultRate: { type: Number, default: null, min: 0 },

    preferredVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    /* A snapshot, so a register row reads correctly without resolving a
       supplier that may since have been renamed or archived. */
    preferredVendorName: { type: String, trim: true, default: "" },

    budgetLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger", default: null },
    budgetLedgerName: { type: String, trim: true, default: "" },
    /* ── WHO CLASSIFIED THIS, AND WHEN ────────────────────────────────────
       The budget default is set from the Store's own service form AND from
       Finance's budget-defaults screen, which are different desks answering
       to different people. Without a stamp, "why does this AMC point at
       Repairs?" has no answer a year later, and the Service Master's general
       `updatedBy` cannot supply one — it moves whenever anybody edits the
       billing unit. Mirrors `RawItem.budgetLedgerSetBy` deliberately: two
       shapes for one fact is how a report ends up unable to join them. */
    budgetLedgerSetBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    budgetLedgerSetByName: { type: String, trim: true, default: "" },
    budgetLedgerSetAt: { type: Date, default: null },

    leadTimeDays: { type: Number, default: null, min: 0 },

    /* The terms a contract is usually on. Recording them creates nothing:
       no order, no renewal, no reminder. */
    recurring: {
      frequency: { type: String, enum: RECURRING_FREQUENCIES, default: "NONE" },
      noticeDays: { type: Number, default: null, min: 0 },
    },

    /* Inactivation replaces deletion: a service named on last year's requests
       must stay readable for ever. */
    status: { type: String, enum: STATUSES, default: "ACTIVE" },
    statusChangedAt: { type: Date, default: null },
    statusChangedByName: { type: String, trim: true, default: "" },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByName: { type: String, trim: true, default: "" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/* Derived here so the uniqueness rule cannot be sidestepped by casing or by a
   route that forgets to normalise. */
serviceSchema.pre("save", function (next) {
  this.nameNormalised = String(this.name || "").trim().replace(/\s+/g, " ").toLowerCase();
  next();
});

/* ── COMPANY-SCOPED IDENTITY ────────────────────────────────────────────────
 * Both unique within a company and free across companies, matching the rule
 * the Item and Supplier masters already follow. */
serviceSchema.index(
  { companyId: 1, serviceCode: 1 },
  { unique: true, name: "companyId_1_serviceCode_1" },
);
serviceSchema.index(
  { companyId: 1, nameNormalised: 1 },
  { unique: true, name: "companyId_1_nameNormalised_1", partialFilterExpression: { nameNormalised: { $gt: "" } } },
);
serviceSchema.index({ companyId: 1, status: 1, name: 1 });

module.exports = mongoose.models.Service || mongoose.model("Service", serviceSchema);
module.exports.RECURRING_FREQUENCIES = RECURRING_FREQUENCIES;
module.exports.STATUSES = STATUSES;
