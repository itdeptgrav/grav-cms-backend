// models/CMS_Models/Configurations/MeasurementTemplate.js
//
// A named, reusable set of standard measurement values for a pre-designed
// garment (e.g. "Men's Formal Shirt" in stock sizes) — as opposed to the
// person-wise values taken one employee at a time. Built against a
// MeasurementCategory (Settings-configured field list), storing one preset
// value per field so a measurement-taking page can auto-fill a whole
// product/category block from a single dropdown pick instead of typing
// every field by hand.

const mongoose = require("mongoose");

const templateFieldValueSchema = new mongoose.Schema(
  {
    fieldName: { type: String, required: true, trim: true },
    value: { type: String, default: "", trim: true },
  },
  { _id: false }
);

const measurementTemplateSchema = new mongoose.Schema(
  {
    // "Product Measurement Name" — e.g. "Men's Formal Shirt"
    name: { type: String, required: true, trim: true },

    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "MeasurementCategory",
      required: true,
    },
    // Denormalized so list/export/display never needs a populate just to
    // show which category this template was built against.
    categoryName: { type: String, required: true, trim: true },

    values: [templateFieldValueSchema],

    notes: { type: String, default: "", trim: true },

    isActive: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { timestamps: true }
);

measurementTemplateSchema.index({ name: 1 });
measurementTemplateSchema.index({ category: 1 });

module.exports =
  mongoose.models.MeasurementTemplate ||
  mongoose.model("MeasurementTemplate", measurementTemplateSchema);
