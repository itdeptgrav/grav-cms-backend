// routes/CMS_Routes/Inventory/Operations/storeLocationRoutes.js
//
// THE PHYSICAL STORE (25 Sep 2026). Mount: /api/cms/inventory/store-locations
//
//   GET  /dashboard                          the location dashboard's figures
//   GET  /warehouses                         active warehouses, for pickers
//   GET  /tree?warehouseId=                  the hierarchy with per-node totals
//   GET  /resolve?code=                      what a scan is: a location, an item sticker, or neither
//   GET  /locations/:locationId              one position: address, contents, markings, children, recent moves
//   GET  /locations/:locationId/movements    its history
//   POST /warehouses/:id/racks               the rack wizard (one structural write)
//   PUT  /warehouses/:id/layout              the layout builder's save (geometry only — never a movement)
//   POST /warehouses/:id/locations/:lid/qr   mint or re-mint a location label token
//   POST /warehouses/:id/qr/backfill         mint tokens for every location without one
//   POST /put | /remove | /transfer | /transfer-all   the guarded physical moves
//   GET  /find?q=                            the locator: items, markings and locations
//   GET  /items/:rawItemId/locations         every position an item is in
//   GET  /markings/:barcodeId                a sticker's placements and journey
//   GET  /unallocated | /putaway-queue | /reconciliation | /movements | /reports/:type
//
// Every read is tenant-scoped. Every write goes through the Store's own chain
// (capability → refuse legacy → idempotency → unit of work) and the guarded
// helpers in services/storePurchase/{locationStock,storeLocations}.service.js,
// so nothing here can put a location below zero, place more than the company
// holds, or land twice on a retry. A TAKE that CONSUMES stock is not here: it
// is the canonical issue (stock-adjustments /issue, MRF issue), which deducts
// company and location stock together. `/remove` only sends stock back to
// Unassigned.
"use strict";

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Warehouse = require("../../../../models/CMS_Models/Inventory/Configurations/Warehouse");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../../../models/CMS_Models/Inventory/Operations/Barcode");
const LocationMovement = require("../../../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../../../models/CMS_Models/Inventory/Operations/LocationBalance");
const GoodsReceipt = require("../../../../models/CMS_Models/StorePurchase/GoodsReceipt");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const { requireTenant, requireCapability, refuseLegacyWrite, withIdempotency } = require("../../../../Middlewear/storePurchaseTenant");
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");
const { CAPABILITIES } = tenantContext;
const unitOfWork = require("../../../../services/storePurchase/unitOfWork.service");
const idempotency = require("../../../../services/storePurchase/idempotency.service");
const actionHistory = require("../../../../services/storePurchase/actionHistory.service");
const { fail, sendError } = require("../../../../services/storePurchase/errors");
const loc = require("../../../../services/storePurchase/locationStock.service");
const S = require("../../../../services/storePurchase/storeLocations.service");

/* A warehouse created before the location layer has neither structureVersion
   nor floorPlan on disk, so a guard of `field: 0` matches nothing and every
   first write reports a conflict. Version 0 therefore also means "absent". */
const versionGuard = (field, seen) => (seen ? { [field]: seen } : { $or: [{ [field]: 0 }, { [field]: { $exists: false } }] });
const ENTITY = "LOCATION_MOVEMENT";
const WH_ENTITY = "WAREHOUSE";
const OPERATE = CAPABILITIES.LOCATION_OPERATE || CAPABILITIES.STOCK_ISSUE;

router.use(EmployeeAuthMiddleware);
router.use(requireTenant);

const scoped = (req, extra = {}) => { const t = tenantContext.tenantFilter(req.tenant); return extra && Object.keys(extra).length ? { $and: [t, extra] } : t; };
const scopeOf = (req) => tenantContext.tenantFilter(req.tenant);
const companyOf = (req) => req.tenant.companyId;
const objectId = (id) => (mongoose.Types.ObjectId.isValid(String(id || "")) ? new mongoose.Types.ObjectId(String(id)) : null);
const strictQty = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? loc.round4(n) : null; };
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
const actorOf = (req) => ({ id: req.user?.id, name: req.user?.name });
const pageOf = (req, def = 50, max = 200) => ({ page: Math.max(1, Number(req.query.page) || 1), limit: Math.min(max, Math.max(1, Number(req.query.limit) || def)) });

function handle(res, e, where) {
  if (e?.name === "StorePurchaseError") return sendError(res, e);
  console.error(`[store-locations] ${where}:`, e);
  return res.status(500).json({ success: false, message: e.message });
}
function succeed(req, res, status, body, entityId, entityType = ENTITY) {
  return req.idempotent ? req.idempotent.succeed(status, body, { entityType, entityId }) : res.status(status).json(body);
}
async function replayed(req, res) {
  return req.idempotent.succeed(200, { success: true, replayed: true, message: "This movement was already processed." }, { entityType: ENTITY, entityId: req.idempotent.recovering?.entityId || null });
}
/* The same MARKED-safe wrapper the other stock routes use. */
async function runMutation(req, { mutate, entityType = ENTITY }) {
  if (await unitOfWork.transactionsAvailable()) return unitOfWork.run(req.tenant, { idempotencyRecord: req.idempotent?.record || null, mutate });
  if (req.idempotent?.record) await idempotency.markEffectApplied({ record: req.idempotent.record, entityType, entityId: null });
  const { entry, result, entityId } = await mutate(null);
  await actionHistory.record(req.tenant, { ...entry, atomicityDegraded: true });
  if (req.idempotent?.record) await idempotency.markEffectApplied({ record: req.idempotent.record, entityType, entityId });
  return { result, mode: "MARKED" };
}
const entry = (req, action, entityId, documentNumber, metadata, reason = "") => ({ entityType: ENTITY, entityId, documentNumber, action, reason, requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata });

async function loadWarehouse(req, id) {
  const oid = objectId(id);
  const w = oid ? await Warehouse.findOne(scoped(req, { _id: oid })).lean() : null;
  if (!w) throw fail("NOT_FOUND", "That warehouse was not found.", { reason: "WAREHOUSE_NOT_FOUND" });
  return w;
}
const publicLoc = (w, l) => ({ id: String(l._id), warehouseId: String(w._id), code: l.code, name: l.name, type: l.type, kind: l.kind || "AREA", status: l.status, sequence: l.sequence || 0, qrToken: l.qrToken || "", layout: l.layout || {}, capacity: l.capacity || {}, parent: l.parent ? String(l.parent) : null, address: S.addressOf(w, l), holds: !S.holdsStockError(w, l) });

/* ── reads ──────────────────────────────────────────────────────────────── */

router.get("/warehouses", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const rows = await Warehouse.find(scoped(req, { status: { $ne: "Archived" } })).select("name shortName status locations.status locations.kind floorPlan.widthCm floorPlan.depthCm").lean();
    res.json({ success: true, warehouses: rows.map((w) => ({ id: String(w._id), name: w.name, code: w.shortName, status: w.status, locations: (w.locations || []).filter((l) => l.status !== "Archived").length, racks: (w.locations || []).filter((l) => l.kind === "RACK" && l.status !== "Archived").length, hasFloorPlan: Boolean(w.floorPlan?.widthCm && w.floorPlan?.depthCm) })) });
  } catch (e) { handle(res, e, "warehouses"); }
});

router.get("/tree", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const w = await loadWarehouse(req, req.query.warehouseId);
    const totals = await S.totalsByLocation(companyOf(req), w._id);
    const tree = S.treeOf(w, totals, { includeArchived: req.query.all === "1" });
    const positions = (w.locations || []).filter((l) => l.status !== "Archived" && !S.holdsStockError(w, l));
    res.json({ success: true, warehouse: { id: String(w._id), name: w.name, code: w.shortName, floorPlan: w.floorPlan || {}, structureVersion: w.structureVersion || 0 }, tree, flat: (w.locations || []).filter((l) => req.query.all === "1" || l.status !== "Archived").map((l) => ({ ...publicLoc(w, l), world: S.worldBoxOf(w, l), totals: totals.get(String(l._id)) || { lines: 0, onHand: 0, items: 0 } })), summary: { positions: positions.length, occupied: positions.filter((l) => totals.has(String(l._id))).length } });
  } catch (e) { handle(res, e, "tree"); }
});

router.get("/resolve", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const parsed = S.parseScan(req.query.code);
    if (parsed.type === "location") {
      const w = await S.warehouseByQrToken(scopeOf(req), parsed.token);
      const l = w ? S.locationByToken(w, parsed.token) : null;
      if (!l) return res.json({ success: true, type: "location", found: false, message: "No location in this company carries that label." });
      const [contents, markings] = await Promise.all([S.contentsOf(scopeOf(req), companyOf(req), w, [l._id]), S.markingsAt(companyOf(req), w._id, [l._id])]);
      return res.json({ success: true, type: "location", found: true, location: publicLoc(w, l), usable: !loc.usableLocationError(w, l, companyOf(req)) && !S.holdsStockError(w, l), reason: (loc.usableLocationError(w, l, companyOf(req)) || {}).message || S.holdsStockError(w, l) || "", contents, markings });
    }
    if (parsed.type === "item") {
      const r = await S.resolveStock(scopeOf(req), { barcodeId: parsed.barcodeId }).catch((e) => ({ error: e }));
      if (r.error) return res.json({ success: true, type: "item", found: false, message: r.error.message });
      const mb = await S.markingBalances(companyOf(req), r.barcode._id);
      const onHand = loc.onHandOf(r.item, r.variantId);
      const sentinel = await LocationBalance.findOne(loc.sentinelFilter(companyOf(req), r.item._id, r.variantId)).lean();
      const assigned = loc.round4(sentinel?.onHand || 0);
      return res.json({ success: true, type: "item", found: true, marking: markingView(r), item: { rawItemId: String(r.item._id), variantId: r.variantId, name: r.item.name, sku: r.variant?.sku || r.item.sku || "", variant: r.variant ? (r.variant.combination || []).join(" · ") : "", baseUnit: loc.baseUnitOf(r.item), onHand, assigned, unassigned: loc.round4(onHand - assigned) }, located: mb.located, remainingToPut: loc.round4(Math.max(0, Math.min(r.barcode.quantity - mb.located, onHand - assigned))), balances: mb.balances });
    }
    return res.json({ success: true, type: parsed.type, found: false, message: parsed.reason || "Not a store code." });
  } catch (e) { handle(res, e, "resolve"); }
});
const markingView = (r) => ({ barcodeId: String(r.barcode._id), rawItemName: r.barcode.rawItemName || r.item.name, rawItemSku: r.barcode.rawItemSku || r.item.sku, variant: (r.barcode.variantCombination || []).join(" · "), variantSku: r.barcode.variantSku || "", quantity: r.barcode.quantity, unit: r.barcode.unit, purchaseOrderNumber: r.barcode.purchaseOrderNumber || "", vendorName: r.barcode.vendorName || "", unitPrice: r.barcode.unitPrice ?? null, printedAt: r.barcode.createdAt, label: r.barcodeLabel });

router.get("/locations/:locationId", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const w = await S.warehouseByLocationId(scopeOf(req), req.params.locationId);
    const l = w ? S.locationIn(w, req.params.locationId) : null;
    if (!l) return res.status(404).json({ success: false, message: "That location was not found in this company." });
    const desc = S.descendantsOf(w, l);
    const ids = [l._id, ...desc.map((d) => d._id)];
    const [contents, markings, recent, totals] = await Promise.all([
      S.contentsOf(scopeOf(req), companyOf(req), w, ids), S.markingsAt(companyOf(req), w._id, ids),
      LocationMovement.find(scoped(req, { warehouseId: w._id, locationId: { $in: ids } })).sort({ createdAt: -1 }).limit(25).lean(),
      S.totalsByLocation(companyOf(req), w._id),
    ]);
    const children = (S.childrenMapOf(w).get(String(l._id)) || []).filter((c) => c.status !== "Archived").map((c) => ({ ...publicLoc(w, c), totals: aggTotals(w, c, totals) }));
    const own = contents.filter((c) => c.locationId === String(l._id));
    const cap = l.capacity || {};
    const usedInUnit = own.filter((c) => !cap.unit || c.baseUnit === cap.unit).reduce((n, c) => n + c.onHand, 0);
    res.json({ success: true, location: publicLoc(w, l), warehouse: { id: String(w._id), name: w.name, code: w.shortName }, world: S.worldBoxOf(w, l), children, contents, markings, recent: recent.map(movementView), totals: aggTotals(w, l, totals),
      occupancy: cap.value ? { value: cap.value, unit: cap.unit, used: loc.round4(usedInUnit), pct: Math.round((usedInUnit / cap.value) * 100), state: usedInUnit >= cap.value ? "full" : usedInUnit >= (cap.value * (cap.warnAtPct || 90)) / 100 ? "nearly_full" : "available", unitMismatch: own.some((c) => cap.unit && c.baseUnit !== cap.unit) } : null,
      canPut: !loc.usableLocationError(w, l, companyOf(req)) && !S.holdsStockError(w, l), qrPayload: l.qrToken ? S.locationQrPayload(l.qrToken) : "" });
  } catch (e) { handle(res, e, "location"); }
});
function aggTotals(w, l, totals) {
  const ids = [String(l._id), ...S.descendantsOf(w, l).map((d) => String(d._id))];
  return ids.reduce((a, id) => { const t = totals.get(id); return t ? { lines: a.lines + t.lines, onHand: loc.round4(a.onHand + t.onHand), items: a.items + t.items } : a; }, { lines: 0, onHand: 0, items: 0 });
}
const movementView = (m) => ({ id: String(m._id), at: m.createdAt, type: m.type, direction: m.direction, quantity: m.quantity, baseUnit: m.baseUnit, itemId: String(m.itemId), variantId: m.variantId ? String(m.variantId) : null, warehouseId: String(m.warehouseId), warehouseName: m.warehouseName, locationId: String(m.locationId), locationCode: m.locationCode, locationName: m.locationName, barcodeId: m.barcodeId ? String(m.barcodeId) : null, barcodeLabel: m.barcodeLabel || "", transferId: m.transferId ? String(m.transferId) : null, source: m.source || {}, actorName: m.actorName || "", note: m.note || "" });

router.get("/locations/:locationId/movements", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const w = await S.warehouseByLocationId(scopeOf(req), req.params.locationId);
    const l = w ? S.locationIn(w, req.params.locationId) : null;
    if (!l) return res.status(404).json({ success: false, message: "That location was not found in this company." });
    const ids = [l._id, ...S.descendantsOf(w, l).map((d) => d._id)];
    const { page, limit } = pageOf(req);
    const q = scoped(req, { warehouseId: w._id, locationId: { $in: ids } });
    const [rows, total] = await Promise.all([LocationMovement.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), LocationMovement.countDocuments(q)]);
    res.json({ success: true, ...(await withItemNames(rows.map(movementView))), total, page, limit });
  } catch (e) { handle(res, e, "location movements"); }
});
async function withItemNames(views) {
  const ids = [...new Set(views.map((v) => v.itemId))].map(objectId).filter(Boolean);
  const items = ids.length ? await RawItem.find({ _id: { $in: ids } }).select("name sku variants._id variants.combination variants.sku").lean() : [];
  const by = new Map(items.map((i) => [String(i._id), i]));
  return { movements: views.map((v) => { const it = by.get(v.itemId); const vr = v.variantId && it ? (it.variants || []).find((x) => String(x._id) === v.variantId) : null; return { ...v, itemName: it?.name || "", sku: vr?.sku || it?.sku || "", variant: vr ? (vr.combination || []).join(" · ") : "" }; }) };
}

/* ── structure: the rack wizard, the layout, labels ─────────────────────── */

router.post("/warehouses/:id/racks", requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite, withIdempotency("LOCATION_RACK_CREATE", { target: (req) => `warehouse:${req.params.id}` }), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return req.idempotent.succeed(200, { success: true, replayed: true }, { entityType: WH_ENTITY, entityId: objectId(req.params.id) });
    const w = await loadWarehouse(req, req.params.id);
    if (w.status === "Archived") throw fail("LIFECYCLE_BLOCKED", "This warehouse is archived.", { reason: "WAREHOUSE_ARCHIVED" });
    const plan = S.rackPlan(req.body);
    const parent = req.body.parent ? S.locationIn(w, req.body.parent) : null;
    if (req.body.parent && !parent) throw fail("VALIDATION", "That parent location was not found in this warehouse.", { reason: "PARENT_NOT_FOUND" });
    if (parent && parent.status !== "Active") throw fail("VALIDATION", `${parent.code} is ${String(parent.status).toLowerCase()}, so nothing can be placed inside it.`, { reason: "PARENT_NOT_ACTIVE" });
    const existing = new Set((w.locations || []).map((l) => l.code));
    const clash = plan.specs.map((s) => s.code).filter((c) => existing.has(c));
    if (clash.length) throw fail("VALIDATION", `These codes already exist in this warehouse: ${clash.slice(0, 5).join(", ")}${clash.length > 5 ? "…" : ""}.`, { reason: "DUPLICATE_LOCATION_CODE", codes: clash });
    /* ids first, so parents can be wired before the write */
    const idByRef = new Map(plan.specs.map((s) => [s.ref, new mongoose.Types.ObjectId()]));
    const actor = objectId(req.user?.id);
    const docs = plan.specs.map((s) => ({ _id: idByRef.get(s.ref), code: s.code, name: s.name, type: s.type, kind: s.kind, parent: s.parentRef ? idByRef.get(s.parentRef) : (parent ? parent._id : null), status: "Active", sequence: s.sequence, layout: s.layout, capacity: {}, qrToken: S.mintQrToken(), barcode: "", description: "", createdBy: actor }));
    const seenVersion = w.structureVersion || 0;
    const { result, mode } = await runMutation(req, { entityType: WH_ENTITY, mutate: async (session) => {
      const doc = await Warehouse.findOneAndUpdate(scoped(req, { _id: w._id, status: { $ne: "Archived" }, ...versionGuard("structureVersion", seenVersion), "locations.code": { $nin: plan.specs.map((s) => s.code) } }), { $push: { locations: { $each: docs } }, $set: { updatedBy: actor }, $inc: { structureVersion: 1 } }, { new: true, runValidators: true, session }).lean();
      if (!doc) throw fail("CONFLICT", "This warehouse changed while the rack was being created. Reload it and try again.", { reason: "STRUCTURE_CONFLICT" });
      return { entityType: WH_ENTITY, entityId: doc._id, entry: { entityType: WH_ENTITY, entityId: doc._id, documentNumber: doc.shortName, action: "LOCATION_RACK_CREATED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { rackCode: plan.code, levels: plan.levels, bays: plan.bays, positions: plan.positions, storageKind: plan.storageKind, created: docs.length, rackId: String(idByRef.get("rack")) } }, result: doc };
    } });
    const rack = (result.locations || []).find((l) => String(l._id) === String(idByRef.get("rack")));
    return succeed(req, res, 201, { success: true, rack: publicLoc(result, rack), created: docs.length, positions: plan.positionsCreated, atomicity: { mode, degraded: mode !== "TRANSACTIONAL" } }, result._id, WH_ENTITY);
  } catch (e) { handle(res, e, "rack wizard"); }
});

router.put("/warehouses/:id/layout", requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite, withIdempotency("LOCATION_LAYOUT_SAVE", { target: (req) => `warehouse:${req.params.id}` }), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return req.idempotent.succeed(200, { success: true, replayed: true }, { entityType: WH_ENTITY, entityId: objectId(req.params.id) });
    const w = await loadWarehouse(req, req.params.id);
    const expected = Number(req.body.layoutVersion);
    const current = w.floorPlan?.layoutVersion || 0;
    if (Number.isFinite(expected) && expected !== current) throw fail("CONFLICT", "Somebody saved this layout after you opened it. Reload the builder and apply your changes again.", { reason: "STALE_VERSION", current });
    const $set = { "floorPlan.layoutVersion": current + 1, "floorPlan.layoutUpdatedAt": new Date(), "floorPlan.layoutUpdatedBy": objectId(req.user?.id) };
    const fp = req.body.floorPlan || {};
    for (const k of ["widthCm", "depthCm", "heightCm", "gridCm"]) if (fp[k] !== undefined) { const n = Number(fp[k]); if (!Number.isFinite(n) || n < 0) throw fail("VALIDATION", `Floor ${k} must be a non-negative number of centimetres.`, { reason: "INVALID_LAYOUT" }); $set[`floorPlan.${k}`] = n; }
    if (fp.notes !== undefined) $set["floorPlan.notes"] = text(fp.notes).slice(0, 2000);
    if (Array.isArray(fp.walls)) $set["floorPlan.walls"] = fp.walls.slice(0, 200).map((x) => ({ id: text(x.id) || String(new mongoose.Types.ObjectId()), x1: Number(x.x1) || 0, z1: Number(x.z1) || 0, x2: Number(x.x2) || 0, z2: Number(x.z2) || 0, thickness: Number(x.thickness) || 15, height: Number(x.height) || (fp.heightCm || w.floorPlan?.heightCm || 300), label: text(x.label) }));
    if (Array.isArray(fp.fixtures)) $set["floorPlan.fixtures"] = fp.fixtures.slice(0, 200).map((x) => ({ id: text(x.id) || String(new mongoose.Types.ObjectId()), kind: text(x.kind) || "door", x: Number(x.x) || 0, z: Number(x.z) || 0, w: Number(x.w) || 0, d: Number(x.d) || 0, h: Number(x.h) || 0, rotation: Number(x.rotation) || 0, label: text(x.label) }));
    const items = Array.isArray(req.body.items) ? req.body.items : [];
    const arrayFilters = [];
    let n = 0;
    for (const it of items) {
      const l = S.locationIn(w, it.locationId);
      if (!l) throw fail("VALIDATION", `Location ${it.locationId} is not in this warehouse.`, { reason: "LOCATION_NOT_FOUND" });
      const layout = S.validateLayout(it.layout) || {};
      const key = `l${n++}`;
      for (const [k, v] of Object.entries(layout)) $set[`locations.$[${key}].layout.${k}`] = v;
      if (it.sequence !== undefined) $set[`locations.$[${key}].sequence`] = Number(it.sequence) || 0;
      if (it.parent !== undefined) {
        const p = it.parent ? S.locationIn(w, it.parent) : null;
        if (it.parent && !p) throw fail("VALIDATION", "A parent named in the layout is not in this warehouse.", { reason: "PARENT_NOT_FOUND" });
        if (p && String(p._id) === String(l._id)) throw fail("VALIDATION", "A location cannot be its own parent.", { reason: "SELF_PARENT" });
        if (p && S.descendantsOf(w, l).some((d) => String(d._id) === String(p._id))) throw fail("VALIDATION", "That would place a location inside its own child.", { reason: "CYCLE" });
        $set[`locations.$[${key}].parent`] = p ? p._id : null;
      }
      arrayFilters.push({ [`${key}._id`]: l._id });
    }
    const { result, mode } = await runMutation(req, { entityType: WH_ENTITY, mutate: async (session) => {
      const doc = await Warehouse.findOneAndUpdate(scoped(req, { _id: w._id, ...versionGuard("floorPlan.layoutVersion", current) }), { $set }, { new: true, runValidators: true, session, arrayFilters }).lean();
      if (!doc) throw fail("CONFLICT", "Somebody saved this layout after you opened it. Reload the builder and apply your changes again.", { reason: "STALE_VERSION" });
      return { entityType: WH_ENTITY, entityId: doc._id, entry: { entityType: WH_ENTITY, entityId: doc._id, documentNumber: doc.shortName, action: "LOCATION_LAYOUT_SAVED", requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { locationsMoved: items.length, floorChanged: Object.keys(fp).length > 0, layoutVersion: current + 1 } }, result: doc };
    } });
    return succeed(req, res, 200, { success: true, layoutVersion: result.floorPlan?.layoutVersion || 0, floorPlan: result.floorPlan || {}, atomicity: { mode } }, result._id, WH_ENTITY);
  } catch (e) { handle(res, e, "layout save"); }
});

async function mintTokens(req, w, locationIds, action) {
  const actor = objectId(req.user?.id);
  const $set = { updatedBy: actor };
  const arrayFilters = [];
  const minted = [];
  locationIds.forEach((lid, i) => { const t = S.mintQrToken(); $set[`locations.$[t${i}].qrToken`] = t; arrayFilters.push({ [`t${i}._id`]: lid }); minted.push({ locationId: String(lid), qrToken: t }); });
  const { result } = await runMutation(req, { entityType: WH_ENTITY, mutate: async (session) => {
    const doc = await Warehouse.findOneAndUpdate(scoped(req, { _id: w._id }), { $set }, { new: true, session, arrayFilters }).lean();
    if (!doc) throw fail("CONFLICT", "The warehouse changed underneath this request.", { reason: "STRUCTURE_CONFLICT" });
    return { entityType: WH_ENTITY, entityId: doc._id, entry: { entityType: WH_ENTITY, entityId: doc._id, documentNumber: doc.shortName, action, requestId: req.id || "", idempotencyKey: req.idempotent?.key || "", metadata: { count: minted.length, first: minted[0]?.locationId || "" } }, result: doc };
  } });
  return { doc: result, minted };
}
router.post("/warehouses/:id/locations/:locationId/qr", requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite, withIdempotency("LOCATION_QR_MINT", { target: (req) => `warehouse:${req.params.id}/location:${req.params.locationId}` }), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return req.idempotent.succeed(200, { success: true, replayed: true }, { entityType: WH_ENTITY, entityId: objectId(req.params.id) });
    const w = await loadWarehouse(req, req.params.id);
    const l = S.locationIn(w, req.params.locationId);
    if (!l) throw fail("NOT_FOUND", "That location was not found in this warehouse.", { reason: "LOCATION_NOT_FOUND" });
    if (l.qrToken && !req.body.regenerate) return succeed(req, res, 200, { success: true, location: publicLoc(w, l), qrPayload: S.locationQrPayload(l.qrToken), unchanged: true }, w._id, WH_ENTITY);
    const { doc, minted } = await mintTokens(req, w, [l._id], l.qrToken ? "LOCATION_QR_REGENERATED" : "LOCATION_QR_MINTED");
    const after = S.locationIn(doc, l._id);
    return succeed(req, res, 200, { success: true, location: publicLoc(doc, after), qrPayload: S.locationQrPayload(minted[0].qrToken), previous: l.qrToken || "" }, doc._id, WH_ENTITY);
  } catch (e) { handle(res, e, "qr mint"); }
});
router.post("/warehouses/:id/qr/backfill", requireCapability(CAPABILITIES.MASTER_MAINTAIN), refuseLegacyWrite, withIdempotency("LOCATION_QR_BACKFILL", { target: (req) => `warehouse:${req.params.id}` }), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return req.idempotent.succeed(200, { success: true, replayed: true }, { entityType: WH_ENTITY, entityId: objectId(req.params.id) });
    const w = await loadWarehouse(req, req.params.id);
    const missing = (w.locations || []).filter((l) => !l.qrToken && l.status !== "Archived").map((l) => l._id);
    if (!missing.length) return succeed(req, res, 200, { success: true, minted: 0 }, w._id, WH_ENTITY);
    const { minted } = await mintTokens(req, w, missing, "LOCATION_QR_BACKFILLED");
    return succeed(req, res, 200, { success: true, minted: minted.length }, w._id, WH_ENTITY);
  } catch (e) { handle(res, e, "qr backfill"); }
});

/* ── the guarded physical moves ─────────────────────────────────────────── */

router.post("/put", requireCapability(OPERATE), refuseLegacyWrite, withIdempotency("LOCATION_PUT"), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return replayed(req, res);
    const qty = strictQty(req.body?.quantity);
    if (qty === null) throw fail("VALIDATION", "Quantity must be a positive number.", { reason: "INVALID_QUANTITY" });
    const stock = await S.resolveStock(scopeOf(req), req.body || {});
    const dest = await S.resolveDestination(scopeOf(req), companyOf(req), { locationId: req.body?.locationId, qrToken: req.body?.locationToken });
    const onHand = loc.onHandOf(stock.item, stock.variantId);
    const sentinel = await LocationBalance.findOne(loc.sentinelFilter(companyOf(req), stock.item._id, stock.variantId)).lean();
    const unassigned = loc.round4(onHand - (sentinel?.onHand || 0));
    if (qty > unassigned + loc.QTY_TOL) throw fail("VALIDATION", `Only ${unassigned} ${loc.baseUnitOf(stock.item)} of this item is still unplaced (on hand ${onHand}); to move stock that is already on a rack, use Transfer.`, { reason: "EXCEEDS_ON_HAND", onHand, unassigned, requested: qty });
    const { result, mode } = await runMutation(req, { mutate: async (session) => {
      const r = await S.putStock(session, { companyId: companyOf(req), siteId: req.tenant.siteId, tenantStamp: tenantContext.stamp(req.tenant), ...stock, warehouse: dest.warehouse, location: dest.location, quantity: qty, actor: actorOf(req), note: text(req.body?.note), idempotencyKey: req.idempotent?.key || "", source: { kind: req.body?.source === "scan" ? "scan_put" : "put", id: req.idempotent?.record?._id || null, reference: stock.barcode ? String(stock.barcode._id) : "" } });
      return { entityType: ENTITY, entityId: r.movement._id, entry: entry(req, "STOCK_LOCATION_ASSIGNED", r.movement._id, String(r.movement._id), { warehouseId: String(dest.warehouse._id), locationId: String(dest.location._id), locationCode: dest.location.code, quantity: qty, barcodeId: stock.barcode ? String(stock.barcode._id) : "", via: "store-locations/put" }, text(req.body?.note)), result: r };
    } });
    return succeed(req, res, 201, { success: true, movement: movementView(result.movement), location: { ...publicLoc(dest.warehouse, dest.location), before: result.before, after: result.after }, item: { rawItemId: String(stock.item._id), variantId: stock.variantId, name: stock.item.name, baseUnit: loc.baseUnitOf(stock.item), onHand: result.companyOnHand }, marking: stock.barcode ? markingView(stock) : null, atomicity: { mode } }, result.movement._id);
  } catch (e) { handle(res, e, "put"); }
});

router.post("/remove", requireCapability(OPERATE), refuseLegacyWrite, withIdempotency("LOCATION_REMOVE"), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return replayed(req, res);
    const qty = strictQty(req.body?.quantity);
    if (qty === null) throw fail("VALIDATION", "Quantity must be a positive number.", { reason: "INVALID_QUANTITY" });
    const reason = text(req.body?.reason);
    if (reason.length < 3) throw fail("VALIDATION", "Say why this stock is leaving its position (it stays in the company's stock as Unassigned).", { reason: "REASON_REQUIRED" });
    const stock = await S.resolveStock(scopeOf(req), req.body || {});
    const src = await resolveSource(req, req.body?.locationId, req.body?.locationToken);
    const { result, mode } = await runMutation(req, { mutate: async (session) => {
      const r = await S.unassignStock(session, { companyId: companyOf(req), siteId: req.tenant.siteId, tenantStamp: tenantContext.stamp(req.tenant), ...stock, warehouse: src.warehouse, location: src.location, quantity: qty, actor: actorOf(req), note: reason, idempotencyKey: req.idempotent?.key || "", source: { kind: "remove_from_position", id: req.idempotent?.record?._id || null, reference: stock.barcode ? String(stock.barcode._id) : "" } });
      return { entityType: ENTITY, entityId: r.movement._id, entry: entry(req, "STOCK_LOCATION_REMOVED", r.movement._id, String(r.movement._id), { warehouseId: String(src.warehouse._id), locationId: String(src.location._id), locationCode: src.location.code, quantity: qty, barcodeId: stock.barcode ? String(stock.barcode._id) : "" }, reason), result: r };
    } });
    return succeed(req, res, 201, { success: true, movement: movementView(result.movement), location: { ...publicLoc(src.warehouse, src.location), before: result.before, after: result.after }, atomicity: { mode } }, result.movement._id);
  } catch (e) { handle(res, e, "remove"); }
});
async function resolveSource(req, locationId, token) {
  const w = token ? await S.warehouseByQrToken(scopeOf(req), token) : await S.warehouseByLocationId(scopeOf(req), locationId);
  const l = w ? (token ? S.locationByToken(w, token) : S.locationIn(w, locationId)) : null;
  if (!w || !l) throw fail("NOT_FOUND", "That location was not found in this company.", { reason: "LOCATION_NOT_FOUND" });
  if (String(w.companyId || "") && String(w.companyId) !== String(companyOf(req))) throw fail("NOT_FOUND", "That location was not found in this company.", { reason: "LOCATION_NOT_FOUND" });
  return { warehouse: w, location: l };
}

router.post("/transfer", requireCapability(OPERATE), refuseLegacyWrite, withIdempotency("LOCATION_TRANSFER_SCAN"), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return replayed(req, res);
    const qty = strictQty(req.body?.quantity);
    if (qty === null) throw fail("VALIDATION", "Quantity must be a positive number.", { reason: "INVALID_QUANTITY" });
    const stock = await S.resolveStock(scopeOf(req), req.body || {});
    const from = await resolveSource(req, req.body?.fromLocationId, req.body?.fromLocationToken);
    const to = await S.resolveDestination(scopeOf(req), companyOf(req), { locationId: req.body?.toLocationId, qrToken: req.body?.toLocationToken });
    if (from.location.type === "RECEIVING" && to.location.type !== "USABLE_STOCK") throw fail("VALIDATION", "Put away from a receiving location must go to usable storage.", { reason: "PUTAWAY_DESTINATION_NOT_USABLE" });
    const { result, mode } = await runMutation(req, { mutate: async (session) => {
      const r = await S.transferStock(session, { companyId: companyOf(req), siteId: req.tenant.siteId, tenantStamp: tenantContext.stamp(req.tenant), ...stock, from, to, quantity: qty, actor: actorOf(req), note: text(req.body?.note), idempotencyKey: req.idempotent?.key || "" });
      return { entityType: ENTITY, entityId: r.transferId, entry: entry(req, "STOCK_TRANSFERRED", r.transferId, String(r.transferId), { transferId: String(r.transferId), quantity: qty, from: from.location.code, to: to.location.code, barcodeId: stock.barcode ? String(stock.barcode._id) : "", via: "store-locations/transfer" }, text(req.body?.note)), result: r };
    } });
    return succeed(req, res, 201, { success: true, transferId: String(result.transferId), quantity: qty, baseUnit: loc.baseUnitOf(stock.item), item: { rawItemId: String(stock.item._id), variantId: stock.variantId, name: stock.item.name, sku: stock.variant?.sku || stock.item.sku || "", variant: stock.variant ? (stock.variant.combination || []).join(" · ") : "" }, marking: stock.barcode ? markingView(stock) : null, source: { ...publicLoc(from.warehouse, from.location), ...result.source }, destination: { ...publicLoc(to.warehouse, to.location), ...result.destination }, companyOnHand: loc.onHandOf(stock.item, stock.variantId), atomicity: { mode } }, result.transferId);
  } catch (e) { handle(res, e, "transfer"); }
});

/* Move EVERYTHING in one position to another: one leg pair per item line and
   per marking within it, all in one unit of work. Refused unless the caller
   confirms the exact line count it saw, so a bin that changed underneath the
   confirmation is not moved blind. */
router.post("/transfer-all", requireCapability(OPERATE), refuseLegacyWrite, withIdempotency("LOCATION_TRANSFER_ALL"), async (req, res) => {
  try {
    if (req.idempotent?.recovering) return replayed(req, res);
    const from = await resolveSource(req, req.body?.fromLocationId, req.body?.fromLocationToken);
    const to = await S.resolveDestination(scopeOf(req), companyOf(req), { locationId: req.body?.toLocationId, qrToken: req.body?.toLocationToken });
    if (String(from.location._id) === String(to.location._id)) throw fail("VALIDATION", "Source and destination must be different.", { reason: "SAME_LOCATION" });
    const contents = await S.contentsOf(scopeOf(req), companyOf(req), from.warehouse, [from.location._id]);
    if (!contents.length) throw fail("VALIDATION", `${from.location.code} is empty.`, { reason: "SOURCE_EMPTY" });
    if (req.body?.expectedLines !== undefined && Number(req.body.expectedLines) !== contents.length) throw fail("CONFLICT", `${from.location.code} now holds ${contents.length} line${contents.length === 1 ? "" : "s"}, not ${req.body.expectedLines}. Review it and confirm again.`, { reason: "CONTENTS_CHANGED", lines: contents.length });
    const markings = await S.markingsAt(companyOf(req), from.warehouse._id, [from.location._id]);
    const { result, mode } = await runMutation(req, { mutate: async (session) => {
      const legs = [];
      let i = 0;
      for (const c of contents) {
        const item = await RawItem.findById(c.rawItemId).lean();
        const variantId = c.variantId || null;
        /* marked stock moves under its markings; whatever is left moves as the item */
        const marks = markings.filter((m) => m.rawItemId === c.rawItemId && (m.variantId || null) === variantId);
        let moved = 0;
        for (const m of marks) {
          const barcode = await Barcode.findById(m.barcodeId).lean();
          const r = await S.transferStock(session, { companyId: companyOf(req), siteId: req.tenant.siteId, tenantStamp: tenantContext.stamp(req.tenant), item, variantId, barcode, barcodeLabel: m.label, from, to, quantity: m.onHand, actor: actorOf(req), note: text(req.body?.note) || "Bulk move", idempotencyKey: loc.movementLineKey(req.idempotent?.key || "", `${c.rawItemId}:${variantId || ""}:${m.barcodeId}`, `bulk${i++}`) });
          legs.push({ ...c, quantity: m.onHand, barcodeId: m.barcodeId, transferId: String(r.transferId) }); moved = loc.round4(moved + m.onHand);
        }
        const rest = loc.round4(c.onHand - moved);
        if (rest > loc.QTY_TOL) {
          const r = await S.transferStock(session, { companyId: companyOf(req), siteId: req.tenant.siteId, tenantStamp: tenantContext.stamp(req.tenant), item, variantId, barcode: null, barcodeLabel: "", from, to, quantity: rest, actor: actorOf(req), note: text(req.body?.note) || "Bulk move", idempotencyKey: loc.movementLineKey(req.idempotent?.key || "", `${c.rawItemId}:${variantId || ""}`, `bulk${i++}`) });
          legs.push({ ...c, quantity: rest, barcodeId: null, transferId: String(r.transferId) });
        }
      }
      const bulkId = new mongoose.Types.ObjectId();
      return { entityType: ENTITY, entityId: bulkId, entry: entry(req, "STOCK_TRANSFERRED", bulkId, String(bulkId), { bulk: true, lines: legs.length, from: from.location.code, to: to.location.code, quantity: loc.round4(legs.reduce((n, l) => n + l.quantity, 0)) }, text(req.body?.note)), result: { bulkId, legs } };
    } });
    return succeed(req, res, 201, { success: true, bulkId: String(result.bulkId), lines: result.legs.length, legs: result.legs, source: publicLoc(from.warehouse, from.location), destination: publicLoc(to.warehouse, to.location), atomicity: { mode } }, result.bulkId);
  } catch (e) { handle(res, e, "transfer-all"); }
});

/* ── the locator ────────────────────────────────────────────────────────── */

router.get("/find", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const q = text(req.query.q);
    if (q.length < 2) return res.json({ success: true, q, items: [], markings: [], locations: [] });
    const companyId = companyOf(req);
    const parsed = S.parseScan(q);
    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    /* items: by name, sku, variant sku/combination, category */
    const items = await RawItem.find(scoped(req, { $or: [{ name: rx }, { sku: rx }, { category: rx }, { "variants.sku": rx }, { "variants.combination": rx }] })).select("name sku category unit customUnit quantity variants._id variants.sku variants.combination variants.quantity").limit(25).lean();
    const itemIds = items.map((i) => i._id);
    const sentinels = itemIds.length ? await LocationBalance.find({ companyId: objectId(companyId), itemId: { $in: itemIds }, warehouseId: null, locationId: null }).lean() : [];
    const locCounts = itemIds.length ? await LocationBalance.aggregate([{ $match: { companyId: objectId(companyId), itemId: { $in: itemIds }, locationId: { $type: "objectId" }, onHand: { $gt: loc.QTY_TOL } } }, { $group: { _id: { itemId: "$itemId", variantId: "$variantId" }, locations: { $sum: 1 } } }]) : [];
    const sentMap = new Map(sentinels.map((s) => [`${s.itemId}:${s.variantId || ""}`, loc.round4(s.onHand)]));
    const locMap = new Map(locCounts.map((c) => [`${c._id.itemId}:${c._id.variantId || ""}`, c.locations]));
    const itemRows = [];
    for (const it of items) {
      const scopes = (it.variants || []).length ? it.variants.filter((v) => !q || rx.test(it.name) || rx.test(it.sku || "") || rx.test(v.sku || "") || (v.combination || []).some((c) => rx.test(c))) : [null];
      for (const v of scopes) {
        const onHand = loc.onHandOf(it, v ? v._id : null); const assigned = sentMap.get(`${it._id}:${v ? v._id : ""}`) || 0;
        itemRows.push({ rawItemId: String(it._id), variantId: v ? String(v._id) : null, name: it.name, sku: v?.sku || it.sku || "", variant: v ? (v.combination || []).join(" · ") : "", category: it.category || "", baseUnit: it.customUnit || it.unit || "", onHand, located: assigned, unallocated: loc.round4(onHand - assigned), locations: locMap.get(`${it._id}:${v ? v._id : ""}`) || 0 });
      }
    }
    /* markings: by sticker id, PO number, vendor, item name/sku */
    const mq = { $or: [{ rawItemName: rx }, { rawItemSku: rx }, { variantSku: rx }, { purchaseOrderNumber: rx }, { vendorName: rx }] };
    if (parsed.type === "item") mq.$or.push({ _id: objectId(parsed.barcodeId) });
    const marks = await Barcode.find(mq).select("rawItem rawItemName rawItemSku variantId variantCombination variantSku quantity unit purchaseOrderNumber vendorName createdAt").sort({ createdAt: -1 }).limit(25).lean();
    const owned = marks.length ? new Set((await RawItem.find(scoped(req, { _id: { $in: marks.map((m) => m.rawItem) } })).select("_id").lean()).map((i) => String(i._id))) : new Set();
    const markingRows = [];
    for (const m of marks.filter((m) => owned.has(String(m.rawItem)))) { const mb = await S.markingBalances(companyId, m._id); markingRows.push({ barcodeId: String(m._id), rawItemId: String(m.rawItem), variantId: m.variantId ? String(m.variantId) : null, rawItemName: m.rawItemName, rawItemSku: m.rawItemSku, variant: (m.variantCombination || []).join(" · "), quantity: m.quantity, unit: m.unit, purchaseOrderNumber: m.purchaseOrderNumber, vendorName: m.vendorName, printedAt: m.createdAt, located: mb.located, unallocated: loc.round4(Math.max(0, m.quantity - mb.located)), locations: mb.balances.length }); }
    /* locations: by code, name, token, address fragment */
    const whs = await Warehouse.find(scoped(req, { status: { $ne: "Archived" } })).lean();
    const locationRows = [];
    for (const w of whs) for (const l of w.locations || []) {
      if (l.status === "Archived") continue;
      const addr = S.addressOf(w, l);
      if (rx.test(l.code) || rx.test(l.name) || (parsed.type === "location" && l.qrToken === parsed.token) || rx.test(addr.code) || rx.test(addr.short)) locationRows.push({ ...publicLoc(w, l), warehouseName: w.name });
      if (locationRows.length >= 25) break;
    }
    res.json({ success: true, q, items: itemRows.slice(0, 40), markings: markingRows, locations: locationRows });
  } catch (e) { handle(res, e, "find"); }
});

router.get("/items/:rawItemId/locations", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const iid = objectId(req.params.rawItemId);
    const item = iid ? await RawItem.findOne(scoped(req, { _id: iid })).lean() : null;
    if (!item) return res.status(404).json({ success: false, message: "Item not found in this company." });
    const companyId = companyOf(req);
    const rows = await LocationBalance.find({ companyId: objectId(companyId), itemId: item._id, locationId: { $type: "objectId" }, onHand: { $gt: loc.QTY_TOL } }).lean();
    const whIds = [...new Set(rows.map((r) => String(r.warehouseId)))].map(objectId);
    const whs = whIds.length ? await Warehouse.find({ _id: { $in: whIds } }).lean() : [];
    const whById = new Map(whs.map((w) => [String(w._id), w]));
    const marks = await LocationMovement.aggregate([{ $match: { companyId: objectId(companyId), itemId: item._id, barcodeId: { $type: "objectId" }, applied: { $ne: false } } }, { $group: { _id: { barcodeId: "$barcodeId", locationId: "$locationId", variantId: "$variantId" }, onHand: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$quantity", { $multiply: ["$quantity", -1] }] } }, label: { $last: "$barcodeLabel" } } }, { $match: { onHand: { $gt: loc.QTY_TOL } } }]);
    const scopes = (item.variants || []).length ? item.variants.map((v) => ({ variantId: String(v._id), variant: (v.combination || []).join(" · "), sku: v.sku || "" })) : [{ variantId: null, variant: "", sku: item.sku || "" }];
    const out = scopes.map((sc) => {
      const mine = rows.filter((r) => (r.variantId ? String(r.variantId) : null) === sc.variantId);
      const onHand = loc.onHandOf(item, sc.variantId);
      const balances = mine.map((r) => { const w = whById.get(String(r.warehouseId)); const l = w ? S.locationIn(w, r.locationId) : null; return { warehouseId: String(r.warehouseId), warehouseName: w?.name || "", locationId: String(r.locationId), location: l && w ? publicLoc(w, l) : null, onHand: loc.round4(r.onHand), markings: marks.filter((m) => String(m._id.locationId) === String(r.locationId) && (m._id.variantId ? String(m._id.variantId) : null) === sc.variantId).map((m) => ({ barcodeId: String(m._id.barcodeId), onHand: loc.round4(m.onHand), label: m.label })) }; });
      const located = loc.round4(balances.reduce((n, b) => n + b.onHand, 0));
      return { ...sc, onHand, located, unallocated: loc.round4(onHand - located), balances };
    });
    res.json({ success: true, item: { rawItemId: String(item._id), name: item.name, sku: item.sku || "", category: item.category || "", baseUnit: loc.baseUnitOf(item), onHand: item.quantity || 0 }, scopes: out });
  } catch (e) { handle(res, e, "item locations"); }
});

router.get("/markings/:barcodeId", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const r = await S.resolveStock(scopeOf(req), { barcodeId: req.params.barcodeId });
    const mb = await S.markingBalances(companyOf(req), r.barcode._id);
    const journey = await LocationMovement.find(scoped(req, { barcodeId: r.barcode._id })).sort({ createdAt: 1 }).lean();
    const whIds = [...new Set(mb.balances.map((b) => b.warehouseId))].map(objectId);
    const whs = whIds.length ? await Warehouse.find({ _id: { $in: whIds } }).lean() : [];
    const whById = new Map(whs.map((w) => [String(w._id), w]));
    res.json({ success: true, marking: markingView(r), item: { rawItemId: String(r.item._id), variantId: r.variantId, name: r.item.name, baseUnit: loc.baseUnitOf(r.item), onHand: loc.onHandOf(r.item, r.variantId) }, located: mb.located, unallocated: loc.round4(Math.max(0, r.barcode.quantity - mb.located)), balances: mb.balances.map((b) => { const w = whById.get(b.warehouseId); const l = w ? S.locationIn(w, b.locationId) : null; return { ...b, location: l && w ? publicLoc(w, l) : null }; }), journey: journey.map(movementView) });
  } catch (e) { handle(res, e, "marking"); }
});

/* ── unallocated, put-away queue, reconciliation ────────────────────────── */

async function reconciliationRows(req) {
  const companyId = companyOf(req);
  const items = await RawItem.find(scoped(req, { status: { $ne: "Inactive" } })).select("name sku category unit customUnit quantity variants._id variants.sku variants.combination variants.quantity").lean();
  const sentinels = await LocationBalance.find({ companyId: objectId(companyId), warehouseId: null, locationId: null }).lean();
  const sentMap = new Map(sentinels.map((s) => [`${s.itemId}:${s.variantId || ""}`, loc.round4(s.onHand)]));
  const tracked = new Set((await LocationMovement.distinct("itemId", { companyId: objectId(companyId) })).map(String));
  const rows = [];
  for (const it of items) {
    const scopes = (it.variants || []).length ? it.variants.map((v) => ({ variantId: String(v._id), variant: (v.combination || []).join(" · "), sku: v.sku || it.sku || "" })) : [{ variantId: null, variant: "", sku: it.sku || "" }];
    for (const sc of scopes) {
      const onHand = loc.onHandOf(it, sc.variantId); const assigned = sentMap.get(`${it._id}:${sc.variantId || ""}`) || 0;
      if (onHand <= loc.QTY_TOL && assigned <= loc.QTY_TOL) continue;
      const diff = loc.round4(onHand - assigned);
      rows.push({ rawItemId: String(it._id), variantId: sc.variantId, name: it.name, sku: sc.sku, variant: sc.variant, category: it.category || "", baseUnit: it.customUnit || it.unit || "", onHand, located: assigned, unallocated: diff > 0 ? diff : 0, excess: diff < -loc.QTY_TOL ? loc.round4(-diff) : 0, state: Math.abs(diff) <= loc.QTY_TOL ? "matched" : diff > 0 ? (assigned > 0 ? "partly_located" : "unallocated") : "location_excess", tracked: tracked.has(String(it._id)) });
    }
  }
  return rows;
}
router.get("/unallocated", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const rows = (await reconciliationRows(req)).filter((r) => r.unallocated > 0).sort((a, b) => b.unallocated - a.unallocated);
    const { page, limit } = pageOf(req, 50, 500);
    res.json({ success: true, total: rows.length, quantity: loc.round4(rows.reduce((n, r) => n + r.unallocated, 0)), rows: rows.slice((page - 1) * limit, page * limit), page, limit });
  } catch (e) { handle(res, e, "unallocated"); }
});
router.get("/putaway-queue", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const companyId = companyOf(req);
    /* stickers whose printed quantity is not fully placed, newest first */
    const owned = await RawItem.find(scoped(req, {})).select("_id").lean();
    const marks = await Barcode.find({ rawItem: { $in: owned.map((i) => i._id) } }).sort({ createdAt: -1 }).limit(300).lean();
    const placed = await LocationMovement.aggregate([{ $match: { companyId: objectId(companyId), barcodeId: { $in: marks.map((m) => m._id) }, applied: { $ne: false } } }, { $group: { _id: "$barcodeId", located: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$quantity", { $multiply: ["$quantity", -1] }] } }, lastAt: { $max: "$createdAt" } } }]);
    const pm = new Map(placed.map((p) => [String(p._id), p]));
    const pending = marks.map((m) => { const p = pm.get(String(m._id)); const located = loc.round4(p?.located || 0); return { barcodeId: String(m._id), rawItemId: String(m.rawItem), variantId: m.variantId ? String(m.variantId) : null, rawItemName: m.rawItemName, rawItemSku: m.rawItemSku, variant: (m.variantCombination || []).join(" · "), quantity: m.quantity, unit: m.unit, purchaseOrderNumber: m.purchaseOrderNumber, vendorName: m.vendorName, printedAt: m.createdAt, located, pending: loc.round4(Math.max(0, m.quantity - located)), lastAt: p?.lastAt || null }; }).filter((r) => r.pending > loc.QTY_TOL);
    /* receipts still in Receiving: lines with put-away outstanding */
    const receipts = await GoodsReceipt.find(scoped(req, { status: { $ne: "VOID" } })).sort({ receiptDate: -1 }).limit(100).select("receiptNumber poNumber supplierName receiptDate warehouseId locationId locationCode lines.rawItemId lines.variantId lines.baseQuantity lines.baseUnit").lean();
    res.json({ success: true, markings: pending, recentReceipts: receipts.map((g) => ({ id: String(g._id), receiptNumber: g.receiptNumber, poNumber: g.poNumber, supplierName: g.supplierName, receiptDate: g.receiptDate, locationCode: g.locationCode, lines: (g.lines || []).length })) });
  } catch (e) { handle(res, e, "putaway queue"); }
});
router.get("/reconciliation", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const rows = await reconciliationRows(req);
    const state = text(req.query.state);
    const filtered = state ? rows.filter((r) => r.state === state) : rows;
    const summary = { matched: rows.filter((r) => r.state === "matched").length, unallocated: rows.filter((r) => r.state === "unallocated").length, partlyLocated: rows.filter((r) => r.state === "partly_located").length, locationExcess: rows.filter((r) => r.state === "location_excess").length, unallocatedQuantityLines: rows.filter((r) => r.unallocated > 0).length };
    const { page, limit } = pageOf(req, 100, 500);
    res.json({ success: true, summary, total: filtered.length, rows: filtered.sort((a, b) => (b.excess - a.excess) || (b.unallocated - a.unallocated)).slice((page - 1) * limit, page * limit), page, limit, invariant: "located + unallocated = on hand (RawItem); located is the sum of the guarded location balances; a movement never changes on hand" });
  } catch (e) { handle(res, e, "reconciliation"); }
});

router.get("/movements", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const f = {};
    if (req.query.type) f.type = { $in: String(req.query.type).split(",") };
    if (req.query.rawItemId && objectId(req.query.rawItemId)) f.itemId = objectId(req.query.rawItemId);
    if (req.query.barcodeId && objectId(req.query.barcodeId)) f.barcodeId = objectId(req.query.barcodeId);
    if (req.query.warehouseId && objectId(req.query.warehouseId)) f.warehouseId = objectId(req.query.warehouseId);
    if (req.query.locationId && objectId(req.query.locationId)) f.locationId = objectId(req.query.locationId);
    if (req.query.actor) f.actorName = new RegExp(String(req.query.actor).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const from = req.query.from ? new Date(req.query.from) : null, to = req.query.to ? new Date(req.query.to) : null;
    if ((from && !Number.isNaN(from.getTime())) || (to && !Number.isNaN(to.getTime()))) f.createdAt = { ...(from && !Number.isNaN(from.getTime()) ? { $gte: from } : {}), ...(to && !Number.isNaN(to.getTime()) ? { $lt: new Date(to.getTime() + 86400000) } : {}) };
    const { page, limit } = pageOf(req);
    const q = scoped(req, f);
    const [rows, total] = await Promise.all([LocationMovement.find(q).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), LocationMovement.countDocuments(q)]);
    res.json({ success: true, ...(await withItemNames(rows.map(movementView))), total, page, limit, types: LocationMovement.MOVEMENT_TYPES });
  } catch (e) { handle(res, e, "movements"); }
});

router.get("/dashboard", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const companyId = companyOf(req);
    const whs = await Warehouse.find(scoped(req, { status: { $ne: "Archived" } })).lean();
    let positions = 0, blocked = 0, containers = 0, racks = 0, unplaced = 0;
    for (const w of whs) for (const l of w.locations || []) { if (l.status === "Archived") continue; if (l.kind === "RACK") racks++; if (S.holdsStockError(w, l)) { containers++; continue; } if (l.status !== "Active") blocked++; else positions++; if (!(l.layout && l.layout.placed)) unplaced++; }
    const occupiedRows = await LocationBalance.aggregate([{ $match: { companyId: objectId(companyId), locationId: { $type: "objectId" }, onHand: { $gt: loc.QTY_TOL } } }, { $group: { _id: "$locationId", lines: { $sum: 1 } } }]);
    const rows = await reconciliationRows(req);
    const since = new Date(Date.now() - 7 * 86400000);
    const [recent, transfers7d, puts7d] = await Promise.all([
      LocationMovement.find(scoped(req, {})).sort({ createdAt: -1 }).limit(12).lean(),
      LocationMovement.countDocuments(scoped(req, { type: "transfer_out", createdAt: { $gte: since } })),
      LocationMovement.countDocuments(scoped(req, { direction: "in", type: { $in: ["opening_assignment", "receipt"] }, createdAt: { $gte: since } })),
    ]);
    res.json({ success: true, warehouses: whs.map((w) => ({ id: String(w._id), name: w.name, code: w.shortName, hasFloorPlan: Boolean(w.floorPlan?.widthCm) })), kpis: { positions, occupied: occupiedRows.length, empty: Math.max(0, positions - occupiedRows.length), blocked, containers, racks, unplacedInLayout: unplaced, unallocatedLines: rows.filter((r) => r.unallocated > 0).length, unallocatedQuantityByUnit: Object.entries(rows.filter((r) => r.unallocated > 0).reduce((m, r) => { m[r.baseUnit || "?"] = loc.round4((m[r.baseUnit || "?"] || 0) + r.unallocated); return m; }, {})).map(([unit, qty]) => ({ unit, qty })), locationExcessLines: rows.filter((r) => r.excess > 0).length, matchedLines: rows.filter((r) => r.state === "matched").length, transfers7d, puts7d }, recent: (await withItemNames(recent.map(movementView))).movements });
  } catch (e) { handle(res, e, "dashboard"); }
});

/* ── reports (JSON; the CMS lays them out and exports) ──────────────────── */
const REPORTS = Object.freeze({
  stockByLocation: "Stock by location", locationByProduct: "Location by product", unallocated: "Unallocated stock", movements: "Movement report", transfers: "Transfer report", occupancy: "Location occupancy", reconciliation: "Inventory vs location", age: "Stock age by location",
});
router.get("/reports/:type", requireCapability(CAPABILITIES.READ), async (req, res) => {
  try {
    const type = req.params.type;
    if (!REPORTS[type]) return res.status(404).json({ success: false, message: "No such report." });
    const companyId = companyOf(req);
    const generatedAt = new Date();
    if (type === "stockByLocation" || type === "occupancy" || type === "age") {
      const whs = await Warehouse.find(scoped(req, req.query.warehouseId && objectId(req.query.warehouseId) ? { _id: objectId(req.query.warehouseId) } : { status: { $ne: "Archived" } })).lean();
      const out = [];
      for (const w of whs) {
        const ids = (w.locations || []).filter((l) => l.status !== "Archived").map((l) => l._id);
        const contents = await S.contentsOf(scopeOf(req), companyId, w, ids);
        for (const c of contents) { const l = S.locationIn(w, c.locationId); out.push({ warehouse: w.name, warehouseCode: w.shortName, ...S.addressOf(w, l), locationCode: l.code, locationName: l.name, kind: l.kind || "AREA", item: c.name, sku: c.sku, variant: c.variant, category: c.category, onHand: c.onHand, baseUnit: c.baseUnit, placedAt: c.placedAt, lastAt: c.lastAt, lastType: c.lastType, ageDays: c.placedAt ? Math.floor((generatedAt - new Date(c.placedAt)) / 86400000) : null, sinceLastMoveDays: c.lastAt ? Math.floor((generatedAt - new Date(c.lastAt)) / 86400000) : null, capacity: l.capacity?.value ?? null, capacityUnit: l.capacity?.unit || "" }); }
        if (type === "occupancy") for (const l of w.locations || []) { if (l.status === "Archived" || S.holdsStockError(w, l)) continue; if (!out.some((o) => o.locationCode === l.code && o.warehouseCode === w.shortName)) out.push({ warehouse: w.name, warehouseCode: w.shortName, ...S.addressOf(w, l), locationCode: l.code, locationName: l.name, kind: l.kind || "AREA", item: "", onHand: 0, baseUnit: "", status: l.status, capacity: l.capacity?.value ?? null, capacityUnit: l.capacity?.unit || "" }); }
      }
      if (type === "age") out.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
      return res.json({ success: true, type, title: REPORTS[type], generatedAt, filters: req.query, rows: out });
    }
    if (type === "locationByProduct") {
      const rows = await reconciliationRows(req);
      const detail = [];
      for (const r of rows.filter((x) => x.located > 0).slice(0, 2000)) { const bal = await LocationBalance.find({ companyId: objectId(companyId), itemId: objectId(r.rawItemId), variantId: r.variantId ? objectId(r.variantId) : null, locationId: { $type: "objectId" }, onHand: { $gt: loc.QTY_TOL } }).lean(); for (const b of bal) { const w = await Warehouse.findById(b.warehouseId).lean(); const l = w ? S.locationIn(w, b.locationId) : null; detail.push({ item: r.name, sku: r.sku, variant: r.variant, category: r.category, baseUnit: r.baseUnit, onHand: r.onHand, located: r.located, unallocated: r.unallocated, warehouse: w?.name || "", ...(l && w ? S.addressOf(w, l) : { code: "", display: "" }), locationCode: l?.code || "", locationOnHand: loc.round4(b.onHand) }); } }
      return res.json({ success: true, type, title: REPORTS[type], generatedAt, filters: req.query, rows: detail });
    }
    if (type === "unallocated" || type === "reconciliation") {
      const rows = await reconciliationRows(req);
      return res.json({ success: true, type, title: REPORTS[type], generatedAt, filters: req.query, rows: type === "unallocated" ? rows.filter((r) => r.unallocated > 0) : rows });
    }
    /* movements / transfers */
    const f = type === "transfers" ? { type: { $in: ["transfer_in", "transfer_out"] } } : {};
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 30 * 86400000), to = req.query.to ? new Date(new Date(req.query.to).getTime() + 86400000) : new Date();
    f.createdAt = { $gte: from, $lt: to };
    if (req.query.warehouseId && objectId(req.query.warehouseId)) f.warehouseId = objectId(req.query.warehouseId);
    const rows = await LocationMovement.find(scoped(req, f)).sort({ createdAt: -1 }).limit(5000).lean();
    return res.json({ success: true, type, title: REPORTS[type], generatedAt, filters: { ...req.query, from: from.toISOString(), to: to.toISOString() }, rows: (await withItemNames(rows.map(movementView))).movements });
  } catch (e) { handle(res, e, "report"); }
});
router.get("/reports", requireCapability(CAPABILITIES.READ), (_req, res) => res.json({ success: true, reports: Object.entries(REPORTS).map(([key, label]) => ({ key, label })) }));

module.exports = router;
