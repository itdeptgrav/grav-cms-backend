// services/requests/booksCompany.js
//
// THE BOOKS A REQUEST BELONGS TO — resolved, never refused on count.
//
// 1 Oct 2026 (owner's request: no company / budget / accounting gate anywhere
// on the Store side). Both Requests routers used to scan `acc_companies` and
// refuse when more than one row existed ("More than one set of books exists,
// and a request cannot tell which it belongs to. Ask finance to configure
// this."). The IE demo seed of 21 Sep 2026 added two demo companies beside
// GRAV Clothing, so from that day every request, service verification and
// budget-head read on the desk was refused — while every other Store write
// resolved the company through the GRAV Clothing primary profile and worked.
//
// This answers the way the Store does:
//   1. the canonical company (`Acc_Company.isPrimary`, canonicalCompany.service)
//   2. else the only company
//   3. else the oldest company (stable: _id order), so two identical requests
//      can never file against two different books
//   4. no company at all → `{ company: null, error }` — nothing can be filed
//      into books that do not exist. That is the one remaining refusal.
"use strict";

const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

const NO_COMPANY_MESSAGE = "No company is set up in the books yet. Ask finance to create one.";

/** @returns {Promise<{ company: {_id, companyName}|null, error: string|null }>} */
async function theCompany() {
  const { getCanonicalCompany } = require("../companyContext/canonicalCompany.service");
  try {
    const canonical = await getCanonicalCompany();
    if (canonical) return { company: canonical, error: null };
  } catch (e) {
    /* Two primaries is a configuration fault; fall through to the oldest
       company rather than refuse the whole desk over it. */
    if (e?.code !== "CANONICAL_COMPANY_AMBIGUOUS") throw e;
  }
  const companies = await companyModel()
    .find({})
    .select("_id companyName")
    .sort({ isPrimary: -1, _id: 1 })
    .limit(1)
    .lean();
  if (companies.length) return { company: companies[0], error: null };
  return { company: null, error: NO_COMPANY_MESSAGE };
}

module.exports = { theCompany, NO_COMPANY_MESSAGE };
