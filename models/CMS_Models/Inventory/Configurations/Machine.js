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

/* Server-owned production state (28 Sep 2026): company ownership, the current
   assignment to a frozen Production execution-basis operation, its bounded
   history and device synchronisation. Additive, `select: false`, guarded —
   see machineProductionAssignment.schema.js. Existing machines stay unclaimed. */
const {
  addProductionAssignmentPaths,
  installMachineAssignmentGuard,
} = require("./machineProductionAssignment.schema");
addProductionAssignmentPaths(machineSchema);
installMachineAssignmentGuard(machineSchema);

/* Maintenance tag (3 Oct 2026): the permanent label identity a Maintenance
   scan resolves through. Additive, `select: false`, written once by the
   maintenance tag service — see machineMaintenanceTag.schema.js. */
const {
  addMaintenanceTagPaths,
  installMaintenanceTagGuard,
} = require("./machineMaintenanceTag.schema");
addMaintenanceTagPaths(machineSchema);
installMaintenanceTagGuard(machineSchema);

module.exports = mongoose.model("Machine", machineSchema);

