// models/Accountant_model/Acc_VoucherModels.js
// =============================================================================
// TALLY VOUCHER MODELS
// -----------------------------------------------------------------------------
// In Tally, every accounting event is a Voucher. We mirror the same 8 voucher
// types Tally Prime ships with, plus the line-item structure (multiple ledger
// entries per voucher, optional inventory entries, optional bill-wise refs).
//
// Why one model with a `voucherType` discriminator (instead of 8 separate
// schemas)? — accountants run reports across types ("Day Book", "Trial
// Balance"); collapsing them into one collection keeps those queries simple
// and the indexes hot. We still validate per-type in the application layer.
// =============================================================================

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCHEMA: Ledger entry line (one Dr/Cr line of a voucher)
// ─────────────────────────────────────────────────────────────────────────────
const ledgerEntrySchema = new mongoose.Schema(
  {
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    ledgerName: { type: String, required: true, trim: true }, // denormalised — survives ledger renames
    groupName: { type: String, trim: true },

    // Tally records every line as either a debit or a credit, with an
    // unsigned amount. We keep both `type` + `amount` (industry-standard
    // representation) AND a signed `signedAmount` for fast balance maths.
    type: { type: String, enum: ["Dr", "Cr"], required: true },
    amount: { type: Number, required: true, min: 0 },
    signedAmount: { type: Number }, // +ve for Dr, -ve for Cr — auto-set in pre-save

    // Bill-wise allocations (Tally's "Bill-wise Details" pop-up)
    billAllocations: [
      {
        billName: { type: String, trim: true }, // bill no / reference
        billType: {
          type: String,
          enum: ["new_ref", "agst_ref", "advance", "on_account"],
          default: "new_ref",
        },
        amount: { type: Number, default: 0 },
        dueDate: { type: Date },
        creditDays: { type: Number, default: 0 },
      },
    ],

    // Cost-centre allocation
    costCentreAllocations: [
      {
        costCentreId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Acc_CostCentre",
        },
        costCentreName: { type: String, trim: true },
        amount: { type: Number, default: 0 },
      },
    ],

    // GST classification at the line level
    gstClassification: { type: String, trim: true }, // "Taxable", "Exempt", "Nil-Rated", "Non-GST"
    isPartyLedger: { type: Boolean, default: false },
    isDeemedPositive: { type: Boolean, default: true },

    narration: { type: String, trim: true },
  },
  { _id: true },
);

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCHEMA: Inventory entry (only on Sales/Purchase/CN/DN/Stock-Journal)
// ─────────────────────────────────────────────────────────────────────────────
const inventoryEntrySchema = new mongoose.Schema(
  {
    stockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_StockItem",
    },
    stockItemName: { type: String, required: true, trim: true },

    quantity: { type: Number, required: true },
    unit: { type: String, trim: true },
    rate: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },

    amount: { type: Number, required: true }, // qty × rate − discount

    hsnCode: { type: String, trim: true },
    godownId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Godown" },
    godownName: { type: String, trim: true },
    batchName: { type: String, trim: true },

    // Per-line tax (some accountants prefer line-level, others voucher-level)
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },

    // Sales/purchase ledger this line posts against (optional — voucher-level
    // sales ledger is the more common pattern)
    accountingLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Ledger",
    },
    accountingLedgerName: { type: String, trim: true },
  },
  { _id: true },
);

// ─────────────────────────────────────────────────────────────────────────────
// SUB-SCHEMA: GST breakup (carried on the voucher header)
// ─────────────────────────────────────────────────────────────────────────────
const gstBreakupSchema = new mongoose.Schema(
  {
    cgst: { type: Number, default: 0 },
    sgst: { type: Number, default: 0 },
    igst: { type: Number, default: 0 },
    cess: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// MAIN SCHEMA: TALLY VOUCHER
// ─────────────────────────────────────────────────────────────────────────────
const tallyVoucherSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },

    // ─── Voucher identification ─────────────────────────────────────────────
    // Tally's 8 default voucher types. Custom voucher types (e.g. "Sales Export"
    // as a class of "sales") store the parent in `voucherType` and the
    // user-facing name in `voucherTypeName`.
    voucherType: {
      type: String,
      enum: [
        "sales",
        "purchase",
        "receipt",
        "payment",
        "contra", // bank ↔ bank or cash ↔ bank
        "journal", // adjustments
        "credit_note", // sales return / customer credit
        "debit_note", // purchase return / vendor debit
        "stock_journal", // inventory transfer
        "delivery_note",
        "receipt_note",
        "rejection_in",
        "rejection_out",
        "physical_stock",
      ],
      required: true,
      index: true,
    },
    voucherTypeName: { type: String, trim: true }, // user-facing label

    voucherNumber: { type: String, required: true, trim: true, index: true },
    referenceNumber: { type: String, trim: true }, // e.g. supplier invoice no
    referenceDate: { type: Date },

    voucherDate: { type: Date, required: true, index: true },

    // Due date for AR/AP tracking. Optional. When set, the Invoices
    // page uses this to compute "overdue" status; otherwise it falls
    // back to voucherDate + credit-period heuristic.
    dueDate: { type: Date, index: true },

    // Free-text payment terms displayed on the invoice (e.g. "Net 30",
    // "Due on receipt", "2/10 Net 30"). The form lets the user type
    // anything; if they pick a common pattern we may parse dueDate from
    // it but typically dueDate is set directly.
    paymentTerms: { type: String, trim: true },

    // Reminder log — when the user clicks "Send reminder" on the
    // Invoices page, we append a row here. Not the same as sending an
    // email — just an audit trail of when reminders were issued.
    reminderLog: [
      {
        sentAt: { type: Date, default: Date.now },
        sentBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Acc_Department",
        },
        sentByName: { type: String, trim: true },
        channel: {
          type: String,
          enum: ["email", "sms", "whatsapp", "phone", "in_person", "other"],
          default: "other",
        },
        note: { type: String, trim: true },
      },
    ],

    // ─── Party (optional — sales/purchase/receipt/payment/CN/DN have one) ───
    partyLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
    partyLedgerName: { type: String, trim: true },
    partyGstin: { type: String, trim: true },
    placeOfSupply: { type: String, trim: true },
    placeOfSupplyCode: { type: String, trim: true }, // GST state code

    // ─── Shipping address (Consignee / Ship-to) ─────────────────────────────
    // Snapshot at voucher creation. Independent of the party ledger so a
    // later edit to the customer's saved address doesn't retroactively
    // rewrite invoices that already shipped. Mirrors the buyer fields
    // we already keep on `partyLedger*` + place-of-supply. Set on sales
    // invoices; ignored for receipts/payments/etc.
    shippingAddress: {
      name: { type: String, trim: true },
      addressLines: [{ type: String, trim: true }],
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      stateCode: { type: String, trim: true },
      pincode: { type: String, trim: true },
      country: { type: String, default: "India", trim: true },
      gstin: { type: String, trim: true },
    },

    // ─── Dispatch details (printed in the invoice header) ───────────────────
    // The fields that appear in the Tally-style invoice header's right-hand
    // meta block and the consignee row. All optional. Captured per-invoice on
    // the sales-voucher form's "Dispatch Details" section so the exported PDF
    // can show them (previously these cells were hardcoded blank).
    //
    // Buyer's-order + delivery-note + dispatch-doc + transport-carrier are the
    // standard fields a GST tax invoice prints. The invoice PUT route already
    // referenced several of these as editable; this is their schema home.
    dispatchDetails: {
      // "Delivery Note No(s)" — can be several; stored as a free string the
      // user types (e.g. "DN/12, DN/13") so multiple notes fit one cell.
      deliveryNoteNumbers: { type: String, trim: true },
      deliveryNoteDate: { type: Date },

      buyersOrderNumber: { type: String, trim: true },
      buyersOrderDate: { type: Date },

      dispatchDocNumber: { type: String, trim: true },
      dispatchedThrough: { type: String, trim: true },
      destination: { type: String, trim: true },

      // "Other References" — free text printed in the header meta block
      otherReferences: { type: String, trim: true },

      // Transport / shipping
      carrierName: { type: String, trim: true }, // Carrier Name / Agent
      billOfLadingNumber: { type: String, trim: true }, // Bill of Lading / LR-RR No.
      motorVehicleNumber: { type: String, trim: true },
      dispatchDate: { type: Date }, // the "Date:" under dispatch details

      termsOfDelivery: { type: String, trim: true },
    },

    // ─── Lines ──────────────────────────────────────────────────────────────
    ledgerEntries: { type: [ledgerEntrySchema], default: [] },
    inventoryEntries: { type: [inventoryEntrySchema], default: [] },

    // ─── Totals ─────────────────────────────────────────────────────────────
    subtotal: { type: Number, default: 0 },
    discountTotal: { type: Number, default: 0 },
    gstBreakup: { type: gstBreakupSchema, default: () => ({}) },
    totalTax: { type: Number, default: 0 },
    roundOff: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true },
    amountInWords: { type: String, trim: true },

    // ─── Validation: total Dr must equal total Cr ─────────────────────────────
    totalDebit: { type: Number, default: 0 },
    totalCredit: { type: Number, default: 0 },
    isBalanced: { type: Boolean, default: false },

    // ─── Narration (header-level note) ──────────────────────────────────────
    narration: { type: String, trim: true },

    // ─── Credit / Debit Note specifics ─────────────────────────────────────
    // GSTR-1 9B/9C compliance. These fields are only meaningful when
    // voucherType is "credit_note" or "debit_note"; they remain null on
    // every other voucher type and don't affect their validation.
    //
    // originalInvoice links the CN back to the sales invoice it's reversing.
    // Required for GSTR-1 Table 9B mapping when the customer is registered.
    // For standalone CNs (e.g. goodwill discount with no specific invoice),
    // this stays empty.
    originalInvoice: {
      voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Voucher" },
      voucherNumber: { type: String, trim: true },
      voucherDate: { type: Date },
    },

    // originalBill is the AP mirror of originalInvoice — links a debit
    // note back to the purchase voucher it's reversing (or supplements).
    // Captures both our internal voucher # and the supplier's invoice #
    // so GSTR-2B reconciliation can match either way.
    originalBill: {
      voucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Voucher" },
      voucherNumber: { type: String, trim: true }, // our voucher #
      supplierInvoiceNumber: { type: String, trim: true }, // their bill #
      voucherDate: { type: Date },
    },

    // The GST reason code as required on the e-invoice / GSTR-1 9B export.
    // The six codes below are the canonical Indian GST reasons for issuing
    // a CN — every accounting software in India uses this same list.
    creditNoteReason: {
      type: String,
      enum: [
        "sales_return", // goods returned by customer
        "post_sale_discount", // discount given after invoicing
        "deficiency_service", // service was deficient
        "correction_invoice", // wrong amount on original invoice
        "change_pos", // change in place of supply
        "others",
        null,
      ],
      default: null,
    },

    // GST reason code for debit notes — AP-side mirror. Reported on
    // GSTR-1 Table 9B (supplier's side) or GSTR-2 as appropriate. Same
    // canonical reason list flipped to the buyer's perspective.
    debitNoteReason: {
      type: String,
      enum: [
        "purchase_return", // goods returned to vendor
        "price_correction", // vendor overcharged us
        "deficiency_service", // service was deficient
        "shortage_quantity", // less than billed received
        "rate_difference", // post-bill price renegotiation
        "others",
        null,
      ],
      default: null,
    },

    // Whether stock physically came back with this credit note. When true,
    // inventoryEntries holds the item-wise return details. Captured but a
    // separate stock journal is NOT auto-posted here — most accountants
    // prefer to handle inventory movements manually after a return.
    affectsInventory: { type: Boolean, default: false },

    // ─── Payment instrument details ────────────────────────────────────────
    // Used by Receipt and Payment vouchers to record HOW the money moved.
    // Cash receipts don't need an instrument number; cheques and bank
    // transfers do. Optional everywhere — won't affect other voucher types.
    paymentMode: {
      type: String,
      enum: [
        "cash",
        "cheque",
        "neft",
        "rtgs",
        "imps",
        "upi",
        "card",
        "online",
        "other",
        null,
      ],
      default: null,
    },
    instrumentNumber: { type: String, trim: true }, // cheque number / UTR / UPI ref
    instrumentDate: { type: Date }, // cheque date (may differ from voucher date)
    bankName: { type: String, trim: true }, // for cheque clearing context

    // ─── Status ─────────────────────────────────────────────────────────────
    // pending_approval is the state used when an Editor creates a voucher
    // but the org requires owner/approver review before it posts. It maps
    // to an Acc_ApprovalRequest row; approve flips it to "posted", reject to
    // "cancelled".
    status: {
      type: String,
      enum: ["draft", "pending_approval", "posted", "cancelled", "void"],
      default: "draft",
      index: true,
    },

    // Optimistic / pessimistic — Tally treats some vouchers as "Optional"
    // (planning-only, not posted to the ledger).
    isOptional: { type: Boolean, default: false },

    // ─── e-Acc_Invoice / e-Way Bill (sales) ─────────────────────────────────────
    eInvoiceDetails: {
      irn: { type: String, trim: true },
      ackNumber: { type: String, trim: true },
      ackDate: { type: Date },
      qrCode: { type: String, trim: true },
      signedInvoiceFile: { type: String, trim: true },
    },
    eWayBillDetails: {
      ewbNumber: { type: String, trim: true },
      ewbDate: { type: Date },
      validUpto: { type: Date },
      transporter: { type: String, trim: true },
      vehicleNo: { type: String, trim: true },
      distance: { type: Number, default: 0 },
    },

    // ─── CMS bridge ─────────────────────────────────────────────────────────
    sourceSystem: {
      type: String,
      enum: [
        "manual",
        "auto_from_quotation",
        "auto_from_po",
        "auto_from_payroll",
        "expense_module",
        "tally_import",
      ],
      default: "manual",
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    sourceReference: { type: String, trim: true },

    // ─── Tally provenance ───────────────────────────────────────────────────
    tallyGuid: { type: String },
    importedAt: { type: Date },
    importSession: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_ImportSession",
    },

    // ─── Audit ──────────────────────────────────────────────────────────────
    financialYear: { type: String, index: true },
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    enteredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
    postedAt: { type: Date },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, trim: true },

    // ─── Approval workflow ──────────────────────────────────────────────────
    // When an Editor (a user without canPostDirectly) creates a sales voucher,
    // it is saved as status "pending_approval" (a draft that is NOT posted to
    // any ledger). An Owner/Approver then approves it (→ posted, balances
    // applied) or rejects it (→ cancelled, with a reason). These fields record
    // who did what, for the audit timeline.
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    submittedByName: { type: String, trim: true },
    submittedAt: { type: Date },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    approvedByName: { type: String, trim: true },
    approvedAt: { type: Date },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    rejectedByName: { type: String, trim: true },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
  },
  { timestamps: true, collection: "acc_vouchers" },
);

// ─────────────────────────────────────────────────────────────────────────────
// PRE-SAVE: compute signedAmount + totals + balance flag + financial year
// ─────────────────────────────────────────────────────────────────────────────
tallyVoucherSchema.pre("save", function (next) {
  // Signed amount per line
  this.ledgerEntries.forEach((l) => {
    l.signedAmount = l.type === "Dr" ? l.amount : -l.amount;
  });

  // Dr / Cr totals
  this.totalDebit = this.ledgerEntries.reduce(
    (s, l) => s + (l.type === "Dr" ? l.amount : 0),
    0,
  );
  this.totalCredit = this.ledgerEntries.reduce(
    (s, l) => s + (l.type === "Cr" ? l.amount : 0),
    0,
  );
  this.isBalanced = Math.abs(this.totalDebit - this.totalCredit) < 0.01;

  // GST aggregate
  if (this.gstBreakup) {
    this.gstBreakup.total =
      (this.gstBreakup.cgst || 0) +
      (this.gstBreakup.sgst || 0) +
      (this.gstBreakup.igst || 0) +
      (this.gstBreakup.cess || 0);
    this.totalTax = this.gstBreakup.total;
  }

  // Financial year string ("2025-26") from voucherDate
  if (this.voucherDate && !this.financialYear) {
    const d = new Date(this.voucherDate);
    const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
    this.financialYear = `${y}-${(y + 1).toString().slice(2)}`;
  }

  next();
});

// ─────────────────────────────────────────────────────────────────────────────
// INDEXES
// ─────────────────────────────────────────────────────────────────────────────
tallyVoucherSchema.index({ companyId: 1, voucherDate: -1 });
tallyVoucherSchema.index(
  { companyId: 1, voucherType: 1, voucherNumber: 1 },
  { unique: true },
);
tallyVoucherSchema.index({ companyId: 1, partyLedgerId: 1 });
tallyVoucherSchema.index({ companyId: 1, financialYear: 1 });
tallyVoucherSchema.index({ "ledgerEntries.ledgerId": 1, voucherDate: -1 });

// ─────────────────────────────────────────────────────────────────────────────
// STATIC: get the next voucher number for a given company + type
// ─────────────────────────────────────────────────────────────────────────────
tallyVoucherSchema.statics.nextVoucherNumber = async function (
  companyId,
  voucherType,
  prefix,
) {
  const fmtPrefix =
    prefix ||
    {
      sales: "SL",
      purchase: "PU",
      receipt: "RC",
      payment: "PY",
      contra: "CN",
      journal: "JV",
      credit_note: "CR",
      debit_note: "DR",
      stock_journal: "SJ",
    }[voucherType] ||
    "VC";

  const today = new Date();
  const fy =
    today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  const fyShort = `${fy.toString().slice(2)}${(fy + 1).toString().slice(2)}`;

  const last = await this.findOne({
    companyId,
    voucherType,
    financialYear: `${fy}-${(fy + 1).toString().slice(2)}`,
  })
    .sort({ createdAt: -1 })
    .select("voucherNumber")
    .lean();

  let seq = 1;
  if (last && last.voucherNumber) {
    const match = last.voucherNumber.match(/(\d+)$/);
    if (match) seq = parseInt(match[1], 10) + 1;
  }
  return `${fmtPrefix}/${fyShort}/${seq.toString().padStart(5, "0")}`;
};

// ─────────────────────────────────────────────────────────────────────────────
// GODOWN (warehouse) model — referenced by inventory entries
// ─────────────────────────────────────────────────────────────────────────────
const tallyGodownSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Godown",
      default: null,
    },
    parentName: { type: String, trim: true },
    address: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
  },
  { timestamps: true, collection: "acc_godowns" },
);

tallyGodownSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
const Acc_Voucher = mongoose.model("Acc_Voucher", tallyVoucherSchema);
const Acc_Godown = mongoose.model("Acc_Godown", tallyGodownSchema);

module.exports = {
  Acc_Voucher,
  Acc_Godown,
};
