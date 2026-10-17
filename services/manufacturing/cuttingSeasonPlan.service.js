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
  return { plan: p, header: plan.headerFromPlan(p), suggestion: plan.suggestLay(p, { cuttingMaster: actor?.name || "" }) };
}

module.exports = { plannedLays, planForSeason, istToday };
