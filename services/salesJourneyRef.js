// services/salesJourneyRef.js
//
// Safe generation of the human Journey reference, `SJ-YYYY-NNNN`.
//
// WHY THIS IS NOT `countDocuments() + 1`.
// That pattern is used elsewhere in this repo (CRMActivity's `activityId` among
// them) and it is not safe: two concurrent creates read the same count and mint
// the same reference, and archived rows shift the count so a later create can
// re-issue a reference that already exists. The Journey reference is the value
// the ROUTE keys on — `/sales/dashboard/journeys/SJ-2026-0001/account` — so a
// collision is not a cosmetic defect, it is two customers' work colliding at
// one URL.
//
// HOW THIS IS SAFE.
// `findOneAndUpdate({ $inc }, { upsert: true })` is atomic in MongoDB: the
// increment and the read of the new value happen inside one document-level
// write, so two concurrent callers get two different numbers even under load.
// The counter is scoped per year, so the sequence restarts at 0001 each January
// without any reset job.
//
// AND WHY THERE IS STILL A RETRY.
// The atomic counter is the primary defence; the unique index on `journeyId` is
// the backstop. If a counter document is ever restored from a stale backup, or
// a reference is written by some future import path that bypasses this service,
// the index refuses the duplicate and the caller retries onto the next number
// rather than failing the user's create. Belt and braces, because the failure
// mode is a wrong URL rather than a wrong row.

"use strict";

const mongoose = require("mongoose");

const counterSchema = new mongoose.Schema(
  {
    // One document per sequence, e.g. "salesJourney:2026".
    key: { type: String, required: true, unique: true, index: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "crm_sequences" },
);

// Guard against redefining the model when Jest re-imports this file across
// test suites in one process.
const Counter =
  mongoose.models.CRMSequence || mongoose.model("CRMSequence", counterSchema);

const PREFIX = "SJ";
const PAD = 4;

const format = (year, seq) => `${PREFIX}-${year}-${String(seq).padStart(PAD, "0")}`;

/**
 * Reserve and return the next reference for `year`.
 *
 * Each call consumes a number whether or not the caller goes on to save — a
 * gap in the sequence is harmless, a duplicate is not.
 *
 * @param {number} [year] defaults to the current year
 * @returns {Promise<string>} e.g. "SJ-2026-0001"
 */
async function nextJourneyRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `salesJourney:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return format(year, doc.seq);
}

/**
 * Create a document with a freshly reserved reference, retrying onto the next
 * number if the unique index refuses it.
 *
 * @param {import("mongoose").Model} Model  the SalesJourney model
 * @param {object} payload                  everything except `journeyId`
 * @param {number} [attempts]               bounded, so a genuinely broken index
 *                                          surfaces as an error rather than a
 *                                          spin
 */
async function createWithRef(Model, payload, attempts = 5) {
  const year = new Date().getFullYear();
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const journeyId = await nextJourneyRef(year);
    try {
      return await Model.create({ ...payload, journeyId });
    } catch (err) {
      // 11000 = duplicate key. Anything else is the caller's problem, not ours.
      const isDuplicateRef =
        err?.code === 11000 && JSON.stringify(err?.keyPattern || {}).includes("journeyId");
      if (!isDuplicateRef) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not allocate a Journey reference.");
}

/** Test seam — lets a suite assert sequence behaviour from a known point. */
async function _resetSequence(year = new Date().getFullYear()) {
  await Counter.deleteOne({ key: `salesJourney:${year}` });
}

module.exports = { nextJourneyRef, createWithRef, Counter, _resetSequence, format };
