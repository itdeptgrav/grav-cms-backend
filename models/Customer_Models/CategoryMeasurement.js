// models/Customer_Models/CategoryMeasurement.js
const mongoose = require("mongoose");

const categoryMeasurementValueSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true, trim: true },
    value: { type: String, default: "", trim: true },
    unit: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const categoryEntrySchema = new mongoose.Schema(
  {
    employeeId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "EmployeeMpc",
      required: true,
    },
    employeeName: { type: String, required: true, trim: true },
    employeeUIN: { type: String, required: true, trim: true },
    gender: { type: String, required: true, trim: true },
    remarks: { type: String, default: "", trim: true },
    noProductAssigned: { type: Boolean, default: true },
    // category: one of "Uniform", "Footwear", "Accessories"
    categoryName: { type: String, required: true, trim: true },
    measurements: [categoryMeasurementValueSchema],
    isCompleted: { type: Boolean, default: false },
    completedAt: { type: Date },
    // when products are later assigned and this converts
    convertedToProductMeasurement: { type: Boolean, default: false },
    convertedAt: { type: Date },
  },
  { _id: false }
);

const categoryMeasurementSchema = new mongoose.Schema(
  {
    measurementId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Measurement",
      required: true,
      index: true,
    },
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Customer",
      required: true,
      index: true,
    },
    organizationName: { type: String, required: true, trim: true },
    entries: [categoryEntrySchema],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager" },
  },
  { timestamps: true }
);

// Default measurement fields per category
categoryMeasurementSchema.statics.getDefaultFields = function (category) {
  const fieldMap = {
    Uniform: ["Chest", "Waist", "Hip", "Shoulder", "Sleeve", "Length", "Neck"],
    Footwear: ["Foot Length", "Foot Width", "Shoe Size"],
    Accessories: ["Head Circumference", "Wrist Size", "Belt Size"],
  };
  return fieldMap[category] || ["Size"];
};

categoryMeasurementSchema.index({ measurementId: 1, "entries.employeeId": 1 });

module.exports = mongoose.model("CategoryMeasurement", categoryMeasurementSchema);