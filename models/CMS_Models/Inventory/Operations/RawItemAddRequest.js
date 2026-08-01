const mongoose = require("mongoose")

const attributeRequestSchema = new mongoose.Schema({
  name: { type: String, trim: true, default: "" },
  values: [{ type: String, trim: true }],
}, { _id: false })

// Reference photos the requester attached, so the store can see exactly which
// product is meant before deciding whether to match or register it.
const productImageSchema = new mongoose.Schema({
  url: { type: String, trim: true, required: true },
  publicId: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
}, { _id: false })

const productRequestSchema = new mongoose.Schema({
  itemName: { type: String, required: true, trim: true },
  category: { type: String, trim: true, default: "" },
  unit: { type: String, trim: true, default: "" },
  requestedQty: { type: Number, default: null },
  notes: { type: String, trim: true, default: "" },
  images: { type: [productImageSchema], default: [] },
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
  // A Purchase Form was raised for THIS product (not stocked, being bought).
  // Set by the requisition route once the form is saved, so the Store screen
  // can show it was already actioned instead of offering the same buttons
  // again with no memory of what happened.
  purchaseFormRaised: { type: Boolean, default: false },
  purchaseRequisitionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Requisition', default: null },
  purchaseRequisitionNumber: { type: String, trim: true, default: "" },
  purchaseFormRaisedAt: { type: Date, default: null },
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

  // When the requester needs the material by. Visible to the requester, the
  // approving TL and the Store — everyone planning around this request.
  neededBy: { type: Date, default: null },

  // ── TL approval gate ──────────────────────────────────────────────────
  // A product request goes to the requester's Primary Manager/TL FIRST. The
  // Store only sees it once the TL has approved — matching it to an existing
  // item or registering a new one is a store decision that comes after
  // approval, not before it.
  //
  // Kept separate from `status` (the store-side lifecycle) so recomputeStatus
  // below stays about products, not approval.
  approvalStatus: {
    type: String,
    enum: ['PENDING_TL', 'TL_APPROVED', 'TL_REJECTED'],
    default: 'PENDING_TL',
  },
  approverEmployee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  approverBiometricId: { type: String, trim: true, default: "" },
  approverAltIds: { type: [String], default: [] },
  approverName: { type: String, trim: true, default: "" },
  approverResolution: { type: String, trim: true, default: "RESOLVED" },
  approvalRoute: { type: String, enum: ['TL', 'AUTO_STORE'], default: 'TL' },
  autoForwarded: { type: Boolean, default: false },
  autoForwardReason: { type: String, trim: true, default: "" },
  requesterCoworkId: { type: String, trim: true, default: "" },

  tlApproved: { type: Boolean, default: false },
  tlApprovedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  tlApprovedByName: { type: String, trim: true, default: "" },
  tlApprovedAt: { type: Date, default: null },
  tlRejected: { type: Boolean, default: false },
  tlRejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
  tlRejectedByName: { type: String, trim: true, default: "" },
  tlRejectedAt: { type: Date, default: null },
  tlRejectionNote: { type: String, trim: true, default: "" },

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

  // ── Request-scoped chat (messages live in MrfChatMessage) ────────────
  // Same thread mechanism MRFs use — requester, TL and Store in one place.
  chatMessageCount: { type: Number, default: 0 },
  chatLastMessageAt: { type: Date, default: null },
  chatLastMessageBy: { type: String, trim: true, default: "" },
}, { timestamps: true })

// TL approval queue lookup.
rawItemAddRequestSchema.index({ approverBiometricId: 1, approvalStatus: 1, createdAt: -1 })
rawItemAddRequestSchema.index({ approverAltIds: 1, approvalStatus: 1 })
rawItemAddRequestSchema.index({ approvalStatus: 1, status: 1, createdAt: -1 })

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