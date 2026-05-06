// models/CMS_Models/Inventory/Operations/Barcode.js
//
// Each document represents ONE printed barcode/QR sticker against a raw-item
// variant. The MongoDB _id of this document is what gets encoded in the QR code.
//
// Lean by design — only stores what's needed to identify what was printed
// and trace it back later. No status/history bloat.

const mongoose = require("mongoose");

const barcodeSchema = new mongoose.Schema(
  {
    // ── What this barcode represents ─────────────────────────────────────────
    rawItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
      required: true,
      index: true
    },
    rawItemName: { type: String, trim: true, default: "" },
    rawItemSku:  { type: String, trim: true, default: "" },

    // Variant reference (a raw item may have multiple variants)
    variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    variantSku:         { type: String, trim: true, default: "" },

    // ── Printed quantity ─────────────────────────────────────────────────────
    quantity: { type: Number, required: true, min: 0 },
    unit:     { type: String, required: true, trim: true },  // unit name (e.g. "Meter")

    // ── Optional PO link (nullable) ──────────────────────────────────────────
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      default: null,
      index: true
    },
    purchaseOrderNumber: { type: String, trim: true, default: "" },

    // ── Audit ────────────────────────────────────────────────────────────────
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null }
  },
  { timestamps: true }
);

// Useful compound index for "show me all barcodes for this variant"
barcodeSchema.index({ rawItem: 1, variantId: 1, createdAt: -1 });

module.exports =
  mongoose.models.Barcode || mongoose.model("Barcode", barcodeSchema);