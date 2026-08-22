// models/CMS_Models/Inventory/Operations/Barcode.js
//
// Each document represents ONE printed barcode/QR sticker against a raw-item
// variant. The MongoDB _id of this document is what gets encoded in the QR code.
//
// Stickers are produced in two places, and both write the same shape:
//   · Product Marking (store/operations/barcode-generator) — ad-hoc labelling
//   · Goods receipt   (purchase-order/:id/receive)         — labelling a delivery
// The receive path additionally records where the lot came from and what it
// cost (vendor, purchaseOrderItemId, unitPrice), which is what makes a scan
// able to answer "when did this arrive, from whom, at what price".
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

    // Which PO line the stock came in against. A PO can carry the same raw item
    // on more than one line at different prices, so the line is what pins the
    // price below to a specific purchase — the PO id alone would not.
    purchaseOrderItemId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Where it came from and what it cost ──────────────────────────────────
    // Captured when the sticker is printed at goods-receipt, and deliberately
    // stored rather than looked up later: the vendor's price on a raw item
    // changes over time, so a scan months from now must report what THIS lot
    // actually cost, not today's rate.
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
      index: true,
    },
    // Denormalised for the same reason rawItemName and purchaseOrderNumber are:
    // a scan renders the label's own facts without joining three collections.
    vendorName: { type: String, trim: true, default: "" },

    // Per-unit purchase price from the PO line, in rupees.
    unitPrice: { type: Number, default: null, min: 0 },

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