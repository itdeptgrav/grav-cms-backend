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
  variantId: { // New: To store which variant of raw item is used
    type: mongoose.Schema.Types.ObjectId
  },
  variantCombination: [{ // New: Which variant combination of raw item
    type: String,
    trim: true
  }],
  quantity: {
    type: Number,
    required: true,
    min: 0
  },
  unit: {
    type: String,
    required: true,
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
  // NEW: Raw items specific to this variant
  rawItems: [variantRawItemSchema],
  // Status for this specific variant
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
  }
}, { _id: false });

const stockItemSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    required: true,
    trim: true
  },
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

  // General Pricing (Base prices - can be overridden by variants)
  unit: {
    type: String,
    required: true,
    default: "Units"
  },
  baseSalesPrice: {
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

  // Variants (REQUIRED - at least one variant)
  variants: [variantSchema],

  // Operations (common for all variants)
  operations: [operationSchema],
  
  // Miscellaneous costs (common for all variants)
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

  // Images (common for all variants)
  images: [String],

  // Overall Status (calculated from variants)
  status: {
    type: String,
    enum: ["In Stock", "Low Stock", "Out of Stock"],
    default: "In Stock"
  },

  // Calculated Fields (from all variants)
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
  }
}, { timestamps: true });

module.exports = mongoose.model("StockItem", stockItemSchema);