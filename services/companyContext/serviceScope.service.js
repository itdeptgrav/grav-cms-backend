// services/companyContext/serviceScope.service.js
//
// THE COMPANY FILTER FOR CODE THAT HAS NO `req`.
//
// ── WHY INTERNAL HELPERS NEED THEIR OWN VERSION OF THIS ─────────────────────
// A route can resolve the caller's company from their session. A service
// called from one cannot, and the tempting shortcut — look the record up
// globally, since "an internal helper is trusted" — is how a scoped route ends
// up returning another company's data through a helper it called.
//
// The trust in "trusted internal helper" belongs to the CALLER, not the
// helper. So these take an explicit `{companyId, reason}` context, and the
// caller must have obtained that company from an already-authorised parent
// operation — never from the record being fetched, which is the circularity
// the tenant rules refuse.
//
// ── AND A FAILURE IS NOT "NO DATA" ──────────────────────────────────────────
// Several of these helpers exist to enrich a response and swallow their errors
// so a missing extra never breaks a page. That is right for a genuinely absent
// record and wrong for a company-context outage: `null` would be read as "this
// enquiry has no images", when the truth is that nothing could be checked. A
// foreign record degrades to absent; an outage propagates.
"use strict";

const { fail } = require("../storePurchase/errors");

/** A context an internal caller must name a company and a reason in. */
function assertServiceContext(ctx, what = "Sales records") {
  if (!ctx?.companyId) {
    throw fail("TENANT_MEMBERSHIP_UNPROVEN", `${what} cannot be read without a company.`, {
      reason: "SERVICE_CONTEXT_REQUIRED",
    });
  }
  if (!ctx.reason) {
    throw fail("VALIDATION", `A service read of ${what} must state its reason.`, {
      reason: "SERVICE_REASON_REQUIRED",
    });
  }
  return ctx;
}

/* ── THE LEGACY ALLOWANCE IS A PROOF, NOT AN OPTION ─────────────────────────
 * The first version took `{ allowUnowned: true }` from the caller. That is not
 * proof of anything: it is a boolean somebody typed, one careless
 * `...req.body` away from being reachable from a request, and it unlocks
 * exactly the records that belong to nobody.
 *
 * The allowance is now established HERE, from the company master, and marked
 * on the context with a symbol. A symbol cannot be JSON, cannot arrive in a
 * request body, and cannot be spread in from an options object a caller
 * assembled — so the only way to hold it is to have asked for it and had the
 * deployment agree.
 */
const LEGACY_ALLOWED = Symbol("companyContext.legacyAllowed");

/**
 * A service context, with the legacy allowance settled by the company master.
 *
 * @param {object} args.companyId  from an already-authorised parent operation
 * @param {string} args.reason     why this read is happening
 * @param {boolean} [args.legacyAware]  ask for the allowance; it is granted
 *   only if the deployment actually justifies it
 * @throws 503 when the company master cannot be read — an outage is never
 *   quietly answered as "no allowance", because that is a different fact
 */
async function createServiceContext({ companyId, reason, legacyAware = false } = {}) {
  assertServiceContext({ companyId, reason });

  let allowed = false;
  if (legacyAware) {
    const Acc_Company = require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;
    let companies;
    try {
      companies = await Acc_Company.find({}).select("_id").limit(2).lean();
    } catch (err) {
      console.error("[serviceScope] company lookup failed:", err?.message || err);
      throw fail(
        "COMPANY_CONTEXT_UNAVAILABLE",
        "Company access could not be checked just now. Try again in a moment.",
        { stage: "service context legacy allowance" },
      );
    }
    allowed = companies.length === 1 && String(companies[0]._id) === String(companyId);
  }

  /* Frozen, so nothing downstream can flip the allowance after the fact. */
  return Object.freeze({ companyId, reason, [LEGACY_ALLOWED]: allowed });
}

/**
 * The company clause for a service context.
 *
 * The allowance is read off the context's symbol — never from an options
 * object, which is why there is no `allowUnowned` parameter any more.
 */
function serviceClause(ctx) {
  assertServiceContext(ctx);
  const allowUnowned = ctx[LEGACY_ALLOWED] === true;
  return {
    $or: [
      { companyId: ctx.companyId },
      ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
    ],
  };
}

/** A selector with the service context's company clause folded in. */
function serviceFilter(ctx, selector = {}) {
  const clause = serviceClause(ctx);
  return Object.keys(selector).length ? { $and: [clause, selector] } : clause;
}

/**
 * Is a thrown error a tenant/context refusal that must NOT be swallowed?
 *
 * Used by enrichment helpers that otherwise return null on failure: a foreign
 * or missing record is absent, but a 503 is an outage and has to reach the
 * caller as one.
 */
const isContextOutage = (err) => err?.code === "COMPANY_CONTEXT_UNAVAILABLE";

module.exports = {
  LEGACY_ALLOWED, createServiceContext, assertServiceContext,
  serviceClause, serviceFilter, isContextOutage,
};
