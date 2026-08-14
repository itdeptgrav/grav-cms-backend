// services/enquiryRef.js
//
// Safe generation of the human Enquiry reference, `ENQ-YYYY-NNNNN`.
//
// Identical discipline to services/salesJourneyRef.js — an atomic per-year
// counter in the shared `crm_sequences` collection, with the unique index on
// `enquiryId` as a backstop and a bounded retry. The reference is customer- and
// audit-facing ("your enquiry ENQ-2026-00182"), so a collision is a real
// defect, not cosmetic. See salesJourneyRef.js for the full rationale.

"use strict";

const mongoose = require("mongoose");

// Reuse the SAME counter model/collection as the journey reference — different
// `key` namespace (`enquiry:YYYY`), so the two sequences never interfere.
const counterSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    seq: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "crm_sequences" },
);

const Counter =
  mongoose.models.CRMSequence || mongoose.model("CRMSequence", counterSchema);

const PREFIX = "ENQ";
const PAD = 5;

const format = (year, seq) => `${PREFIX}-${year}-${String(seq).padStart(PAD, "0")}`;

/** Reserve and return the next enquiry reference for `year`. */
async function nextEnquiryRef(year = new Date().getFullYear()) {
  const doc = await Counter.findOneAndUpdate(
    { key: `enquiry:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  ).lean();
  return format(year, doc.seq);
}

/**
 * Create an Enquiry with a freshly reserved reference, retrying onto the next
 * number if the unique index refuses it.
 */
async function createWithRef(Model, payload, attempts = 5) {
  const year = new Date().getFullYear();
  let lastErr;

  for (let i = 0; i < attempts; i++) {
    const enquiryId = await nextEnquiryRef(year);
    try {
      return await Model.create({ ...payload, enquiryId });
    } catch (err) {
      const isDuplicateRef =
        err?.code === 11000 && JSON.stringify(err?.keyPattern || {}).includes("enquiryId");
      if (!isDuplicateRef) throw err;
      lastErr = err;
    }
  }
  throw lastErr || new Error("Could not allocate an Enquiry reference.");
}

/** Test seam. */
async function _resetSequence(year = new Date().getFullYear()) {
  await Counter.deleteOne({ key: `enquiry:${year}` });
}

module.exports = { nextEnquiryRef, createWithRef, Counter, _resetSequence, format };
