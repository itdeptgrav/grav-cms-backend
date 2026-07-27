const mongoose = require("mongoose")

const attributeRequestSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: "" },
  values: [{ type: String, trim: true }],
}, { _id: false })

const productRequestSchema = new mongoose.Schema({
  itemName: { type: String, required: true, trim: true },
  category: { type: String, trim: true, default: "" },
  unit: { type: String, trim: true, default: "" },
  requestedQty: { type: Number, default: null },
  notes: { type: String, trim: true, default: "" },
  attributes: [attributeRequestSchema], // parent attribute → its values, mirrors RawItem
  status: {
    type: String,
    enum: ['PENDING', 'MATCHED', 'ADDED', 'REJECTED'],
    default: 'PENDING',
  },
  matchedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RawItem',
    default: null,
  },
  storeNote: { type: String, default: "" },
  resolvedAt: { type: Date, default: null },
  // Once matched/approved, Store specifies a quantity and this product becomes
  // a real MRF (same issuance pipeline as any other request) — this points to it.
  spawnedMrf: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MRF',
    default: null,
  },
}, { _id: true })


const rawItemAddRequestSchema = new mongoose.Schema({
  requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
  requestedByName: { type: String, default: "" },
  requestedByDept: { type: String, default: "" },
  products: [productRequestSchema],
  priority: {
    type: String,
    enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'],
    default: 'NORMAL',
  },
  reason: { type: String, trim: true, default: "" },
  status: {
    type: String,
    enum: ['PENDING', 'ADDED', 'MATCHED', 'REJECTED', 'RESOLVED'],
    default: 'PENDING',
  },
  matchedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RawItem',
    default: null,
  },
  storeNote: { type: String, default: "" },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  resolvedAt: { type: Date, default: null },
}, { timestamps: true })

rawItemAddRequestSchema.methods.recomputeStatus = function () {
  if (!this.products.length) { this.status = "PENDING"; return }
  const allResolved = this.products.every(p => p.status !== "PENDING")
  if (!allResolved) { this.status = "PENDING"; return }
  const allRejected = this.products.every(p => p.status === "REJECTED")
  this.status = allRejected ? "REJECTED" : "RESOLVED"
  if (this.products.length === 1) this.matchedTo = this.products[0].matchedTo || null
}

module.exports = mongoose.models.RawItemAddRequest ||
  mongoose.model("RawItemAddRequest", rawItemAddRequestSchema)