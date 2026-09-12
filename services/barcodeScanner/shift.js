// lib/shift.js
//
// Shift bucketing and barcode parsing. Shared by the ingest route and the
// rollup job so an event and its read models can never disagree.
//
// IMPORTANT — timezone:
// The previous deployment ran on Render (UTC), so `d.setHours(0,0,0,0)` bucketed
// on UTC midnight. This service runs on the factory PC in IST. Relying on the
// process timezone would silently shift every bucket by 5h30m the day you move
// hosts, so the offset is explicit and configurable instead.
const SHIFT_TZ_OFFSET_MIN = Number(process.env.SHIFT_TZ_OFFSET_MIN || 330); // IST

const MS_PER_MIN = 60 * 1000;

/**
 * Bucket an instant into the shift day it belongs to.
 * Returns the UTC instant corresponding to local-midnight of that day, so the
 * stored value is a stable point in time regardless of where it is read.
 */
function shiftDateFor(instant) {
  const t = new Date(instant).getTime();
  if (Number.isNaN(t)) return null;
  const shifted = new Date(t + SHIFT_TZ_OFFSET_MIN * MS_PER_MIN);
  const midnightLocal = Date.UTC(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth(),
    shifted.getUTCDate()
  );
  return new Date(midnightLocal - SHIFT_TZ_OFFSET_MIN * MS_PER_MIN);
}

/** The shift day that "now" falls into. */
function currentShiftDate() {
  return shiftDateFor(new Date());
}

/**
 * "WO-4471-001" -> { workOrderKey: "4471", unitNumber: 1 }
 * Anything that does not match returns nulls. The caller still stores the
 * event — a malformed barcode is a fact that happened, not something to drop.
 */
function parseBarcode(barcodeId) {
  const out = { workOrderKey: null, unitNumber: null };
  if (!barcodeId || typeof barcodeId !== "string") return out;

  const parts = barcodeId.trim().split("-");
  if (parts.length < 3) return out;
  if (parts[0].toUpperCase() !== "WO") return out;

  const key = parts[1].trim();
  if (key) out.workOrderKey = key;

  const unit = Number.parseInt(parts[2], 10);
  if (Number.isFinite(unit)) out.unitNumber = unit;

  return out;
}

/** Device sends "SJ-01,BA-03"; older payloads may send an array. */
function normaliseActiveOps(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (typeof raw === "string") {
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

module.exports = {
  SHIFT_TZ_OFFSET_MIN,
  shiftDateFor,
  currentShiftDate,
  parseBarcode,
  normaliseActiveOps,
};
