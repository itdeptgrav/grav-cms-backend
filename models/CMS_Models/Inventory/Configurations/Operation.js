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
    // ── Default salary basis (26 Aug 2026, explicit request: "in the
    // operation registration time... ask for the department, designation...
    // so that when in the stock item, the operation will goona fill then it
    // also auto select the department, designation... no need to do the
    // department, designation selection for each and every product"). Set
    // once here at registration, and every stock item that pulls this
    // operation in (directly or via an Operation Group) inherits it — see
    // applyRegisteredOperation/applyRegisteredGroup in the stock-item editor
    // and the operation-groups apply-to-category bulk route.
    salaryDept: {
      type: String,
      trim: true,
      default: "",
    },
    salaryDesig: {
      type: String,
      trim: true,
      default: "",
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