// models/CMS_Models/Inventory/Products/RawItem.js
//
// Refactored model. Changes vs prior version:
//   1. REMOVED: item-level `vendorNicknames` array
//   2. ADDED:   `variant.image` (Cloudinary URL string — frontend uploads directly)
//   3. ADDED:   `variant.vendorNicknames[]` (per-variant aliases)
//
// Everything else (stockTransactions, primaryVendor, alternateVendors,
// discounts, attributes, etc.) is preserved.
//
// NOTE: If your previous model had additional custom fields not shown here,
// merge them in. This file matches what the routes file expects.

const mongoose = require("mongoose");

// ── Per-variant vendor nickname ────────────────────────────────────────────
const variantVendorNicknameSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true
    },
    nickname: { type: String, required: true, trim: true },
    notes:    { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

// ── Variant ────────────────────────────────────────────────────────────────
const variantSchema = new mongoose.Schema({
  combination: [{ type: String }],
  quantity:    { type: Number, default: 0, min: 0 },
  minStock:    { type: Number, default: 0 },
  maxStock:    { type: Number, default: 0 },
  sku:         { type: String, default: "" },

  // ── NEW: per-variant fields ──
  image:           { type: String, default: "" },          // Cloudinary URL
  vendorNicknames: [variantVendorNicknameSchema],          // per-variant aliases

  status: { type: String, default: "In Stock" }
});

// ── Stock transaction (embedded) ───────────────────────────────────────────
const stockTransactionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["ADD", "REDUCE", "PURCHASE_ORDER", "VARIANT_ADD", "VARIANT_REDUCE", "CONSUME"],
      required: true
    },
    quantity:           { type: Number, required: true },
    variantCombination: [{ type: String }],
    variantId:          { type: mongoose.Schema.Types.ObjectId },

    previousQuantity: { type: Number, default: 0 },
    newQuantity:      { type: Number, default: 0 },

    reason:          { type: String, default: "" },
    supplier:        { type: String, default: "" },
    supplierId:      { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    unitPrice:       { type: Number, default: 0 },
    purchaseOrder:   { type: String, default: "" },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    invoiceNumber:   { type: String, default: "" },
    notes:           { type: String, default: "" },

    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" }
  },
  { timestamps: true }
);

// ── Discount ───────────────────────────────────────────────────────────────
const discountSchema = new mongoose.Schema({
  minQuantity: { type: Number, required: true, min: 0 },
  price:       { type: Number, required: true, min: 0 }
});

// ── Attribute ──────────────────────────────────────────────────────────────
const attributeSchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true },
  values: [{ type: String, trim: true }]
});

// ── Helper: derive status from qty vs minStock ──
const deriveStatus = (qty, minStock) => {
  const q = Number(qty) || 0;
  const m = Number(minStock) || 0;
  if (q <= 0) return "Out of Stock";
  if (q <= m) return "Low Stock";
  return "In Stock";
};

// ── Main RawItem ───────────────────────────────────────────────────────────
const rawItemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    sku:  { type: String, required: true, unique: true, trim: true },

    category:       { type: String, default: "" },
    customCategory: { type: String, default: "" },

    unit:       { type: String, default: "" },
    customUnit: { type: String, default: "" },

    quantity: { type: Number, default: 0, min: 0 },
    minStock: { type: Number, default: 0 },
    maxStock: { type: Number, default: 0 },

    description: { type: String, default: "" },
    notes:       { type: String, default: "" },

    status: { type: String, default: "In Stock" },

    attributes: [attributeSchema],
    variants:   [variantSchema],
    discounts:  [discountSchema],

    stockTransactions: [stockTransactionSchema],

    primaryVendor:    { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    alternateVendors: [{ type: mongoose.Schema.Types.ObjectId, ref: "Vendor" }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" }
  },
  { timestamps: true }
);

// Auto-derive item-level + variant statuses on save
rawItemSchema.pre("save", function (next) {
  this.status = deriveStatus(this.quantity, this.minStock);

  if (Array.isArray(this.variants)) {
    this.variants.forEach(v => {
      v.status = deriveStatus(v.quantity, v.minStock ?? this.minStock);
    });
  }

  next();
});

rawItemSchema.statics.deriveStatus = deriveStatus;

// Indexes
rawItemSchema.index({ name: 1 });
rawItemSchema.index({ category: 1 });
rawItemSchema.index({ "variants.vendorNicknames.vendor": 1 });

module.exports =
  mongoose.models.RawItem || mongoose.model("RawItem", rawItemSchema);