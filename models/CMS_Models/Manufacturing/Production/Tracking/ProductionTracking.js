// models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking.js
// UPDATED: Removed operationNumber/operationType from tracking schema.
// Operation info is derived at query time from barcode IDs + WorkOrder data.

const mongoose = require("mongoose");

const barcodeScanSchema = new mongoose.Schema(
  {
    barcodeId: {
      type: String,
      required: true,
      trim: true,
    },
    timeStamp: {
      type: Date,
      required: true,
    },
    // operationNumber REMOVED — derive from barcode + WO at query time
  },
  { _id: true },
);

const operatorTrackingSchema = new mongoose.Schema(
  {
    operatorIdentityId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    signInTime: {
      type: Date,
      required: true,
    },
    signOutTime: {
      type: Date,
      default: null,
    },
    barcodeScans: [barcodeScanSchema],
  },
  { _id: true },
);

// Simplified: one slot per machine — no more operationNumber/operationType.
// currentOperatorIdentityId tracks who is currently signed in on the machine.
// Multiple WOs can happen on the same machine; the barcode encodes WO info.
const machineTrackingSchema = new mongoose.Schema(
  {
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
    // Who is currently signed in on this machine (null if no one)
    currentOperatorIdentityId: {
      type: String,
      default: null,
    },
    // All operator sessions on this machine today
    operators: [operatorTrackingSchema],
  },
  { _id: true },
);

const productionTrackingSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },
    machines: [machineTrackingSchema],
  },
  {
    timestamps: true,
  },
);

productionTrackingSchema.index({ date: 1 });
productionTrackingSchema.index({ "machines.machineId": 1 });

module.exports = mongoose.model("ProductionTracking", productionTrackingSchema);