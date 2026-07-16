const mongoose = require("mongoose")

const attributeRequestSchema = new mongoose.Schema({
  name:   { type: String, trim: true, default: "" },
  values: [{ type: String, trim: true }],
}, { _id: false })

const productRequestSchema = new mongoose.Schema({
  itemName:   { type: String, required: true, trim: true },
  category:   { type: String, trim: true, default: "" },
  unit:       { type: String, trim: true, default: "" },
  notes:      { type: String, trim: true, default: "" },
  attributes: [attributeRequestSchema], // parent attribute → its values, mirrors RawItem
}, { _id: true })

const rawItemAddRequestSchema = new mongoose.Schema({
  requestedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
  requestedByName: { type: String, default: "" },
  requestedByDept: { type: String, default: "" },
  products:        [productRequestSchema],
  status: { type: String, enum: ["PENDING", "ADDED", "REJECTED"], default: "PENDING" },
  storeNote:  { type: String, default: "" },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true })

module.exports = mongoose.models.RawItemAddRequest ||
  mongoose.model("RawItemAddRequest", rawItemAddRequestSchema)