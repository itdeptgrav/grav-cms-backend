// services/storePurchase/storeLocations.service.js
//
// THE PHYSICAL STORE — racks, shelves, drawers and bins as real, addressable,
// scannable, drawable locations (25 Sep 2026).
//
// This sits ON the existing Warehouse Stock layer and adds nothing that
// competes with it:
//
//   · a location is still a `Warehouse.locations[]` subdocument — this file
//     gives it a physical KIND, an order among its siblings, a layout box in
//     centimetres, an optional capacity and a stable QR token;
//   · stock still lives in the immutable LocationMovement ledger and the
//     guarded LocationBalance projection (locationStock.service.js); PUT,
//     TRANSFER and REMOVE here are the same guarded writes, tagged with the
//     printed marking (Barcode) they were scanned from;
//   · a marking's split across locations is DERIVED by replaying the rows
//     that carry its id; the atomic guard stays at item/variant/location grain,
//     which is the grain the inventory is counted at.
//
// Three things are kept apart on purpose and connected only by references:
// what the company OWNS (RawItem on-hand), which MARKED stock a sticker
// represents (Barcode), and WHERE it is (this layer).
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const loc = require("./locationStock.service");
const { fail } = require("./errors");

const { LOCATION_KINDS, HOLDING_KINDS } = Warehouse;
const KIND_LABEL = Object.freeze({
  AREA: "Area", ZONE: "Zone", AISLE: "Aisle", RACK: "Rack", BAY: "Bay", LEVEL: "Level",
  SHELF: "Shelf", DRAWER: "Drawer", BIN: "Bin", SLOT: "Slot", FLOOR: "Floor space",
});
/* Kinds that are containers of other locations rather than places stock sits. */
const CONTAINER_KINDS = new Set(["ZONE", "AISLE", "RACK", "BAY", "LEVEL"]);
const round4 = loc.round4;
const oid = (v) => (mongoose.Types.ObjectId.isValid(String(v || "")) ? new mongoose.Types.ObjectId(String(v)) : null);
const isId = (v) => /^[0-9a-f]{24}$/i.test(String(v || ""));
const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
const num = (v, d = null) => { if (v === undefined || v === null || v === "") return d; const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ══ THE PHYSICAL FIELDS ═════════════════════════════════════════════════════ */

function validateKind(raw) {
  const k = text(raw).toUpperCase();
  if (!k) return null;
  if (!LOCATION_KINDS.includes(k)) throw fail("VALIDATION", "Choose one of the supported location kinds.", { reason: "INVALID_LOCATION_KIND", allowed: LOCATION_KINDS });
  return k;
}
function validateLayout(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object") throw fail("VALIDATION", "Layout must be an object of numbers in centimetres.", { reason: "INVALID_LAYOUT" });
  const out = {};
  for (const k of ["x", "y", "z", "w", "h", "d", "rotation"]) {
    if (raw[k] !== undefined) {
      const n = num(raw[k]);
      if (n === null) throw fail("VALIDATION", `Layout ${k} must be a number (centimetres, degrees for rotation).`, { reason: "INVALID_LAYOUT", field: k });
      if (["w", "h", "d"].includes(k) && n < 0) throw fail("VALIDATION", `Layout ${k} cannot be negative.`, { reason: "INVALID_LAYOUT", field: k });
      out[k] = k === "rotation" ? ((n % 360) + 360) % 360 : Math.round(n * 10) / 10;
    }
  }
  if (raw.color !== undefined) { const c = text(raw.color); if (c && !/^#[0-9a-f]{3,8}$/i.test(c)) throw fail("VALIDATION", "Layout colour must be a hex colour.", { reason: "INVALID_LAYOUT", field: "color" }); out.color = c; }
  if (raw.placed !== undefined) out.placed = Boolean(raw.placed);
  return out;
}
function validateCapacity(raw) {
  if (raw === undefined) return undefined;
  if (raw === null) return {};
  if (typeof raw !== "object") throw fail("VALIDATION", "Capacity must be an object.", { reason: "INVALID_CAPACITY" });
  const out = {};
  if (raw.value !== undefined) { const n = raw.value === null || raw.value === "" ? null : num(raw.value); if (n !== null && n < 0) throw fail("VALIDATION", "Capacity cannot be negative.", { reason: "INVALID_CAPACITY" }); out.value = n; }
  if (raw.unit !== undefined) out.unit = text(raw.unit);
  if (raw.warnAtPct !== undefined) { const n = num(raw.warnAtPct, 90); if (n < 1 || n > 100) throw fail("VALIDATION", "The warning threshold is a percentage between 1 and 100.", { reason: "INVALID_CAPACITY" }); out.warnAtPct = n; }
  if (raw.note !== undefined) out.note = text(raw.note).slice(0, 300);
  return out;
}

/** For a CREATE: the physical fields a body carries, validated, with defaults. */
function physicalFieldsFromBody(body = {}) {
  const kind = validateKind(body.kind) || "AREA";
  const sequence = num(body.sequence, 0);
  const layout = validateLayout(body.layout) || {};
  const capacity = validateCapacity(body.capacity) || {};
  if (layout.w || layout.h || layout.d) layout.placed = layout.placed ?? true;
  return { kind, sequence, layout, capacity };
}

/** For an UPDATE: dotted $set entries, only for the fields the body carries. */
function physicalSetFromBody(body = {}, prefix = "") {
  const $set = {};
  if (body.kind !== undefined) $set[`${prefix}kind`] = validateKind(body.kind) || "AREA";
  if (body.sequence !== undefined) $set[`${prefix}sequence`] = num(body.sequence, 0);
  const layout = validateLayout(body.layout);
  if (layout !== undefined) for (const [k, v] of Object.entries(layout)) $set[`${prefix}layout.${k}`] = v;
  const capacity = validateCapacity(body.capacity);
  if (capacity !== undefined) for (const [k, v] of Object.entries(capacity)) $set[`${prefix}capacity.${k}`] = v;
  return $set;
}

/* ══ QR TOKENS AND SCAN PARSING ══════════════════════════════════════════════ */

/* A token is what a printed LOCATION label carries: `LOC-` + 8 characters
   from an alphabet with no 0/O or 1/I confusion. It is minted once and never
   derived from the code, so a renamed rack keeps its label. */
const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function mintQrToken() {
  const bytes = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += TOKEN_ALPHABET[bytes[i] % TOKEN_ALPHABET.length];
  return `LOC-${s}`;
}
const TOKEN_RE = /^LOC-[A-Z2-9]{8}$/;
const LOCATION_QR_PARAM = "loc";
const LOCATION_SCAN_PATH = "/store/dashboard/locations/scan";
const locationQrPayload = (token, origin = "") => (origin ? `${origin.replace(/\/+$/, "")}${LOCATION_SCAN_PATH}?${LOCATION_QR_PARAM}=${token}` : `${LOCATION_QR_PARAM}=${token}`);

/**
 * What did the scanner hand us? A LOCATION label, an ITEM (marking) sticker,
 * or neither. Mirrors the frontend's parseItemQr so a phone-camera URL, a
 * wedge-scanner string and a bare id all resolve the same way — and validated
 * here, server-side, because the frontend is not the only caller.
 */
function parseScan(raw) {
  const s = String(raw || "").trim();
  if (!s) return { type: "empty" };
  let loc = null, item = null;
  if (/^https?:\/\//i.test(s)) {
    try { const u = new URL(s); loc = u.searchParams.get(LOCATION_QR_PARAM); item = u.searchParams.get("itemid"); } catch { /* fall through */ }
  }
  const locM = /^(?:loc|location)=(.+)$/i.exec(s);
  if (locM) loc = locM[1];
  const itemM = /^(?:itemid|rawitem)=(.+)$/i.exec(s);
  if (itemM) item = itemM[1];
  if (!loc && !item) {
    if (/^LOC-/i.test(s)) loc = s; // a location label, well-formed or not
    else if (isId(s)) item = s;
  }
  if (loc) { const t = String(loc).trim().toUpperCase(); return TOKEN_RE.test(t) ? { type: "location", token: t } : { type: "invalid", reason: "That is not a valid location label." }; }
  if (item) { const id = String(item).trim(); return isId(id) ? { type: "item", barcodeId: id.toLowerCase() } : { type: "invalid", reason: "That is not a valid item sticker." }; }
  if (/^WO-[0-9a-f]{8,24}-\d+$/i.test(s)) return { type: "piece", reason: "That is a production piece barcode, not store stock." };
  return { type: "unknown", reason: "This code is not a location label or an item sticker." };
}

/* ══ THE HIERARCHY ═══════════════════════════════════════════════════════════ */

const byIdOf = (warehouse) => new Map((warehouse.locations || []).map((l) => [String(l._id), l]));
function childrenMapOf(warehouse) {
  const m = new Map();
  for (const l of warehouse.locations || []) { const k = l.parent ? String(l.parent) : ""; if (!m.has(k)) m.set(k, []); m.get(k).push(l); }
  for (const list of m.values()) list.sort((a, b) => (a.sequence || 0) - (b.sequence || 0) || String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));
  return m;
}
/** Root → … → the location itself. Stops on a cycle. */
function pathOf(warehouse, location) {
  const byId = byIdOf(warehouse);
  const out = [location];
  const seen = new Set([String(location._id)]);
  let cur = location.parent ? byId.get(String(location.parent)) : null;
  while (cur && !seen.has(String(cur._id))) { seen.add(String(cur._id)); out.unshift(cur); cur = cur.parent ? byId.get(String(cur.parent)) : null; }
  return out;
}
/** Every location beneath one, any depth. */
function descendantsOf(warehouse, location) {
  const kids = childrenMapOf(warehouse);
  const out = []; const seen = new Set([String(location._id)]);
  const q = [...(kids.get(String(location._id)) || [])];
  while (q.length) { const n = q.shift(); if (seen.has(String(n._id))) continue; seen.add(String(n._id)); out.push(n); q.push(...(kids.get(String(n._id)) || [])); }
  return out;
}
/** The human-readable address and the stable id chain. */
function addressOf(warehouse, location) {
  const path = pathOf(warehouse, location);
  const parts = [{ id: String(warehouse._id), code: warehouse.shortName, name: warehouse.name, kind: "WAREHOUSE" }, ...path.map((l) => ({ id: String(l._id), code: l.code, name: l.name, kind: l.kind || "AREA" }))];
  return {
    code: parts.map((p) => p.code).join("-"),
    display: parts.map((p) => (p.kind === "WAREHOUSE" ? p.name : `${KIND_LABEL[p.kind] || ""} ${p.name}`.trim())).join(" › "),
    short: path.map((l) => l.code).join(" / "),
    parts, depth: path.length,
  };
}
/** Whether stock may be PUT here: an active, stock-holding location with no
    active children (stock goes on the leaf, never on the rack around it). */
function holdsStockError(warehouse, location) {
  if (!location) return "That location is not in this warehouse.";
  if (location.type === "RECEIVING" || location.type === "INSPECTION" || location.type === "SCRAP") return `${location.code} is a ${String(location.type).toLowerCase()} area, not a storage position.`;
  const kids = childrenMapOf(warehouse).get(String(location._id)) || [];
  if (kids.some((k) => k.status === "Active") && CONTAINER_KINDS.has(location.kind || "AREA")) return `${location.code} is a ${KIND_LABEL[location.kind].toLowerCase()} — put the stock on one of its ${kids.length} positions, not on the ${KIND_LABEL[location.kind].toLowerCase()} itself.`;
  return null;
}
/** The world-space box of a location: children of a rack are placed relative
    to the rack, so the absolute position folds each ancestor's offset and
    rotation in. Returns cm. */
function worldBoxOf(warehouse, location) {
  const path = pathOf(warehouse, location);
  let x = 0, y = 0, z = 0, rot = 0;
  for (const l of path) {
    const L = l.layout || {};
    const r = (rot * Math.PI) / 180;
    const lx = L.x || 0, lz = L.z || 0;
    x += lx * Math.cos(r) + lz * Math.sin(r);
    z += -lx * Math.sin(r) + lz * Math.cos(r);
    y += L.y || 0;
    rot = (rot + (L.rotation || 0)) % 360;
  }
  const L = location.layout || {};
  return { x, y, z, w: L.w || 0, h: L.h || 0, d: L.d || 0, rotation: rot, placed: Boolean(L.placed) };
}

/* ══ THE RACK WIZARD ═════════════════════════════════════════════════════════ */

const CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,15}$/;
const pad2 = (n) => String(n).padStart(2, "0");
/**
 * The locations a rack expands into. Pure: returns specs; the route writes
 * them in one structural write.
 *
 * @param {object} o  { code, name, parent, levels, bays, storageKind (SHELF|DRAWER|BIN|SLOT),
 *                      positionsPerBay (bins per shelf, default 1), width, height, depth (cm),
 *                      layout {x,z,rotation}, levelCodePrefix "L", bayCodePrefix "B", positionCodePrefix "P",
 *                      startLevel (1 = bottom) }
 */
function rackPlan(o = {}) {
  const code = text(o.code).toUpperCase();
  if (!CODE_PATTERN.test(code)) throw fail("VALIDATION", "A rack code may use letters, numbers and hyphens, up to 16 characters.", { reason: "CODE_FORMAT", code });
  const levels = Math.max(1, Math.min(30, Math.floor(num(o.levels, 1))));
  const bays = Math.max(1, Math.min(30, Math.floor(num(o.bays, 1))));
  const positions = Math.max(1, Math.min(30, Math.floor(num(o.positionsPerBay, 1))));
  const storageKind = validateKind(o.storageKind) || "SHELF";
  if (!["SHELF", "DRAWER", "BIN", "SLOT"].includes(storageKind)) throw fail("VALIDATION", "A rack holds shelves, drawers, bins or slots.", { reason: "INVALID_STORAGE_KIND" });
  const W = num(o.width, 100), H = num(o.height, 200), D = num(o.depth, 50);
  if (W <= 0 || H <= 0 || D <= 0) throw fail("VALIDATION", "Rack width, height and depth must be positive centimetres.", { reason: "INVALID_LAYOUT" });
  const lp = text(o.levelCodePrefix).toUpperCase() || "L", bp = text(o.bayCodePrefix).toUpperCase() || "B", pp = text(o.positionCodePrefix).toUpperCase() || "P";
  const bayW = W / bays, levelH = H / levels, posW = bayW / positions;
  const specs = [];
  const rackRef = "rack";
  specs.push({ ref: rackRef, parentRef: null, code, name: text(o.name) || `Rack ${code}`, kind: "RACK", type: "USABLE_STOCK", sequence: num(o.sequence, 0), layout: { x: num(o.layout?.x, 0), y: 0, z: num(o.layout?.z, 0), w: W, h: H, d: D, rotation: num(o.layout?.rotation, 0), color: text(o.layout?.color), placed: o.layout && (o.layout.x !== undefined || o.layout.z !== undefined) ? true : false } });
  const codeOf = (parts) => { const c = parts.join("-"); if (c.length > 16 || !CODE_PATTERN.test(c)) throw fail("VALIDATION", `The generated code ${c} is longer than 16 characters — use shorter prefixes or a shorter rack code.`, { reason: "CODE_FORMAT", code: c }); return c; };
  for (let l = 1; l <= levels; l++) {
    for (let b = 1; b <= bays; b++) {
      const multiBay = bays > 1;
      const levelCode = multiBay ? codeOf([code, `${lp}${pad2(l)}`, `${bp}${pad2(b)}`]) : codeOf([code, `${lp}${pad2(l)}`]);
      const holderKind = positions > 1 ? (storageKind === "DRAWER" ? "DRAWER" : "SHELF") : storageKind;
      const holderRef = `l${l}b${b}`;
      specs.push({ ref: holderRef, parentRef: rackRef, code: levelCode, name: multiBay ? `Level ${l} · Bay ${b}` : `${KIND_LABEL[holderKind]} ${l}`, kind: holderKind, type: "USABLE_STOCK", sequence: (l - 1) * bays + b, layout: { x: (b - 1) * bayW, y: (l - 1) * levelH, z: 0, w: bayW, h: levelH, d: D, rotation: 0, placed: true } });
      for (let p = 1; p <= positions && positions > 1; p++) {
        specs.push({ ref: `${holderRef}p${p}`, parentRef: holderRef, code: codeOf([levelCode, `${pp}${pad2(p)}`]), name: `${KIND_LABEL[storageKind]} ${p}`, kind: storageKind, type: "USABLE_STOCK", sequence: p, layout: { x: (p - 1) * posW, y: 0, z: 0, w: posW, h: levelH, d: D, rotation: 0, placed: true } });
      }
    }
  }
  return { code, levels, bays, positions, storageKind, specs, positionsCreated: specs.length - 1 };
}

/* ══ READS ═══════════════════════════════════════════════════════════════════ */

/** The warehouse that holds a location id, within the tenant scope. */
async function warehouseByLocationId(scope, locationId) {
  const lid = oid(locationId); if (!lid) return null;
  return Warehouse.findOne({ $and: [scope, { "locations._id": lid }] }).lean();
}
async function warehouseByQrToken(scope, token) {
  const t = String(token || "").trim().toUpperCase();
  if (!TOKEN_RE.test(t)) return null;
  return Warehouse.findOne({ $and: [scope, { "locations.qrToken": t }] }).lean();
}
const locationIn = (warehouse, locationId) => (warehouse?.locations || []).find((l) => String(l._id) === String(locationId)) || null;
const locationByToken = (warehouse, token) => (warehouse?.locations || []).find((l) => l.qrToken === String(token).toUpperCase()) || null;

/** Per-location on-hand rows (item grain) for a set of locations, from the
    projection, joined to item names. */
async function contentsOf(scope, companyId, warehouse, locationIds) {
  const ids = locationIds.map(oid).filter(Boolean);
  if (!ids.length) return [];
  const rows = await LocationBalance.find({ companyId: oid(companyId), warehouseId: warehouse._id, locationId: { $in: ids }, onHand: { $gt: loc.QTY_TOL } }).lean();
  const itemIds = [...new Set(rows.map((r) => String(r.itemId)))].map(oid);
  const items = itemIds.length ? await RawItem.find({ _id: { $in: itemIds } }).select("name sku unit customUnit category variants._id variants.combination variants.sku variants.quantity quantity").lean() : [];
  const byItem = new Map(items.map((i) => [String(i._id), i]));
  /* last movement per (item, variant, location) — one aggregate, newest wins */
  const last = await LocationMovement.aggregate([
    { $match: { companyId: oid(companyId), warehouseId: warehouse._id, locationId: { $in: ids }, applied: { $ne: false } } },
    { $sort: { createdAt: -1 } },
    { $group: { _id: { itemId: "$itemId", variantId: "$variantId", locationId: "$locationId" }, at: { $first: "$createdAt" }, type: { $first: "$type" }, actorName: { $first: "$actorName" }, firstIn: { $last: "$createdAt" } } },
  ]);
  const lastMap = new Map(last.map((x) => [`${x._id.itemId}:${x._id.variantId || ""}:${x._id.locationId}`, x]));
  return rows.map((r) => {
    const it = byItem.get(String(r.itemId));
    const v = r.variantId && it ? (it.variants || []).find((x) => String(x._id) === String(r.variantId)) : null;
    const lm = lastMap.get(`${r.itemId}:${r.variantId || ""}:${r.locationId}`);
    const location = locationIn(warehouse, r.locationId);
    return {
      rawItemId: String(r.itemId), variantId: r.variantId ? String(r.variantId) : null,
      name: it?.name || "(item)", sku: v?.sku || it?.sku || "", variant: v ? (v.combination || []).join(" · ") : "", category: it?.category || "",
      baseUnit: it ? (it.customUnit || it.unit || "") : "", onHand: round4(r.onHand),
      locationId: String(r.locationId), locationCode: location?.code || "", locationName: location?.name || "", locationKind: location?.kind || "AREA",
      lastAt: lm?.at || null, lastType: lm?.type || "", lastBy: lm?.actorName || "", placedAt: lm?.firstIn || null,
    };
  });
}

/** A marking's balance per location, derived from the rows that carry it. */
async function markingBalances(companyId, barcodeId) {
  const rows = await LocationMovement.find({ companyId: oid(companyId), barcodeId: oid(barcodeId), applied: { $ne: false } }).sort({ createdAt: 1 }).lean();
  const byLoc = new Map();
  for (const m of rows) {
    const k = `${m.warehouseId}:${m.locationId}`;
    if (!byLoc.has(k)) byLoc.set(k, { warehouseId: String(m.warehouseId), locationId: String(m.locationId), warehouseName: m.warehouseName, locationCode: m.locationCode, locationName: m.locationName, onHand: 0, firstAt: m.createdAt, lastAt: m.createdAt });
    const r = byLoc.get(k); r.onHand += m.direction === "in" ? m.quantity : -m.quantity; r.lastAt = m.createdAt; if (m.locationCode) r.locationCode = m.locationCode; if (m.locationName) r.locationName = m.locationName;
  }
  const balances = [...byLoc.values()].map((r) => ({ ...r, onHand: round4(r.onHand) })).filter((r) => r.onHand > loc.QTY_TOL);
  return { balances, located: round4(balances.reduce((n, b) => n + b.onHand, 0)), movements: rows.length };
}
/** Marking balances inside ONE location (for a location's contents view). */
async function markingsAt(companyId, warehouseId, locationIds) {
  const ids = locationIds.map(oid).filter(Boolean);
  if (!ids.length) return [];
  const agg = await LocationMovement.aggregate([
    { $match: { companyId: oid(companyId), warehouseId: oid(warehouseId), locationId: { $in: ids }, barcodeId: { $type: "objectId" }, applied: { $ne: false } } },
    { $group: { _id: { barcodeId: "$barcodeId", locationId: "$locationId", itemId: "$itemId", variantId: "$variantId" }, onHand: { $sum: { $cond: [{ $eq: ["$direction", "in"] }, "$quantity", { $multiply: ["$quantity", -1] }] } }, lastAt: { $max: "$createdAt" }, firstAt: { $min: "$createdAt" }, label: { $last: "$barcodeLabel" } } },
    { $match: { onHand: { $gt: loc.QTY_TOL } } },
  ]);
  const bids = agg.map((a) => a._id.barcodeId);
  const marks = bids.length ? await Barcode.find({ _id: { $in: bids } }).select("rawItemName rawItemSku variantCombination variantSku quantity unit purchaseOrderNumber vendorName createdAt").lean() : [];
  const byId = new Map(marks.map((m) => [String(m._id), m]));
  return agg.map((a) => { const m = byId.get(String(a._id.barcodeId)); return { barcodeId: String(a._id.barcodeId), locationId: String(a._id.locationId), rawItemId: String(a._id.itemId), variantId: a._id.variantId ? String(a._id.variantId) : null, onHand: round4(a.onHand), firstAt: a.firstAt, lastAt: a.lastAt, label: a.label || "", marking: m ? { rawItemName: m.rawItemName, rawItemSku: m.rawItemSku, variant: (m.variantCombination || []).join(" · "), variantSku: m.variantSku, quantity: m.quantity, unit: m.unit, purchaseOrderNumber: m.purchaseOrderNumber, vendorName: m.vendorName, printedAt: m.createdAt } : null }; });
}

/** The company's item-grain balances rolled up per location id (for tree totals). */
async function totalsByLocation(companyId, warehouseId) {
  const rows = await LocationBalance.aggregate([
    { $match: { companyId: oid(companyId), warehouseId: oid(warehouseId), locationId: { $type: "objectId" }, onHand: { $gt: loc.QTY_TOL } } },
    { $group: { _id: "$locationId", lines: { $sum: 1 }, onHand: { $sum: "$onHand" }, items: { $addToSet: "$itemId" } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), { lines: r.lines, onHand: round4(r.onHand), items: r.items.length }]));
}

/** The tree with per-node totals aggregated from the leaves. */
function treeOf(warehouse, totals = new Map(), { includeArchived = false } = {}) {
  const kids = childrenMapOf(warehouse);
  const build = (l) => {
    const children = (kids.get(String(l._id)) || []).filter((c) => includeArchived || c.status !== "Archived").map(build);
    const own = totals.get(String(l._id)) || { lines: 0, onHand: 0, items: 0 };
    const agg = children.reduce((a, c) => ({ lines: a.lines + c.totals.lines, onHand: round4(a.onHand + c.totals.onHand), items: a.items + c.totals.items, positions: a.positions + c.totals.positions, occupied: a.occupied + c.totals.occupied }), { lines: own.lines, onHand: own.onHand, items: own.items, positions: children.length ? 0 : 1, occupied: children.length ? 0 : (own.lines ? 1 : 0) });
    return { id: String(l._id), code: l.code, name: l.name, type: l.type, kind: l.kind || "AREA", status: l.status, sequence: l.sequence || 0, qrToken: l.qrToken || "", layout: l.layout || {}, capacity: l.capacity || {}, parent: l.parent ? String(l.parent) : null, own, totals: agg, children };
  };
  const roots = (kids.get("") || []).filter((c) => includeArchived || c.status !== "Archived").map(build);
  return roots;
}

/* ══ THE GUARDED WRITES ══════════════════════════════════════════════════════ */

/** Resolve the stock a scan or a form names: a marking (Barcode) or an item. */
async function resolveStock(scope, { barcodeId, rawItemId, variantId }) {
  let barcode = null;
  if (barcodeId) {
    if (!isId(barcodeId)) throw fail("VALIDATION", "That is not a valid item sticker.", { reason: "INVALID_BARCODE" });
    barcode = await Barcode.findById(barcodeId).lean();
    if (!barcode) throw fail("NOT_FOUND", "That item sticker is not on record.", { reason: "BARCODE_NOT_FOUND" });
    rawItemId = String(barcode.rawItem); variantId = barcode.variantId ? String(barcode.variantId) : null;
  }
  const iid = oid(rawItemId);
  if (!iid) throw fail("VALIDATION", "Choose the item.", { reason: "INVALID_ITEM" });
  const item = await RawItem.findOne({ $and: [scope, { _id: iid }] }).lean();
  if (!item) throw fail(barcode ? "FORBIDDEN" : "NOT_FOUND", barcode ? "This sticker belongs to an item outside your company." : "Item not found in this company.", { reason: "ITEM_NOT_FOUND" });
  let variant = null;
  if (variantId) { variant = (item.variants || []).find((v) => String(v._id) === String(variantId)) || null; if (!variant) throw fail("NOT_FOUND", "Variant not found on this item.", { reason: "VARIANT_NOT_FOUND" }); }
  return { item, variant, variantId: variant ? String(variant._id) : null, barcode, barcodeLabel: barcode ? `${barcode.quantity} ${barcode.unit}${barcode.purchaseOrderNumber ? ` · ${barcode.purchaseOrderNumber}` : ""}` : "" };
}

/** An active storage position in this company, or a refusal in words. */
async function resolveDestination(scope, companyId, { locationId, qrToken }) {
  const warehouse = qrToken ? await warehouseByQrToken(scope, qrToken) : await warehouseByLocationId(scope, locationId);
  const location = warehouse ? (qrToken ? locationByToken(warehouse, qrToken) : locationIn(warehouse, locationId)) : null;
  const err = loc.usableLocationError(warehouse, location, companyId);
  if (err) throw fail("VALIDATION", err.message, { reason: err.reason });
  const hold = holdsStockError(warehouse, location);
  if (hold) throw fail("VALIDATION", hold, { reason: "LOCATION_NOT_A_POSITION" });
  return { warehouse, location };
}

/**
 * PUT: place stock that the company already holds into a position. Never
 * changes company on-hand. Guarded at item grain by the assigned-total
 * sentinel; at marking grain by the marking's own printed quantity.
 */
async function putStock(session, o) {
  const { companyId, siteId, tenantStamp, item, variantId, barcode, barcodeLabel, warehouse, location, quantity, actor, note, idempotencyKey, source } = o;
  const onHand = loc.onHandOf(item, variantId);
  if (barcode) {
    /* A sticker says how much it labels; more than that cannot be put under it. */
    const mb = await markingBalances(companyId, barcode._id);
    if (round4(mb.located + quantity) > round4(barcode.quantity) + loc.QTY_TOL) {
      throw fail("VALIDATION", `This sticker labels ${barcode.quantity} ${barcode.unit}; ${mb.located} is already placed, so at most ${round4(barcode.quantity - mb.located)} more can be put under it.`, { reason: "EXCEEDS_MARKING", marking: barcode.quantity, located: mb.located, requested: quantity });
    }
  }
  const ok = await loc.incAssignedTotal(session, companyId, item._id, variantId, quantity, onHand);
  if (!ok) throw fail("VALIDATION", `Cannot put ${quantity}: it would place more than this item's on-hand of ${onHand} into locations.`, { reason: "EXCEEDS_ON_HAND", onHand, requested: quantity });
  const inc = await loc.incLocationReturning(session, companyId, item._id, variantId, warehouse._id, location._id, quantity);
  const mv = await loc.writeMovement(session, { ...tenantStamp, ...loc.buildMovement({ companyId, siteId, item, variantId, warehouse, location, direction: "in", quantity, type: "opening_assignment", source: source || { kind: "put", reference: "" }, actor, note, idempotencyKey }), barcodeId: barcode ? barcode._id : null, barcodeLabel });
  return { movement: mv, after: inc.after, before: round4(inc.after - quantity), companyOnHand: onHand };
}

/** REMOVE from a position without consuming: the stock goes back to Unassigned. */
async function unassignStock(session, o) {
  const { companyId, siteId, tenantStamp, item, variantId, barcode, barcodeLabel, warehouse, location, quantity, actor, note, idempotencyKey, source } = o;
  if (barcode) await assertMarkingAt(session, companyId, barcode, warehouse, location, quantity);
  const dec = await loc.decLocationGuardedReturning(session, companyId, item._id, variantId, warehouse._id, location._id, quantity);
  if (!dec.ok) { const have = await loc.locationOnHand(session, companyId, item._id, variantId, warehouse._id, location._id); throw fail("VALIDATION", `Only ${have} ${loc.baseUnitOf(item)} of this item is in ${location.code}.`, { reason: "INSUFFICIENT_AT_LOCATION", available: have, requested: quantity }); }
  await loc.incAssignedTotal(session, companyId, item._id, variantId, -quantity, null);
  const mv = await loc.writeMovement(session, { ...tenantStamp, ...loc.buildMovement({ companyId, siteId, item, variantId, warehouse, location, direction: "out", quantity, type: "adjustment", source: source || { kind: "unassign", reference: "" }, actor, note, idempotencyKey }), barcodeId: barcode ? barcode._id : null, barcodeLabel });
  return { movement: mv, after: dec.after, before: round4(dec.after + quantity) };
}

/** TRANSFER between two positions — two equal legs, one identity, atomic. */
async function transferStock(session, o) {
  const { companyId, siteId, tenantStamp, item, variantId, barcode, barcodeLabel, from, to, quantity, actor, note, idempotencyKey } = o;
  if (String(from.location._id) === String(to.location._id)) throw fail("VALIDATION", "Source and destination must be different.", { reason: "SAME_LOCATION" });
  if (barcode) await assertMarkingAt(session, companyId, barcode, from.warehouse, from.location, quantity);
  const dec = await loc.decLocationGuardedReturning(session, companyId, item._id, variantId, from.warehouse._id, from.location._id, quantity);
  if (!dec.ok) { const have = await loc.locationOnHand(session, companyId, item._id, variantId, from.warehouse._id, from.location._id); throw fail("VALIDATION", `Only ${have} ${loc.baseUnitOf(item)} of this item is in ${from.location.code}.`, { reason: "INSUFFICIENT_AT_SOURCE", available: have, requested: quantity }); }
  const inc = await loc.incLocationReturning(session, companyId, item._id, variantId, to.warehouse._id, to.location._id, quantity);
  const transferId = new mongoose.Types.ObjectId();
  const common = { companyId, siteId, item, variantId, transferId, actor, note, idempotencyKey, source: { kind: "transfer", id: transferId, reference: "" } };
  const [out, inn] = await LocationMovement.create([
    { ...tenantStamp, ...loc.buildMovement({ ...common, warehouse: from.warehouse, location: from.location, direction: "out", quantity, type: "transfer_out" }), barcodeId: barcode ? barcode._id : null, barcodeLabel },
    { ...tenantStamp, ...loc.buildMovement({ ...common, warehouse: to.warehouse, location: to.location, direction: "in", quantity, type: "transfer_in" }), barcodeId: barcode ? barcode._id : null, barcodeLabel },
  ], { session, ordered: true });
  return { transferId, movementOut: out, movementIn: inn, source: { before: round4(dec.after + quantity), after: dec.after }, destination: { before: round4(inc.after - quantity), after: inc.after } };
}

/** A marking may only leave a position it is actually in. Read inside the
    transaction so it sees what this unit of work has already done. */
async function assertMarkingAt(session, companyId, barcode, warehouse, location, quantity) {
  const rows = await LocationMovement.find({ companyId: oid(companyId), barcodeId: barcode._id, warehouseId: warehouse._id, locationId: location._id, applied: { $ne: false } }).select("direction quantity").session(session || null).lean();
  const have = round4(rows.reduce((n, m) => n + (m.direction === "in" ? m.quantity : -m.quantity), 0));
  if (round4(quantity) > have + loc.QTY_TOL) throw fail("VALIDATION", `Only ${have} of this sticker's stock is in ${location.code}.`, { reason: "INSUFFICIENT_MARKING_AT_LOCATION", available: have, requested: quantity });
}

module.exports = {
  LOCATION_KINDS, HOLDING_KINDS, CONTAINER_KINDS, KIND_LABEL, CODE_PATTERN, TOKEN_RE, LOCATION_QR_PARAM, LOCATION_SCAN_PATH,
  physicalFieldsFromBody, physicalSetFromBody, validateLayout, validateCapacity, validateKind,
  mintQrToken, locationQrPayload, parseScan,
  byIdOf, childrenMapOf, pathOf, descendantsOf, addressOf, holdsStockError, worldBoxOf, treeOf, rackPlan,
  warehouseByLocationId, warehouseByQrToken, locationIn, locationByToken, contentsOf, markingBalances, markingsAt, totalsByLocation,
  resolveStock, resolveDestination, putStock, unassignStock, transferStock, assertMarkingAt,
  isId, oid, round4,
};
