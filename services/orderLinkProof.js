// services/orderLinkProof.js
//
// THE ONE RULE FOR "IS THIS ENQUIRY'S STORED ORDER LINK THE EXACT ORDER?"
//
// Two questions, answered in this order, and every consumer asks both:
//
//   1. OWNERSHIP — does the stored order belong to the caller's company?
//      (`proveOrderOwnership`, unchanged from G03.) CustomerRequest carries no
//      company, so this is proved through the order's origin, or through the
//      portal customer that only this company's account links.
//
//   2. EXACTNESS — is it THIS DEAL'S order, rather than merely one of this
//      customer's orders? (`classifyStoredLink`, G02.) Ownership alone let a
//      link written by the old "newest order for this customer" guess, or by a
//      name match, pass as if it were proof: any order of the right customer
//      qualified. Exact means either
//        • sales_origin — raised from this enquiry, and still the current head
//          of its supersession chain; or
//        • manual — an authorised salesperson confirmed THIS order id for this
//          enquiry (Enquiry.orderLink), and no order has been raised from the
//          enquiry since that would contradict it.
//
// The closing verdict, the closing screen, the buyer brief, the order-link
// resolver and the post-PO Sales screens all use this file, so none of them can
// disagree about which order a deal is.
//
// No writes, no name matching, no recency.

const Account = require("../models/CMS_Models/Sales/Account");
const CustomerRequest = require("../models/Customer_Models/CustomerRequest");

const DEAD_STATUSES = ["cancelled"];

/* Always read, whatever the caller adds: the fields exactness depends on. */
const PROOF_FIELDS = "requestId customerId status salesOrigin.enquiryId salesOrigin.supersedesRequestId";

/* One wording for every OWNERSHIP failure — missing, foreign, from another
   enquiry, or ambiguous between companies. Varying it would let a caller
   probe which of those is true. */
const UNPROVED = "The linked customer order cannot be proved to belong to this company. "
  + "An order raised from this enquiry's Cost & Invoicing carries that proof.";

/* One wording for every EXACTNESS failure. The order is this company's, so
   saying that much discloses nothing; what is missing is the confirmation. */
const UNCONFIRMED = "The linked customer order has not been confirmed as this deal's order. "
  + "Confirm it on the journey's order link, or raise the proforma from this enquiry.";

const NOT_LINKED = "This enquiry is not linked to a customer order, so there is nothing to close.";

const str = (v) => (v == null ? "" : String(v));
const sameId = (a, b) => Boolean(a) && Boolean(b) && str(a) === str(b);

/**
 * THE HEAD of each supersession chain among requests raised from one enquiry:
 * not cancelled, and not superseded by another of them. Pure.
 */
function originHeads(originRequests = []) {
  const superseded = new Set(originRequests
    .map((r) => str(r.salesOrigin?.supersedesRequestId))
    .filter(Boolean));
  return originRequests.filter((r) => !superseded.has(str(r._id)) && !DEAD_STATUSES.includes(r.status));
}

const originRequestsFor = (enquiryId, fields = "") => CustomerRequest
  .find({ "salesOrigin.enquiryId": enquiryId })
  .select(`${PROOF_FIELDS} createdAt ${fields}`.trim())
  .lean();

/**
 * Ownership only. Read-only: never resolves a link by name, never writes one.
 *
 * @param {object} p
 * @param {object} p.enquiry  a company-scoped Enquiry (needs _id, customerRequestId, accountId)
 * @param {(selector:object) => object|Promise<object>} p.scope  folds the CALLER's company clause
 * @param {string} [p.fields]  extra CustomerRequest fields the caller needs on `request`
 * @returns {Promise<{ok:true, request:object, basis:"origin"|"customer"} | {ok:false, code:string, message:string}>}
 */
async function proveOrderOwnership({ enquiry, scope, fields = "" }) {
  const fail = (code, message) => ({ ok: false, code, message });
  if (typeof scope !== "function") throw new Error("proveOrderOwnership needs the caller's company scope");

  const requestId = enquiry?.customerRequestId;
  if (!requestId) return fail("not_linked", NOT_LINKED);

  const request = await CustomerRequest.findById(requestId).select(`${PROOF_FIELDS} ${fields}`.trim()).lean();
  if (!request) return fail("unproved_link", UNPROVED);

  /* ORIGIN. Decisive either way: a request raised from another enquiry is not
     this enquiry's order, whatever its customer. */
  const originEnquiryId = request.salesOrigin?.enquiryId;
  if (originEnquiryId) {
    return sameId(originEnquiryId, enquiry._id)
      ? { ok: true, request, basis: "origin" }
      : fail("unproved_link", UNPROVED);
  }

  /* CUSTOMER, and only when no other company can claim the same customer. */
  if (!enquiry.accountId) return fail("unproved_link", UNPROVED);
  /* The caller's company clause, resolved once and folded into both reads. */
  const clause = await scope({});
  const account = await Account.findOne({ $and: [clause, { _id: enquiry.accountId }] })
    .select("linkedCustomer").lean();
  if (!account?.linkedCustomer || !sameId(request.customerId, account.linkedCustomer)) {
    return fail("unproved_link", UNPROVED);
  }
  /* Deliberately OUTSIDE the caller's company, existence only. */
  const claimedElsewhere = await Account.exists({ linkedCustomer: account.linkedCustomer, $nor: [clause] });
  if (claimedElsewhere) return fail("unproved_link", UNPROVED);

  return { ok: true, request, basis: "customer" };
}

/**
 * EXACTNESS of an owned stored link. Pure: every fact is passed in.
 *
 * @param {object} p
 * @param {object} p.enquiry           needs _id and orderLink
 * @param {object} p.request           the stored order (needs _id, status)
 * @param {"origin"|"customer"} p.basis from proveOrderOwnership
 * @param {object[]} p.origin           every request raised from this enquiry
 * @param {boolean} p.supersededElsewhere  some request names this one as superseded
 * @returns {{exact:true, method:"sales_origin"|"manual"} | {exact:false, reason:"stale"|"ambiguous"|"conflict"|"unconfirmed"}}
 */
function classifyStoredLink({ enquiry, request, basis, origin = [], supersededElsewhere = false }) {
  if (DEAD_STATUSES.includes(request.status) || supersededElsewhere
    || origin.some((r) => sameId(r.salesOrigin?.supersedesRequestId, request._id))) {
    return { exact: false, reason: "stale" };
  }
  const heads = originHeads(origin);
  /* A person settled THIS id: the choice is recorded against this very id. */
  const personConfirmed = sameId(enquiry.orderLink?.customerRequestId, request._id)
    && Boolean(enquiry.orderLink?.confirmedBy?.id || enquiry.orderLink?.confirmedBy?.name);

  if (basis === "origin") {
    return heads.length > 1 && !personConfirmed
      ? { exact: false, reason: "ambiguous" }
      : { exact: true, method: "sales_origin" };
  }
  /* Customer chain: one of this company's customer's orders, not raised from
     this enquiry. Never the deal when an order WAS raised from this enquiry,
     and otherwise only when a person said so. */
  if (heads.length) return { exact: false, reason: "conflict" };
  if (personConfirmed && enquiry.orderLink?.method === "manual") return { exact: true, method: "manual" };
  return { exact: false, reason: "unconfirmed" };
}

/**
 * Ownership AND exactness — what every reader that ACTS on a link must use.
 *
 * @returns {Promise<{ok:true, request:object, basis:"sales_origin"|"manual"}
 *                  | {ok:false, code:"not_linked"|"unproved_link"|"unverified_link", message:string, reason?:string}>}
 */
async function proveExactOrderLink({ enquiry, scope, fields = "" }) {
  const owned = await proveOrderOwnership({ enquiry, scope, fields });
  if (!owned.ok) return owned;
  const [origin, supersededElsewhere] = await Promise.all([
    originRequestsFor(enquiry._id),
    CustomerRequest.exists({ "salesOrigin.supersedesRequestId": owned.request._id }),
  ]);
  const c = classifyStoredLink({
    enquiry, request: owned.request, basis: owned.basis, origin, supersededElsewhere: Boolean(supersededElsewhere),
  });
  if (!c.exact) return { ok: false, code: "unverified_link", message: UNCONFIRMED, reason: c.reason };
  return { ok: true, request: owned.request, basis: c.method };
}

module.exports = {
  DEAD_STATUSES,
  UNPROVED,
  UNCONFIRMED,
  NOT_LINKED,
  originHeads,
  originRequestsFor,
  proveOrderOwnership,
  classifyStoredLink,
  proveExactOrderLink,
};
