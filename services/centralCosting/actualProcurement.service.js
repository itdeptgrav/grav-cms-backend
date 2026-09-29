// services/centralCosting/actualProcurement.service.js
//
// WHAT THE APPROVED COSTING SAID IT WOULD COST, AND WHAT PURCHASING AND
// ACCOUNTING HAVE ACTUALLY RECORDED SINCE.
//
// ── READ-ONLY, IN THE STRONGEST SENSE ───────────────────────────────────────
// It writes nothing anywhere: not a costing version, not a request, not a
// purchase order, not a voucher, not a landed-cost allocation, not stock. It
// reads records other lanes own and reports what they say.
//
// ── AND IT IS NOT THE PRODUCT'S ACTUAL COST ─────────────────────────────────
// This pass sees externally PROCURED cost only. Actual production consumption,
// actual labour, finished output and rejection quantities are not connected,
// so no figure here is a finished-garment unit cost — and the report refuses
// to divide a partial posted amount by the approved output quantity to
// manufacture one. "Actual to date" is the whole claim.
//
// ── EVERY JOIN IS A STORED ID ───────────────────────────────────────────────
//   costing line key    → SpendRequest.items[].costingDemandSource
//   spend request line  → PurchaseOrder.items[].spendLineId
//                       / ServiceOrder.lines[].spendLineId
//   purchase order line → GoodsReceipt.lines[].poItemId
//                       → GoodsReceiptInspection.lines[].poItemId
//   purchase order      → Acc_Voucher.purchaseOrderId (+ items[].poItemId)
//   service order       → Acc_Voucher.serviceOrderId
//   purchase order      → LandedCostAllocation.purchaseOrderId
//
// Never an item name, a supplier name, an amount, an array position, invoice
// text or a nearest quantity. A rename or a coincidence of figures would
// silently attach somebody else's invoice to this costing, and the resulting
// variance would look like a finding.

"use strict";

const mongoose = require("mongoose");

const projection = require("./procurementProjection.service");

/* ── THE REQUESTS DOMAIN'S OWN DOOR ────────────────────────────────────────
   Central Costing does not own `SpendRequest`. It reads what was raised from
   its own approved version through the Requests domain's boundary service,
   which is company-scoped in the query and read-only. */
const costingDemand = require("../requests/costingDemand.service");
const PurchaseOrder = () => require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
/* Read through Store & Purchase's own door, for the same reason as the
   requests above: an actual is not a costing source, and a module that can
   require one could come to read it as one. */
const orderActuals = require("../storePurchase/orderActualsRead.service");
const GoodsReceipt = () => require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = () => require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const LandedCostAllocation = () => require("../../models/CMS_Models/Inventory/Valuation/LandedCostAllocation");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

/* ── ONLY A POSTED VOUCHER IS A FINANCIAL ACTUAL ────────────────────────────
   A draft is somebody's working copy and a pending one is awaiting a decision
   nobody has made. Both are shown — "recorded, not posted" is useful — and
   neither reaches an actual-cost figure. */
const POSTED = "posted";
const RECORDED_NOT_POSTED = Object.freeze(["draft", "pending_approval"]);

/* One state per requirement, reusing the lifecycle words the source records
   already use rather than inventing a parallel vocabulary. */
const STATE = Object.freeze({
  NOT_REQUESTED: "Not requested",
  DRAFT_REQUEST: "Draft request",
  AWAITING_APPROVAL: "Awaiting approval",
  APPROVED_NOT_ORDERED: "Approved, not ordered",
  PARTLY_ORDERED: "Partly ordered",
  AWAITING_RECEIPT: "Ordered, awaiting receipt",
  AWAITING_INSPECTION: "Received, awaiting inspection",
  PARTLY_ACCEPTED: "Partly accepted",
  AWAITING_BILL: "Accepted, awaiting bill",
  BILL_NOT_POSTED: "Bill recorded, awaiting posting",
  POSTED: "Posted actual available",
  RETURNED: "Returned/replaced",
  RECONCILE: "Reconciliation required",
});

/* What a reader should do next, in business words. Never a status enum. */
const NEXT_ACTION = Object.freeze({
  [STATE.NOT_REQUESTED]: "Raise the purchasing request from the projection.",
  [STATE.DRAFT_REQUEST]: "Submit the draft request for approval.",
  [STATE.AWAITING_APPROVAL]: "Waiting for the request to be approved.",
  [STATE.APPROVED_NOT_ORDERED]: "Approved request has not yet been converted into the required supplier orders.",
  [STATE.PARTLY_ORDERED]: "Part of this requirement still has no supplier order.",
  [STATE.AWAITING_RECEIPT]: "Waiting for the supplier to deliver.",
  [STATE.AWAITING_INSPECTION]: "Waiting for inspection.",
  [STATE.PARTLY_ACCEPTED]: "Some of this delivery is still in quarantine or was rejected.",
  [STATE.AWAITING_BILL]: "Waiting for supplier bill.",
  [STATE.BILL_NOT_POSTED]: "Bill recorded but not posted.",
  [STATE.POSTED]: "Posted actual available.",
  [STATE.RETURNED]: "A return or replacement is open against this requirement.",
  [STATE.RECONCILE]: "Source document could not be linked. Reconciliation required.",
});

/* Where a lineage stopped, said precisely rather than as one "no data". */
const GAP = Object.freeze({
  NO_REQUEST: "NO_REQUEST",
  NO_ORDER: "NO_ORDER",
  NO_RECEIPT: "NO_RECEIPT",
  NO_INSPECTION: "NO_INSPECTION",
  NO_BILL: "NO_BILL",
  BILL_NOT_POSTED: "BILL_NOT_POSTED",
  UNLINKED_VOUCHER: "UNLINKED_VOUCHER",
  UNALLOCATED_CHARGE: "UNALLOCATED_CHARGE",
  OPEN_QUARANTINE: "OPEN_QUARANTINE",
  OPEN_RETURN: "OPEN_RETURN",
});

const GAP_TEXT = Object.freeze({
  NO_REQUEST: "No purchasing request has been raised for this requirement.",
  NO_ORDER: "No supplier order has been raised against the approved request.",
  NO_RECEIPT: "Nothing has been received against the supplier order yet.",
  NO_INSPECTION: "Received, but not yet inspected — received is not accepted.",
  NO_BILL: "No supplier bill has been recorded against this order.",
  BILL_NOT_POSTED: "A bill is recorded but has not been posted, so it is not an actual.",
  UNLINKED_VOUCHER: "A posted bill references this order but not this line, so it cannot be attributed.",
  UNALLOCATED_CHARGE: "A landed charge on this order has not been allocated to its lines.",
  OPEN_QUARANTINE: "Quantity is still in quarantine and has not been accepted or rejected.",
  OPEN_RETURN: "A supplier return or replacement is open against this requirement.",
});

/* ── THE NINE FAMILIES, AND WHICH CAN BE MEASURED TODAY ─────────────────────
   An unmeasurable family is NOT ₹0. Zero is a claim that something cost
   nothing; "not connected" is the truth, and the two lead to opposite
   decisions. */
const FAMILY_FEEDBACK = Object.freeze({
  materials: { label: "Materials", connected: true },
  packaging: { label: "Packaging", connected: true },
  services: { label: "Services", connected: true },
  freight: { label: "Freight", connected: true },
  development: { label: "Development/setup", connected: true },
  duty: { label: "Duty and non-recoverable charges", connected: true },
  operations: {
    label: "Operations/labour", connected: false,
    reason: "Actual source not connected — actual labour and production consumption are recorded in production, which is not connected yet.",
  },
  financing: {
    label: "Financing", connected: false,
    reason: "Actual source not connected — financing cost is not attributed to an order.",
  },
  overhead: {
    label: "Overhead", connected: false,
    reason: "Actual source not connected — overhead is an internal allocation, not a purchase.",
  },
});

/* What this report does NOT yet cover, said as a later connection rather than
   as a defect in the actuals it does have. */
const LATER = Object.freeze([
  "Actual material consumption from production",
  "Actual labour and operation cost",
  "Finished output and rejection quantities",
  "Final finished-product unit cost",
  "Realised revenue and gross margin",
]);

const TITLE = "Procurement cost feedback";
const STANDING =
  "This compares the approved procurement estimate with recorded purchasing and "
  + "Accounting actuals. It is not the full finished-product actual cost until "
  + "production consumption, labour and output quantities are also available.";

const present = (v) => v !== null && v !== undefined && v !== ""
  && (typeof v !== "number" || Number.isFinite(v));
const idOf = (v) => (v === null || v === undefined ? null : String(v));
const num = (v) => (present(v) ? Number(v) : 0);
/* Major-unit money to integer minor units, so nothing here compares a float
   against the costing's integers. */
const toMinor = (major) => Math.round(Number(major || 0) * 100);

/**
 * What one requirement's downstream records add up to.
 *
 * ── EACH FIGURE IS A DIFFERENT CLAIM ────────────────────────────────────────
 * Ordered is what somebody committed to buy. Accepted is what inspection
 * agreed to keep — RECEIVED IS NOT ACCEPTED, and quarantined stock is neither.
 * Posted is what Accounting has actually recognised. Collapsing any two of
 * them produces a number that reads as settled and is not.
 */
function measureLine({ requestLine, orderLines, receipts, inspections, vouchers, allocations }) {
  const gaps = [];

  /* ── ORDERED ─────────────────────────────────────────────────────────
     Several PO lines per request line is ORDINARY: one requirement may be
     split across suppliers, and each keeps its own rate. */
  const ordered = orderLines.map((o) => ({
    orderId: idOf(o.orderId),
    orderNumber: o.orderNumber || "",
    orderLineId: idOf(o.lineId),
    kind: o.kind,
    supplierId: idOf(o.supplierId),
    supplierName: o.supplierName || "",
    quantity: num(o.quantity),
    unit: o.unit || "",
    rateMinor: toMinor(o.rate),
    netMinor: toMinor(o.net),
    status: o.status || "",
  }));
  const orderedQuantity = ordered.reduce((t, o) => t + o.quantity, 0);
  const orderedNetMinor = ordered.reduce((t, o) => t + o.netMinor, 0);
  if (!ordered.length) gaps.push(GAP.NO_ORDER);

  /* ── RECEIVED, AND SEPARATELY ACCEPTED ───────────────────────────────
     Inspection is the authority on acceptance. A receipt with no inspection
     is received and nothing more. */
  const receivedQuantity = receipts.reduce((t, r) => t + num(r.receivedQuantity), 0);
  const acceptedQuantity = inspections.reduce((t, i) => t + num(i.acceptedQuantity), 0);
  const quarantinedQuantity = inspections.reduce((t, i) => t + num(i.quarantinedQuantity), 0);
  const rejectedQuantity = inspections.reduce((t, i) => t + num(i.rejectedQuantity), 0);
  const inspectedQuantity = acceptedQuantity + quarantinedQuantity + rejectedQuantity;

  if (ordered.length && !receipts.length) gaps.push(GAP.NO_RECEIPT);
  if (receivedQuantity > 0 && inspectedQuantity <= 0) gaps.push(GAP.NO_INSPECTION);
  if (quarantinedQuantity > 0) gaps.push(GAP.OPEN_QUARANTINE);
  if (rejectedQuantity > 0) gaps.push(GAP.OPEN_RETURN);

  /* ── POSTED, AND ONLY POSTED ─────────────────────────────────────────
     A recorded bill is reported and excluded. Recoverable tax never reaches
     the cost figure; non-recoverable tax does, but only where the voucher
     itself recorded the treatment. */
  const postedRows = vouchers.filter((v) => v.status === POSTED);
  const recordedRows = vouchers.filter((v) => RECORDED_NOT_POSTED.includes(v.status));

  const posted = postedRows.map((v) => ({
    voucherId: idOf(v.voucherId),
    voucherNumber: v.voucherNumber || "",
    voucherDate: v.voucherDate || null,
    quantity: num(v.quantity),
    rateMinor: toMinor(v.rate),
    netMinor: toMinor(v.net),
    /* Recorded, and reported apart — the company reclaims it. */
    recoverableTaxMinor: v.taxRecoverable === true ? toMinor(v.taxAmount) : null,
    /* Cost, and only where the treatment was actually written down. */
    nonRecoverableTaxMinor: v.taxRecoverable === false ? toMinor(v.taxAmount) : null,
    taxTreatmentRecorded: typeof v.taxRecoverable === "boolean",
    /* A voucher that names the order but not the line cannot be attributed
       to this requirement without guessing which line it paid for. */
    attributed: Boolean(v.lineMatched),
  }));

  const attributable = posted.filter((p) => p.attributed);
  const unattributed = posted.filter((p) => !p.attributed);
  if (unattributed.length) gaps.push(GAP.UNLINKED_VOUCHER);

  const billedQuantity = attributable.reduce((t, p) => t + p.quantity, 0);
  const postedNetMinor = attributable.reduce((t, p) => t + p.netMinor, 0);
  const postedNonRecoverableMinor = attributable.reduce((t, p) => t + num(p.nonRecoverableTaxMinor), 0);
  const postedRecoverableMinor = attributable.reduce((t, p) => t + num(p.recoverableTaxMinor), 0);

  if (acceptedQuantity > 0 && !postedRows.length && !recordedRows.length) gaps.push(GAP.NO_BILL);
  if (!postedRows.length && recordedRows.length) gaps.push(GAP.BILL_NOT_POSTED);

  /* ── LANDED CHARGES, ADDED ONCE ──────────────────────────────────────
     Only ACTIVE allocations, and only the amount allocated to THIS order
     line. A superseded or reversed allocation is history; counting it would
     add the same freight twice. */
  const landedMinor = allocations.reduce((t, a) => t + toMinor(a.allocatedAmount), 0);
  const unallocated = allocations.some((a) => a.unallocated === true);
  if (unallocated) gaps.push(GAP.UNALLOCATED_CHARGE);

  return {
    ordered, orderedQuantity, orderedNetMinor,
    receivedQuantity, acceptedQuantity, quarantinedQuantity, rejectedQuantity, inspectedQuantity,
    posted, unattributedVouchers: unattributed,
    recordedNotPosted: recordedRows.map((v) => ({
      voucherId: idOf(v.voucherId), voucherNumber: v.voucherNumber || "",
      netMinor: toMinor(v.net), status: v.status,
    })),
    billedQuantity, postedNetMinor, postedNonRecoverableMinor, postedRecoverableMinor,
    landedMinor,
    /* The cost figure: net + non-recoverable tax + allocated landed charges.
       Recoverable tax is NOT in it. */
    postedActualMinor: postedNetMinor + postedNonRecoverableMinor + landedMinor,
    requestLine: requestLine || null,
    gaps: [...new Set(gaps)],
  };
}

/**
 * Which state one requirement is in.
 *
 * Ordered so the FIRST unmet condition wins: a requirement with a posted bill
 * and open quarantine is not "posted", it is "partly accepted", because the
 * quarantined quantity is still an open question about what was bought.
 */
function stateOf({ requestLine, measured }) {
  if (!requestLine) return STATE.NOT_REQUESTED;
  if (requestLine.requestStatus === "draft") return STATE.DRAFT_REQUEST;
  if (["submitted", "pending_tl", "pending_finance", "awaiting_requester_confirmation",
    "requester_revision_requested", "requester_confirmed", "budget_exception"]
    .includes(requestLine.requestStatus)) return STATE.AWAITING_APPROVAL;
  if (["rejected", "cancelled"].includes(requestLine.requestStatus)) return STATE.RECONCILE;

  if (!measured.ordered.length) return STATE.APPROVED_NOT_ORDERED;
  if (measured.unattributedVouchers.length) return STATE.RECONCILE;
  if (measured.rejectedQuantity > 0) return STATE.RETURNED;
  if (measured.receivedQuantity <= 0) return STATE.AWAITING_RECEIPT;
  if (measured.inspectedQuantity <= 0) return STATE.AWAITING_INSPECTION;
  if (measured.quarantinedQuantity > 0) return STATE.PARTLY_ACCEPTED;
  if (measured.postedNetMinor > 0) return STATE.POSTED;
  if (measured.recordedNotPosted.length) return STATE.BILL_NOT_POSTED;
  if (measured.acceptedQuantity > 0) return STATE.AWAITING_BILL;
  return STATE.AWAITING_RECEIPT;
}

/**
 * Why the actual differs from the estimate, cause by cause.
 *
 * ── NEVER ONE UNEXPLAINED NUMBER ────────────────────────────────────────────
 * "₹41,000 over" is not a finding; "we bought 60 m more at a rate ₹8 higher,
 * and freight nobody estimated" is. Each cause is computed against the figures
 * that isolate it, and whatever the causes fail to account for is reported as
 * an EXPLICIT unexplained difference rather than absorbed into the last one.
 */
function varianceFor({ estimate, measured }) {
  const estQty = present(estimate.quantity) ? Number(estimate.quantity) : null;
  const estRateMinor = present(estimate.rateMinor) ? Number(estimate.rateMinor) : null;
  const estNetMinor = present(estimate.netMinor) ? Number(estimate.netMinor) : null;

  const causes = [];
  const comparable = estQty !== null && estRateMinor !== null && measured.billedQuantity > 0;

  if (comparable) {
    const actualQty = measured.billedQuantity;
    /* Quantity variance holds the RATE constant at the estimate, so it
       contains no price effect. */
    const quantityMinor = Math.round((actualQty - estQty) * estRateMinor);
    /* Rate variance holds the QUANTITY constant at the actual, so the two
       never double-count the overlap between them. */
    const actualRateMinor = actualQty > 0 ? measured.postedNetMinor / actualQty : 0;
    const rateMinor = Math.round((actualRateMinor - estRateMinor) * actualQty);
    if (quantityMinor !== 0) {
      causes.push({
        cause: "QUANTITY", label: "Purchase quantity variance", amountMinor: quantityMinor,
        detail: `Billed ${actualQty} against an estimate of ${estQty}.`,
      });
    }
    if (rateMinor !== 0) {
      causes.push({
        cause: "RATE", label: "Supplier price variance", amountMinor: rateMinor,
        detail: "Rate actually billed differs from the approved quotation rate.",
      });
    }
  }

  /* Tax the estimate did not carry as cost, or carried differently. */
  const estNonRecoverable = present(estimate.nonRecoverableTaxMinor) ? Number(estimate.nonRecoverableTaxMinor) : 0;
  const taxMinor = measured.postedNonRecoverableMinor - estNonRecoverable;
  if (taxMinor !== 0) {
    causes.push({
      cause: "TAX", label: "Tax treatment variance", amountMinor: taxMinor,
      detail: "Non-recoverable tax actually posted differs from the estimate. Recoverable tax is excluded from both.",
    });
  }

  /* Freight and other landed charges the estimate may not have carried. */
  const estLanded = present(estimate.landedMinor) ? Number(estimate.landedMinor) : 0;
  const landedMinor = measured.landedMinor - estLanded;
  if (landedMinor !== 0) {
    causes.push({
      cause: "LANDED", label: "Landed-charge variance", amountMinor: landedMinor,
      detail: "Allocated freight and landed charges against the estimate's frozen figure.",
    });
  }

  /* ── THE SUPPLIER ACTUALLY USED ──────────────────────────────────────
     A substitution is stated as a FACT, not as an amount: the money it moved
     is already inside the rate variance, and adding it again would
     double-count. */
  const actualSuppliers = [...new Set(measured.ordered.map((o) => o.supplierName).filter(Boolean))];
  const substituted = present(estimate.supplierId)
    && measured.ordered.length > 0
    && !measured.ordered.some((o) => o.supplierId && String(o.supplierId) === String(estimate.supplierId));

  const explainedMinor = causes.reduce((t, c) => t + c.amountMinor, 0);
  const totalMinor = estNetMinor === null ? null
    : measured.postedActualMinor - (estNetMinor + estNonRecoverable + estLanded);
  /* ── AND WHATEVER IS LEFT IS SAID OUT LOUD ───────────────────────────
     Forcing this to zero by widening the last cause would turn an unanswered
     question into a confident explanation. */
  const unexplainedMinor = totalMinor === null ? null : totalMinor - explainedMinor;

  return {
    comparable,
    causes,
    supplierSubstituted: substituted,
    estimatedSupplier: estimate.supplierName || "",
    actualSuppliers,
    explainedMinor,
    totalMinor,
    unexplainedMinor,
    /* True only when the identity actually holds on the recorded facts. */
    reconciles: unexplainedMinor === 0,
  };
}

/**
 * Walk the whole chain for one approved scenario.
 *
 * Every query below is company-scoped and every join is a stored id. Nothing
 * is written.
 */
async function reportFor(ctx, { costingId, scenarioKey } = {}) {
  const projected = await projection.projectFor(ctx, { costingId, scenarioKey });
  if (!projected.available) {
    return { available: false, reason: projected.reason, message: projected.message, title: TITLE, standing: STANDING };
  }
  const versionId = projected.version.costingVersionId;

  /* ── 1. THE REQUESTS RAISED FROM THIS APPROVED VERSION ───────────────
     Found by the provenance the handoff stored, never by a name. */
  const requests = await costingDemand.requestsRaisedFromCosting({
    companyId: ctx.companyId,
    costingVersionId: versionId,
    scenarioKey: projected.scenario.scenarioKey,
  });

  /* costing line key → the request line raised for it. */
  const requestByLineKey = new Map();
  for (const r of requests) {
    for (const item of r.items || []) {
      const src = item.costingDemandSource;
      if (!src?.costingLineKey) continue;
      requestByLineKey.set(`${src.costingLineKey}:${r.requestType === "SERVICE" ? "SERVICE" : "PHYSICAL"}`, {
        requestId: idOf(r._id), requestNumber: r.requestNumber || "",
        requestType: r.requestType, requestStatus: r.status,
        spendLineId: idOf(item._id),
        requestQuantity: num(item.quantity), requestUnit: item.unit || "",
        requestRateMinor: toMinor(item.rate),
      });
    }
  }

  const spendLineIds = [...requestByLineKey.values()].map((v) => v.spendLineId).filter(Boolean);
  const requestIds = requests.map((r) => r._id);

  /* ── 2. THE ORDERS RAISED AGAINST THOSE REQUEST LINES ────────────────
     One request line may reach SEVERAL purchase-order lines, across several
     suppliers. Collected as a list per line, never reduced to one. */
  const [pos, sos] = await Promise.all([
    requestIds.length
      ? PurchaseOrder().find({ companyId: ctx.companyId, spendRequestId: { $in: requestIds } }).lean().catch(() => [])
      : [],
    requestIds.length
      ? orderActuals.serviceOrdersForSpendRequests({ companyId: ctx.companyId, spendRequestIds: requestIds })
      : [],
  ]);

  const ordersBySpendLine = new Map();
  const push = (key, row) => {
    if (!key) return;
    if (!ordersBySpendLine.has(key)) ordersBySpendLine.set(key, []);
    ordersBySpendLine.get(key).push(row);
  };
  const poLineOwner = new Map();     // po line id → spendLineId
  for (const po of pos) {
    for (const item of po.items || []) {
      const key = idOf(item.spendLineId);
      push(key, {
        kind: "PURCHASE_ORDER", orderId: po._id, orderNumber: po.poNumber || po.orderNumber || "",
        lineId: item._id, supplierId: po.vendorId || po.vendor, supplierName: po.vendorName || "",
        quantity: item.quantity, unit: item.unit || "", rate: item.rate,
        net: present(item.amount) ? item.amount : num(item.quantity) * num(item.rate),
        status: po.status || "",
      });
      if (key) poLineOwner.set(String(item._id), key);
    }
  }
  for (const so of sos) {
    for (const line of so.lines || []) {
      push(idOf(line.spendLineId), {
        kind: "SERVICE_ORDER", orderId: so._id, orderNumber: so.serviceOrderNumber || "",
        lineId: line._id, supplierId: so.vendorId, supplierName: so.vendorName || "",
        quantity: line.quantity, unit: line.billingUnit || "", rate: line.rate,
        net: present(line.netAmount) ? line.netAmount : num(line.quantity) * num(line.rate),
        status: so.status || "",
      });
    }
  }

  /* ── 3. RECEIPTS AND INSPECTIONS, BY PO LINE ─────────────────────────
     Received and accepted are separate reads because they are separate
     facts, and inspection is the only authority on the second. */
  const poIds = pos.map((p) => p._id);
  const [receipts, inspections, allocations] = await Promise.all([
    poIds.length ? GoodsReceipt().find({ companyId: ctx.companyId, purchaseOrderId: { $in: poIds } }).lean().catch(() => []) : [],
    poIds.length ? GoodsReceiptInspection().find({ companyId: ctx.companyId, purchaseOrderId: { $in: poIds } }).lean().catch(() => []) : [],
    poIds.length ? LandedCostAllocation().find({ companyId: ctx.companyId, purchaseOrderId: { $in: poIds }, status: "active" }).lean().catch(() => []) : [],
  ]);

  const receiptsByPoLine = new Map();
  for (const g of receipts) {
    for (const l of g.lines || []) {
      const k = idOf(l.poItemId);
      if (!k) continue;
      if (!receiptsByPoLine.has(k)) receiptsByPoLine.set(k, []);
      receiptsByPoLine.get(k).push({ receivedQuantity: l.receivedQuantity, receiptId: idOf(g._id), receiptNumber: g.grnNumber || "" });
    }
  }
  const inspectionsByPoLine = new Map();
  for (const i of inspections) {
    for (const l of i.lines || []) {
      const k = idOf(l.poItemId);
      if (!k) continue;
      if (!inspectionsByPoLine.has(k)) inspectionsByPoLine.set(k, []);
      inspectionsByPoLine.get(k).push({
        acceptedQuantity: l.acceptedQuantity, quarantinedQuantity: l.quarantinedQuantity,
        rejectedQuantity: l.rejectedQuantity, inspectionId: idOf(i._id),
      });
    }
  }
  const allocationsByPoLine = new Map();
  for (const a of allocations) {
    for (const t of a.targets || []) {
      const k = idOf(t.poLineId);
      if (!k) {
        /* An active charge nobody could attribute to a line. Reported as an
           exception rather than spread across lines by a guess. */
        continue;
      }
      if (!allocationsByPoLine.has(k)) allocationsByPoLine.set(k, []);
      allocationsByPoLine.get(k).push({ allocatedAmount: t.allocatedAmount, voucherNumber: a.sourceVoucherNumber || "" });
    }
  }
  const unallocatedCharges = allocations.filter((a) => (a.targets || []).every((t) => !t.poLineId));

  /* ── 4. POSTED BILLS ─────────────────────────────────────────────────
     Read by the order they name. A voucher that names the order but not the
     LINE cannot be attributed to a requirement without guessing. */
  const soIds = sos.map((s) => s._id);
  const vouchers = (poIds.length || soIds.length)
    ? await Acc_Voucher.find({
      companyId: ctx.companyId, voucherType: "purchase",
      $or: [
        ...(poIds.length ? [{ purchaseOrderId: { $in: poIds } }] : []),
        ...(soIds.length ? [{ serviceOrderId: { $in: soIds } }] : []),
      ],
    }).lean().catch(() => [])
    : [];

  const vouchersByOrderLine = new Map();
  const vouchersByOrder = new Map();
  for (const v of vouchers) {
    const orderKey = idOf(v.purchaseOrderId) || idOf(v.serviceOrderId);
    if (orderKey) {
      if (!vouchersByOrder.has(orderKey)) vouchersByOrder.set(orderKey, []);
      vouchersByOrder.get(orderKey).push(v);
    }
    for (const entry of v.inventoryEntries || v.items || []) {
      const k = idOf(entry.poItemId);
      if (!k) continue;
      if (!vouchersByOrderLine.has(k)) vouchersByOrderLine.set(k, []);
      vouchersByOrderLine.get(k).push({
        voucherId: v._id, voucherNumber: v.voucherNumber || "", voucherDate: v.voucherDate || null,
        status: v.status, quantity: entry.quantity, rate: entry.rate,
        net: present(entry.amount) ? entry.amount : num(entry.quantity) * num(entry.rate),
        taxAmount: entry.taxAmount ?? entry.gstAmount ?? 0,
        /* Only where the voucher itself recorded the treatment. Undefined
           means nobody said, and nobody saying is not "recoverable". */
        taxRecoverable: typeof entry.taxRecoverable === "boolean" ? entry.taxRecoverable
          : (typeof entry.isRecoverable === "boolean" ? entry.isRecoverable : undefined),
        lineMatched: true,
      });
    }
  }

  /* ── 5. ONE ROW PER PROJECTED REQUIREMENT ────────────────────────────── */
  const rows = projected.requirements.map((req) => {
    const key = `${req.reference.lineKey}:${req.reference.kind === "SERVICE" || req.reference.kind === "FREIGHT" ? "SERVICE" : "PHYSICAL"}`;
    const requestLine = requestByLineKey.get(key) || null;
    const orderLines = requestLine ? (ordersBySpendLine.get(requestLine.spendLineId) || []) : [];

    const receiptRows = [];
    const inspectionRows = [];
    const voucherRows = [];
    const allocationRows = [];
    for (const o of orderLines) {
      const lineKey = String(o.lineId);
      receiptRows.push(...(receiptsByPoLine.get(lineKey) || []));
      inspectionRows.push(...(inspectionsByPoLine.get(lineKey) || []));
      voucherRows.push(...(vouchersByOrderLine.get(lineKey) || []));
      allocationRows.push(...(allocationsByPoLine.get(lineKey) || []));
      /* A service order has no line-level voucher link; its bills are read at
         order level, which IS the authoritative granularity there. */
      if (o.kind === "SERVICE_ORDER") {
        for (const v of vouchersByOrder.get(String(o.orderId)) || []) {
          voucherRows.push({
            voucherId: v._id, voucherNumber: v.voucherNumber || "", voucherDate: v.voucherDate || null,
            status: v.status, quantity: o.quantity, rate: o.rate, net: v.grandTotal ?? o.net,
            taxAmount: 0, taxRecoverable: undefined, lineMatched: true,
          });
        }
      }
    }
    if (unallocatedCharges.length && orderLines.length) {
      allocationRows.push({ allocatedAmount: 0, unallocated: true });
    }

    const measured = measureLine({
      requestLine, orderLines, receipts: receiptRows, inspections: inspectionRows,
      vouchers: voucherRows, allocations: allocationRows,
    });
    if (!requestLine) measured.gaps.unshift(GAP.NO_REQUEST);

    const isPhysical = req.kind === "PHYSICAL";
    const estimate = {
      quantity: isPhysical ? req.quantity?.orderQuantity : req.quantity?.serviceQuantity,
      unit: isPhysical ? req.quantity?.purchaseUom : req.quantity?.billingUnit,
      rateMinor: req.supplier?.quotedRateMinor ?? null,
      netMinor: req.money?.expectedNetMinor ?? null,
      nonRecoverableTaxMinor: req.money?.nonRecoverableTaxMinor ?? null,
      recoverableTaxMinor: req.money?.recoverableTaxMinor ?? null,
      landedMinor: null,
      supplierId: req.supplier?.supplierId || null,
      supplierName: req.supplier?.supplierName || "",
      quotation: req.supplier?.quotationReference || "",
      quotationRevision: req.supplier?.quotationRevision ?? null,
    };

    const state = stateOf({ requestLine, measured });
    const variance = varianceFor({ estimate, measured });

    /* ── COMPLETE, OR HONESTLY NOT ────────────────────────────────────
       Every condition, not a majority of them. One open quarantine or one
       unposted bill makes the actual a running total, not a result. */
    const complete = Boolean(requestLine)
      && orderLines.length > 0
      && measured.inspectedQuantity > 0
      && measured.quarantinedQuantity === 0
      && measured.postedNetMinor > 0
      && measured.unattributedVouchers.length === 0
      && !measured.gaps.includes(GAP.UNALLOCATED_CHARGE);

    return {
      requirementId: `${req.reference.lineKey}:${req.reference.kind}`,
      /* ── THE STORED IDS, CARRIED THROUGH ───────────────────────────────
         Not for a screen to render — for the next report to join on. Chunk
         8B matches material issues to a requirement by `itemId`/`variantId`,
         and without these it would have nothing but a name to match on,
         which is the one thing this whole chain refuses to do. */
      reference: req.reference,
      kind: req.kind,
      identity: req.identity,
      family: req.identity?.category || "",
      estimate,
      actual: measured,
      variance,
      state,
      nextAction: NEXT_ACTION[state] || "",
      gaps: measured.gaps.map((g) => ({ key: g, message: GAP_TEXT[g] })),
      complete,
      documents: {
        request: requestLine ? { id: requestLine.requestId, number: requestLine.requestNumber } : null,
        orders: measured.ordered.map((o) => ({ id: o.orderId, number: o.orderNumber, kind: o.kind })),
        receipts: [...new Set(receiptRows.map((r) => r.receiptNumber).filter(Boolean))],
        vouchers: measured.posted.map((p) => ({ id: p.voucherId, number: p.voucherNumber })),
      },
    };
  });

  /* ── 6. TOTALS, AND THE ONE CLAIM THIS REPORT WILL NOT MAKE ──────────── */
  const sum = (pick) => rows.reduce((t, r) => t + num(pick(r)), 0);
  const estimatedMinor = sum((r) => r.estimate.netMinor) + sum((r) => r.estimate.nonRecoverableTaxMinor);
  const postedActualMinor = sum((r) => r.actual.postedActualMinor);
  const allComplete = rows.length > 0 && rows.every((r) => r.complete);

  return {
    available: true,
    title: TITLE,
    standing: STANDING,
    costing: projected.costing,
    version: projected.version,
    scenario: projected.scenario,
    summary: {
      estimatedProcurementMinor: estimatedMinor,
      orderedMinor: sum((r) => r.actual.orderedNetMinor),
      acceptedQuantityRows: rows.filter((r) => r.actual.acceptedQuantity > 0).length,
      postedActualMinor,
      landedPostedMinor: sum((r) => r.actual.landedMinor),
      recoverableTaxMinor: sum((r) => r.actual.postedRecoverableMinor),
      awaitingBillMinor: sum((r) => (r.state === STATE.AWAITING_BILL ? r.actual.orderedNetMinor : 0)),
      notOrderedMinor: sum((r) => (r.actual.ordered.length ? 0 : r.estimate.netMinor)),
      remainingWithoutPostedMinor: estimatedMinor - postedActualMinor,
      /* Of the estimate, how much has a posted actual behind it. */
      coveragePercent: estimatedMinor > 0
        ? Math.round((postedActualMinor / estimatedMinor) * 1000) / 10 : null,
      reconciledCount: rows.filter((r) => r.complete && r.variance.reconciles).length,
      attentionCount: rows.filter((r) => !r.complete || !r.variance.reconciles).length,
      requirementCount: rows.length,
      /* ── AND THE HEADLINE IS HONEST ─────────────────────────────────
         A final comparable procurement actual only when EVERY requirement is
         complete. Otherwise this is a running total, and it says so. */
      complete: allComplete,
      label: allComplete ? "Actual procurement cost" : "Actual to date — incomplete",
      /* Deliberately absent while incomplete: dividing a partial posted
         amount by the approved output quantity manufactures a unit cost
         nobody can stand behind. */
      perUnitActualMinor: null,
      perUnitWithheldReason: allComplete
        ? "Per-unit actual is a finished-product figure and needs production consumption, labour and output quantities."
        : "Actual is incomplete, so it cannot be divided into a per-unit cost.",
    },
    requirements: rows,
    families: Object.entries(FAMILY_FEEDBACK).map(([key, f]) => ({
      key, label: f.label, connected: f.connected, reason: f.reason || null,
    })),
    laterConnections: LATER,
    unallocatedCharges: unallocatedCharges.map((a) => ({
      voucherNumber: a.sourceVoucherNumber || "", message: GAP_TEXT.UNALLOCATED_CHARGE,
    })),
  };
}

module.exports = {
  reportFor, measureLine, stateOf, varianceFor,
  POSTED, RECORDED_NOT_POSTED, STATE, NEXT_ACTION, GAP, GAP_TEXT,
  FAMILY_FEEDBACK, LATER, TITLE, STANDING,
  costingDemand, PurchaseOrder, orderActuals, GoodsReceipt, GoodsReceiptInspection,
  LandedCostAllocation, Acc_Voucher, projection,
  present, idOf, num, toMinor,
};
