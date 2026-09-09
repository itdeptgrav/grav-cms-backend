// models/CMS_Models/Inventory/Operations/PurchaseOrder.js

const mongoose = require("mongoose");

const purchaseOrderItemSchema = new mongoose.Schema(
  {
    rawItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
    },
    itemName: { type: String, trim: true},
    sku: { type: String, trim: true, default: "" },
    unit: { type: String, trim: true, default: "unit" }, // PO line unit
    baseUnit: { type: String, trim: true, default: "" }, // ← NEW: raw-item registered unit at PO time
    quantity: { type: Number, min: 0},
    unitPrice: { type: Number, min: 0 },
    totalPrice: { type: Number, min: 0, default: 0 }, // net line amount (qty × price)
    /* ── LINE-LEVEL TAX, RETAINED EXPLICITLY ────────────────────────────────
       A spend request prices tax per line — a laptop and an annual service
       contract can carry different GST rates — and collapsing them into one
       header figure loses the per-line fact the invoice is checked against.
       Declared on the line schema itself: this is a nested subdocument, and a
       nested schema discards values it does not declare regardless of the
       parent's `strict:false`. Additive and optional; a line without tax reads
       as zero, exactly as before. */
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    gstAmount: { type: Number, min: 0, default: 0 },
    /* The vendor's quote this line's terms were taken from, snapshotted so the
       order can be reconciled against the quote it was raised from. */
    quoteRef: { type: String, trim: true, default: "" },
    receivedQuantity: { type: Number, min: 0, default: 0 }, // (only one — remove the duplicate)
    pendingQuantity: { type: Number, min: 0, default: 0 },
    status: {
      type: String,
      enum: ["PENDING", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    variantId: { type: mongoose.Schema.Types.ObjectId },
    variantCombination: [{ type: String, trim: true }],
    variantName: { type: String, trim: true, default: "" },
    variantSku: { type: String, trim: true, default: "" },
    vendorNickname: { type: String, trim: true, default: "" },
    expectedDeliveryDate: { type: Date, default: null },
    itemCharges: [{
      label: { type: String, trim: true, default: "" },
      value: { type: String, default: "" },
      type: { type: String, enum: ["amount", "percent"], default: "amount" },
      amount: { type: Number, default: 0 },
    }],
    itemChargesTotal: { type: Number, min: 0, default: 0 },
  },
  { _id: true },
);

const deliverySchema = new mongoose.Schema(
  {
    deliveryDate: {
      type: Date,
      default: Date.now,
    },
    quantityReceived: {
      type: Number,
      min: 0,
    },
    invoiceNumber: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
    },
  },
  { timestamps: true },
);

// ── Return request receipt sub-doc ───────────────────────────────────────
const returnReceiptSchema = new mongoose.Schema(
  {
    quantityReceived: { type: Number,  min: 0 },
    receivedDate: { type: Date, default: Date.now },
    notes: { type: String, trim: true, default: "" },
    /* The operation that recorded this receipt — see RawItem.stockTransactions
       .operationId. Recovery matches on this and nothing else: an earlier
       receipt of the same quantity is not evidence that THIS attempt landed. */
    operationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    receivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
  },
  { timestamps: true },
);

// ── Return request sub-doc ───────────────────────────────────────────────
const returnRequestSchema = new mongoose.Schema(
  {
    poItemId: { type: mongoose.Schema.Types.ObjectId },
    rawItem: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "RawItem",
    },
    itemName: { type: String, trim: true},
    sku: { type: String, trim: true, default: "" },
    unit: { type: String, trim: true, default: "unit" },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    damagedQuantity: { type: Number,  min: 0 },
    returnedQuantity: { type: Number, default: 0, min: 0 },
    pendingReturnQty: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["PENDING", "PARTIAL", "COMPLETED", "CANCELLED"],
      default: "PENDING",
    },
    reason: { type: String, trim: true, default: "" },
    reportedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      default: null,
    },
    reportedAt: { type: Date, default: Date.now },
    /* The operation that raised this return. Recovery matches on this rather
       than on (item, quantity), which two separate returns can share. */
    operationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    receipts: [returnReceiptSchema],
  },
  { timestamps: true },
);

const paymentSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      default: Date.now,
    },
    amount: {
      type: Number,
      min: 0,
    },
    paymentMethod: {
      type: String,
      enum: ["CASH", "BANK_TRANSFER", "CHEQUE", "ONLINE", "OTHER"],
      default: "BANK_TRANSFER",
    },
    referenceNumber: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
    },
  },
  { timestamps: true },
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    // Basic Information
    /* ── THE APPROVED QUOTE THIS ORDER FULFILS ──────────────────────────────
       A purchase order used to have no link to anything upstream: it was
       raised by hand, and "was this approved?" could only be answered by
       somebody remembering. This ties it to the spend request finance agreed —
       the quote, the vendor, the figure and the budget head it was committed
       against.

       Optional, because the eighty orders that predate this were raised the
       old way and are not wrong for having no link. It is what lets an order
       raised FROM an approval be told apart from one typed in. */
    spendRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SpendRequest",
      /* Uniqueness (for non-null values) is enforced by the partial index
         below — one approved spend request converts to at most one order, so a
         double submission or a retry cannot mint a second. The same index
         serves the lookups this field is read by. */
    },
    spendRequestNumber: { type: String, trim: true },

    /* ── Chunk 1: tenancy ───────────────────────────────────────────────────
       Declared rather than left to `strict:false`, so it is indexed and can
       be reasoned about. Absent on every order that predates the boundary —
       those are legacy-global records, readable only in legacy mode. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    /* ── WHY THE UNIQUENESS IS COMPOUND AND NOT ON THE FIELD ────────────────
       Numbering is per company: two companies each start their own PO
       sequence at 1, which is what a tenant boundary means. A GLOBAL unique
       index on `poNumber` therefore makes the second company unable to raise
       its first order at all — the number is legitimately the same string.

       The uniqueness scope has to match the numbering scope, so it moves to
       the compound index below. Legacy numbers are untouched by this: they
       remain exactly as they are, and remain unique among themselves.

       MIGRATION NOTE — this schema change does NOT drop the pre-existing
       `poNumber_1` index on a database that already has one. Mongoose builds
       missing indexes; it never removes one. Until an authorised migration
       drops it, a multi-company deployment will still hit a duplicate-key
       error on the second company's first order. See
       docs/decisions/store-purchase-tenancy-permissions.md §6. */
    poNumber: {
      type: String,
      trim: true,
      required: [true, "PO number is required"],
    },
    vendor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Vendor",
      required: false,
      default: null,
    },
    isEmergencyOrder: { type: Boolean, default: false },
    vendorName: {
      type: String,
      trim: true,
      default: "",
    },

    // Order Details
    orderDate: {
      type: Date,
      default: Date.now,
    },
    expectedDeliveryDate: {
      type: Date,
      default: null,
    },

    // Items
    items: [purchaseOrderItemSchema],

    // Pricing
    subtotal: {
      type: Number,
      min: 0,
      default: 0,
    },
    taxRate: {
      type: Number,
      min: 0,
      max: 100,
      default: 0,
    },
    /* ── HOW TO READ `taxRate` ──────────────────────────────────────────────
       On a SINGLE_RATE order every line shares one GST rate and `taxRate`
       holds it. On a MIXED_RATE order the lines carry different rates, so no
       single number is the order's rate and `taxRate` is left 0 — which alone
       reads as "zero-rated", a false claim on an order that has tax. This says
       which case it is, so a reader never mistakes a mixed order for a tax-free
       one. The per-line `gstRate`/`gstAmount` stay authoritative either way.

       Defaults to SINGLE_RATE so every historical or manually-created order —
       which has one header `taxRate` — reads correctly without migration. */
    taxMode: {
      type: String,
      enum: ["SINGLE_RATE", "MIXED_RATE"],
      default: "SINGLE_RATE",
    },
    taxAmount: {
      type: Number,
      min: 0,
      default: 0,
    },
    shippingCharges: {
      type: Number,
      min: 0,
      default: 0,
    },
    discount: {
      type: Number,
      min: 0,
      default: 0,
    },
    customCharges: [
      {
        label: { type: String, trim: true, default: "" },
        amount: { type: Number, min: 0, default: 0 },
      },
    ],
    totalAmount: {
      type: Number,
      min: 0,
      default: 0,
    },

    // Delivery Tracking
    deliveries: [deliverySchema],

    returnRequests: [returnRequestSchema],

    totalReceived: {
      type: Number,
      min: 0,
      default: 0,
    },
    totalPending: {
      type: Number,
      min: 0,
      default: 0,
    },

    // Status
    status: {
      type: String,
      enum: ["DRAFT", "ISSUED", "PARTIALLY_RECEIVED", "COMPLETED", "CANCELLED"],
      default: "DRAFT",
    },

    // Payment Information
    paymentStatus: {
      type: String,
      enum: ["PENDING", "PARTIAL", "COMPLETED"],
      default: "PENDING",
    },
    payments: [paymentSchema],
    paymentTerms: {
      type: String,
      trim: true,
      default: "",
    },

    // Additional Info
    notes: {
      type: String,
      trim: true,
      default: "",
    },
    termsConditions: {
      type: String,
      trim: true,
      default: "",
    },
    piInvoiceNumber: {
      type: String,
      trim: true,
      default: "",
    },
    piInvoicePhoto: {
      type: String,
      trim: true,
      default: "",
    },

    // References
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
      required: [true, "Created by is required"],
    },
    approvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
    },
  },
  {
    timestamps: true,
    // Disable strict mode to allow additional fields
    strict: false,
  },
);

/* Uniqueness scoped to the tenant, matching how numbers are now allocated.
   `companyId: null` (a legacy-global order) still participates, so legacy
   numbers cannot be duplicated among themselves either. */
purchaseOrderSchema.index({ companyId: 1, poNumber: 1 }, { unique: true });
purchaseOrderSchema.index({ companyId: 1, status: 1, createdAt: -1 });

/* ── ONE PURCHASE ORDER PER APPROVED SPEND REQUEST ──────────────────────────
   The conversion writes `spendRequestId` back onto the order it produces. A
   concurrent double submission or a retry that lost the request→order link
   would otherwise create a second order for the same approval; the database
   refuses the second write instead, and the route catches the duplicate-key
   error and returns the order that already exists.

   Partial, on non-null values only: the eighty-odd orders that predate this
   were typed by hand with no spend request and must not collide with each
   other on a null key.

   MIGRATION NOTE — mongoose builds a missing index but never drops one, and
   this build fails if the collection already holds two live orders for one
   spend request. That would itself be the bug this prevents; resolve any such
   pair by hand before the index can be created. */
purchaseOrderSchema.index(
  { spendRequestId: 1 },
  {
    unique: true,
    name: "one_po_per_spend_request",
    partialFilterExpression: { spendRequestId: { $type: "objectId" } },
  },
);

module.exports = mongoose.model("PurchaseOrder", purchaseOrderSchema);
