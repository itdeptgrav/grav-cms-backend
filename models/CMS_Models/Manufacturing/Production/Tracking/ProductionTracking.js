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
    // ADD operation number if available in barcode
    operationNumber: {
      type: Number,
      default: null,
    },
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

// Create operation-specific tracking
const operationTrackingSchema = new mongoose.Schema(
  {
    operationNumber: {
      type: Number,
      required: true,
    },
    operationType: {
      type: String,
      trim: true,
    },
    currentOperatorIdentityId: {
      type: String,
      default: null,
    },
    operators: [operatorTrackingSchema],
  },
  { _id: true },
);

const machineTrackingSchema = new mongoose.Schema(
  {
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
    // Each machine can track multiple operations separately
    operationTracking: [operationTrackingSchema],
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

// Indexes for faster queries
productionTrackingSchema.index({ date: 1 });
productionTrackingSchema.index({ "machines.machineId": 1 });
productionTrackingSchema.index({
  "machines.operationTracking.operationNumber": 1,
});

module.exports = mongoose.model("ProductionTracking", productionTrackingSchema);
