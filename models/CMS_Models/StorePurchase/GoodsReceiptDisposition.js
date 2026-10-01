// models/CMS_Models/StorePurchase/GoodsReceiptDisposition.js
//
// GOODS RECEIPT DISPOSITION (V1) — an immutable record of ONE decision taken on
// quarantined stock after inspection:
//   RELEASE  QUARANTINE → RECEIVING  (becomes accepted stock awaiting put-away)
//   REJECT   QUARANTINE → RETURNS    (becomes rejected stock awaiting supplier return)
//
// It NEVER edits the original GoodsReceipt or the original GoodsReceiptInspection
// (both stay immutable) and NEVER creates a second stock authority: the move is a
// two-leg internal transfer through the SAME LocationBalance / LocationMovement
// machinery, and company-wide on-hand (RawItem) is untouched — only WHERE stock
// sits changes. Partial and repeated dispositions are allowed, but their sum can
// never exceed the line's quarantined quantity (guarded atomically per line).

"use strict";

const mongoose = require("mongoose");

const DISPOSITION_TYPES = Object.freeze(["RELEASE", "REJECT"]);

const goodsReceiptDispositionSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── What it resolves (immutable provenance) ──
    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceipt", required: true },
    inspectionId: { type: mongoose.Schema.Types.ObjectId, ref: "GoodsReceiptInspection", required: true },
    receiptNumber: { type: String, trim: true, default: "" },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, required: true },
    poItemId: { type: mongoose.Schema.Types.ObjectId, default: null },   // the PO line id

    // ── Item / variant identity + snapshot ──
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },

    // ── The decision ──
    dispositionType: { type: String, enum: DISPOSITION_TYPES, required: true },

    // Quantity in the inspection line's own received unit, plus frozen base-unit
    // conversion evidence used for the location move (never recomputed later).
    quantity: { type: Number, required: true, min: 0 },
    unit: { type: String, trim: true, default: "" },
    baseQuantity: { type: Number, min: 0, default: 0 },
    baseUnit: { type: String, trim: true, default: "" },
    conversionFactor: { type: Number, default: 1 },

    // ── Source (always Quarantine) and destination (Receiving | Returns) ──
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    fromLocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    fromLocationCode: { type: String, trim: true, default: "" },
    fromLocationName: { type: String, trim: true, default: "" },
    toLocationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    toLocationCode: { type: String, trim: true, default: "" },
    toLocationName: { type: String, trim: true, default: "" },

    // ── The two internal movement legs this disposition created ──
    transferId: { type: mongoose.Schema.Types.ObjectId, default: null },
    movementOutId: { type: mongoose.Schema.Types.ObjectId, default: null },
    movementInId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Why (mandatory) + optional evidence ──
    reason: { type: String, trim: true, required: true },
    note: { type: String, trim: true, default: "" },
    evidenceRef: { type: String, trim: true, default: "" },

    actor: { id: { type: mongoose.Schema.Types.ObjectId, default: null }, name: { type: String, trim: true, default: "" } },
    at: { type: Date, default: Date.now },
    idempotencyKey: { type: String, trim: true, default: "" },
  },
  { timestamps: true },
);

goodsReceiptDispositionSchema.index({ companyId: 1, goodsReceiptId: 1, createdAt: -1 });
goodsReceiptDispositionSchema.index({ companyId: 1, goodsReceiptLineId: 1 });

module.exports = mongoose.models.GoodsReceiptDisposition
  || mongoose.model("GoodsReceiptDisposition", goodsReceiptDispositionSchema);
module.exports.DISPOSITION_TYPES = DISPOSITION_TYPES;
