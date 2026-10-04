// services/maintenance/maintenanceServiceTerms.js
//
// SERVICE MAINTENANCE uses the Store's own service form (owner, 3 Oct 2026:
// "exact same … all input filled logic all copy"). Its form fields, options and
// checks are the Store's Service master's — routes/CMS_Routes/Inventory/
// Services/services.js — applied to a Maintenance job:
//
//   service name, category, description or specification, billing unit,
//   estimated rate, lead time, preferred supplier, proposed budget head,
//   SAC code, default GST rate, recurring frequency and notice period
//
// plus "Done by" (in-house / outside vendor). The vendor-side terms are kept
// only when the work is done by an outside vendor.
//
// READ-ONLY toward the Store and Finance: suppliers and budget heads are READ
// to offer and to check; nothing here writes a supplier, a ledger or a service.
// The company is the books' primary company, as the Requests desk resolves it
// (services/requests/booksCompany.js) — Maintenance staff need no Store grant.
"use strict";

const mongoose = require("mongoose");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const { Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const tenantContext = require("../storePurchase/tenantContext.service");
const budgetClassification = require("../budgetClassification.service");
const itemBudgetHead = require("../itemBudgetHead.service");
const { theCompany } = require("../requests/booksCompany");

/* The Store's limits and suggestions, as its service master states them. */
const LIMITS = Object.freeze({ name: 200, category: 120, description: 5000, billingUnit: 60, sac: 20 });
const BILLING_UNIT_SUGGESTIONS = Object.freeze([
  "Per month", "Per visit", "Per trip", "Per licence", "Per hour", "Per job", "Lump sum",
]);
const DONE_BY = Object.freeze(["in-house", "outside"]);

const text = (v) => (typeof v === "string" ? v.trim() : "");

/** A number a caller may omit, but may not send nonsense for (the Store's rule). */
function optionalNumber(raw, { field, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isFinite(n)) return { ok: false, field, message: `${field} must be a number.` };
  if (n < min || n > max) return { ok: false, field, message: `${field} must be between ${min} and ${max}.` };
  return { ok: true, value: n };
}

/** The supplier, budget-head and billing-unit lists the Store's form offers. */
async function serviceOptions() {
  const { company, error } = await theCompany();
  if (!company) return { suppliers: [], budgetHeads: [], billingUnitSuggestions: BILLING_UNIT_SUGGESTIONS, recurringFrequencies: Service.RECURRING_FREQUENCIES, company: null, error };
  const ctx = { companyId: company._id };
  const [suppliers, ledgers] = await Promise.all([
    Vendor.find({ $and: [tenantContext.tenantFilter(ctx), tenantContext.ownedOnly()], status: "Active" })
      .select("_id companyName supplierCode").sort({ companyName: 1 }).lean(),
    Acc_Ledger.find({ companyId: company._id }).select("_id name groupName nature budgetControl").sort({ name: 1 }).lean(),
  ]);
  const budgetHeads = ledgers.filter((l) => budgetClassification.isExpenseBudget({
    budgetControl: l.budgetControl, name: l.name, groupName: l.groupName, nature: l.nature,
  }));
  return {
    suppliers: suppliers.map((s) => ({ id: String(s._id), name: s.companyName, code: s.supplierCode || "" })),
    budgetHeads: budgetHeads.map((l) => ({ id: String(l._id), name: l.name, group: l.groupName || "" })),
    billingUnitSuggestions: BILLING_UNIT_SUGGESTIONS,
    recurringFrequencies: Service.RECURRING_FREQUENCIES,
    company: { id: String(company._id), name: company.companyName || "" },
  };
}

/**
 * The Store service form's body, checked as the Store checks it.
 * `{ ok, errors, identity: {title, category, description}, doneBy, terms|null }`.
 * `terms` only when the work is by an outside vendor.
 */
async function checkServiceForm(raw = {}, { linkedName = "" } = {}) {
  const s = raw && typeof raw === "object" ? raw : {};
  const errors = [];
  const bounded = (field, value, max) => {
    if (value !== undefined && value !== null && typeof value !== "string") { errors.push({ field: `service.${field}`, message: `${field} must be text.` }); return ""; }
    const v = text(value);
    if (v.length > max) errors.push({ field: `service.${field}`, message: `${field} is longer than ${max} characters.` });
    return v;
  };
  /* `name` is the Store's word; `title` is this app's older one. */
  const title = bounded("name", s.name ?? s.title, LIMITS.name) || linkedName;
  if (!title) errors.push({ field: "service.name", message: "A service name is required." });
  const category = bounded("category", s.category, LIMITS.category);
  const description = bounded("description", s.description, LIMITS.description);
  const doneBy = text(s.doneBy) || "in-house";
  if (!DONE_BY.includes(doneBy)) errors.push({ field: "service.doneBy", message: "Say whether the work is in-house or by an outside vendor." });

  let terms = null;
  if (doneBy === "outside") {
    const billingUnit = bounded("billingUnit", s.billingUnit, LIMITS.billingUnit);
    const sacCode = bounded("sacCode", s.sacCode, LIMITS.sac);
    const gst = optionalNumber(s.defaultGstRate, { field: "defaultGstRate", min: 0, max: 100 });
    const rate = optionalNumber(s.defaultRate, { field: "defaultRate" });
    const lead = optionalNumber(s.leadTimeDays, { field: "leadTimeDays", max: 3650 });
    const notice = optionalNumber(s.recurring?.noticeDays, { field: "recurring.noticeDays", max: 3650 });
    for (const r of [gst, rate, lead, notice]) if (!r.ok) errors.push({ field: `service.${r.field}`, message: r.message });
    const frequency = text(s.recurring?.frequency) || "NONE";
    if (!Service.RECURRING_FREQUENCIES.includes(frequency)) errors.push({ field: "service.recurring.frequency", message: "That recurring term is not one this system records." });

    let vendor = null;
    let ledger = null;
    const vendorId = s.preferredVendorId;
    const ledgerId = s.budgetLedgerId;
    if ((vendorId || ledgerId) && !errors.length) {
      const { company } = await theCompany();
      if (vendorId) {
        if (!mongoose.Types.ObjectId.isValid(String(vendorId)) || !company) {
          errors.push({ field: "service.preferredVendorId", message: "That supplier reference is not valid." });
        } else {
          vendor = await Vendor.findOne({ $and: [tenantContext.tenantFilter({ companyId: company._id }), tenantContext.ownedOnly()], _id: vendorId })
            .select("_id companyName").lean();
          if (!vendor) errors.push({ field: "service.preferredVendorId", message: "That supplier was not found in this company." });
        }
      }
      if (ledgerId) {
        const check = company ? await itemBudgetHead.assertMappable(ledgerId, company._id, { subject: "a service" }) : { ok: false, message: "That head does not exist." };
        if (!check.ok) errors.push({ field: "service.budgetLedgerId", message: check.message });
        else ledger = check.ledger;
      }
    }
    terms = {
      billingUnit, sacCode,
      defaultGstRate: gst.value ?? null, defaultRate: rate.value ?? null, leadTimeDays: lead.value ?? null,
      preferredVendorId: vendor?._id || null, preferredVendorName: vendor?.companyName || "",
      budgetLedgerId: ledger?._id || null, budgetLedgerName: ledger?.name || "",
      recurring: { frequency, noticeDays: notice.value ?? null },
    };
  }
  return { ok: errors.length === 0, errors, identity: { title, category, description }, doneBy, terms };
}

/** The terms as a job shows them. Absent stays absent — never a made-up 0. */
function termsView(t) {
  if (!t) return null;
  return {
    billingUnit: t.billingUnit || "",
    defaultRate: Number.isFinite(t.defaultRate) ? t.defaultRate : null,
    leadTimeDays: Number.isFinite(t.leadTimeDays) ? t.leadTimeDays : null,
    preferredVendorId: t.preferredVendorId ? String(t.preferredVendorId) : null,
    preferredVendorName: t.preferredVendorName || "",
    budgetLedgerId: t.budgetLedgerId ? String(t.budgetLedgerId) : null,
    budgetLedgerName: t.budgetLedgerName || "",
    sacCode: t.sacCode || "",
    defaultGstRate: Number.isFinite(t.defaultGstRate) ? t.defaultGstRate : null,
    recurring: { frequency: t.recurring?.frequency || "NONE", noticeDays: Number.isFinite(t.recurring?.noticeDays) ? t.recurring.noticeDays : null },
  };
}

module.exports = { LIMITS, BILLING_UNIT_SUGGESTIONS, DONE_BY, serviceOptions, checkServiceForm, termsView };
