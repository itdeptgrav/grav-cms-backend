// models/CMS_Models/StorePurchase/CustomerMaterialReturn.js
//
// THE CANONICAL RECORD OF MATERIAL GOING BACK TO ITS OWNER.
//
// A return used to leave no document of its own: the evidence was a movement
// appended to each lot, and recovery after an interrupted request looked for
// "any lot in this company with any RETURNED_TO_CUSTOMER movement". That is not
// evidence of anything. An unrelated return from last month made a failed new
// return look successful, and the operator was told their work had landed when
// nothing had moved.
//
// So a return is a DOCUMENT. One per operation, naming every lot it drew from and
// how much came out of each, keyed by the idempotency key of the request that
// created it. Recovery can then ask the only question worth asking: did THIS
// operation post, and did all of it post?
//
// ── WHY NOT REUSE StockIssuance WITH A CREDIT DIRECTION ─────────────────────
// Because a credit on that model means "material came back from the floor to
// Store" — the quantity is ours again and the shelf goes up. This is the
// opposite: the goods leave the building and are no longer ours to hold. Sharing
// a record with a flag would put two opposite facts in one collection, and every
// report that summed it would be wrong for one of them.
//
// ── AND IT IS NOT A SUPPLIER RETURN ─────────────────────────────────────────
// No purchase order, no vendor, no credit note, nothing payable. The factory
// never bought this material, so there is nothing to reverse — only a physical
// departure and the evidence of who handed it over and what they signed.
"use strict";

const mongoose = require("mongoose");

const r4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/** One lot this return drew from. */
const returnLineSchema = new mongoose.Schema({
  lotId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMaterialLot", required: true },
  goodsReceiptNumber: { type: String, trim: true, default: "" },
  /* The stable cross-revision line identity this lot was received against. */
  expectationLineRef: { type: String, trim: true, required: true },
  expectationRevisionNo: { type: Number, default: null },
  rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
  variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
  itemName: { type: String, trim: true, default: "" },
  quantity: { type: Number, required: true, min: 0.0001 },
  baseUnit: { type: String, trim: true, required: true },
  /* Where it left from, and the physical movements it caused — by stored id, so
     a reconciliation follows references rather than matching numbers. */
  warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
  locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
  locationCode: { type: String, trim: true, default: "" },
  stockTransactionId: { type: mongoose.Schema.Types.ObjectId, default: null },
  locationMovementId: { type: mongoose.Schema.Types.ObjectId, default: null },
  /* The exact movement appended to the lot. Named, not searched for. */
  lotMovementId: { type: mongoose.Schema.Types.ObjectId, default: null },
}, { _id: true });

const customerMaterialReturnSchema = new mongoose.Schema(
  {
    /* No `index: true` anywhere in this file — see the note below the schema on
       why a lazily built index and a transaction do not mix. */
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── THE OPERATION'S OWN IDENTITY ─────────────────────────────────────
       This is what recovery queries. `{companyId, idempotencyKey}` is unique, so
       a replay finds exactly the one operation its key created, or nothing —
       never somebody else's return that happens to look similar. */
    idempotencyKey: { type: String, trim: true, required: true },
    /* A second identity carried onto every movement this operation wrote, so a
       movement read in isolation can be traced back to the operation. */
    operationKey: { type: String, trim: true, required: true },

    /* ── WHOSE, AND AGAINST WHAT ──────────────────────────────────────────── */
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", required: true },
    customerLabel: { type: String, trim: true, default: "" },
    orderRef: { type: String, trim: true, required: true },
    /* The PERMANENT sales order line. */
    orderLineRef: { type: String, trim: true, default: "" },
    executionFileId: { type: mongoose.Schema.Types.ObjectId, ref: "ExecutionFile", required: true },
    /* The STABLE document reference, which survives a revision — this is the
       identity the route addresses and the lots are bound to. */
    documentRef: { type: String, trim: true, required: true },
    expectationId: { type: mongoose.Schema.Types.ObjectId, required: true },

    lines: { type: [returnLineSchema], default: [] },

    reason: { type: String, trim: true, required: true, maxlength: 1000 },
    /* What the customer signed for. Not an invoice — nothing was bought. */
    customerReference: { type: String, trim: true, default: "" },

    /* ── TWO DATES, BECAUSE THEY ARE TWO FACTS ────────────────────────────
       `effectiveAt` is when the material actually went back; `recordedAt` is when
       somebody typed it in. They are routinely days apart — a lorry leaves on
       Friday and the paperwork is done on Monday — and collapsing them loses the
       only one a customer will argue about. The effective date used to be parsed,
       returned to the browser and then thrown away. */
    effectiveAt: { type: Date, required: true },
    recordedAt: { type: Date, required: true, default: Date.now },

    recordedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      name: { type: String, trim: true, default: "" },
    },
  },
  { timestamps: true, collection: "customer_material_returns" },
);

/* ── ONE RETURN PER KEY — AND THE INDEX IS DECLARED IN THE MIGRATION ─────────
   The uniqueness this collection needs is
   `{ companyId, idempotencyKey }`, unique, partial on a non-empty key — the last
   line of defence behind the idempotency claim, and what makes recovery exact: a
   key maps to at most one operation.

   IT IS NOT DECLARED HERE, AND THE REASON IS A BUG THAT HAPPENED TWICE.
   Mongoose builds a schema's indexes LAZILY, on the collection's first use. This
   collection's first use is INSIDE the return transaction. The build then lands
   within the transaction, takes the collection lock, hits the 5 ms transaction
   lock timeout, and surfaces as a transient error retried by `withTransaction` —
   which reports a `VersionError` about modified paths and says nothing whatsoever
   about indexes. It cost a long bisect on `goodsreceipts`, and then the same
   again on `barcodes`.

   So the specs live in `scripts/migrations/customer-material-ownership-indexes.js`
   (dry-run by default) where building an index is the operation rather than a
   side effect, and the service's own lookup guards the real case in the meantime.
   Nothing here declares an index. */

/* Every line must carry a quantity, or the document cannot prove what it moved —
   which is the whole reason it exists. */
customerMaterialReturnSchema.pre("validate", function hasLines(next) {
  const lines = this.lines || [];
  if (!lines.length) return next(new Error("A customer return must name at least one lot."));
  const total = r4(lines.reduce((s, l) => s + (Number(l.quantity) || 0), 0));
  if (!(total > 0)) return next(new Error("A customer return must move a quantity greater than zero."));
  return next();
});

module.exports = {
  CustomerMaterialReturn: mongoose.models.CustomerMaterialReturn
    || mongoose.model("CustomerMaterialReturn", customerMaterialReturnSchema),
};
