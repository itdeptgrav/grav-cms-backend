// services/manufacturing/qcRawItemGrns.js
//
// RAW-MATERIAL QC, GRN BY GRN  (8 Oct 2026)
//
// The Store records a merchandiser's material request as a goods receipt (a
// MATERIAL_REQUEST GRN) and prints one label per roll / packet at that moment;
// each label carries the GRN it was received under (`Barcode.goodsReceiptId`).
// QC checks the material AFTER the GRN, label by label. So for raw material the
// unit of QC work is the GRN, the way the manufacturing order is the unit of
// garment QC — and this module reads that book:
//
//   receiptOfLabel(b)   which GRN a scanned label was received under, with the
//                       request and the order it serves — what the Inspect
//                       screen shows after a scan and what the save records;
//   listGrns(...)       every material-request GRN with how much is to check
//                       and how much is done (per unit, never summed across);
//   grnDetail(id)       one GRN, line by line and label by label.
//
// Figures: "to check" is what the GRN RECEIVED (the actual counted quantity,
// in the line's unit); "checked" is the standing QC records on that GRN's
// labels. Nothing is guessed from a requirement here — the roll either arrived
// on this receipt or it did not.
"use strict";

const mongoose = require("mongoose");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const QCRawItemInspection = require("../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const str = (v) => String(v ?? "").trim();
const idStr = (v) => (v ? String(v) : "");
const TOL = 0.0001;

const KIND = Object.freeze({ MATERIAL: "material-request", PURCHASE: "purchase", CUSTOMER: "customer-material" });
const kindOf = (g) => (g?.sourceType === "MATERIAL_REQUEST" ? KIND.MATERIAL : g?.sourceType === "CUSTOMER_MATERIAL" ? KIND.CUSTOMER : KIND.PURCHASE);

/* A label that is live stock: activated, or printed before identity states
   existed (an absent state counts as usable, as everywhere else), and not voided. */
const LIVE_LABEL = Object.freeze({
  voidedAt: null,
  $or: [{ identityState: "ACTIVATED" }, { identityState: null }, { identityState: { $exists: false } }],
});

const GRN_SELECT = "receiptNumber receiptDate sourceType status poNumber supplierName materialRequest sourceDocumentNumber lines recordedBy warehouseName notes createdAt";

/* ── WHICH GRN IS THIS LABEL FROM ─────────────────────────────────────────── */

/**
 * The receipt a scanned label was printed under, or null for a label printed
 * from stock on hand (an honest absence, not a gap).
 */
async function receiptOfLabel(b) {
  const grnId = b?.goodsReceiptId || b?.customerMaterial?.goodsReceiptId || null;
  if (!grnId) return null;
  const g = await GoodsReceipt.findById(grnId).select(GRN_SELECT).lean().catch(() => null);
  if (!g) return null;
  const lineId = idStr(b.goodsReceiptLineId || b.customerMaterial?.goodsReceiptLineId);
  const line = (g.lines || []).find((l) => idStr(l._id) === lineId)
    /* a GRN the checker chose for a label that named none: the line is the one carrying the label's material */
    || (!lineId && b.rawItem ? (g.lines || []).find((l) => idStr(l.rawItemId) === idStr(b.rawItem) && (!l.variantId || !b.variantId || idStr(l.variantId) === idStr(b.variantId))) : null)
    || null;
  const kind = kindOf(g);
  const mr = g.materialRequest || {};
  let order = null;
  if (kind === KIND.MATERIAL && mr.customerRequestId) {
    const mo = await CustomerRequest.findById(mr.customerRequestId)
      .select("requestId customerInfo.name customerInfo.deliveryDeadline status").lean().catch(() => null);
    if (mo) order = { manufacturingOrderId: idStr(mo._id), moNumber: mo.requestId ? `MO-${mo.requestId}` : "", requestId: str(mo.requestId), customerName: str(mo.customerInfo?.name), deliveryDate: mo.customerInfo?.deliveryDeadline || null, status: str(mo.status) };
  }
  return {
    goodsReceiptId: idStr(g._id),
    receiptNumber: str(g.receiptNumber),
    receiptDate: g.receiptDate || g.createdAt || null,
    recordedBy: str(g.recordedBy?.name),
    kind,
    /* the source it discharged */
    requestId: mr.requestId ? idStr(mr.requestId) : null,
    requestNumber: str(mr.requestNumber || (kind === KIND.MATERIAL ? g.sourceDocumentNumber : "")),
    orderRef: str(mr.orderRef) || str(order?.requestId),
    customerRequestId: mr.customerRequestId ? idStr(mr.customerRequestId) : null,
    poNumber: kind === KIND.PURCHASE ? str(g.poNumber) : "",
    supplierName: kind === KIND.PURCHASE ? str(g.supplierName) : "",
    order,
    line: line ? {
      goodsReceiptLineId: idStr(line._id), itemName: str(line.itemName), unit: str(line.poUnit),
      received: r4(line.receivedQuantity), invoiced: line.invoicedQuantity === null || line.invoicedQuantity === undefined ? null : r4(line.invoicedQuantity),
    } : null,
    href: `/qc/dashboard/orders/grn/${idStr(g._id)}`,
    storeHref: `/store/dashboard/operations/goods-receipts/${idStr(g._id)}/document`,
  };
}

/* ── GRNs THAT CARRY A MATERIAL (8 Oct 2026, owner) ─────────────────────────
   A label printed from stock on hand names no receipt. When QC scans one, the
   screen offers the material-request GRNs whose lines carry that raw item and
   variant, so the checker can say which receipt the roll belongs to; saving
   against one links the label to it. A line with no variant matches any
   variant of the item, as the requirement matching already does. */
async function grnsForMaterial({ rawItemId, variantId = null, fallbackToAll = true }) {
  if (!isId(rawItemId)) return [];
  let grns = await GoodsReceipt.find({ sourceType: "MATERIAL_REQUEST", status: { $ne: "VOID" }, "lines.rawItemId": oid(rawItemId) })
    .select(GRN_SELECT).sort({ receiptDate: -1, _id: -1 }).limit(50).lean();
  /* No receipt carries this material (owner, 8 Oct 2026): offer every recent
     material-request GRN anyway, marked as not carrying it, so the checker can
     still say which delivery the roll came with and link it. */
  let carries = true;
  if (!grns.length && fallbackToAll) {
    carries = false;
    grns = await GoodsReceipt.find({ sourceType: "MATERIAL_REQUEST", status: { $ne: "VOID" } })
      .select(GRN_SELECT).sort({ receiptDate: -1, _id: -1 }).limit(50).lean();
  }
  const ids = grns.map((g) => idStr(g._id));
  const orderIds = [...new Set(grns.map((g) => idStr(g.materialRequest?.customerRequestId)).filter(isId))];
  const [checks, orders] = await Promise.all([
    checksByGrn(ids, new Map(grns.map((g) => [idStr(g._id), g]))),
    orderIds.length ? CustomerRequest.find({ _id: { $in: orderIds.map(oid) } }).select("requestId customerInfo.name status").lean() : [],
  ]);
  const orderById = new Map(orders.map((o) => [idStr(o._id), o]));
  const out = [];
  for (const g of grns) {
    const line = (g.lines || []).find((l) => idStr(l.rawItemId) === idStr(rawItemId) && (!l.variantId || !variantId || idStr(l.variantId) === idStr(variantId))) || null;
    if (!line && carries) continue;
    const mo = orderById.get(idStr(g.materialRequest?.customerRequestId)) || null;
    const cl = line ? (checks.get(idStr(g._id))?.byLine.get(idStr(line._id)) || null) : null;
    out.push({
      goodsReceiptId: idStr(g._id), receiptNumber: str(g.receiptNumber), receiptDate: g.receiptDate || g.createdAt || null,
      requestId: idStr(g.materialRequest?.requestId) || null, requestNumber: str(g.materialRequest?.requestNumber || g.sourceDocumentNumber),
      orderRef: str(g.materialRequest?.orderRef || mo?.requestId),
      manufacturingOrderId: mo ? idStr(mo._id) : (idStr(g.materialRequest?.customerRequestId) || null),
      moNumber: mo?.requestId ? `MO-${mo.requestId}` : "", customerName: str(mo?.customerInfo?.name),
      /* whether a line of this receipt carries the label's material */
      carriesMaterial: Boolean(line),
      materials: (g.lines || []).map((l) => str(l.itemName)).filter(Boolean),
      line: line ? {
        goodsReceiptLineId: idStr(line._id), itemName: str(line.itemName), variantLabel: (line.variantCombination || []).map(str).filter(Boolean).join(" \u00b7 "),
        unit: str(line.poUnit), received: r4(line.receivedQuantity), checked: cl?.checkedQty || 0, remaining: r4(Math.max(0, r4(line.receivedQuantity) - (cl?.checkedQty || 0))),
      } : null,
      href: `/qc/dashboard/orders/grn/${idStr(g._id)}`,
    });
  }
  return out;
}

/** The receipt summary for a GRN the checker chose, in the same shape `receiptOfLabel` answers. */
async function receiptById(grnId, b) {
  if (!isId(grnId)) return null;
  return receiptOfLabel({ goodsReceiptId: grnId, goodsReceiptLineId: null, customerMaterial: null, ...(b ? { rawItem: b.rawItem, variantId: b.variantId } : {}) });
}

/* ── THE ROLLUPS ─────────────────────────────────────────────────────────── */

/** Live labels per GRN (and per GRN line): count and quantity by unit. */
async function labelsByGrn(grnIds) {
  if (!grnIds.length) return new Map();
  const rows = await Barcode.aggregate([
    { $match: { goodsReceiptId: { $in: grnIds.map(oid) }, ...LIVE_LABEL } },
    { $group: { _id: { grn: "$goodsReceiptId", line: "$goodsReceiptLineId", unit: { $ifNull: ["$unit", ""] } }, labels: { $sum: 1 }, quantity: { $sum: { $ifNull: ["$quantity", 0] } }, ids: { $push: "$_id" } } },
  ]);
  const out = new Map();
  for (const r of rows) {
    const k = idStr(r._id.grn);
    const cur = out.get(k) || { labels: 0, byLine: new Map(), ids: [] };
    cur.labels += r.labels;
    cur.ids.push(...r.ids.map(idStr));
    const lk = idStr(r._id.line);
    const line = cur.byLine.get(lk) || { labels: 0, quantity: 0, unit: r._id.unit, ids: [] };
    line.labels += r.labels; line.quantity = r4(line.quantity + r.quantity); line.ids.push(...r.ids.map(idStr));
    cur.byLine.set(lk, line);
    out.set(k, cur);
  }
  return out;
}

/** Standing QC records per GRN: by line, by unit, and which labels they cover. */
async function checksByGrn(grnIds, grnById = null) {
  if (!grnIds.length) return new Map();
  const recs = await QCRawItemInspection.find({ goodsReceiptId: { $in: grnIds.map(oid) }, superseded: { $ne: true } })
    .select("goodsReceiptId goodsReceiptLineId barcodeId rawItemId variantId unit quantity passedQuantity defectiveQuantity status defects inspectedAt inspectedByName").lean();
  /* a record with no line (a label linked on the spot) sits on the line that
     carries its material, when the receipt has one */
  const lineOf = (r) => {
    const own = idStr(r.goodsReceiptLineId);
    const g = grnById?.get(idStr(r.goodsReceiptId));
    if (!g || own) return own;
    const l = (g.lines || []).find((x) => idStr(x.rawItemId) === idStr(r.rawItemId) && (!x.variantId || !r.variantId || idStr(x.variantId) === idStr(r.variantId)));
    return l ? idStr(l._id) : "";
  };
  const out = new Map();
  for (const r of recs) {
    const k = idStr(r.goodsReceiptId);
    const cur = out.get(k) || { stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defectiveStickers: 0, byUnit: new Map(), byLine: new Map(), labelIds: new Set(), lastAt: null, checkers: new Set() };
    cur.stickers += 1; cur.checkedQty = r4(cur.checkedQty + r.quantity); cur.passedQty = r4(cur.passedQty + r.passedQuantity); cur.defectiveQty = r4(cur.defectiveQty + r.defectiveQuantity);
    if (r.status === "defective") cur.defectiveStickers += 1;
    cur.labelIds.add(idStr(r.barcodeId));
    if (r.inspectedByName) cur.checkers.add(r.inspectedByName);
    if (!cur.lastAt || r.inspectedAt > cur.lastAt) cur.lastAt = r.inspectedAt;
    const u = str(r.unit).toLowerCase();
    const bu = cur.byUnit.get(u) || { unit: str(r.unit), stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0 };
    bu.stickers += 1; bu.checkedQty = r4(bu.checkedQty + r.quantity); bu.passedQty = r4(bu.passedQty + r.passedQuantity); bu.defectiveQty = r4(bu.defectiveQty + r.defectiveQuantity);
    cur.byUnit.set(u, bu);
    const lk = lineOf(r);
    const bl = cur.byLine.get(lk) || { stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0, defectiveStickers: 0, labelIds: new Set(), reasons: new Map(), lastAt: null };
    bl.stickers += 1; bl.checkedQty = r4(bl.checkedQty + r.quantity); bl.passedQty = r4(bl.passedQty + r.passedQuantity); bl.defectiveQty = r4(bl.defectiveQty + r.defectiveQuantity);
    if (r.status === "defective") bl.defectiveStickers += 1;
    bl.labelIds.add(idStr(r.barcodeId));
    for (const d of r.defects || []) { const x = bl.reasons.get(d.code) || { code: d.code, name: d.name, stickers: 0, quantity: 0 }; x.stickers += 1; x.quantity = r4(x.quantity + r.defectiveQuantity); bl.reasons.set(d.code, x); }
    if (!bl.lastAt || r.inspectedAt > bl.lastAt) bl.lastAt = r.inspectedAt;
    cur.byLine.set(lk, bl);
    out.set(k, cur);
  }
  return out;
}

/* "To check" per unit is the GRN's received figure; "checked" is the records.
   A GRN is complete when every unit it received has been checked in full;
   in progress when anything has; otherwise not started. */
function progressOf(g, checks) {
  const toCheck = new Map();
  for (const l of g.lines || []) {
    const u = str(l.poUnit).toLowerCase();
    const cur = toCheck.get(u) || { unit: str(l.poUnit), received: 0 };
    cur.received = r4(cur.received + (l.receivedQuantity || 0));
    toCheck.set(u, cur);
  }
  const byUnit = [...toCheck.entries()].map(([u, t]) => {
    const c = checks?.byUnit.get(u) || { stickers: 0, checkedQty: 0, passedQty: 0, defectiveQty: 0 };
    return { unit: t.unit, received: t.received, checked: c.checkedQty, passed: c.passedQty, defective: c.defectiveQty, remaining: r4(Math.max(0, t.received - c.checkedQty)), stickers: c.stickers };
  });
  const anyChecked = byUnit.some((u) => u.checked > TOL) || (checks?.stickers || 0) > 0;
  const allDone = byUnit.length > 0 && byUnit.every((u) => u.remaining <= TOL);
  const status = allDone ? "complete" : anyChecked ? "in-progress" : "not-started";
  return { byUnit, status, hasDefects: (checks?.defectiveStickers || 0) > 0 };
}

/* ── THE LIST ────────────────────────────────────────────────────────────── */

const STATUS_FILTERS = Object.freeze(["all", "not-started", "in-progress", "complete", "defects"]);

/**
 * Every material-request GRN, newest first, with its QC standing.
 * `q` matches the GRN number, the request, the order, the customer and the
 * materials; `status` is one of STATUS_FILTERS; `customer` narrows to one.
 */
async function listGrns({ q = "", status = "all", customer = "" } = {}) {
  const grns = await GoodsReceipt.find({ sourceType: "MATERIAL_REQUEST", status: { $ne: "VOID" } })
    .select(GRN_SELECT).sort({ receiptDate: -1, _id: -1 }).limit(500).lean();
  const ids = grns.map((g) => idStr(g._id));
  const orderIds = [...new Set(grns.map((g) => idStr(g.materialRequest?.customerRequestId)).filter(isId))];
  const grnById = new Map(grns.map((g) => [idStr(g._id), g]));
  const [labels, checks, orders] = await Promise.all([
    labelsByGrn(ids), checksByGrn(ids, grnById),
    orderIds.length ? CustomerRequest.find({ _id: { $in: orderIds.map(oid) } }).select("requestId customerInfo.name customerInfo.deliveryDeadline status").lean() : [],
  ]);
  const orderById = new Map(orders.map((o) => [idStr(o._id), o]));

  const rows = grns.map((g) => {
    const k = idStr(g._id);
    const mo = orderById.get(idStr(g.materialRequest?.customerRequestId)) || null;
    const lab = labels.get(k) || { labels: 0, ids: [] };
    const chk = checks.get(k) || null;
    const checkedLabels = chk ? [...chk.labelIds].filter((id) => lab.ids.includes(id)).length : 0;
    const p = progressOf(g, chk);
    return {
      goodsReceiptId: k,
      receiptNumber: str(g.receiptNumber),
      receiptDate: g.receiptDate || g.createdAt || null,
      recordedBy: str(g.recordedBy?.name),
      warehouseName: str(g.warehouseName),
      requestId: idStr(g.materialRequest?.requestId) || null,
      requestNumber: str(g.materialRequest?.requestNumber || g.sourceDocumentNumber),
      orderRef: str(g.materialRequest?.orderRef || mo?.requestId),
      manufacturingOrderId: mo ? idStr(mo._id) : (idStr(g.materialRequest?.customerRequestId) || null),
      moNumber: mo?.requestId ? `MO-${mo.requestId}` : "",
      customerName: str(mo?.customerInfo?.name) || "—",
      deliveryDate: mo?.customerInfo?.deliveryDeadline || null,
      orderStatus: str(mo?.status),
      lines: (g.lines || []).length,
      materials: (g.lines || []).map((l) => str(l.itemName)).filter(Boolean),
      labels: { total: lab.labels, checked: checkedLabels, remaining: Math.max(0, lab.labels - checkedLabels) },
      byUnit: p.byUnit,
      stickers: chk?.stickers || 0,
      defectiveStickers: chk?.defectiveStickers || 0,
      checkers: chk ? chk.checkers.size : 0,
      lastAt: chk?.lastAt || null,
      status: p.status,
      hasDefects: p.hasDefects,
      href: `/qc/dashboard/orders/grn/${k}`,
      storeHref: `/store/dashboard/operations/goods-receipts/${k}/document`,
    };
  });

  const needle = str(q).toLowerCase();
  let out = rows;
  if (needle) out = out.filter((r) => [r.receiptNumber, r.requestNumber, r.orderRef, r.moNumber, r.customerName, ...r.materials].some((v) => String(v || "").toLowerCase().includes(needle)));
  if (status === "defects") out = out.filter((r) => r.hasDefects);
  else if (status !== "all" && STATUS_FILTERS.includes(status)) out = out.filter((r) => r.status === status);
  if (str(customer)) out = out.filter((r) => r.customerName === str(customer));

  return {
    grns: out,
    counts: {
      all: rows.length,
      notStarted: rows.filter((r) => r.status === "not-started").length,
      inProgress: rows.filter((r) => r.status === "in-progress").length,
      complete: rows.filter((r) => r.status === "complete").length,
      defects: rows.filter((r) => r.hasDefects).length,
      labels: rows.reduce((n, r) => n + r.labels.total, 0),
      labelsChecked: rows.reduce((n, r) => n + r.labels.checked, 0),
    },
    customers: [...new Set(rows.map((r) => r.customerName).filter((c) => c && c !== "—"))].sort(),
  };
}

/* ── ONE GRN ─────────────────────────────────────────────────────────────── */

async function grnDetail(grnId) {
  if (!isId(grnId)) return null;
  const g = await GoodsReceipt.findById(grnId).select(GRN_SELECT).lean();
  if (!g || g.sourceType !== "MATERIAL_REQUEST") return null;
  const k = idStr(g._id);
  const [labels, checks, mo, records] = await Promise.all([
    labelsByGrn([k]), checksByGrn([k], new Map([[k, g]])),
    g.materialRequest?.customerRequestId
      ? CustomerRequest.findById(g.materialRequest.customerRequestId).select("requestId customerInfo.name customerInfo.deliveryDeadline status items.stockItemName").lean().catch(() => null)
      : null,
    QCRawItemInspection.find({ goodsReceiptId: g._id, superseded: { $ne: true } }).sort({ inspectedAt: -1 }).lean(),
  ]);
  const lab = labels.get(k) || { labels: 0, byLine: new Map(), ids: [] };
  const chk = checks.get(k) || null;

  /* Every live label on this GRN, with its verdict if it has one. */
  const labelDocs = lab.ids.length
    ? await Barcode.find({ _id: { $in: lab.ids.map(oid) } }).select("goodsReceiptLineId rawItemName variantCombination quantity unit sessionSequence printedAt").lean()
    : [];
  const verdictByLabel = new Map(records.map((r) => [idStr(r.barcodeId), r]));
  const labelRows = labelDocs.map((l) => {
    const v = verdictByLabel.get(idStr(l._id)) || null;
    return {
      barcodeId: idStr(l._id), goodsReceiptLineId: idStr(l.goodsReceiptLineId), sequence: l.sessionSequence || null,
      rawItemName: str(l.rawItemName), variantLabel: (l.variantCombination || []).join(" · "), quantity: r4(l.quantity), unit: str(l.unit),
      status: v ? v.status : "unchecked", passedQuantity: v ? r4(v.passedQuantity) : null, defectiveQuantity: v ? r4(v.defectiveQuantity) : null,
      inspectedAt: v?.inspectedAt || null, inspectedByName: str(v?.inspectedByName), defects: v ? (v.defects || []).map((d) => d.name || d.code) : [],
    };
  }).sort((a, b) => (a.sequence || 0) - (b.sequence || 0));

  const lines = (g.lines || []).map((l, i) => {
    const lk = idStr(l._id);
    const ll = lab.byLine.get(lk) || { labels: 0, quantity: 0, ids: [] };
    const cl = chk?.byLine.get(lk) || null;
    const received = r4(l.receivedQuantity);
    const checked = cl?.checkedQty || 0;
    const labelsChecked = cl ? [...cl.labelIds].filter((id) => ll.ids.includes(id)).length : 0;
    return {
      no: i + 1, goodsReceiptLineId: lk,
      rawItemId: idStr(l.rawItemId) || null, variantId: idStr(l.variantId) || null,
      itemName: str(l.itemName), sku: str(l.sku), variantLabel: (l.variantCombination || []).map(str).filter(Boolean).join(" · "),
      unit: str(l.poUnit),
      received, invoiced: l.invoicedQuantity === null || l.invoicedQuantity === undefined ? null : r4(l.invoicedQuantity),
      labels: { total: ll.labels, quantity: ll.quantity, checked: labelsChecked, remaining: Math.max(0, ll.labels - labelsChecked) },
      checked, passed: cl?.passedQty || 0, defective: cl?.defectiveQty || 0,
      remaining: r4(Math.max(0, received - checked)),
      defectiveStickers: cl?.defectiveStickers || 0,
      reasons: cl ? [...cl.reasons.values()].sort((a, b) => b.quantity - a.quantity) : [],
      lastAt: cl?.lastAt || null,
      status: received - checked <= TOL && received > 0 ? "complete" : checked > TOL ? "in-progress" : "not-started",
    };
  });
  const p = progressOf(g, chk);

  return {
    grn: {
      goodsReceiptId: k, receiptNumber: str(g.receiptNumber), receiptDate: g.receiptDate || g.createdAt || null,
      recordedBy: str(g.recordedBy?.name), warehouseName: str(g.warehouseName), notes: str(g.notes),
      requestId: idStr(g.materialRequest?.requestId) || null, requestNumber: str(g.materialRequest?.requestNumber || g.sourceDocumentNumber),
      orderRef: str(g.materialRequest?.orderRef || mo?.requestId),
      storeHref: `/store/dashboard/operations/goods-receipts/${k}/document`,
      requestHref: g.materialRequest?.requestId ? `/store/dashboard/operations/material-requests/${idStr(g.materialRequest.requestId)}` : null,
    },
    order: mo ? {
      manufacturingOrderId: idStr(mo._id), moNumber: mo.requestId ? `MO-${mo.requestId}` : "", requestId: str(mo.requestId),
      customerName: str(mo.customerInfo?.name) || "—", deliveryDate: mo.customerInfo?.deliveryDeadline || null, status: str(mo.status),
      products: (mo.items || []).map((i) => str(i.stockItemName)).filter(Boolean).slice(0, 6),
      href: `/qc/dashboard/orders/${idStr(mo._id)}`,
    } : null,
    totals: {
      lines: lines.length, labels: lab.labels, labelsChecked: chk ? [...chk.labelIds].filter((id) => lab.ids.includes(id)).length : 0,
      stickers: chk?.stickers || 0, defectiveStickers: chk?.defectiveStickers || 0, checkers: chk ? [...chk.checkers] : [], lastAt: chk?.lastAt || null,
      byUnit: p.byUnit, status: p.status, hasDefects: p.hasDefects,
    },
    lines,
    labels: labelRows,
    records: records.map((r) => ({
      _id: idStr(r._id), inspectedAt: r.inspectedAt, inspectedByName: str(r.inspectedByName), barcodeId: idStr(r.barcodeId), goodsReceiptLineId: idStr(r.goodsReceiptLineId),
      rawItemName: str(r.rawItemName), variantLabel: str(r.variantLabel), quantity: r4(r.quantity), unit: str(r.unit),
      status: r.status, passedQuantity: r4(r.passedQuantity), defectiveQuantity: r4(r.defectiveQuantity), defects: r.defects || [], note: str(r.note),
    })),
  };
}

module.exports = { KIND, STATUS_FILTERS, receiptOfLabel, receiptById, grnsForMaterial, listGrns, grnDetail, progressOf };
