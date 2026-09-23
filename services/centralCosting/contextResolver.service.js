// services/centralCosting/contextResolver.service.js
//
// Central Costing — Chunk 1 hardening. PROVING THE THING A COSTING POINTS AT.
//
// ── WHAT THE PARSER CANNOT DO ───────────────────────────────────────────────
// `costingInput.parseContext` checks the SHAPE of a context reference: is this
// a known type, is this a well-formed id, is the compound key present. It
// cannot check that the document exists, and it must not: it is pure, it runs
// before any company is even in scope, and a parser that reached into the
// database would be a parser nobody could test.
//
// This is the other half, and it runs AFTER the company is resolved — never
// before, and never as an input to it.
//
// ── THE ORDER IS THE WHOLE POINT ────────────────────────────────────────────
//   1. the actor's company is resolved from their own membership;
//   2. the referenced document is looked up WITHIN that company;
//   3. missing and foreign are answered identically.
//
// Never the reverse. Reading the company off the enquiry would answer "may I
// see this?" with "you are seeing it", and would let anyone who could name an
// enquiry id borrow whichever company owned it.
//
// ── AND A SNAPSHOT THE CLIENT DID NOT WRITE ─────────────────────────────────
// The display copy is built here, from the document that was just proved to
// exist. A client-supplied label would be a caption on a record it does not
// own — harmless on a screen, and quietly wrong in an audit six months later
// when the frozen version is read back and the label describes something else.
"use strict";

const mongoose = require("mongoose");

const { fail } = require("../storePurchase/errors");

/* Loaded lazily. The Sales models pull in a large graph, and a costing create
   that never names an enquiry should not pay for it. */
const enquiryModel = () => require("../../models/CMS_Models/Sales/Enquiry");
const companyModel = () => require("../../models/Accountant_model/Acc_MasterModels").Acc_Company;

/* Identical to the router's: a costing that names an enquiry the actor may not
   have must be refused exactly as one that names an enquiry nobody has. */
const notFound = () =>
  fail("NOT_FOUND", "That enquiry was not found.", { reason: "CONTEXT_REFERENCE_NOT_FOUND" });

/**
 * ── THE HONEST PART: SALES RECORDS CARRY NO COMPANY ─────────────────────────
 *
 * `Enquiry` has no `companyId`, and neither does `CRMAccount` or
 * `SalesJourney`. That is a fact about the current schema, not an oversight
 * here, and it has one unavoidable consequence: an enquiry document cannot be
 * proved to belong to the actor's company.
 *
 * Three responses were possible, and two of them are wrong:
 *
 *   · scope the query by a field that does not exist — the filter matches
 *     nothing and every enquiry costing fails, so nobody would write that;
 *   · look the enquiry up unscoped and call it validated — which is the
 *     unsafe adapter this chunk explicitly refuses to build. In a
 *     multi-company deployment it would let one company raise costings
 *     against another's enquiries and snapshot their buyer's name into them.
 *
 * So: an unowned Sales record is usable only where ownership cannot be
 * ambiguous — a deployment fact the company master can answer.
 *
 * ── AND THE ORDER MATTERS AS MUCH AS THE RULE ───────────────────────────────
 * The first version of this asked the question in the wrong order: it looked
 * the enquiry up FIRST and decided whether it was allowed to afterwards. In a
 * multi-company deployment that made the refusal depend on the lookup —
 *
 *     an enquiry id that exists      → CONTEXT_NOT_SUPPORTED_YET
 *     an enquiry id that does not     → NOT_FOUND
 *
 * — which is an existence oracle. Anyone who could reach this endpoint could
 * enumerate other companies' enquiry ids one guess at a time, learning nothing
 * about their contents but everything about which ids are real. A refusal that
 * varies with the secret is not a refusal.
 *
 * So the capability is settled BEFORE any enquiry is read, and it is settled
 * from things that are not the enquiry: the model's own schema, and the
 * company master. Where scoping is impossible, no enquiry query happens at
 * all, and every caller gets the same answer whatever id they guessed.
 */

/**
 * Can an enquiry be scoped to a company at all — as a property of the MODEL,
 * never of one document?
 *
 * Read from the schema rather than from a fetched record, precisely so the
 * decision can be made without fetching one. It also answers honestly during a
 * migration: once the path exists, the scoped query below is used, and a
 * document that has not been backfilled yet simply does not match — which is
 * fail-closed and correct, not a special case to code around.
 */
const enquiryIsCompanyScoped = () => Boolean(enquiryModel().schema.path("companyId"));

/** The one refusal when Sales cannot be scoped. Identical for every input. */
const notCompanyScoped = () =>
  fail(
    "CONTEXT_NOT_SUPPORTED_YET",
    "Enquiries are not company-scoped yet, so a costing cannot safely be raised against one here.",
    {
      field: "context.primaryId",
      reason: "CONTEXT_SOURCE_NOT_COMPANY_SCOPED",
      contextType: "ENQUIRY_STYLE",
    },
  );

/**
 * Is this a single-company deployment, and is it the actor's company?
 *
 * The only circumstance in which reading an unowned Sales record is safe: if
 * exactly one company exists, no enquiry can belong to a different one.
 * Asked of the company master — never of the enquiry, and never of the
 * request.
 */
async function isSoleCompanyDeployment(ctx) {
  const Acc_Company = companyModel();
  let companies;
  try {
    companies = await Acc_Company.find({}).select("_id").limit(2).lean();
  } catch (err) {
    /* Same rule as the membership resolver: a failed lookup is not a fact,
       and it must never be the thing that lets an unowned record through. */
    console.error("[centralCosting] company lookup failed while scoping an enquiry:", err?.message || err);
    throw fail(
      "COMPANY_CONTEXT_UNAVAILABLE",
      "The enquiry's company could not be checked just now. Try again in a moment.",
      { stage: "context company lookup" },
    );
  }
  return companies.length === 1 && String(companies[0]._id) === String(ctx.companyId);
}

/**
 * Resolve an `ENQUIRY_STYLE` context and build its display snapshot.
 *
 * @param {object} ctx    the resolved costing context — company comes from
 *                        HERE and only here
 * @param {object} context `parseContext`'s output
 * @returns {Promise<{contextSnapshot: object, scopeProof: string}>}
 */
async function resolveEnquiryStyle(ctx, context, { withSheets = false } = {}) {
  const Enquiry = enquiryModel();

  /* ── 1. MAY AN ENQUIRY BE RESOLVED AT ALL, IN THIS DEPLOYMENT? ──────────
     Settled first, and without reading the enquiry. Nothing below this point
     runs until the answer is yes, so a refusal cannot vary with the id. */
  const scoped = enquiryIsCompanyScoped();

  /* ── MAY AN UNOWNED ENQUIRY BE USED AT ALL, IN THIS DEPLOYMENT? ─────────
   * Asked of the COMPANY MASTER, before any enquiry is read, so the answer
   * cannot vary with the id supplied — that is the oracle this file was
   * corrected for once already.
   *
   * Every enquiry created before `Enquiry.companyId` existed is unowned, and
   * the backfill for them is a reviewable script that has deliberately not
   * been run. Refusing them outright would break costing on every existing
   * deployment; accepting them anywhere would let one company cost against
   * another's enquiry. So they are usable exactly where ownership cannot be
   * ambiguous: when the company master holds one company, and it is this
   * actor's. The moment a second company exists they fail closed — and they
   * fail closed as NOT FOUND, indistinguishable from an enquiry that never
   * existed. */
  const allowUnowned = await isSoleCompanyDeployment(ctx);

  if (!scoped && !allowUnowned) {
    /* A deployment whose Enquiry model predates the company field entirely.
       Nothing can be proved about ownership, so nothing is assumed. */
    throw notCompanyScoped();
  }

  /* ── 2. ONE QUERY, SCOPED WHERE SCOPING EXISTS ──────────────────────────
     `companyId` comes from the resolved context and is part of the SAME
     filter as the id, so there is no "find it, then check it" — a check
     somebody eventually forgets to write, and one that briefly holds a
     foreign document in memory before deciding it is not allowed.

     Where the model has no company path, the filter omits it — and that is
     only reachable because step 1 already proved there is exactly one
     company for it to have belonged to. */
  /* ── ONE QUERY, SCOPED, WITH THE LEGACY ALLOWANCE INSIDE IT ────────────
     `companyId` comes from the resolved context and is part of the SAME
     filter as the id — no "find it, then check it", which is a check somebody
     eventually forgets to write and which briefly holds a foreign document in
     memory before deciding it is not allowed.

     The unowned clause is added only when the deployment proved above that it
     is safe, so a multi-company deployment issues a strictly company-scoped
     query and an unowned enquiry simply does not match. */
  const companyClause = scoped
    ? {
        $or: [
          { companyId: ctx.companyId },
          ...(allowUnowned ? [{ companyId: null }, { companyId: { $exists: false } }] : []),
        ],
      }
    : {};

  const enquiry = await Enquiry.findOne({
    _id: context.primaryId,
    isActive: true,
    ...companyClause,
  })
    /* `costingSheets` only when a caller has said it needs them — Chunk 2's
       legacy import does; an ordinary create does not, and the sheets are the
       largest thing on an enquiry. */
    .select(`enquiryId title products accountId isActive createdAt companyId${withSheets ? " costingSheets" : ""}`)
    .lean();

  /* Missing, inactive, foreign, and unowned-in-a-multi-company-deployment all
     land here with one body. */
  if (!enquiry) throw notFound();

  /* Recorded into the frozen snapshot so a later reader knows what the
     ownership check was worth at the time: proved from the document, or
     allowed because there was only one company it could have belonged to. */
  const scopeProof = enquiry.companyId ? "DOCUMENT_COMPANY" : "SINGLE_COMPANY_DEPLOYMENT";

  /* ── THE PRODUCT KEY MUST NAME A PRODUCT THE ENQUIRY HAS ────────────────
     `products[].product` is the identity — the enquiry schema says so, and
     says why: `sanitizeProducts()` reassigns every row a fresh `_id` on each
     requirement save, so the name is the only thing that survives. A costing
     keyed to a product the enquiry does not list would be an orphan the
     moment anybody looked.

     Only checked when the enquiry HAS products: an enquiry routinely gets
     costed before its requirement is filled in, and refusing that would stop
     legitimate work to enforce an ordering nobody agreed to. */
  const names = (enquiry.products || []).map((p) => String(p.product || "").trim()).filter(Boolean);
  if (names.length && !names.includes(context.externalKey)) {
    throw fail("VALIDATION", "That product is not on this enquiry.", {
      field: "context.externalKey",
      reason: "CONTEXT_PRODUCT_NOT_IN_ENQUIRY",
      /* The enquiry is already proved visible to this caller, so listing its
         own product names discloses nothing they cannot read directly. */
      available: names,
    });
  }

  return {
    scopeProof,
    enquiry,
    contextSnapshot: {
      label: `${context.externalKey} — ${enquiry.enquiryId}`,
      facts: [
        { key: "enquiryId", value: String(enquiry.enquiryId || "") },
        { key: "enquiryTitle", value: String(enquiry.title || "") },
        { key: "product", value: context.externalKey },
        /* The reference, not the buyer's name: resolving the account would be
           a second unowned Sales read, and the id is enough for anyone
           entitled to look it up. */
        { key: "accountId", value: String(enquiry.accountId || "") },
        /* How ownership was established, carried into the frozen record so a
           later reader knows what the check was worth at the time. */
        { key: "scopeProof", value: scopeProof },
      ].filter((f) => f.value),
      capturedAt: new Date(),
    },
  };
}

/**
 * Resolve whatever the parsed context needs resolving.
 *
 * `ADHOC` references nothing, so there is nothing to prove and the client's
 * own label stands — it describes a costing, not somebody else's document.
 */
async function resolveContext(ctx, context, parsedSnapshot) {
  if (context.type === "ENQUIRY_STYLE") {
    if (!mongoose.Types.ObjectId.isValid(context.primaryId)) throw notFound();
    const { contextSnapshot, scopeProof } = await resolveEnquiryStyle(ctx, context);
    return { contextSnapshot, scopeProof };
  }
  return { contextSnapshot: parsedSnapshot, scopeProof: "NOT_APPLICABLE" };
}

module.exports = {
  resolveContext, resolveEnquiryStyle, enquiryIsCompanyScoped, isSoleCompanyDeployment,
};
