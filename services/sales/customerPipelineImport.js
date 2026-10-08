// services/sales/customerPipelineImport.js
//
// EVERY EXISTING CUSTOMER, ONTO THE PIPELINE  (8 Oct 2026, owner)
//
// "Whoever the existing customers are in the customer schema, they need to
// show in the pipeline." The pipeline is the Leads board; a Customer record
// is a portal account and sits nowhere on it. This walks every active
// Customer and makes a Lead for each one that has none yet, in the first
// column ("Interest Confirmed" — qualificationState `new`), sourced
// `existing_customer`, linked back to the Customer by `importedFromCustomerId`
// so running it twice creates nothing twice.
//
// "Already there" is decided by that link first, then by e-mail, then by
// phone — a Lead somebody typed by hand for the same company must not get a
// twin. Nothing on the Customer is changed, nothing is deleted, and a Lead
// that already exists is never edited.
//
// Two doors, one function: the Sales settings page's button
// (POST /api/cms/crm/leads/import-customers) and scripts/importCustomersToPipeline.js
// for a deploy. `dryRun` lists what WOULD be created and writes nothing.
"use strict";

const Customer = require("../../models/Customer_Models/Customer");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const { createWithRef } = require("../leadRef");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const digits = (v) => str(v).replace(/\D+/g, "");
/* Internal test accounts (the CAD test organisation's "DO NOT USE FOR REAL
   ORDERS" customers carry this domain) are not customers and never go on the
   board; they are listed back as skipped so nobody wonders where they went. */
const TEST_EMAIL_DOMAINS = ["internal.gravtest.com"];
const isTestCustomer = (c) => TEST_EMAIL_DOMAINS.some((d) => str(c.email).toLowerCase().endsWith(`@${d}`));

/** What a Customer becomes on the board. Exported for the test. */
function leadPayloadFor(customer, { ownership = {}, actor = null } = {}) {
  const profile = customer.profile || {};
  const address = profile.address || {};
  const company = str(profile.companyName) || str(customer.name);
  /* The Customer's `name` is the account name, often the company itself; when
     a company name is recorded separately the account name is the person. */
  const person = str(profile.companyName) && str(customer.name) !== str(profile.companyName) ? str(customer.name) : "";
  const contactName = person || company;
  const assignedTo = customer.salesAssignedBy || actor?.id || undefined;
  const assignedToName = customer.salesAssignedBy ? str(customer.salesAssignedByName) : str(actor?.name);
  return {
    ...ownership,
    company,
    firstName: person || undefined,
    prospectType: "company",
    email: str(customer.email).toLowerCase() || undefined,
    phone: str(customer.phone) || undefined,
    whatsapp: str(customer.alternatePhone) || undefined,
    city: str(address.city) || undefined,
    state: str(address.state) || undefined,
    country: str(address.country) || "India",
    source: "existing_customer",
    qualificationState: "new",
    stage: "new",
    captureStatus: "active",
    reviewStatus: "approved",
    priority: "medium",
    assignedTo,
    assignedToName: assignedToName || undefined,
    sourcedBy: actor?.id || undefined,
    sourcedByName: str(actor?.name) || undefined,
    contacts: contactName ? [{ name: contactName, email: str(customer.email).toLowerCase() || undefined, phone: str(customer.phone) || undefined, isPrimary: true, status: "active" }] : [],
    importedFromCustomerId: customer._id,
    importedFromCustomerCode: str(customer.customerId),
    isActive: true,
  };
}

/**
 * @param {object} opts
 * @param {object} opts.ownership  companyId + companyOwnership for the new Leads
 * @param {object} [opts.actor]    { id, name } — who ran it (owner, sourcer)
 * @param {boolean} [opts.dryRun]  list only, write nothing
 */
async function importCustomersIntoPipeline({ ownership, actor = null, dryRun = false } = {}) {
  if (!ownership?.companyId) throw new Error("A company must be resolved before customers can be placed on its pipeline.");

  const customers = await Customer.find({ isActive: { $ne: false } })
    .select("customerId name email phone alternatePhone profile.companyName profile.address salesAssignedBy salesAssignedByName createdAt")
    .sort({ createdAt: 1 })
    .lean();

  const ids = customers.map((c) => c._id);
  const emails = [...new Set(customers.map((c) => str(c.email).toLowerCase()).filter(Boolean))];
  const phones = [...new Set(customers.map((c) => digits(c.phone)).filter((p) => p.length >= 8))];
  const existing = await Lead.find({
    isActive: true,
    $or: [
      { importedFromCustomerId: { $in: ids } },
      { convertedCustomerId: { $in: ids } },
      ...(emails.length ? [{ email: { $in: emails } }] : []),
      ...(phones.length ? [{ phone: { $exists: true, $ne: "" } }] : []),
    ],
  }).select("leadRef importedFromCustomerId convertedCustomerId email phone company").lean();

  const byCustomer = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  for (const l of existing) {
    if (l.importedFromCustomerId) byCustomer.set(String(l.importedFromCustomerId), l);
    if (l.convertedCustomerId) byCustomer.set(String(l.convertedCustomerId), l);
    if (l.email) byEmail.set(str(l.email).toLowerCase(), l);
    const p = digits(l.phone);
    if (p.length >= 8) byPhone.set(p, l);
  }

  const result = { customers: customers.length, created: [], alreadyThere: [], skippedTest: [], failed: [], dryRun: Boolean(dryRun) };
  for (const c of customers) {
    if (isTestCustomer(c)) { result.skippedTest.push({ customerId: c.customerId, name: c.name, email: c.email }); continue; }
    const hit = byCustomer.get(String(c._id)) || byEmail.get(str(c.email).toLowerCase()) || (digits(c.phone).length >= 8 ? byPhone.get(digits(c.phone)) : null);
    if (hit) { result.alreadyThere.push({ customerId: c.customerId, name: c.name, leadRef: hit.leadRef || "", company: hit.company || "" }); continue; }
    const payload = leadPayloadFor(c, { ownership, actor });
    if (dryRun) { result.created.push({ customerId: c.customerId, name: c.name, company: payload.company, email: payload.email || "" }); continue; }
    try {
      const lead = await createWithRef(Lead, payload);
      result.created.push({ customerId: c.customerId, name: c.name, company: lead.company, leadRef: lead.leadRef || "", leadId: String(lead._id) });
      /* a second customer with the same e-mail or phone in this run joins the one just made */
      if (payload.email) byEmail.set(payload.email, lead);
      if (digits(payload.phone).length >= 8) byPhone.set(digits(payload.phone), lead);
    } catch (err) {
      result.failed.push({ customerId: c.customerId, name: c.name, reason: err?.message || String(err) });
    }
  }
  return result;
}

module.exports = { importCustomersIntoPipeline, leadPayloadFor };
