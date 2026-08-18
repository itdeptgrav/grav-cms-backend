// services/sampleStyleRef.js
//
// Safe generation of the human SampleStyle reference, `SS-YYYY-NNNN`.
//
// Identical discipline to services/enquiryRef.js / salesJourneyRef.js — an
// atomic per-year counter in the shared `crm_sequences` collection, with the
// unique index on `sampleStyleId` as a backstop and a bounded retry. The
// reference is audit-facing, so a collision is a real defect. See
// salesJourneyRef.js for the full rationale.

"use strict";

// Reuse the SAME counter model/collection as the other CRM references — a
// distinct `key` namespace (`sampleStyle:YYYY`) keeps the sequences disjoint.
const { Counter } = require("./salesJourneyRef");

const PREFIX = "SS";
const PAD = 4;

const format = (year, seq) => `${PREFIX}-${year}-${String(seq).padStart(PAD, "0")}`;

/** Reserve and return the next SampleStyle reference for `year`. */
async function nextSampleStyleRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `sampleStyle:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return format(year, doc.seq);
}

/**
 * Create a SampleStyle with a freshly reserved reference, retrying onto the
 * next number if the unique index refuses it.
 */
async function createWithRef(Model, payload, attempts = 5) {
  const year = new Date().getFullYear();
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const sampleStyleId = await nextSampleStyleRef(year);
    try {
      return await Model.create({ ...payload, sampleStyleId });
    } catch (err) {
      const isDuplicateRef =
        err?.code === 11000 && JSON.stringify(err?.keyPattern || {}).includes("sampleStyleId");
      if (!isDuplicateRef) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not allocate a SampleStyle reference.");
}

/** Test seam. */
async function _resetSequence(year = new Date().getFullYear()) {
  await Counter.deleteOne({ key: `sampleStyle:${year}` });
}

module.exports = { nextSampleStyleRef, createWithRef, _resetSequence, format };
