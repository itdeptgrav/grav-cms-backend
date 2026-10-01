"use strict";
// services/sales/orderOwnership.service.js
//
// IS THIS CUSTOMER ORDER THIS COMPANY'S?
//
// A CustomerRequest carries no `companyId`. Every Order Book route in
// routes/CMS_Routes/Sales/customerRequests.js used to read or change one by
// `_id` alone — its money, its people, its work orders, its notes, its status —
// so any signed-in employee could open or edit any company's order by id, and
// the list, export and dashboard showed every company's orders to everyone.
//
// ── THE EVIDENCE, IN ORDER — EVERY PIECE AN EXISTING RULE ─────────────────
//
//   0. SOLE COMPANY — the deployment's company master holds exactly one
//      company and it is the actor's (salesScope.service `allowUnowned`).
//      There is nobody else the order could belong to. This is the same
//      allowance every Sales record already gets.
//   1. ORIGIN — `salesOrigin.enquiryId`, stamped server-side when Sales raises
//      the order from an enquiry. The enquiry must be visible under the
//      caller's company. DECISIVE: an order raised from another company's
//      enquiry is refused, whatever else it carries.
//   2. STYLES — each line's `sampleStyleId`, proved through the style's journey
//      or enquiry (integration/styleOwnershipProof.service, the rule the
//      Merchandising handover and the buyer brief use). DECISIVE: every named
//      style must exist and prove THIS company; one that does not refuses the
//      order.
//   3. CUSTOMER — the portal customer on the order is linked by one of this
//      company's CRM accounts (`Account.linkedCustomer`) and by NO account
//      outside it. The same customer chain as services/orderLinkProof.js. A
//      portal customer belongs to no company; when two companies know it,
//      "same customer" proves nothing and the order is refused.
//
// Nothing else counts. Specifically NOT: the customer's name, the newest
// order, an Enquiry that merely points at the order (`customerRequestId` was
// written by guesses — see services/orderBookLink.js), the measurement's
// organisation (a portal customer, not a company), or who created it.
//
// ── ONE REFUSAL ────────────────────────────────────────────────────────────
// Foreign, contested, unattributable and missing all answer the same 404
// "Order not found." — a refusal that varied would tell a caller which order
// ids are real and whose they are.
//
// ── A PROOF FOR ONE ORDER, AND A FILTER FOR MANY ──────────────────────────
// `proveOrderOwned` answers for one order. `ownedOrdersFilter` expresses the
// SAME rule as a Mongo filter for the list, export and dashboard, so a row can
// never appear in a list that its own page would refuse. The two are tested
// against the same fixtures.

const mongoose = require("mongoose");
const { scopeFor } = require("../companyContext/salesScope.service");
const { fail } = require("../storePurchase/errors");
const { ownershipProofFor } = require("../integration/styleOwnershipProof.service");

const CustomerRequest = () => require("../../models/Customer_Models/CustomerRequest");
const Enquiry = () => require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = () => require("../../models/CMS_Models/Sales/SalesJourney");
const Account = () => require("../../models/CMS_Models/Sales/Account");
const SampleStyle = () => require("../../models/CMS_Models/Sales/SampleStyle");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || ""));
const str = (v) => (v == null ? "" : String(v));

/* Always read, whatever a route selects: the fields the proof needs. */
const PROOF_FIELDS = "customerId salesOrigin.enquiryId items.sampleStyleId";

const notFound = () => fail("NOT_FOUND", "Order not found.");

/* A route's inclusion projection plus whatever proof fields it does not
   already cover. `items` covers `items.sampleStyleId`, and asking for both is
   a projection path collision MongoDB refuses. */
function withProofFields(select) {
  const chosen = String(select).split(/\s+/).filter(Boolean);
  const covered = (field) => chosen.some((t) => field === t || field.startsWith(`${t}.`));
  return [...chosen, ...PROOF_FIELDS.split(" ").filter((f) => !covered(f))].join(" ");
}

const styleIdsOf = (request) => [...new Set((request.items || [])
  .map((i) => str(i?.sampleStyleId)).filter(Boolean))];

/** Does the caller's company, and ONLY the caller's company, link this customer? */
async function customerIsExclusivelyOurs(scope, customerId) {
  if (!customerId) return false;
  const ours = await Account().exists({ $and: [scope.clause, { linkedCustomer: customerId }] });
  if (!ours) return false;
  /* Deliberately OUTSIDE the caller's company, existence only. */
  const elsewhere = await Account().exists({ linkedCustomer: customerId, $nor: [scope.clause] });
  return !elsewhere;
}

/**
 * The rule, for one already-read order.
 *
 * @returns {Promise<{owned:true, basis:"sole_company"|"origin"|"style"|"customer"}
 *                  | {owned:false, reason:"origin_not_ours"|"style_not_ours"|"customer_not_exclusive"|"no_evidence"}>}
 *          `reason` is for logs, tests and the legacy audit — never for a response.
 */
async function ownershipOf(scope, request) {
  if (scope.allowUnowned) return { owned: true, basis: "sole_company" };

  const originId = request.salesOrigin?.enquiryId;
  if (originId) {
    const enquiry = await Enquiry().findOne({ $and: [scope.clause, { _id: originId }] }).select("_id").lean();
    return enquiry ? { owned: true, basis: "origin" } : { owned: false, reason: "origin_not_ours" };
  }

  const styleIds = styleIdsOf(request);
  if (styleIds.length) {
    const styles = await SampleStyle().find({ _id: { $in: styleIds } }).select("journeyId enquiryId").lean();
    if (styles.length !== styleIds.length) return { owned: false, reason: "style_not_ours" };
    for (const style of styles) {
      if (!(await ownershipProofFor(style, scope.companyId))) return { owned: false, reason: "style_not_ours" };
    }
    return { owned: true, basis: "style" };
  }

  if (await customerIsExclusivelyOurs(scope, request.customerId)) return { owned: true, basis: "customer" };
  /* Nothing proves it. For the legacy audit only: was the customer at least
     linked somewhere (contested / someone else's), or linked nowhere at all? */
  const linkedAnywhere = request.customerId
    ? await Account().exists({ linkedCustomer: request.customerId })
    : null;
  return { owned: false, reason: linkedAnywhere ? "customer_not_exclusive" : "no_evidence" };
}

/**
 * Read one order, proved to be the caller's company's, or refuse.
 *
 * @param {object} req                 the Express request (auth → company scope)
 * @param {string} requestId           the CustomerRequest _id from the URL
 * @param {object} [opt]
 * @param {string} [opt.select]        fields the route needs; proof fields are added
 * @param {boolean} [opt.lean=true]    false returns a document the route may save
 * @param {(q:any) => any} [opt.query] extra query steps (populate, …)
 * @returns {Promise<{request:object, basis:string}>}
 * @throws NOT_FOUND for missing, foreign, contested and unattributable alike;
 *         the scope's own 401/403/409/503 pass through untouched.
 */
async function proveOrderOwned(req, requestId, { select = "", lean = true, query = null } = {}) {
  const scope = await scopeFor(req);
  if (!isId(requestId)) throw notFound();

  let q = CustomerRequest().findById(requestId);
  if (select) q = q.select(withProofFields(select));
  if (query) q = query(q);
  if (lean) q = q.lean();
  const request = await q;
  if (!request) throw notFound();

  const verdict = await ownershipOf(scope, request);
  if (!verdict.owned) throw notFound();
  return { request, basis: verdict.basis };
}

/**
 * The SAME rule as a filter, for routes that list or count orders.
 *
 * In a sole-company deployment every order is the company's, so the filter is
 * empty. Otherwise an order is listed when:
 *   • it was raised from an enquiry visible to this company; or
 *   • it has no origin, names styles, and EVERY style proves this company; or
 *   • it has no origin, names no style, and its customer is linked by this
 *     company alone.
 *
 * @returns {Promise<object>} a filter to `$and` with the route's own
 */
async function ownedOrdersFilter(req) {
  /* Memoised per request, like the scope it is built from: one request must
     not list against two different answers, and the dashboard asks six times. */
  if (!req.__ownedOrdersFilter) req.__ownedOrdersFilter = buildOwnedOrdersFilter(req);
  return req.__ownedOrdersFilter;
}

async function buildOwnedOrdersFilter(req) {
  const scope = await scopeFor(req);
  if (scope.allowUnowned) return {};

  /* 1. Origin: this company's enquiries. */
  const enquiries = await Enquiry().find({ $and: [scope.clause, {}] }).select("_id enquiryId").lean();
  const enquiryIds = enquiries.map((e) => e._id);

  /* 2. Styles reachable from this company's journeys or enquiries, each then
        put through the exact style rule — a style whose journey belongs to
        another company is refused there even if its enquiry is ours. */
  const journeys = await SalesJourney().find({ $and: [scope.clause, {}] }).select("_id journeyId").lean();
  const journeyKeys = [...journeys.map((j) => j._id), ...journeys.map((j) => j.journeyId).filter(Boolean)];
  const enquiryKeys = [...enquiryIds, ...enquiries.map((e) => e.enquiryId).filter(Boolean)];
  /* Through the driver: the schema types these as ObjectIds, but older and
     imported styles hold the business reference (SJ-…, ENQ-…) — the very case
     styleOwnershipProof's `refQuery` exists for — and a Mongoose cast would
     reject the whole query rather than match them. */
  const candidateStyles = journeyKeys.length || enquiryKeys.length
    ? await SampleStyle().collection
      .find({ $or: [{ journeyId: { $in: journeyKeys } }, { enquiryId: { $in: enquiryKeys } }] })
      .project({ _id: 1, journeyId: 1, enquiryId: 1 })
      .toArray()
    : [];
  const myStyleIds = [];
  for (const style of candidateStyles) {
    if (await ownershipProofFor(style, scope.companyId)) myStyleIds.push(style._id);
  }

  /* 3. Customers this company alone links. */
  const accounts = await Account().find({ $and: [scope.clause, { linkedCustomer: { $ne: null } }] })
    .select("linkedCustomer").lean();
  const exclusiveCustomers = [];
  for (const id of [...new Set(accounts.map((a) => str(a.linkedCustomer)))]) {
    const elsewhere = await Account().exists({ linkedCustomer: id, $nor: [scope.clause] });
    if (!elsewhere) exclusiveCustomers.push(new mongoose.Types.ObjectId(id));
  }

  const namesStyle = { items: { $elemMatch: { sampleStyleId: { $type: "objectId" } } } };
  return {
    $or: [
      { "salesOrigin.enquiryId": { $in: enquiryIds } },
      {
        $and: [
          { "salesOrigin.enquiryId": null },
          namesStyle,
          { items: { $not: { $elemMatch: { sampleStyleId: { $type: "objectId", $nin: myStyleIds } } } } },
        ],
      },
      {
        $and: [
          { "salesOrigin.enquiryId": null },
          { items: { $not: namesStyle.items } },
          { customerId: { $in: exclusiveCustomers } },
        ],
      },
    ],
  };
}

/** Fold the ownership filter into a route's own filter without displacing its `$or`. */
async function withOwnedOrders(req, filter = {}) {
  const owned = await ownedOrdersFilter(req);
  if (!Object.keys(owned).length) return filter;
  return Object.keys(filter).length ? { $and: [owned, filter] } : owned;
}

module.exports = {
  PROOF_FIELDS,
  ownershipOf,
  proveOrderOwned,
  ownedOrdersFilter,
  withOwnedOrders,
};
