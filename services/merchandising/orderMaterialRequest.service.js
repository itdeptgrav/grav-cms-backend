// services/merchandising/orderMaterialRequest.service.js
//
// MATERIAL REQUESTS A MERCHANDISER RAISES AGAINST A RELEASED ORDER (7 Oct 2026).
//
// Against an order Sales released, the merchandiser asks the Store to bring
// in raw material: which raw item and variant, how much, in what unit. The
// lines are suggested from the order's BOM and may be edited or typed from
// nothing — a product with no BOM is not a blocker.
//
// ── LIFECYCLE ────────────────────────────────────────────────────────────
//   draft  → the merchandiser's own: editable, withdrawable, not shown to
//            the Store;
//   open   → submitted: on the Store's Purchase register, received against;
//   partially_received / received → derived from what the Store received;
//   cancelled → withdrawn (allowed while draft, or open with nothing received).
//
// ── WHERE IT LIVES ───────────────────────────────────────────────────────
// On the order itself: `CustomerRequest.materialRequests[]`, the array PPC's
// own (issue-from-stock) requests already use, tagged `source: "merchandising"`.
// Same line shape, same numbering (`MR-<order>-NN`), no new collection — the
// cluster is at its collection cap.
//
// ── UNITS ────────────────────────────────────────────────────────────────
// A line's unit is one the raw item actually has: its registered unit, or a
// unit named by one of its (or its variant's) conversions — the same rule the
// merchandiser's BOM dialog applies. Anything else is refused by name.
//
// No vendor and no price anywhere: this asks for material, it does not buy it.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("../storePurchase/errors");
const orders = require("./orders.service");

const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const RawItem = () => model("RawItem", "../../models/CMS_Models/Inventory/Products/RawItem");
const GoodsReceipt = () => model("GoodsReceipt", "../../models/CMS_Models/StorePurchase/GoodsReceipt");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = (n) => Math.round(n * 10000) / 10000;
const personOf = (a) => ({ userId: str(a?.userId || a?.id), name: str(a?.name), email: str(a?.email).toLowerCase() });
const sameUnit = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();

const SOURCE = "merchandising";
const RAW_SELECT = "name sku unit unitConversions quantity variants._id variants.combination variants.sku variants.quantity variants.unitConversions";

/* One implementation of the unit rule: the order read's. */
const { unitOptionsFor } = orders;

/* ── THE VIEW ───────────────────────────────────────────────────────────── */

function lineView(l) {
  const requested = num(l.quantity) || 0;
  const received = num(l.receivedQuantity) || 0;
  const pending = Math.max(0, r4(requested - received));
  return {
    lineId: str(l._id),
    rawItemId: str(l.rawItemId), rawItemName: str(l.rawItemName), rawItemSku: str(l.rawItemSku),
    variantId: l.variantId ? str(l.variantId) : null,
    variantCombination: (l.variantCombination || []).map(str),
    variantLabel: (l.variantCombination || []).map(str).filter(Boolean).join(" · "),
    quantity: requested, unit: str(l.unit), note: str(l.note),
    receivedQuantity: r4(received), pending,
    status: received <= 0 ? "open" : pending > 0 ? "partial" : "received",
  };
}

/** The status a merchandising request stands in. */
function statusOf(r) {
  const stored = str(r.status);
  if (stored === "cancelled") return "cancelled";
  if (stored === "draft") return "draft";
  const lines = (r.lines || []).map(lineView);
  if (lines.length && lines.every((l) => l.status === "received")) return "received";
  if (lines.some((l) => l.receivedQuantity > 0)) return "partially_received";
  return "open";
}

/** What the merchandiser may still do with it.
    10 Oct 2026 (owner): a SUBMITTED request stays editable "till the Store
    person makes the GRN" — once a goods receipt is recorded against it,
    editing stops; withdrawing already did. */
function actionsOf(r) {
  const status = statusOf(r);
  const nothingReceived = !(r.lines || []).some((l) => (num(l.receivedQuantity) || 0) > 0) && !(r.receipts || []).length;
  return {
    edit: status === "draft" || (status === "open" && nothingReceived),
    submit: status === "draft",
    withdraw: status === "draft" || (status === "open" && nothingReceived),
  };
}

function requestView(r, order) {
  const lines = (r.lines || []).map(lineView);
  return {
    id: str(r._id),
    requestNumber: str(r.requestNumber),
    source: str(r.source || "ppc"),
    status: statusOf(r),
    actions: actionsOf(r),
    reason: str(r.reason), neededBy: r.neededBy || null,
    createdAt: r.createdAt || null, createdBy: r.createdBy || null,
    updatedAt: r.updatedAt || null,
    submittedAt: r.submittedAt || null, submittedBy: r.submittedBy || null,
    cancelledAt: r.cancelledAt || null, cancelledBy: r.cancelledBy || null, cancelReason: str(r.cancelReason),
    lines, lineCount: lines.length,
    totalRequested: r4(lines.reduce((n, l) => n + l.quantity, 0)),
    totalReceived: r4(lines.reduce((n, l) => n + l.receivedQuantity, 0)),
    linesPending: lines.filter((l) => l.status !== "received").length,
    receipts: (r.receipts || []).map((x) => ({
      id: str(x._id), goodsReceiptId: x.goodsReceiptId ? str(x.goodsReceiptId) : null,
      receiptNumber: str(x.receiptNumber), receivedAt: x.receivedAt || null, byName: str(x.byName),
      lines: (x.lines || []).map((y) => ({ lineId: str(y.lineId), quantity: num(y.quantity) || 0, unit: str(y.unit) })),
    })),
    order: order ? {
      id: str(order._id), orderRef: str(order.requestId),
      customerName: str(order.customerInfo?.name),
      deliveryDeadline: order.customerInfo?.deliveryDeadline || null,
      products: (order.items || []).map((i) => str(i.stockItemName)).filter(Boolean),
    } : null,
  };
}

const ofMerchandising = (order) => (order.materialRequests || []).filter((r) => str(r.source) === SOURCE);

async function listForOrder(ctx, { orderId } = {}) {
  const order = await orders.loadOwnedOrder(ctx, orderId);
  const requests = ofMerchandising(order).map((r) => requestView(r, order))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  /* Each line carries the units it may be edited into and what is on hand,
     so a draft reopened on the page offers what the picker offered. */
  const ids = [...new Set(requests.flatMap((r) => r.lines.map((l) => l.rawItemId)).filter(isId))];
  const items = ids.length ? await RawItem().find({ _id: { $in: ids } }).select(RAW_SELECT).lean() : [];
  const byId = new Map(items.map((i) => [str(i._id), i]));
  for (const r of requests) {
    for (const l of r.lines) {
      const item = byId.get(l.rawItemId);
      const v = item && l.variantId ? (item.variants || []).find((x) => str(x._id) === l.variantId) : null;
      l.unitOptions = item ? unitOptionsFor(item, v) : [];
      l.onHand = item ? r4(num(v ? v.quantity : item.quantity) || 0) : null;
    }
  }
  await attachReceiptsAndQc(requests);
  return { requests, order: requests[0]?.order || requestView({ lines: [] }, order).order };
}

/* ── WHAT THE STORE RECEIVED AND WHAT QC FOUND (10 Oct 2026, owner) ──────
   "As per the request made by the merchandiser, he should also see the QC
   checked status — correct, defectives and all." The goods receipts recorded
   against each request are read with their lines, QC's standing per receipt
   comes from the Store's own bridge (qcInspectionBridge), and both are
   folded back onto the request: per receipt (date, warehouse, QC text) and
   per request line (checked / passed / defective / remaining, summed over
   every receipt line that names this request line). Never throws — a
   failed read leaves the figures absent, not zero. */
async function attachReceiptsAndQc(requests) {
  const live = requests.filter((r) => (r.receipts || []).length);
  if (!live.length) return;
  try {
    const ids = live.map((r) => new mongoose.Types.ObjectId(r.id));
    const grns = await GoodsReceipt().find({ "materialRequest.requestId": { $in: ids }, status: { $ne: "VOID" } })
      .select("receiptNumber receiptDate createdAt recordedBy warehouseName locationCode locationName sourceType materialRequest lines").lean();
    const { qcStandingFor } = require("../storePurchase/qcInspectionBridge");
    const standing = await qcStandingFor(grns);
    const byRequest = new Map();
    for (const g of grns) { const k = str(g.materialRequest?.requestId); if (!byRequest.has(k)) byRequest.set(k, []); byRequest.get(k).push(g); }
    for (const r of live) {
      const mine = byRequest.get(r.id) || [];
      const grnById = new Map(mine.map((g) => [str(g._id), g]));
      r.receipts = r.receipts.map((x) => {
        const g = grnById.get(str(x.goodsReceiptId));
        const s = g ? standing.get(str(g._id)) : null;
        const p = s?.progress || null;
        return {
          ...x,
          receiptDate: g?.receiptDate || g?.createdAt || x.receivedAt,
          warehouseName: g?.warehouseName || "", location: g?.locationCode || g?.locationName || "",
          qc: g ? {
            state: p?.complete ? "complete" : p?.anyChecked ? "in-progress" : "not-started",
            text: p?.text || "Not checked yet", checkers: p?.checkers || [], lastAt: p?.lastAt || null,
          } : null,
        };
      });
      /* per request line: every receipt line that names it */
      const perLine = new Map();
      for (const g of mine) {
        const prog = standing.get(str(g._id))?.progress;
        const progLine = new Map((prog?.lines || []).map((pl) => [str(pl.lineId), pl]));
        for (const gl of g.lines || []) {
          const key = str(gl.sourceLineId);
          const q = progLine.get(str(gl._id));
          const acc = perLine.get(key) || { received: 0, checked: 0, passed: 0, defective: 0, unit: gl.poUnit || "" };
          acc.received = r4(acc.received + (num(gl.receivedQuantity) || 0));
          acc.checked = r4(acc.checked + (num(q?.checked) || 0));
          acc.passed = r4(acc.passed + (num(q?.passed) || 0));
          acc.defective = r4(acc.defective + (num(q?.defective) || 0));
          perLine.set(key, acc);
        }
      }
      let tot = { received: 0, checked: 0, passed: 0, defective: 0 };
      for (const l of r.lines) {
        const q = perLine.get(l.lineId);
        l.qc = q ? { ...q, remaining: Math.max(0, r4(q.received - q.checked)), state: q.checked <= 0 ? "not-started" : q.checked >= q.received ? "complete" : "in-progress" } : null;
        if (q) tot = { received: r4(tot.received + q.received), checked: r4(tot.checked + q.checked), passed: r4(tot.passed + q.passed), defective: r4(tot.defective + q.defective) };
      }
      r.qc = {
        ...tot, remaining: Math.max(0, r4(tot.received - tot.checked)),
        state: tot.received <= 0 ? "nothing-received" : tot.checked <= 0 ? "not-started" : tot.checked >= tot.received ? "complete" : "in-progress",
        receiptsChecked: r.receipts.filter((x) => x.qc?.state === "complete").length,
        receipts: r.receipts.length,
      };
    }
  } catch (err) {
    console.warn("[orderMaterialRequest] receipts/QC unavailable:", err?.message || err);
  }
}

/* ── ONE GOODS RECEIPT, AS THE MERCHANDISER MAY READ IT ──────────────────
   The Store's GRN routes need Store access, which a merchandiser does not
   hold; this reads the same document for a receipt recorded against one of
   THIS order's requests, plus QC's detail of it (labels and verdicts). */
async function receiptDocument(ctx, { orderId, requestId, grnId } = {}) {
  const { request } = await loadRequest(ctx, orderId, requestId);
  const mine = (request.receipts || []).some((x) => str(x.goodsReceiptId) === str(grnId));
  if (!mine || !isId(grnId)) throw fail("NOT_FOUND", "That goods receipt was not recorded against this request.");
  const grnDoc = require("../storePurchase/goodsReceiptDocument.service");
  const document = await grnDoc.document({ companyId: ctx.companyId }, grnId);
  let qc = null;
  try { qc = await require("../manufacturing/qcRawItemGrns").grnDetail(grnId); } catch (err) { console.warn("[orderMaterialRequest] QC detail unavailable:", err?.message || err); }
  return { document, qc };
}

/** The same receipt as a PDF (Buffer), for the merchandiser's download. */
async function receiptPdf(ctx, args) {
  const { document, qc } = await receiptDocument(ctx, args);
  const { buildDocumentPdf } = require("../mail/documentPdf");
  const fmt = (n) => (n === null || n === undefined ? "" : Number(n).toLocaleString("en-IN", { maximumFractionDigits: 4 }));
  const qcLine = new Map((qc?.lines || []).map((l) => [str(l.goodsReceiptLineId), l]));
  const pdf = await buildDocumentPdf({
    title: "Goods receipt", reference: document.grn.receiptNumber,
    subtitle: `Recorded against material request ${document.source?.requestNumber || ""} · order ${document.source?.orderRef || ""} · ${document.source?.customerName || ""}`,
    facts: [
      ["Receipt date", document.grn.receiptDate ? new Date(document.grn.receiptDate).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }) : ""],
      ["Recorded by", document.grn.recordedBy], ["Warehouse", document.grn.warehouseName], ["Location", document.grn.location || "Put-away pending"],
      ["Material request", document.source?.requestNumber], ["Order", document.source?.orderRef], ["Customer", document.source?.customerName],
      ["QC standing", qc?.totals?.status ? String(qc.totals.status).replace(/-/g, " ") : "not checked yet"],
    ],
    sections: [{
      heading: "Lines received, with QC's check",
      columns: [
        { key: "no", label: "#", width: 0.4 }, { key: "itemName", label: "Raw item", width: 2.2, bold: true }, { key: "variant", label: "Variant", width: 1.2 },
        { key: "received", label: "Received", width: 0.9, align: "right" }, { key: "unit", label: "Unit", width: 0.6 },
        { key: "checked", label: "Checked", width: 0.8, align: "right" }, { key: "passed", label: "Passed", width: 0.8, align: "right" }, { key: "defective", label: "Defective", width: 0.8, align: "right" },
      ],
      rows: (document.lines || []).map((l) => { const q = qcLine.get(str(l.id)); return { no: l.no, itemName: l.itemName, variant: l.variant || "—", received: fmt(l.received), unit: l.unit, checked: fmt(q?.checked ?? 0), passed: fmt(q?.passed ?? 0), defective: fmt(q?.defective ?? 0) }; }),
    }, ...(qc?.labels?.length ? [{
      heading: "Labels and verdicts",
      columns: [{ key: "sequence", label: "Label", width: 0.6 }, { key: "rawItemName", label: "Raw item", width: 2 }, { key: "variantLabel", label: "Variant", width: 1.2 }, { key: "qty", label: "Qty", width: 0.8, align: "right" }, { key: "status", label: "Verdict", width: 0.9 }, { key: "defects", label: "Defects", width: 1.8 }],
      rows: qc.labels.map((b) => ({ sequence: b.sequence, rawItemName: b.rawItemName, variantLabel: b.variantLabel || "—", qty: `${fmt(b.quantity)} ${b.unit || ""}`, status: b.status, defects: (b.defects || []).map((d) => d.name || d.code || d).join(", ") })),
    }] : [])],
    notes: document.grn.notes || "",
    footer: "Goods receipt · Store → Merchandising",
  });
  return { pdf, fileName: `${str(document.grn.receiptNumber).replace(/\//g, "-")}.pdf` };
}

/** `Map<orderId, {count, draft, open, received}>` for the register rows. */
async function countForOrders(ctx, orderIds) {
  const ids = orderIds.filter(isId);
  const out = new Map();
  if (!ids.length) return out;
  const rows = await CustomerRequest().find({ _id: { $in: ids } }).select("materialRequests").lean();
  for (const r of rows) {
    const mine = ofMerchandising(r);
    const statuses = mine.map(statusOf);
    out.set(str(r._id), {
      count: mine.length,
      draft: statuses.filter((s) => s === "draft").length,
      open: statuses.filter((s) => s === "open" || s === "partially_received").length,
      received: statuses.filter((s) => s === "received").length,
    });
  }
  return out;
}
orders.registerMaterialRequestCounter(countForOrders);

/* ── BUILDING THE LINES ─────────────────────────────────────────────────── */

async function buildLines(inLines) {
  const rows = Array.isArray(inLines) ? inLines : [];
  if (!rows.length) throw fail("VALIDATION", "Add at least one raw item.", { field: "lines" });
  if (rows.length > 60) throw fail("VALIDATION", "A request carries at most 60 lines.", { field: "lines" });

  const itemIds = [...new Set(rows.map((l) => str(l?.rawItemId)))];
  if (itemIds.some((id) => !isId(id))) throw fail("VALIDATION", "A line names no raw item.", { field: "lines" });
  const items = await RawItem().find({ _id: { $in: itemIds } }).select(RAW_SELECT).lean();
  const byId = new Map(items.map((i) => [str(i._id), i]));

  const seen = new Set();
  return rows.map((l, i) => {
    const item = byId.get(str(l.rawItemId));
    if (!item) throw fail("VALIDATION", `Line ${i + 1}: that raw item is not in the register.`, { field: "lines", index: i });
    const qty = num(l.quantity);
    if (qty === null || qty <= 0) throw fail("VALIDATION", `Line ${i + 1} (${item.name}): give a quantity above zero.`, { field: "lines", index: i });
    let variant = null;
    if (str(l.variantId)) {
      variant = (item.variants || []).find((v) => str(v._id) === str(l.variantId)) || null;
      if (!variant) throw fail("VALIDATION", `Line ${i + 1} (${item.name}): that variant is not on the item.`, { field: "lines", index: i });
    }
    const options = unitOptionsFor(item, variant);
    const unit = str(l.unit) || str(item.unit) || "";
    if (!unit || !options.some((u) => sameUnit(u, unit))) {
      throw fail("VALIDATION",
        `Line ${i + 1} (${item.name}): "${unit || "no unit"}" is not a unit of this item. Use ${options.join(", ") || "its registered unit"}.`,
        { field: "unit", index: i, options });
    }
    const dupKey = `${str(item._id)}:${variant ? str(variant._id) : ""}`;
    if (seen.has(dupKey)) throw fail("VALIDATION", `Line ${i + 1} (${item.name}) repeats an earlier line. Combine the quantities.`, { field: "lines", index: i });
    seen.add(dupKey);
    const existingId = str(l.lineId);
    return {
      _id: isId(existingId) ? new mongoose.Types.ObjectId(existingId) : new mongoose.Types.ObjectId(),
      rawItemId: item._id, rawItemName: str(item.name), rawItemSku: str(item.sku),
      variantId: variant ? variant._id : null,
      variantCombination: variant ? (variant.combination || []).map(str) : [],
      quantity: qty, unit: options.find((u) => sameUnit(u, unit)) || unit,
      note: str(l.note).slice(0, 500),
      receivedQuantity: 0,
    };
  });
}

async function loadRequest(ctx, orderId, requestId) {
  const order = await orders.loadOwnedOrder(ctx, orderId);
  const request = ofMerchandising(order).find((r) => str(r._id) === str(requestId));
  if (!request) throw fail("NOT_FOUND", "Material request not found.");
  return { order, request };
}

async function fresh(orderId, requestId) {
  const order = await CustomerRequest().findById(orderId).lean();
  const r = ofMerchandising(order).find((x) => str(x._id) === str(requestId));
  return { request: requestView(r, order), replayed: false };
}

/* ── CREATE (A DRAFT, OR SUBMITTED AT ONCE) ─────────────────────────────── */

async function create(ctx, { orderId, lines: inLines, note, neededBy, submit = false, idempotencyKey, actor } = {}) {
  const order = await orders.loadOwnedOrder(ctx, orderId);

  const key = str(idempotencyKey);
  if (key) {
    const dup = ofMerchandising(order).find((r) => str(r.idempotencyKey) === key);
    if (dup) return { request: requestView(dup, order), replayed: true };
  }
  const needed = neededBy ? new Date(neededBy) : null;
  if (needed && Number.isNaN(needed.getTime())) throw fail("VALIDATION", "The needed-by date is not valid.", { field: "neededBy" });
  const lines = await buildLines(inLines);

  const n = (order.materialRequests || []).length + 1;
  const now = new Date();
  const doc = {
    _id: new mongoose.Types.ObjectId(),
    requestNumber: `MR-${str(order.requestId) || str(order._id).slice(-6)}-${String(n).padStart(2, "0")}`,
    source: SOURCE, companyId: ctx.companyId,
    status: submit ? "open" : "draft",
    reason: str(note).slice(0, 1000) || `Material for order ${str(order.requestId)}`,
    neededBy: needed || order.customerInfo?.deliveryDeadline || null,
    idempotencyKey: key,
    lines, receipts: [],
    createdBy: personOf(actor), createdAt: now, updatedAt: now,
    ...(submit ? { submittedAt: now, submittedBy: personOf(actor) } : {}),
  };
  await CustomerRequest().updateOne({ _id: order._id }, { $push: { materialRequests: doc } });
  return fresh(order._id, doc._id);
}

/* ── EDIT A DRAFT ───────────────────────────────────────────────────────── */

async function update(ctx, { orderId, requestId, lines: inLines, note, neededBy, actor } = {}) {
  const { order, request } = await loadRequest(ctx, orderId, requestId);
  if (!actionsOf(request).edit) {
    throw fail("LIFECYCLE_BLOCKED", `${request.requestNumber} is ${statusOf(request).replace(/_/g, " ")} and can no longer be edited: the Store has recorded a goods receipt against it. Raise a further request for anything still missing.`);
  }
  const needed = neededBy ? new Date(neededBy) : null;
  if (needed && Number.isNaN(needed.getTime())) throw fail("VALIDATION", "The needed-by date is not valid.", { field: "neededBy" });
  const lines = await buildLines(inLines);
  await CustomerRequest().updateOne(
    { _id: order._id },
    {
      $set: {
        "materialRequests.$[r].lines": lines,
        "materialRequests.$[r].updatedAt": new Date(),
        ...(note !== undefined ? { "materialRequests.$[r].reason": str(note).slice(0, 1000) || `Material for order ${str(order.requestId)}` } : {}),
        ...(neededBy !== undefined ? { "materialRequests.$[r].neededBy": needed } : {}),
      },
    },
    { arrayFilters: [{ "r._id": request._id }] },
  );
  return fresh(order._id, request._id);
}

/* ── SUBMIT A DRAFT TO THE STORE ────────────────────────────────────────── */

async function submit(ctx, { orderId, requestId, actor } = {}) {
  const { order, request } = await loadRequest(ctx, orderId, requestId);
  if (statusOf(request) === "open") return { ...(await fresh(order._id, request._id)), replayed: true };
  if (!actionsOf(request).submit) {
    throw fail("LIFECYCLE_BLOCKED", `${request.requestNumber} is ${statusOf(request).replace(/_/g, " ")} and cannot be submitted.`);
  }
  if (!(request.lines || []).length) throw fail("VALIDATION", "Add at least one raw item before submitting.", { field: "lines" });
  const now = new Date();
  await CustomerRequest().updateOne(
    { _id: order._id },
    { $set: { "materialRequests.$[r].status": "open", "materialRequests.$[r].submittedAt": now, "materialRequests.$[r].submittedBy": personOf(actor), "materialRequests.$[r].updatedAt": now } },
    { arrayFilters: [{ "r._id": request._id }] },
  );
  return fresh(order._id, request._id);
}

/* ── WITHDRAW ───────────────────────────────────────────────────────────── */

async function withdraw(ctx, { orderId, requestId, reason, actor } = {}) {
  const { order, request } = await loadRequest(ctx, orderId, requestId);
  if (statusOf(request) === "cancelled") return { ...(await fresh(order._id, request._id)), replayed: true };
  if (!actionsOf(request).withdraw) {
    throw fail("LIFECYCLE_BLOCKED", `${request.requestNumber} has material received against it and cannot be withdrawn.`);
  }
  const now = new Date();
  await CustomerRequest().updateOne(
    { _id: order._id },
    { $set: { "materialRequests.$[r].status": "cancelled", "materialRequests.$[r].cancelledAt": now, "materialRequests.$[r].cancelledBy": personOf(actor), "materialRequests.$[r].cancelReason": str(reason).slice(0, 500), "materialRequests.$[r].updatedAt": now } },
    { arrayFilters: [{ "r._id": request._id }] },
  );
  return fresh(order._id, request._id);
}

module.exports = {
  SOURCE, listForOrder, countForOrders, create, update, submit, withdraw, receiptDocument, receiptPdf,
  /* kept under its old name for the route that first called it */
  raise: create,
  requestView, statusOf, actionsOf, lineView, ofMerchandising, unitOptionsFor,
};
