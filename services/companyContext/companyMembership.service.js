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

/**
 * Run an identity query, or refuse — never quietly return "nothing".
 *
 * ── WHY EVERY `.catch(() => [])` HERE WAS A HOLE ────────────────────────────
 * "The query returned no rows" and "the query failed" are different facts, and
 * this file's whole job is to turn facts about identity into an access
 * decision. Collapsing them:
 *
 *   · told a user with a perfectly good membership that their account is not
 *     linked to a company, sending them to an administrator to fix nothing;
 *   · and — the serious one — made the single-company fallback's premise
 *     ("nobody has a membership row") reachable by BREAKING the query that
 *     tests it. A fail-closed rule that can be opened by causing an error is
 *     not fail-closed.
 *
 * So a failure becomes a stable 503 that no caller can mistake for an
 * authorisation answer, and the cause is logged for an operator rather than
 * described to the client.
 */
async function unavailableOnFailure(fail, what, runQuery) {
  try {
    /* A THUNK, not an already-built query: a mongoose call can throw
       synchronously (a bad cast, a model in a broken state), and passing the
       query in as a value would let that throw escape the very handler written
       to catch it — surfacing as a 500 rather than the stable 503. */
    return await runQuery();
  } catch (err) {
    console.error(`[companyContext] ${what} failed:`, err?.message || err);
    throw fail(
      "COMPANY_CONTEXT_UNAVAILABLE",
      "Your company access could not be checked just now. Try again in a moment.",
      { stage: what },
    );
  }
}

const MEMBERSHIP_SOURCES = Object.freeze({
  MEMBERSHIP_RECORD: "MEMBERSHIP_RECORD",
  SINGLE_COMPANY_DEPLOYMENT: "SINGLE_COMPANY_DEPLOYMENT",
  /* The deployment's own company (`Acc_Company.isPrimary`), used for an actor
     with no membership while the legacy migration window is open. */
  PRIMARY_COMPANY_LEGACY: "PRIMARY_COMPANY_LEGACY",
  SERVICE: "SERVICE",
});

/* The same switch services/storePurchase/tenantContext.service.js defines as
   LEGACY_READTHROUGH, read here directly because that module requires this
   one (a require cycle otherwise). One env var, one meaning everywhere. */
const legacyWindowOpen = () => process.env.STORE_PURCHASE_STRICT_TENANCY !== "1";

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
    memberships = await unavailableOnFailure(fail, "membership lookup", () =>
      SpCompanyMembership.find({ isActive: true, $or: or })
        .select("companyId siteIds personName email employeeRef")
        .sort({ companyId: 1 }) // stable order, so any diagnostic reads the same twice
        .lean());
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
  /* ── BOTH QUERIES MUST SUCCEED BEFORE THE FALLBACK IS EVEN CONSIDERED ────
   * The fallback's premise is "no membership row exists for ANYBODY and there
   * is exactly one company". A failed query cannot establish either half, and
   * treating a failure as an empty result would let the premise be
   * MANUFACTURED by breaking the database — which is the one way a
   * fail-closed rule turns into a fail-open one. */
  const anyMembershipExists = await unavailableOnFailure(fail, "membership existence check", () =>
    SpCompanyMembership.exists({ isActive: true }));
  const companies = await unavailableOnFailure(fail, "company lookup", () =>
    Acc_Company.find({}).select("_id isPrimary isActive").limit(20).lean());

  if (!anyMembershipExists && companies.length === 1) {
    return {
      companyId: companies[0]._id,
      permittedSiteIds: [],
      membershipSource: MEMBERSHIP_SOURCES.SINGLE_COMPANY_DEPLOYMENT,
      membership: null,
    };
  }

  /* ── 2b. The deployment's own company, for the migration window ──────────
   *
   * The rule above stopped applying on 21 Sep 2026 — not because anybody was
   * given a membership, but because the IE demo seeder created two more
   * companies and a dozen demo memberships. From that moment every GRAV
   * employee without a membership row (which was all of them) fell through to
   * "not linked to a company" in Store, Merchandising, Packaging and the
   * finishing portals, and screens that swallowed the 403 showed empty floors.
   *
   * `Acc_Company.isPrimary` is set on the GRAV Clothing record itself and on
   * nothing else — it names the company this deployment IS. While the legacy
   * migration window is open, an actor with no membership resolves to that
   * one company, and only if exactly one active company is marked primary. A
   * person who HAS memberships is never affected (they returned above), and
   * the demo companies are never reachable this way. Closes with the window:
   * set STORE_PURCHASE_STRICT_TENANCY=1 once memberships are populated. */
  if (legacyWindowOpen()) {
    const primary = companies.filter((c) => c.isPrimary && c.isActive !== false);
    if (primary.length === 1) {
      return {
        companyId: primary[0]._id,
        permittedSiteIds: [],
        membershipSource: MEMBERSHIP_SOURCES.PRIMARY_COMPANY_LEGACY,
        membership: null,
      };
    }
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

/**
 * THE COMPANIES THIS ACTOR IS A MEMBER OF, WITH THEIR NAMES.
 *
 * The smallest projection a company selector needs, and membership-bound: it
 * reads the actor's own `SpCompanyMembership` rows and looks up only those
 * ids. Nobody browses the company master through it, and a person with no
 * membership gets an empty list rather than everybody's companies.
 *
 * ── WHY IT LIVES HERE ───────────────────────────────────────────────────────
 * It was written inside `services/merchandising/execution.service.js` because
 * that is the chunk that needed a selector first. A second department needing
 * the same answer had two bad options — import a Merchandising service into
 * Industrial Engineering, or keep a second copy that drifts — so the rule moved
 * to the module that already owns "which company is this person in". Both
 * callers read it here; neither owns it.
 *
 * @returns {Promise<{companies: Array<{companyId: string, displayName: string}>}>}
 */
async function listMembershipCompanies(user) {
  const str = (v) => String(v ?? "").trim();
  const email = str(user?.email).toLowerCase();
  const or = [];
  if (email) or.push({ email });
  if (mongoose.Types.ObjectId.isValid(str(user?.id))) {
    or.push({ employeeRef: new mongoose.Types.ObjectId(str(user.id)) });
  }
  if (!or.length) return { companies: [] };

  const memberships = await SpCompanyMembership.find({ isActive: true, $or: or })
    .select("companyId").lean();
  const ids = [...new Set(memberships.map((m) => str(m.companyId)))].filter(Boolean);
  if (!ids.length) return { companies: [] };

  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const companies = await Acc_Company.find({ _id: { $in: ids } })
    .select("companyName").lean();
  return {
    /* Sorted by name so two identical requests return the same order and a
       selector does not reshuffle itself between renders. */
    companies: companies
      .map((c) => ({ companyId: str(c._id), displayName: str(c.companyName) }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

module.exports = { MEMBERSHIP_SOURCES, resolveCompanyForActor, listMembershipCompanies };
