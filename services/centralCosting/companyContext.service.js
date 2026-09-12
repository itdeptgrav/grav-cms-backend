// services/centralCosting/companyContext.service.js
//
// Central Costing — Chunk 1. WHOSE COSTING IS THIS, AND WHO IS ASKING.
//
// ── WHAT WAS FOUND BEFORE CHOOSING ──────────────────────────────────────────
// Four company-context mechanisms exist in this repository, and none of them
// is authoritative for a CMS employee outside Store:
//
//   1. `SpCompanyMembership` — {email|employeeRef → companyId}, server-owned,
//      deliberate. The only record that says whose books a CMS user works in.
//   2. `Acc_Organization.tallyCompanyIds` + `Acc_User.organizationId` — the
//      accountant module's own tenancy, reached through a DIFFERENT login
//      (`accountant_token`) and a different user collection. It cannot resolve
//      a CMS employee JWT at all.
//   3. The single-company deployment rule — a deployment FACT used by the MRF
//      fulfilment decision and by Store's tenant context.
//   4. Nothing at all for Sales, Manufacturing, Merchandising and R&D:
//      `Employee`, `DeptUser`, `DepartmentRole` and the JWT carry no company.
//
// ── WHAT WAS CHOSEN ─────────────────────────────────────────────────────────
// (1) and (3), through the shared, domain-neutral resolver at
// `services/companyContext/companyMembership.service.js` — the SAME code
// Store's tenant context now calls, so costing cannot resolve a company Store
// would have refused, or the reverse.
//
// This is an adapter, and it is named as one: the collection is Store-named
// because Store is the chunk that had to invent it. The consequence is stated
// rather than hidden — a Sales or Manufacturing user with no membership row
// and more than one company configured has NO proven company and is refused.
// That is the correct failure: guessing would be worse than a 403. See
// docs/decisions/central-costing-company-context-and-visibility.md §4.
//
// ── WHAT IS NEVER IDENTITY ──────────────────────────────────────────────────
// The request body. The query string. A header on its own. The style, enquiry
// or order the costing is about. Resolving company from the document being
// accessed answers "may I see this?" with "you are seeing it".
//
// A multi-company actor MAY name which of THEIR OWN memberships they are
// acting under, in `X-Costing-Company` or `?actingCompanyId=`. That selects
// among proven memberships and is validated against them; it is never
// authority by itself, and a single-membership actor's value is ignored.
"use strict";

const mongoose = require("mongoose");

const {
  MEMBERSHIP_SOURCES, resolveCompanyForActor,
} = require("../companyContext/companyMembership.service");
/* Required as a namespace, not destructured: the capability resolution is the
   one seam a focused test needs to stand in for (there is no department grant
   that yields cost-without-margin, and that separation must still be proved at
   the route). A destructured reference would bind at require time and could
   not be substituted. */
const capabilities = require("./capabilities");
const { CAPABILITIES } = capabilities;
/* ── SHARED REFUSAL SHAPE ──────────────────────────────────────────────────
 * `services/storePurchase/errors.js` is domain-neutral infrastructure that
 * happens to live under a domain folder: a machine `code`, an HTTP status and
 * a sentence a person can act on, in the envelope every current Store screen
 * already reads. Costing reuses it rather than inventing a second refusal
 * shape for clients to tell apart. Moving that file to a neutral path is a
 * mechanical rename for a later chunk; it is recorded in the decision record,
 * not left to be discovered. */
const { fail } = require("../storePurchase/errors");

const DOMAIN_LABEL = "Central Costing";

/**
 * Resolve the costing context for an authenticated actor.
 *
 * Fails closed on every unclear case: unauthenticated, no membership,
 * ambiguous membership with no valid selection. There is no "all companies"
 * and no first-company-found.
 *
 * @param {object} user  req.user as EmployeeAuthMiddlewear sets it
 * @returns {Promise<object>} the resolved context
 */
async function resolveForActor(user, { requestedCompanyId = null } = {}) {
  if (!user || !user.id) {
    throw fail("UNAUTHENTICATED", `Sign in to use ${DOMAIN_LABEL}.`);
  }

  const email = user.email ? String(user.email).toLowerCase().trim() : "";
  const employeeRef = mongoose.Types.ObjectId.isValid(user.id)
    ? new mongoose.Types.ObjectId(user.id)
    : null;

  const { companyId, membershipSource, membership } = await resolveCompanyForActor(user, {
    requestedCompanyId,
    domainLabel: DOMAIN_LABEL,
    fail,
  });

  /* Capabilities are resolved SEPARATELY from membership, and from costing's
     own mapping. Belonging to a company is not permission to see its cost. */
  const { capabilities: granted, via, isAdmin } = await capabilities.resolveCapabilities({
    email,
    employeeRef,
    biometricId: user.employeeId,
  });

  return {
    actorId: String(user.id),
    actorType: "employee",
    actorName: user.name || membership?.personName || "",
    actorEmail: email,
    companyId,
    capabilities: granted,
    capabilitySet: new Set(granted),
    via,
    isAdmin,
    membershipSource,
    /* Surfaced, not buried: a context resolved by the single-company
       deployment rule is a weaker statement than one backed by a membership
       record, and every response says which one it was. */
    membershipProven: membershipSource === MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD,
  };
}

/**
 * Explicit context for a background job or an import.
 *
 * Deliberately awkward to call — a company AND a reason — so there is no
 * ambient "system" context that silently becomes global. Chunk 2's legacy
 * import will need exactly this.
 */
function forService({ companyId, reason, capabilities = [] }) {
  if (!companyId) throw fail("VALIDATION", "A service costing context must name a company.");
  if (!reason) throw fail("VALIDATION", "A service costing context must state its reason.");
  return {
    actorId: "service",
    actorType: "service",
    actorName: reason,
    actorEmail: "",
    companyId,
    capabilities,
    capabilitySet: new Set(capabilities),
    via: ["service"],
    isAdmin: false,
    membershipSource: MEMBERSHIP_SOURCES.SERVICE,
    membershipProven: true,
  };
}

/**
 * The filter every costing read and write must include.
 *
 * There is no legacy mode: this domain's collections are new, so every
 * document has an owner and no read path has to cope with an unowned one.
 */
function companyFilter(ctx) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", `Sign in to use ${DOMAIN_LABEL}.`);
  return { companyId: ctx.companyId };
}

/** Fields every new costing document must carry, taken from context only. */
const stamp = (ctx) => ({ companyId: ctx.companyId });

/**
 * Refuse a company the client tried to supply in a payload.
 *
 * Not merely ignored: a body naming a DIFFERENT company is a client asking for
 * something it must never get, and answering with a silent substitution
 * teaches the client that the field works.
 */
function assertNoForeignCompany(ctx, body = {}) {
  const supplied = body?.companyId ?? body?.company;
  if (supplied === undefined || supplied === null || supplied === "") return;
  if (String(supplied) !== String(ctx.companyId)) {
    throw fail("TENANT_MISMATCH", "That record belongs to another company.", {});
  }
}

module.exports = {
  DOMAIN_LABEL, MEMBERSHIP_SOURCES, CAPABILITIES,
  resolveForActor, forService, companyFilter, stamp, assertNoForeignCompany,
};
