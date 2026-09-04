// services/storePurchase/locationStock.service.js
//
// Warehouse Stock V1 — deriving location balances from the immutable ledger,
// and the rules a location movement must satisfy. No route logic here; this is
// the shared, testable core the location-stock routes call.

"use strict";

const mongoose = require("mongoose");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");

const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const QTY_TOL = 1e-6;

const baseUnitOf = (item) => (item && (item.customUnit || item.unit)) || "";

// The company-wide on-hand authority for an item (or a variant) — RawItem.
function onHandOf(item, variantId) {
  if (variantId) {
    const v = (item.variants || []).find((x) => String(x._id) === String(variantId));
    return v && typeof v.quantity === "number" ? v.quantity : 0;
  }
  return typeof item.quantity === "number" ? item.quantity : 0;
}

// Replay applied movements into per-location balances. Pure: give it the rows
// (already scoped to one item [+variant]) and it returns one entry per location
// with onHand = Σ in − Σ out. Zero/negative-after-rounding balances are dropped.
function deriveLocationBalances(movements) {
  const byLoc = new Map();
  for (const m of movements || []) {
    if (m.applied === false) continue; // only applied facts count
    const key = `${m.warehouseId}:${m.locationId}`;
    if (!byLoc.has(key)) {
      byLoc.set(key, {
        warehouseId: String(m.warehouseId),
        locationId: String(m.locationId),
        warehouseName: m.warehouseName || "",
        warehouseShortName: m.warehouseShortName || "",
        locationCode: m.locationCode || "",
        locationName: m.locationName || "",
        onHand: 0,
      });
    }
    const row = byLoc.get(key);
    const q = Number(m.quantity) || 0;
    row.onHand += m.direction === "in" ? q : -q;
    // Keep the latest non-empty snapshot names.
    if (m.warehouseName) row.warehouseName = m.warehouseName;
    if (m.locationName) row.locationName = m.locationName;
    if (m.locationCode) row.locationCode = m.locationCode;
  }
  return [...byLoc.values()]
    .map((r) => ({ ...r, onHand: round4(r.onHand) }))
    .filter((r) => Math.abs(r.onHand) > QTY_TOL);
}

const assignedTotalOf = (balances) =>
  round4((balances || []).reduce((s, b) => s + (b.onHand || 0), 0));

// The reconciliation invariant the whole feature rests on:
//   assigned across locations + unassigned === company on-hand.
function reconcile({ onHand, balances }) {
  const assigned = assignedTotalOf(balances);
  const unassigned = round4(onHand - assigned);
  return {
    onHand: round4(onHand),
    assigned,
    unassigned,
    // Unassigned may not be negative — that would mean more is placed than
    // exists, which the write path refuses. Surfaced so a reader can see it.
    overAssigned: unassigned < -QTY_TOL,
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

// Find a location subdocument in a warehouse by its _id.
function findLocation(warehouse, locationId) {
  if (!warehouse || !locationId) return null;
  return (warehouse.locations || []).find((l) => String(l._id) === String(locationId)) || null;
}

// A location may RECEIVE a new movement only if both the warehouse and the
// location are Active and belong to this company. Archived/Inactive stay
// readable in history but are refused for new movements.
function usableLocationError(warehouse, location, companyId) {
  if (!warehouse) return { reason: "WAREHOUSE_NOT_FOUND", message: "Warehouse not found in this company." };
  if (String(warehouse.companyId || "") !== String(companyId || "")) {
    return { reason: "WAREHOUSE_NOT_FOUND", message: "Warehouse not found in this company." };
  }
  if (warehouse.status !== "Active") {
    return { reason: "WAREHOUSE_INACTIVE", message: `Warehouse ${warehouse.name || ""} is ${String(warehouse.status || "").toLowerCase()} and cannot take new stock movements.` };
  }
  if (!location) return { reason: "LOCATION_NOT_FOUND", message: "That location is not in this warehouse." };
  if (location.status !== "Active") {
    return { reason: "LOCATION_INACTIVE", message: `Location ${location.code || ""} is ${String(location.status || "").toLowerCase()} and cannot take new stock movements.` };
  }
  return null;
}

const isReceiving = (location) => location && location.type === "RECEIVING";

// A movement document (plain object) ready for LocationMovement.create.
function buildMovement({
  companyId, siteId, item, variantId, warehouse, location,
  direction, quantity, type, source, transferId, actor, note, idempotencyKey,
}) {
  return {
    companyId,
    siteId: siteId || null,
    itemId: item._id,
    variantId: variantId || null,
    baseUnit: baseUnitOf(item),
    warehouseId: warehouse._id,
    locationId: location._id,
    warehouseName: warehouse.name || "",
    warehouseShortName: warehouse.shortName || "",
    locationCode: location.code || "",
    locationName: location.name || "",
    direction,
    quantity: round4(quantity),
    type,
    source: source || {},
    transferId: transferId || null,
    actorId: actor?.id || null,
    actorName: actor?.name || "",
    note: note || "",
    idempotencyKey: idempotencyKey || "",
    applied: true,
  };
}

// ── ATOMIC BALANCE PROJECTION GUARDS (concurrency safety) ────────────────────
// The immutable LocationMovement is the audit; these guarded writes on the
// rebuildable LocationBalance projection are what stop two concurrent
// operations spending the same balance. All take the caller's session so they
// commit with the domain mutation.

const oid = (v) => (v == null ? null : new mongoose.Types.ObjectId(String(v)));
const locFilter = (companyId, itemId, variantId, warehouseId, locationId) => ({
  companyId: oid(companyId),
  itemId: oid(itemId),
  variantId: variantId ? oid(variantId) : null,
  warehouseId: warehouseId ? oid(warehouseId) : null,
  locationId: locationId ? oid(locationId) : null,
});
const sentinelFilter = (companyId, itemId, variantId) =>
  locFilter(companyId, itemId, variantId, null, null);

// Increase a location's projected on-hand (upsert). Never guarded.
async function incLocation(session, companyId, itemId, variantId, warehouseId, locationId, delta) {
  await LocationBalance.updateOne(
    locFilter(companyId, itemId, variantId, warehouseId, locationId),
    { $inc: { onHand: round4(delta) } },
    { upsert: true, session },
  );
}

// Decrease a location's projected on-hand ONLY if it holds enough — the atomic
// guard against a location going below zero. Returns false (no write) if not.
async function decLocationGuarded(session, companyId, itemId, variantId, warehouseId, locationId, qty) {
  const res = await LocationBalance.updateOne(
    { ...locFilter(companyId, itemId, variantId, warehouseId, locationId), onHand: { $gte: round4(qty) - QTY_TOL } },
    { $inc: { onHand: -round4(qty) } },
    { session },
  );
  return (res.matchedCount || res.n || 0) > 0;
}

// Move the assigned-total sentinel. `guardMax` (company on-hand) refuses a
// placement that would put more into locations than the company holds — the
// atomic guard two concurrent assignments race on.
async function incAssignedTotal(session, companyId, itemId, variantId, delta, guardMax) {
  const filter = sentinelFilter(companyId, itemId, variantId);
  if (delta > 0 && guardMax != null) {
    await LocationBalance.updateOne(filter, { $setOnInsert: { onHand: 0 } }, { upsert: true, session });
    const res = await LocationBalance.updateOne(
      { ...filter, onHand: { $lte: round4(guardMax - delta) + QTY_TOL } },
      { $inc: { onHand: round4(delta) } },
      { session },
    );
    return (res.matchedCount || res.n || 0) > 0;
  }
  await LocationBalance.updateOne(filter, { $inc: { onHand: round4(delta) } }, { upsert: true, session });
  return true;
}

async function writeMovement(session, doc) {
  const [mv] = await LocationMovement.create([doc], { session });
  return mv;
}

// ── HIGH-LEVEL: what a canonical operation calls inside its own mutate ────────
// Each pairs the guarded projection change with the immutable LocationMovement,
// tagged with the REAL source document. `o` carries companyId/siteId, item,
// variantId, warehouse, location, quantity, type, source {kind,id,reference},
// actor, note, idempotencyKey.

// Stock ENTERING a location. intent "receive" = new stock joining the company
// (on-hand rose with it, no headroom guard); intent "place" = placing stock
// already counted in on-hand (guarded so placement can't exceed companyOnHand).
async function applyLocationIn(session, o) {
  if (o.intent === "place") {
    const ok = await incAssignedTotal(session, o.companyId, o.item._id, o.variantId, o.quantity, o.companyOnHand);
    if (!ok) return { ok: false, reason: "EXCEEDS_ON_HAND" };
  } else {
    await incAssignedTotal(session, o.companyId, o.item._id, o.variantId, o.quantity, null);
  }
  await incLocation(session, o.companyId, o.item._id, o.variantId, o.warehouse._id, o.location._id, o.quantity);
  const mv = await writeMovement(session, buildMovement({ ...o, direction: "in" }));
  return { ok: true, movement: mv };
}

// Stock LEAVING a location — guarded so the location cannot go below zero.
async function applyLocationOut(session, o) {
  const ok = await decLocationGuarded(session, o.companyId, o.item._id, o.variantId, o.warehouse._id, o.location._id, o.quantity);
  if (!ok) return { ok: false, reason: "INSUFFICIENT_AT_LOCATION" };
  await incAssignedTotal(session, o.companyId, o.item._id, o.variantId, -o.quantity, null);
  const mv = await writeMovement(session, buildMovement({ ...o, direction: "out" }));
  return { ok: true, movement: mv };
}

// Snapshot fields for a RawItem.stockTransaction, so Stock movements can show
// the real location without a join. Absent → the movement reads "Unassigned".
function txLocationSnapshot(warehouse, location) {
  if (!warehouse || !location) return {};
  return {
    warehouseId: warehouse._id,
    locationId: location._id,
    warehouseName: warehouse.name || "",
    locationCode: location.code || "",
    locationName: location.name || "",
  };
}

// Rebuild the projection for one (item, variant) from immutable movements.
// Idempotent; used by tests and any future reconciliation.
async function rebuildProjection(session, companyId, itemId, variantId) {
  const movements = await LocationMovement.find(locFilter(companyId, itemId, variantId, undefined, undefined))
    .where({ itemId: oid(itemId), companyId: oid(companyId), variantId: variantId ? oid(variantId) : null })
    .session(session || null)
    .lean();
  const balances = deriveLocationBalances(movements);
  await LocationBalance.deleteMany({ companyId: oid(companyId), itemId: oid(itemId), variantId: variantId ? oid(variantId) : null }, { session });
  for (const b of balances) {
    await LocationBalance.updateOne(
      locFilter(companyId, itemId, variantId, b.warehouseId, b.locationId),
      { $set: { onHand: b.onHand } }, { upsert: true, session },
    );
  }
  await LocationBalance.updateOne(sentinelFilter(companyId, itemId, variantId), { $set: { onHand: assignedTotalOf(balances) } }, { upsert: true, session });
}

module.exports = {
  baseUnitOf,
  onHandOf,
  deriveLocationBalances,
  assignedTotalOf,
  reconcile,
  findLocation,
  usableLocationError,
  isReceiving,
  buildMovement,
  QTY_TOL,
  round4,
  // projection guards
  incLocation,
  decLocationGuarded,
  incAssignedTotal,
  writeMovement,
  rebuildProjection,
  sentinelFilter,
  locFilter,
  // high-level operation helpers
  applyLocationIn,
  applyLocationOut,
  txLocationSnapshot,
};
