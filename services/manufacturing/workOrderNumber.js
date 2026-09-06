// services/manufacturing/workOrderNumber.js
//
// THE NUMBER A WORK ORDER IS SHOWN BY — one rule, every screen.
//
// WHY THIS EXISTS (6 Sep 2026)
// ----------------------------
// `WorkOrder.workOrderNumber` is empty on every work order in the database.
// The model assigns one in a `pre("validate")` hook, but that hook is guarded
// on `isNew`, so it has never touched the 143 rows that predate it — and the
// model says so itself: "production holds many with neither field…
// populating those records is a migration, deliberately separate".
//
// That migration has not been run, so every screen that renders
// `wo.workOrderNumber` raw shows a blank where the number should be. Several do
// — the Project Manager's cutting, embroidery, packaging, planning, bulk
// tracking and production tabs all print it unguarded, which is what "the wo
// number are not showing" is.
//
// The rest of the codebase already had an answer for this, scattered as
// `workOrderNumber || "WO-" + _id.slice(-8)` at each read. This is that
// expression, named once, applied at the API boundary so a reader gets a
// number rather than having to know the field may be empty.
//
// WHY THE SHORT FORM AND NOT THE MODEL'S CANONICAL ONE
// ----------------------------------------------------
// `WorkOrder.canonicalNumber()` returns `WO-<full ObjectId>` — the right
// choice for a stored unique key, and left alone here. But it is not what the
// floor reads: every unit barcode is `WO-<last 8 of the id>-<unit>`, built and
// parsed that way by the scanner, the QC pipeline and the production ledger.
// Showing `WO-6a79a588da39e282a6b16a8f` on screen beside a label reading
// `WO-a6b16a8f-001` gives one work order two different numbers, which is worse
// than the blank it replaces. So the DISPLAY number matches the label, and the
// model's own comment already calls the eight-character form exactly that: "a
// PRESENTATION fallback".
//
// A stored `workOrderNumber` always wins. Nothing here writes to the database:
// if the migration is run later, these functions return the stored value and
// this module quietly stops mattering.

"use strict";

/** The last 8 hex characters of an id — the form every barcode is built from. */
const shortIdOf = (id) => String(id ?? "").slice(-8);

/**
 * What to call this work order.
 *
 * @param {object} wo  a WorkOrder document or lean object (needs `_id`)
 * @returns {string}   the stored number, else `WO-<short id>`, else "" when
 *                     there is nothing to name at all.
 */
function displayWorkOrderNumber(wo) {
  const stored = String(wo?.workOrderNumber ?? "").trim();
  if (stored) return stored;
  const short = shortIdOf(wo?._id ?? wo?.workOrderId);
  return short ? `WO-${short}` : "";
}

/**
 * The same row back, with `workOrderNumber` guaranteed non-empty.
 *
 * Returns the object unchanged when it already has one, so this is safe to map
 * over a list that is already correct.
 */
function withWorkOrderNumber(wo) {
  if (!wo) return wo;
  const resolved = displayWorkOrderNumber(wo);
  if (!resolved || wo.workOrderNumber === resolved) return wo;
  return { ...wo, workOrderNumber: resolved };
}

/** `withWorkOrderNumber` over a list. A non-array is returned as-is. */
function withWorkOrderNumbers(rows) {
  return Array.isArray(rows) ? rows.map(withWorkOrderNumber) : rows;
}

module.exports = { shortIdOf, displayWorkOrderNumber, withWorkOrderNumber, withWorkOrderNumbers };
