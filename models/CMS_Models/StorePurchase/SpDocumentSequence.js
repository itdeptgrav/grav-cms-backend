// models/CMS_Models/StorePurchase/SpDocumentSequence.js
//
// Store & Purchase — Chunk 1. ATOMIC DOCUMENT NUMBERING.
//
// ── WHAT THIS REPLACES ──────────────────────────────────────────────────────
// Chunk 0 found four different race-prone schemes, all of them read-then-write:
//   · operational PO   `PO<yy><mm><rand4>` — random, existence-checked in a
//                      loop, retried ten times and then given up on
//   · worksheet PO/WO  a counter read, incremented in JS and saved back
//   · MRF / REQ / SPR  regex-sort the collection, parse the last number, +1
// Every one of them can mint the same number twice under concurrency, and
// none of them retries on the duplicate-key error that follows.
//
// This is one counter document per {company, documentType, fiscalYear, site},
// moved by a single atomic $inc. Two simultaneous callers get two different
// numbers because the database, not the process, does the incrementing.
//
// ── NUMBERS ARE NEVER REUSED ────────────────────────────────────────────────
// `next` only ever moves forward. A failed save, a cancellation or a deletion
// does NOT return its number to the pool: a gap in a commercial sequence is a
// question somebody can answer ("PO/2026-27/0007 was cancelled"), whereas a
// reissued number is two documents that claim to be the same one.
"use strict";

const mongoose = require("mongoose");

const sequenceSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
    },

    /* e.g. "PURCHASE_ORDER". Server vocabulary, never supplied by a client. */
    documentType: { type: String, required: true, trim: true },

    /* Indian financial year, "2026-27" — the same shape Acc_Budget uses. */
    fiscalYear: { type: String, required: true, trim: true },

    /* Only for document types whose numbering policy is per-site. Null for
       every current type, and part of the unique key so that a site-numbered
       type and a company-numbered one cannot share a counter. */
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* The last number ISSUED. The allocator returns the value after $inc, so
       the first allocation is 1. */
    next: { type: Number, default: 0, min: 0 },

    lastAllocatedAt: { type: Date },
  },
  { timestamps: true, collection: "sp_document_sequences" },
);

/* The whole guarantee. Two callers racing on one key contend on this index
   and the loser is upserted into the same document, not a second one. */
sequenceSchema.index(
  { companyId: 1, documentType: 1, fiscalYear: 1, siteId: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.SpDocumentSequence ||
  mongoose.model("SpDocumentSequence", sequenceSchema);
