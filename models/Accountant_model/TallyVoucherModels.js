// models/Accountant_model/TallyVoucherModels.js
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
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "TallyLedger" },
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
          ref: "TallyCostCentre",
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
      ref: "TallyStockItem",
    },
    stockItemName: { type: String, required: true, trim: true },

    quantity: { type: Number, required: true },
    unit: { type: String, trim: true },
    rate: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },

    amount: { type: Number, required: true }, // qty × rate − discount

    hsnCode: { type: String, trim: true },
    godownId: { type: mongoose.Schema.Types.ObjectId, ref: "TallyGodown" },
    godownName: { type: String, trim: true },
    batchName: { type: String, trim: true },

    // Per-line tax (some accountants prefer line-level, others voucher-level)
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },

    // Sales/purchase ledger this line posts against (optional — voucher-level
    // sales ledger is the more common pattern)
    accountingLedgerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyLedger",
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
      ref: "TallyCompany",
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

    // ─── Party (optional — sales/purchase/receipt/payment/CN/DN have one) ───
    partyLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "TallyLedger" },
    partyLedgerName: { type: String, trim: true },
    partyGstin: { type: String, trim: true },
    placeOfSupply: { type: String, trim: true },
    placeOfSupplyCode: { type: String, trim: true }, // GST state code

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

    // ─── Status ─────────────────────────────────────────────────────────────
    // pending_approval is the state used when an Editor creates a voucher
    // but the org requires owner/approver review before it posts. It maps
    // to an ApprovalRequest row; approve flips it to "posted", reject to
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

    // ─── e-Invoice / e-Way Bill (sales) ─────────────────────────────────────
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
      ref: "TallyImportSession",
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
      ref: "AccountantDepartment",
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantDepartment",
    },
    postedAt: { type: Date },
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantDepartment",
    },
    cancelledAt: { type: Date },
    cancellationReason: { type: String, trim: true },
  },
  { timestamps: true, collection: "tally_vouchers" },
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
      ref: "TallyCompany",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyGodown",
      default: null,
    },
    parentName: { type: String, trim: true },
    address: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
  },
  { timestamps: true, collection: "tally_godowns" },
);

tallyGodownSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
const TallyVoucher = mongoose.model("TallyVoucher", tallyVoucherSchema);
const TallyGodown = mongoose.model("TallyGodown", tallyGodownSchema);

module.exports = {
  TallyVoucher,
  TallyGodown,
};
