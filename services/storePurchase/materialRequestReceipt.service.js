// services/storePurchase/materialRequestReceipt.service.js
//
// THE STORE'S SIDE OF A MERCHANDISER'S MATERIAL REQUEST (7 Oct 2026).
//
// A material request is Merchandising's ask against a released order: raw
// item, variant, quantity, unit — no supplier, no price. It lives on the order
// (`CustomerRequest.materialRequests[]`, `source: "merchandising"`). The Store
// sees it on the Purchase register as a "Material request" record, opens it on
// its own page, and records goods receipts against it on its own receive page.
//
// ── THE RECEIPT IS A REAL GRN ────────────────────────────────────────────
// Numbered from the same GOODS_RECEIPT sequence, posted through the same
// `receiptPosting.postMovements` (RawItem on-hand, stock transactions, the
// shelf when one is named), written to the same `goodsreceipts` collection
// with `sourceType: MATERIAL_REQUEST`. The request's own lines then carry
// what has been received, and its status follows from them. Nothing here
// touches a purchase order or a supplier.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("./errors");
const posting = require("./receiptPosting.service");
const locStock = require("./locationStock.service");
const tenantContext = require("./tenantContext.service");
const unitOfWork = require("./unitOfWork.service");
const idempotencyService = require("./idempotency.service");
const mr = require("../merchandising/orderMaterialRequest.service");
const counts = require("./materialRequestSession.service");

const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const RawItem = () => model("RawItem", "../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = () => model("Warehouse", "../../models/CMS_Models/Inventory/Configurations/Warehouse");
const GoodsReceipt = () => model("GoodsReceipt", "../../models/CMS_Models/StorePurchase/GoodsReceipt");
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");

const ENTITY = "MATERIAL_REQUEST";
const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));
const num = (v) => (v === "" || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* ── WHICH REQUESTS THIS COMPANY MAY SEE ─────────────────────────────────
   Every merchandising request is stamped with the company that raised it. */
const ownedClause = (tenant) => ({
  materialRequests: { $elemMatch: { source: mr.SOURCE, companyId: tenant.companyId } },
});

async function loadOwned(tenant, requestId) {
  if (!isId(requestId)) throw fail("NOT_FOUND", "Material request not found.");
  const order = await CustomerRequest().findOne({
    "materialRequests._id": oid(requestId), ...ownedClause(tenant),
  }).lean();
  const request = order && (order.materialRequests || []).find((r) => str(r._id) === str(requestId));
  if (!order || !request || str(request.source) !== mr.SOURCE
      || str(request.companyId) !== str(tenant.companyId) || mr.statusOf(request) === "draft") {
    throw fail("NOT_FOUND", "Material request not found.");
  }
  return { order, request };
}

/* ── THE REGISTER ROWS ──────────────────────────────────────────────────── */

const STATUS_WORD = { draft: "DRAFT", open: "OPEN", partially_received: "PARTIALLY_RECEIVED", received: "RECEIVED", cancelled: "CANCELLED" };
const STAGE_OF = { draft: null, open: "on-order", partially_received: "on-order", received: "completed", cancelled: null };

function registerRow(order, r) {
  const v = mr.requestView(r, order);
  const open = v.status === "open" || v.status === "partially_received";
  return {
    id: v.id,
    recordType: "material-request",
    purchaseType: "material",
    reference: v.requestNumber,
    title: `${v.order.orderRef} · ${v.order.products.slice(0, 3).join(", ")}${v.order.products.length > 3 ? ` +${v.order.products.length - 3} more` : ""}`,
    orderRef: v.order.orderRef,
    requestedFor: v.order.customerName,
    supplierLabel: "",
    stage: STAGE_OF[v.status] || null,
    exactStatus: STATUS_WORD[v.status] || "OPEN",
    orderDate: v.createdAt,
    expectedDate: v.neededBy,
    lineCount: v.lineCount,
    linesAwaitingReceipt: v.linesPending,
    /* No value: nothing was bought through it. `null` is "not a figure". */
    totalAmount: null,
    currency: "INR",
    paymentStatus: null,
    totalReceived: v.totalReceived,
    items: v.lines.map((l) => ({
      itemName: l.variantLabel ? `${l.rawItemName} · ${l.variantLabel}` : l.rawItemName,
      unit: l.unit, quantity: l.quantity, receivedQuantity: l.receivedQuantity,
      status: l.status === "received" ? "COMPLETED" : l.status === "partial" ? "PARTIALLY_RECEIVED" : "PENDING",
    })),
    exceptionSummary: null, exceptionHref: null,
    nextAction: open
      ? { code: "RECORD_RECEIPT", label: "Record receipt", href: `/store/dashboard/operations/material-requests/${v.id}/receive` }
      : { code: "VIEW_REQUEST", label: v.status === "cancelled" ? "View request" : "View receipts", href: `/store/dashboard/operations/material-requests/${v.id}` },
    raisedBy: v.createdBy?.name || "",
  };
}

/**
 * The register's material-request rows, filtered the way the workspace
 * filters purchase orders: stage (all / on-order / completed), open or closed,
 * a search over the request number, the order, the customer and the lines.
 */
async function registerRows(tenant, { stage = "all", status = "open", search = "" } = {}) {
  const orders = await CustomerRequest().find(ownedClause(tenant))
    .select("requestId customerInfo.name customerInfo.deliveryDeadline items.stockItemName materialRequests")
    .sort({ updatedAt: -1 }).limit(300).lean();
  const rx = str(search) ? new RegExp(escapeRx(str(search)), "i") : null;
  const rows = [];
  for (const order of orders) {
    for (const r of mr.ofMerchandising(order)) {
      if (str(r.companyId) !== str(tenant.companyId)) continue;
      /* A draft is the merchandiser's own until submitted. */
      if (mr.statusOf(r) === "draft") continue;
      const row = registerRow(order, r);
      const closed = row.exactStatus === "CANCELLED";
      if (status === "closed" ? !closed : closed) continue;
      if (stage === "on-order" && row.stage !== "on-order") continue;
      if (stage === "completed" && row.stage !== "completed") continue;
      if (stage === "draft-orders" || stage === "to-source") continue;
      if (rx && !(rx.test(row.reference) || rx.test(row.orderRef) || rx.test(row.requestedFor)
        || row.items.some((i) => rx.test(i.itemName)))) continue;
      rows.push(row);
    }
  }
  rows.sort((a, b) => new Date(b.orderDate || 0) - new Date(a.orderDate || 0));
  return rows;
}

/* ── THE UNITS A LABEL MAY BE TYPED IN ──────────────────────────────────────
   `[{ unit, factor }]`, factor = how many of the LINE's unit one of `unit`
   makes, from the material's (and its variant's) direct conversions
   `{fromUnit, toUnit, quantity}` = "1 fromUnit is `quantity` toUnit". Only a
   conversion that touches the line's unit gives a choice — a chain is never
   guessed. The label panel converts into the line's unit before printing. */
function unitChoicesFor(item, variant, lineUnit) {
  const same = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();
  const out = [];
  const add = (unit, factor) => {
    if (!str(unit) || !(factor > 0) || same(unit, lineUnit) || out.some((c) => same(c.unit, unit))) return;
    out.push({ unit: str(unit), factor: r4(factor) });
  };
  const convs = [
    ...(variant?.unitConversions || []),
    ...(variant?.unitConversion?.toUnit ? [variant.unitConversion] : []),
    ...(item?.unitConversions || []),
  ];
  for (const c of convs) {
    const q = Number(c?.quantity);
    if (!(q > 0)) continue;
    if (same(c.toUnit, lineUnit)) add(c.fromUnit, q);
    else if (same(c.fromUnit, lineUnit)) add(c.toUnit, 1 / q);
  }
  return out;
}

/* ── ONE REQUEST, FOR ITS OWN PAGE ──────────────────────────────────────── */

async function detail(tenant, requestId) {
  const { order, request } = await loadOwned(tenant, requestId);
  const view = mr.requestView(request, order);

  const stockIds = [...new Set((order.items || []).map((i) => str(i.stockItemId)).filter(isId))];
  const stocks = stockIds.length
    ? await StockItem().find({ _id: { $in: stockIds } }).select("name reference images variants._id variants.images").lean()
    : [];
  const stockById = new Map(stocks.map((s) => [str(s._id), s]));
  const products = (order.items || []).map((i) => {
    const si = stockById.get(str(i.stockItemId));
    return {
      name: i.stockItemName || si?.name || "", reference: i.stockItemReference || si?.reference || "",
      image: si?.images?.[0] || (si?.variants || []).find((v) => v.images?.length)?.images?.[0] || "",
      totalQuantity: num(i.totalQuantity) || 0,
      variants: (i.variants || []).map((v) => ({
        label: (v.attributes || []).map((a) => a.value).filter(Boolean).join(" / ") || "—", quantity: num(v.quantity) || 0,
      })),
    };
  });

  const rawIds = [...new Set(view.lines.map((l) => l.rawItemId).filter(isId))];
  const raws = rawIds.length
    ? await RawItem().find({ _id: { $in: rawIds } }).select("quantity unit unitConversions variants._id variants.quantity variants.unitConversions variants.unitConversion").lean()
    : [];
  const rawById = new Map(raws.map((r) => [str(r._id), r]));
  const lines = view.lines.map((l) => {
    const item = rawById.get(l.rawItemId);
    const v = item && l.variantId ? (item.variants || []).find((x) => str(x._id) === l.variantId) : null;
    return {
      ...l, onHand: item ? r4(v ? v.quantity : item.quantity) : null, stockUnit: item?.unit || l.unit,
      unitChoices: unitChoicesFor(item, v, l.unit),
    };
  });

  const receipts = await GoodsReceipt().find({
    companyId: tenant.companyId, sourceType: "MATERIAL_REQUEST", "materialRequest.requestId": oid(requestId),
  }).sort({ receiptDate: -1, _id: -1 }).lean();

  return {
    request: { ...view, lines, row: registerRow(order, request) },
    order: {
      id: str(order._id), orderRef: str(order.requestId), status: str(order.status),
      customer: { name: str(order.customerInfo?.name), email: str(order.customerInfo?.email), phone: str(order.customerInfo?.phone) },
      deliveryDeadline: order.customerInfo?.deliveryDeadline || null,
      piNumber: order.quotations?.[0]?.quotationNumber || "",
      fulfilmentModel: str(order.fulfilmentModel) || "FULL_PACKAGE",
    },
    products,
    receipts: receipts.map((g) => ({
      id: str(g._id), receiptNumber: g.receiptNumber, receiptDate: g.receiptDate, notes: g.notes || "",
      warehouseName: g.warehouseName || "", locationCode: g.locationCode || "",
      recordedBy: g.recordedBy?.name || "", status: g.status,
      lines: (g.lines || []).map((l) => ({
        sourceLineId: l.sourceLineId ? str(l.sourceLineId) : null, itemName: l.itemName, variantCombination: l.variantCombination || [],
        receivedQuantity: l.receivedQuantity, invoicedQuantity: l.invoicedQuantity ?? null,
        unit: l.poUnit, baseQuantity: l.baseQuantity, baseUnit: l.baseUnit, conversionNote: l.conversionNote || "",
      })),
    })),
  };
}

/* ── RECORDING A RECEIPT ────────────────────────────────────────────────── */

async function resolveDestination(tenant, { warehouseId, locationId }) {
  if (!warehouseId && !locationId) return { warehouse: null, location: null };
  if (locationId && !warehouseId) throw fail("VALIDATION", "A location needs its warehouse.", { reason: "LOCATION_INCOMPLETE" });
  const warehouse = await Warehouse().findOne({ _id: warehouseId, ...tenantContext.tenantFilter(tenant) }).lean();
  if (!warehouse) throw fail("VALIDATION", "That warehouse was not found.", { reason: "WAREHOUSE_UNKNOWN" });
  if (!locationId) return { warehouse, location: null };
  const location = locStock.findLocation(warehouse, locationId);
  const locErr = locStock.usableLocationError(warehouse, location, tenant.companyId);
  if (locErr) throw fail("VALIDATION", locErr.message, { reason: locErr.reason });
  return { warehouse, location };
}

async function planLines(request, inLines) {
  const rows = Array.isArray(inLines) ? inLines : [];
  if (!rows.length) throw fail("VALIDATION", "Enter a received quantity on at least one line.", { field: "lines" });
  const seen = new Set();
  const plans = [];
  for (const [i, row] of rows.entries()) {
    const line = (request.lines || []).find((l) => str(l._id) === str(row?.lineId));
    if (!line) throw fail("VALIDATION", `Line ${i + 1} is not on this request.`, { field: "lines", index: i });
    if (seen.has(str(line._id))) throw fail("VALIDATION", `${line.rawItemName} is entered twice. Combine the quantities.`, { field: "lines", index: i });
    seen.add(str(line._id));
    /* Two figures a line (owner, 7 Oct 2026): what the invoice / challan says
       (`invoicedQuantity`, optional) and what was actually counted
       (`quantity`, which stock moves by). */
    const invoiced = row.invoicedQuantity === "" || row.invoicedQuantity == null ? null : num(row.invoicedQuantity);
    if (invoiced !== null && invoiced < 0) throw fail("VALIDATION", `${line.rawItemName}: the invoiced quantity cannot be negative.`, { field: "invoicedQuantity", index: i });
    const qty = num(row.quantity);
    if (qty === null || qty <= 0) throw fail("VALIDATION", `${line.rawItemName}: give a received quantity above zero.`, { field: "quantity", index: i });

    const rawItem = await RawItem().findById(line.rawItemId).select("name sku unit variants._id variants.sku variants.combination").lean();
    if (!rawItem) throw fail("VALIDATION", `${line.rawItemName} is no longer in the register.`, { reason: "RAW_ITEM_MISSING" });
    const variant = line.variantId ? (rawItem.variants || []).find((v) => str(v._id) === str(line.variantId)) : null;
    const unit = str(line.unit) || str(rawItem.unit);
    const baseUnit = await posting.baseUnitOf(rawItem._id, unit);
    const conv = await posting.resolveConversion({ quantity: qty, fromUnit: unit, toUnit: baseUnit });
    const already = num(line.receivedQuantity) || 0;
    plans.push({
      lineKey: str(line._id), sourceLineId: line._id, sourceLineRef: str(line._id),
      rawItemId: rawItem._id, variantId: variant ? variant._id : null,
      variantCombination: variant ? (variant.combination || []) : (line.variantCombination || []),
      variantSku: variant?.sku || "",
      itemName: rawItem.name, sku: rawItem.sku,
      poUnit: unit, receivedQuantity: r4(qty),
      baseUnit, baseQuantity: conv.baseQuantity, conversionFactor: conv.factor, conversionNote: conv.note,
      quantityOrdered: num(line.quantity) || 0, previouslyReceived: already,
      invoicedQuantity: invoiced === null ? null : r4(invoiced),
    });
  }
  return plans;
}

/**
 * Record one goods receipt against a material request.
 *
 * `idempotent` is the middleware's `req.idempotent` (key, record, recovering).
 */
async function receive(tenant, { requestId, body = {}, actor, idempotent = null }) {
  const { order, request } = await loadOwned(tenant, requestId);

  if (idempotent?.recovering) {
    const existing = await GoodsReceipt().findOne({
      companyId: tenant.companyId, sourceType: "MATERIAL_REQUEST",
      "materialRequest.requestId": request._id, idempotencyKey: idempotent.key,
    }).lean();
    await unitOfWork.recover(tenant, {
      entityType: ENTITY, entityId: request._id, idempotencyKey: idempotent.key,
      entry: {
        documentNumber: request.requestNumber,
        action: existing ? "RECEIVED" : "RECEIPT_RECONCILIATION_REQUIRED",
        resultingState: mr.statusOf(request), idempotencyKey: idempotent.key,
        reason: existing ? "" : "Stock effect marked but no goods receipt was written.",
        metadata: { recovered: true, goodsReceiptNumber: existing?.receiptNumber || null },
      },
    });
    if (!existing) {
      throw fail("LIFECYCLE_BLOCKED",
        "This receipt was interrupted after the stock effect was marked but before the goods receipt was written. Check the item's stock and reconcile — do not record it again.",
        { reason: "PARTIAL_RECEIPT_NEEDS_RECONCILIATION", requestNumber: request.requestNumber });
    }
    return { goodsReceipt: existing, replayed: true };
  }

  if (mr.statusOf(request) === "cancelled") {
    throw fail("LIFECYCLE_BLOCKED", "This material request was cancelled; nothing can be received against it.");
  }
  if (mr.statusOf(request) === "draft") {
    throw fail("LIFECYCLE_BLOCKED", "This material request has not been submitted by Merchandising yet.");
  }
  const { warehouse, location } = await resolveDestination(tenant, body);
  const plans = await planLines(request, body.lines);
  const receiptDate = body.receiptDate ? new Date(body.receiptDate) : new Date();
  if (Number.isNaN(receiptDate.getTime())) throw fail("VALIDATION", "The receipt date is not valid.", { field: "receiptDate" });
  const previousState = mr.statusOf(request);

  if (idempotent?.record) {
    await idempotencyService.markEffectApplied({ record: idempotent.record, entityType: ENTITY, entityId: request._id });
  }

  let created = null;
  await unitOfWork.run(tenant, {
    idempotencyRecord: idempotent?.record,
    mutate: async (session) => {
      const { number: receiptNumber } = await posting.allocateReceiptNumber({
        companyId: tenant.companyId, session, siteId: tenant.siteId || null,
      });
      const header = { warehouse, location, receiptDate, notes: str(body.notes) };
      const source = {
        type: "MATERIAL_REQUEST",
        documentId: request._id,
        documentNumber: str(request.requestNumber),
        stockMeta: (pl) => ({
          reason: "Material request receipt",
          notes: `GRN ${receiptNumber} · ${str(request.requestNumber)} for ${str(order.requestId)}`
            + `${pl.conversionNote ? ` (${pl.conversionNote})` : ""}`,
        }),
        locationSource: (pl) => ({
          kind: "material_request_receipt",
          id: request._id,
          reference: str(request.requestNumber),
          orderRef: str(order.requestId),
          orderLineRef: str(pl.sourceLineRef),
        }),
      };
      await posting.postMovements({
        session, tenant, plans, receiptNumber, header, actor, idempotencyKey: idempotent?.key || "", source,
      });

      const grnLines = plans.map((pl) => ({
        sourceLineId: pl.sourceLineId, sourceLineRef: pl.sourceLineRef,
        rawItemId: pl.rawItemId, variantId: pl.variantId, variantCombination: pl.variantCombination,
        itemName: pl.itemName, sku: pl.sku, variantSku: pl.variantSku,
        poUnit: pl.poUnit, receivedQuantity: pl.receivedQuantity,
        baseUnit: pl.baseUnit, baseQuantity: pl.baseQuantity,
        conversionFactor: pl.conversionFactor, conversionNote: pl.conversionNote,
        invoicedQuantity: pl.invoicedQuantity,
        quantityOrdered: pl.quantityOrdered, previouslyReceived: pl.previouslyReceived,
        receivedAfter: r4(pl.previouslyReceived + pl.receivedQuantity),
        pendingAfter: r4(Math.max(0, pl.quantityOrdered - pl.previouslyReceived - pl.receivedQuantity)),
        stockLedgerRef: { rawItemId: pl.rawItemId, transactionId: pl.__txId || null },
        locationMovementId: pl.__mvId || null,
      }));

      const [goodsReceipt] = await GoodsReceipt().create([{
        companyId: tenant.companyId, siteId: tenant.siteId || null, receiptNumber,
        sourceType: "MATERIAL_REQUEST",
        sourceDocumentId: request._id,
        sourceDocumentNumber: str(request.requestNumber),
        materialRequest: {
          customerRequestId: order._id, requestId: request._id,
          requestNumber: str(request.requestNumber), orderRef: str(order.requestId),
        },
        warehouseId: warehouse?._id || null, warehouseName: warehouse?.name || "",
        locationId: location?._id || null, locationCode: location?.code || "", locationName: location?.name || "",
        receiptDate, notes: str(body.notes), status: "RECORDED",
        recordedBy: { id: actor.id || null, name: actor.name || "" },
        idempotencyKey: idempotent?.key || "",
        lines: grnLines,
      }], { session });
      created = goodsReceipt;

      /* The labels counted on each received line become live stock under
         this GRN; a line not on this receipt keeps its count open. */
      await counts.activateForReceipt(tenant, { request, goodsReceipt, actor }, session);

      /* The request's own lines learn what arrived; its status follows. */
      for (const pl of plans) {
        await CustomerRequest().updateOne(
          { _id: order._id },
          { $inc: { "materialRequests.$[r].lines.$[l].receivedQuantity": pl.receivedQuantity } },
          { arrayFilters: [{ "r._id": request._id }, { "l._id": pl.sourceLineId }], session },
        );
      }
      const after = await CustomerRequest().findOne({ _id: order._id }).select("materialRequests").session(session).lean();
      const fresh = (after.materialRequests || []).find((r) => str(r._id) === str(request._id));
      await CustomerRequest().updateOne(
        { _id: order._id },
        {
          $set: { "materialRequests.$[r].status": mr.statusOf(fresh) },
          $push: {
            "materialRequests.$[r].receipts": {
              goodsReceiptId: goodsReceipt._id, receiptNumber, receivedAt: receiptDate, byName: actor.name || "",
              lines: plans.map((pl) => ({ lineId: pl.sourceLineId, quantity: pl.receivedQuantity, unit: pl.poUnit })),
            },
          },
        },
        { arrayFilters: [{ "r._id": request._id }], session },
      );

      return {
        entityType: ENTITY, entityId: request._id, result: true,
        entry: {
          entityType: ENTITY, entityId: request._id, documentNumber: str(request.requestNumber),
          action: "RECEIVED", previousState, resultingState: mr.statusOf(fresh),
          idempotencyKey: idempotent?.key || "",
          metadata: { goodsReceiptNumber: receiptNumber, lineCount: plans.length, orderRef: str(order.requestId) },
        },
      };
    },
  });

  return { goodsReceipt: created, replayed: false };
}

module.exports = { ENTITY, registerRows, registerRow, detail, receive, loadOwned };
