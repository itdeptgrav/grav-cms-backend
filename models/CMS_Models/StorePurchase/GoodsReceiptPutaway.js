// models/CMS_Models/StorePurchase/GoodsReceiptPutaway.js
//
// GOODS RECEIPT PUT-AWAY (V1) — an immutable record of moving ACCEPTED stock
// from the Receiving location to a Usable Stock location. More than one per
// accepted line is allowed (accepted stock can be split across bins); "remaining
// to put away" is DERIVED from accepted quantity minus recorded put-aways, never
// stored as a mutable total. Put-away changes location only — never company-wide
// on-hand.

"use strict";

const mongoose = require("mongoose");

const goodsReceiptPutawaySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceipt", required: true },
    inspectionId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceiptInspection", default: null },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    receiptNumber: { type: String, trim: true, default: "" },

    poItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },

    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Source Receiving location and destination Usable Stock location.
    fromLocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    fromLocationCode: { type: String, trim: true, default: "" },
    toLocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    toLocationCode: { type: String, trim: true, default: "" },
    toLocationName: { type: String, trim: true, default: "" },

    // Quantity in the line's received unit, plus the base-unit move evidence.
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, default: "" },
    baseQuantity: { type: Number, min: 0, default: 0 },
    baseUnit: { type: String, trim: true, default: "" },

    // The transfer identity and its two movement legs.
    transferId: { type: mongoose.Schema.Types.ObjectId, default: null },
    movementOutId: { type: mongoose.Schema.Types.ObjectId, default: null },
    movementInId: { type: mongoose.Schema.Types.ObjectId, default: null },

    actor: { id: { type: mongoose.Schema.Types.ObjectId, default: null }, name: { type: String, trim: true, default: "" } },
    at: { type: Date, default: Date.now },
    note: { type: String, trim: true, default: "" },
    idempotencyKey: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

goodsReceiptPutawaySchema.index({ companyId: 1, goodsReceiptId: 1, createdAt: -1 });
goodsReceiptPutawaySchema.index({ companyId: 1, goodsReceiptLineId: 1 });

module.exports = mongoose.models.GoodsReceiptPutaway
  || mongoose.model("GoodsReceiptPutaway", goodsReceiptPutawaySchema);
