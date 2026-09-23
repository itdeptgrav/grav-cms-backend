// models/CMS_Models/StorePurchase/GoodsReceipt.js
//
// GOODS RECEIPT (GRN) — the authoritative, line-level record of what physically
// arrived against a Purchase Order. V1 proves RECEIPT ONLY: it records that a
// quantity was received, in a unit, at a location, against a supplier reference.
// It does NOT claim inspection, acceptance, quarantine or put-away — those are
// deliberately later chunks. Never call a received quantity "accepted".
//
// Every line joins its PO line by the STORED `poItemId` (never by name, amount
// or array position), carries its own conversion evidence and the stock/location
// movement identifiers this receipt created, and is immutable once written.

"use strict";

const mongoose = require("mongoose");

// One received PO line. Immutable: a correction is a new document, never an edit.
const goodsReceiptLineSchema = new mongoose.Schema(
  {
    // ── Stored-id join back to the PO line (the reliable key) ──
    poItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    spendLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Item / variant identity + snapshots (so the line reads without a join) ──
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },
    variantSku: { type: String, trim: true, default: "" },

    // ── How much arrived, in the PO unit, plus the canonical/base evidence ──
    poUnit: { type: String, trim: true, default: "" },
    receivedQuantity: { type: Number, required: true, min: 0 },     // in poUnit
    baseUnit: { type: String, trim: true, default: "" },            // RawItem registered unit
    baseQuantity: { type: Number, min: 0, default: 0 },             // received in baseUnit
    conversionFactor: { type: Number, default: 1 },                 // baseQuantity / receivedQuantity
    conversionNote: { type: String, trim: true, default: "" },      // human evidence

    // ── Before/after snapshots, so the line is self-explaining ──
    quantityOrdered: { type: Number, min: 0, default: 0 },
    previouslyReceived: { type: Number, min: 0, default: 0 },       // before this receipt
    receivedAfter: { type: Number, min: 0, default: 0 },            // PO line received after
    pendingAfter: { type: Number, min: 0, default: 0 },             // PO line pending after

    // ── The stock/location movements this line created (linked, not recomputed) ──
    stockLedgerRef: {
      rawItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
      transactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    locationMovementId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: true },
);

const goodsReceiptSchema = new mongoose.Schema(
  {
    // Company-owned (unlike the legacy StockItem catalogue).
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Immutable GRN number, allocated through the GOODS_RECEIPT document sequence.
    receiptNumber: { type: String, required: true, trim: true, immutable: true },

    // ── The order this receipt discharges ──
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", required: true, index: true },
    poNumber: { type: String, trim: true, default: "" },

    // ── Supplier snapshot ──
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    supplierName: { type: String, trim: true, default: "" },

    // ── Where it was received (identity + snapshot) ──
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseName: { type: String, trim: true, default: "" },
    locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationCode: { type: String, trim: true, default: "" },
    locationName: { type: String, trim: true, default: "" },

    // ── Supplier invoice / challan reference and the date claimed ──
    invoiceNumber: { type: String, trim: true, default: "" },
    receiptDate: { type: Date, default: Date.now },
    notes: { type: String, trim: true, default: "" },

    // ── V1 lifecycle. RECORDED means "receipt captured", NOT accepted/inspected.
    status: { type: String, enum: ["RECORDED", "VOID"], default: "RECORDED" },

    // ── Who recorded it ──
    recordedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
    },

    // ── The idempotency key of the operation that created it (replay safety) ──
    idempotencyKey: { type: String, trim: true, default: "" },

    lines: { type: [goodsReceiptLineSchema], default: [] },
  },
  { timestamps: true },
);

// Company-scoped uniqueness for the number; company-scoped lookups by PO,
// supplier and date for the register.
goodsReceiptSchema.index({ companyId: 1, receiptNumber: 1 }, { unique: true });
goodsReceiptSchema.index({ companyId: 1, purchaseOrderId: 1, createdAt: -1 });
goodsReceiptSchema.index({ companyId: 1, supplierId: 1, receiptDate: -1 });
goodsReceiptSchema.index({ companyId: 1, receiptDate: -1 });

module.exports = mongoose.models.GoodsReceipt || mongoose.model("GoodsReceipt", goodsReceiptSchema);
