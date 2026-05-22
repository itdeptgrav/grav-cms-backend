// models/CMS_Models/Inventory/Operations/StockLedger.js
// Used ONLY for:
//   1. Compensating entries (auto-created when a stockTransaction is corrected)
//   2. Edit log records (tracking what changed on which stockTransaction)
// The main ledger data lives in RawItem.stockTransactions[].

const mongoose = require("mongoose");

const editLogSchema = new mongoose.Schema(
  {
    editedBy:            { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    editedByName:        { type: String, trim: true, default: "" },
    editedAt:            { type: Date, default: Date.now },
    field:               { type: String, required: true },
    oldValue:            { type: mongoose.Schema.Types.Mixed, required: true },
    newValue:            { type: mongoose.Schema.Types.Mixed, required: true },
    compensatingEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    editNote:            { type: String, trim: true, default: "" },
  },
  { _id: true }
);

const stockLedgerSchema = new mongoose.Schema(
  {
    rawItem:            { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    rawItemName:        { type: String, trim: true, default: "" },
    rawItemSku:         { type: String, trim: true, default: "" },
    variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    unit:               { type: String, trim: true, default: "unit" },

    direction:      { type: String, enum: ["CREDIT", "DEBIT"], required: true },
    quantity:       { type: Number, required: true, min: 0 },
    quantityBefore: { type: Number, default: 0 },
    quantityAfter:  { type: Number, default: 0 },

    txnType: {
      type: String,
      enum: [
        "PURCHASE_ORDER", "STOCK_ADJUSTMENT", "MRF_ISSUE", "MRF_RETURN",
        "RETURN_TO_VENDOR", "REPLACEMENT_RECEIVED", "OPENING_STOCK", "COMPENSATING",
      ],
      required: true,
    },

    reason:  { type: String, trim: true, default: "" },
    notes:   { type: String, trim: true, default: "" },

    // Source refs
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null },
    purchaseOrderNo: { type: String, trim: true, default: "" },
    mrfId:           { type: mongoose.Schema.Types.ObjectId, ref: "MRF", default: null },
    mrfNumber:       { type: String, trim: true, default: "" },
    vendorId:        { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    vendorName:      { type: String, trim: true, default: "" },

    // For COMPENSATING entries — points back to the stockTransaction._id being corrected
    compensatingFor: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── KEY FIELD: links this ledger record back to the embedded stockTransaction ──
    originalTxnId:  { type: mongoose.Schema.Types.ObjectId, default: null },

    performedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "ProjectManager", default: null },
    performedByName: { type: String, trim: true, default: "" },

    isEdited: { type: Boolean, default: false },
    editLog:  [editLogSchema],

    isVoided: { type: Boolean, default: false },
    voidedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    collection: "stockledger",
  }
);

stockLedgerSchema.index({ rawItem: 1, createdAt: -1 });
stockLedgerSchema.index({ rawItem: 1, variantId: 1, createdAt: -1 });
stockLedgerSchema.index({ originalTxnId: 1 });
stockLedgerSchema.index({ compensatingFor: 1 });
stockLedgerSchema.index({ isEdited: 1 });

module.exports =
  mongoose.models.StockLedger ||
  mongoose.model("StockLedger", stockLedgerSchema);