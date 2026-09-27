// models/CMS_Models/StorePurchase/GoodsReceipt.js
//
// GOODS RECEIPT (GRN) — the authoritative, line-level record of what physically
// arrived against a Purchase Order. V1 proves RECEIPT ONLY: it records that a
// quantity was received, in a unit, at a location, against a supplier reference.
// It does NOT claim inspection, acceptance, quarantine or put-away — those are
// deliberately later chunks. Never call a received quantity "accepted".
//
// Every line joins its source line by a STORED id (never by name, amount or
// array position), carries its own conversion evidence and the stock/location
// movement identifiers this receipt created, and is immutable once written.
//
// ── TWO KINDS OF ARRIVAL, ONE RECEIPT RECORD ────────────────────────────────
// A purchase receipt discharges a Purchase Order: the factory bought the goods,
// there is a supplier, an invoice and a spend.
//
// A CUSTOMER-MATERIAL receipt discharges a customer-supplied material
// expectation on a job-work order: the customer sent the goods, the factory
// bought nothing, and there is no supplier, no invoice, no value and nothing
// payable. The physical act — something arrived, was counted, converted to the
// base unit and put in a location — is identical, which is why it is the same
// document rather than a second receipt system with its own arithmetic.
//
// `sourceType` says which. It is not decoration: the conditional `required`
// rules and the validator below make an invalid combination unsaveable, so a
// receipt cannot claim a purchase order it has not got, cannot carry a supplier
// on customer goods, and cannot mix two sources in one document.

"use strict";

const mongoose = require("mongoose");

// One received PO line. Immutable: a correction is a new document, never an edit.
const SOURCE_TYPE = Object.freeze({
  PURCHASE_ORDER: "PURCHASE_ORDER",
  CUSTOMER_MATERIAL: "CUSTOMER_MATERIAL",
});
const SOURCE_TYPES = Object.freeze(Object.values(SOURCE_TYPE));

const goodsReceiptLineSchema = new mongoose.Schema(
  {
    /* ── WHICH SOURCE LINE THIS DISCHARGES ────────────────────────────────
       The generic stored-id join, filled for every source type, so a reader
       that does not care which kind of receipt this is can still say which line
       it belongs to. */
    sourceLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* ── AND ITS STABLE, HUMAN-QUOTABLE REFERENCE ─────────────────────────
       For customer material this is the expectation's `lineRef`, which is the
       identity that survives a revision — the whole reason receipts against
       revision 1 still count after revision 2 is issued. An ObjectId alone
       would not do: a revision is a new document with new subdocument ids. */
    sourceLineRef: { type: String, trim: true, default: "" },

    /* ── STORED-ID JOIN BACK TO THE PO LINE (THE RELIABLE KEY) ────────────
       Required for a PURCHASE_ORDER receipt and absent on a customer-material
       one, where there is no purchase order line and a placeholder id would be
       a lie.

       That condition is enforced in the DOCUMENT-level validator below, not by a
       `required` function here. A subdocument's `required` would have to reach
       its parent to learn the source type, and reaching upward from inside an
       array subdocument is exactly the kind of lookup that works until the
       subdocument is validated in a context where the parent is not attached —
       at which point every purchase receipt fails with a cast error nobody can
       read. The invariant is the same and it is checked where the parent is
       simply in scope. */
    poItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
    spendLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Item / variant identity + snapshots (so the line reads without a join) ──
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", default: null },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },
    variantSku: { type: String, trim: true, default: "" },

    // ── How much arrived, in the PO unit, plus the canonical/base evidence ──
    poUnit: { type: String, trim: true, default: "" },
    receivedQuantity: { type: Number, required: true, min: 0 },     // in poUnit
    baseUnit: { type: String, trim: true, default: "" },            // RawItem registered unit
    baseQuantity: { type: Number, min: 0, default: 0 },             // received in baseUnit
    conversionFactor: { type: Number, default: 1 },                 // baseQuantity / receivedQuantity
    conversionNote: { type: String, trim: true, default: "" },      // human evidence

    // ── Before/after snapshots, so the line is self-explaining ──
    quantityOrdered: { type: Number, min: 0, default: 0 },
    previouslyReceived: { type: Number, min: 0, default: 0 },       // before this receipt
    receivedAfter: { type: Number, min: 0, default: 0 },            // PO line received after
    pendingAfter: { type: Number, min: 0, default: 0 },             // PO line pending after

    // ── The stock/location movements this line created (linked, not recomputed) ──
    stockLedgerRef: {
      rawItemId: { type: mongoose.Schema.Types.ObjectId, default: null },
      transactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    locationMovementId: { type: mongoose.Schema.Types.ObjectId, default: null },
  },
  { _id: true },
);

const goodsReceiptSchema = new mongoose.Schema(
  {
    // Company-owned (unlike the legacy StockItem catalogue).
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Immutable GRN number, allocated through the GOODS_RECEIPT document sequence.
    receiptNumber: { type: String, required: true, trim: true, immutable: true },

    /* ── WHAT THIS RECEIPT DISCHARGES ────────────────────────────────────
       `sourceType` defaults to PURCHASE_ORDER so every receipt written before
       this field existed reads as what it is. It is not inferred from which
       other fields happen to be set — an inference is a guess, and a guess
       about whether goods were bought decides whether they appear in spend. */
    sourceType: {
      type: String, enum: SOURCE_TYPES, default: SOURCE_TYPE.PURCHASE_ORDER,
      required: true, index: true,
    },
    /* The source document, generically. Always set on a new receipt; equal to
       `purchaseOrderId` on a purchase receipt, so a reader needs to know only
       one field. */
    sourceDocumentId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    sourceDocumentNumber: { type: String, trim: true, default: "" },

    // ── The order this receipt discharges ──
    // Retained, and still REQUIRED for a purchase receipt — conditionally, so a
    // customer-material receipt cannot claim a purchase order it has not got.
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", index: true,
      required: function required() { return this.sourceType === SOURCE_TYPE.PURCHASE_ORDER; },
    },
    poNumber: { type: String, trim: true, default: "" },

    // ── Supplier snapshot ──
    // Never set on customer material: the customer is not a supplier, and a
    // vendor field holding their name turns a buyer into one in every report
    // that groups by vendor. The validator refuses it outright.
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor", default: null },
    supplierName: { type: String, trim: true, default: "" },

    /* ── CUSTOMER-SUPPLIED MATERIAL: WHOSE GOODS, AND AGAINST WHAT ────────
       Present only on a CUSTOMER_MATERIAL receipt. `customerId` is the stable
       ownership identity resolved on the server from the Sales handover chain —
       never from a payload. The rest is provenance a person reads.

       There is deliberately no price, no value, no tax and nothing payable: the
       factory bought nothing, so there is nowhere for one to land. */
    customerMaterial: {
      customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null, index: true },
      customerLabel: { type: String, trim: true, default: "" },
      customerCode: { type: String, trim: true, default: "" },
      orderRef: { type: String, trim: true, default: "" },
      executionFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      /* WHICH REVISION of the expectation this was received against. Receipt
         provenance names the exact revision, so a later revision never rewrites
         what an earlier receipt was recorded against. */
      expectationRevisionNo: { type: Number, default: null },
      /* The customer's own challan or delivery-note reference. Deliberately a
         separate field from `invoiceNumber`: this is not a supplier invoice and
         must not be read, reported or worded as one. */
      customerReference: { type: String, trim: true, default: "" },
    },

    // ── Where it was received (identity + snapshot) ──
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseName: { type: String, trim: true, default: "" },
    locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationCode: { type: String, trim: true, default: "" },
    locationName: { type: String, trim: true, default: "" },

    // ── Supplier invoice / challan reference and the date claimed ──
    invoiceNumber: { type: String, trim: true, default: "" },
    receiptDate: { type: Date, default: Date.now },
    notes: { type: String, trim: true, default: "" },

    // ── V1 lifecycle. RECORDED means "receipt captured", NOT accepted/inspected.
    status: { type: String, enum: ["RECORDED", "VOID"], default: "RECORDED" },

    // ── Who recorded it ──
    recordedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
    },

    // ── The idempotency key of the operation that created it (replay safety) ──
    idempotencyKey: { type: String, trim: true, default: "" },

    lines: { type: [goodsReceiptLineSchema], default: [] },
  },
  { timestamps: true },
);

/* ── THE INVARIANTS A TYPE ALONE CANNOT EXPRESS ──────────────────────────────
   Conditional `required` covers "a purchase receipt has a purchase order". It
   cannot express "and a customer-material receipt has none of a purchase
   order's baggage", or "one receipt names one source document". Those are here,
   before any write, so an invalid combination is unsaveable rather than merely
   discouraged.

   This is what replaces the unconditional `required` that used to stand on
   `purchaseOrderId` and `poItemId`: the field got weaker, and the document did
   not. */
goodsReceiptSchema.pre("validate", function enforceSourceContract(next) {
  const lines = this.lines || [];
  const isPurchase = this.sourceType === SOURCE_TYPE.PURCHASE_ORDER;

  /* Every receipt names its source document generically. Back-filled from
     `purchaseOrderId` for a purchase receipt so nothing existing has to change
     to satisfy it. */
  if (!this.sourceDocumentId && isPurchase && this.purchaseOrderId) {
    this.sourceDocumentId = this.purchaseOrderId;
    if (!this.sourceDocumentNumber) this.sourceDocumentNumber = this.poNumber || "";
  }
  if (!this.sourceDocumentId) {
    return next(new Error("A goods receipt must name the source document it discharges."));
  }

  if (isPurchase) {
    /* A purchase line without its PO line cannot be reconciled against the
       order, which is the only thing a purchase receipt is for. */
    if (lines.some((l) => !l.poItemId)) {
      return next(new Error("Every purchase-order receipt line must name its purchase-order line."));
    }
    /* One receipt, one order. A receipt spanning two orders cannot be reconciled
       against either. */
    if (String(this.sourceDocumentId) !== String(this.purchaseOrderId)) {
      return next(new Error("A purchase receipt's source document must be its purchase order."));
    }
    return next();
  }

  /* ── CUSTOMER MATERIAL ───────────────────────────────────────────────── */
  if (this.purchaseOrderId || (this.poNumber || "").trim()) {
    return next(new Error("A customer-material receipt has no purchase order."));
  }
  if (this.supplierId || (this.supplierName || "").trim()) {
    return next(new Error("A customer-material receipt has no supplier: the customer sent the goods and nothing was bought."));
  }
  if ((this.invoiceNumber || "").trim()) {
    return next(new Error("A customer-material receipt has no supplier invoice. Record the customer's challan as customerMaterial.customerReference."));
  }
  if (!this.customerMaterial?.customerId) {
    return next(new Error("A customer-material receipt must name the customer whose goods these are."));
  }
  if (!this.customerMaterial?.expectationRevisionNo) {
    return next(new Error("A customer-material receipt must name the expectation revision it was received against."));
  }
  /* The stable cross-revision line identity. Without it a receipt cannot be
     matched to its line after a revision, which is the whole point of it. */
  if (lines.some((l) => !String(l.sourceLineRef || "").trim())) {
    return next(new Error("Every customer-material receipt line must name its expectation line reference."));
  }
  if (lines.some((l) => l.poItemId || l.spendLineId)) {
    return next(new Error("A customer-material receipt line carries no purchase-order or spend line."));
  }
  return next();
});

// Company-scoped uniqueness for the number; company-scoped lookups by PO,
// supplier and date for the register.
goodsReceiptSchema.index({ companyId: 1, receiptNumber: 1 }, { unique: true });
goodsReceiptSchema.index({ companyId: 1, purchaseOrderId: 1, createdAt: -1 });
goodsReceiptSchema.index({ companyId: 1, supplierId: 1, receiptDate: -1 });
goodsReceiptSchema.index({ companyId: 1, receiptDate: -1 });

/* ── THE CUSTOMER-MATERIAL INDEXES LIVE IN A MIGRATION, NOT HERE ────────────
   They are needed — "every receipt against this document" and "everything we
   hold for this customer" are the two questions asked of these receipts — and
   they are declared in `scripts/migrations/goods-receipt-source-contract.js`
   alongside the backfill, following the pattern the other store-purchase index
   migrations already use.

   The reason is specific and worth writing down, because the next person to add
   an index to this schema will hit it. Mongoose's `autoIndex` builds a model's
   indexes lazily, on first use, asynchronously. This collection is written
   INSIDE the goods-receipt transaction, and adding two more builds was enough to
   push one of them past the start of that transaction: the build takes
   collection locks, the transaction cannot acquire its own within mongod's 5ms
   `maxTransactionLockRequestTimeoutMillis`, the driver treats the timeout as a
   transient error and retries — and the retry re-saves a mongoose document whose
   `__v` the first attempt already bumped, so it fails with a VersionError that
   says nothing about indexes at all.

   Reproduced and bisected: with one added index the receipt suite passes, with
   two it fails, and reverting them restores it. An explicit migration builds
   them once, outside any transaction, which is where index creation belongs. */

const GoodsReceipt = mongoose.models.GoodsReceipt
  || mongoose.model("GoodsReceipt", goodsReceiptSchema);

module.exports = GoodsReceipt;
/* Named alongside the default export so existing `require(...)` callers are
   untouched while new ones can read the vocabulary. */
module.exports.SOURCE_TYPE = SOURCE_TYPE;
module.exports.SOURCE_TYPES = SOURCE_TYPES;
