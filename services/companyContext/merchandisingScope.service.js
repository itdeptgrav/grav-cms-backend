// services/companyContext/merchandisingScope.service.js
//
// THE COMPANY FILTER EVERY MERCHANDISING STYLE QUERY MUST CARRY.
//
// ── WHY THIS IS A SCOPE HELPER AND NOT A LINE IN A ROUTE ────────────────────
// A `SampleStyle` carries no `companyId`. Ownership is PROVED through its Sales
// parents — the Journey is the spine and carries a company, and a house sample
// with no journey falls back to its enquiry. `technicalSource.ownershipProofFor`
// implements that rule one style at a time, which is right for opening a style
// and is an N+1 read per row for a work queue that counts and pages a whole
// portfolio.
//
// So the same rule is expressed here ONCE, as a filter: the company's own
// parents are resolved in indexed, company-scoped reads and the style query is
// bounded by their ids before Mongo looks at a style. Every Merchandising read
// goes through this, and a future query that reaches SampleStyle without it is
// visibly doing something the rest of the module does not.
//
// ── EVERY READ HERE IS BOUNDED BY THE COMPANY ───────────────────────────────
// Both queries below carry `companyClause`, and there is deliberately no third.
//
// An earlier version of this file also read `SalesJourney.find({companyId:
// {$in:[null]}})` — every unstamped journey in the DATABASE, across every
// company — so that a style whose journey proves nothing could still be
// rescued by its enquiry. That query grows with the whole deployment rather
// than with the caller's company, it is exactly the unbounded scan this chunk
// forbids, and the thing it bought was small: a style whose journey exists but
// carries no company at all.
//
// ── SO AMBIGUOUS PARENTAGE IS EXCLUDED, AND THAT IS SAID OUT LOUD ───────────
// Three shapes cannot be attributed with bounded reads, and all three are
// absent from Merchandising's queue rather than assumed to be this company's:
//
//   · a style whose journey carries no `companyId` (a pre-tenancy record the
//     Chunk 3A backfill exists to settle);
//   · a style whose journey row is MISSING entirely — a dangling reference;
//   · a style naming a journey by BUSINESS REFERENCE rather than by id.
//     `SampleStyle.journeyId` is an ObjectId path, so a `SJ-2026-0002` held
//     there cannot be matched through this filter without a cast error.
//
// Each of them is a legacy data problem with a named migration
// (`scripts/migrations/backfill-journey-company.js`), and every one of them
// fails CLOSED here: a style is either proved to belong to this company or it
// is not listed. The alternative — reading ownership off a second parent after
// the authoritative one proved nothing — is how one company's work appears in
// another's queue.
//
// ── AND THE `$in` ARRAYS ARE THE COMPANY'S, NOT THE DATABASE'S ──────────────
// They grow with one company's Sales records, which is the interim bound
// Chunk 1 specifies ("bound styles by company-owned indexed parent IDs before
// aggregation until direct company stamps arrive"). Chunk 2 stamps company
// directly on the Merchandising-owned records and retires this file's reason
// to exist; until then this is the boundary, and it is one query per REQUEST
// rather than one per result.
"use strict";

const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

/* ── A FINISHED STYLE IS NOT OUTSTANDING WORK ───────────────────────────────
 * `SampleStyle.status` is the style's own lifecycle — `active`, `completed` or
 * `cancelled` — and it is indexed. `isActive` is a separate soft-delete flag;
 * a style can be perfectly `isActive: true` and still be COMPLETED, which is
 * how a finished style kept appearing in a queue of things somebody has to do.
 *
 * Terminal is terminal for every read here: the portfolio count, each work
 * count, and the queue itself. A count that included closed styles and a list
 * that excluded them would be two answers to one question. */
const TERMINAL_STYLE_STATUSES = Object.freeze(["completed", "cancelled"]);

/* Required as a NAMESPACE so the delegation below is visible — and testable —
   as "this IS the Sales scope", rather than as a lookalike that has to be
   compared with it by reading two files. */
const salesScope = require("./salesScope.service");
const membership = require("./companyMembership.service");
const { StorePurchaseError, fail } = require("../storePurchase/errors");

/* ═══ WHICH COMPANY A MERCHANDISER IS STANDING IN ══════════════════════════
 *
 * The Merchandising Overview and Style Work queue take an acting company on
 * `X-Costing-Company` — the header the CMS company-context resolver already
 * reads. The STYLE and BOM screens are the same journey continued, so a
 * merchandiser who chose a company on the Overview has to still be in it when
 * they open a style, approve a packaging component or save a development
 * requirement. Without that, the second half of the flow silently resolves
 * through a different rule than the first.
 *
 * ── AND EVERY EXISTING CALLER RESOLVES EXACTLY AS IT DID ────────────────────
 * The Merchandising style and BOM endpoints live on the sample-style router,
 * and three of them — the packaging selection write, its status change and the
 * item search — are shared with the R&D screen, which sends no such header.
 *
 * So when no company is NAMED, this does not merely behave like the Sales
 * scope: it IS the Sales scope. `salesScope.scopeFor(req)` is called, its
 * memoised result is returned, and there is no second resolution, no second
 * set of rules and nothing to drift. Only a request that explicitly names a
 * company takes the branch below.
 *
 * ── THE HEADER SELECTS; IT NEVER AUTHORISES ─────────────────────────────────
 * `resolveCompanyForActor` validates the named company against the
 * memberships the actor already holds and refuses one they do not — with the
 * same non-disclosing answer a company that does not exist would get. Nothing
 * here reads a company from a body, and nothing reads one from the record
 * being requested.
 */
function requestedCompanyFrom(req) {
  const raw = (typeof req?.get === "function" ? req.get("X-Costing-Company") : null)
    || req?.headers?.["x-costing-company"]
    || req?.query?.actingCompanyId
    || null;
  const value = String(raw ?? "").trim();
  return value || null;
}

/**
 * The company this Merchandising request is for.
 *
 * @returns the same shape `salesScope.scopeFor` returns — `{ companyId,
 *   membershipSource, allowUnowned, clause }` — so a handler can be moved onto
 *   it without its body changing.
 */
async function merchandisingScopeFor(req, { domainLabel = "Merchandising" } = {}) {
  if (req.__merchandisingScope) return req.__merchandisingScope;

  const requestedCompanyId = requestedCompanyFrom(req);
  if (!requestedCompanyId) {
    /* Not a copy of the Sales rule — the Sales rule. */
    const scope = await salesScope.scopeFor(req, { domainLabel });
    req.__merchandisingScope = scope;
    return scope;
  }

  if (!req.user?.id) throw fail("UNAUTHENTICATED", `Sign in to use ${domainLabel}.`);

  const { companyId, membershipSource } = await membership.resolveCompanyForActor(req.user, {
    requestedCompanyId,
    domainLabel,
    fail,
  });

  /* The legacy allowance is the deployment's, not the request's, and it is
     asked of the COMPANY MASTER exactly as the Sales scope asks it. */
  const allowUnowned = await salesScope.soleCompanyDeployment(companyId);
  const scope = {
    companyId,
    membershipSource,
    allowUnowned,
    clause: {
      $or: [
        { companyId },
        ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
      ],
    },
  };
  req.__merchandisingScope = scope;
  return scope;
}

/**
 * The refusals that answer "who are you, and which company is this for" —
 * every one of which already knows its own HTTP status.
 *
 * Listed by CODE rather than by class, and that distinction is load-bearing:
 * the domain refusals these same handlers raise — a body carrying a rate, a
 * service that is not registered, a charge nobody configured — are
 * `StorePurchaseError`s too. Catching the class would have handed all of them
 * the access refusal's response SHAPE, and every screen reading `body.code`
 * would have stopped seeing one.
 *
 * `FORBIDDEN` joins the company codes because the Merchandising blocks now
 * prove a live department grant as well as a company, and "you do not hold a
 * Merchandising role" is the same kind of answer as "choose a company": a 403
 * the screen can act on, not a 500 that says the server broke.
 */
const ACCESS_REFUSAL_CODES = new Set([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "TENANT_MEMBERSHIP_UNPROVEN",
  "COMPANY_SELECTION_REQUIRED",
  "COMPANY_CONTEXT_UNAVAILABLE",
]);

/**
 * Is this an access refusal that already knows its own status?
 *
 * The Merchandising route handlers catch everything and answer 500. That is
 * the right answer for a bug and the wrong one for "you belong to two
 * companies and named neither" or "that is not your department". Used to let
 * those through with their own code, and to leave every other refusal to the
 * handling its block already had.
 */
const isScopeRefusal = (err) => (
  err instanceof StorePurchaseError && ACCESS_REFUSAL_CODES.has(err.code)
);

/**
 * The filter that binds a `SampleStyle` query to one company.
 *
 * @param {ObjectId|string} companyId  the actor's proven company — never a
 *   value taken from a body, a style, or the record being requested.
 * @param {object} [opts]
 * @param {boolean} [opts.activeOnly=true]  a cancelled or archived style is
 *   not somebody's outstanding work.
 * @returns {Promise<object|null>}  the filter, or `null` when this company owns
 *   no Sales parent at all — which is a truthful empty result, not an error.
 */
async function styleOwnershipClause(companyId, { activeOnly = true } = {}) {
  const companyClause = { companyId };

  const [journeys, enquiries] = await Promise.all([
    SalesJourney.find({ ...companyClause }).select("_id").lean(),
    Enquiry.find({ ...companyClause }).select("_id").lean(),
  ]);

  const journeyIds = journeys.map((j) => j._id);
  const enquiryIds = enquiries.map((e) => e._id);

  if (!journeyIds.length && !enquiryIds.length) return null;

  const branches = [];
  /* Proved by the spine. A journey that resolves and names this company is the
     authoritative answer, exactly as `ownershipProofFor` treats it. */
  if (journeyIds.length) branches.push({ journeyId: { $in: journeyIds } });
  /* A house sample, which has NO journey by construction. `$in: [null]` matches
     an absent field as well as an explicit null, because both shapes exist in a
     collection the field was made optional on.

     Note what this branch does NOT do: it never applies to a style that names a
     journey. A foreign journey plus an owned enquiry is refused, and so is an
     unresolvable one — see the header. */
  if (enquiryIds.length) {
    branches.push({ journeyId: { $in: [null] }, enquiryId: { $in: enquiryIds } });
  }

  return {
    ...(activeOnly ? { isActive: true, status: { $nin: TERMINAL_STYLE_STATUSES } } : {}),
    $or: branches,
  };
}

/**
 * The company middleware every Merchandising router shares.
 *
 * Resolves the acting company from the actor's own memberships (the
 * `X-Costing-Company` header SELECTS among them and is never authority), and
 * leaves `{ companyId, membershipSource }` on `req.merchandising`. Extracted
 * so the Work router and the Execution router cannot drift — the same reason
 * the grant rule lives once in the access service.
 */
const merchandisingCompanyMiddleware = ({ domainLabel = "Merchandising" } = {}) => async (req, res, next) => {
  try {
    const requestedCompanyId = req.get("X-Costing-Company") || req.query?.actingCompanyId || null;
    const { companyId, membershipSource } = await membership.resolveCompanyForActor(req.user, {
      requestedCompanyId,
      domainLabel,
      fail,
    });
    req.merchandising = { companyId, membershipSource };
    next();
  } catch (err) {
    if (err instanceof StorePurchaseError) return res.status(err.status).json(err.toResponse());
    console.error("[merchandisingScope] company middleware:", err);
    return res.status(500).json({ success: false, message: "Something went wrong. Nothing was changed." });
  }
};

/**
 * THE SAME RULE, ONE STYLE AT A TIME.
 *
 * `styleOwnershipClause` states the rule as a QUERY, which is right for a list
 * bounded before Mongo looks at a style. Some callers need the same answer
 * ROW-WISE — an audit classifying every style it scanned, a boundary deciding
 * whether two references reach one company — and the honest way to give them
 * that is to state the rule once rather than let each one re-derive an
 * approximate copy that drifts.
 *
 * The four clauses below are exactly the four the query carries, in the same
 * order, and `test/industrial-engineering/ie-style-ownership.test.js` proves
 * the two agree over a fixture set by running both and comparing the id sets.
 *
 * @param {object} style  a lean SampleStyle with `journeyId`, `enquiryId`,
 *   `isActive` and `status`
 * @param {object} parents
 * @param {(journeyId: string) => (string|null)} parents.journeyCompanyOf  the
 *   company on that journey, or null when the journey is missing or carries
 *   none
 * @param {(enquiryId: string) => (string|null)} parents.enquiryCompanyOf
 * @param {object} [opts]
 * @param {boolean} [opts.activeOnly=true]  mirrors the query's own option
 * @returns {{eligible: boolean, companyId: string|null, reason: string}}
 */
function styleOwnerFrom(style, { journeyCompanyOf, enquiryCompanyOf }, { activeOnly = true } = {}) {
  const out = (reason, companyId = null) => ({ eligible: companyId !== null, companyId, reason });
  const id = (v) => String(v ?? "").trim();

  /* 1 — the soft-delete flag, and 2 — the style's own lifecycle. Both are in
     the query's top level, so a style failing either is not merely unowned:
     it is outside every read this rule governs. */
  if (activeOnly && style?.isActive === false) return out("NOT_ACTIVE");
  if (activeOnly && TERMINAL_STYLE_STATUSES.includes(id(style?.status))) {
    return out("TERMINAL_STATUS");
  }

  /* 3 — the journey is the spine, and it is AUTHORITATIVE when named. A style
     that names a journey is matched by the journey branch or by nothing: the
     enquiry branch carries `journeyId: {$in: [null]}` precisely so a
     named-but-unprovable journey cannot fall through to it. A missing journey,
     one carrying no company, and one belonging to somebody else are therefore
     the same answer — unprovable — and that is deliberate. */
  const journeyId = id(style?.journeyId);
  if (journeyId) {
    const company = id(journeyCompanyOf(journeyId));
    return company ? out("SALES_JOURNEY", company) : out("JOURNEY_UNPROVABLE");
  }

  /* 4 — a house sample has no journey by construction, and only then does its
     enquiry answer. */
  const enquiryId = id(style?.enquiryId);
  if (enquiryId) {
    const company = id(enquiryCompanyOf(enquiryId));
    return company ? out("ENQUIRY", company) : out("ENQUIRY_UNPROVABLE");
  }

  return out("NO_PARENT");
}

module.exports = {
  styleOwnershipClause, styleOwnerFrom, TERMINAL_STYLE_STATUSES, merchandisingScopeFor,
  merchandisingCompanyMiddleware,
  isScopeRefusal, ACCESS_REFUSAL_CODES, requestedCompanyFrom,
};
