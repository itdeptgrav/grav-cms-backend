// services/companyContext/ownershipStamp.service.js
//
// WHOSE COMPANY OWNS A RECORD BEING CREATED — PROVEN, OR NOT CREATED.
//
// ── THE CONTRACT THIS FILE USED TO HAVE, AND WHY IT WAS WRONG ───────────────
// The first version never threw. When ownership could not be resolved it
// returned `companyId: null` and let the caller create the record anyway,
// reasoning that refusing would stop Sales working and that costing enforced
// the boundary on its own read path.
//
// That is failing open, and the reasoning does not survive contact with a
// second company. An unowned enquiry is a confidential commercial record —
// buyer, quantities, target prices, and from Chunk 3 supplier rates — sitting
// in a shared database belonging to nobody. Every consumer then has to
// remember to treat "no company" as "not mine", and the first one that writes
// `Enquiry.findOne({_id})` inherits it. "Costing checks its own reads" is a
// guarantee about one consumer, offered as though it were a guarantee about
// the record.
//
// So: ownership is PROVEN or the record is not created. There is no third
// answer, and no code path here returns one.
//
// ── AND THE REFUSAL SAYS WHICH REFUSAL IT IS ────────────────────────────────
// The earlier version also collapsed every resolver failure into
// `NO_MEMBERSHIP`, which turned a database outage into "ask an administrator
// for access" — unfixable advice for a problem that fixes itself. The
// resolver's own errors are preserved and surface with their own codes and
// statuses: 409 to choose a company, 403 when membership cannot be proved,
// 503 when the lookup itself failed.
"use strict";

/* Required as a NAMESPACE, not destructured: a destructured binding is fixed
   at require time and cannot be substituted, and "how many times did this
   request resolve a company?" is a property worth being able to assert. */
const membership = require("./companyMembership.service");
const { MEMBERSHIP_SOURCES } = membership;
const { fail } = require("../storePurchase/errors");

/**
 * The company a record this actor is creating must belong to.
 *
 * @param {object} user  `req.user` as an auth middleware sets it
 * @param {object} [opts]
 * @param {string} [opts.domainLabel]  the module name used in refusal prose
 * @returns {Promise<{companyId, source, proven}>}
 * @throws  the resolver's own refusal — never a substitute for one
 */
async function resolveOwnershipForActor(user, { domainLabel = "Sales" } = {}) {
  if (!user?.id) {
    throw fail("UNAUTHENTICATED", `Sign in to use ${domainLabel}.`);
  }

  /* No `requestedCompanyId`: ownership is not something a caller selects. An
     actor who belongs to several companies is REFUSED rather than assigned
     one — nothing here should guess which, and a body field naming one would
     be the client choosing its own tenant. */
  const { companyId, membershipSource } = await membership.resolveCompanyForActor(user, {
    requestedCompanyId: null,
    domainLabel,
    fail,
  });

  return {
    companyId,
    source: membershipSource,
    /* A membership record is a decision somebody made. The single-company
       deployment rule is a deployment fact — weaker, and recorded as such so a
       later reader (or the backfill) can tell them apart. */
    proven: membershipSource === MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD,
  };
}

/** The ownership fields a newly created record carries. */
async function ownershipFieldsFor(user, opts) {
  const { companyId, source, proven } = await resolveOwnershipForActor(user, opts);
  return {
    companyId,
    companyOwnership: { source, resolvedAt: new Date(), proven },
  };
}

/* ── THERE IS NO "BEST EFFORT" VARIANT, DELIBERATELY ────────────────────────
 * One existed, for SalesJourney, on the argument that an unowned journey is
 * only reachable in a sole-company deployment and so cannot be claimed. The
 * argument was true and beside the point: an ownerless record becomes
 * inaccessible the day a second company appears, is a candidate for an
 * incorrect backfill, and — for Sales source records — is exactly what Chunk 3
 * will hang confidential supplier quotations off.
 *
 * It is deleted rather than left unused. A general helper that makes ownerless
 * writes easy is a helper the next writer will reach for. */

module.exports = { resolveOwnershipForActor, ownershipFieldsFor };
