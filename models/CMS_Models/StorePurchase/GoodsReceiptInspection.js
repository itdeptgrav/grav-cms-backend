// models/CMS_Models/StorePurchase/GoodsReceiptInspection.js
//
// GOODS RECEIPT INSPECTION (V1) — the single, immutable inspection decision for
// one GoodsReceipt. It classifies each received line into accepted / quarantined
// / rejected quantities (in that line's own received unit, summing exactly to
// the received quantity) and records the location movements the quarantined and
// rejected quantities caused. It NEVER changes company-wide on-hand — it only
// decides where already-received stock belongs.
//
// Immutable in V1: one inspection per receipt, no edit, no reversal.

"use strict";

const mongoose = require("mongoose");

const inspectionLineSchema = new mongoose.Schema(
  {
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    poItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },

    // The line's own received unit — the three decisions are in THIS unit and
    // add exactly to receivedQuantity. Never combined with another line's unit.
    unit: { type: String, trim: true, default: "" },
    receivedQuantity: { type: Number, required: true, min: 0 },
    acceptedQuantity: { type: Number, required: true, min: 0 },
    quarantinedQuantity: { type: Number, required: true, min: 0 },
    rejectedQuantity: { type: Number, required: true, min: 0 },
    note: { type: String, trim: true, default: "" },

    // Base-unit conversion evidence used for the location moves.
    baseUnit: { type: String, trim: true, default: "" },
    conversionFactor: { type: Number, default: 1 },

    // The internal location movements this line's inspection created (linked,
    // not recomputed). Accepted stock does not move at inspection.
    quarantineMovementOutId: { type: mongoose.Schema.Types.ObjectId, default: null },
    quarantineMovementInId: { type: mongoose.Schema.Types.ObjectId, default: null },
    returnsMovementOutId: { type: mongoose.Schema.Types.ObjectId, default: null },
    returnsMovementInId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: true },
);

const goodsReceiptInspectionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceipt", required: true },
    receiptNumber: { type: String, trim: true, default: "" },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },

    // The warehouse and the Receiving location the goods were inspected from.
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseName: { type: String, trim: true, default: "" },
    receivingLocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    receivingLocationCode: { type: String, trim: true, default: "" },

    inspectedAt: { type: Date, default: Date.now },
    inspectedBy: { id: { type: mongoose.Schema.Types.ObjectId, default: null }, name: { type: String, trim: true, default: "" } },
    note: { type: String, trim: true, default: "" },

    idempotencyKey: { type: String, trim: true, default: "" },
    lines: { type: [inspectionLineSchema], default: [] },
  },
  { timestamps: true },
);

// One inspection per receipt in V1.
goodsReceiptInspectionSchema.index({ companyId: 1, goodsReceiptId: 1 }, { unique: true });
goodsReceiptInspectionSchema.index({ companyId: 1, purchaseOrderId: 1 });

module.exports = mongoose.models.GoodsReceiptInspection
  || mongoose.model("GoodsReceiptInspection", goodsReceiptInspectionSchema);
