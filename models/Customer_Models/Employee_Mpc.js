const mongoose = require("mongoose");

const employeeMpcSchema = new mongoose.Schema({
  // Customer reference
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer",
    required: true,
    index: true
  },
  
  // Employee basic information
  name: {
    type: String,
    required: true,
    trim: true
  },
  
  // Unique Identification Number
  uin: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    uppercase: true,
    index: true
  },
  
  // Department (fetched from organization departments)
  department: {
    type: String,
    required: true,
    trim: true
  },
  
  // Designation (fetched from selected department)
  designation: {
    type: String,
    required: true,
    trim: true
  },
  
  // Gender
  gender: {
    type: String,
    enum: ["Male", "Female"],
    required: true
  },
  
  // Status
  status: {
    type: String,
    enum: ["active", "inactive"],
    default: "active"
  },
  
  // Additional fields
  notes: {
    type: String,
    trim: true
  },
  
  // Audit fields
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer"
  },
  
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Customer"
  }
}, { 
  timestamps: true 
});

// Index for better query performance
employeeMpcSchema.index({ customerId: 1, department: 1 });
employeeMpcSchema.index({ customerId: 1, status: 1 });
employeeMpcSchema.index({ customerId: 1, createdAt: -1 });

// Compound index for unique employee per customer
employeeMpcSchema.index({ customerId: 1, uin: 1 }, { unique: true });

module.exports = mongoose.model("EmployeeMpc", employeeMpcSchema);





// Ok let's move towords the another page ok means in the cms side ok.
// So basically i need to create the measurement dashboard where basically the corresponding registered employee measurement records need to keep ok.
// so basically as you know that 