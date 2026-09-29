// models/CMS_Models/Inventory/Operations/Barcode.js
//
// Each document represents ONE printed barcode/QR sticker against a raw-item
// variant. The MongoDB _id of this document is what gets encoded in the QR code.
//
// Stickers are produced in two places, and both write the same shape:
//   · Product Marking (store/operations/barcode-generator) — ad-hoc labelling
//   · Goods receipt   (purchase-order/:id/receive)         — labelling a delivery
// The receive path additionally records where the lot came from and what it
// cost (vendor, purchaseOrderItemId, unitPrice), which is what makes a scan
// able to answer "when did this arrive, from whom, at what price".
//
// ── AND A THIRD PLACE, WHOSE STOCK IS NOT OURS ──────────────────────────────
// Customer-supplied material on a job-work order also gets labelled, and its
// label has to say something the other two never do: THIS IS NOT OURS. A roll of
// a customer's fabric sitting beside our own, with a sticker that looks the same,
// will be cut for the wrong order — and the person who does it will have had no
// way to know.
//
// So a customer-owned label carries the ownership lot and everything that makes
// the material unusable for anything else, and it carries NO vendor, NO price and
// NO purchase reference, because nothing was bought. The existing two paths are
// untouched: `customerMaterial` is absent on every label they produce.
//
// `cuttingSessions` tracks each cutting session against this fabric roll.
// A session is open while closedAt is null; once closed, endQty is set and
// the parent `quantity` is updated to that endQty (so the next session's
// startQty picks up where this one left off).

const mongoose = require("mongoose");

// ── Cutting session sub-doc ─────────────────────────────────────────────────
// Lean — only what's needed to log what happened during one cutting run.
const cuttingSessionSchema = new mongoose.Schema(
  {
    startQty: { type: Number, required: true, min: 0 },
    endQty:   { type: Number, default: null,    min: 0 },

    // Each scanned piece barcode (e.g. "WO-69abc123-001") as a plain string
    scannedPieces: [{ type: String, trim: true }],

    startedAt: { type: Date, default: Date.now },
    closedAt:  { type: Date, default: null },
  },
  { _id: true }
);

const barcodeSchema = new mongoose.Schema(
  {
    // ── What this barcode represents ─────────────────────────────────────────
    /* ── WHOSE COMPANY PRINTED IT ─────────────────────────────────────────
       Added with customer ownership, and for a reason that is specifically about
       it: a scan has to be refusable across companies, and until now there was
       nothing on a barcode to refuse it by. A label for a customer's fabric that
       could be scanned from another tenant would disclose that customer's order,
       their material and their quantities to somebody with no relationship to
       them.

       Defaulted null so every existing label is unaffected and keeps scanning.
       A customer-owned label is REQUIRED to carry it — see the validator. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      default: null,
      /* ── NO `index: true`, AND THE REASON IS NOT TASTE ──────────────────
         This collection is written INSIDE the goods-receipt transaction, and
         mongoose builds a schema's indexes lazily on first use of the
         collection. Adding a build here pushed one past the start of that
         transaction: the build takes collection locks, the transaction cannot
         acquire its own within mongod's 5ms lock timeout, the driver treats the
         timeout as transient and retries, and the retry re-saves a document
         whose `__v` the first attempt already bumped — failing with a
         VersionError that says nothing about indexes at all.

         Diagnosed once already on `GoodsReceipt` and reproduced here exactly:
         `goods-receipt.route.test.js` went from 22/22 to failing 2 runs in 3 on
         its multi-line receipt. The indexes are real and needed; they are built
         by `scripts/migrations/customer-material-ownership-indexes.js`, outside
         any transaction, which is where index creation belongs. */
    },

    rawItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
      required: true,
      index: true,
    },
    rawItemName: { type: String, trim: true, default: "" },
    rawItemSku:  { type: String, trim: true, default: "" },

    // Variant reference (a raw item may have multiple variants)
    variantId:          { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    variantSku:         { type: String, trim: true, default: "" },

    // ── Printed quantity ─────────────────────────────────────────────────────
    quantity: { type: Number, required: true, min: 0 },
    unit:     { type: String, required: true, trim: true },

    // ── Optional PO link (nullable) ──────────────────────────────────────────
    purchaseOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      default: null,
      index: true,
    },
    purchaseOrderNumber: { type: String, trim: true, default: "" },

    // Which PO line the stock came in against. A PO can carry the same raw item
    // on more than one line at different prices, so the line is what pins the
    // price below to a specific purchase — the PO id alone would not.
    purchaseOrderItemId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Where it came from and what it cost ──────────────────────────────────
    // Captured when the sticker is printed at goods-receipt, and deliberately
    // stored rather than looked up later: the vendor's price on a raw item
    // changes over time, so a scan months from now must report what THIS lot
    // actually cost, not today's rate.
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      default: null,
      index: true,
    },
    // Denormalised for the same reason rawItemName and purchaseOrderNumber are:
    // a scan renders the label's own facts without joining three collections.
    vendorName: { type: String, trim: true, default: "" },

    // Per-unit purchase price from the PO line, in rupees.
    unitPrice: { type: Number, default: null, min: 0 },

    // ── Audit ────────────────────────────────────────────────────────────────
    generatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },

    /* ── THE ARRIVAL THIS LABEL BELONGS TO ────────────────────────────────
       A company-owned label carried the purchase order and the supplier but
       never the RECEIPT, although the receipt is the document that proves the
       goods physically arrived and in what quantity. Without it a label printed
       from a receipt could only claim the order it discharges, and a store
       person holding a sticker could not get back to the delivery it came off.

       Customer-owned labels have carried this since they existed, inside
       `customerMaterial`. These are the same three facts for the ordinary case,
       deliberately named the same way. Null on a label printed from stock on
       hand rather than from an arrival — that is an honest absence, not a gap. */
    goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
    goodsReceiptNumber: { type: String, trim: true, default: "" },
    goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── WHICH PRINT RUN MINTED THIS ──────────────────────────────────────
       A thermal printer that times out is the ordinary case, and the operator
       presses Print again. Without a key that second press minted a second set
       of identities for the same physical rolls, and two stickers claiming the
       same 20 metres is exactly the failure labels exist to prevent.

       `printBatchKey` is the client's stable intent for one run — not a
       timestamp, which differs on every retry and would defeat the whole
       mechanism. `printBatchSeq` is this label's position in that run, so a
       PARTIAL batch can be told apart from a complete one and completed rather
       than restarted. Customer-owned labels solve the same problem with
       `customerMaterial.printKey`; this is its company-owned counterpart. */
    printBatchKey: { type: String, trim: true, default: "" },
    printBatchSeq: { type: Number, default: null, min: 1 },

    // ── Cutting sessions ─────────────────────────────────────────────────────
    /* ── CUSTOMER-OWNED MATERIAL ──────────────────────────────────────────
       Present only on a label for material the factory does not own. Its whole
       job is to make a scan able to say, without any further lookup, whose goods
       these are and which single order line they may be used for.

       There is deliberately no price, no vendor and no purchase reference in
       here, and the validator below refuses the ones that live at the top level
       of this schema — because a customer-owned label carrying `unitPrice` would
       put a number on somebody else's property. */
    customerMaterial: {
      /* Indexed by the migration, not here — see the note on `companyId`. */
      lotId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMaterialLot", default: null },
      /* The arrival this label belongs to. */
      goodsReceiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
      goodsReceiptNumber: { type: String, trim: true, default: "" },
      goodsReceiptLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
      /* Whose. */
      customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
      customerLabel: { type: String, trim: true, default: "" },
      customerCode: { type: String, trim: true, default: "" },
      /* For which order, and which PERMANENT line of it. */
      orderRef: { type: String, trim: true, default: "" },
      orderLineRef: { type: String, trim: true, default: "" },
      executionFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
      /* Against which document, revision and line. */
      documentRef: { type: String, trim: true, default: "" },
      expectationRevisionNo: { type: Number, default: null },
      expectationLineRef: { type: String, trim: true, default: "" },
      /* Where it is. */
      warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
      warehouseName: { type: String, trim: true, default: "" },
      locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
      locationCode: { type: String, trim: true, default: "" },
      /* Which print this is. 1 is the original; a REPRINT does not increment it,
         because reprinting the same label is not a second label and must not look
         like a second arrival. */
      printCount: { type: Number, default: 1, min: 1 },
      lastPrintedAt: { type: Date, default: null },

      /* ── THE ALLOCATION THIS LABEL IS ─────────────────────────────────────
         A label is not a description of a lot; it is a CLAIM on part of it. Six
         rolls in one delivery are six labels, each naming the metres on that
         roll, and the six together may not exceed what the lot holds — otherwise
         two people pick up two rolls both marked with the same 300 metres and
         one of them is wrong.

         `allocationRef` names the claim (`<receipt>/L<n>`), `allocationSeq` is
         its number within the lot, and both are stamped at creation so a sticker
         found on a floor can be traced to the exact claim rather than to "one of
         this lot's labels". */
      allocationRef: { type: String, trim: true, default: "" },
      allocationSeq: { type: Number, default: null, min: 1 },

      /* ── FIRST-PRINT IDEMPOTENCY ──────────────────────────────────────────
         A printer that times out is the ordinary case, and the operator presses
         Print again. With the same key that second press RETURNS the first label
         instead of allocating a second claim on the same material. */
      printKey: { type: String, trim: true, default: "" },
    },

    cuttingSessions: [cuttingSessionSchema],
  },
  { timestamps: true }
);

/* ── A CUSTOMER-OWNED LABEL CARRIES NO PURCHASE, AND PROVES ITS OWNERSHIP ────
   Both halves matter. Without the first, a label could put a unit price on
   somebody else's fabric. Without the second, a scan could present customer
   material as ordinary stock — which is the single failure this label exists to
   prevent, and it fails silently. */
barcodeSchema.pre("validate", function enforceOwnership(next) {
  const cm = this.customerMaterial || {};
  if (!cm.lotId) {
    /* An ordinary label. Untouched, and it must not carry ownership fields
       half-filled — a partial claim is worse than none. */
    if (cm.customerId || (cm.documentRef || "").trim()) {
      return next(new Error(
        "A barcode naming a customer or a customer-material document must also name its ownership lot.",
      ));
    }
    return next();
  }
  if (!this.companyId) {
    return next(new Error("A customer-owned label must name the company that printed it, so a scan can be refused across companies."));
  }
  for (const [field, label] of [
    ["customerId", "the customer whose material this is"],
    ["orderRef", "the sales order"],
    ["orderLineRef", "the permanent sales order line"],
    ["documentRef", "the customer-material document"],
    ["expectationLineRef", "the document line"],
  ]) {
    if (!cm[field]) {
      return next(new Error(`A customer-owned label must name ${label}.`));
    }
  }
  if (this.vendor || (this.vendorName || "").trim()) {
    return next(new Error("A customer-owned label has no vendor: the customer sent the material and nothing was bought."));
  }
  if (this.unitPrice !== null && this.unitPrice !== undefined) {
    return next(new Error("A customer-owned label carries no price. Nothing was bought, and the material is not ours to value."));
  }
  if (this.purchaseOrder || (this.purchaseOrderNumber || "").trim()) {
    return next(new Error("A customer-owned label has no purchase order."));
  }
  return next();
});

barcodeSchema.index({ rawItem: 1, variantId: 1, createdAt: -1 });
/* ── ONE LABEL PER (BATCH, POSITION) ────────────────────────────────────────
   The index IS the idempotency: a retried print run re-inserts the same
   (company, key, seq) triples and the database refuses the duplicates, so a
   second press cannot mint a second identity however the request is retried.
   Partial — labels with no batch key (every existing one, and every one printed
   before this) are untouched and unconstrained.

   Built by `scripts/migrations/customer-material-ownership-indexes.js` rather
   than lazily, for the reason spelled out on `companyId` above: an index build
   inside the goods-receipt transaction takes collection locks the transaction
   then cannot acquire. */
barcodeSchema.index(
  { companyId: 1, printBatchKey: 1, printBatchSeq: 1 },
  { unique: true, partialFilterExpression: { printBatchKey: { $type: "string", $gt: "" } } },
);

module.exports =
  mongoose.models.Barcode || mongoose.model("Barcode", barcodeSchema);