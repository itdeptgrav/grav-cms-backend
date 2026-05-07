// models/CMS_Models/Inventory/Operations/Barcode.js
//
// Each document represents ONE printed barcode/QR sticker against a raw-item
// variant. The MongoDB _id of this document is what gets encoded in the QR code.
//
// `cuttingSessions` tracks each cutting session against this fabric roll.
// A session is open while closedAt is null; once closed, endQty is set and
// the parent `quantity` is updated to that endQty (so the next session's
// startQty picks up where this one left off).

const mongoose = require("mongoose");

// ── Cutting session sub-doc ─────────────────────────────────────────────────
// Lean — only what's needed to log what happened during one cutting run.
const cuttingSessionSchema = new mongoose.Schema(
  {
    startQty: { type: Number, required: true, min: 0 },
    endQty:   { type: Number, default: null,    min: 0 },

    // Each scanned piece barcode (e.g. "WO-69abc123-001") as a plain string
    scannedPieces: [{ type: String, trim: true }],

    startedAt: { type: Date, default: Date.now },
    closedAt:  { type: Date, default: null },
  },
  { _id: true }
);

const barcodeSchema = new mongoose.Schema(
  {
    // ── What this barcode represents ─────────────────────────────────────────
    rawItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
      required: true,
      index: true,
    },
    rawItemName: { type: String, trim: true, default: "" },
    rawItemSku:  { type: String, trim: true, default: "" },

    // Variant reference (a raw item may have multiple variants)
    variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    variantSku:         { type: String, trim: true, default: "" },

    // ── Printed quantity ─────────────────────────────────────────────────────
    quantity: { type: Number, required: true, min: 0 },
    unit:     { type: String, required: true, trim: true },

    // ── Optional PO link (nullable) ──────────────────────────────────────────
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      default: null,
      index: true,
    },
    purchaseOrderNumber: { type: String, trim: true, default: "" },

    // ── Audit ────────────────────────────────────────────────────────────────
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },

    // ── Cutting sessions ─────────────────────────────────────────────────────
    cuttingSessions: [cuttingSessionSchema],
  },
  { timestamps: true }
);

barcodeSchema.index({ rawItem: 1, variantId: 1, createdAt: -1 });

module.exports =
  mongoose.models.Barcode || mongoose.model("Barcode", barcodeSchema);