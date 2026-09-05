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

// e.g. Button → fromUnit "Piece", toUnit "Kilogram", quantity 0.4  → 1 pc = 0.4 KG
const unitConversionSchema = new mongoose.Schema(
  {
    fromUnit: { type: String, trim: true, default: "" },
    toUnit:   { type: String, trim: true, default: "" },
    quantity: { type: Number, default: 0, min: 0 }
  },
  { _id: false }
);

// ── Per-variant vendor alias ───────────────────────────────────────────────
const variantVendorNicknameSchema = new mongoose.Schema(
  {
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: true
    },
    nickname:     { type: String, required: true, trim: true },  // vendor's code/name for this variant
    price:        { type: Number, default: 0, min: 0 },          // vendor's price for this variant
    deliveryDays: { type: Number, default: 0, min: 0 },          // delivery timeline in days
    notes:          { type: String, default: "", trim: true },
    specifications: [{ key: { type: String, default: "" }, value: { type: String, default: "" } }]
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
  unitConversion:  { type: unitConversionSchema, default: null },   // legacy — kept for backward compat
  unitConversions: [unitConversionSchema],

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

    /* ── THE VARIANT'S OWN BEFORE AND AFTER ──────────────────────────────────
       Written whenever a movement targets a specific variant, so the variant's
       balance has the same continuous audit chain the item-level balance has.
       They were being stored without ever being declared: the stock movements
       are written as aggregation-pipeline updates, which bypass Mongoose's
       casting and validation entirely, so the fields reached the database
       regardless of what this schema said and were invisible to anything
       reading through the model. Null on a movement that touched no variant —
       distinct from 0, which would claim the variant was emptied. */
    variantPreviousQuantity: { type: Number, default: null },
    variantNewQuantity:      { type: Number, default: null },

    reason:          { type: String, default: "" },
    supplier:        { type: String, default: "" },
    supplierId:      { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    unitPrice:       { type: Number, default: 0 },
    purchaseOrder:   { type: String, default: "" },
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    invoiceNumber:   { type: String, default: "" },
    notes:           { type: String, default: "" },

    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },

    /* ── WHICH OPERATION MOVED THIS STOCK ────────────────────────────────────
       The `_id` of the Store & Purchase idempotency record whose action wrote
       this line. It is what lets a retry ask "did MY attempt already move
       stock?" and get an answer that cannot be confused with an earlier,
       identical-looking movement of the same item for the same quantity.
       Null on everything written before, and on movements from routes that are
       not yet governed. */
    operationId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    /* ── WHERE IN THE WAREHOUSE THIS MOVEMENT LANDED / LEFT (Warehouse Stock V1)
       A snapshot of the warehouse/location the paired LocationMovement records,
       so Stock movements can show the real location without a fragile join.
       Absent on legacy movements and on operations not yet location-aware —
       those read as "Unassigned", never guessed onto a warehouse. */
    warehouseId:   { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", default: null },
    locationId:    { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseName: { type: String, default: "" },
    locationCode:  { type: String, default: "" },
    locationName:  { type: String, default: "" },

    /* Mongoose's `timestamps` option does not run for an update written as an
       aggregation pipeline, and the stock movements are written that way so
       they can be atomic. The route sets these explicitly; declaring them here
       is what stops a ledger line from silently carrying none. */
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
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
    /* Not `unique` here any more: uniqueness is company-scoped, declared as a
       compound index below. Mongoose never DROPS an index it stops declaring,
       so the legacy global `sku_1` survives on running deployments and must be
       retired deliberately — see
       scripts/migrations/store-purchase-catalogue-indexes.js. */
    sku:  { type: String, required: true, trim: true },

    category:       { type: String, default: "" },

    /* ── THIS ITEM'S OWN BUDGET HEAD, WHERE IT DIFFERS FROM ITS CATEGORY ───
       Normally empty. The head comes from the item's CATEGORY (see
       Acc_ItemCategoryBudget) because mapping 15 categories is a meeting and
       mapping every item is a project nobody finishes.

       Set only where an item genuinely does not belong with its siblings —
       a fabric bought for sampling rather than production, say. An empty
       value is not "unknown", it is "whatever my category says", which is
       what keeps this field rare and therefore trustworthy. */
    budgetLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger", default: null },
    /* Display snapshot, never the authority — the id is. Held so a resolver
       can name the head without a join per item, and deliberately allowed to
       go stale: a head renamed next year must not silently restate what this
       override was set to. */
    budgetLedgerName: { type: String, trim: true, default: "" },
    budgetLedgerSetBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User", default: null },
    budgetLedgerSetByName: { type: String, trim: true, default: "" },
    budgetLedgerSetAt: { type: Date, default: null },
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
/* ── TENANT OWNERSHIP ────────────────────────────────────────────────────────
   The catalogue is company data: an item's code, its suppliers and its balance
   all belong to one set of books. Optional for the same reason every other
   Store & Purchase model's is — records that predate the boundary carry none,
   and they are legacy-global, excluded from ordinary reads rather than adopted
   by whichever company asks first. */
rawItemSchema.add({
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Acc_Company",
    default: null,
    index: true,
  },
  siteId: { type: mongoose.Schema.Types.ObjectId, default: null },
});

/* One item code per company. Two companies may both stock "RAW-FAB-CTN-001";
   within a company the code is the item's identity. */
rawItemSchema.index({ companyId: 1, sku: 1 }, { unique: true });
rawItemSchema.index({ companyId: 1, name: 1 });
rawItemSchema.index({ companyId: 1, category: 1 });
rawItemSchema.index({ name: 1 });
rawItemSchema.index({ category: 1 });
rawItemSchema.index({ "variants.vendorNicknames.vendor": 1 });

module.exports =
  mongoose.models.RawItem || mongoose.model("RawItem", rawItemSchema);