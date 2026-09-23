// services/industrialEngineering/ieOrderAudit.js
//
// IE CHUNK 1C — CLASSIFY ONE WORK ORDER AGAINST THE ACCEPTED CHUNK 1B RULES.
//
// ── WHY THIS IS PURE, AND SEPARATE FROM THE SCRIPT ─────────────────────────
// The question Chunk 1C has to answer is "can the real data support an
// order-wise landing page", and the honest way to answer it is to run the SAME
// rules the endpoint runs and count what they say. A classifier written for the
// audit alone would be a second opinion, and a second opinion that disagreed
// with the endpoint would be worse than no audit — it would report a page as
// displayable that the endpoint refuses.
//
// So the decision is not reimplemented here. `resolveOrderStyleLink` — the
// same function the Orders endpoint calls — resolves both references together,
// decides the company from every style either of them reaches, and applies the
// attach rule. This file adds only the data-quality flags a reviewer needs.
//
// ── AND WHY IT TAKES ALREADY-LOADED RECORDS ────────────────────────────────
// Nothing here touches a database. It is handed the work order, its customer
// request, the styles that name it and a company lookup, and returns a
// classification. That is what makes every branch testable as arithmetic
// against synthetic fixtures rather than against whatever the live database
// happens to hold this week.
"use strict";

const orderStyleLink = require("./orderStyleLink");

const str = (v) => String(v ?? "").trim();

/* ── THE VOCABULARY IS THE ENDPOINT'S ────────────────────────────────────────
 * `COMPANY_ATTRIBUTION` and `STYLE_LINK_STATUS` were declared here AND in the
 * orders service, which is how the endpoint came to admit a conflicting order
 * this classifier counted as clean. They now live in `orderStyleLink.js` and
 * both callers read them from there.
 *
 * Attribution uses ONLY SampleStyle ownership under the accepted rules. It
 * never reads a customer, a creator, a product name or any text — those are the
 * inferences the whole boundary exists to refuse, and an audit that used them
 * would report a coverage the endpoint cannot deliver. */
const { COMPANY_ATTRIBUTION, STYLE_LINK_STATUS } = orderStyleLink;

/* Work-order status classification is the shared `orderStatus` module — the
   same lists the endpoint uses to decide whether an order is still open, which
   is what a lifecycle warning turns on. */
const {
  STATUS_CLASS, OPERATIONAL_STATUSES, COMPLETED_STATUSES, CANCELLED_STATUSES, statusClassOf,
} = require("./orderStatus");

function classifyOrder({
  order, request = null, directStyleIds = [], companyOf = () => null, knownStyleIds = null,
} = {}) {
  const flags = [];

  /* ── THE DECISION IS THE ENDPOINT'S, NOT A SECOND OPINION ──────────────
     Both references resolved together, the company decided from every style
     either of them reaches, and the attach rule applied — all by the shared
     `resolveOrderStyleLink`. This file adds the audit's own data-quality
     flags and nothing else. */
  const decision = orderStyleLink.resolveOrderStyleLink({
    order, request, directStyleIds,
    /* IE Chunk 1D. Read off the order, exactly as the endpoint reads it. */
    canonicalStyleId: order?.sampleStyleId || null,
    ownerOf: companyOf,
  });

  /* ── DATA-QUALITY FLAGS ─────────────────────────────────────────────── */
  if (!str(order?.workOrderNumber)) flags.push("MISSING_WORK_ORDER_NUMBER");
  if (!str(order?.stockItemId)) flags.push("MISSING_STOCK_ITEM");
  if (!str(order?.customerRequestId)) flags.push("NO_CUSTOMER_REQUEST_REFERENCE");
  else if (!request) flags.push("MISSING_CUSTOMER_REQUEST");

  if (request) {
    const items = Array.isArray(request.items) ? request.items : [];
    const matching = items.filter((i) => str(i?.stockItemId) === str(order?.stockItemId));
    if (!matching.length) flags.push("NO_REQUEST_LINE_MATCHING_PRODUCT");
    else if (matching.some((i) => !str(i?.sampleStyleId))) flags.push("REQUEST_LINE_MISSING_STYLE_ID");
    if (matching.length > 1) flags.push("SHARED_PRODUCT_REQUEST_LINES");
  }

  /* A reference to a style that is not in the collection at all — a dangling
     id, which is a different fault from one whose company cannot be proved. */
  if (knownStyleIds) {
    const missing = decision.decisionStyleIds.filter((id) => !knownStyleIds.has(id));
    if (missing.length) flags.push("REFERENCED_STYLE_MISSING");
  }
  if (decision.unprovableStyleIds.length) flags.push("STYLE_OWNERSHIP_UNPROVABLE");
  if (decision.linkStatus === STYLE_LINK_STATUS.REFERENCES_CONFLICT) {
    flags.push("DIRECT_AND_LINE_REFERENCES_CONFLICT");
  }

  const visible = decision.attribution === COMPANY_ATTRIBUTION.ONE_COMPANY;

  return {
    orderId: str(order?._id),
    reference: str(order?.workOrderNumber),
    statusClass: statusClassOf(order),
    status: str(order?.status),
    companyAttribution: decision.attribution,
    styleLinkStatus: decision.linkStatus,
    lineResolution: decision.lineResolution,
    /* Chunk 1D: which of the three stored sources this order actually has. */
    hasCanonicalLink: decision.canonicalStyleIds.length > 0,
    canonicalStyleCount: decision.canonicalStyleIds.length,
    directStyleCount: decision.directStyleIds.length,
    lineStyleCount: decision.lineStyleIds.length,
    /* Exactly what the endpoint would attach — not "how many styles exist",
       which is the number that made the audit disagree with the page. */
    displayableStyles: visible ? decision.attachedStyleIds.length : 0,
    visibleToOneCompany: visible,
    companies: decision.companyIds,
    referencedStyleIds: decision.decisionStyleIds,
    flags: [...new Set(flags)].sort(),
  };
}

module.exports = {
  COMPANY_ATTRIBUTION, STYLE_LINK_STATUS, STATUS_CLASS,
  OPERATIONAL_STATUSES, COMPLETED_STATUSES, CANCELLED_STATUSES,
  statusClassOf, classifyOrder,
};
