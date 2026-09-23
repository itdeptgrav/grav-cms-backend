// services/closingVerdict.js
//
// The server-side answer to "may this order be closed?".
//
// The closing checks were computed properly (services/closingReport.js) and
// shown properly (the Order Closing screen disables its button on unmet checks)
// — but the CLOSE ITSELF never consulted them. A disabled button is not a
// control: anything calling POST /sales-journeys/:id/stage directly closed the
// order with money outstanding and pieces undelivered. This is what the stage
// route hands the planner so the refusal happens where it cannot be bypassed.
//
// ── IT FAILS CLOSED (G03) ──────────────────────────────────────────────────
//
// This used to return `null` whenever it could not reach a verdict — no
// enquiry, no stored order link, no work order, a report without a boolean, or
// ANY thrown error — and the planner read `null` as "no financial objection
// known" and closed the order. So every way of breaking this function was a way
// of closing an order: a direct API call on a journey whose enquiry had never
// been linked closed it, and so did a database hiccup.
//
// It now ALWAYS returns a verdict. When it cannot prove the order may close, it
// says `canClose: false` and names what is missing. There is no null and no
// "unknown means yes". An order that genuinely has no work order cannot be
// closed here either — closing it means certifying delivery and payment, and
// there is nothing to certify them against.
//
// ── OWNERSHIP IS PROVED, NOT ASSUMED ──────────────────────────────────────
//
// CustomerRequest, WorkOrder and DispatchChallan carry no company of their own,
// so the verdict cannot scope them the way it scopes the enquiry. Two chains
// can be verified, and they are tried in this order:
//
//   1. ORIGIN — the authoritative one. A request raised from Cost & Invoicing
//      carries `salesOrigin.enquiryId`, stamped server-side from an enquiry
//      read under the caller's company (services/sales/proformaRequest.service)
//      and never accepted from a request body. If it names THIS enquiry, the
//      request is this company's. If it names any other enquiry, it is not.
//
//   2. CUSTOMER — for a request with no origin (portal, measurement, older
//      records). The request's customer must be the portal customer this
//      company's account is linked to, AND no account outside this company may
//      be linked to that same customer. A portal customer is not owned by a
//      company, so when two companies' accounts both link it, "same customer"
//      says nothing about whose order this is — that is refused, not guessed.
//
// And ownership is not the end of it (G02): the order must be this deal's
// EXACT order — raised from this enquiry and still current, or confirmed for
// this enquiry by a salesperson. A link that is merely "one of this
// customer's orders", as the old recency and name guesses wrote, is refused as
// unverified. services/orderLinkProof.js holds the rule.
//
// WorkOrders and challans are then proved TRANSITIVELY: they hang off a request
// that has itself been proved. Every broken chain gets the SAME refusal, so the
// caller cannot learn whether the request exists, whose it is, or that another
// company knows the customer.
//
// WHY NOT REUSE THE ENQUIRY ROUTE'S VERSION
//
// routes/.../enquiries.js has GET /:id/closing-report. It used to resolve the
// CustomerRequest by fuzzy customer-name match and WRITE the result back. A
// permission gate must not mutate anything, so this reads the stored link only
// — and the display route now uses `proveOrderLink` below too, so the screen
// and the gate always agree on which order they are talking about.

const Enquiry = require("../models/CMS_Models/Sales/Enquiry");
const { serviceFilter, assertServiceContext } = require("./companyContext/serviceScope.service");
const WorkOrder = require("../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const DispatchChallan = require("../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");
const { buildClosingReport } = require("./closingReport");
const { proveExactOrderLink } = require("./orderLinkProof");

/* The fields both closing routes read. One list, so the gate and the screen
   are always assembled from the same facts. */
const WORK_ORDER_FIELDS = "workOrderNumber stockItemName stockItemReference variantAttributes quantity assignedDeadline "
  + "dispatchedQuantity estimatedCost actualCost rawMaterials.quantityIssued rawMaterials.unitCost "
  + "productionCompletion.operationCompletion productionCompletion.timeMetrics "
  + "productionCompletion.invalidScansCount";
const CHALLAN_FIELDS = "challanNumber dispatchType totalUnits totalPersons createdAt "
  + "persons.employeeName persons.department persons.totalUnits";
const REQUEST_FIELDS = "requestId customerId grandTotal paymentSchedule quotations.grandTotal salesOrigin.enquiryId";

/**
 * A refusal the planner turns into the close error. `code` is stable for
 * callers and tests; `message` is what the salesperson reads, and it names the
 * gap without describing the order behind a link that failed proof.
 */
const refusal = (code, message) => ({
  canClose: false,
  available: false,
  code,
  message,
  blockers: 1,
  checklistCount: 0,
  blocking: [{ id: code, status: "unavailable", label: message }],
});

/**
 * Prove that an enquiry's stored order link is THIS DEAL'S EXACT ORDER and
 * belongs to the caller's company. Read-only: never resolves a link by name,
 * never writes one.
 *
 * ── OWNERSHIP IS NOT ENOUGH (G02) ─────────────────────────────────────────
 * This used to stop at ownership: a link was accepted when the request's
 * customer was this company's account's customer. Any order of that customer
 * passed — including the one the old "newest order for this customer" guess,
 * or a name match, happened to write. It now also requires the link to be
 * exact (services/orderLinkProof.js): raised from this enquiry and still
 * current, or confirmed for this enquiry by a salesperson. The closing gate,
 * the closing screen and the buyer brief all come through here.
 *
 * @param {object} p
 * @param {object} p.enquiry  a company-scoped Enquiry (needs _id, customerRequestId, accountId, orderLink)
 * @param {(selector:object) => object|Promise<object>} p.scope
 *   folds the CALLER's company clause into a selector; `scope({})` is the bare
 *   clause. Both closing routes pass their own already-authorised scope.
 * @returns {Promise<{ok:true, request:object, basis:"sales_origin"|"manual"}
 *                  | {ok:false, code:"not_linked"|"unproved_link"|"unverified_link", message:string}>}
 */
function proveOrderLink({ enquiry, scope, fields = REQUEST_FIELDS }) {
  return proveExactOrderLink({ enquiry, scope, fields });
}

/**
 * Read the closing facts for a PROVED order.
 * @returns {Promise<{workOrders:object[], challans:object[]}>}
 */
async function closingFactsFor(requestId) {
  const [workOrders, challans] = await Promise.all([
    WorkOrder.find({ customerRequestId: requestId }).select(WORK_ORDER_FIELDS).lean(),
    DispatchChallan.find({ manufacturingOrderId: requestId }).select(CHALLAN_FIELDS).lean(),
  ]);
  return { workOrders, challans };
}

/**
 * @param {ObjectId|string} journeyId  the SalesJourney _id
 * @param {object} ctx                 the caller's company service context
 * @returns {Promise<{canClose:boolean, available:boolean, code?:string, message?:string,
 *                    blockers:number, checklistCount:number, blocking:object[]}>}
 *          Never null.
 */
async function closingVerdictForJourney(journeyId, ctx) {
  try {
    assertServiceContext(ctx, "closing verdict");
    /* ── SCOPED, AND THE CONTEXT IS THE CALLER'S ──────────────────────────
       This used to read the enquiry for a journey id with no company at all,
       so a stage transition in company A could inspect company B's
       order-closing state — payment status, delivery status, the lot. The
       company comes from the already-authorised operation that called this,
       never from the journey or enquiry being examined. */
    const enquiry = await Enquiry.findOne(serviceFilter(ctx, { journeyId, isActive: true }));
    if (!enquiry) {
      return refusal("no_enquiry", "This order has no active enquiry, so its closing checks cannot be run.");
    }

    const proof = await proveOrderLink({ enquiry, scope: (selector) => serviceFilter(ctx, selector) });
    if (!proof.ok) return refusal(proof.code, proof.message);

    const { workOrders, challans } = await closingFactsFor(enquiry.customerRequestId);
    if (!workOrders.length) {
      return refusal("no_work_order",
        "No work order was raised against this order, so delivery cannot be confirmed.");
    }

    const report = buildClosingReport({
      workOrders, challans, request: proof.request, enquiry: enquiry.toObject(),
    });
    if (!report || typeof report.canClose !== "boolean") {
      return refusal("no_verdict", "The closing checks could not be completed for this order.");
    }

    const unmet = (report.checklist || []).filter((c) => !c.done);
    return {
      canClose: report.canClose,
      available: true,
      blockers: Number(report.blockers) || 0,
      checklistCount: Array.isArray(report.checklist) ? report.checklist.length : 0,
      /* What is in the way, named — so the refusal can say which evidence is
         missing rather than only how many checks failed. */
      blocking: unmet.map((c) => ({ id: c.id, status: c.status || "unmet", label: c.label })),
    };
  } catch (err) {
    /* A failure to CHECK is not permission to close. This used to return null
       here, which the planner read as a pass — so a database outage closed
       orders. Logged for whoever investigates; the caller is told plainly that
       nothing could be checked, and nothing about why beyond that. */
    console.error(`[closingVerdict] failed for journey ${journeyId}:`, err.message);
    return refusal("check_failed", "The closing checks could not be checked right now. Try again shortly.");
  }
}

module.exports = {
  closingVerdictForJourney,
  proveOrderLink,
  closingFactsFor,
  WORK_ORDER_FIELDS,
  CHALLAN_FIELDS,
  REQUEST_FIELDS,
};
