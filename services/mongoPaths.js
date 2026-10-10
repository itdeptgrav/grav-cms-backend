// services/mongoPaths.js
//
// NESTED OBJECTS BECOME DOT PATHS, SO A PARTIAL UPDATE MERGES.
//
// ── THE BUG THIS EXISTS TO STOP ─────────────────────────────────────────────
// `$set: { documents: { aadharNumber: "…" } }` does not add an Aadhaar number
// to somebody's documents. It REPLACES the whole `documents` sub-document, so
// the PAN, the UAN, the uploaded Aadhaar scan and every other sibling key are
// erased by a request that never mentioned them.
//
// That is what `PUT /api/employees/:id` did. The employee form saves one
// section at a time and each section sends its own sub-objects, so every save
// of the Documents section dropped whatever that payload happened not to
// carry — the file objects, which are included only when a fresh upload is in
// browser state, and `additionalDocuments`, which the form never sends at all.
// The symptom HR reported is exactly the mechanism: a field is saved, and
// after a refresh something NEXT to it is gone, or a value comes back as it
// was because the form reloaded a sub-document that had been replaced.
//
// `address` is the one with teeth beyond annoyance: the monthly leave cap is
// judged on `address.permanent.state` (services/leaveHomeState.service.js), so
// a whole-object replace that dropped the permanent branch silently moved
// somebody between the 7-day and 10-day cap.
//
// ── WHY IT LIVES HERE ──────────────────────────────────────────────────────
// `PATCH /api/employees/bulk-update` already did this correctly and carried
// the only copy, with the comment this file's title is taken from. One route
// doing it right and its neighbour doing it wrong is the state that produced
// the bug, so there is one implementation now and both call it.
//
// ── WHAT IS DELIBERATELY NOT FLATTENED ─────────────────────────────────────
// An ARRAY is a value, not a branch. `fieldsNotAvailable`,
// `documents.additionalDocuments` and the custom-field arrays are meant to be
// replaced wholesale — flattening them to `arr.0`, `arr.1` would leave the
// tail of a shortened array in place, which is a different data-loss bug.
// A Date, a Buffer and an ObjectId are values for the same reason: they are
// objects, and walking into them would write their internals as fields.
//
// An EMPTY object contributes no paths, so the sub-document is left exactly as
// it is. That is the intended reading of `{ bankDetails: {} }` — a section
// that sent a sub-object whose every key was undefined is saying nothing about
// it, not asking for it to be emptied. Clearing a value is done by sending it
// as "" or null, which are leaves and survive.

"use strict";

const mongoose = require("mongoose");

/** Values that are objects but must be written whole, never walked into. */
function isLeafObject(v) {
  return (
    Array.isArray(v) ||
    v instanceof Date ||
    v instanceof mongoose.Types.ObjectId ||
    (typeof Buffer !== "undefined" && Buffer.isBuffer(v))
  );
}

/**
 * Flatten a partial update into `$set` dot paths.
 *
 * @param {object} obj     the update, with nested plain objects
 * @param {string} prefix  internal — the path walked so far
 * @param {object} out     internal — the accumulator
 * @returns {object} { "a.b.c": value } ready for `$set`
 */
function flattenToPaths(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !isLeafObject(v)) {
      flattenToPaths(v, path, out);
    } else {
      out[path] = v;
    }
  }
  return out;
}

module.exports = { flattenToPaths, isLeafObject };
