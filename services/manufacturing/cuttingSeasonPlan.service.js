// services/manufacturing/cuttingSeasonPlan.service.js
//
// The reads behind a log-book season started from PPC's lay (see
// cuttingSeasonPlan.js). Only LIVE cutting targets are read — a proposal from
// an order page is not a lay until PPC takes it into the Cutting plan and
// saves there.
"use strict";
const mongoose = require("mongoose");
const PpcOrderTarget = require("../../models/CMS_Models/PPC/PpcOrderTarget");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const CuttingSeason = require("../../models/CMS_Models/Manufacturing/CuttingMaster/CuttingSeason");
const { fabricOf } = require("../ppc/departmentPlan");
const { displayWorkOrderNumber } = require("./workOrderNumber");
const { resolvePhotos, variantText } = require("./workOrderPhoto");
const plan = require("./cuttingSeasonPlan");

const isId = (v) => mongoose.Types.ObjectId.isValid(String(v || "")) && /^[0-9a-f]{24}$/i.test(String(v));
const istToday = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const addDays = (d, n) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const METRES = /^(m|mtr|mtrs|meter|meters|metre|metres)$/i;

const liveTargets = (companyId) => PpcOrderTarget.find({ companyId, department: "cutting", status: "active" })
  .select("_id status department manufacturingOrderId moNumber customerName from to dayPlan cutPlan").lean();

/** Product, style, size, colour, photo, fabric and BOM consumption of each work order named in the lays. */
async function workOrderFacts(ids) {
  const clean = [...new Set(ids.filter(isId).map(String))];
  if (!clean.length) return new Map();
  const wos = await WorkOrder.find({ _id: { $in: clean } })
    .select("_id workOrderNumber quantity stockItemId stockItemName stockItemReference variantId variantAttributes rawMaterials").lean();
  const photos = await resolvePhotos(wos).catch(() => []);
  const itemIds = [...new Set(wos.flatMap((w) => (w.rawMaterials || []).map((r) => String(r.rawItemId))))].filter(isId);
  const items = itemIds.length ? await RawItem.find({ _id: { $in: itemIds } }).select("_id category").lean() : [];
  const categoryOf = new Map(items.map((i) => [String(i._id), i.category || ""]));
  return new Map(wos.map((w, i) => {
    const fabric = fabricOf(w.rawMaterials, categoryOf);
    /* BOM cons per garment: the fabric line's requirement before allowance, over the work order's pieces, in metres */
    const line = fabric ? (w.rawMaterials || []).find((r) => String(r.rawItemId) === fabric.quality) : null;
    const need = line ? Number(line.requiredQuantity ?? line.quantityRequired) : NaN;
    const bomCons = line && METRES.test(String(line.unit || "").trim()) && need > 0 && w.quantity > 0 ? Math.round((need / w.quantity) * 1000) / 1000 : null;
    const parts = plan.variantParts(w.variantAttributes);
    return [String(w._id), {
      workOrderNumber: displayWorkOrderNumber(w), productName: w.stockItemName || "", styleNo: w.stockItemReference || "",
      variantText: variantText({ attributes: w.variantAttributes || [] }), size: parts.size, colour: parts.colour,
      quantity: w.quantity || 0, photo: photos[i] || null, fabric, bomCons,
    }];
  }));
}

/** Each order's customer delivery deadline (an IST day) and priority. */
async function orderDue(moIds) {
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const ids = [...new Set(moIds.filter(isId).map(String))];
  if (!ids.length) return new Map();
  const mos = await CustomerRequest.find({ _id: { $in: ids } }).select("_id priority customerInfo.deliveryDeadline").lean();
  const ist = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : "");
  return new Map(mos.map((m) => [String(m._id), { deliveryDeadline: ist(m.customerInfo?.deliveryDeadline), priority: m.priority || "" }]));
}

/** Which season holds each lay: an open one first, else the latest closed. A removed season holds nothing. */
async function claims(companyId, keys) {
  if (!keys.length) return new Map();
  const seasons = await CuttingSeason.find({ companyId, deletedAt: null, "plan.lays.layKey": { $in: keys } })
    .select("_id name status createdAt lays plan.lays.layKey").sort({ createdAt: -1 }).lean();
  const out = new Map();
  for (const s of seasons) for (const l of s.plan?.lays || []) {
    const prev = out.get(l.layKey);
    const pcs = (s.lays || []).reduce((a, x) => a + plan.SIZES.reduce((n, k) => n + (Number(x.ratio?.[k]) || 0), 0) * (Number(x.plies) || 0), 0);
    if (!prev || (prev.status === "closed" && s.status !== "closed")) out.set(l.layKey, { seasonId: String(s._id), name: s.name, status: s.status, pcsCut: pcs });
  }
  return out;
}

/** PPC's lays from `from` for `days` days, each line with its product, photo and fabric, and the season that holds it. */
async function plannedLays(companyId, { from, days = 3 } = {}) {
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || "")) ? String(from) : istToday();
  const span = Math.min(14, Math.max(1, Number(days) || 3));
  const to = addDays(start, span - 1);
  const lays = plan.laysFromTargets(await liveTargets(companyId), { from: start, to });
  const facts = await workOrderFacts(lays.flatMap((l) => l.lines.map((x) => x.workOrderId)));
  const held = await claims(companyId, lays.map((l) => l.layKey));
  const due = await orderDue(lays.flatMap((l) => l.lines.map((x) => x.moId)));
  return {
    from: start, to, today: istToday(),
    lays: lays.map((l) => {
      for (const x of l.lines) Object.assign(x, due.get(String(x.moId)) || {});
      const p = plan.planOf([l], { facts });
      const fabrics = p.fabrics.map(({ key, name, variant }) => ({ key, name, variant }));
      return { layKey: l.layKey, date: l.date, time: l.time, start: l.start, label: l.label, pieces: l.pieces, orders: l.orders, hasCutPlan: Boolean(l.cutPlan), ...plan.dueOf(p.lines), lines: p.lines, fabrics, season: held.get(l.layKey) || null };
    }),
  };
}

/**
 * The plan a new season takes from its lay(s), its report details and the
 * lay row to start from. Refuses a lay PPC no longer plans, or one an OPEN
 * season already holds (409).
 */
/* LAY NUMBER (17 Oct 2026, owner: "the lay number should have been filled").
   An order's lays count 1, 2, 3 … — every season (open or closed, not
   removed) that cuts a work order of the order is a lay of it. A lay that
   holds several orders takes the highest next number among them; several
   products of one order on one lay are ONE lay. */
async function nextLayNo(companyId, moIds) {
  const ids = [...new Set((moIds || []).map((x) => String(x || "")).filter(Boolean))];
  if (!ids.length) return "1";
  const counts = await Promise.all(ids.map((id) => CuttingSeason.countDocuments({ companyId, deletedAt: null, "plan.lines.moId": id })));
  return String(Math.max(0, ...counts) + 1);
}

async function planForSeason(companyId, layKeys, actor) {
  const keys = [...new Set((layKeys || []).map((k) => String(k || "").trim()).filter(Boolean))].slice(0, 20);
  if (!keys.length) return null;
  const lays = plan.laysFromTargets(await liveTargets(companyId)).filter((l) => keys.includes(l.layKey));
  const missing = keys.filter((k) => !lays.some((l) => l.layKey === k));
  if (missing.length) { const e = new Error(missing.length === 1 ? "That lay is no longer in PPC's Cutting plan. Refresh the list." : `${missing.length} of those lays are no longer in PPC's Cutting plan. Refresh the list.`); e.status = 409; throw e; }
  const held = await claims(companyId, keys);
  const open = [...held.entries()].filter(([, s]) => s.status !== "closed");
  if (open.length) { const e = new Error(`${lays.find((l) => l.layKey === open[0][0])?.label || "That lay"} is already being cut in the open season "${open[0][1].name}". Open it there.`); e.status = 409; e.seasonId = open[0][1].seasonId; throw e; }
  const facts = await workOrderFacts(lays.flatMap((l) => l.lines.map((x) => x.workOrderId)));
  const p = plan.planOf(lays, { facts, takenBy: actor });
  const suggestion = plan.suggestLay(p, { cuttingMaster: actor?.name || "" });
  p.layNo = suggestion?.values?.layNo || await nextLayNo(companyId, (p.lines || []).map((x) => x.moId));
  if (suggestion?.values && !suggestion.values.layNo) suggestion.values.layNo = p.layNo;
  return { plan: p, header: plan.headerFromPlan(p), suggestion };
}

/* ═══ A SEASON STARTED FROM AN ORDER (17 Oct 2026, owner) ════════════════
   The Overview's order cards open Cutting Seasons for that order instead of
   the old work-order page. An order may hold several products (a shirt and a
   pant are cut from different fabric), so a season is one ORDER × PRODUCT: its
   lines are that product's work orders with what each still needs cut, its
   report details the order's, and its suggested lay row puts each size's
   remaining pieces in the size columns on one ply. The lay key
   `order:<moId>:<product>` is what a later click finds the open season by. */
const orderLayKey = (moId, productKey) => `order:${moId}:${productKey}`;

async function orderWorkOrders(companyId, moId) {
  const { workOrderScope } = require("../../routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingAccess");
  if (!isId(moId)) return [];
  return WorkOrder.find({ customerRequestId: moId, ...workOrderScope(companyId), status: { $ne: "cancelled" } })
    .select("_id workOrderNumber quantity stockItemId stockItemName stockItemReference variantAttributes cuttingProgress cuttingStatus").lean();
}
const remainingOf = (w) => Math.max(0, (w.quantity || 0) - (w.cuttingProgress?.completed || 0));

/** The order and its products, each with its work orders (size, quantity, cut, left) and the open season that holds it. */
async function orderProducts(companyId, moId) {
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  if (!isId(moId)) return null;
  const mo = await CustomerRequest.findById(moId).select("_id requestId customerInfo.name customerInfo.deliveryDeadline priority").lean();
  if (!mo) return null;
  const wos = await orderWorkOrders(companyId, moId);
  const photos = await resolvePhotos(wos).catch(() => []);
  const groups = new Map();
  wos.forEach((w, i) => {
    const key = String(w.stockItemId || "none");
    if (!groups.has(key)) groups.set(key, { key, layKey: orderLayKey(moId, key), productName: w.stockItemName || "Product", styleNo: w.stockItemReference || "", photo: null, workOrders: [], quantity: 0, cut: 0, remaining: 0, openSeason: null });
    const g = groups.get(key);
    const parts = plan.variantParts(w.variantAttributes);
    g.photo = g.photo || photos[i] || null;
    g.workOrders.push({ id: String(w._id), workOrderNumber: displayWorkOrderNumber(w), size: parts.size, column: plan.sizeColumn(parts.size), colour: parts.colour, variantText: variantText({ attributes: w.variantAttributes || [] }), quantity: w.quantity || 0, cut: w.cuttingProgress?.completed || 0, remaining: remainingOf(w) });
    g.quantity += w.quantity || 0; g.cut += w.cuttingProgress?.completed || 0; g.remaining += remainingOf(w);
  });
  const keys = [...groups.values()].map((g) => g.layKey).concat(orderLayKey(moId, "all"));
  const open = keys.length ? await CuttingSeason.find({ companyId, deletedAt: null, status: { $ne: "closed" }, "plan.lays.layKey": { $in: keys } }).select("_id name plan.lays.layKey").lean() : [];
  for (const s of open) for (const l of s.plan?.lays || []) for (const g of groups.values()) if (g.layKey === l.layKey && !g.openSeason) g.openSeason = { id: String(s._id), name: s.name };
  const wholeOpen = open.find((s) => (s.plan?.lays || []).some((l) => l.layKey === orderLayKey(moId, "all")));
  const ist = (d) => (d ? new Date(new Date(d).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10) : "");
  return {
    wholeOrder: { layKey: orderLayKey(moId, "all"), openSeason: wholeOpen ? { id: String(wholeOpen._id), name: wholeOpen.name } : null },
    ppcLays: await ppcLaysOfOrder(companyId, moId),
    order: { id: String(mo._id), moNumber: `MO-${mo.requestId}`, customerName: mo.customerInfo?.name || "", deliveryDeadline: ist(mo.customerInfo?.deliveryDeadline), priority: mo.priority || "" },
    products: [...groups.values()].map((g) => ({ ...g, workOrders: g.workOrders.sort((a, b) => plan.SIZES.indexOf(a.column) - plan.SIZES.indexOf(b.column)) })),
  };
}

/** The plan, report details and suggested lay of a season for one product of an order — or, with
    productKey "all", the WHOLE order as one lay. Refuses when an open season holds it (409, with its id). */
async function planForOrder(companyId, moId, productKey, actor, { exclude = new Set() } = {}) {
  const info = await orderProducts(companyId, moId);
  if (!info) { const e = new Error("That order was not found."); e.status = 404; throw e; }
  const whole = String(productKey || "") === "all";
  const product = whole
    ? { key: "all", layKey: orderLayKey(moId, "all"), productName: info.order.moNumber, workOrders: info.products.flatMap((p) => p.workOrders), openSeason: info.wholeOrder?.openSeason || null }
    : info.products.find((p) => p.key === String(productKey || "")) || (info.products.length === 1 ? info.products[0] : null);
  if (!product) { const e = new Error(info.products.length ? "Choose which product of the order to cut." : "This order has no work order to cut."); e.status = 400; throw e; }
  if (product.openSeason) { const e = new Error(`${product.productName} of ${info.order.moNumber} is already being cut in "${product.openSeason.name}". Opening it.`); e.status = 409; e.seasonId = product.openSeason.id; throw e; }
  const today = istToday();
  const lines = product.workOrders.filter((w) => w.remaining > 0 && !exclude.has(String(w.id))).map((w) => ({ workOrderId: w.id, moId: info.order.id, moNumber: info.order.moNumber, customerName: info.order.customerName, targetId: "", targetFrom: "", targetTo: "", pieces: w.remaining }));
  if (!lines.length) { const e = new Error(`Every piece of ${whole ? info.order.moNumber : `${product.productName} on ${info.order.moNumber}`} is already cut${exclude.size ? " or in a lay already open" : ""}.`); e.status = 409; throw e; }
  const lay = { layKey: product.layKey, date: today, time: "", start: "", label: product.productName, pieces: lines.reduce((a, x) => a + x.pieces, 0), lines, cutPlan: null };
  const facts = await workOrderFacts(lines.map((x) => x.workOrderId));
  const p = plan.planOf([lay], { facts, takenBy: actor });
  const suggestion = plan.suggestLay(p, { cuttingMaster: actor?.name || "", sizeQuantities: true });
  /* the lay's label is the product's name; its number is the order's next lay */
  const layNo = await nextLayNo(companyId, [info.order.id]);
  if (suggestion?.values) suggestion.values.layNo = layNo;
  return { plan: { ...p, source: "order", layNo }, header: plan.headerFromPlan(p), suggestion };
}

/* PPC'S LAYS FOR ONE ORDER (17 Oct 2026, owner: "unless PPC has defined it,
   it is one lay"). A lay is defined when PPC planned it on its department plan
   (a day-plan entry carrying a `layKey`); a target's bare day figure ("12
   pieces on 16 Oct") is not a lay. Lays a closed season already cut are left out. */
async function ppcLaysOfOrder(companyId, moId) {
  const targets = (await liveTargets(companyId)).filter((t) => String(t.manufacturingOrderId) === String(moId));
  const defined = targets.map((t) => ({ ...t, dayPlan: (t.dayPlan || []).filter((e) => String(e.layKey || "").trim()) })).filter((t) => t.dayPlan.length);
  if (!defined.length) return [];
  const lays = plan.laysFromTargets(defined);
  const held = await claims(companyId, lays.map((l) => l.layKey));
  return lays
    .map((l) => ({ layKey: l.layKey, date: l.date, start: l.start, time: l.time, label: l.label, pieces: l.pieces, season: held.get(l.layKey) || null }))
    .filter((l) => !(l.season && l.season.status === "closed"));
}

/**
 * Open the order's one lay (17 Oct 2026): the open whole-order season when
 * there is one; otherwise a new one holding every work order still to cut.
 * A per-product season started before this that nobody has worked on (no lay
 * saved, nothing scanned or printed) is folded into it — marked removed, not
 * erased; one somebody worked on stays, and its work orders are left out of
 * the new lay so nothing is cut twice.
 */
async function openWholeOrderLay(companyId, moId, actor) {
  const info = await orderProducts(companyId, moId);
  if (!info) { const e = new Error("That order was not found."); e.status = 404; throw e; }
  if (info.wholeOrder.openSeason) return { seasonId: info.wholeOrder.openSeason.id };
  const perProduct = await CuttingSeason.find({ companyId, deletedAt: null, status: { $ne: "closed" }, "plan.lays.layKey": { $in: info.products.map((p) => p.layKey) } });
  const exclude = new Set();
  let busy = null;
  for (const s of perProduct) {
    const worked = (s.lays || []).length || (s.fabricScans || []).length || (s.printRuns || []).length || (s.rawItems || []).length;
    if (worked) { busy = busy || s; for (const x of s.plan?.lines || []) exclude.add(String(x.workOrderId)); continue; }
    s.deletedAt = new Date(); s.deletedBy = actor || {}; s.note = `${s.note ? `${s.note} · ` : ""}Folded into the order's one lay`;
    await s.save();
  }
  try { return { plan: await planForOrder(companyId, moId, "all", actor, { exclude }) }; }
  catch (e) { if (e.status === 409 && busy) return { seasonId: String(busy._id) }; throw e; }
}

module.exports = { plannedLays, planForSeason, istToday, orderProducts, planForOrder, orderLayKey, openWholeOrderLay, nextLayNo };
