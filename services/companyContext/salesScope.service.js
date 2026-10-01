// services/companyContext/salesScope.service.js
//
// THE COMPANY FILTER EVERY AUTHENTICATED SALES QUERY MUST CARRY.
//
// ── WHY A SHARED HELPER AND NOT A RULE IN A COMMENT ─────────────────────────
// `routes/CMS_Routes/Sales/enquiries.js` selects an Enquiry in thirty-five
// places. A convention that each of them must remember to add `companyId` is a
// convention that holds until the thirty-sixth is written, and the one that
// forgets is indistinguishable from the ones that did not — it works, it
// returns data, and nothing fails until the data belongs to somebody else.
//
// So the filter is built here, the scoped finders below are the only way the
// router reaches an Enquiry, and a future route that writes
// `Enquiry.findOne({_id})` is visibly doing something the rest of the file
// does not.
//
// ── THE LEGACY ALLOWANCE, AND ITS PRICE ─────────────────────────────────────
// Records created before Sales had a company are unowned. Refusing them
// outright breaks every existing deployment; accepting them anywhere lets one
// company read another's. They are therefore usable exactly where ownership
// cannot be ambiguous — when the company master holds ONE company, and it is
// this actor's — and that question is asked of the company master, never of
// the record being requested.
//
// The allowance is computed once per request and memoised on `req`: it is a
// property of the deployment, not of the row, so asking per row would be both
// wasteful and an invitation to ask it about the row instead.
"use strict";

/* Required as a NAMESPACE, not destructured — see ownershipStamp.service.js
   for why: one request must resolve its company once, and that is only
   testable if the call can be observed. */
const membership = require("./companyMembership.service");
const { fail } = require("../storePurchase/errors");

const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

/** The one non-disclosing answer. Foreign, missing and unowned share it. */
const notFound = (what = "record") =>
  fail("NOT_FOUND", `That ${what} was not found.`);

/**
 * Is this a sole-company deployment, and is it the actor's company?
 *
 * Asked of the COMPANY MASTER. A failure is an outage, not a licence: it can
 * never be the thing that lets an unowned record through.
 */
async function soleCompanyDeployment(companyId) {
  const Acc_Company = companyModel();
  let companies;
  try {
    companies = await Acc_Company.find({}).select("_id").limit(2).lean();
  } catch (err) {
    console.error("[salesScope] company lookup failed:", err?.message || err);
    throw fail(
      "COMPANY_CONTEXT_UNAVAILABLE",
      "Your company access could not be checked just now. Try again in a moment.",
      { stage: "sales scope company lookup" },
    );
  }
  return companies.length === 1 && String(companies[0]._id) === String(companyId);
}

/**
 * The actor's company and the clause every query of theirs must carry.
 *
 * Memoised per request — the same request must not resolve two different
 * companies, and a second lookup is a second chance to disagree.
 *
 * @throws 401/403/409/503 exactly as the shared resolver raises them
 */
async function scopeFor(req, { domainLabel = "Sales" } = {}) {
  if (req.__salesScope) return req.__salesScope;

  if (!req.user?.id) throw fail("UNAUTHENTICATED", `Sign in to use ${domainLabel}.`);

  const { companyId, membershipSource } = await membership.resolveCompanyForActor(req.user, {
    /* Ownership is never selected by the caller. An actor in several companies
       is asked to choose through the established company-selection refusal —
       not handed one. */
    requestedCompanyId: null,
    domainLabel,
    fail,
  });

  const allowUnowned = await soleCompanyDeployment(companyId);

  const scope = {
    companyId,
    membershipSource,
    allowUnowned,
    /* Owned by me, plus — only where it is provably unambiguous — unowned. */
    clause: {
      $or: [
        { companyId },
        ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
      ],
    },
  };
  req.__salesScope = scope;
  return scope;
}

/**
 * A selector with the company clause folded in.
 *
 * `$and`, so a caller's own `$or` (a search, a status filter) cannot displace
 * the tenant clause — the failure mode of merging two `$or`s into one object.
 */
async function scopedFilter(req, selector = {}, opts) {
  const { clause } = await scopeFor(req, opts);
  return Object.keys(selector).length ? { $and: [clause, selector] } : clause;
}

/** Build the scoped finders for one model. */
function scopedFinders(Model, label) {
  return {
    /** One record, or the same answer a missing one gets. */
    async findOne(req, selector, { lean = false, select = null, orFail = false } = {}) {
      const filter = await scopedFilter(req, selector);
      let q = Model.findOne(filter);
      if (select) q = q.select(select);
      if (lean) q = q.lean();
      const doc = await q;
      if (!doc && orFail) throw notFound(label);
      return doc;
    },
    /** One record or a refusal — for the many routes that 404 on absence. */
    async findOneOrFail(req, selector, opts = {}) {
      return this.findOne(req, selector, { ...opts, orFail: true });
    },
    async find(req, selector, { lean = true, select = null, sort = null, limit = null } = {}) {
      const filter = await scopedFilter(req, selector);
      let q = Model.find(filter);
      if (select) q = q.select(select);
      if (sort) q = q.sort(sort);
      if (limit) q = q.limit(limit);
      if (lean) q = q.lean();
      return q;
    },
    async countDocuments(req, selector = {}) {
      return Model.countDocuments(await scopedFilter(req, selector));
    },
  };
}

/**
 * The ownership fields to stamp, derived from a scope already resolved.
 *
 * ── WHY THIS EXISTS RATHER THAN A SECOND RESOLUTION ─────────────────────────
 * Journey creation used to call `scopeFor(req)` for its source lookups and
 * then `ownershipFieldsFor(req.user)` for the stamp. Two independent
 * resolutions in one request are two chances to disagree: a membership row
 * changed, added or removed between them, and the record is created owned by a
 * company different from the one whose sources were checked. It is a small
 * window and the failure is silent, which is the worst combination.
 *
 * One request, one decision. This derives the stamp from that decision and
 * queries nothing.
 */
function ownershipFieldsFromScope(scope) {
  if (!scope?.companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", "Ownership cannot be stamped without a resolved company.");
  }
  return {
    companyId: scope.companyId,
    companyOwnership: {
      source: scope.membershipSource,
      resolvedAt: new Date(),
      proven: scope.membershipSource === "MEMBERSHIP_RECORD",
    },
  };
}

/** Resolve the scope and the stamp together — the ordinary case for a create. */
async function scopeAndOwnership(req, opts) {
  const scope = await scopeFor(req, opts);
  return { scope, ownership: ownershipFieldsFromScope(scope) };
}

module.exports = {
  notFound, soleCompanyDeployment, scopeFor, scopedFilter, scopedFinders,
  ownershipFieldsFromScope, scopeAndOwnership,
};
