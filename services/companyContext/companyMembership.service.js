// services/companyContext/companyMembership.service.js
//
// WHICH COMPANY AN AUTHENTICATED PERSON IS ACTING FOR — ONE ANSWER, FOR EVERY
// DOMAIN THAT ASKS.
//
// ── WHY THIS FILE EXISTS AT A NEUTRAL PATH ──────────────────────────────────
// Store & Purchase Chunk 1 established the only server-owned CMS record that
// says whose books a person works in (`SpCompanyMembership`). Central Costing
// needs exactly the same answer, and a second implementation of "which company
// is this person in" is a second answer waiting to disagree with the first —
// which is how one domain ends up scoping a read to a company another domain
// would have refused.
//
// So the resolution itself moved here, domain-neutral, and BOTH callers use
// it: `services/storePurchase/tenantContext.service.js` and
// `services/centralCosting/companyContext.service.js`. Nothing about the
// Store's behaviour changed — its wording, its error codes and its
// single-company deployment rule are passed in and returned unchanged.
//
// ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
// Capabilities. Two domains grant different things from the same identity, and
// folding permission into membership is what makes "you are in company X"
// quietly mean "and you may do X's work". Each domain resolves its own.
//
// ── THE COLLECTION IS STORE-NAMED, AND THAT IS RECORDED, NOT HIDDEN ─────────
// `SpCompanyMembership` lives under StorePurchase because that is the chunk
// that had to invent it. It is read here as the CMS company-membership record
// of record, and the consequence is stated rather than glossed: a person with
// no membership row has no proven company, and every domain that uses this
// fails closed for them. See
// docs/decisions/central-costing-company-context-and-visibility.md.
"use strict";

const mongoose = require("mongoose");

const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const MEMBERSHIP_SOURCES = Object.freeze({
  MEMBERSHIP_RECORD: "MEMBERSHIP_RECORD",
  SINGLE_COMPANY_DEPLOYMENT: "SINGLE_COMPANY_DEPLOYMENT",
  SERVICE: "SERVICE",
});

/** Loaded lazily: the accountant master models are a large module and no
 *  caller should pay for it at require time. */
const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

/**
 * Resolve the company an authenticated actor is acting for.
 *
 * @param {object} user           `{ id, email }` as an auth middleware sets it
 * @param {object} opts
 * @param {string|null} opts.requestedCompanyId  SELECTS among memberships the
 *   actor already holds. It is validated against them and is never authority
 *   on its own; a single-membership actor's value is ignored entirely.
 * @param {string} opts.domainLabel  the module name used in refusal prose
 * @param {function} opts.fail       `(codeKey, message, details) => Error` —
 *   the calling domain's own error factory, so codes and shapes stay that
 *   domain's own.
 * @returns {Promise<{companyId, permittedSiteIds: string[], membershipSource, membership}>}
 */
async function resolveCompanyForActor(user, { requestedCompanyId = null, domainLabel, fail } = {}) {
  if (!user || !user.id) {
    throw fail("UNAUTHENTICATED", `Sign in to use ${domainLabel}.`);
  }

  const email = user.email ? String(user.email).toLowerCase().trim() : "";
  const employeeRef = mongoose.Types.ObjectId.isValid(user.id)
    ? new mongoose.Types.ObjectId(user.id)
    : null;

  /* ── 1. An explicit membership record decides ───────────────────────────
   *
   * ── WHY THIS IS NOT A `findOne` ────────────────────────────────────────
   * The model permits an actor to hold memberships in several companies, and
   * taking whichever one the database returned first is not a tenant
   * boundary: the same person, on two identical requests, could resolve into
   * two different companies and nothing about the request would say which.
   * Selection has to be deterministic and it has to be the caller's stated,
   * validated choice. */
  const or = [];
  if (email) or.push({ email });
  if (employeeRef) or.push({ employeeRef });

  let memberships = [];
  if (or.length) {
    memberships = await SpCompanyMembership.find({ isActive: true, $or: or })
      .select("companyId siteIds personName email employeeRef")
      .sort({ companyId: 1 }) // stable order, so any diagnostic reads the same twice
      .lean()
      .catch(() => []);
  }

  /* Two rows naming the SAME company (one matched by email, one by
     employeeRef) are one membership found twice, not a choice. */
  const byCompany = new Map();
  for (const m of memberships) byCompany.set(String(m.companyId), m);
  const distinct = [...byCompany.values()];

  if (distinct.length === 1) {
    const membership = distinct[0];
    return {
      companyId: membership.companyId,
      permittedSiteIds: (membership.siteIds || []).map(String),
      membershipSource: MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD,
      membership,
    };
  }

  if (distinct.length > 1) {
    /* Multi-company: the caller must choose, and the choice must be one of
       theirs. A requested company identifies WHICH authorised membership to
       use; it is never authority by itself. */
    const wanted = requestedCompanyId ? String(requestedCompanyId) : null;
    if (!wanted) {
      throw fail(
        "COMPANY_SELECTION_REQUIRED",
        "You belong to more than one company. Choose which one you are working in.",
        { companies: distinct.map((m) => String(m.companyId)) },
      );
    }
    const membership = byCompany.get(wanted) || null;
    if (!membership) {
      /* Non-disclosing: naming a company they do not belong to is answered
         the same way as naming one that does not exist. */
      throw fail(
        "TENANT_MEMBERSHIP_UNPROVEN",
        `You do not have access to that company in ${domainLabel}.`,
        {},
      );
    }
    return {
      companyId: membership.companyId,
      permittedSiteIds: (membership.siteIds || []).map(String),
      membershipSource: MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD,
      membership,
    };
  }

  /* ── 2. Single-company deployment ──────────────────────────────────────
   * A DEPLOYMENT FACT, not an inference from this request: it reads neither
   * the body, the query, nor the document being accessed. It is what keeps
   * the live single-company system working while memberships are populated.
   * The moment a second company exists, or anybody is given an explicit
   * membership, it stops applying — for everybody, at once. */
  const Acc_Company = companyModel();
  const anyMembershipExists = await SpCompanyMembership.exists({ isActive: true }).catch(() => null);
  const companies = await Acc_Company.find({}).select("_id").limit(2).lean().catch(() => []);

  if (!anyMembershipExists && companies.length === 1) {
    return {
      companyId: companies[0]._id,
      permittedSiteIds: [],
      membershipSource: MEMBERSHIP_SOURCES.SINGLE_COMPANY_DEPLOYMENT,
      membership: null,
    };
  }

  /* ── 3. Fail closed ───────────────────────────────────────────────────── */
  throw fail(
    "TENANT_MEMBERSHIP_UNPROVEN",
    companies.length === 0
      ? `No company is set up in the books yet. Ask finance to create one before using ${domainLabel}.`
      : `Your account is not linked to a company in ${domainLabel}. Ask an administrator to grant you access.`,
    { companiesConfigured: companies.length, hasMembershipRecords: Boolean(anyMembershipExists) },
  );
}

module.exports = { MEMBERSHIP_SOURCES, resolveCompanyForActor };
