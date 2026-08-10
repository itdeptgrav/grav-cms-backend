// services/accountReadiness.js
//
// The ONE definition of "is this Account complete enough to raise an
// Enquiry/RFQ against?" — the gate the Sales Journey's Account → Enquiry
// advance must clear. Until this existed the rule lived ONLY in the frontend
// (components/sales/crm/journey/stages/AccountStage.js's `missing[]` and a
// disabled button), so a direct call to POST /:journeyId/stage could advance a
// hollow Account straight into Enquiry. This makes the prerequisite real and
// server-enforced, the same discipline services/leadReadiness.js already uses
// for the Lead qualification gate.
//
// Pure and DB-free ON PURPOSE: it is handed the already-loaded account bundle
// pieces (account doc + the contacts/sites/addresses/team arrays the account
// GET already assembles) and returns the verdict. The caller does the loading;
// this decides. That keeps it unit-testable without a database and lets the
// frontend mirror the exact same five checks (see lib/accountReadiness.js).
//
// THE FIVE CHECKS (mirror lib/accountReadiness.js on the frontend one-for-one —
// both files move together):
//   • a primary/any contact          — who do we talk to?
//   • at least one business role      — customer / buying house / brand…
//   • a billing or delivery location  — a Site OR an Address; needed to quote
//   • an internal owner               — someone accountable
//   • a garment profile business model — drives costing assumptions
"use strict";

/**
 * @param {object} bundle
 * @param {object}   bundle.account     the CRMAccount document/object
 * @param {Array}   [bundle.contacts]   active contacts on the account
 * @param {Array}   [bundle.sites]      active sites
 * @param {Array}   [bundle.addresses]  active addresses
 * @returns {{checks: Array<{key:string,label:string,met:boolean}>, missing: Array<{key:string,label:string}>, ready: boolean}}
 */
function computeAccountEnquiryReadiness({ account, contacts = [], sites = [], addresses = [] } = {}) {
  const a = account || {};
  const checks = [
    { key: "contact", label: "Primary contact", met: contacts.length > 0 },
    { key: "roles", label: "Business role", met: (a.roles || []).length > 0 },
    { key: "location", label: "Billing or delivery location", met: sites.length > 0 || addresses.length > 0 },
    { key: "owner", label: "Internal owner", met: Boolean(String(a.assignedToName || "").trim()) },
    {
      key: "profile",
      label: "Garment profile",
      met: (a.garmentSalesProfile?.businessModels || []).length > 0,
    },
  ];
  const missing = checks.filter((c) => !c.met).map(({ key, label }) => ({ key, label }));
  return { checks, missing, ready: missing.length === 0 };
}

module.exports = { computeAccountEnquiryReadiness };
