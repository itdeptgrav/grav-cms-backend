// services/merchandising/orders.service.js
//
// EVERY ORDER SALES HAS RELEASED, AS MERCHANDISING SEES IT (7 Oct 2026).
//
// The Order Execution register used to begin at the HANDOVER: a line reached
// Merchandising only once a Sales approver issued it, so an order Sales had
// already released to production could be invisible here for days. The owner:
// "it is needed to showcase all the orders released from the sales side",
// because against that order the merchandiser raises the material request.
//
// So this reads the released CustomerRequests directly — the same population
// the PPC board and the Store's order requests read — and says, per order:
// its products and their size-wise quantities, the raw material each needs
// (from the work orders' allocations when the order has been released to
// production, else computed live from the product's BOM), and what is on
// hand. It READS; nothing here writes.
//
// ── OWNERSHIP ────────────────────────────────────────────────────────────
// A CustomerRequest carries no companyId. Its company is proved through its
// lines' styles, exactly as the handover does (`merchandisingHandover
// .loadOwnedRequest`); an order whose lines name no style at all (the PI
// form offers every register product since 7 Oct 2026) is admitted only on a
// sole-company deployment, which is the allowance every Sales read makes.
"use strict";

const mongoose = require("mongoose");
const { fail } = require("../storePurchase/errors");
const { ownershipProofFor } = require("../integration/styleOwnershipProof.service");
const { soleCompanyDeployment } = require("../companyContext/salesScope.service");
const { CONFIRMED_STATUSES } = require("../sales/merchandisingHandover.service");
const { resolveOrderFulfilmentModel } = require("../../constants/orderFulfilment");

const model = (name, path) => (mongoose.models[name] || require(path));
const CustomerRequest = () => model("CustomerRequest", "../../models/Customer_Models/CustomerRequest");
const SampleStyle = () => model("SampleStyle", "../../models/CMS_Models/Sales/SampleStyle");
const StockItem = () => model("StockItem", "../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = () => model("WorkOrder", "../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = () => model("RawItem", "../../models/CMS_Models/Inventory/Products/RawItem");
const SalesHandoverVersion = () => model("SalesHandoverVersion", "../../models/CMS_Models/Sales/SalesHandoverVersion");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r4 = (n) => Math.round(n * 10000) / 10000;
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const sameUnit = (a, b) => str(a).toLowerCase() === str(b).toLowerCase();

/** The units a raw item (and, when named, its variant) may be requested in:
    its registered unit and every unit its conversions name — the rule the
    merchandiser's BOM dialog applies. */
function unitOptionsFor(item, variant = null) {
  const out = [];
  const add = (u) => { const v = str(u); if (v && !out.some((x) => sameUnit(x, v))) out.push(v); };
  add(item?.unit);
  for (const c of item?.unitConversions || []) { add(c.fromUnit); add(c.toUnit); }
  const variants = variant ? [variant] : (item?.variants || []);
  for (const v of variants) for (const c of v?.unitConversions || []) { add(c.fromUnit); add(c.toUnit); }
  return out;
}

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_REQUIRED", "Choose the company you are working in.");
}

/* ── WHICH RELEASED ORDERS THIS COMPANY MAY SEE ─────────────────────────── */

const RELEASED = {
  status: { $in: CONFIRMED_STATUSES },
  orderOrigin: { $ne: "sampling" },
};

/**
 * Prove each order's company through its lines' styles, one proof per style.
 * Returns the orders that are this company's, in the order given.
 */
async function ownedOnly(ctx, requests) {
  const styleIds = [...new Set(requests.flatMap((r) => (r.items || [])
    .map((i) => str(i.sampleStyleId)).filter(isId)))];
  const styles = styleIds.length
    ? await SampleStyle().find({ _id: { $in: styleIds } })
      .select("_id companyId journeyId enquiryId sampleType").lean()
    : [];
  const proof = new Map();
  for (const s of styles) proof.set(str(s._id), Boolean(await ownershipProofFor(s, ctx.companyId)));

  let sole = null;
  const out = [];
  for (const r of requests) {
    const ids = (r.items || []).map((i) => str(i.sampleStyleId)).filter(isId);
    if (!ids.length) {
      if (sole === null) sole = await soleCompanyDeployment(ctx.companyId);
      if (sole) out.push(r);
      continue;
    }
    if (ids.every((id) => proof.get(id) === true)) out.push(r);
  }
  return out;
}

async function loadOwnedOrder(ctx, id) {
  if (!isId(id)) throw fail("NOT_FOUND", "Order not found.");
  const request = await CustomerRequest().findOne({ _id: id, ...RELEASED }).lean();
  if (!request) throw fail("NOT_FOUND", "Order not found.");
  const [owned] = await ownedOnly(ctx, [request]);
  if (!owned) throw fail("NOT_FOUND", "Order not found.");
  return request;
}

/* ── THE REGISTER ───────────────────────────────────────────────────────── */

const releasedAtOf = (r) => r.quotations?.[0]?.salesApproval?.approvedAt
  || r.internalOrderMarkedAt || r.updatedAt || r.createdAt || null;

function orderRow(r, handover) {
  const products = (r.items || []).map((i) => ({
    name: i.stockItemName || "", reference: i.stockItemReference || "",
  }));
  return {
    rowType: "ORDER",
    id: str(r._id),
    orderRef: r.requestId || "",
    customerName: r.customerInfo?.name || "",
    status: r.status,
    fulfilmentModel: resolveOrderFulfilmentModel(r.fulfilmentModel),
    jobWork: (r.items || []).some((i) => resolveOrderFulfilmentModel(i.fulfilmentModel) === "JOB_WORK"),
    products,
    productCount: products.length,
    totalQuantity: (r.items || []).reduce((s, i) => s + num(i.totalQuantity), 0),
    deliveryDeadline: r.customerInfo?.deliveryDeadline || null,
    releasedAt: releasedAtOf(r),
    piNumber: r.quotations?.[0]?.quotationNumber || "",
    poNumber: r.quotations?.[0]?.poProof?.poNumber || r.poProof?.poNumber || "",
    handover: handover || { issuedLines: 0, lines: (r.items || []).length },
    materialRequests: { count: 0 },
  };
}

/**
 * Every released order this company may see, newest release first.
 * The population is small (tens), so it is read whole and filtered in memory;
 * `limit` bounds the page and `cursor` is the offset.
 */
async function listOrders(ctx, { q = "", cursor, limit } = {}) {
  assertContext(ctx);
  const size = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 100);
  const offset = Math.max(parseInt(cursor, 10) || 0, 0);

  const filter = { ...RELEASED };
  const term = str(q);
  if (term) {
    const rx = new RegExp(escapeRx(term), "i");
    filter.$or = [
      { requestId: rx }, { "customerInfo.name": rx }, { "items.stockItemName": rx },
      { "items.stockItemReference": rx }, { "quotations.quotationNumber": rx },
    ];
  }
  const all = await CustomerRequest().find(filter)
    .select("requestId status orderOrigin fulfilmentModel customerInfo.name customerInfo.deliveryDeadline "
      + "items.stockItemName items.stockItemReference items.totalQuantity items.sampleStyleId items.fulfilmentModel "
      + "quotations.quotationNumber quotations.salesApproval.approvedAt quotations.poProof.poNumber poProof.poNumber "
      + "internalOrderMarkedAt createdAt updatedAt")
    .sort({ updatedAt: -1, _id: -1 }).limit(500).lean();
  const owned = await ownedOnly(ctx, all);
  owned.sort((a, b) => new Date(releasedAtOf(b) || 0) - new Date(releasedAtOf(a) || 0));

  const page = owned.slice(offset, offset + size);
  const handovers = await handoverSummary(ctx, page.map((r) => r.requestId));
  const rows = page.map((r) => orderRow(r, handovers.get(r.requestId)));
  await attachMaterialRequestCounts(ctx, rows);

  return {
    rows,
    limit: size,
    total: owned.length,
    hasMore: offset + size < owned.length,
    nextCursor: offset + size < owned.length ? String(offset + size) : null,
  };
}

/** How many of each order's lines Sales has handed over (CURRENT versions). */
async function handoverSummary(ctx, orderRefs) {
  const out = new Map();
  if (!orderRefs.length) return out;
  const versions = await SalesHandoverVersion().find({
    companyId: ctx.companyId, handoverRef: { $in: orderRefs }, "publication.state": "CURRENT",
  }).select("handoverRef handoverLineRef").lean();
  for (const v of versions) {
    const cur = out.get(v.handoverRef) || { issuedLines: 0, lineRefs: [] };
    cur.issuedLines += 1; cur.lineRefs.push(v.handoverLineRef);
    out.set(v.handoverRef, cur);
  }
  return out;
}

/* ── MATERIAL REQUESTS AGAINST AN ORDER ─────────────────────────────────
   Filled in by the material-request service once it registers itself, so the
   register and the order page can say how many requests stand against an
   order without this read knowing where they are stored. */
let materialRequestCounter = null;
function registerMaterialRequestCounter(fn) { materialRequestCounter = fn; }
async function attachMaterialRequestCounts(ctx, rows) {
  if (!materialRequestCounter || !rows.length) return;
  try {
    const counts = await materialRequestCounter(ctx, rows.map((r) => r.id));
    for (const row of rows) row.materialRequests = counts.get(row.id) || { count: 0 };
  } catch (err) {
    console.error("[merchandising/orders] material request counts:", err?.message || err);
  }
}

/* ── ONE ORDER: PRODUCTS, QUANTITIES AND THE MATERIAL THEY NEED ────────── */

const variantLabel = (attrs) => (attrs || []).map((a) => a.value).filter(Boolean).join(" / ") || "—";

/**
 * Raw material per (raw item, raw-item variant) for the whole order.
 *
 * Preferred source: the work orders' `rawMaterials` — the allocation Sales'
 * release wrote from the product's BOM at release time, which is what the
 * Store issues against. When the order has no work orders (released before
 * the chain created them, or a line with no production route) the figure is
 * computed live from the product's BOM, variant by variant, and said so.
 */
function consumptionFromWorkOrders(workOrders, productNameOf) {
  const rows = new Map();
  for (const wo of workOrders) {
    for (const m of wo.rawMaterials || []) {
      const key = `${str(m.rawItemId)}:${str(m.rawItemVariantId)}`;
      const need = num(m.quantityRequired ?? m.requiredQuantity);
      const cur = rows.get(key) || {
        rawItemId: str(m.rawItemId), name: m.name || "", sku: m.sku || "",
        variantId: str(m.rawItemVariantId) || null,
        variantCombination: m.rawItemVariantCombination || [],
        unit: m.unit || "", required: 0, issued: 0, byProduct: new Map(),
      };
      cur.required += need;
      cur.issued += num(m.quantityIssued);
      const p = productNameOf(wo);
      cur.byProduct.set(p, (cur.byProduct.get(p) || 0) + need);
      rows.set(key, cur);
    }
  }
  return rows;
}

function consumptionFromBom(items, stockById) {
  const rows = new Map();
  const missing = [];
  for (const line of items) {
    const si = stockById.get(str(line.stockItemId));
    if (!si) { missing.push(line.stockItemName || "a product"); continue; }
    let anyBom = false;
    for (const v of line.variants || []) {
      const qty = num(v.quantity);
      if (qty <= 0) continue;
      const sv = (si.variants || []).find((x) => str(x._id) === str(v.variantId))
        || (si.variants || []).find((x) => variantLabel(x.attributes) === variantLabel(v.attributes));
      for (const m of sv?.rawItems || []) {
        anyBom = true;
        const key = `${str(m.rawItemId)}:${str(m.variantId)}`;
        const need = num(m.quantity) * qty;
        const cur = rows.get(key) || {
          rawItemId: str(m.rawItemId), name: m.rawItemName || "", sku: m.rawItemSku || "",
          variantId: str(m.variantId) || null, variantCombination: m.variantCombination || [],
          unit: m.unit || "", required: 0, issued: 0, byProduct: new Map(),
        };
        cur.required += need;
        const p = line.stockItemName || si.name || "";
        cur.byProduct.set(p, (cur.byProduct.get(p) || 0) + need);
        rows.set(key, cur);
      }
    }
    if (!anyBom) missing.push(line.stockItemName || si.name || "a product");
  }
  return { rows, missing };
}

async function withOnHand(rows) {
  const ids = [...new Set([...rows.values()].map((r) => r.rawItemId).filter(isId))];
  const items = ids.length
    ? await RawItem().find({ _id: { $in: ids } }).select("quantity unit unitConversions variants._id variants.quantity variants.combination variants.unitConversions").lean()
    : [];
  const byId = new Map(items.map((i) => [str(i._id), i]));
  return [...rows.values()].map((r) => {
    const item = byId.get(r.rawItemId);
    const v = item && r.variantId ? (item.variants || []).find((x) => str(x._id) === r.variantId) : null;
    return {
      ...r,
      required: r4(r.required),
      issued: r4(r.issued),
      onHand: item ? r4(num(v ? v.quantity : item.quantity)) : null,
      stockUnit: item?.unit || r.unit,
      unitOptions: item ? unitOptionsFor(item, v) : [],
      byProduct: [...r.byProduct.entries()].map(([product, required]) => ({ product, required: r4(required) })),
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

async function getOrder(ctx, { id } = {}) {
  assertContext(ctx);
  const r = await loadOwnedOrder(ctx, id);
  const items = r.items || [];

  const stockIds = [...new Set(items.map((i) => str(i.stockItemId)).filter(isId))];
  const stocks = stockIds.length
    ? await StockItem().find({ _id: { $in: stockIds } })
      .select("name reference images category genderCategory variants._id variants.attributes variants.images variants.rawItems")
      .lean()
    : [];
  const stockById = new Map(stocks.map((s) => [str(s._id), s]));
  const styleIds = [...new Set(items.map((i) => str(i.sampleStyleId)).filter(isId))];
  const styles = styleIds.length
    ? await SampleStyle().find({ _id: { $in: styleIds } }).select("sampleStyleId styleCode productName").lean()
    : [];
  const styleById = new Map(styles.map((s) => [str(s._id), s]));

  const products = items.map((line) => {
    const si = stockById.get(str(line.stockItemId));
    const style = styleById.get(str(line.sampleStyleId));
    const image = si?.images?.[0] || (si?.variants || []).find((v) => v.images?.length)?.images?.[0] || "";
    return {
      lineRef: line.lineRef || "",
      stockItemId: str(line.stockItemId),
      name: line.stockItemName || si?.name || "",
      reference: line.stockItemReference || si?.reference || "",
      category: si?.category || "",
      image,
      styleRef: style?.styleCode || style?.sampleStyleId || "",
      fulfilmentModel: resolveOrderFulfilmentModel(line.fulfilmentModel || r.fulfilmentModel),
      totalQuantity: num(line.totalQuantity),
      hasBom: Boolean(si && (si.variants || []).some((v) => (v.rawItems || []).length)),
      variants: (line.variants || []).map((v) => ({
        variantId: str(v.variantId) || null,
        label: variantLabel(v.attributes),
        quantity: num(v.quantity),
      })),
    };
  });

  const workOrders = await WorkOrder().find({ customerRequestId: r._id })
    .select("workOrderNumber status quantity stockItemId variantAttributes rawMaterials")
    .sort({ createdAt: 1 }).lean();

  let consumption;
  let source;
  let missing = [];
  if (workOrders.length && workOrders.some((w) => (w.rawMaterials || []).length)) {
    source = "work-orders";
    const nameOf = (wo) => products.find((p) => p.stockItemId === str(wo.stockItemId))?.name || "";
    consumption = await withOnHand(consumptionFromWorkOrders(workOrders, nameOf));
    missing = products.filter((p) => !workOrders.some((w) => str(w.stockItemId) === p.stockItemId
      && (w.rawMaterials || []).length)).map((p) => p.name);
  } else {
    source = "bom";
    const out = consumptionFromBom(items, stockById);
    consumption = await withOnHand(out.rows);
    missing = out.missing;
  }

  const handovers = await handoverSummary(ctx, [r.requestId]);
  const header = orderRow(r, handovers.get(r.requestId));
  await attachMaterialRequestCounts(ctx, [header]);

  return {
    order: {
      ...header,
      notes: r.customerInfo?.description || "",
      customer: {
        name: r.customerInfo?.name || "", email: r.customerInfo?.email || "",
        phone: r.customerInfo?.phone || "", city: r.customerInfo?.city || "",
      },
    },
    products,
    workOrders: workOrders.map((w) => ({
      id: str(w._id), number: w.workOrderNumber || "", status: w.status, quantity: num(w.quantity),
      product: products.find((p) => p.stockItemId === str(w.stockItemId))?.name || "",
      variant: variantLabel(w.variantAttributes),
    })),
    consumption: { source, rows: consumption, productsWithoutBom: [...new Set(missing)] },
  };
}

module.exports = {
  RELEASED, listOrders, getOrder, loadOwnedOrder, registerMaterialRequestCounter, unitOptionsFor,
};
