// models/Cms_Models/Inventory/Configurations/Machine.js

const mongoose = require("mongoose");

const machineSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    required: true,
    trim: true
  },
  model: {
    type: String,
    required: true,
    trim: true
  },
  serialNumber: {
    type: String,
    required: true,
    unique: true,
    uppercase: true,
    trim: true
  },
  status: {
    type: String,
    enum: ["Operational", "Under Maintenance", "Idle", "Repair Needed"],
    default: "Operational"
  },
  powerConsumption: {
    type: String,
    required: true,
    trim: true
  },
  location: {
    type: String,
    required: true,
    trim: true
  },
  lastMaintenance: {
    type: Date,
    required: true
  },
  nextMaintenance: {
    type: Date,
    required: true
  },
  description: {
    type: String,
    trim: true
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

module.exports = mongoose.model("Machine", machineSchema);

