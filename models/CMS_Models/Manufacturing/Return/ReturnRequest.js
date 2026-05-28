// models/CMS_Models/Manufacturing/Return/ReturnRequest.js

const mongoose = require("mongoose");

// Product-level return dispatch tracking
const returnProductSchema = new mongoose.Schema(
  {
    workOrderId:       { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder", default: null },
    workOrderNumber:   { type: String, default: "" },
    stockItemId:       { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", default: null },
    variantId:         { type: String, default: "" },
    productName:       { type: String, required: true },
    productRef:        { type: String, default: "" },
    variantAttributes: [{ name: { type: String }, value: { type: String } }],
    returnQuantity:    { type: Number, required: true, min: 1 },
    // Return dispatch tracking — set to in_progress when MO is created, dispatched when physically sent back
    returnDispatchStatus: { type: String, enum: ["pending", "in_progress", "dispatched"], default: "pending" },
    returnDispatchedAt:   { type: Date, default: null },
    returnDispatchedBy:   { type: String, default: "" },
  },
  { _id: false }
);

const returnPersonSchema = new mongoose.Schema(
  {
    employeeId:       { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc", default: null },
    employeeName:     { type: String, required: true },
    employeeUIN:      { type: String, default: "" },
    department:       { type: String, default: "" },
    designation:      { type: String, default: "" },
    gender:           { type: String, default: "" },
    products:         [returnProductSchema],
    totalReturnUnits: { type: Number, default: 0 },
    // Aggregated return dispatch status for this person
    returnDispatchStatus: { type: String, enum: ["pending", "in_progress", "partial", "dispatched"], default: "pending" },
  },
  { _id: false }
);

const returnRequestSchema = new mongoose.Schema(
  {
    returnRequestNumber: { type: String, required: true, unique: true, index: true, trim: true },

    // Original MO
    originalMoId:      { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", required: true, index: true },
    originalRequestId: { type: String, default: "" },

    // Customer
    customerId:   { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    customerName: { type: String, default: "" },
    customerInfo: { type: mongoose.Schema.Types.Mixed, default: null },

    // Type
    dispatchType: { type: String, enum: ["person_wise", "bulk"], required: true },

    // Person-wise
    persons:      [returnPersonSchema],

    // Bulk
    bulkProducts: [returnProductSchema],

    // Totals
    totalReturnUnits: { type: Number, default: 0 },
    totalPersons:     { type: Number, default: 0 },
    totalProducts:    { type: Number, default: 0 },

    // Creator
    createdByType:     { type: String, enum: ["customer", "dispatch"], default: "dispatch" },
    createdByEmployee: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdByCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },

    // Status: pending → store_processing → mo_created → completed | rejected
    status: {
      type:  String,
      enum:  ["pending", "store_processing", "mo_created", "completed", "rejected"],
      default: "pending",
      index: true,
    },

    // Processing
    processingStartedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    processingStartedAt: { type: Date, default: null },

    // Final data store person finalises before MO creation
    processedPersons:      [returnPersonSchema],
    processedBulkProducts: [returnProductSchema],

    // New MO created
    newMoId:          { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    newRequestId:     { type: String, default: "" },
    newMeasurementId: { type: mongoose.Schema.Types.ObjectId, ref: "Measurement", default: null },

    // Rejection
    rejectedBy:      { type: mongoose.Schema.Types.ObjectId, default: null },
    rejectedAt:      { type: Date, default: null },
    rejectionReason: { type: String, trim: true, default: "" },

    // Return dispatch tracking (populated after MO is created)
    // "in_progress" = MO created, items being reworked
    // "partial"     = some items dispatched back
    // "dispatched"  = all items dispatched back
    returnDispatchStatus: {
      type: String, enum: ["pending", "in_progress", "partial", "dispatched"], default: "pending",
    },
    returnDispatchedAt: { type: Date, default: null },
    returnDispatchedBy: { type: String, default: "" },

    notes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

returnRequestSchema.index({ originalMoId: 1, createdAt: -1 });
returnRequestSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model("ReturnRequest", returnRequestSchema);