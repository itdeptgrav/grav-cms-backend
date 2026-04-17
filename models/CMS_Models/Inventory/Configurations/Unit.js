// models/CMS_Models/Inventory/Configurations/Unit.js

const mongoose = require("mongoose");

const conversionSchema = new mongoose.Schema({
  toUnit: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Unit",
    required: true
  },
  quantity: {
    type: Number,
    required: true,
    min: 0.001
  }
});

const unitSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    unique: true
  },
  conversions: [conversionSchema],
  status: {
    type: String,
    enum: ["Active", "Inactive"],
    default: "Active"
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProjectManager"
  }
}, { timestamps: true });

module.exports = mongoose.model("Unit", unitSchema);