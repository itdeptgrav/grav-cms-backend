// services/leadRef.js
//
// Safe generation of the human Lead reference, `LEAD-YYYY-NNNN`.
//
// This is the exact atomic pattern proven by services/salesJourneyRef.js
// (see that file for the full rationale — `countDocuments() + 1`, which the
// old Lead.js pre-save hook used, collides under concurrent creates and
// re-issues a reference when earlier rows are removed from the count).
//
// SHARED PRIMITIVE, NOT A COPY. `Counter` is imported from
// salesJourneyRef.js rather than redefined here, so there is exactly one
// atomic-counter collection/model in the codebase, not two competing
// implementations of the same idea. salesJourneyRef.js itself is NOT
// modified — this file only reads its export. The two sequences cannot
// collide with each other: `nextJourneyRef` writes documents keyed
// "salesJourney:<year>" and `nextLeadRef` below writes documents keyed
// "lead:<year>", so they are disjoint rows in the same `crm_sequences`
// collection. test/crm/lead.test.js includes a regression assertion that
// allocating Lead references does not disturb Journey reference sequencing,
// so this sharing is covered exactly as the task requires.

"use strict";

const { Counter } = require("./salesJourneyRef");

const PREFIX = "LEAD";
const PAD = 4;

const format = (year, seq) => `${PREFIX}-${year}-${String(seq).padStart(PAD, "0")}`;

/**
 * Reserve and return the next Lead reference for `year`.
 *
 * @param {number} [year] defaults to the current year
 * @returns {Promise<string>} e.g. "LEAD-2026-0001"
 */
async function nextLeadRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `lead:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return format(year, doc.seq);
}

/**
 * Create a Lead with a freshly reserved reference, retrying onto the next
 * number if the unique index refuses it. Mirrors salesJourneyRef.createWithRef.
 *
 * @param {import("mongoose").Model} Model  the Lead model
 * @param {object} payload                  everything except `leadId`
 * @param {number} [attempts]
 */
async function createWithRef(Model, payload, attempts = 5) {
  const year = new Date().getFullYear();
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const leadId = await nextLeadRef(year);
    try {
      return await Model.create({ ...payload, leadId });
    } catch (err) {
      const isDuplicateRef =
        err?.code === 11000 && JSON.stringify(err?.keyPattern || {}).includes("leadId");
      if (!isDuplicateRef) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not allocate a Lead reference.");
}

/** Test seam — lets a suite assert sequence behaviour from a known point. */
async function _resetSequence(year = new Date().getFullYear()) {
  await Counter.deleteOne({ key: `lead:${year}` });
}

module.exports = { nextLeadRef, createWithRef, _resetSequence, format };
