// services/storePurchase/tenantContext.service.js
//
// Store & Purchase — Chunk 1. WHOSE BOOKS IS THIS, AND WHO IS ASKING.
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
// Chunk 0 measured it precisely: not one Store/Purchase collection carries a
// companyId, and every inventory router returns every document to every
// authenticated caller. A tenant boundary needs an answer to "which company
// does this person belong to" — and nothing in the CMS identity chain has one.
// Employee, DeptUser, DepartmentRole and the JWT all describe who somebody is
// and what they may do; none says whose books they work in.
//
// ── WHY MEMBERSHIP IS NEVER INFERRED FROM THE REQUEST ───────────────────────
// The tempting shortcut is to read the company off the document being
// accessed, or off the body. Both are circular: they answer "may I see this?"
// with "you are seeing it". Membership here comes only from server-owned
// records, in a fixed order, and fails closed.
"use strict";

const mongoose = require("mongoose");

const { resolveCapabilities, CAPABILITIES } = require("./capabilities");
const { fail } = require("./errors");

/* ── THE MEMBERSHIP RESOLUTION ITSELF MOVED, THE RULES DID NOT ──────────────
 * Central Costing needs the same answer to "which company is this person
 * acting for", and a second implementation is a second answer waiting to
 * disagree with this one. So the ordered, fail-closed resolution now lives at
 * a neutral path and both domains call it. Nothing about Store & Purchase's
 * behaviour changes: the order, the error codes and the wording are the same,
 * with the wording passed in rather than duplicated. */
const {
  MEMBERSHIP_SOURCES, resolveCompanyForActor,
} = require("../companyContext/companyMembership.service");

/**
 * Resolve the tenant context for an authenticated actor.
 *
 * @param {object} user  req.user as EmployeeAuthMiddlewear sets it
 * @throws {StorePurchaseError} 401 when unauthenticated, 403 when membership
 *         cannot be proved
 */
async function resolveForActor(user, { requestedCompanyId = null } = {}) {
  if (!user || !user.id) {
    throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  }

  const email = user.email ? String(user.email).toLowerCase().trim() : "";
  const employeeRef = mongoose.Types.ObjectId.isValid(user.id)
    ? new mongoose.Types.ObjectId(user.id)
    : null;

  const {
    companyId, permittedSiteIds, membershipSource, membership,
  } = await resolveCompanyForActor(user, {
    requestedCompanyId,
    domainLabel: "Store & Purchase",
    fail,
  });

  const { capabilities, via, isAdmin } = await resolveCapabilities({
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
    permittedSiteIds,
    siteId: null,
    capabilities,
    capabilitySet: new Set(capabilities),
    via,
    isAdmin,
    membershipSource,
    legacyMode: false,
  };
}

/**
 * Resolve tenant context for an identity that arrived WITHOUT a CMS token.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 * Material requests have two doors. The CMS door carries a JWT with an
 * ObjectId and an email, which `resolveForActor` reads. The Cowork/Firebase
 * door carries neither: `coworkAuth` verifies a Firebase ID token and the
 * route's own `attach` sets `req.user.id` to a **biometricId string**. Passing
 * that to `resolveForActor` would look up a membership by an id that is not an
 * ObjectId and quietly find nothing.
 *
 * So the Cowork door resolves the person the only way that is authoritative —
 * the HR Employee record — and the context is built from THAT. The Firebase
 * token proves who is calling; the employee record says who they are here.
 * Neither is asked what company they belong to.
 *
 * @param {object} employee  a lean Employee document, already looked up
 */
async function resolveForEmployee(employee, { requestedCompanyId = null } = {}) {
  if (!employee?._id) {
    throw fail(
      "UNAUTHENTICATED",
      "Your staff record could not be found, so Store & Purchase cannot identify you.",
    );
  }
  /* Deliberately reusing the same resolution, not a parallel one: a second
     implementation of "which company is this person in" is a second answer
     waiting to disagree with the first. */
  return resolveForActor({
    id: String(employee._id),
    email: employee.email || "",
    name: [employee.firstName, employee.lastName].filter(Boolean).join(" ").trim() || employee.name || "",
    employeeId: employee.biometricId || employee.identityId || "",
  }, { requestedCompanyId });
}

/**
 * Explicit context for a background job or internal service.
 *
 * Deliberately awkward to call: a service that wants tenant scope must name
 * the company AND say why. There is no ambient "system" context that silently
 * becomes global, which is how background jobs quietly cross tenants.
 */
function forService({ companyId, reason, capabilities = null }) {
  if (!companyId) throw fail("VALIDATION", "A service tenant context must name a company.");
  if (!reason) throw fail("VALIDATION", "A service tenant context must state its reason.");
  return {
    actorId: "service",
    actorType: "service",
    actorName: reason,
    actorEmail: "",
    companyId,
    permittedSiteIds: [],
    siteId: null,
    /* A service gets exactly what it is given — not everything. */
    capabilities: capabilities || [],
    capabilitySet: new Set(capabilities || []),
    via: ["service"],
    isAdmin: false,
    membershipSource: MEMBERSHIP_SOURCES.SERVICE,
    legacyMode: false,
  };
}

/**
 * The filter every scoped read and write must include.
 *
 * In legacy mode it selects the records with NO company instead — never both,
 * because a list that mixes owned and unowned records is exactly the
 * ambiguity Chunk 0 recorded.
 */
function tenantFilter(ctx) {
  if (!ctx) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (ctx.legacyMode) {
    return { $or: [{ companyId: { $exists: false } }, { companyId: null }] };
  }
  return { companyId: ctx.companyId };
}

/** Fields every new operational record must carry, taken from context only. */
function stamp(ctx) {
  const out = { companyId: ctx.companyId };
  if (ctx.siteId) out.siteId = ctx.siteId;
  return out;
}

/**
 * A site the caller asked to act at.
 *
 * ── WHY THIS REFUSES RATHER THAN VALIDATES ──────────────────────────────────
 * There is no authoritative company-owned site model anywhere in this system.
 * An earlier version accepted whatever ObjectId the browser sent and stamped
 * it onto the record whenever the actor's membership listed no sites — which
 * is not validation, it is trusting the client with a scope field and then
 * describing it as checked.
 *
 * So until a real site master exists (a later chunk, with warehouses):
 *   · no site named  → null. Every current document type is site-optional.
 *   · a site named, and the membership grants sites → validated against them.
 *   · a site named, and the membership grants none → REFUSED as not
 *     configured. Silently ignoring it would be worse: the caller would
 *     believe they had scoped the record.
 *   · a malformed id → a structured validation error, never a 500 from
 *     mongoose casting it later.
 */
function resolveSite(ctx, requestedSiteId) {
  if (requestedSiteId === undefined || requestedSiteId === null || requestedSiteId === "") return null;

  const wanted = String(requestedSiteId);
  if (!mongoose.Types.ObjectId.isValid(wanted)) {
    throw fail("VALIDATION", "That site reference is not valid.", { field: "siteId" });
  }

  if (!ctx.permittedSiteIds.length) {
    throw fail(
      "SITE_NOT_CONFIGURED",
      "Sites are not set up for Store & Purchase yet, so work cannot be assigned to one.",
      { siteId: wanted },
    );
  }

  if (!ctx.permittedSiteIds.includes(wanted)) {
    throw fail("SITE_NOT_PERMITTED", "You do not have access to that site.", { siteId: wanted });
  }

  return new mongoose.Types.ObjectId(wanted);
}

/**
 * Refuse a company the browser tried to supply.
 *
 * Not merely ignored: a body that names a DIFFERENT company is a client
 * asking for something it must never get, and answering it with a silent
 * substitution teaches the client that the field works.
 */
function assertNoForeignCompany(ctx, body = {}) {
  const supplied = body.companyId ?? body.company;
  if (supplied === undefined || supplied === null || supplied === "") return;
  if (String(supplied) !== String(ctx.companyId)) {
    throw fail("TENANT_MISMATCH", "That record belongs to another company.", {});
  }
}

/**
 * Assert a referenced document belongs to this tenant before it is used.
 *
 * Takes the already-loaded document rather than an id, so the caller cannot
 * "check" one document and then mutate another.
 */
function assertSameTenant(ctx, doc, label = "record") {
  if (!doc) throw fail("NOT_FOUND", `That ${label} was not found.`);
  const owner = doc.companyId ?? null;
  if (owner === null) {
    /* A legacy-global record cannot join a company-scoped write. Reading it
       is a separate, capability-gated mode. */
    throw fail(
      "LIFECYCLE_BLOCKED",
      `That ${label} predates company ownership and cannot be used in a new company-scoped action.`,
      { reason: "LEGACY_GLOBAL_RECORD" },
    );
  }
  if (String(owner) !== String(ctx.companyId)) {
    /* Non-disclosing: the same answer a genuinely missing document gets. */
    throw fail("NOT_FOUND", `That ${label} was not found.`);
  }
  return doc;
}

module.exports = {
  MEMBERSHIP_SOURCES,
  CAPABILITIES,
  resolveForActor,
  resolveForEmployee,
  forService,
  tenantFilter,
  stamp,
  resolveSite,
  assertNoForeignCompany,
  assertSameTenant,
};
