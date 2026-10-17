// services/sales/orderQuantityReduction.js
//
// SALES REDUCES A BULK ORDER'S QUANTITY AFTER IT WENT TO PRODUCTION (17 Oct
// 2026, owner: "the order qty the user has entered wrong, and as the order
// got sent to production the sales person can't edit … keep a button so he
// can reduce the order qty, product-variant wise, WO-wise … he can't add more
// products").
//
// THE RULES, PURE — no database, no React — so `node --test` holds them to
// account (orderQuantityReduction.test.js). The route on quotationRoutes.js
// reads the request and its work orders, asks these functions what may
// change, and then writes every dependent record in one pass:
//
//   WorkOrder.quantity (originalQuantity kept, quantityChanges[] appended)
//     → rawMaterials rescaled (the BOM snapshot is per piece × quantity)
//     → cuttingProgress.remaining, productionCompletion totals re-based
//   CustomerRequest.items[].variants[].quantity + items[].totalQuantity
//     → quotations[0].items[] re-priced, subtotal / GST / grand total,
//       finalOrderPrice, totalDueAmount, taxSummary
//     → paymentSchedule amounts re-derived from each step's percentage
//       (paid money is never touched; an over-payment is reported as credit)
//
// WHAT IS REFUSED, BY NAME
//   · a person-wise (measurement) order — each person's quantity is changed
//     on the person, where the unit ranges live (PUT …/person/:employeeId);
//   · an order the PI is not sales-approved on yet — the PI itself is still
//     editable, so this door is not needed;
//   · an order already shipping, delivered, completed or cancelled;
//   · a new product or a new variant — only the work orders that exist
//     change; raising or lowering a variant's pieces is allowed (17 Oct 2026,
//     owner: "so that user can also increase the qty also"), up to
//     MAX_PIECES a work order;
//   · a quantity below what the floor has already done — the highest unit
//     number scanned complete, pieces cut, packed or dispatched: those pieces
//     exist, and the order cannot pretend they do not.
"use strict";

const str = (v) => String(v ?? "").trim();
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const idOf = (v) => str(v?._id || v);

const CODES = Object.freeze({
  NOT_BULK: "NOT_BULK_ORDER",
  NOT_APPROVED: "PI_NOT_SALES_APPROVED",
  ORDER_CLOSED: "ORDER_CLOSED",
  VALIDATION: "VALIDATION",
});

/* The request statuses a reduction may still happen in. Shipping and later
   are the customer's goods, not the floor's work. */
const OPEN_STATUSES = new Set(["quotation_sales_approved", "in_progress", "production"]);

/* A sanity bound on one work order, not a business rule: a slip of the
   keyboard (an extra two zeros) is refused rather than sent to the floor. */
const MAX_PIECES = 100000;

/** May this order's quantities be reduced here at all? */
function requestEditable(request) {
  if (!request) return { ok: false, code: CODES.VALIDATION, reason: "Request not found." };
  if (request.requestType === "measurement_conversion" || request.measurementId) {
    return { ok: false, code: CODES.NOT_BULK, reason: "This is a person-wise order. Change a person's quantity on the person themselves (Order Items › the person), where their unit range lives." };
  }
  const quotation = request.quotations?.[0] || null;
  const approved = quotation && (quotation.status === "sales_approved" || quotation.salesApproval?.approved);
  if (!approved) {
    return { ok: false, code: CODES.NOT_APPROVED, reason: "The PI is not sales-approved yet, so the quantities can still be changed on the PI itself (Revise)." };
  }
  if (!OPEN_STATUSES.has(str(request.status))) {
    return { ok: false, code: CODES.ORDER_CLOSED, reason: `This order is ${str(request.status).replace(/_/g, " ") || "closed"}; its quantities are history now.` };
  }
  return { ok: true, code: null, reason: null };
}

/**
 * The lowest quantity a work order may be reduced to, and why: whatever the
 * floor has already done with it. Unit numbers are labels on real pieces, so
 * the highest unit scanned complete holds the floor even when fewer pieces
 * than that were finished.
 */
function floorFor(wo) {
  const holds = [];
  const push = (n, why) => { const v = Math.round(num(n)); if (v > 0) holds.push({ n: v, why }); };
  const pc = wo?.productionCompletion || {};
  const unitMax = Math.max(0, ...(pc.operationCompletion || []).flatMap((op) => (op.completedUnitNumbers || []).map((u) => num(u))));
  push(unitMax, `piece ${unitMax} is already scanned complete`);
  push(pc.overallCompletedQuantity, `${Math.round(num(pc.overallCompletedQuantity))} piece(s) are finished`);
  push(wo?.cuttingProgress?.completed, `${Math.round(num(wo?.cuttingProgress?.completed))} piece(s) are already cut`);
  push(wo?.qcCompletion?.completedQuantity, `${Math.round(num(wo?.qcCompletion?.completedQuantity))} piece(s) passed QC`);
  push(wo?.packagedQuantity, `${Math.round(num(wo?.packagedQuantity))} piece(s) are packed`);
  push(wo?.dispatchedQuantity, `${Math.round(num(wo?.dispatchedQuantity))} piece(s) are dispatched`);
  const top = holds.sort((a, b) => b.n - a.n)[0];
  return { floor: Math.max(1, top ? top.n : 1), reason: top ? top.why : "nothing is made yet — down to 1 piece" };
}

const variantText = (attrs) => (attrs || []).filter((a) => a && str(a.value)).map((a) => (a.name ? `${a.name}: ${a.value}` : str(a.value))).join(", ");

const attrsMatch = (a = [], b = []) => {
  if (!a?.length || !b?.length || a.length !== b.length) return false;
  return a.every((x) => b.some((y) => str(y.name) === str(x.name) && str(y.value) === str(x.value)));
};

/**
 * The request line and variant a work order was made from — by the stored
 * line reference first, then by product + variant id, then by product +
 * attributes. Returns { item, variant } or nulls.
 */
function matchRequestVariant(request, wo) {
  const items = request?.items || [];
  const pid = idOf(wo?.stockItemId);
  const lineRef = str(wo?.salesLineLink?.lineRef);
  let candidates = items.filter((it) => idOf(it.stockItemId) === pid);
  if (lineRef) { const byRef = items.filter((it) => str(it.lineRef) === lineRef); if (byRef.length) candidates = byRef; }
  for (const item of candidates) {
    const byId = (item.variants || []).find((v) => str(v.variantId) && str(v.variantId) === str(wo.variantId));
    if (byId) return { item, variant: byId };
  }
  for (const item of candidates) {
    const byAttrs = (item.variants || []).find((v) => attrsMatch(v.attributes, wo.variantAttributes));
    if (byAttrs) return { item, variant: byAttrs };
  }
  /* one variant on the line and one work order for it: that is the one */
  for (const item of candidates) if ((item.variants || []).length === 1) return { item, variant: item.variants[0] };
  return { item: candidates[0] || null, variant: null };
}

/** The priced PI line behind a work order, for the rate it shows. */
function matchQuotationLine(request, wo) {
  const q = request?.quotations?.[0];
  const pid = idOf(wo?.stockItemId);
  const lines = (q?.items || []).filter((qi) => idOf(qi.stockItemId) === pid);
  if (!lines.length) return null;
  if (lines.length === 1) return lines[0];
  return lines.find((qi) => attrsMatch(qi.attributes, wo.variantAttributes)) || null;
}

/** One editable line, as the drawer reads it. */
function lineView(request, wo) {
  const { floor, reason } = floorFor(wo);
  const qi = matchQuotationLine(request, wo);
  const { variant } = matchRequestVariant(request, wo);
  const quantity = Math.round(num(wo.quantity));
  const closed = ["completed", "cancelled", "forwarded"].includes(str(wo.status));
  return {
    workOrderId: idOf(wo),
    reference: str(wo.workOrderNumber),
    status: str(wo.status),
    stockItemId: idOf(wo.stockItemId),
    productName: str(wo.stockItemName),
    productReference: str(wo.stockItemReference),
    variantId: str(wo.variantId),
    variant: variantText(wo.variantAttributes) || variantText(variant?.attributes) || "",
    quantity,
    originalQuantity: Math.round(num(wo.originalQuantity)) || quantity,
    floor: Math.min(floor, quantity),
    floorReason: reason,
    unitPrice: qi ? num(qi.unitPrice) : null,
    gstPercentage: qi ? num(qi.gstPercentage) : null,
    canReduce: !closed && quantity > Math.min(floor, quantity),
    canChange: !closed,
    maxQuantity: MAX_PIECES,
    onRequest: Boolean(variant),
    changes: (wo.quantityChanges || []).map((c) => ({ from: c.from, to: c.to, reason: str(c.reason), at: c.changedAt || null, by: str(c.changedBy?.name) })),
  };
}

/**
 * What the body asks for, checked line by line against the work orders.
 * `lines` is [{ workOrderId, quantity }]. Returns the changes to make, the
 * refusals by name, and the lines that asked for no change.
 */
function planReduction(workOrders, lines) {
  const byId = new Map((workOrders || []).map((wo) => [idOf(wo), wo]));
  const errors = [], changes = [], unchanged = [];
  const seen = new Set();
  if (!Array.isArray(lines) || !lines.length) return { changes, unchanged, errors: ["Say which work orders to change, and to what."] };
  for (const l of lines) {
    const id = idOf(l?.workOrderId);
    const wo = byId.get(id);
    if (!wo) { errors.push(`Work order ${id || "?"} is not on this order.`); continue; }
    if (seen.has(id)) { errors.push(`${str(wo.workOrderNumber) || id} is listed twice.`); continue; }
    seen.add(id);
    const from = Math.round(num(wo.quantity));
    const raw = Number(l?.quantity);
    const name = `${str(wo.workOrderNumber) || id}${variantText(wo.variantAttributes) ? ` (${variantText(wo.variantAttributes)})` : ""}`;
    if (!Number.isInteger(raw) || raw < 1) { errors.push(`${name}: the quantity must be a whole number of at least 1.`); continue; }
    if (["completed", "cancelled", "forwarded"].includes(str(wo.status))) { errors.push(`${name} is ${wo.status}; its quantity is history.`); continue; }
    if (raw === from) { unchanged.push(id); continue; }
    if (raw > MAX_PIECES) { errors.push(`${name}: ${raw} is more than ${MAX_PIECES} pieces on one work order — check the figure.`); continue; }
    if (raw < from) {
      const { floor, reason } = floorFor(wo);
      if (raw < floor) { errors.push(`${name}: cannot go below ${floor} — ${reason}.`); continue; }
    }
    changes.push({ workOrderId: id, from, to: raw });
  }
  if (!errors.length && !changes.length) errors.push("Nothing changed — every quantity is what it already was.");
  return { changes, unchanged, errors };
}

/**
 * Write one change onto the work order document (not saved here): the
 * quantity, the log, the raw-material rescale left to the caller's helper,
 * and the progress figures that are stated against the total.
 */
function applyToWorkOrder(wo, change, { reason = "", actor = null, at = new Date() } = {}) {
  const from = Math.round(num(wo.quantity));
  if (!wo.originalQuantity) wo.originalQuantity = from;
  wo.quantity = change.to;
  if (!Array.isArray(wo.quantityChanges)) wo.quantityChanges = [];
  wo.quantityChanges.push({
    from, to: change.to, reason: str(reason).slice(0, 300), changedAt: at,
    changedBy: { userId: str(actor?.id), name: str(actor?.name), email: str(actor?.email) },
    source: change.to > from ? "sales-increase" : "sales-reduce",
  });
  if (wo.cuttingProgress) {
    wo.cuttingProgress.remaining = Math.max(0, change.to - num(wo.cuttingProgress.completed));
  }
  const pc = wo.productionCompletion;
  if (pc && Array.isArray(pc.operationCompletion)) {
    for (const op of pc.operationCompletion) {
      op.totalQuantity = change.to;
      op.completionPercentage = change.to > 0 ? Math.min(100, Math.round((num(op.completedQuantity) / change.to) * 100)) : 0;
      if (op.completionPercentage >= 100) op.status = "completed";
      else if (op.status === "completed") op.status = "in_progress"; /* raised past what was done */
    }
    pc.overallCompletionPercentage = change.to > 0 ? Math.min(100, Math.round((num(pc.overallCompletedQuantity) / change.to) * 100)) : 0;
  }
  return wo;
}

/**
 * Write the change onto the request's own line (not saved here): the
 * variant's quantity, the line total, and the estimate scaled per piece.
 */
function applyToRequestItems(request, wo, change) {
  const { item, variant } = matchRequestVariant(request, wo);
  if (!item || !variant) return { found: false };
  const before = Math.round(num(variant.quantity));
  const perPiece = before > 0 ? num(variant.estimatedPrice) / before : 0;
  variant.quantity = change.to;
  if (variant.estimatedPrice != null) variant.estimatedPrice = Math.round(perPiece * change.to * 100) / 100;
  item.totalQuantity = Math.max(1, (item.variants || []).reduce((n, v) => n + Math.round(num(v.quantity)), 0));
  if (item.totalEstimatedPrice != null) item.totalEstimatedPrice = Math.round((item.variants || []).reduce((n, v) => n + num(v.estimatedPrice), 0) * 100) / 100;
  return { found: true, before, after: change.to };
}

/** The schedule's step amounts, re-derived from the percentages on the new
 *  grand total. Paid money stays; a step paid beyond its new amount is said. */
function rebasePaymentSchedule(quotation) {
  const grand = num(quotation?.grandTotal);
  const over = [];
  for (const step of quotation?.paymentSchedule || []) {
    const pct = num(step.percentage);
    if (!pct) continue;
    step.amount = Math.round(((grand * pct) / 100) * 100) / 100;
    const paid = num(step.paidAmount);
    if (paid > step.amount + 0.005) over.push({ stepNumber: step.stepNumber, name: str(step.name), amount: step.amount, paidAmount: paid, excess: Math.round((paid - step.amount) * 100) / 100 });
    if (paid >= step.amount - 0.005 && paid > 0 && step.status !== "paid") step.status = "paid";
    /* a raised total can leave a step that was paid in full only part-paid */
    else if (step.status === "paid" && paid < step.amount - 0.005) step.status = paid > 0 ? "partially_paid" : "pending";
  }
  return over;
}

/** The note the request keeps, in words. */
function changeNote(changes, workOrders, { reason = "", by = "" } = {}) {
  const byId = new Map((workOrders || []).map((wo) => [idOf(wo), wo]));
  const parts = changes.map((c) => {
    const wo = byId.get(c.workOrderId);
    const v = variantText(wo?.variantAttributes);
    return `${str(wo?.stockItemName) || "product"}${v ? ` (${v})` : ""} ${c.from} → ${c.to}`;
  });
  return `${movementText(changes)}${by ? ` by ${by}` : ""}: ${parts.join("; ")}.${reason ? ` Reason: ${reason}` : ""}`;
}

/** "Order quantity raised by 10 pieces" / "reduced by 5" / "changed: +10, −5". */
function movementText(changes) {
  const up = changes.reduce((n, c) => n + Math.max(0, c.to - c.from), 0);
  const down = changes.reduce((n, c) => n + Math.max(0, c.from - c.to), 0);
  const pcs = (n) => `${n} piece${n === 1 ? "" : "s"}`;
  if (up && down) return `Order quantity changed: +${pcs(up)}, −${pcs(down)}`;
  if (up) return `Order quantity raised by ${pcs(up)}`;
  return `Order quantity reduced by ${pcs(down)}`;
}

module.exports = {
  CODES, OPEN_STATUSES, MAX_PIECES, movementText,
  requestEditable, floorFor, matchRequestVariant, matchQuotationLine, lineView,
  planReduction, planChange: planReduction, applyToWorkOrder, applyToRequestItems, rebasePaymentSchedule, changeNote, variantText,
};
