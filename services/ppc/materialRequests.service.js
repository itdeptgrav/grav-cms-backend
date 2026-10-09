"use strict";
// services/ppc/materialRequests.service.js
//
// MATERIAL REQUESTS FROM PPC TO THE STORE (4 Oct 2026, owner).
//
// "The store person can issue as much qty he wants against that order — so a
// request-based approach is needed in the PPC side." PPC raises a request
// against a manufacturing order — raw item, variant, quantity, unit, a reason
// — and the Store issues against it. Every issue made against a request
// carries the request's id and the line's id (StockIssuance.materialRequestId
// / items[].materialRequestLineId), so "requested vs issued" is exact on
// both sides. The Store's free issue (no request) is untouched.
//
// The requests live on the order itself (`CustomerRequest.materialRequests`)
// — the cluster is at its collection cap, and a request is a fact about the
// order. Status is DERIVED from the issues at read time, never trusted from
// the stored value, except "cancelled".

const mongoose = require("mongoose");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const StockIssuance = require("../../models/CMS_Models/Inventory/Operations/StockIssuance");

const str = (v) => (v == null ? "" : String(v).trim());
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const refuse = (status, message, extra = {}) => { const e = new Error(message); e.status = status; Object.assign(e, extra); return e; };

const ORDER_SELECT = "requestId customerInfo.name status createdAt materialRequests items.stockItemName";

/** The order, proved to the PPC company the way the PO route proves it. */
async function orderForCompany(companyId, moId) {
  if (!isId(moId)) throw refuse(400, "Not an order id.");
  const mine = await WorkOrder.exists({ customerRequestId: oid(moId), "salesLineLink.companyId": companyId });
  const legacy = !mine && await WorkOrder.exists({ customerRequestId: oid(moId) });
  if (!mine && !legacy) throw refuse(404, "That order was not found.");
  const order = await CustomerRequest.findById(moId).select(ORDER_SELECT).lean();
  if (!order) throw refuse(404, "That order was not found.");
  return order;
}

/** The order by id alone — the Store's door, which has its own session gate. */
async function orderById(moId) {
  if (!isId(moId)) throw refuse(400, "Not an order id.");
  const order = await CustomerRequest.findById(moId).select(ORDER_SELECT).lean();
  if (!order) throw refuse(404, "That order was not found.");
  return order;
}

const personOf = (a) => ({ userId: str(a?.userId || a?.id), name: str(a?.name), email: str(a?.email).toLowerCase() });

/* ── the view ───────────────────────────────────────────────────────────── */

function issueRowsOf(issuances) {
  const rows = [];
  for (const iss of issuances) {
    for (const it of iss.items || []) {
      rows.push({
        issuanceId: String(iss._id), at: iss.createdAt || null, by: str(iss.performedByName), direction: iss.direction,
        reason: str(iss.reason), moNumber: str(iss.moNumber),
        materialRequestId: iss.materialRequestId ? String(iss.materialRequestId) : null,
        materialRequestLineId: it.materialRequestLineId ? String(it.materialRequestLineId) : null,
        rawItemId: it.rawItem ? String(it.rawItem) : "", rawItemName: str(it.rawItemName), rawItemSku: str(it.rawItemSku),
        variantId: it.variantId ? String(it.variantId) : null, variantCombination: (it.variantCombination || []).map(str),
        issuedQty: Number(it.issuedQty) || 0, issuedUnit: str(it.issuedUnit), nativeQty: Number(it.nativeQty) || 0, nativeUnit: str(it.nativeUnit),
        warehouseName: str(it.warehouseName), locationCode: str(it.locationCode), notes: str(it.notes),
      });
    }
  }
  return rows;
}

function requestView(r, issueRows) {
  const lines = (r.lines || []).map((l) => {
    const mine = issueRows.filter((x) => x.materialRequestLineId === String(l._id));
    /* issued in the request's unit where the Store issued in that unit;
       otherwise the native figure is shown beside it rather than mixed in */
    const sameUnit = mine.filter((x) => !x.issuedUnit || x.issuedUnit.toLowerCase() === str(l.unit).toLowerCase());
    const otherUnit = mine.filter((x) => x.issuedUnit && x.issuedUnit.toLowerCase() !== str(l.unit).toLowerCase());
    const signed = (x) => (x.direction === "credit" ? -1 : 1);
    const issuedQty = Math.round(sameUnit.reduce((n, x) => n + signed(x) * x.issuedQty, 0) * 1000) / 1000;
    const otherQty = Math.round(otherUnit.reduce((n, x) => n + signed(x) * x.nativeQty, 0) * 1000) / 1000;
    const requested = Number(l.quantity) || 0;
    const remaining = Math.max(0, Math.round((requested - issuedQty) * 1000) / 1000);
    return {
      lineId: String(l._id), rawItemId: l.rawItemId ? String(l.rawItemId) : "", rawItemName: str(l.rawItemName), rawItemSku: str(l.rawItemSku),
      variantId: l.variantId ? String(l.variantId) : null, variantCombination: (l.variantCombination || []).map(str), variantLabel: (l.variantCombination || []).map(str).filter(Boolean).join(" · "),
      quantity: requested, unit: str(l.unit), note: str(l.note),
      issuedQty, otherUnitIssued: otherUnit.length ? { qty: otherQty, unit: otherUnit[0].nativeUnit } : null,
      remaining, over: Math.max(0, Math.round((issuedQty - requested) * 1000) / 1000),
      status: issuedQty <= 0 ? "open" : remaining > 0 ? "partial" : issuedQty > requested + 1e-6 ? "over_issued" : "issued",
      issues: mine.sort((a, b) => new Date(a.at) - new Date(b.at)),
    };
  });
  const totalRequested = lines.reduce((n, l) => n + l.quantity, 0);
  const totalIssued = lines.reduce((n, l) => n + l.issuedQty, 0);
  const status = r.status === "cancelled" ? "cancelled"
    : lines.length && lines.every((l) => l.status === "issued" || l.status === "over_issued") ? "issued"
      : lines.some((l) => l.issuedQty > 0) ? "partially_issued" : "open";
  return {
    id: String(r._id), requestNumber: str(r.requestNumber), status,
    reason: str(r.reason), neededBy: r.neededBy || null,
    createdAt: r.createdAt || null, createdBy: r.createdBy || null,
    cancelledAt: r.cancelledAt || null, cancelledBy: r.cancelledBy || null, cancelReason: str(r.cancelReason),
    lines, lineCount: lines.length, totalRequested, totalIssued,
    issueCount: new Set(lines.flatMap((l) => l.issues.map((x) => x.issuanceId))).size,
    lastIssuedAt: lines.flatMap((l) => l.issues.map((x) => x.at)).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null,
  };
}

async function viewOf(order) {
  const issuances = await StockIssuance.find({ manufacturingOrder: order._id }).sort({ createdAt: 1 }).lean();
  const rows = issueRowsOf(issuances);
  const requests = (order.materialRequests || []).map((r) => requestView(r, rows)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const free = rows.filter((x) => !x.materialRequestId);
  return {
    order: { moId: String(order._id), requestId: str(order.requestId), moNumber: order.requestId ? `MO-${order.requestId}` : "", customerName: str(order.customerInfo?.name), status: str(order.status), products: (order.items || []).map((i) => str(i.stockItemName)).filter(Boolean) },
    requests,
    /* the Store's issues against this order that name no request — kept
       visible, never hidden: the free issue stays allowed */
    freeIssues: free,
    totals: {
      requests: requests.length,
      open: requests.filter((r) => r.status === "open").length,
      partiallyIssued: requests.filter((r) => r.status === "partially_issued").length,
      issued: requests.filter((r) => r.status === "issued").length,
      cancelled: requests.filter((r) => r.status === "cancelled").length,
      requestedLines: requests.filter((r) => r.status !== "cancelled").reduce((n, r) => n + r.lineCount, 0),
      issuesAgainstRequests: rows.filter((x) => x.materialRequestId).length,
      freeIssues: free.length,
    },
  };
}

async function listForOrder(moId, { companyId = null } = {}) {
  const order = companyId ? await orderForCompany(companyId, moId) : await orderById(moId);
  return viewOf(order);
}

/* ── raise ──────────────────────────────────────────────────────────────── */

async function create(companyId, moId, body, actor) {
  const order = await orderForCompany(companyId, moId);
  const reason = str(body?.reason);
  if (reason.length < 5) throw refuse(400, "Say why the material is needed (at least 5 characters).");
  const neededBy = body?.neededBy ? new Date(body.neededBy) : null;
  if (neededBy && Number.isNaN(neededBy.getTime())) throw refuse(400, "The needed-by date is not valid.");
  const inLines = Array.isArray(body?.lines) ? body.lines : [];
  if (!inLines.length) throw refuse(400, "Add at least one raw item.");
  if (inLines.length > 60) throw refuse(400, "A request carries at most 60 lines.");
  const itemIds = [...new Set(inLines.map((l) => str(l?.rawItemId)))];
  if (itemIds.some((id) => !isId(id))) throw refuse(400, "A line names no raw item.");
  const items = await RawItem.find({ _id: { $in: itemIds } }).select("name sku unit variants._id variants.combination variants.sku variants.unit").lean();
  const byId = new Map(items.map((i) => [String(i._id), i]));
  const lines = inLines.map((l, i) => {
    const item = byId.get(str(l.rawItemId));
    if (!item) throw refuse(400, `Line ${i + 1}: that raw item is not in the register.`);
    const qty = num(l.quantity);
    if (qty === null || qty <= 0) throw refuse(400, `Line ${i + 1} (${item.name}): give a quantity above zero.`);
    let variant = null;
    if (str(l.variantId)) {
      variant = (item.variants || []).find((v) => String(v._id) === str(l.variantId)) || null;
      if (!variant) throw refuse(400, `Line ${i + 1} (${item.name}): that variant is not on the item.`);
    }
    return {
      _id: new mongoose.Types.ObjectId(),
      rawItemId: item._id, rawItemName: str(item.name), rawItemSku: str(item.sku),
      variantId: variant ? variant._id : null, variantCombination: variant ? (variant.combination || []).map(str) : [],
      quantity: qty, unit: str(l.unit) || str(variant?.unit) || str(item.unit) || "unit", note: str(l.note).slice(0, 500),
    };
  });
  const n = (order.materialRequests || []).length + 1;
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    requestNumber: `MR-${str(order.requestId) || String(order._id).slice(-6)}-${String(n).padStart(2, "0")}`,
    status: "open", reason, neededBy, lines,
    createdBy: personOf(actor), createdAt: new Date(),
  };
  /* an atomic push — the order's own `.save()` re-validates sixteen writers' worth of lines */
  await CustomerRequest.updateOne({ _id: order._id }, { $push: { materialRequests: doc } });
  const fresh = await CustomerRequest.findById(order._id).select(ORDER_SELECT).lean();
  const view = await viewOf(fresh);
  const created = view.requests.find((r) => r.id === String(doc._id)) || null;
  return { ...view, created };
}

async function cancel(companyId, moId, requestId, reason, actor) {
  const order = await orderForCompany(companyId, moId);
  const r = (order.materialRequests || []).find((x) => String(x._id) === str(requestId));
  if (!r) throw refuse(404, "That material request was not found on this order.");
  if (r.status === "cancelled") throw refuse(400, "That request is already cancelled.");
  const issued = await StockIssuance.exists({ manufacturingOrder: order._id, materialRequestId: r._id });
  if (issued) throw refuse(400, "The Store has already issued against this request — it cannot be cancelled. Raise a return in the Store if the material is not needed.");
  await CustomerRequest.updateOne(
    { _id: order._id, "materialRequests._id": r._id },
    { $set: { "materialRequests.$.status": "cancelled", "materialRequests.$.cancelledAt": new Date(), "materialRequests.$.cancelledBy": personOf(actor), "materialRequests.$.cancelReason": str(reason).slice(0, 500) } },
  );
  const fresh = await CustomerRequest.findById(order._id).select(ORDER_SELECT).lean();
  return viewOf(fresh);
}

/** The order's material story as a report: every request with its lines and issues, plus the free issues. */
async function reportForOrder(moId, { companyId = null } = {}) {
  const view = await listForOrder(moId, { companyId });
  return { ...view, generatedAt: new Date() };
}

module.exports = { listForOrder, create, cancel, reportForOrder, isId };
