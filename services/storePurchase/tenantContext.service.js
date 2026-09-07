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

const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { resolveCapabilities, CAPABILITIES } = require("./capabilities");
const { fail } = require("./errors");

const MEMBERSHIP_SOURCES = Object.freeze({
  MEMBERSHIP_RECORD: "MEMBERSHIP_RECORD",
  SINGLE_COMPANY_DEPLOYMENT: "SINGLE_COMPANY_DEPLOYMENT",
  SERVICE: "SERVICE",
});

/** Loaded lazily: the accountant master models are a large module and the
 *  Store routers should not pay for it at require time. */
const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

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

  /* ── 1. An explicit membership record decides ───────────────────────────
   *
   * ── WHY THIS IS NOT A `findOne` ────────────────────────────────────────
   * The model permits an actor to hold memberships in several companies, and
   * an earlier version took whichever one the database happened to return
   * first. That is not a tenant boundary: the same person, on two identical
   * requests, could be resolved into two different companies, and nothing
   * about the request would say which. Selection has to be deterministic and
   * it has to be the caller's stated, validated choice.
   *
   * So: read EVERY active membership. One is unambiguous. More than one
   * requires the caller to name the company they are acting for — and that
   * name is validated against the memberships, never trusted on its own. */
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

  let companyId;
  let permittedSiteIds = [];
  let membershipSource;
  let membership = null;

  if (distinct.length === 1) {
    membership = distinct[0];
    companyId = membership.companyId;
    permittedSiteIds = (membership.siteIds || []).map(String);
    membershipSource = MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD;
  } else if (distinct.length > 1) {
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
    membership = byCompany.get(wanted) || null;
    if (!membership) {
      /* Non-disclosing: naming a company they do not belong to is answered
         the same way as naming one that does not exist. */
      throw fail(
        "TENANT_MEMBERSHIP_UNPROVEN",
        "You do not have access to that company in Store & Purchase.",
        {},
      );
    }
    companyId = membership.companyId;
    permittedSiteIds = (membership.siteIds || []).map(String);
    membershipSource = MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD;
  } else {
    /* ── 2. Single-company deployment ──────────────────────────────────────
     * A DEPLOYMENT FACT, not an inference from this request: it reads neither
     * the body, the query, nor the document being accessed. It is the same
     * rule mrfRoutes.js already applies at the fulfilment decision, and it is
     * what keeps the live single-company system working while memberships are
     * populated. The moment a second company exists, or anybody is given an
     * explicit membership, it stops applying — for everybody, at once. */
    const Acc_Company = companyModel();
    const anyMembershipExists = await SpCompanyMembership.exists({ isActive: true }).catch(() => null);
    const companies = await Acc_Company.find({}).select("_id").limit(2).lean().catch(() => []);

    if (!anyMembershipExists && companies.length === 1) {
      companyId = companies[0]._id;
      membershipSource = MEMBERSHIP_SOURCES.SINGLE_COMPANY_DEPLOYMENT;
    } else {
      /* ── 3. Fail closed ─────────────────────────────────────────────────── */
      throw fail(
        "TENANT_MEMBERSHIP_UNPROVEN",
        companies.length === 0
          ? "No company is set up in the books yet. Ask finance to create one before using Store & Purchase."
          : "Your account is not linked to a company in Store & Purchase. Ask an administrator to grant you access.",
        { companiesConfigured: companies.length, hasMembershipRecords: Boolean(anyMembershipExists) },
      );
    }
  }

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
