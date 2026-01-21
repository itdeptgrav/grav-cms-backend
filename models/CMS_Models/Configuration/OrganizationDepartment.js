// models/CMS_Models/Configuration/OrganizationDepartment.js

const mongoose = require("mongoose");

const designationStockItemSchema = new mongoose.Schema({
  stockItemId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "StockItem",
    required: true
  },
  variantId: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  variantName: {
    type: String,
    default: "Default"
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
    default: 1
  },
  assignedAt: {
    type: Date,
    default: Date.now
  }
}, { _id: false });

const designationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  assignedStockItems: [designationStockItemSchema],
  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active"
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
}, { _id: true });

const departmentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    trim: true
  },
  designations: [designationSchema],
  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active"
  }
}, { _id: true });

const organizationDepartmentSchema = new mongoose.Schema({
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    required: true,
    index: true
  },
  customerName: {
    type: String,
    required: true,
    trim: true
  },
  customerEmail: {
    type: String,
    trim: true
  },
  customerPhone: {
    type: String,
    trim: true
  },
  departments: [departmentSchema],
  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active"
  }
}, { 
  timestamps: true 
});

// Compound index for unique department per customer
organizationDepartmentSchema.index({ 
  customerId: 1, 
  "departments.name": 1 
}, { 
  unique: true,
  partialFilterExpression: { 
    "departments.name": { $exists: true } 
  } 
});

// Index for better query performance
organizationDepartmentSchema.index({ customerId: 1, status: 1 });
organizationDepartmentSchema.index({ customerName: 1 });
organizationDepartmentSchema.index({ "departments.status": 1 });

module.exports = mongoose.model("OrganizationDepartment", organizationDepartmentSchema);