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

    /* ── Chunk 1C: tenancy ─────────────────────────────────────────────────
       Server-owned, taken from the resolved tenant context and never from the
       request body. Absent on every record written before the boundary — those
       are legacy-global and readable only under the legacy-read policy. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // For COMPENSATING entries — points back to the stockTransaction._id being corrected
    compensatingFor: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── Chunk 1C: correction identity ─────────────────────────────────────
       A correction is an APPEND, never an edit. These record what the
       correction did without touching the movement it corrects:

         · `correctsQuantityFrom/To` — what the original said and what the
           correction asserts it should have said. The original transaction
           itself keeps its own figures unchanged.
         · `originalQuantityBefore/After` — the balance either side of the
           ORIGINAL movement, preserved so the chain stays readable even after
           later corrections move the live balance on.
         · `idempotencyKey` — which user action produced this entry, so a
           replayed request is recognised rather than appending a second
           compensating movement. */
    correctsQuantityFrom: { type: Number, default: null },
    correctsQuantityTo:   { type: Number, default: null },
    originalQuantityBefore: { type: Number, default: null },
    originalQuantityAfter:  { type: Number, default: null },
    correctionReason: { type: String, trim: true, default: "" },
    idempotencyKey:   { type: String, trim: true, default: "", index: true },

    /* ── WHETHER THE CORRECTION ACTUALLY LANDED ────────────────────────────
       A compensating row is written BEFORE the balance moves — it is the
       atomic claim on the movement being corrected, and writing it first is
       what stops two simultaneous corrections. But that means the row's
       existence proves only that somebody started; it says nothing about
       whether the stock moved.

       Treating the row as proof of completion is how an interrupted
       correction gets replayed to the caller as a success while the balance
       was never touched — or, worse, while it was touched and the row was
       never finished.

         PENDING — claimed. The balance may or may not have moved.
         APPLIED — the balance moved, the variant balance moved where one
                   applies, and quantityBefore/quantityAfter are persisted.

       Only APPLIED may be reported as a completed correction. */
    applicationState: {
      type: String,
      enum: ["PENDING", "APPLIED"],
      /* No default: a row written before this field existed has no state at
         all, and must not be silently read as APPLIED. `undefined` is
         distinguishable from both values and is handled as unknown. */
      index: true,
    },
    appliedAt: { type: Date, default: null },

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

/* Tenant-first compounds: every scoped read filters on companyId before
   anything else, so it must lead the index. */
stockLedgerSchema.index({ companyId: 1, rawItem: 1, createdAt: -1 });
stockLedgerSchema.index({ companyId: 1, createdAt: -1 });
stockLedgerSchema.index({ rawItem: 1, createdAt: -1 });
stockLedgerSchema.index({ rawItem: 1, variantId: 1, createdAt: -1 });
stockLedgerSchema.index({ originalTxnId: 1 });
stockLedgerSchema.index({ compensatingFor: 1 });

/* ── AT MOST ONE CORRECTION PER MOVEMENT ───────────────────────────────────
   Enforced by the database, not by a read-then-write check. Two simultaneous
   corrections under different idempotency keys both pass a pre-read; only one
   can win a unique index. The partial filter keeps it to live compensating
   rows, so it never constrains ordinary ledger entries or a voided one. */
stockLedgerSchema.index(
  { compensatingFor: 1, txnType: 1 },
  {
    unique: true,
    name: "one_live_correction_per_movement",
    partialFilterExpression: {
      txnType: "COMPENSATING",
      isVoided: false,
      compensatingFor: { $type: "objectId" },
    },
  },
);
stockLedgerSchema.index({ isEdited: 1 });

module.exports =
  mongoose.models.StockLedger ||
  mongoose.model("StockLedger", stockLedgerSchema);