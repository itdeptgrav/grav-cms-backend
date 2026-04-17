// models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking.js

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
    // Snapshot of which operation CODES were active on this machine when the
    // scan happened. Stored as an array of operation code strings
    // (e.g. ["SJ-01", "BA-03"]).
    // Sent by the device from its in-memory active-ops state.
    activeOps: {
      type: [String],
      default: [],
    },
  },
  { _id: true },
);

const operatorTrackingSchema = new mongoose.Schema(
  {
    operatorIdentityId: {
      type: String,
      required: false,
      trim: true,
      index: true,
    },
    operatorName: {
      type: String,
      default: "",
    },
    signInTime:   { type: Date, required: true },
    signOutTime:  { type: Date, default: null },
    barcodeScans: [barcodeScanSchema],
  },
  { _id: true },
);

// One tracking slot per machine per day.
// currentOperatorIdentityId: who is currently signed in (null if nobody).
const machineTrackingSchema = new mongoose.Schema(
  {
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
    currentOperatorIdentityId: { type: String, default: null },
    operators: [operatorTrackingSchema],
  },
  { _id: true },
);

const productionTrackingSchema = new mongoose.Schema(
  {
    date:     { type: Date, required: true, index: true },
    machines: [machineTrackingSchema],
  },
  { timestamps: true },
);

productionTrackingSchema.index({ date: 1 });
productionTrackingSchema.index({ "machines.machineId": 1 });

module.exports = mongoose.model("ProductionTracking", productionTrackingSchema);