// models/Customer_Models/Measurement.js
const mongoose = require("mongoose");

const measurementValueSchema = new mongoose.Schema(
  {
    measurementName: { type: String, required: true, trim: true },
    value:           { type: String, default: "", trim: true },   // NOT required - can be empty/partial
    unit:            { type: String, default: "", trim: true },
  },
  { _id: false }
);

// ─── category measurement field (for no-product employees) ───────────────────
const categoryMeasurementFieldSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true, trim: true },
    value:     { type: String, default: "", trim: true },
    unit:      { type: String, default: "", trim: true },
  },
  { _id: false }
);

// ─── one category block e.g. "Shirts" with its fields ────────────────────────
const categoryEntrySchema = new mongoose.Schema(
  {
    categoryName: { type: String, required: true, trim: true },
    measurements: [categoryMeasurementFieldSchema],
  },
  { _id: false }
);

const productMeasurementSchema = new mongoose.Schema(
  {
    productId:   { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
    productName: { type: String, required: true, trim: true },
    variantId:   { type: mongoose.Schema.Types.ObjectId, default: null },
    variantName: { type: String, default: "Default" },
    quantity:    { type: Number, required: true, min: 1, default: 1 },
    measurements: [measurementValueSchema],
    measuredAt:  { type: Date, default: Date.now },
    qrGenerated: { type: Boolean, default: false },
    qrGeneratedAt: { type: Date, default: null },
  },
  { _id: false }
);

const employeeMeasurementSchema = new mongoose.Schema(
  {
    employeeId:   { type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc", required: true },
    employeeName: { type: String, required: true, trim: true },
    employeeUIN:  { type: String, required: true, trim: true },
    gender:       { type: String, required: true, trim: true },

    products:            [productMeasurementSchema],

    // true when the employee has no products assigned in EmployeeMpc
    noProductAssigned:   { type: Boolean, default: false },
    // category-based measurements used when noProductAssigned = true
    categoryMeasurements: [categoryEntrySchema],

    isCompleted: { type: Boolean, default: false },
    completedAt: { type: Date },
    remarks:     { type: String, default: "", trim: true },
  },
  { _id: false }
);

const measurementSchema = new mongoose.Schema(
  {
    organizationId:   { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true, index: true },
    organizationName: { type: String, required: true, trim: true },

    name:        { type: String, required: true, trim: true },
    description: { type: String, trim: true },

    registeredEmployeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc" }],

    employeeMeasurements: [employeeMeasurementSchema],

    totalRegisteredEmployees: { type: Number, default: 0 },
    measuredEmployees:        { type: Number, default: 0 },
    pendingEmployees:         { type: Number, default: 0 },
    completionRate:           { type: Number, default: 0 },
    totalMeasurements:        { type: Number, default: 0 },
    completedMeasurements:    { type: Number, default: 0 },
    pendingMeasurements:      { type: Number, default: 0 },

    convertedToPO:    { type: Boolean, default: false },
    poRequestId:      { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    poConversionDate: { type: Date },
    convertedBy:      { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" },

    poCreatedForEmployeeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "EmployeeMpc" }],

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", required: true },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" },
  },
  { timestamps: true }
);

measurementSchema.index({ organizationId: 1, createdAt: -1 });
measurementSchema.index({ organizationId: 1, completionRate: 1 });
measurementSchema.index({ "employeeMeasurements.employeeId": 1 });

module.exports = mongoose.model("Measurement", measurementSchema);