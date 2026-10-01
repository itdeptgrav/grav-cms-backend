// models/CMS_Models/PPC/DownstreamHandoverReceipt.js
//
// PPC'S DECISION ON A MERCHANDISING EXECUTION PACK. PPC-OWNED.
//
// ── WHY THIS LIVES UNDER PPC AND NOT UNDER MERCHANDISING ────────────────────
// It is the receiving department's record of its own decision. Merchandising
// announces a submitted pack through its outbox; PPC's route writes this row.
// Nothing in `services/merchandising/` may write it, and a test scans for
// that — the same inversion `handoverIntake.service.js` established for Sales
// → Merchandising, where the producer cannot reach a receiver model.
//
// Merchandising READS it (to show what came back) and MIRRORS its state onto
// the file for the register. Reading and mirroring are not authoring: the
// mirrored copy is labelled "as PPC recorded it" everywhere it appears, and
// the authoritative answer is always this document.
//
// ── PENDING IS COMPUTED, NOT STORED ─────────────────────────────────────────
// A submitted pack with no receipt row IS pending. Writing a PENDING row at
// submission would mean Merchandising creating a PPC record before PPC had
// done anything — precisely the cross-app write this design exists to prevent.
// So the absence of a row is the pending state, and every reader derives it.
//
// ── AND THERE IS NO `REJECTED` ──────────────────────────────────────────────
// PPC may ask for clarification; it does not reject. The pack carries a
// commercial commitment Sales already made and the company already accepted —
// refusing it is not PPC's call any more than declining a Sales handover is
// Merchandising's. The enum has no such member, so the state cannot be
// reached by any route, present or future, without this file changing.
"use strict";

const mongoose = require("mongoose");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true },
  email: { type: String, trim: true, lowercase: true },
});

/**
 * What PPC can say about a pack.
 *
 * `SUPERSEDED` and `CANCELLED_BY_MERCHANDISING` are not PPC decisions — they
 * are what happens to PPC's row when the thing it decided about is replaced or
 * the order is cancelled. PPC's own decision is preserved underneath in
 * `decidedBy`/`decidedAt`, because "PPC accepted version 2 on the 4th" stays
 * true after version 3 supersedes it.
 */
const RECEIPT_STATE = Object.freeze({
  ACCEPTED: "ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  SUPERSEDED: "SUPERSEDED",
  CANCELLED_BY_MERCHANDISING: "CANCELLED_BY_MERCHANDISING",
});

/** What a clarification can be about. Closed, so it can be reported on. */
const CLARIFICATION_CATEGORY = Object.freeze([
  "MISSING_EXECUTION_DETAIL",
  "DATE_NOT_ACHIEVABLE",
  "QUANTITY_OR_SPLIT_UNCLEAR",
  "MATERIAL_OR_TRIM_QUERY",
  "PACKING_REQUIREMENT_UNCLEAR",
  "OTHER",
]);

const MIN_REASON = 15;

const receiptSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    /* Exactly which pack version was decided on. Immutable: a decision that
       could be re-pointed at a different version would be worthless. */
    packId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    packVersionNo: { type: Number, required: true, immutable: true },
    fileId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true },

    state: { type: String, enum: Object.values(RECEIPT_STATE), required: true },

    clarification: {
      category: { type: String, enum: CLARIFICATION_CATEGORY, default: undefined },
      /* Long enough to act on. A one-word clarification sends the pack back
         with nothing anybody can do about it. */
      reason: { type: String, trim: true, default: "", maxlength: 2000 },
    },

    /* Who in PPC decided, and when. Absent on SUPERSEDED/CANCELLED rows that
       were never decided. */
    decidedBy: actorRef(),
    decidedAt: { type: Date, default: null },

    /* The event that carried the pack to PPC — how a duplicate delivery is
       recognised. */
    sourceEventId: { type: mongoose.Schema.Types.ObjectId, default: null },

    revision: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "ppc_downstream_handover_receipts" },
);

/* One decision per pack version. The database, not the handler, is what makes
   a duplicate accept impossible. */
receiptSchema.index({ companyId: 1, packId: 1 }, { unique: true });
/* PPC's inbound queue: everything decided on one file, newest first. */
receiptSchema.index({ companyId: 1, fileId: 1, packVersionNo: -1 });

module.exports = {
  RECEIPT_STATE, CLARIFICATION_CATEGORY, MIN_REASON,
  DownstreamHandoverReceipt: mongoose.models.DownstreamHandoverReceipt
    || mongoose.model("DownstreamHandoverReceipt", receiptSchema),
};
