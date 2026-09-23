// models/CMS_Models/AI/GravAiUsage.js
//
// HOW MUCH OF THE ASSISTANT ONE COMPANY USED TODAY.
//
// ── A CEILING ENFORCED AFTERWARDS IS AN INVOICE ────────────────────────────
// This row exists so the gateway can answer "may I make this call" before
// making it. Counting usage after the fact tells somebody what they spent; it
// does not stop them spending it.
//
// ── TOKENS, NOT MONEY ──────────────────────────────────────────────────────
// No currency field anywhere, deliberately. Provider pricing changes
// independently of this code; a stored rupee figure would be wrong the week it
// changed, and a wrong number labelled as money is worse than an honest token
// count. Whoever wants money multiplies by today's published rate.
"use strict";

const mongoose = require("mongoose");

const { OPERATION_CODES } = require("../../../constants/gravAi");

const usageSchema = new mongoose.Schema(
  {
    /* ── EVERY SELECTOR CARRIES THIS ─────────────────────────────────────
       One company's usage can neither be read nor spent by another. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true },

    /* Per operation, not per company overall. A future operation with a
       different cost profile gets its own ceiling rather than competing for one
       shared allowance — and a runaway in one cannot silence the other. */
    operation: { type: String, enum: OPERATION_CODES, required: true },

    /* A calendar day in UTC, as a string. A ceiling that reset at "midnight
       somewhere" would reset at a different moment for every company. */
    usageDate: { type: String, required: true, trim: true, match: /^\d{4}-\d{2}-\d{2}$/ },

    /* ── COUNTED ON EVERY ATTEMPT THAT REACHED THE PROVIDER ──────────────
       Including the ones that failed. A refused or timed-out request still cost
       the provider's time and, for some failures, tokens — and a ceiling that
       only counted successes would let a failing integration retry for ever. */
    requests: { type: Number, required: true, default: 0, min: 0 },

    /* Reported by the provider where it reports them. `cachedTokens` is
       recorded separately rather than folded in: it is usually cheaper and
       sometimes free, and merging it would misstate both figures. */
    inputTokens: { type: Number, required: true, default: 0, min: 0 },
    outputTokens: { type: Number, required: true, default: 0, min: 0 },
    cachedTokens: { type: Number, required: true, default: 0, min: 0 },

    /* Which model actually answered, as the provider named it. Not the one
       configured — those differ when a provider silently serves an alias, and
       the stored analysis has to say what really produced it. */
    models: { type: [{ type: String, trim: true, maxlength: 80 }], default: [] },

    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: "grav_ai_usage", strict: "throw" },
);

/* One row per company per operation per day. The uniqueness is what lets the
   gateway increment atomically with `$inc` rather than read-modify-write, so
   two concurrent requests cannot both see the same count and both pass a
   ceiling that only had room for one. */
usageSchema.index({ companyId: 1, operation: 1, usageDate: 1 }, { unique: true });

module.exports = {
  GravAiUsage: mongoose.models.GravAiUsage || mongoose.model("GravAiUsage", usageSchema),
};
