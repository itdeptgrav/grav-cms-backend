// models/Accountant_model/Acc_OperationalModels.js
// Complete Accountant System Models

const mongoose = require("mongoose");

// ═══════════════════════════════════════════════════════════════
// 1. EXPENSE MODEL
// ═══════════════════════════════════════════════════════════════
const expenseSchema = new mongoose.Schema(
  {
    expenseId: {
      type: String,
      unique: true,
      default: () =>
        `EXP-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
    },
    category: {
      type: String,
      enum: [
        "raw_materials",
        "machinery",
        "utilities",
        "rent",
        "salaries",
        "transport",
        "packaging",
        "marketing",
        "office_supplies",
        "maintenance",
        "insurance",
        "taxes",
        "legal",
        "miscellaneous",
      ],
      required: true,
    },
    subCategory: { type: String, trim: true },
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, default: 0, min: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    currency: { type: String, default: "INR" },
    paymentMethod: {
      type: String,
      enum: [
        "cash",
        "bank_transfer",
        "upi",
        "cheque",
        "credit_card",
        "debit_card",
      ],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["pending", "paid", "partially_paid", "cancelled", "refunded"],
      default: "pending",
    },
    paidAmount: { type: Number, default: 0, min: 0 },
    paymentDate: { type: Date },
    dueDate: { type: Date },
    referenceNumber: { type: String, trim: true },
    transactionId: { type: String, trim: true },
    vendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    vendorName: { type: String, trim: true },
    purchaseOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PurchaseOrder",
    },
    poNumber: { type: String, trim: true },
    gstApplicable: { type: Boolean, default: false },
    gstDetails: {
      gstRate: { type: Number, default: 0 },
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
      gstNumber: { type: String, trim: true },
      hsnCode: { type: String, trim: true },
    },
    tdsApplicable: { type: Boolean, default: false },
    tdsDetails: {
      tdsRate: { type: Number, default: 0 },
      tdsAmount: { type: Number, default: 0 },
      tdsSection: { type: String, trim: true },
    },
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    status: {
      type: String,
      enum: ["draft", "pending_approval", "approved", "rejected", "void"],
      default: "draft",
    },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    approvedAt: { type: Date },
    rejectionReason: { type: String, trim: true },
    isRecurring: { type: Boolean, default: false },
    recurringConfig: {
      frequency: {
        type: String,
        enum: ["daily", "weekly", "monthly", "quarterly", "yearly"],
      },
      nextDueDate: { type: Date },
      endDate: { type: Date },
    },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    financialYear: { type: String },
  },
  { timestamps: true, collection: "acc_expenses" },
);
expenseSchema.index({ category: 1, createdAt: -1 });
expenseSchema.index({ vendorId: 1 });
expenseSchema.index({ status: 1 });
expenseSchema.index({ paymentStatus: 1 });
expenseSchema.index({ financialYear: 1 });

// ═══════════════════════════════════════════════════════════════
// 2. INVOICE MODEL
// ═══════════════════════════════════════════════════════════════
const invoiceItemSchema = new mongoose.Schema(
  {
    itemName: { type: String, required: true },
    description: { type: String, trim: true },
    hsnCode: { type: String, trim: true },
    quantity: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0 },
    discountType: {
      type: String,
      enum: ["percentage", "flat"],
      default: "flat",
    },
    taxRate: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    totalPrice: { type: Number, required: true, min: 0 },
  },
  { _id: true },
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, unique: true, required: true },
    invoiceDate: { type: Date, default: Date.now, required: true },
    dueDate: { type: Date, required: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    customerName: { type: String, required: true },
    customerEmail: { type: String },
    customerPhone: { type: String },
    customerAddress: { type: String },
    customerGSTIN: { type: String, trim: true },
    customerRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerRequest",
    },
    requestId: { type: String },
    quotationId: { type: mongoose.Schema.Types.ObjectId },
    items: [invoiceItemSchema],
    subtotal: { type: Number, required: true, min: 0 },
    discountTotal: { type: Number, default: 0 },
    taxBreakdown: {
      cgst: { type: Number, default: 0 },
      sgst: { type: Number, default: 0 },
      igst: { type: Number, default: 0 },
      totalTax: { type: Number, default: 0 },
    },
    grandTotal: { type: Number, required: true, min: 0 },
    amountInWords: { type: String },
    roundOff: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: [
        "unpaid",
        "partially_paid",
        "paid",
        "overdue",
        "cancelled",
        "refunded",
      ],
      default: "unpaid",
    },
    paidAmount: { type: Number, default: 0, min: 0 },
    balanceDue: { type: Number, default: 0, min: 0 },
    payments: [
      {
        amount: { type: Number, required: true },
        paymentDate: { type: Date, default: Date.now },
        paymentMethod: {
          type: String,
          enum: [
            "cash",
            "bank_transfer",
            "upi",
            "cheque",
            "credit_card",
            "debit_card",
          ],
        },
        referenceNumber: { type: String },
        notes: { type: String },
        recordedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Acc_Department",
        },
      },
    ],
    status: {
      type: String,
      enum: ["draft", "sent", "viewed", "paid", "overdue", "cancelled", "void"],
      default: "draft",
    },
    companyDetails: {
      name: { type: String, default: "GRAV Clothing" },
      gstin: { type: String },
      pan: { type: String },
      address: { type: String },
      phone: { type: String },
      email: { type: String },
      bankName: { type: String },
      accountNumber: { type: String },
      ifscCode: { type: String },
      upiId: { type: String },
    },
    termsAndConditions: { type: String },
    internalNotes: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    financialYear: { type: String },
  },
  { timestamps: true, collection: "acc_invoices" },
);
invoiceSchema.index({ customerId: 1, createdAt: -1 });
invoiceSchema.index({ status: 1 });
invoiceSchema.index({ paymentStatus: 1 });
invoiceSchema.index({ invoiceDate: -1 });
invoiceSchema.index({ financialYear: 1 });

// ═══════════════════════════════════════════════════════════════
// 3. BANK TRANSACTION MODEL
// ═══════════════════════════════════════════════════════════════
const bankTransactionSchema = new mongoose.Schema(
  {
    transactionId: {
      type: String,
      unique: true,
      default: () =>
        `TXN-${Date.now()}-${Math.random().toString(36).substr(2, 6).toUpperCase()}`,
    },
    bankAccount: { type: String, required: true },
    bankName: { type: String, required: true },
    transactionDate: { type: Date, required: true },
    valueDate: { type: Date },
    type: { type: String, enum: ["credit", "debit"], required: true },
    amount: { type: Number, required: true, min: 0 },
    runningBalance: { type: Number },
    description: { type: String, trim: true },
    referenceNumber: { type: String, trim: true },
    chequeNumber: { type: String, trim: true },
    category: {
      type: String,
      enum: [
        "customer_payment",
        "vendor_payment",
        "salary",
        "tax_payment",
        "loan",
        "interest",
        "refund",
        "bank_charges",
        "transfer",
        "other",
      ],
    },
    isReconciled: { type: Boolean, default: false },
    reconciledWith: {
      type: { type: String, enum: ["invoice", "expense", "payroll", "manual"] },
      referenceId: { type: mongoose.Schema.Types.ObjectId },
      referenceNumber: { type: String },
    },
    reconciledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
    reconciledAt: { type: Date },
    linkedInvoice: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Invoice" },
    linkedExpense: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Expense" },
    linkedVendor: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    linkedCustomer: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    financialYear: { type: String },
  },
  { timestamps: true, collection: "acc_bank_transactions" },
);
bankTransactionSchema.index({ bankAccount: 1, transactionDate: -1 });
bankTransactionSchema.index({ isReconciled: 1 });
bankTransactionSchema.index({ type: 1 });
bankTransactionSchema.index({ category: 1 });

// ═══════════════════════════════════════════════════════════════
// 4. BUDGET MODEL
// ═══════════════════════════════════════════════════════════════
const budgetItemSchema = new mongoose.Schema(
  {
    category: { type: String, required: true },
    allocatedAmount: { type: Number, required: true, min: 0 },
    spentAmount: { type: Number, default: 0, min: 0 },
    remainingAmount: { type: Number, default: 0 },
    variance: { type: Number, default: 0 },
    notes: { type: String, trim: true },
  },
  { _id: true },
);

const budgetSchema = new mongoose.Schema(
  {
    budgetId: {
      type: String,
      unique: true,
      default: () => `BUD-${Date.now().toString(36).toUpperCase()}`,
    },
    name: { type: String, required: true, trim: true },
    financialYear: { type: String, required: true },
    period: {
      type: String,
      enum: ["monthly", "quarterly", "half_yearly", "yearly"],
      required: true,
    },
    month: { type: Number, min: 1, max: 12 },
    quarter: { type: Number, min: 1, max: 4 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    items: [budgetItemSchema],
    totalAllocated: { type: Number, default: 0, min: 0 },
    totalSpent: { type: Number, default: 0, min: 0 },
    totalRemaining: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ["draft", "active", "closed", "exceeded"],
      default: "draft",
    },
    alerts: [
      {
        message: String,
        severity: { type: String, enum: ["info", "warning", "critical"] },
        triggeredAt: { type: Date, default: Date.now },
        acknowledged: { type: Boolean, default: false },
      },
    ],
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    notes: { type: String, trim: true },
  },
  { timestamps: true, collection: "acc_budgets" },
);
budgetSchema.index({ financialYear: 1, period: 1 });

// ═══════════════════════════════════════════════════════════════
// 5. JOURNAL ENTRY MODEL
// ═══════════════════════════════════════════════════════════════
const journalLineSchema = new mongoose.Schema(
  {
    accountName: { type: String, required: true },
    accountCode: { type: String },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
    description: { type: String, trim: true },
  },
  { _id: true },
);

const journalEntrySchema = new mongoose.Schema(
  {
    entryNumber: {
      type: String,
      unique: true,
      default: () => `JE-${Date.now().toString(36).toUpperCase()}`,
    },
    entryDate: { type: Date, required: true, default: Date.now },
    narration: { type: String, required: true, trim: true },
    lines: {
      type: [journalLineSchema],
      validate: {
        validator: function (lines) {
          if (lines.length < 2) return false;
          const totalDebit = lines.reduce((sum, l) => sum + (l.debit || 0), 0);
          const totalCredit = lines.reduce(
            (sum, l) => sum + (l.credit || 0),
            0,
          );
          return Math.abs(totalDebit - totalCredit) < 0.01;
        },
        message:
          "Journal entry must have at least 2 lines and debit must equal credit",
      },
    },
    totalDebit: { type: Number, default: 0 },
    totalCredit: { type: Number, default: 0 },
    type: {
      type: String,
      enum: ["standard", "adjusting", "closing", "reversing", "opening"],
      default: "standard",
    },
    sourceType: {
      type: String,
      enum: [
        "manual",
        "invoice",
        "expense",
        "payroll",
        "bank",
        "tax",
        "depreciation",
      ],
    },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    sourceReference: { type: String },
    status: {
      type: String,
      enum: ["draft", "posted", "reversed", "void"],
      default: "draft",
    },
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        uploadedAt: { type: Date, default: Date.now },
      },
    ],
    postedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    postedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    financialYear: { type: String },
  },
  { timestamps: true, collection: "acc_journal_entries" },
);
journalEntrySchema.index({ entryDate: -1 });
journalEntrySchema.index({ status: 1 });
journalEntrySchema.index({ sourceType: 1 });
journalEntrySchema.index({ financialYear: 1 });

// ═══════════════════════════════════════════════════════════════
// 6. TAX FILING MODEL
// ═══════════════════════════════════════════════════════════════
const taxFilingSchema = new mongoose.Schema(
  {
    filingId: {
      type: String,
      unique: true,
      default: () => `TAX-${Date.now().toString(36).toUpperCase()}`,
    },
    taxType: {
      type: String,
      enum: [
        "gst",
        "tds",
        "income_tax",
        "professional_tax",
        "advance_tax",
        "esi",
        "pf",
      ],
      required: true,
    },
    period: { type: String, required: true },
    financialYear: { type: String, required: true },
    filingDate: { type: Date },
    dueDate: { type: Date, required: true },
    taxableAmount: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    penalty: { type: Number, default: 0 },
    interest: { type: Number, default: 0 },
    totalPayable: { type: Number, default: 0 },
    amountPaid: { type: Number, default: 0 },
    gstDetails: {
      gstr1: {
        totalInvoices: Number,
        totalTaxableValue: Number,
        totalTax: Number,
        filedDate: Date,
      },
      gstr3b: {
        outputTax: Number,
        inputTaxCredit: Number,
        netTaxPayable: Number,
        filedDate: Date,
      },
    },
    tdsDetails: {
      totalDeductions: Number,
      totalDeductees: Number,
      form: String,
    },
    status: {
      type: String,
      enum: ["upcoming", "pending", "filed", "paid", "overdue", "revised"],
      default: "upcoming",
    },
    challanNumber: { type: String, trim: true },
    acknowledgementNumber: { type: String, trim: true },
    referenceNumber: { type: String, trim: true },
    notes: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    filedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
  },
  { timestamps: true, collection: "acc_tax_filings" },
);
taxFilingSchema.index({ taxType: 1, financialYear: 1 });
taxFilingSchema.index({ status: 1 });
taxFilingSchema.index({ dueDate: 1 });

// ═══════════════════════════════════════════════════════════════
// 7. CHART OF ACCOUNTS MODEL
// ═══════════════════════════════════════════════════════════════
const chartOfAccountsSchema = new mongoose.Schema(
  {
    accountCode: { type: String, unique: true, required: true },
    accountName: { type: String, required: true, trim: true },
    accountType: {
      type: String,
      enum: ["asset", "liability", "equity", "revenue", "expense"],
      required: true,
    },
    parentAccount: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_ChartOfAccounts",
    },
    level: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
    balance: { type: Number, default: 0 },
    description: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
  },
  { timestamps: true, collection: "acc_chart_of_accounts" },
);

// ═══════════════════════════════════════════════════════════════
// 8. CREDIT/DEBIT NOTE MODEL
// ═══════════════════════════════════════════════════════════════
const creditDebitNoteSchema = new mongoose.Schema(
  {
    noteNumber: { type: String, unique: true, required: true },
    noteType: { type: String, enum: ["credit", "debit"], required: true },
    noteDate: { type: Date, default: Date.now },
    reason: {
      type: String,
      enum: ["return", "defect", "price_adjustment", "discount", "other"],
      required: true,
    },
    description: { type: String, trim: true },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Invoice" },
    invoiceNumber: { type: String },
    partyType: { type: String, enum: ["customer", "vendor"], required: true },
    partyId: { type: mongoose.Schema.Types.ObjectId },
    partyName: { type: String, required: true },
    amount: { type: Number, required: true, min: 0 },
    taxAmount: { type: Number, default: 0 },
    totalAmount: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["draft", "issued", "applied", "cancelled"],
      default: "draft",
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
    financialYear: { type: String },
  },
  { timestamps: true, collection: "acc_credit_debit_notes" },
);
creditDebitNoteSchema.index({ partyType: 1, partyId: 1 });
creditDebitNoteSchema.index({ status: 1 });

// ═══════════════════════════════════════════════════════════════
// 9. ACCOUNTANT ACTIVITY LOG
// ═══════════════════════════════════════════════════════════════
const activityLogSchema = new mongoose.Schema(
  {
    accountantId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
      required: true,
    },
    action: { type: String, required: true },
    module: {
      type: String,
      enum: [
        "expense",
        "invoice",
        "payment",
        "vendor",
        "customer",
        "payroll",
        "tax",
        "bank",
        "budget",
        "journal",
        "report",
        "settings",
      ],
      required: true,
    },
    entityType: { type: String },
    entityId: { type: mongoose.Schema.Types.ObjectId },
    details: { type: String },
    metadata: { type: mongoose.Schema.Types.Mixed },
    ipAddress: { type: String },
  },
  { timestamps: true, collection: "acc_activity_logs" },
);
activityLogSchema.index({ accountantId: 1, createdAt: -1 });
activityLogSchema.index({ module: 1 });

// ═══════════════════════════════════════════════════════════════
// 10. ACCOUNTANT SETTINGS  (PATCHED — see notes inline)
// ═══════════════════════════════════════════════════════════════
//
// This schema previously didn't match what the Settings page actually sent,
// which is why every tab "silently saved" but nothing actually persisted.
// Fixed by:
//   • Adding the field names the frontend ACTUALLY uses (gstin/pan/phone/
//     email/website at top level) AND keeping legacy companyGSTIN/companyPAN/
//     companyPhone/companyEmail so existing data isn't lost
//   • Replacing the flat `companyAddress` string with a real `address`
//     sub-object (line1/line2/city/state/pincode/country)
//   • Adding `defaultGstRate`, `defaultTdsRate`, `tdsApplicable` (the
//     frontend casing). `financialYearStart` is now a String to match
//     the frontend dropdown ("April" / "January") — legacy numeric value
//     can still be saved into `financialYearStartMonth`.
//   • Adding nested `numbering` object (invoicePrefix/invoiceNextNum/
//     quotationPrefix/quotationNextNum/voucherPrefix)
//   • Adding nested `preferences` object (currency/currencySymbol/
//     dateFormat/decimalPlaces/locale)
//   • Adding a `branchName` field to bank accounts (frontend already
//     sends it; previously dropped)
//
const bankAccountSubSchema = new mongoose.Schema(
  {
    bankName: { type: String, required: true },
    accountNumber: { type: String, required: true },
    ifscCode: { type: String },
    branchName: { type: String }, // ← was being dropped
    accountType: { type: String, enum: ["current", "savings", "od", "cc"] },
    upiId: { type: String },
    isDefault: { type: Boolean, default: false },
  },
  { _id: true },
);

const accountantSettingsSchema = new mongoose.Schema(
  {
    // ── Company identity (NEW — what the Organization tab actually sends) ──
    companyName: { type: String, default: "GRAV Clothing" },
    gstin: { type: String, trim: true },
    pan: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    website: { type: String, trim: true },

    // ── Legacy field aliases kept for back-compat with anything else that
    //    reads from settings (e.g. invoice render code). Whichever set the
    //    user-edits-first will be the source of truth going forward.
    companyGSTIN: { type: String, trim: true },
    companyPAN: { type: String, trim: true },
    companyPhone: { type: String, trim: true },
    companyEmail: { type: String, trim: true },
    companyAddress: { type: String }, // legacy flat-string address
    companyLogo: { type: String },

    // ── Address (NEW — sub-object matching the Address tab) ──
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      pincode: { type: String, trim: true },
      country: { type: String, trim: true, default: "India" },
    },

    // ── Bank accounts ──
    bankAccounts: [bankAccountSubSchema],

    // ── Invoice / numbering (legacy flat fields kept) ──
    invoicePrefix: { type: String, default: "INV" },
    invoiceStartNumber: { type: Number, default: 1 },
    currentInvoiceNumber: { type: Number, default: 0 },
    invoiceTerms: { type: String },
    invoiceNotes: { type: String },

    // ── Numbering (NEW — sub-object the Numbering tab sends) ──
    numbering: {
      invoicePrefix: { type: String, default: "INV" },
      invoiceNextNum: { type: Number, default: 1 },
      quotationPrefix: { type: String, default: "QT" },
      quotationNextNum: { type: Number, default: 1 },
      voucherPrefix: { type: String, default: "JV" },
    },

    // ── Financial year ──
    currentFinancialYear: { type: String },
    financialYearStartMonth: { type: Number, default: 4 }, // April (legacy numeric)
    financialYearStart: { type: String, default: "April" }, // NEW — string form the frontend sends

    // ── Tax defaults (NEW casing matches frontend) ──
    defaultGstRate: { type: Number, default: 18 },
    defaultTdsRate: { type: Number, default: 10 },
    tdsApplicable: { type: Boolean, default: false },
    // Legacy uppercase variants (so old code reading these still works)
    defaultGSTRate: { type: Number, default: 18 },
    defaultTDSRate: { type: Number, default: 10 },
    gstRegistered: { type: Boolean, default: true },
    compositionScheme: { type: Boolean, default: false },

    // ── Notification preferences ──
    notifications: {
      paymentReminders: { type: Boolean, default: true },
      overdueAlerts: { type: Boolean, default: true },
      taxDueDates: { type: Boolean, default: true },
      budgetAlerts: { type: Boolean, default: true },
    },

    // ── UI/format preferences (NEW — sub-object the Preferences tab sends) ──
    preferences: {
      currency: { type: String, default: "INR" },
      currencySymbol: { type: String, default: "₹" },
      dateFormat: { type: String, default: "DD-MM-YYYY" },
      decimalPlaces: { type: Number, default: 2 },
      locale: { type: String, default: "en-IN" },
    },

    // ── Legacy flat currency fields (kept for back-compat) ──
    baseCurrency: { type: String, default: "INR" },
    currencySymbol: { type: String, default: "₹" },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Department" },
  },
  { timestamps: true, collection: "acc_settings" },
);

// Mirror legacy ⇄ canonical field pairs on save so any consumer that reads
// either casing keeps working. Frontend writes "defaultGstRate"; old invoice
// render code may read "defaultGSTRate" — keep them in sync.
accountantSettingsSchema.pre("save", function (next) {
  if (this.isModified("defaultGstRate"))
    this.defaultGSTRate = this.defaultGstRate;
  else if (this.isModified("defaultGSTRate"))
    this.defaultGstRate = this.defaultGSTRate;
  if (this.isModified("defaultTdsRate"))
    this.defaultTDSRate = this.defaultTdsRate;
  else if (this.isModified("defaultTDSRate"))
    this.defaultTdsRate = this.defaultTDSRate;

  // Mirror new "gstin/pan/phone/email" → "companyGSTIN/companyPAN/..." so
  // invoice generator code that still reads the legacy fields keeps working.
  if (this.isModified("gstin")) this.companyGSTIN = this.gstin;
  if (this.isModified("pan")) this.companyPAN = this.pan;
  if (this.isModified("phone")) this.companyPhone = this.phone;
  if (this.isModified("email")) this.companyEmail = this.email;

  // Mirror preferences → legacy flat currency fields.
  if (this.preferences) {
    if (this.preferences.currency)
      this.baseCurrency = this.preferences.currency;
    if (this.preferences.currencySymbol)
      this.currencySymbol = this.preferences.currencySymbol;
  }

  next();
});

accountantSettingsSchema.statics.getSingleton = async function () {
  let settings = await this.findOne();
  if (!settings) settings = await this.create({});
  return settings;
};

// ═══════════════════════════════════════════════════════════════
// EXPORT ALL MODELS
// ═══════════════════════════════════════════════════════════════
const Acc_Expense = mongoose.model("Acc_Expense", expenseSchema);
const Acc_Invoice = mongoose.model("Acc_Invoice", invoiceSchema);
const Acc_BankTransaction = mongoose.model(
  "Acc_BankTransaction",
  bankTransactionSchema,
);
const Acc_Budget = mongoose.model("Acc_Budget", budgetSchema);
const Acc_JournalEntry = mongoose.model("Acc_JournalEntry", journalEntrySchema);
const Acc_TaxFiling = mongoose.model("Acc_TaxFiling", taxFilingSchema);
const Acc_ChartOfAccounts = mongoose.model(
  "Acc_ChartOfAccounts",
  chartOfAccountsSchema,
);
const Acc_CreditDebitNote = mongoose.model(
  "Acc_CreditDebitNote",
  creditDebitNoteSchema,
);
const ActivityLog = mongoose.model("Acc_ActivityLog", activityLogSchema);
const Acc_Settings = mongoose.model("Acc_Settings", accountantSettingsSchema);

module.exports = {
  Acc_Expense,
  Acc_Invoice,
  Acc_BankTransaction,
  Acc_Budget,
  Acc_JournalEntry,
  Acc_TaxFiling,
  Acc_ChartOfAccounts,
  Acc_CreditDebitNote,
  ActivityLog,
  Acc_Settings,
};
