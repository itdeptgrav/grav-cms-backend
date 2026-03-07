// models/CMS_Models/Inventory/Configurations/Operation.js

const mongoose = require("mongoose")

const operationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Operation name is required"],
      trim: true,
    },
    // Optional code linked from OperationCode registry (stored as plain string for fast reads)
    operationCode: {
      type: String,
      trim: true,
      default: "",
    },
    totalSam: {
      type: Number,
      required: [true, "Total SAM is required"],
      min: 0,
    },
    // SAM × 60 — stored for convenience
    durationSeconds: {
      type: Number,
      required: true,
      min: 0,
    },
    machineType: {
      type: String,
      required: [true, "Machine type is required"],
      trim: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Employee",
    },
  },
  { timestamps: true }
)

module.exports = mongoose.model("Operation", operationSchema)