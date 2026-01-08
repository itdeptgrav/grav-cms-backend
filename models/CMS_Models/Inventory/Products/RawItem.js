// models/CMS_Models/Inventory/Products/RawItem.js

const mongoose = require("mongoose");

const discountSchema = new mongoose.Schema({
  minQuantity: {
    type: Number,
    
  },
  price: {
    type: Number,
    
  }
}, { _id: false });

const stockTransactionSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["ADD", "REDUCE", "CONSUME", "ADJUST", "PURCHASE_ORDER"],
  },
  quantity: {
    type: Number,
    
  },
  previousQuantity: {
    type: Number,
    
  },
  newQuantity: {
    type: Number,
    
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
    type: Number,
    
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
  }
}, { timestamps: true });

const rawItemSchema = new mongoose.Schema({
  // Basic Information
  name: {
    type: String,
    trim: true,
    
  },
  sku: {
    type: String,
    trim: true,
    unique: true
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
    
  },
  customUnit: {
    type: String,
    trim: true
  },
  
  // Stock Information
  quantity: {
    type: Number,
    
    default: 0
  },
  minStock: {
    type: Number,
    
    
  },
  maxStock: {
    type: Number,
    
    
  },
  
  // Pricing
  sellingPrice: {
    type: Number,
    
  },
  
  // Bulk Discounts (no vendor costs at registration)
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
  
  // Vendor associations (updated via purchase orders)
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
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  }
}, { timestamps: true });

// Auto-calculate status based on quantity
rawItemSchema.pre("save", function(next) {
  if (this.quantity === 0) {
    this.status = "Out of Stock";
  } else if (this.quantity <= this.minStock) {
    this.status = "Low Stock";
  } else {
    this.status = "In Stock";
  }

});

// Virtual for vendor costs (calculated from recent transactions)
rawItemSchema.virtual('currentVendorCosts').get(function() {
  // Get the most recent purchase prices from each vendor
  const vendorMap = new Map();
  
  this.stockTransactions
    .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
    .sort((a, b) => b.createdAt - a.createdAt)
    .forEach(tx => {
      if (tx.supplier && tx.unitPrice && !vendorMap.has(tx.supplier)) {
        vendorMap.set(tx.supplier, {
          supplier: tx.supplier,
          supplierId: tx.supplierId,
          cost: tx.unitPrice,
          lastPurchaseDate: tx.createdAt
        });
      }
    });
  
  return Array.from(vendorMap.values());
});

module.exports = mongoose.model("RawItem", rawItemSchema);