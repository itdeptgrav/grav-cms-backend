// models/CMS_Models/Inventory/Products/StockItem.js

const mongoose = require("mongoose");

const attributeValueSchema = new mongoose.Schema({
  name: {
    type: String,
    
    trim: true
  },
  value: {
    type: String,
    
    trim: true
  }
}, { _id: false });

const variantSchema = new mongoose.Schema({
  sku: {
    type: String,
    
    unique: true,
    uppercase: true,
    trim: true
  },
  attributes: [attributeValueSchema],
  quantityOnHand: {
    type: Number,
    
    min: 0,
    default: 0
  },
  minStock: {
    type: Number,
    
    min: 0
  },
  maxStock: {
    type: Number,
    
    min: 0
  },
  cost: {
    type: Number,
    
    min: 0
  },
  salesPrice: {
    type: Number,
    
    min: 0
  },
  barcode: {
    type: String,
    trim: true
  },
  images: [String]
}, { timestamps: true });

const rawItemComponentSchema = new mongoose.Schema({
  rawItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "RawItem",
    required: true
  },
  name: {
    type: String,
    
    trim: true
  },
  sku: {
    type: String,
    
    trim: true
  },
  quantity: {
    type: Number,
    
    min: 0
  },
  unit: {
    type: String,
    
    trim: true
  },
  unitCost: {
    type: Number,
    
    min: 0
  },
  totalCost: {
    type: Number,
    
    min: 0
  }
}, { _id: false });

const operationSchema = new mongoose.Schema({
  type: {
    type: String,
    
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
    
    trim: true
  },
  reference: {
    type: String,
    
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
  
  // General Pricing
  unit: {
    type: String,
    
    default: "Units"
  },
  salesPrice: {
    type: Number,
    
    min: 0
  },
  salesTax: {
    type: String,
    trim: true
  },
  cost: {
    type: Number,
    
    min: 0
  },
  purchaseTax: {
    type: String,
    trim: true
  },
  quantityOnHand: {
    type: Number,
    
    min: 0,
    default: 0
  },
  minStock: {
    type: Number,
    
    min: 0
  },
  maxStock: {
    type: Number,
    
    min: 0
  },
  
  // Attributes
  attributes: [{
    name: {
      type: String,
      
      trim: true
    },
    values: [{
      type: String,
      trim: true
    }]
  }],
  
  // Variants
  variants: [variantSchema],
  
  // Components
  rawItems: [rawItemComponentSchema],
  operations: [operationSchema],
  miscellaneousCosts: [{
    name: {
      type: String,
      
      trim: true
    },
    amount: {
      type: Number,
      
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
  
  // Status
  status: {
    type: String,
    enum: ["In Stock", "Low Stock", "Out of Stock"],
    default: "In Stock"
  },
  
  // Calculated Fields
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
  totalCost: {
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

// Pre-save middleware for calculations
stockItemSchema.pre("save", function(next) {
  // Calculate total raw items cost
  this.totalRawItemsCost = this.rawItems.reduce((total, item) => {
    return total + (item.totalCost || 0);
  }, 0);
  
  // Calculate total operations cost
  this.totalOperationsCost = this.operations.reduce((total, op) => {
    return total + (op.operatorCost || 0);
  }, 0);
  
  // Calculate total miscellaneous cost
  this.totalMiscellaneousCost = this.miscellaneousCosts.reduce((total, cost) => {
    return total + (cost.amount || 0);
  }, 0);
  
  // Calculate total cost
  this.totalCost = this.cost + this.totalRawItemsCost + this.totalOperationsCost + this.totalMiscellaneousCost;
  
  // Calculate profit margin
  if (this.salesPrice > 0 && this.totalCost > 0) {
    this.profitMargin = ((this.salesPrice - this.totalCost) / this.totalCost) * 100;
  }
  
  // Calculate inventory value
  this.inventoryValue = this.quantityOnHand * this.totalCost;
  
  // Calculate potential revenue
  this.potentialRevenue = this.quantityOnHand * this.salesPrice;
  
  // Auto-update status based on quantity
  if (this.quantityOnHand === 0) {
    this.status = "Out of Stock";
  } else if (this.quantityOnHand <= this.minStock) {
    this.status = "Low Stock";
  } else {
    this.status = "In Stock";
  }
  
});

module.exports = mongoose.model("StockItem", stockItemSchema);



