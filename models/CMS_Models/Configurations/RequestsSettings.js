// models/CMS_Models/Configurations/RequestsSettings.js
//
// GLOBAL SWITCHES FOR THE REQUESTS SYSTEM (MRF, spend requests, …).
//
// The first (and so far only) switch: whether finance/budget involvement is
// currently part of the MRF flow.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────
// Explicit request, 31 Aug 2026: "due to some reason temporarily we need to
// pause that revenue/accounts department budget involvement with this mrf...
// in the admin ceo side, keep the button for whether wants to include the
// budget concept in the mrf or not... if this is disabled then normally as
// like previous means the store person only do the matching, issue items and
// all... that conversation with revenue team shouldn't showcase/happen here."
//
// Normally, when Store decides an MRF needs a purchase (`buy_or_service` /
// `partial_buy_balance`), it spins off a SpendRequest that starts at
// `pending_finance` — finance has to approve the budget before Store can
// raise a purchase order. See routes/CMS_Routes/Inventory/Operations/
// mrfRoutes.js's `/:id/fulfilment-decision` and services/
// spendRequestCreate.service.js.
//
// With `mrfBudgetEnabled: false`, that same route skips the budget-head
// requirement and starts the resulting SpendRequest already `approved` (see
// services/spendApproval.service.js's APPROVED constant) — Store can raise
// the purchase order immediately, with no finance step in between. Nothing
// about SpendRequest, budget commitments, or the accountant module is
// removed; this only changes where a request STARTS on that chain.
//
// ── WHY A SINGLETON, NOT AN ENV VAR ──────────────────────────────────────
// `PM_APPROVAL_FOR_MRF` (grav-backend's own env var) is the cautionary
// example: it is read once at module load and never actually consulted
// anywhere, because nobody could flip it without a redeploy. A CEO flipping
// this on and off "temporarily" needs it to take effect the next request, not
// the next deploy — so it is one document, read fresh (or from a short
// in-process cache) on every check.
"use strict";

const mongoose = require("mongoose");

const requestsSettingsSchema = new mongoose.Schema(
  {
    // One document. The unique index is what makes a second one impossible
    // at the database level rather than by convention — see StoreSettings.js
    // for the same pattern.
    key: { type: String, default: "requests", unique: true, immutable: true },

    // The switch. Defaults to true so a fresh install behaves exactly as the
    // codebase already did before this existed — "temporarily paused" is
    // something a CEO turns OFF, not the ground state.
    mrfBudgetEnabled: { type: Boolean, default: true },

    // Audit trail for the one action this collection exists to gate — who
    // paused finance's involvement in MRF, and why, matters more here than on
    // an ordinary settings row.
    updatedByRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    updatedByName: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "", maxlength: 500 },
  },
  { timestamps: true },
);

/** The document, created with defaults on first read — same pattern as
 *  StoreSettings.get(). */
requestsSettingsSchema.statics.get = async function () {
  const existing = await this.findOne({ key: "requests" });
  if (existing) return existing;
  try {
    return await this.create({ key: "requests" });
  } catch (err) {
    // Two concurrent first-reads race; the unique index rejects the loser,
    // whose document is now guaranteed to exist.
    if (err?.code === 11000) return this.findOne({ key: "requests" });
    throw err;
  }
};

module.exports =
  mongoose.models.RequestsSettings ||
  mongoose.model("RequestsSettings", requestsSettingsSchema);
