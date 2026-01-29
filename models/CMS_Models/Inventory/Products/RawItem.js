// models/CMS_Models/Inventory/Products/RawItem.js

const mongoose = require("mongoose");

const discountSchema = new mongoose.Schema({
  minQuantity: {
    type: Number,
    required: true,
    min: 1
  },
  price: {
    type: Number,
    required: true,
    min: 0
  }
}, { _id: false });

const attributeSchema = new mongoose.Schema({
  name: {
    type: String,
    trim: true,
    required: true
  },
  values: [{
    type: String,
    trim: true,
    required: true
  }]
}, { _id: false });

const variantSchema = new mongoose.Schema({
  combination: [{
    type: String,
    trim: true,
    required: true
  }],
  quantity: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  minStock: {
    type: Number,
    required: true,
    min: 0
  },
  maxStock: {
    type: Number,
    required: true,
    min: 0
  },
  sku: {
    type: String,
    trim: true
  },
  status: {
    type: String,
    enum: ["In Stock", "Low Stock", "Out of Stock"],
    default: "In Stock"
  }
}, { _id: true });

const stockTransactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["ADD", "REDUCE", "CONSUME", "ADJUST", "PURCHASE_ORDER", "VARIANT_ADD", "VARIANT_REDUCE"],
    required: true
  },
  quantity: {
    type: Number,
    required: true
  },
  variantCombination: [{
    type: String,
    trim: true
  }],
  variantId: {
    type: mongoose.Schema.Types.ObjectId
  },
  previousQuantity: {
    type: Number,
    required: true
  },
  newQuantity: {
    type: Number,
    required: true
  },
  reason: {
    type: String,
    trim: true
  },
  supplier: {
    type: String,
    trim: true
  },
  supplierId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vendor"
  },
  unitPrice: {
    type: Number
  },
  purchaseOrder: {
    type: String,
    trim: true
  },
  purchaseOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "PurchaseOrder"
  },
  invoiceNumber: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  performedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager",
    required: true
  }
}, { timestamps: true });

const rawItemSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    trim: true,
    required: true
  },
  sku: {
    type: String,
    trim: true,
    unique: true,
    required: true
  },
  category: {
    type: String,
    trim: true
  },
  customCategory: {
    type: String,
    trim: true
  },
  
  // Measurement
  unit: {
    type: String,
    trim: true,
    required: true
  },
  customUnit: {
    type: String,
    trim: true
  },
  
  // Attributes & Variants
  attributes: [attributeSchema],
  variants: [variantSchema],
  
  // Stock Information (total quantity - sum of all variants)
  quantity: {
    type: Number,
    required: true,
    default: 0,
    min: 0
  },
  minStock: {
    type: Number,
    required: true,
    min: 0
  },
  maxStock: {
    type: Number,
    required: true,
    min: 0
  },
  
  // Bulk Discounts
  discounts: [discountSchema],
  
  // Stock Transactions History
  stockTransactions: [stockTransactionSchema],
  
  // Status
  status: {
    type: String,
    enum: ["In Stock", "Low Stock", "Out of Stock"],
    default: "In Stock"
  },
  
  // Additional Info
  description: {
    type: String,
    trim: true
  },
  notes: {
    type: String,
    trim: true
  },
  
  // Vendor associations
  primaryVendor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vendor"
  },
  alternateVendors: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: "Vendor"
  }],
  
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

module.exports = mongoose.model("RawItem", rawItemSchema);