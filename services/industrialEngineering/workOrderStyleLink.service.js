// services/industrialEngineering/workOrderStyleLink.service.js
//
// IE CHUNK 1D — PROVE WHICH STYLE A NEW WORK ORDER IS MAKING, BEFORE IT EXISTS.
//
// ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
// The Chunk 1C readiness audit found 0 of 95 operational work orders with a
// provable order-to-style link. Not because the links disagreed — there were no
// conflicts and no ambiguities — but because almost none were stored. IE could
// not show the factory's open orders at all.
//
// So every live creation path now resolves the style FIRST, from a stored
// reference, and refuses to create anything if it cannot. The value is written
// as part of the work order's original save; nothing appends it afterwards.
//
// ── THE ONLY TWO SOURCES THAT PROVE ANYTHING ────────────────────────────────
//   1. the EXACT `CustomerRequest.items[]` line being converted, via that
//      line's own `sampleStyleId`;
//   2. for a split, replacement, return or remake, the EXACT source work
//      order's already-proved `sampleStyleId`.
//
// Everything else is refused by construction, because this module is never
// given it: not `stockItemId` alone, not a product name or reference, not
// variant similarity, not the customer, not enquiry or journey text, not "the
// first style found", and not a request-level `sampleStyleId` where an item
// line exists to answer instead. Two lines for one product resolve to that
// product's line only when they agree; otherwise the creation is refused as
// ambiguous rather than cross-linked.
//
// ── AND OWNERSHIP IS THE ACCEPTED RULE, NOT A NEW ONE ───────────────────────
// `styleOwnerFrom` from the shared scope service, in the Lane A
// status-independent mode: a completed, cancelled or archived style still
// proves ownership. What is NOT relaxed is parentage — a named journey is
// authoritative, an enquiry answers only for a style with no journey, and a
// missing, dangling or company-less journey stays unprovable.
"use strict";

const mongoose = require("mongoose");

const { fail, sendError } = require("../storePurchase/errors");
const { styleOwnerFrom } = require("../companyContext/merchandisingScope.service");
const {
  resolveCompanyForActor,
} = require("../companyContext/companyMembership.service");
const orderStyleLink = require("./orderStyleLink");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const model = (name, path) => (mongoose.models[name] || require(path));
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const WorkOrder = () => model("WorkOrder", "../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const SalesJourney = () => model("SalesJourney", "../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = () => model("Enquiry", "../../models/CMS_Models/Sales/Enquiry");

/** Lane A: lifecycle does not decide ownership. Parentage does. */
const OWNERSHIP_MODE = Object.freeze({ activeOnly: false });

const CODES = Object.freeze({
  REQUIRED: "WORK_ORDER_STYLE_LINK_REQUIRED",
  AMBIGUOUS: "WORK_ORDER_STYLE_LINK_AMBIGUOUS",
  NOT_FOUND: "WORK_ORDER_STYLE_NOT_FOUND",
  OWNERSHIP_UNPROVEN: "WORK_ORDER_STYLE_OWNERSHIP_UNPROVEN",
  COMPANY_MISMATCH: "WORK_ORDER_STYLE_COMPANY_MISMATCH",
});

/**
 * The style proved by the EXACT request line this work order is being built
 * from.
 *
 * @param {object} request  a CustomerRequest (document or lean)
 * @param {string} stockItemId  the product the work order is for — the only
 *   stored id a work order and a request line genuinely share at line level
 * @param {object} [opts]
 * @param {string} [opts.label]  what to call the product in a refusal
 * @returns {string} the style id
 * @throws typed refusal — never a guess
 */
function styleFromRequestLine(request, stockItemId, { label = "this product" } = {}) {
  const items = Array.isArray(request?.items) ? request.items : [];
  const wanted = str(stockItemId);
  const candidates = wanted ? items.filter((i) => str(i?.stockItemId) === wanted) : [];

  if (!candidates.length) {
    throw fail(CODES.REQUIRED,
      `This order cannot be released for production: no line on the customer request is for `
      + `${label}, so there is no approved style to make. Add the product to the order, or raise `
      + `the work order from the line that carries it.`,
      { stockItemId: wanted });
  }

  /* ── THE REQUEST-LEVEL STYLE, AND EXACTLY WHEN IT COUNTS ───────────────
     A sampling order is raised FROM one in-house sample, and stores it on the
     request rather than on the line: `CustomerRequest.sampleStyleId`. That is
     the order-specific fact for such a request, not an inference.

     It is used ONLY when the request has at most one item line, so there is no
     "which line" question for it to answer wrongly — which is the identical
     rule the accepted IE read resolver applies in `orderStyleLink.js`. Writing
     and reading therefore agree by construction. Where an item line names a
     style, the line wins and this is never consulted. */
  const items1 = Array.isArray(request?.items) ? request.items : [];
  const requestLevel = items1.length <= 1 ? str(request?.sampleStyleId) : "";
  const styleOfLine = (i) => str(i?.sampleStyleId) || requestLevel;

  const named = [...new Set(candidates.map(styleOfLine).filter(Boolean))];

  if (candidates.some((i) => !styleOfLine(i))) {
    /* A line that names no style cannot be answered for by a sibling line —
       whatever it would have named is not knowable. With one silent line the
       fix is to link it; with several the order is ambiguous as well. */
    if (candidates.length === 1) {
      throw fail(CODES.REQUIRED,
        `This order cannot be released for production: the customer-request line for ${label} `
        + `names no approved style. Link the line to its style in Sales before releasing.`,
        { stockItemId: wanted });
    }
    throw fail(CODES.AMBIGUOUS,
      `This order cannot be released for production: ${label} appears on ${candidates.length} `
      + `customer-request lines and at least one names no style, so which style this work order `
      + `would make cannot be read from the order. Reconcile the lines in Sales.`,
      { stockItemId: wanted, lines: candidates.length });
  }

  if (named.length > 1) {
    throw fail(CODES.AMBIGUOUS,
      `This order cannot be released for production: ${label} appears on ${candidates.length} `
      + `customer-request lines naming ${named.length} different styles. Nothing stored says which `
      + `one this work order would make. Reconcile the lines in Sales.`,
      { stockItemId: wanted, lines: candidates.length, styles: named.length });
  }

  return named[0];
}

/**
 * The style proved by the EXACT source work order a derivative is raised from.
 *
 * Splits, replacements, returns and remakes make the same garment as the order
 * they came from, and that order's link was already proved when IT was created.
 * Inheriting is therefore not an inference; re-deriving it from the new
 * paperwork would be.
 */
function styleFromSourceWorkOrder(sourceWorkOrder, { label = "this order" } = {}) {
  const styleId = str(sourceWorkOrder?.sampleStyleId);
  if (!styleId) {
    throw fail(CODES.REQUIRED,
      `${label} cannot be created: the work order it is raised from carries no approved style link, `
      + `so the style this one would make cannot be proved. Link the original order's style first.`,
      { sourceWorkOrderId: str(sourceWorkOrder?._id) });
  }
  return styleId;
}

/**
 * The style of a DERIVATIVE's source order — canonical first, then the accepted
 * legacy resolver.
 *
 * ── ABSENCE NEVER INHERITS ──────────────────────────────────────────────────
 * An earlier cut let a legacy source's missing link become `sampleStyleId: null`
 * on the new order, so a split or a remake could still create an unlinked work
 * order. That defeated the whole invariant. It is gone: a derivative is created
 * with a proved ObjectId or it is not created.
 *
 * A legacy source is not simply refused, though — it is RESOLVED, through the
 * very resolver the IE read boundary uses, from the two legacy references it
 * may already carry. Only an undisputed, company-provable, single-style answer
 * counts; ambiguous, disputed, cross-company or absent all refuse.
 *
 * ── AND THE SOURCE IS NEVER WRITTEN TO ──────────────────────────────────────
 * Resolving a legacy parent does not backfill it. No historical record is
 * touched here, only read.
 *
 * @param {string[]} sourceWorkOrderIds  every order feeding this derivative
 * @returns {Promise<string>} the one style all sources agree on
 */
async function styleForDerivative(sourceWorkOrderIds, { label = "This order", expectedCompanyId = null } = {}) {
  const ids = [...new Set((sourceWorkOrderIds || []).map(str).filter(isId))];
  if (!ids.length) {
    throw fail(CODES.REQUIRED,
      `${label} cannot be created: it names no original work order, so the style it would make `
      + `cannot be proved.`);
  }

  const sources = await WorkOrder().find({ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("_id workOrderNumber stockItemId customerRequestId sampleStyleId")
    .lean();
  if (sources.length !== ids.length) {
    throw fail(CODES.NOT_FOUND,
      `${label} cannot be created: an original work order it is raised from no longer exists.`);
  }

  /* ── EVERY SOURCE, EVERY PIECE OF EVIDENCE ─────────────────────────────
     Loaded for ALL sources, not only those missing a canonical field. An
     earlier cut skipped the legacy lookups whenever `sampleStyleId` was
     present, so a source carrying canonical A AND a reverse or request-line
     reference to B looked undisputed — the contradiction was never read.

     A canonical field is stronger PROVENANCE; it is not permission to stop
     looking. Read, never written: no source is backfilled by being resolved. */
  const namingByOrder = new Map();
  let requestById = new Map();

  const naming = await SampleStyle()
    .find({ "production.workOrderIds": { $in: sources.map((w) => w._id) } })
    .select("_id production.workOrderIds").lean();
  for (const style of naming) {
    for (const orderId of new Set((style.production?.workOrderIds || []).map(str))) {
      if (!namingByOrder.has(orderId)) namingByOrder.set(orderId, []);
      namingByOrder.get(orderId).push(str(style._id));
    }
  }
  const requestIds = [...new Set(sources.map((w) => str(w.customerRequestId)).filter(isId))];
  if (requestIds.length) {
    const requests = await CustomerRequest()
      .find({ _id: { $in: requestIds.map((id) => new mongoose.Types.ObjectId(id)) } })
      .select("_id sampleStyleId items.stockItemId items.sampleStyleId").lean();
    requestById = new Map(requests.map((r) => [str(r._id), r]));
  }

  /* Ownership for every style any source's decision touches — the accepted
     rule, so a derivative cannot be created on evidence the read boundary
     would refuse. */
  const candidateStyleIds = new Set();
  for (const source of sources) {
    if (str(source.sampleStyleId)) candidateStyleIds.add(str(source.sampleStyleId));
    for (const id of namingByOrder.get(str(source._id)) || []) candidateStyleIds.add(id);
    const decision = orderStyleLink.resolveOrderLine(
      source, requestById.get(str(source.customerRequestId)) || null,
    );
    for (const id of decision.styleIds || []) candidateStyleIds.add(id);
  }
  const owners = await styleOwnersFor([...candidateStyleIds]);
  const ownerOf = (id) => owners.get(str(id)) || null;

  const resolved = new Set();
  for (const source of sources) {
    const name = str(source.workOrderNumber) || "an original work order";
    const decision = orderStyleLink.resolveOrderStyleLink({
      order: source,
      request: requestById.get(str(source.customerRequestId)) || null,
      directStyleIds: namingByOrder.get(str(source._id)) || [],
      canonicalStyleId: source.sampleStyleId || null,
      ownerOf,
    });

    /* Exactly one attached style, ONE_COMPANY attribution, no conflict, no
       ambiguity, no unprovable candidate. Anything else refuses.

       ── AN AMBIGUOUS LINE REFUSES EVEN WHEN THE DIRECT REFERENCE RESOLVES ──
       The accepted READ boundary attaches a direct reference beside an
       ambiguous request line — order-specific proof, with the ambiguity
       reported next to it — and that behaviour is deliberately untouched.
       CREATION is a different question. A derivative built on a source whose
       own request lines cannot say which style it makes would carry that
       uncertainty forward as a fact, permanently, into a record nobody will
       re-examine. So `lineResolution === AMBIGUOUS` refuses here regardless of
       what the direct reference says: reading an uncertain record is fine,
       minting a new one from it is not. */
    if (decision.attribution !== orderStyleLink.COMPANY_ATTRIBUTION.ONE_COMPANY
      || decision.disputed
      || decision.lineResolution === orderStyleLink.LINE_RESOLUTION.AMBIGUOUS
      || decision.unprovableStyleIds.length
      || decision.attachedStyleIds.length !== 1) {
      const ambiguous = decision.disputed
        || decision.lineResolution === orderStyleLink.LINE_RESOLUTION.AMBIGUOUS
        || decision.attribution === orderStyleLink.COMPANY_ATTRIBUTION.MULTIPLE_COMPANIES;
      throw fail(
        ambiguous ? CODES.AMBIGUOUS : CODES.REQUIRED,
        decision.disputed
          ? `${label} cannot be created: ${name} has stored style references that disagree, so the `
            + `style to make cannot be proved. Reconcile the original order's references first.`
          : ambiguous
            ? `${label} cannot be created: the style ${name} makes cannot be read unambiguously from `
              + `what is stored. Reconcile the original order's references first.`
            : `${label} cannot be created: ${name} carries no provable style link. Link the original `
              + `order's style before raising this one.`);
    }
    if (expectedCompanyId && decision.companyId !== str(expectedCompanyId)) {
      throw fail(CODES.COMPANY_MISMATCH,
        `${label} cannot be created: the original work order belongs to a different company from `
        + `the one you are working in.`);
    }
    resolved.add(decision.attachedStyleIds[0]);
  }

  if (resolved.size !== 1) {
    throw fail(CODES.AMBIGUOUS,
      `${label} cannot be created: the original work orders it is raised from make `
      + `${resolved.size} different styles. Raise one per style.`);
  }
  return [...resolved][0];
}

/**
 * Prove that a resolved style exists, is owned, and is this company's.
 *
 * Reads only `_id`, the two parent references and the lifecycle fields the
 * shared rule needs; the parents are read for `companyId` alone. Nothing about
 * a Sales parent, a customer or a price is returned or logged.
 *
 * @param {string[]} styleIds  every style the pending creation depends on
 * @param {object} [opts]
 * @param {string|null} [opts.expectedCompanyId]  the acting company, when the
 *   calling workflow has one. The legacy Sales release path has no company
 *   context at all today (see the Chunk 1D notes), so it passes none and gets
 *   the single-company check below instead of a match against a known company.
 * @returns {Promise<{companyId: string, byStyle: Map<string,string>}>}
 */
async function styleOwnersFor(styleIds) {
  const wanted = [...new Set((styleIds || []).map(str).filter(isId))];
  if (!wanted.length) return new Map();
  const styles = await SampleStyle()
    .find({ _id: { $in: wanted.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("_id journeyId enquiryId isActive status").lean();
  const journeyIds = [...new Set(styles.map((x) => str(x.journeyId)).filter(isId))];
  const enquiryIds = [...new Set(styles.map((x) => str(x.enquiryId)).filter(isId))];
  const [journeys, enquiries] = await Promise.all([
    journeyIds.length
      ? SalesJourney().find({ _id: { $in: journeyIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id companyId").lean() : [],
    enquiryIds.length
      ? Enquiry().find({ _id: { $in: enquiryIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id companyId").lean() : [],
  ]);
  const jc = new Map(journeys.map((j) => [str(j._id), str(j.companyId)]));
  const ec = new Map(enquiries.map((e) => [str(e._id), str(e.companyId)]));
  const out = new Map();
  for (const style of styles) {
    const { companyId } = styleOwnerFrom(style, {
      journeyCompanyOf: (id) => jc.get(id) || null,
      enquiryCompanyOf: (id) => ec.get(id) || null,
    }, OWNERSHIP_MODE);
    out.set(str(style._id), companyId || null);
  }
  return out;
}

/* ═══ THE ACTING COMPANY, AND THE TYPED REFUSAL ════════════════════════════ */

/**
 * The company this actor may release production for.
 *
 * ── WHY THIS IS NOT OPTIONAL ANY MORE ───────────────────────────────────────
 * Proving that every style in a release belongs to ONE company says nothing
 * about whether the person pressing the button may act for that company. The
 * Sales release routes had no company context at all, so a signed-in employee
 * could release another company's order and the styles would all agree.
 *
 * It uses the SHARED membership service — the same one the IE boundary, Store
 * and Central Costing use — so there is one answer to "which company is this
 * person in" and one place it can be changed. The header only SELECTS among
 * memberships the actor already holds; it is never authority on its own, and a
 * multi-company actor who names none is refused rather than defaulted.
 */
async function resolveActingCompany(req, domainLabel = "production release") {
  const requestedCompanyId = (typeof req?.get === "function" ? req.get("X-Costing-Company") : null)
    || req?.headers?.["x-costing-company"]
    || req?.query?.actingCompanyId
    || req?.body?.actingCompanyId
    || null;
  const { companyId } = await resolveCompanyForActor(req?.user, {
    requestedCompanyId, domainLabel, fail,
  });
  return str(companyId);
}

/**
 * Send a typed refusal with its registered status and code.
 *
 * Without this the linkage errors reached the caller as a generic 500 and an
 * operator was told "server error" for a request line they could have fixed in
 * a minute. Anything that is NOT one of ours is still a 500 with no detail —
 * an unexpected fault must not start leaking internals through this door.
 */
function sendTypedError(res, err, fallbackMessage) {
  if (err && err.name === "StorePurchaseError") return sendError(res, err);
  console.error(`[workOrderStyleLink] ${fallbackMessage}:`, err);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

async function assertStylesUsable(styleIds, { expectedCompanyId = null } = {}) {
  const wanted = [...new Set((styleIds || []).map(str).filter(Boolean))];
  if (!wanted.length) {
    throw fail(CODES.REQUIRED, "No approved style could be proved for this production release.");
  }
  const malformed = wanted.filter((id) => !isId(id));
  if (malformed.length) {
    throw fail(CODES.NOT_FOUND,
      "This order cannot be released for production: a customer-request line names a style "
      + "reference that is not a valid record. Correct the line in Sales.",
      { styles: malformed.length });
  }

  const styles = await SampleStyle().find({ _id: { $in: wanted.map((id) => new mongoose.Types.ObjectId(id)) } })
    .select("_id journeyId enquiryId isActive status")
    .lean();
  const byId = new Map(styles.map((s) => [str(s._id), s]));

  const missing = wanted.filter((id) => !byId.has(id));
  if (missing.length) {
    throw fail(CODES.NOT_FOUND,
      "This order cannot be released for production: a customer-request line names a style that no "
      + "longer exists. Re-link the line to a live style in Sales.",
      { styles: missing.length });
  }

  const journeyIds = [...new Set(styles.map((s) => str(s.journeyId)).filter(isId))];
  const enquiryIds = [...new Set(styles.map((s) => str(s.enquiryId)).filter(isId))];
  const [journeys, enquiries] = await Promise.all([
    journeyIds.length
      ? SalesJourney().find({ _id: { $in: journeyIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id companyId").lean()
      : [],
    enquiryIds.length
      ? Enquiry().find({ _id: { $in: enquiryIds.map((id) => new mongoose.Types.ObjectId(id)) } })
        .select("_id companyId").lean()
      : [],
  ]);
  const journeyCompany = new Map(journeys.map((j) => [str(j._id), str(j.companyId)]));
  const enquiryCompany = new Map(enquiries.map((e) => [str(e._id), str(e.companyId)]));

  const byStyle = new Map();
  const companies = new Set();
  const unprovable = [];
  for (const id of wanted) {
    const { companyId } = styleOwnerFrom(byId.get(id), {
      journeyCompanyOf: (j) => journeyCompany.get(j) || null,
      enquiryCompanyOf: (e) => enquiryCompany.get(e) || null,
    }, OWNERSHIP_MODE);
    if (!companyId) { unprovable.push(id); continue; }
    byStyle.set(id, companyId);
    companies.add(companyId);
  }

  if (unprovable.length) {
    throw fail(CODES.OWNERSHIP_UNPROVEN,
      "This order cannot be released for production: the company that owns its style cannot be "
      + "proved. The style's sales journey is missing, or carries no company. Correct the style's "
      + "sales record before releasing.",
      { styles: unprovable.length });
  }

  /* ── ONE COMPANY PER RELEASE ────────────────────────────────────────────
     Work orders raised together must belong to one company. Two would mean a
     single release action produced another company's production order, which
     no downstream boundary could then untangle. */
  if (companies.size > 1) {
    throw fail(CODES.COMPANY_MISMATCH,
      "This order cannot be released for production: its lines name styles belonging to different "
      + "companies. One release produces one company's work orders. Split the order in Sales.",
      { companies: companies.size });
  }

  const companyId = [...companies][0];
  if (expectedCompanyId && str(expectedCompanyId) !== companyId) {
    throw fail(CODES.COMPANY_MISMATCH,
      "This order cannot be released for production: its style belongs to a different company from "
      + "the one you are working in.");
  }

  return { companyId, byStyle };
}

/**
 * The pre-flight every creation path runs BEFORE its first write.
 *
 * ── WHY A PRE-FLIGHT AND NOT A CHECK PER ORDER ──────────────────────────────
 * The Sales release loop creates work orders one at a time and the deployment
 * gives it no transaction. Validating inside that loop would leave the first
 * two orders saved and the third refused — a half-released order nobody can
 * reason about, which is exactly what "all or nothing" exists to prevent.
 *
 * So the whole batch is resolved and proved first. If any line cannot prove its
 * style, this throws before a single record is written: no work order, no
 * progress row, no reverse link, no notification.
 *
 * @param {object[]} units  `{ stockItemId, label }` — one per work order to be
 *   created, in creation order
 * @returns {Promise<Map<string,string>>} product id → proved style id
 */
async function preflightRequestLines(request, units, { expectedCompanyId = null } = {}) {
  const byProduct = new Map();
  for (const unit of units) {
    const key = str(unit?.stockItemId);
    if (byProduct.has(key)) continue;
    byProduct.set(key, styleFromRequestLine(request, key, { label: unit?.label }));
  }
  await assertStylesUsable([...byProduct.values()], { expectedCompanyId });
  return byProduct;
}

module.exports = {
  CODES, OWNERSHIP_MODE,
  styleOwnersFor, resolveActingCompany, sendTypedError, styleForDerivative,
  /* Re-exported so a caller raising its own typed refusal uses the same
     factory and the same codes rather than inventing a parallel shape. */
  errors: { fail },
  styleFromRequestLine, styleFromSourceWorkOrder, assertStylesUsable, preflightRequestLines,
};
