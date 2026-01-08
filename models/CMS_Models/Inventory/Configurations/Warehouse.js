// models/Cms_Models/Inventory/Configurations/Warehouse.js

const mongoose = require("mongoose");

const warehouseSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  shortName: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  address: {
    type: String,
    required: true,
    trim: true
  },
  capacity: {
    type: String,
    default: "0 sq ft"
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active"
  },
  itemsCount: {
    type: Number,
    default: 0
  },
  description: {
    type: String,
    trim: true
  },
  contactPerson: {
    name: String,
    phone: String,
    email: String
  },
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

// Index for faster queries
warehouseSchema.index({ name: 1, shortName: 1 });
warehouseSchema.index({ shortName: 1 }, { unique: true });
warehouseSchema.index({ status: 1 });

module.exports = mongoose.model("Warehouse", warehouseSchema);