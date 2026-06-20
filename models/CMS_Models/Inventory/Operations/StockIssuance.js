// models/CMS_Models/Inventory/Operations/StockIssuance.js

const mongoose = require("mongoose");

const issuanceItemSchema = new mongoose.Schema({
  rawItem:            { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
  rawItemName:        { type: String, default: "" },
  rawItemSku:         { type: String, default: "" },
  variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
  variantCombination: [{ type: String }],
  issuedQty:          { type: Number, required: true },   // qty in user-selected unit
  issuedUnit:         { type: String, required: true },   // unit user selected
  nativeQty:          { type: Number, required: true },   // converted to raw item's native unit
  nativeUnit:         { type: String, required: true },   // raw item's native unit
  notes:              { type: String, default: "" },
}, { _id: true });

const stockIssuanceSchema = new mongoose.Schema(
  {
    direction: { type: String, enum: ["debit", "credit"], required: true },

    // Optional MO reference
    manufacturingOrder: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    moNumber:           { type: String, default: "" },
    customerName:       { type: String, default: "" },

    items:  [issuanceItemSchema],
    reason: { type: String, default: "" },
    notes:  { type: String, default: "" },

    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  },
  { timestamps: true }
);

stockIssuanceSchema.index({ manufacturingOrder: 1 });
stockIssuanceSchema.index({ createdAt: -1 });
stockIssuanceSchema.index({ direction: 1 });

module.exports =
  mongoose.models.StockIssuance ||
  mongoose.model("StockIssuance", stockIssuanceSchema);