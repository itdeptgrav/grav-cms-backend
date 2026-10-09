// models/CMS_Models/StorePurchase/GoodsReceiptSession.js
//
// A DRAFT RECEIVING SESSION — counting one purchase-order line by labelling it.
//
// ── WHY THIS RECORD HAS TO EXIST ────────────────────────────────────────────
// A receiver does not count a delivery, write the total down, and then print
// labels. They count BY labelling: a sticker goes on each roll as it comes off
// the vehicle, and the count is how many stickers went on. That means a label
// is printed BEFORE the goods receipt exists — and a printed label carries a
// code somebody will scan weeks later, so the code must be a real, unique,
// server-allocated identity from the moment it reaches paper.
//
// It must equally NOT be stock until the receipt is recorded. Between printing
// and finalising, the identity exists and is RESERVED: it names nothing GRAV
// will let anybody put on a shelf, issue, or find in a stock search. This
// document is what holds that in-between state, and what the activation at
// finalisation is driven from.
//
// ── ONE SESSION, ONE PO LINE, ONE COUNTER ───────────────────────────────────
// `sequenceHigh` is the line's label counter, and it is advanced only by an
// atomic `$inc` inside the reservation — so two receivers working the same
// delivery from two terminals cannot be handed the same sequence number. The
// partial unique index on (companyId, poItemId) for OPEN sessions is the second
// half of that guarantee: a line has at most one open count, so there is one
// counter rather than two that would each start at 1.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// It holds no quantity of its own. The counted quantity is the sum of the
// labels that were applied, read from the Barcode collection, because a total
// stored here could drift from the stickers it claims to describe. It records
// no stock, no movement and no receipt: finalising the GRN does all of that
// through the existing receipt engine, and this session is only told about it.
"use strict";

const mongoose = require("mongoose");

/* The session's own life. A session is OPEN while counting, and ends exactly
   once — either the receipt was recorded (FINALIZED) or it was abandoned
   (CANCELLED). Both are terminal, and both leave every label they reserved in
   a settled state. */
const SESSION_STATUS = Object.freeze({
  OPEN: "OPEN",
  FINALIZED: "FINALIZED",
  CANCELLED: "CANCELLED",
});
const SESSION_STATUSES = Object.freeze(Object.values(SESSION_STATUS));

/* How this line is being received. Kept on the session rather than inferred
   from whether labels exist: "no labels yet" and "this line is a bulk lot with
   no handling unit to label" are different claims, and only one of them means
   the receipt may be recorded from a typed total. */
const RECEIVING_MODE = Object.freeze({
  COUNT_AND_LABEL: "COUNT_AND_LABEL",
  TOTAL_ONLY: "TOTAL_ONLY",
});
const RECEIVING_MODES = Object.freeze(Object.values(RECEIVING_MODE));

/* What a label is put ON. This is the field that stops one sticker per metre:
   INDIVIDUAL is one label per piece, PACKAGE is one per roll/bundle/drum
   carrying the quantity measured in it, LOT is one label for the whole
   delivery of this line. */
const TRACKING_LEVEL = Object.freeze({
  INDIVIDUAL: "INDIVIDUAL",
  PACKAGE: "PACKAGE",
  LOT: "LOT",
});
const TRACKING_LEVELS = Object.freeze(Object.values(TRACKING_LEVEL));

const goodsReceiptSessionSchema = new mongoose.Schema(
  {
    // ── Whose count this is ────────────────────────────────────────────────
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Which line is being counted ────────────────────────────────────────
    /* ── TWO KINDS OF LINE (1 Oct 2026) ─────────────────────────────────
       A count hangs off a purchase-order line OR a customer-material
       document line — the owner asked for the same labels and scan-in on a
       customer-owned delivery as on a purchase. Exactly one pair is set:
       `purchaseOrderId` + `poItemId`, or `customerMaterialId` +
       `customerLineRef`. The unique-on-OPEN indexes are per kind (see
       scripts/migrations/receiving-session-indexes.js). */
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    poNumber: { type: String, trim: true, default: "" },
    customerMaterialId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMaterialExpectation", default: null },
    customerDocumentRef: { type: String, trim: true, default: "" },
    customerLineRef: { type: String, trim: true, default: "" },
    /* A third kind (7 Oct 2026): a line of a merchandiser's material request
       against a released order. The request lives on the order
       (`CustomerRequest.materialRequests[]`), so the count names the order,
       the request and the request line. Company-owned stock — no customer
       claim, no supplier. */
    materialRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
    materialRequestNumber: { type: String, trim: true, default: "" },
    materialLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    orderRequestId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* The stored-id join to the PO line. Never a name, never an array index:
       a line reordered in the editor must not take another line's count. */
    poItemId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Identity snapshots, so a session reads without a join and so a label
       reserved under it can be checked against the material it claims. */
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },
    variantSku: { type: String, trim: true, default: "" },
    variantCombination: [{ type: String, trim: true }],
    /* The PO line's unit. Every label reserved in this session carries it, so
       a count can never be a mixture of metres and kilograms. */
    unit: { type: String, trim: true, required: true },

    // ── How it is being received ───────────────────────────────────────────
    receivingMode: {
      type: String, enum: RECEIVING_MODES, default: RECEIVING_MODE.COUNT_AND_LABEL, required: true,
    },
    trackingLevel: { type: String, enum: [...TRACKING_LEVELS, null], default: null },
    /* What the Materials master said, recorded as it was at the time. The
       override below is only meaningful against a stated suggestion. */
    suggestedTrackingLevel: { type: String, enum: [...TRACKING_LEVELS, null], default: null },
    /* Why this delivery is tracked differently from the master. Required by the
       service whenever the two differ — an override with no reason is a setting
       nobody can account for later. */
    trackingOverrideReason: { type: String, trim: true, default: "" },

    /* ── THE LABEL COUNTER ─────────────────────────────────────────────────
       Advanced ONLY by an atomic `$inc` in the reservation. It never goes
       backwards: a voided label's sequence is spent, because re-issuing it
       would put two different stickers into the record under one number. */
    sequenceHigh: { type: Number, default: 0, min: 0 },

    // ── Life ───────────────────────────────────────────────────────────────
    status: { type: String, enum: SESSION_STATUSES, default: SESSION_STATUS.OPEN, required: true },
    openedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
      name: { type: String, trim: true, default: "" },
    },
    openedAt: { type: Date, default: Date.now },

    /* Set when the receipt was recorded. The GRN is the authority on what was
       received; this is the back-reference, so a label activated by that
       receipt can be traced to the count it came from. */
    finalizedAt: { type: Date, default: null },
    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
    goodsReceiptNumber: { type: String, trim: true, default: "" },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

/* ── ONE OPEN COUNT PER LINE ────────────────────────────────────────────────
   Partial and unique: a line may have many finished sessions in its history
   (a part receipt today, another next week) but never two open at once. This
   is what makes `sequenceHigh` the single counter for the line, and what stops
   two receivers starting independent counts of one delivery.

   Built by `scripts/migrations/receiving-session-indexes.js` rather than
   lazily, for the reason spelled out on Barcode.companyId: a lazy index build
   takes collection locks that the goods-receipt transaction then cannot
   acquire, and the failure it produces names neither indexes nor transactions. */
/* ── THE INDEXES ARE BUILT BY A MIGRATION, NOT DECLARED HERE ───────────────
   `{companyId, poItemId}` unique-and-partial-on-OPEN is what makes
   `sequenceHigh` the SINGLE counter for a line: two receivers cannot start
   independent counts of one pallet each numbering from 1. `{companyId,
   purchaseOrderId, status}` is the receiving screen's own read.

   Both live in `scripts/migrations/receiving-session-indexes.js`. This
   collection is written inside the goods-receipt transaction (the activation
   at finalisation), and a lazily-built index landing inside that transaction
   takes collection locks it cannot then acquire — the hazard documented on
   `Barcode.companyId` and diagnosed twice already. */

module.exports = mongoose.models.GoodsReceiptSession
  || mongoose.model("GoodsReceiptSession", goodsReceiptSessionSchema);

module.exports.SESSION_STATUS = SESSION_STATUS;
module.exports.SESSION_STATUSES = SESSION_STATUSES;
module.exports.RECEIVING_MODE = RECEIVING_MODE;
module.exports.RECEIVING_MODES = RECEIVING_MODES;
module.exports.TRACKING_LEVEL = TRACKING_LEVEL;
module.exports.TRACKING_LEVELS = TRACKING_LEVELS;
