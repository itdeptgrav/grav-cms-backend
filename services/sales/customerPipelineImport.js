// services/sales/customerPipelineImport.js
//
// EVERY EXISTING CUSTOMER, ONTO THE PIPELINE  (8 Oct 2026, owner)
//
// "Whoever the existing customers are in the customer schema, they need to
// show in the pipeline." The pipeline is the Sales Journeys page (Account →
// Enquiry → Style & Sample → … → Retention). A Customer record is a portal
// account and sits nowhere on it; a Journey needs a CRM Account. So, for
// every active Customer:
//
//   1. the Account — the one already LINKED to the customer
//      (customerAccountLink.resolve: by id, or proved by an order); else the
//      one whose active CONTACT carries the customer's e-mail (the portal
//      login — a credential, not a name — the CRM's accounts were keyed in
//      from the same addresses); else a new one (customerAccountLink.ensure).
//      A name is never used to match — see that service's header.
//   2. the Journey — one per account; an account that already has a live
//      Journey (any outcome) is "already on the pipeline". A new one starts at
//      the Enquiry stage, business type `repeat` (they are a customer already),
//      owned by the customer's salesperson, else the person running this, and
//      names the Lead the first version of this import made, if one exists.
//
// Idempotent: run it twice and the second run creates nothing. `dryRun` lists
// what would happen and writes nothing. Nothing on the Customer is changed.
//
// The first version (earlier the same day) made LEADS instead — the Leads
// board, which the owner does not call the pipeline. `strayLeads` counts
// them and `retireImportedLeads` archives them.
//
// Two doors, one function: the Sales settings page's button
// (POST /api/cms/crm/leads/import-customers) and scripts/importCustomersToPipeline.js.
"use strict";

const mongoose = require("mongoose");
const Customer = require("../../models/Customer_Models/Customer");
const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const customerAccountLink = require("./customerAccountLink.service");
const { createWithRef } = require("../salesJourneyRef");

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const id = (v) => (v ? String(v) : "");
const within = (scope, extra = {}) => ({ ...(scope?.clause || {}), ...extra });
/* Internal test accounts (the CAD test organisation's "DO NOT USE FOR REAL
   ORDERS" customers carry this domain) are not customers and never go on the
   board; they are listed back as skipped so nobody wonders where they went. */
const TEST_EMAIL_DOMAINS = ["internal.gravtest.com"];
const isTestCustomer = (c) => TEST_EMAIL_DOMAINS.some((d) => str(c.email).toLowerCase().endsWith(`@${d}`));

/** The customer's Account: linked, proved, matched by contact e-mail, or made. */
async function accountFor({ scope, customer, actor, dryRun }) {
  const found = await customerAccountLink.resolve({ scope, customerId: customer._id });
  if (found.state === customerAccountLink.STATE.LINKED) return { ok: true, account: found.account, establishedBy: "LINKED" };
  if (found.state === customerAccountLink.STATE.REPAIRABLE) {
    const r = await customerAccountLink.ensure({ scope, customerId: customer._id, customer, actor, dryRun });
    return r.ok ? { ok: true, account: r.account || found.account, establishedBy: "REPAIRED" } : { ok: false, reason: r.message };
  }
  if (found.state !== customerAccountLink.STATE.ABSENT) return { ok: false, reason: found.reason || found.state };

  const email = str(customer.email).toLowerCase();
  if (email) {
    const contacts = await Contact.find(within(scope, { email, isActive: true, accountId: { $ne: null } })).select("accountId").lean();
    const accountIds = [...new Set(contacts.map((c) => id(c.accountId)).filter(Boolean))];
    if (accountIds.length > 1) {
      return { ok: false, reason: `Two commercial records' contacts carry ${email} — say which is this customer's on the Accounts page first.` };
    }
    if (accountIds.length === 1) {
      const account = await Account.findOne(within(scope, { _id: accountIds[0], isActive: true }))
        .select("_id accountId companyName displayName linkedCustomer").lean();
      if (account) {
        if (account.linkedCustomer && id(account.linkedCustomer) !== id(customer._id)) {
          return { ok: false, reason: `${account.companyName} (${account.accountId}) already belongs to another customer.` };
        }
        if (!dryRun && !account.linkedCustomer) {
          await Account.updateOne({ _id: account._id, linkedCustomer: { $in: [null, undefined] } }, { $set: { linkedCustomer: customer._id } });
        }
        return { ok: true, account, establishedBy: "EMAIL" };
      }
    }
  }

  const made = await customerAccountLink.ensure({ scope, customerId: customer._id, customer, actor, dryRun });
  if (!made.ok) return { ok: false, reason: made.message };
  return { ok: true, account: made.account || { _id: null, companyName: made.name, accountId: "" }, establishedBy: "CREATED" };
}

/**
 * @param {object} opts
 * @param {object} opts.scope       the Sales scope (companyId + clause) — salesScope.service
 * @param {object} opts.ownership   companyId + companyOwnership for the new Journeys
 * @param {object} [opts.actor]     { id, name } — who ran it
 * @param {object} [opts.fallbackOwner] { id, name } — the Journey owner when the customer has no salesperson
 * @param {boolean} [opts.dryRun]
 */
async function importCustomersIntoPipeline({ scope, ownership, actor = null, fallbackOwner = null, dryRun = false } = {}) {
  if (!scope?.companyId || !ownership?.companyId) throw new Error("A company must be resolved before customers can be placed on its pipeline.");
  const owner = fallbackOwner || actor;

  const customers = await Customer.find({ isActive: { $ne: false } })
    .select("customerId name email phone profile.companyName businessInfo.companyName salesAssignedBy salesAssignedByName createdAt")
    .sort({ createdAt: 1 })
    .lean();

  const result = { customers: customers.length, created: [], alreadyThere: [], skippedTest: [], failed: [], dryRun: Boolean(dryRun), strayLeads: 0 };
  result.strayLeads = await Lead.countDocuments({ importedFromCustomerId: { $ne: null }, isActive: true });

  for (const c of customers) {
    if (isTestCustomer(c)) { result.skippedTest.push({ customerId: c.customerId, name: c.name, email: c.email }); continue; }
    try {
      const acc = await accountFor({ scope, customer: c, actor, dryRun });
      if (!acc.ok) { result.failed.push({ customerId: c.customerId, name: c.name, reason: acc.reason }); continue; }
      const account = acc.account;
      const company = account.displayName || account.companyName || str(c.profile?.companyName) || str(c.name);

      if (account._id) {
        const existing = await SalesJourney.findOne(within(scope, { accountId: account._id, isActive: true }))
          .select("journeyId name currentStage outcome").sort({ createdAt: -1 }).lean();
        if (existing) {
          result.alreadyThere.push({ customerId: c.customerId, name: c.name, company, accountId: account.accountId, journeyId: existing.journeyId, stage: existing.currentStage, outcome: existing.outcome });
          continue;
        }
      }
      if (dryRun) {
        result.created.push({ customerId: c.customerId, name: c.name, company, accountId: account.accountId || "(new)", accountEstablishedBy: acc.establishedBy });
        continue;
      }

      const ownerId = c.salesAssignedBy || owner?.id;
      if (!ownerId) { result.failed.push({ customerId: c.customerId, name: c.name, reason: "No salesperson to own the journey (the customer has none assigned and nobody is signed in)." }); continue; }
      const ownerName = c.salesAssignedBy ? str(c.salesAssignedByName) : str(owner?.name);
      const lead = await Lead.findOne({ importedFromCustomerId: c._id, isActive: true }).select("_id leadId").lean();

      const journey = await createWithRef(SalesJourney, {
        ...ownership,
        name: company,
        accountId: account._id,
        businessType: "repeat",
        ownerId: new mongoose.Types.ObjectId(String(ownerId)),
        ownerName: ownerName || undefined,
        createdBy: actor ? { id: actor.id, name: actor.name } : undefined,
        updatedBy: actor ? { id: actor.id, name: actor.name } : undefined,
        ...(lead ? { leadId: lead._id, leadRef: lead.leadId || undefined } : {}),
        importedFromCustomerId: c._id,
        importedFromCustomerCode: str(c.customerId),
      });
      result.created.push({ customerId: c.customerId, name: c.name, company, accountId: account.accountId, accountEstablishedBy: acc.establishedBy, journeyId: journey.journeyId, journeyDbId: String(journey._id) });
    } catch (err) {
      result.failed.push({ customerId: c.customerId, name: c.name, reason: err?.message || String(err) });
    }
  }
  return result;
}

/** Archive the Leads the first version of this import made (they are not the pipeline). */
async function retireImportedLeads() {
  const r = await Lead.updateMany(
    { importedFromCustomerId: { $ne: null }, isActive: true },
    { $set: { isActive: false, captureStatus: "archived", qualificationReason: "Retired: made by the customer→pipeline import before it placed customers on Journeys (8 Oct 2026)." } },
  );
  return { retired: r.modifiedCount || 0 };
}

module.exports = { importCustomersIntoPipeline, retireImportedLeads, accountFor };
