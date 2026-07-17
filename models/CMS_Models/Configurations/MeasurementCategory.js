const mongoose = require("mongoose");

const measurementCategorySchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true, unique: true },
  fields: [{ type: String, trim: true, required: true }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

module.exports = mongoose.models.MeasurementCategory ||
  mongoose.model("MeasurementCategory", measurementCategorySchema);