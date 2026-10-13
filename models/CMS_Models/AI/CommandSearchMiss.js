// models/CMS_Models/AI/CommandSearchMiss.js
//
// A SEARCH CMD/CTRL K COULD NOT ANSWER — THE WORDS, AND HOW OFTEN.
//
// ── WHAT IT IS FOR ─────────────────────────────────────────────────────────
// The palette understands a question when its words match a name it knows.
// When they match nothing it says so, and until now nobody could see what had
// been typed. These rows are that list, so the words people actually use can
// be taught to it (services/ai/storeVocabulary.js), a few at a time.
//
// ── ANONYMOUS BY CONSTRUCTION ──────────────────────────────────────────────
// Decided by the owner, 8 Oct 2026: what was typed, never who typed it. There
// is no field here for a person, an employee, an email or a company, and a
// test asserts the schema has none — so "anonymous" is a property of the
// collection, not a promise in a route. Phone numbers and email addresses are
// blanked out of the text before it is saved
// (services/ai/commandSearchMisses.js).
//
// ── KEPT 90 DAYS ───────────────────────────────────────────────────────────
// Also the owner's: a row is deleted 90 days after the search was LAST typed,
// by MongoDB's own TTL monitor. A word still being typed every week stays on
// the list; one nobody uses again leaves it.
//
// One row per distinct search per application, counted with `$inc`, so the
// collection grows with the vocabulary, not with the traffic.
"use strict";

const mongoose = require("mongoose");

const RETENTION_DAYS = 90;

const commandSearchMissSchema = new mongoose.Schema(
  {
    app: { type: String, required: true, trim: true, maxlength: 40 },
    /* Lower-cased, spaces collapsed, phone numbers and emails blanked. */
    query: { type: String, required: true, trim: true, maxlength: 200 },
    /* The palette's own verdict: no_match (words understood, nothing found)
       or unsupported (words not understood at all). */
    state: { type: String, required: true, enum: ["no_match", "unsupported"] },
    count: { type: Number, required: true, default: 0, min: 0 },
    firstSeenAt: { type: Date, required: true },
    lastSeenAt: { type: Date, required: true },
  },
  { collection: "command_search_misses", versionKey: false },
);

commandSearchMissSchema.index({ app: 1, query: 1 }, { unique: true });
commandSearchMissSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: RETENTION_DAYS * 24 * 60 * 60 });
commandSearchMissSchema.index({ app: 1, count: -1 });

const CommandSearchMiss = mongoose.models.CommandSearchMiss
  || mongoose.model("CommandSearchMiss", commandSearchMissSchema);

module.exports = CommandSearchMiss;
module.exports.RETENTION_DAYS = RETENTION_DAYS;
