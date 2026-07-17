// models/CMS_Models/Inventory/Configurations/MeasurementSizeConfig.js

const mongoose = require("mongoose");

// Each rule maps a measurement range → a specific product variant (size)
const sizeRuleSchema = new mongoose.Schema({
  fromValue:  { type: Number, required: true },
  toValue:    { type: Number, required: true },
  sizeValue:  { type: String, required: true, trim: true }, // e.g. "32", "S", "M"
  variantId:  { type: mongoose.Schema.Types.ObjectId, default: null }, // resolved StockItem variant _id
}, { _id: true });

const measurementSizeConfigSchema = new mongoose.Schema({
  name: {
    type: String, required: true, trim: true,
    // e.g. "Shirt Chest → Size"
  },

  // Product this config applies to
  productId:   { type: mongoose.Schema.Types.ObjectId, ref: "StockItem", required: true },
  productName: { type: String, trim: true, default: "" },
  productRef:  { type: String, trim: true, default: "" },

  // Garment category drives which measurement names are available
  // Mirrors the StockItem category field
  garmentCategory: {
    type: String, required: true, trim: true,
    // e.g. "Shirts", "Bottoms", "Outerwear"
  },

  // Which specific measurement determines the size
  // e.g. "Chest", "Waist", "Shoulder"
  measurementParameter: { type: String, required: true, trim: true },

  // The attribute name on the product variant that holds the size value
  // usually "Size" — stored so we can match even if named differently
  sizeAttributeName: { type: String, default: "Size", trim: true },

  // Ordered rules: fromValue ≤ measurement < toValue  →  sizeValue
  rules: [sizeRuleSchema],

  isActive: { type: Boolean, default: true },

  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
}, { timestamps: true });

measurementSizeConfigSchema.index({ productId: 1, measurementParameter: 1 });

module.exports = mongoose.model("MeasurementSizeConfig", measurementSizeConfigSchema);