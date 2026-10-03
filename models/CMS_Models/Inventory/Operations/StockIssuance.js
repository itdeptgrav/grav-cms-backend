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

  /* ── THE STICKER THIS LINE CAME OFF (2 Oct 2026) ─────────────────────
     When the line was scanned from a raw-item label, the label's own
     quantity moves with the issue (down on a debit, back up on a credit).
     What it read before and after is kept here so the movement can be
     explained from the issuance alone. */
  barcodeId:          { type: mongoose.Schema.Types.ObjectId, ref: "Barcode", default: null },
  barcodeQtyBefore:   { type: Number, default: null },
  barcodeQtyAfter:    { type: Number, default: null },
  barcodeUnit:        { type: String, default: "" },

  /* ── CUSTOMER-OWNED MATERIAL ────────────────────────────────────────────
     Present only when this line issued material the factory does not own — a
     job-work customer's fabric, handed to production against the one order line
     it was sent for.

     EXTENDED rather than given its own collection, deliberately. This is the
     canonical record of "material was handed over", and an issue of customer
     goods is that same act: the storekeeper does the same thing, production
     receives the same thing, and a report of what went to an order has to see
     both or it is not a report of what went to the order. A parallel issue
     collection is how two places start disagreeing about what production was
     given.

     What it adds is the OWNERSHIP, which a company-owned issue has no need of:
     the exact lot, whose goods they are, and which commercial line they belong
     to. Every one of these is required for a customer-material line and absent
     on an ordinary one — enforced by the header validator below, because a lot
     reference that might be missing is a traceability claim nobody can rely on. */
  /* Indexed by `scripts/migrations/customer-material-ownership-indexes.js`
     rather than here: a lazy index build on a collection written inside the
     issue transaction can push the build into that transaction and make it fail
     with an unrelated VersionError. See the long note on `Barcode.companyId`. */
  customerMaterialLotId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerMaterialLot", default: null },
  customerId:            { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
  customerLabel:         { type: String, trim: true, default: "" },
  /* Sales' own identities: the order, and the PERMANENT line within it. */
  orderRef:              { type: String, trim: true, default: "" },
  orderLineRef:          { type: String, trim: true, default: "" },
  executionFileId:       { type: mongoose.Schema.Types.ObjectId, default: null },
  /* Which customer-material document, revision and line this discharges. */
  expectationId:         { type: mongoose.Schema.Types.ObjectId, default: null },
  documentRef:           { type: String, trim: true, default: "" },
  expectationRevisionNo: { type: Number, default: null },
  expectationLineRef:    { type: String, trim: true, default: "" },
  /* Taken from exactly here. An issue that could not say which location it came
     out of cannot be reconciled against the location balance it moved. */
  warehouseId:           { type: mongoose.Schema.Types.ObjectId, default: null },
  warehouseName:         { type: String, trim: true, default: "" },
  locationId:            { type: mongoose.Schema.Types.ObjectId, default: null },
  locationCode:          { type: String, trim: true, default: "" },
  /* The physical movements this line caused, by stored id. */
  stockTransactionId:    { type: mongoose.Schema.Types.ObjectId, default: null },
  locationMovementId:    { type: mongoose.Schema.Types.ObjectId, default: null },
}, { _id: true });

const stockIssuanceSchema = new mongoose.Schema(
  {
    /* ── Chunk 1C: tenancy ─────────────────────────────────────────────────
       Server-owned, from the resolved tenant context only. An issuance is a
       stock movement, so it cannot be written without an owner; records
       predating the boundary have none and are legacy-global. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* Which user action produced this, so a replay is recognised rather than
       issuing the same stock twice. */
    idempotencyKey: { type: String, trim: true, default: "", index: true },

    direction: { type: String, enum: ["debit", "credit"], required: true },

    // Optional MO reference
    manufacturingOrder: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", default: null },
    moNumber:           { type: String, default: "" },
    customerName:       { type: String, default: "" },

    items:  [issuanceItemSchema],
    /* ── WHAT KIND OF HANDOVER THIS IS ────────────────────────────────────
       Defaults to COMPANY_OWNED so every issuance written before this field
       existed reads as what it was: the factory's own stock, which was the only
       kind there was. Not inferred from whether a lot happens to be set — an
       inference is a guess, and a guess about whose goods moved is the one this
       whole design exists to prevent. */
    ownership: {
      type: String,
      enum: ["COMPANY_OWNED", "CUSTOMER_OWNED"],
      default: "COMPANY_OWNED",
      required: true,
      /* Indexed by the migration — see `customerMaterialLotId` above. */
    },

    reason: { type: String, default: "" },
    notes:  { type: String, default: "" },

    performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    performedByName: { type: String, default: "" },
  },
  { timestamps: true }
);

stockIssuanceSchema.index({ manufacturingOrder: 1 });
stockIssuanceSchema.index({ createdAt: -1 });
stockIssuanceSchema.index({ direction: 1 });

/* ── A CUSTOMER-OWNED ISSUE MUST BE FULLY TRACEABLE, OR NOT EXIST ───────────
   Conditional `required` on a subdocument would have to reach its parent to
   learn the ownership, and reaching upward from inside an array subdocument
   fails wherever the parent is not attached — which is how a whole collection
   of ordinary issues starts failing with an unreadable cast error. So the
   invariant is here, where the parent is simply in scope.

   The claim being protected is not a formality. An issue of a customer's fabric
   that could not say WHICH lot it came out of, whose it was, or which commercial
   line it belonged to would be an untraceable movement of somebody else's
   property — and the only thing worse than not recording it is recording it in a
   way that cannot be audited. */
stockIssuanceSchema.pre("validate", function enforceOwnership(next) {
  const items = this.items || [];
  if (this.ownership !== "CUSTOMER_OWNED") {
    /* And the reverse: an ordinary issue must not quietly carry a lot. */
    if (items.some((i) => i.customerMaterialLotId)) {
      return next(new Error(
        "A company-owned issuance cannot name a customer-material lot. Set ownership to CUSTOMER_OWNED.",
      ));
    }
    return next();
  }
  if (!items.length) {
    return next(new Error("A customer-owned issuance must have at least one line."));
  }
  for (const i of items) {
    for (const [field, label] of [
      ["customerMaterialLotId", "the ownership lot"],
      ["customerId", "the customer whose goods these are"],
      ["orderRef", "the sales order"],
      ["orderLineRef", "the permanent sales order line"],
      ["expectationId", "the customer-material document"],
      ["expectationLineRef", "the document line"],
      ["locationId", "the location it came out of"],
    ]) {
      if (!i[field]) {
        return next(new Error(
          `A customer-owned issuance line must name ${label}; without it the movement cannot be audited.`,
        ));
      }
    }
  }
  return next();
});

/* The traceability read — everything issued from one lot — is indexed by
   `scripts/migrations/customer-material-ownership-indexes.js` and deliberately
   not declared here. See the note on `customerMaterialLotId`.

*/

module.exports =
  mongoose.models.StockIssuance ||
  mongoose.model("StockIssuance", stockIssuanceSchema);