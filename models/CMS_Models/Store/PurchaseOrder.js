// models/CMS_Models/Store/PurchaseOrder.js
//
// Purchase Order — a document recording what we PURCHASED and why.
// Mirrors the Work Order engine (items, GST, totals, dynamic columns) but:
//   - party is a VENDOR/SUPPLIER (not a worker)
//   - carries a free-text "Reason for Purchase" (why we bought it)
//   - status workflow is Draft → Ordered → Received
//   - its own PO- number sequence (separate counter)
//
// Like the WO, almost everything is OPTIONAL except poNumber (auto-generated,
// editable, unique) — the workflow, list, and PDF filename depend on it.

const mongoose = require("mongoose");

// ── A single line item ─────────────────────────────────────────────────────
const purchaseOrderItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, trim: true, default: "" },
    description: { type: String, trim: true, default: "" },
    itemSize: { type: String, trim: true, default: "" },
    hsnCode: { type: String, trim: true, default: "" },
    quantity: { type: Number, default: 0 },
    unit: { type: String, trim: true, default: "Pieces" },
    unitPrice: { type: Number, default: 0 },
    gstPercentage: { type: Number, default: 0 },

    priceBeforeGST: { type: Number, default: 0 },
    gstAmount: { type: Number, default: 0 },
    priceIncludingGST: { type: Number, default: 0 },

    customFields: [
      {
        name: { type: String, trim: true, default: "" },
        value: { type: String, trim: true, default: "" },
        _id: false,
      },
    ],
  },
  { _id: false },
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    // ── Identity ──
    poNumber: {
      type: String,
      trim: true,
      required: true,
      unique: true,
      index: true,
    },

    // ── Vendor / Supplier (who we bought FROM) ──
    vendorName: { type: String, trim: true, default: "" },
    vendorPhone: { type: String, trim: true, default: "" },
    vendorAddress: { type: String, trim: true, default: "" },
    vendorGstin: { type: String, trim: true, default: "" },

    // Why we purchased (free text) — the key PO-specific context.
    reasonForPurchase: { type: String, trim: true, default: "" },

    // Editable label for the line section (e.g. "Items", "Materials").
    lineSectionLabel: { type: String, trim: true, default: "Items" },

    // ── Line items ──
    items: [purchaseOrderItemSchema],

    // ── Custom header-level fields ──
    customHeaderFields: [
      {
        name: { type: String, trim: true, default: "" },
        value: { type: String, trim: true, default: "" },
        _id: false,
      },
    ],

    // ── Totals ──
    subtotalBeforeGST: { type: Number, default: 0 },
    totalGST: { type: Number, default: 0 },
    grandTotal: { type: Number, default: 0 },

    // ── Status workflow (PO-specific) ──
    status: {
      type: String,
      enum: ["Draft", "Ordered", "Received"],
      default: "Draft",
      index: true,
    },

    // ── Priority (shown on PDF) ──
    priority: {
      type: String,
      enum: ["Emergency", "Urgent", "Neutral"],
      default: "Neutral",
    },

    // Dates
    poDate: { type: Date, default: null }, // when the PO was placed
    expectedDate: { type: Date, default: null }, // expected delivery/receipt
    receivedDate: { type: Date, default: null }, // stamped when marked Received

    // ── Audit ──
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
  },
  { timestamps: true },
);

purchaseOrderSchema.pre("save", function (next) {
  let subtotal = 0;
  let totalGst = 0;

  (this.items || []).forEach((item) => {
    const qty = Number(item.quantity) || 0;
    const price = Number(item.unitPrice) || 0;
    let gstP = Number(item.gstPercentage) || 0;
    if (gstP < 0) gstP = 0;
    if (gstP > 100) gstP = 100;
    item.gstPercentage = gstP;

    const base = qty * price;
    const gst = base * (gstP / 100);

    item.priceBeforeGST = base;
    item.gstAmount = gst;
    item.priceIncludingGST = base + gst;

    subtotal += base;
    totalGst += gst;
  });

  this.subtotalBeforeGST = subtotal;
  this.totalGST = totalGst;
  this.grandTotal = subtotal + totalGst;

  next();
});

purchaseOrderSchema.index({ status: 1, createdAt: -1 });
purchaseOrderSchema.index({ vendorName: 1 });

module.exports = mongoose.model("StorePurchaseOrder", purchaseOrderSchema);
