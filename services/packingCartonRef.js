// services/packingCartonRef.js
//
// Safe generation of the carton reference, `CTN-YYYY-NNNN`.
//
// A carton number is printed on an A4 label, encoded in a QR code, and quoted
// between the packing floor, dispatch and the customer's receiving bay. Two
// cartons sharing one number is not a cosmetic defect: it is two boxes whose
// contents cannot be told apart by the one thing written on them. So this is
// the same atomic-counter-plus-unique-index arrangement salesJourneyRef.js
// uses, not `countDocuments() + 1`, for the reasons that file records.
//
// `findOneAndUpdate({ $inc }, { upsert: true })` is one document-level write,
// so two people sealing cartons at the same moment get two different numbers.
// The counter is per year, so the sequence restarts at 0001 each January with
// no reset job. Each call consumes a number whether or not a carton is saved —
// a gap in the sequence is harmless, a duplicate is not — and the unique index
// on PackingCarton.cartonNumber is the backstop.
//
// ── WHY THE COUNTER LIVES IN `crm_sequences` (24 Sep 2026) ──────────────────
// It had its own collection, `packaging_sequences`, and every seal failed with
// "Server error": the Atlas cluster is at its 500-collection cap and refused
// to create it. `crm_sequences` already exists, already holds exactly this
// shape — `{ key, seq }`, one document per sequence, unique on `key` — and the
// key is namespaced (`packingCarton:<year>`), so it cannot touch the Journey
// counters beside it. One collection fewer to ask a full cluster for.

"use strict";

const mongoose = require("mongoose");

/* Byte-for-byte the schema services/salesJourneyRef.js registers, so whichever
   module loads first registers the model and the other reuses it. */
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "crm_sequences" },
);

const Counter =
  mongoose.models.CRMSequence || mongoose.model("CRMSequence", counterSchema);

const PREFIX = "CTN";
const PAD = 4;
const PATTERN = /^CTN-(\d{4})-(\d+)$/i;

const format = (year, seq) => `${PREFIX}-${year}-${String(seq).padStart(PAD, "0")}`;

/**
 * Reserve and return the next carton reference for `year`.
 *
 * @param {number} [year] defaults to the current year
 * @returns {Promise<string>} e.g. "CTN-2026-0001"
 */
async function nextCartonNumber(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `packingCarton:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return format(year, doc.seq);
}

/**
 * Normalise what a person typed or a scanner read into the stored form.
 *
 * Accepts the bare number in any case and padding ("ctn-2026-7"), and the URL
 * a carton label's QR code carries (".../cartons/CTN-2026-0007"), so the same
 * field takes a keyboard, a hand scanner or a phone camera.
 */
function normaliseCartonNumber(value) {
  let s = String(value ?? "").trim();
  const fromUrl = /\/cartons\/([^/?#\s]+)/i.exec(s);
  if (fromUrl) s = decodeURIComponent(fromUrl[1]);
  s = s.toUpperCase();
  const m = PATTERN.exec(s);
  if (!m) return s;
  return format(m[1], Number(m[2]));
}

/** Does this look like a carton reference (or a carton QR's URL)? */
function isCartonReference(value) {
  return PATTERN.test(normaliseCartonNumber(value));
}

module.exports = { nextCartonNumber, normaliseCartonNumber, isCartonReference, PATTERN };
