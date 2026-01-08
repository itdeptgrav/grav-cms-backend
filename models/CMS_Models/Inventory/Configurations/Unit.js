// models/CMS_Models/Inventory/Configurations/Unit.js

const mongoose = require("mongoose");

const unitSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  gstUqc: {
    type: String,
    uppercase: true,
    trim: true
  },
  quantity: {
    type: Number,
    min: 0
  },
  baseUnit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Unit",
    default: null
  },
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active"
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager",
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  }
}, { timestamps: true });


module.exports = mongoose.model("Unit", unitSchema);