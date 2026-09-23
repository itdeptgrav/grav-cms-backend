// services/storePurchase/reservation.service.js
//
// STOCK RESERVATION (V1) — hold usable stock against an approved MRF line before
// it is issued, WITHOUT ever changing on-hand. This service owns:
//   · the availability read  (usable on-hand − reserved, per usable location)
//   · the atomic reserve/release/consume guards on the LocationReservation
//     projection (the serialization point that stops two users spending the same
//     last stock — a single guarded document write, reused from the codebase's
//     dec/inc-guarded idiom)
//   · the StockReservation record lifecycle + status derivation + queue shaping
//
// It NEVER calls the LocationBalance mutators (that is the issue engine's job).
// Reserving is a live operational record, not a movement.

"use strict";

const mongoose = require("mongoose");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationReservation = require("../../models/CMS_Models/Inventory/Operations/LocationReservation");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const locStock = require("./locationStock.service");
const { fail } = require("./errors");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const TOL = 0.0001;
const USABLE_TYPE = "USABLE_STOCK";

const oid = (v) => (v == null ? null : (mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : v));
const sameId = (a, b) => String(a ?? "") === String(b ?? "");

// ── Usable-location discovery ────────────────────────────────────────────────
// A usable location is an ACTIVE USABLE_STOCK bin in an ACTIVE warehouse of THIS
// company. Receiving / Inspection / Quarantine / Returns / Scrap / inactive
// locations, and the Unassigned sentinel, are never usable.
function usableLocationsOf(warehouse) {
  if (!warehouse || warehouse.status !== "Active") return [];
  return (warehouse.locations || [])
    .filter((l) => l.type === USABLE_TYPE && l.status === "Active")
    .map((l) => ({ warehouse, location: l }));
}

// Candidate locations for a demand, ordered by a clear, stable policy:
//   1. the requested/preferred warehouse first (where recorded);
//   2. then every usable location, by warehouse short name then location code.
// The caller layers on the per-location available quantity.
function orderedCandidates(warehouses, { preferredWarehouseId = null } = {}) {
  const all = [];
  for (const w of (warehouses || [])) for (const c of usableLocationsOf(w)) all.push(c);
  return all.sort((a, b) => {
    const ap = preferredWarehouseId && sameId(a.warehouse._id, preferredWarehouseId) ? 0 : 1;
    const bp = preferredWarehouseId && sameId(b.warehouse._id, preferredWarehouseId) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    const aw = (a.warehouse.shortName || a.warehouse.name || "");
    const bw = (b.warehouse.shortName || b.warehouse.name || "");
    if (aw !== bw) return aw.localeCompare(bw);
    return String(a.location.code || "").localeCompare(String(b.location.code || ""));
  });
}

// ── Availability read (NON-mutating) ─────────────────────────────────────────
// For one (item, variant), across the company's usable locations:
//   usable on hand = LocationBalance.onHand at the location  (base unit)
//   reserved       = LocationReservation.reserved            (base unit)
//   available      = max(0, on hand − reserved)              (base unit)
// Returns per-location rows in BASE units; the caller converts to the business
// unit for display using the line's frozen conversion factor.
async function availabilityFor({ session = null, companyId, itemId, variantId = null, warehouses, preferredWarehouseId = null }) {
  const candidates = orderedCandidates(warehouses, { preferredWarehouseId });
  const rows = [];
  for (const c of candidates) {
    const onHand = r4(await locStock.locationOnHand(session, companyId, itemId, variantId, c.warehouse._id, c.location._id));
    if (onHand <= TOL) continue;  // only locations that actually hold stock are candidates
    const resRow = await LocationReservation.findOne({
      companyId: oid(companyId), itemId: oid(itemId), variantId: variantId ? oid(variantId) : null,
      warehouseId: c.warehouse._id, locationId: c.location._id,
    }).session(session || null).lean();
    const reserved = r4(resRow ? resRow.reserved : 0);
    const available = r4(Math.max(0, onHand - reserved));
    rows.push({
      warehouseId: String(c.warehouse._id), warehouseName: c.warehouse.name || "", warehouseShortName: c.warehouse.shortName || "",
      locationId: String(c.location._id), locationCode: c.location.code || "", locationName: c.location.name || "",
      onHandBase: onHand, reservedBase: reserved, availableBase: available,
    });
  }
  return rows;
}

// The reserved base quantity at one location — used by stock views to show
// On hand / Reserved / Available without recomputing from the record.
async function reservedBaseAt({ session = null, companyId, itemId, variantId = null, warehouseId, locationId }) {
  const row = await LocationReservation.findOne({
    companyId: oid(companyId), itemId: oid(itemId), variantId: variantId ? oid(variantId) : null,
    warehouseId: oid(warehouseId), locationId: oid(locationId),
  }).session(session || null).lean();
  return r4(row ? row.reserved : 0);
}

// All reserved rows for an item (optionally a variant), keyed by "warehouse:location".
async function reservedMapForItem({ session = null, companyId, itemId, variantId = undefined }) {
  const q = { companyId: oid(companyId), itemId: oid(itemId) };
  if (variantId !== undefined) q.variantId = variantId ? oid(variantId) : null;
  const rows = await LocationReservation.find(q).session(session || null).lean();
  const m = new Map();
  for (const r of rows) m.set(`${String(r.warehouseId)}:${String(r.locationId)}`, r4(r.reserved));
  return m;
}

// ── The atomic reserve guard (the serialization point) ───────────────────────
// Ensure the projection row exists, then a single guarded update that increments
// `reserved` ONLY if it stays within the location's on-hand. Two concurrent
// reservers of the same location contend on THIS one document; the loser matches
// nothing and is refused, having changed nothing. `onHand` is read in the same
// unit of work, and issuing this location's stock also contends here.
// @returns {boolean} whether the reservation was placed.
async function reserveAtLocation({ session = null, companyId, itemId, variantId = null, warehouseId, locationId, requestedBase, onHand }) {
  const key = {
    companyId: oid(companyId), itemId: oid(itemId), variantId: variantId ? oid(variantId) : null,
    warehouseId: oid(warehouseId), locationId: oid(locationId),
  };
  await LocationReservation.updateOne(key, { $setOnInsert: { reserved: 0 } }, { upsert: true, ...(session ? { session } : {}) });
  const res = await LocationReservation.updateOne(
    { ...key, reserved: { $lte: r4(onHand) - r4(requestedBase) + TOL } },
    { $inc: { reserved: r4(requestedBase) } },
    session ? { session } : {},
  );
  return (res.matchedCount || res.n || 0) > 0;
}

// Release/consume reserved base at a location (guarded so it can never go below
// zero). Used by release (stock stays put) and issue (stock also moves, elsewhere).
async function reduceReservationAtLocation({ session = null, companyId, itemId, variantId = null, warehouseId, locationId, baseQty }) {
  const key = {
    companyId: oid(companyId), itemId: oid(itemId), variantId: variantId ? oid(variantId) : null,
    warehouseId: oid(warehouseId), locationId: oid(locationId),
    reserved: { $gte: r4(baseQty) - TOL },
  };
  const res = await LocationReservation.updateOne(key, { $inc: { reserved: -r4(baseQty) } }, session ? { session } : {});
  return (res.matchedCount || res.n || 0) > 0;
}

// ── StockReservation status derivation (pure) ────────────────────────────────
// Primary status from the frozen quantities. `active` (for the unique index) is
// derived alongside — a reservation with nothing left reserved and no issue is
// released; one fully issued or fully released stops being the line's live hold.
function deriveStatus(r) {
  const requested = r4(r.requestedQty);
  const reserved = r4(r.reservedQty);
  const issued = r4(r.issuedQty);
  const released = r4(r.releasedQty);
  const activeReserved = r4(Math.max(0, reserved - issued - released));

  let status;
  let active = true;
  if (r.cancelled) { status = "CANCELLED"; active = false; }
  else if (issued >= reserved - TOL && issued > TOL && released <= TOL) { status = "ISSUED"; active = false; }
  else if (issued > TOL) status = "PARTIALLY_ISSUED";
  else if (released >= reserved - TOL && released > TOL) { status = "RELEASED"; active = false; }
  else if (released > TOL) status = "PARTIALLY_RELEASED";
  else if (reserved >= requested - TOL) status = "RESERVED";
  else status = "PARTIALLY_RESERVED";
  return { status, active, activeReserved };
}

// Recompute the roll-ups + status from allocations, and return the fields to set.
function rollUp(r) {
  const reservedQty = r4((r.allocations || []).reduce((t, a) => t + (a.reservedQty || 0), 0));
  const reservedBaseQty = r4((r.allocations || []).reduce((t, a) => t + (a.reservedBaseQty || 0), 0));
  const issuedQty = r4((r.allocations || []).reduce((t, a) => t + (a.issuedQty || 0), 0));
  const releasedQty = r4((r.allocations || []).reduce((t, a) => t + (a.releasedQty || 0), 0));
  const backorderedQty = r4(Math.max(0, r4(r.requestedQty) - reservedQty));
  const factor = Number(r.conversionFactor) || 1;
  // Read fields off `r` explicitly — `r` may be a Mongoose document, and
  // `{...doc}` does NOT copy schema paths, which would silently zero requestedQty.
  const { status, active } = deriveStatus({ requestedQty: r.requestedQty, cancelled: r.cancelled, reservedQty, issuedQty, releasedQty });
  return {
    reservedQty, reservedBaseQty,
    issuedQty, issuedBaseQty: r4(issuedQty * factor),
    releasedQty, releasedBaseQty: r4(releasedQty * factor),
    backorderedQty, status, active,
  };
}

// The queue group a reservation belongs to — actionable, operational language.
function queueGroup(r) {
  const requested = r4(r.requestedQty);
  const reserved = r4(r.reservedQty);
  const issued = r4(r.issuedQty);
  const released = r4(r.releasedQty);
  const activeReserved = r4(Math.max(0, reserved - issued - released));
  const backordered = r4(r.backorderedQty != null ? r.backorderedQty : Math.max(0, requested - reserved));
  if (r.status === "CANCELLED" || (r.mrfCancelled && activeReserved > TOL)) return "ATTENTION";  // release required
  if (issued > TOL && issued < reserved - TOL) return "PARTLY_ISSUED";
  if (issued >= reserved - TOL && issued > TOL) return "DONE";
  if (backordered > TOL && activeReserved <= TOL) return "BACKORDERED";
  if (activeReserved > TOL && reserved >= requested - TOL) return "READY_TO_PICK";
  if (activeReserved > TOL && reserved < requested - TOL) return "PARTLY_RESERVED";
  return "READY_TO_RESERVE";
}

const GROUPS = Object.freeze({
  READY_TO_RESERVE: { label: "Ready to reserve", order: 1 },
  PARTLY_RESERVED: { label: "Partly reserved", order: 2 },
  READY_TO_PICK: { label: "Ready to pick", order: 3 },
  PARTLY_ISSUED: { label: "Partly issued", order: 4 },
  BACKORDERED: { label: "Backordered", order: 5 },
  ATTENTION: { label: "Attention required", order: 6 },
  DONE: { label: "Completed", order: 7 },
});

module.exports = {
  USABLE_TYPE, TOL, r4,
  usableLocationsOf, orderedCandidates, availabilityFor, reservedBaseAt, reservedMapForItem,
  reserveAtLocation, reduceReservationAtLocation,
  deriveStatus, rollUp, queueGroup, GROUPS,
  LocationReservation, StockReservation,
};
