const mongoose = require("mongoose");

const measurementCategorySchema = new mongoose.Schema({
  name:   { type: String, required: true, trim: true, unique: true },
  fields: [{ type: String, trim: true, required: true }],
  // Persisted link — which StockItem.category string(s) this measurement
  // category has been assigned to. Without this, there was no way to go
  // from a product's category back to the correct measurement category
  // name, since the two are independently user-named.
  productCategories: [{ type: String, trim: true }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { timestamps: true });

module.exports = mongoose.models.MeasurementCategory ||
  mongoose.model("MeasurementCategory", measurementCategorySchema);