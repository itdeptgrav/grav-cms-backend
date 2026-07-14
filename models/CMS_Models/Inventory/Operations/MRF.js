// models/CMS_Models/Inventory/Operations/MRF.js

const mongoose = require("mongoose");

// ── Per-item return history entry ─────────────────────────────────────────────
const returnEntrySchema = new mongoose.Schema(
  {
    returnedQty: { type: Number, required: true, min: 0 },
    returnedAt:  { type: Date, default: Date.now },
    notes:       { type: String, trim: true, default: "" },
    recordedBy:  { type: mongoose.Schema.Types.ObjectId, refPath: "recordedByModel", default: null },
    recordedByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "ProjectManager" },
  },
  { _id: true }
);

// ── Per-item sub-doc ──────────────────────────────────────────────────────────
const mrfItemSchema = new mongoose.Schema(
  {
    rawItem:            { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    rawItemName:        { type: String, trim: true, required: true },
    rawItemSku:         { type: String, trim: true, default: "" },
    variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],

    requestedQty: { type: Number, required: true, min: 0 },
    unit:         { type: String, trim: true, required: true },
    baseUnit:     { type: String, trim: true, default: "" },
    issuedQty:    { type: Number, default: 0, min: 0 },
    returnedQty:  { type: Number, default: 0, min: 0 },
    consumedQty:  { type: Number, default: 0, min: 0 },

    itemStatus: {
      type: String,
      enum: ["PENDING", "APPROVED", "ISSUED", "PARTIALLY_RETURNED", "RETURNED", "OVERDUE", "REJECTED"],
      default: "PENDING",
    },

    returnHistory: [returnEntrySchema],
    issueHistory: [{
      issuedQty:  { type: Number, required: true },
      notes:      { type: String, default: "" },
      recordedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
      recordedAt: { type: Date, default: Date.now },
    }],
    storeNotes:    { type: String, trim: true, default: "" },
  },
  { _id: true }
);

// ── Main MRF schema ───────────────────────────────────────────────────────────
const mrfSchema = new mongoose.Schema(
  {
    mrfNumber: { type: String, unique: true, trim: true, required: true },

    // Who the materials are FOR
    requestedFor:     { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true },
    requestedForName: { type: String, trim: true, default: "" },
    requestedForDept: { type: String, trim: true, default: "" },
    requestedForId:   { type: String, trim: true, default: "" }, // employee ID / badge

    // How the MRF was created
    // SELF     → employee raised it themselves via Cowork
    // BYPASS   → store raised it on behalf of the employee
    creationMode: {
      type: String,
      enum: ["SELF", "BYPASS"],
      default: "SELF",
    },

    // Who actually created it (employee if SELF, ProjectManager if BYPASS)
    createdByRef:      { type: mongoose.Schema.Types.ObjectId, refPath: "createdByModel", required: true },
    createdByModel:    { type: String, enum: ["Employee", "ProjectManager"], default: "Employee" },
    createdByName:     { type: String, trim: true, default: "" },

    requestType: {
      type: String,
      enum: ["TIME_BASED", "USES_BASED"],
      required: true,
    },

    deadline: { type: Date, default: null },
    reason:   { type: String, trim: true, default: "" },

    // Priority
    priority: {
      type: String,
      enum: ["LOW", "NORMAL", "HIGH", "URGENT"],
      default: "NORMAL",
    },

    // Cost centre / project reference (optional, for tracking)
    costCentre:       { type: String, trim: true, default: "" },
    projectReference: { type: String, trim: true, default: "" },

    status: {
      type: String,
      enum: [
        "PENDING",
        "APPROVED",
        "PARTIALLY_ISSUED",
        "ISSUED",
        "PARTIALLY_RETURNED",
        "COMPLETED",
        "REJECTED",
        "CANCELLED",
      ],
      default: "PENDING",
    },

    items: [mrfItemSchema],

    //pm action 

    // ── PM approval layer ──────────────────────────────────────────────
    pmApproved:      { type: Boolean, default: false },
    pmApprovedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmApprovedAt:    { type: Date, default: null },
    pmRejected:      { type: Boolean, default: false },
    pmRejectedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    pmRejectedAt:    { type: Date, default: null },
    pmRejectionNote: { type: String, default: "" },

    // Store actions audit
    approvedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    approvedAt:    { type: Date, default: null },
    rejectedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    rejectedAt:    { type: Date, default: null },
    rejectionNote: { type: String, trim: true, default: "" },
    cancelledBy:   { type: mongoose.Schema.Types.ObjectId, refPath: "cancelledByModel", default: null },
    cancelledByModel: { type: String, enum: ["Employee", "ProjectManager"], default: "ProjectManager" },
    cancelledAt:   { type: Date, default: null },
    cancellationNote: { type: String, trim: true, default: "" },

    storeNotes: { type: String, trim: true, default: "" },
  },
  { timestamps: true }
);

mrfSchema.index({ requestedFor: 1, status: 1, createdAt: -1 });
mrfSchema.index({ status: 1, createdAt: -1 });
mrfSchema.index({ requestType: 1, deadline: 1 });
mrfSchema.index({ creationMode: 1, createdAt: -1 });

// Auto-generate MRF number
mrfSchema.pre("validate", async function (next) {
  if (!this.mrfNumber) {
    const now = new Date();
    const yy  = String(now.getFullYear()).slice(-2);
    const mm  = String(now.getMonth() + 1).padStart(2, "0");
    const prefix = `MRF-${yy}${mm}-`;
    const last = await mongoose
      .model("MRF")
      .findOne({ mrfNumber: { $regex: `^${prefix}` } })
      .sort({ mrfNumber: -1 })
      .lean();
    const seq = last ? parseInt(last.mrfNumber.slice(-4), 10) + 1 : 1;
    this.mrfNumber = `${prefix}${String(seq).padStart(4, "0")}`;
  }
  next();
});

module.exports = mongoose.models.MRF || mongoose.model("MRF", mrfSchema);