// models/CMS_Models/Inventory/Products/StockItem.js

const mongoose = require("mongoose");

const attributeValueSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  value: {
    type: String,
    required: true,
    trim: true
  }
}, { _id: false });

const variantRawItemSchema = new mongoose.Schema({
  rawItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "RawItem",
    required: true
  },
  rawItemName: {
    type: String,
    required: true,
    trim: true
  },
  rawItemSku: {
    type: String,
    trim: true
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId
  },
  variantCombination: [{
    type: String,
    trim: true
  }],
  // ── The qty actually needed per unit produced, before allowance ──
  requiredQuantity: {
    type: Number,
    min: 0
  },
  // ── Extra % added on top of requiredQuantity for wastage/buffer ──
  allowancePercent: {
    type: Number,
    default: 0,
    min: 0
  },
  // ── Effective qty consumed: requiredQuantity * (1 + allowancePercent/100) ──
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  // ── The unit the user chose (may be a converted unit, e.g. "Piece" instead of "Gross") ──
  unit: {
    type: String,
    required: true,
    trim: true
  },
  // ── The base/registered unit of the raw item, stored for deduction logic ──
  baseUnit: {
    type: String,
    trim: true
  },
  unitCost: {
    type: Number,
    required: true,
    min: 0
  },
  totalCost: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const variantSchema = new mongoose.Schema({
  sku: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  attributes: [attributeValueSchema],
  quantityOnHand: {
    type: Number,
    required: true,
    min: 0,
    default: 0
  },
  minStock: {
    type: Number,
    required: true,
    min: 0,
    default: 10
  },
  maxStock: {
    type: Number,
    required: true,
    min: 0,
    default: 100
  },
  cost: {
    type: Number,
    required: true,
    min: 0
  },
  salesPrice: {
    type: Number,
    required: true,
    min: 0
  },
  barcode: {
    type: String,
    trim: true
  },
  images: [String],
  rawItems: [variantRawItemSchema],
  status: {
    type: String,
    enum: ["In Stock", "Low Stock", "Out of Stock"],
    default: "In Stock"
  }
}, { timestamps: true });

const operationSchema = new mongoose.Schema({
  type: {
    type: String,
    required: true,
    trim: true
  },
  operationCode: {
    type: String,
    trim: true,
    default: ""
  },
  machine: {
    type: String,
    trim: true
  },
  machineType: {
    type: String,
    trim: true
  },
  minutes: {
    type: Number,
    min: 0
  },
  seconds: {
    type: Number,
    min: 0,
    max: 59
  },
  totalSeconds: {
    type: Number,
    min: 0
  },
  operatorSalary: {
    type: Number,
    min: 0
  },
  operatorCost: {
    type: Number,
    min: 0
  },
  // ── Salary basis — department and designation used to derive operatorSalary ──
  salaryDept: {
    type: String,
    trim: true,
    default: ""
  },
  salaryDesig: {
    type: String,
    trim: true,
    default: ""
  }
}, { _id: false });

const stockItemSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    required: true,
    trim: true
  },

  // ── Additional / Alternate Names ─────────────────────────────────────────
  additionalNames: [{
    type: String,
    trim: true
  }],

  reference: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  productType: {
    type: String,
    enum: ["Goods", "Service", "Combo"],
    default: "Goods"
  },
  invoicingPolicy: {
    type: String,
    enum: ["Ordered quantities", "Delivered quantities"],
    default: "Ordered quantities"
  },
  trackInventory: {
    type: Boolean,
    default: true
  },

  // Category
  category: {
    type: String,
    required: true,
    trim: true
  },

  // ── Gender Category ───────────────────────────────────────────────────────
  // Indicates intended gender audience for the garment.
  genderCategory: {
    type: String,
    enum: ["Male", "Female", "Unisex", "Kids", ""],
    default: ""
  },

  // Barcode & HSN
  barcode: {
    type: String,
    trim: true
  },
  hsnCode: {
    type: String,
    trim: true
  },

  // Internal Information
  internalNotes: {
    type: String,
    trim: true
  },

  // General Pricing
  unit: {
    type: String,
    required: true,
    default: "Units"
  },
  baseSalesPrice: {
    type: Number,
    min: 0
  },
  /**
   * The most this product is allowed to COST to make, per piece — set by
   * Sales when the product is defined on the enquiry (2 Sept 2026, explicit
   * request), and carried here so the people actually building the costing
   * work against it.
   *
   * The Raw Items and Operations tabs refuse an addition that would push
   * raw-material + operations + miscellaneous cost past this, and show how
   * much of it is spent. A CEILING ON COST, not a price and not a target —
   * `baseSalesPrice`/`averageSalesPrice` are what it sells FOR.
   *
   * Unset (the default) means no cap at all: every restriction downstream is
   * gated on this being a real number, so products that predate this — and
   * products nobody set a budget for — behave exactly as they always did.
   */
  maxBudget: {
    type: Number,
    min: 0
  },
  salesTax: {
    type: String,
    trim: true
  },
  baseCost: {
    type: Number,
    min: 0
  },
  purchaseTax: {
    type: String,
    trim: true
  },

  // Attributes for variants
  attributes: [{
    name: {
      type: String,
      required: true,
      trim: true
    },
    values: [{
      type: String,
      trim: true
    }]
  }],

  measurements: [{
    type: String,
    trim: true
  }],

  numberOfPanels: {
    type: Number,
    min: 0,
    default: 0
  },

  // Variants
  variants: [variantSchema],

  // Operations
  operations: [operationSchema],

  // Miscellaneous costs
  miscellaneousCosts: [{
    name: {
      type: String,
      required: true,
      trim: true
    },
    amount: {
      type: Number,
      required: true,
      min: 0
    },
    unit: {
      type: String,
      enum: ["Fixed", "Percentage"],
      default: "Fixed"
    }
  }],

  // Images
  images: [String],

  // Overall Status
  status: {
    type: String,
    enum: ["In Stock", "Low Stock", "Out of Stock"],
    default: "In Stock"
  },

  // Calculated Fields
  totalQuantityOnHand: {
    type: Number,
    min: 0,
    default: 0
  },
  totalRawItemsCost: {
    type: Number,
    min: 0,
    default: 0
  },
  totalOperationsCost: {
    type: Number,
    min: 0,
    default: 0
  },
  totalMiscellaneousCost: {
    type: Number,
    min: 0,
    default: 0
  },
  averageCost: {
    type: Number,
    min: 0,
    default: 0
  },
  averageSalesPrice: {
    type: Number,
    min: 0,
    default: 0
  },
  profitMargin: {
    type: Number,
    default: 0
  },
  inventoryValue: {
    type: Number,
    min: 0,
    default: 0
  },
  potentialRevenue: {
    type: Number,
    min: 0,
    default: 0
  },

  // Audit Fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager",
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  },

  // Soft delete (1 Sept 2026, explicit request: "the deleted products
  // history is not gonna stored hence it is needed to track... need to keep
  // in an another tab... so that if we want then we can also revert it").
  // Deleting used to be `stockItem.deleteOne()` — no trace, no way back.
  // `isActive: false` is the same flag this codebase already uses for a
  // recoverable delete elsewhere (SampleStyle, SalesJourney, Enquiry); every
  // list/search endpoint that lets someone PICK a product filters this out,
  // while GET /:id and every historical reference (work orders, dispatch,
  // QC, customer requests, …) still resolves it — the record isn't gone,
  // just off the shelf.
  isActive: { type: Boolean, default: true, index: true },
  deletedAt: { type: Date, default: null },
  deletedBy: {
    id: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String, trim: true },
  },
}, { timestamps: true });

module.exports = mongoose.model("StockItem", stockItemSchema);


