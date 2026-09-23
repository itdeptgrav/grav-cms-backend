// models/CMS_Models/Marketing/MarketingLeadSourceState.js
//
// HOW FAR GRAV HAS READ ONE LEAD SOURCE, AND HOW THE LAST CHECK WENT.
//
// One row per company and source. It is the cursor, the rate fence and the
// run lease in one place, so all three move together atomically.
//
//   coveredThrough  the end of the last window whose every enquiry is saved.
//                   It moves only forward, and only after the whole window is
//                   durable — a failed or half-saved check leaves it where it
//                   was, so the next check asks for the same window again.
//   lastCallAt      set BEFORE the call to the source. A call whose answer was
//                   lost still counted against the source's rate limit.
//   leaseUntil      one check at a time; a crashed check frees it on expiry.
//
// ── NO SECRET HERE ─────────────────────────────────────────────────────────
// The key lives in the server environment. Nothing in this row is a key, a
// URL, a request, a response body or a source message.
"use strict";

const mongoose = require("mongoose");

const countsSchema = new mongoose.Schema(
  {
    received: { type: Number, default: 0 },
    recorded: { type: Number, default: 0 },
    alreadyHeld: { type: Number, default: 0 },
    unreadable: { type: Number, default: 0 },
  },
  { _id: false, strict: "throw" },
);

const runSchema = new mongoose.Schema(
  {
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, default: null },
    outcome: { type: String, enum: ["completed", "failed"], required: true },
    /* Which door started it. Not a person. */
    startedBy: { type: String, enum: ["scheduler", "manual", ""], default: "" },
    windowFrom: { type: Date, required: true },
    windowTo: { type: Date, required: true },
    counts: { type: countsSchema, default: () => ({}) },
    /* A GRAV error code from constants/marketingIndiamart.js ERRORS. */
    errorCode: { type: String, default: "" },
  },
  { _id: false, strict: "throw" },
);

const stateSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },
    source: { type: String, enum: ["indiamart"], required: true },

    coveredFrom: { type: Date, default: null },
    coveredThrough: { type: Date, default: null },
    /* Time ranges that aged out of the source before GRAV read them. */
    gaps: {
      type: [new mongoose.Schema({ from: Date, to: Date }, { _id: false, strict: "throw" })],
      default: [],
    },

    lastCallAt: { type: Date, default: null },
    blockedUntil: { type: Date, default: null },
    leaseUntil: { type: Date, default: null },
    leaseToken: { type: String, default: "" },

    lastRun: { type: runSchema, default: null },
    lastSuccessAt: { type: Date, default: null },
    /* The scheduler's own heartbeat: the last cycle that looked at this
       source, whether or not it was allowed to call. */
    lastScheduledCycleAt: { type: Date, default: null },
    lastScheduledCycleOutcome: { type: String, default: "" },
    lastFailureAt: { type: Date, default: null },
    consecutiveFailures: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "marketing_lead_source_states", strict: "throw" },
);

stateSchema.index({ companyId: 1, source: 1 }, { unique: true });

const MarketingLeadSourceState = mongoose.models.MarketingLeadSourceState
  || mongoose.model("MarketingLeadSourceState", stateSchema);

module.exports = { MarketingLeadSourceState };
