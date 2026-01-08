// models/Cms_Models/HistoryReport/Vendor.js

const mongoose = require("mongoose");

const vendorSchema = new mongoose.Schema({
  // Basic Information
  companyName: {
    type: String,
    required: true,
    trim: true
  },
  vendorType: {
    type: String,
    default: "Raw Material Supplier"
  },
  
  // Contact Information
  contactPerson: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  phone: {
    type: String,
    trim: true
  },
  alternatePhone: {
    type: String,
    trim: true
  },
  
  // Address Information
  address: {
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, trim: true, default: "India" }
  },
  
  // Business Information
  gstNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  panNumber: {
    type: String,
    trim: true,
    uppercase: true
  },
  
  // Product/Service Details
  primaryProducts: [{
    type: String,
    trim: true
  }],
  
  // Bank Details
  bankDetails: {
    accountName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    bankName: { type: String, trim: true },
    ifscCode: { type: String, trim: true, uppercase: true },
    branch: { type: String, trim: true }
  },
  
  // Status and Additional Info
  status: {
    type: String,
    enum: ["Active", "Inactive", "Blacklisted"],
    default: "Active"
  },
  rating: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  notes: {
    type: String,
    trim: true
  },
  
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


module.exports = mongoose.model("Vendor", vendorSchema);