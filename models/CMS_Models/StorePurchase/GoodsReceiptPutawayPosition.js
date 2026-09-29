// models/CMS_Models/StorePurchase/GoodsReceiptPutawayPosition.js
//
// PUT-AWAY / QUARANTINE POSITION (V1) — a small, per-receipt-line operational
// projection used ONLY to make concurrent writes safe. It holds, in the line's
// own received unit:
//   accepted           put-away capacity  = inspection.accepted + Σ quarantine RELEASE
//   posted             Σ put-aways so far
//   quarantined        the line's quarantined quantity at inspection
//   quarantineResolved Σ dispositions (RELEASE + REJECT) so far
//   rejected           inspection.rejected + Σ REJECT dispositions (returnable pool)
//   returned           Σ supplier returns so far
// A single atomic guarded increment refuses a put-away that would push `posted`
// past `accepted`, a disposition that would push `quarantineResolved` past
// `quarantined`, and a supplier return that would push `returned` past `rejected`.
// Releasing raises `accepted`, rejecting raises `rejected`, in the SAME atomic
// increment — so the released quantity becomes put-away capacity and the rejected
// quantity becomes returnable.
//
// It is NOT a stock authority. It is fully rebuildable/reconcilable from the
// immutable GoodsReceiptInspection, GoodsReceiptDisposition and GoodsReceiptPutaway
// records. Quantities are in the line's own received unit.

"use strict";

const mongoose = require("mongoose");

const goodsReceiptPutawayPositionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceipt", required: true },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    inspectionId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceiptInspection", default: null },

    unit: { type: String, trim: true, default: "" },
    accepted: { type: Number, required: true, min: 0 },   // inspection.accepted + Σ RELEASE
    posted: { type: Number, required: true, min: 0, default: 0 }, // Σ put-aways so far
    quarantined: { type: Number, required: true, min: 0, default: 0 },        // inspection.quarantined
    quarantineResolved: { type: Number, required: true, min: 0, default: 0 }, // Σ dispositions so far
    rejected: { type: Number, required: true, min: 0, default: 0 },           // inspection.rejected + Σ REJECT dispositions
    returned: { type: Number, required: true, min: 0, default: 0 },           // Σ supplier returns so far
  },
  { timestamps: true },
);

// One position per receipt line — the atomic guard target.
goodsReceiptPutawayPositionSchema.index({ companyId: 1, goodsReceiptLineId: 1 }, { unique: true });
goodsReceiptPutawayPositionSchema.index({ companyId: 1, goodsReceiptId: 1 });

module.exports = mongoose.models.GoodsReceiptPutawayPosition
  || mongoose.model("GoodsReceiptPutawayPosition", goodsReceiptPutawayPositionSchema);
