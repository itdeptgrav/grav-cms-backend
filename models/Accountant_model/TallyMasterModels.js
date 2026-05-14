// models/Accountant_model/TallyMasterModels.js
// =============================================================================
// TALLY-COMPATIBLE MASTER MODELS
// -----------------------------------------------------------------------------
// Mirrors Tally Prime's master hierarchy:
//   Company → (Groups → Ledgers) + (Stock Groups → Stock Items → Units)
//
// Why this shape?
//   • Tally's Excel/XML imports speak in Groups + Ledgers + Vouchers.
//   • Keeping the same nouns means import → display → export round-trips
//     without lossy translation, and accountants familiar with Tally feel at
//     home in our UI.
// =============================================================================

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// 1. TALLY COMPANY
// ─────────────────────────────────────────────────────────────────────────────
// One row per company imported from Tally. A single CMS install can hold
// multiple companies (multi-entity firms commonly maintain separate Tally
// companies for sister-concerns).
const tallyCompanySchema = new mongoose.Schema(
  {
    companyName: { type: String, required: true, trim: true, index: true },
    companyCode: { type: String, unique: true, sparse: true, trim: true },

    // Core identifiers
    gstin: { type: String, trim: true },
    pan: { type: String, trim: true },
    cin: { type: String, trim: true },
    tan: { type: String, trim: true },

    // Address
    address: {
      line1: { type: String, trim: true },
      line2: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      stateCode: { type: String, trim: true }, // GST state code, e.g. "21" for Odisha
      pincode: { type: String, trim: true },
      country: { type: String, default: "India", trim: true },
    },

    contact: {
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      website: { type: String, trim: true },
    },

    // Books / financial year
    booksFromDate: { type: Date, required: true }, // when books begin
    financialYearStart: { type: Date }, // current FY start (e.g. 2025-04-01)
    currentFinancialYear: { type: String }, // "2025-26"

    baseCurrency: { type: String, default: "INR" },
    currencySymbol: { type: String, default: "₹" },

    // Tally provenance
    isImportedFromTally: { type: Boolean, default: false },
    tallyCompanyGuid: { type: String }, // Tally's internal UUID if available
    lastTallySync: { type: Date },

    // CMS link — typically the host's own org
    isPrimary: { type: Boolean, default: false }, // set on the GRAV Clothing record itself
    isActive: { type: Boolean, default: true },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantDepartment",
    },
  },
  { timestamps: true, collection: "tally_companies" },
);

tallyCompanySchema.index({ gstin: 1 });
tallyCompanySchema.index({ isPrimary: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// 2. TALLY GROUP (Account Group)
// ─────────────────────────────────────────────────────────────────────────────
// Tally organises every Ledger under a Group. Groups are themselves nested.
// We pre-seed the 28 default Tally groups; users can add custom sub-groups.
//
// Default Tally primary groups:
//   Capital Account, Loans (Liability), Current Liabilities, Suspense A/c,
//   Branch / Divisions, Misc. Expenses (Asset), Loans & Advances (Asset),
//   Investments, Current Assets, Fixed Assets, Sales Accounts,
//   Purchase Accounts, Direct Expenses, Indirect Expenses, Direct Incomes,
//   Indirect Incomes, …
const TALLY_DEFAULT_GROUPS = [
  // Liabilities
  {
    name: "Capital Account",
    nature: "liability",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Reserves & Surplus",
    nature: "liability",
    isReserved: true,
    parent: "Capital Account",
  },
  {
    name: "Loans (Liability)",
    nature: "liability",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Bank OD A/c",
    nature: "liability",
    isReserved: true,
    parent: "Loans (Liability)",
  },
  {
    name: "Secured Loans",
    nature: "liability",
    isReserved: true,
    parent: "Loans (Liability)",
  },
  {
    name: "Unsecured Loans",
    nature: "liability",
    isReserved: true,
    parent: "Loans (Liability)",
  },
  {
    name: "Current Liabilities",
    nature: "liability",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Duties & Taxes",
    nature: "liability",
    isReserved: true,
    parent: "Current Liabilities",
  },
  {
    name: "Provisions",
    nature: "liability",
    isReserved: true,
    parent: "Current Liabilities",
  },
  {
    name: "Sundry Creditors",
    nature: "liability",
    isReserved: true,
    parent: "Current Liabilities",
  },
  {
    name: "Suspense A/c",
    nature: "liability",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },

  // Assets
  {
    name: "Fixed Assets",
    nature: "asset",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Investments",
    nature: "asset",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Current Assets",
    nature: "asset",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Bank Accounts",
    nature: "asset",
    isReserved: true,
    parent: "Current Assets",
  },
  {
    name: "Cash-in-Hand",
    nature: "asset",
    isReserved: true,
    parent: "Current Assets",
  },
  {
    name: "Deposits (Asset)",
    nature: "asset",
    isReserved: true,
    parent: "Current Assets",
  },
  {
    name: "Loans & Advances (Asset)",
    nature: "asset",
    isReserved: true,
    parent: "Current Assets",
  },
  {
    name: "Stock-in-Hand",
    nature: "asset",
    isReserved: true,
    parent: "Current Assets",
  },
  {
    name: "Sundry Debtors",
    nature: "asset",
    isReserved: true,
    parent: "Current Assets",
  },
  {
    name: "Misc. Expenses (Asset)",
    nature: "asset",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Branch / Divisions",
    nature: "asset",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },

  // Income
  {
    name: "Sales Accounts",
    nature: "revenue",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Direct Incomes",
    nature: "revenue",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Indirect Incomes",
    nature: "revenue",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },

  // Expense
  {
    name: "Purchase Accounts",
    nature: "expense",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Direct Expenses",
    nature: "expense",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Indirect Expenses",
    nature: "expense",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
];

const tallyGroupSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCompany",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },

    // Either parent (sub-group) or null (one of the 28 primaries)
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyGroup",
      default: null,
    },
    parentName: { type: String, trim: true }, // denormalised — saves a populate
    isPrimary: { type: Boolean, default: false },

    // Accounting nature drives where this group sits in P&L vs Balance Sheet
    nature: {
      type: String,
      enum: ["asset", "liability", "equity", "revenue", "expense"],
      required: true,
    },

    // Tally specifics
    isReserved: { type: Boolean, default: false }, // can't be deleted (the 28 defaults)
    isRevenue: { type: Boolean, default: false },
    affectsGrossProfit: { type: Boolean, default: false },
    isDeemedPositive: { type: Boolean, default: true }, // dr-positive vs cr-positive

    // Hierarchy helpers
    level: { type: Number, default: 1 },
    fullPath: { type: String }, // e.g. "Current Assets > Sundry Debtors"

    // Manual sort order among siblings (groups sharing the same parent
    // and same companyId). Sparse integer ranking; null = falls back to
    // alphabetical sort at render time. Same idea as TallyLedger.groupOrder.
    // Pure display-order: doesn't affect balances, reports, or any
    // calculated values. Editor+ can change it, no approval required.
    displayOrder: { type: Number, default: null, index: true },

    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },

    // Tally provenance
    tallyGuid: { type: String }, // GUID from Tally, if imported
    importedAt: { type: Date },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantDepartment",
    },
  },
  { timestamps: true, collection: "tally_groups" },
);

tallyGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });
tallyGroupSchema.index({ companyId: 1, parent: 1 });
tallyGroupSchema.index({ companyId: 1, nature: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// 3. TALLY LEDGER
// ─────────────────────────────────────────────────────────────────────────────
// A Ledger is a single account (e.g. "HDFC Bank A/c 1234", "Rent Paid",
// "Acme Pvt Ltd"). Every voucher line points at a Ledger.
const tallyLedgerSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCompany",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    aliases: [{ type: String, trim: true }], // alternate names — Tally supports these natively

    // Group reference
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyGroup",
      required: true,
    },
    groupName: { type: String, required: true, trim: true }, // denormalised

    // Manual sort order WITHIN the group — org-wide, persisted across users.
    // Sparse integer ranking (gaps of 100): inserting a ledger between two
    // existing ones usually needs only one update. Ledgers without a value
    // fall back to alphabetical at render time. See ledgerReclassRoutes.js
    // for the reorder logic.
    groupOrder: { type: Number, default: null, index: true },

    // Reclassification audit — set when a ledger's groupId changes. Used
    // by the activity log and to surface "this ledger was recently moved"
    // hints to users who might be confused.
    reclassifiedAt: { type: Date, default: null },
    reclassifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantUser",
      default: null,
    },
    reclassifiedByName: { type: String, default: "" },
    reclassificationCount: { type: Number, default: 0 },

    // Inherited from group, but can be overridden per-ledger in Tally
    nature: {
      type: String,
      enum: ["asset", "liability", "equity", "revenue", "expense"],
      required: true,
    },

    // Opening balance — Tally stores this signed
    openingBalance: { type: Number, default: 0 }, // signed: positive = Dr, negative = Cr
    openingBalanceType: { type: String, enum: ["Dr", "Cr"], default: "Dr" },
    openingBalanceDate: { type: Date },

    // Running balance (re-computed on voucher post)
    currentBalance: { type: Number, default: 0 }, // signed
    currentBalanceType: { type: String, enum: ["Dr", "Cr"], default: "Dr" },

    // Tax & statutory
    gstApplicable: { type: Boolean, default: false },
    gstRegistrationType: {
      type: String,
      enum: ["regular", "composition", "consumer", "unregistered", "unknown"],
      default: "unknown",
    },
    gstin: { type: String, trim: true },
    hsnCode: { type: String, trim: true },
    taxRate: { type: Number, default: 0 }, // for income/expense ledgers

    tdsApplicable: { type: Boolean, default: false },
    tdsRate: { type: Number, default: 0 },
    tdsSection: { type: String, trim: true },

    panNumber: { type: String, trim: true },

    // Bank details (when ledger is a bank ledger)
    bankDetails: {
      bankName: { type: String, trim: true },
      branchName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      ifscCode: { type: String, trim: true },
      accountType: {
        type: String,
        enum: ["current", "savings", "od", "cc", "fd"],
      },
      upiId: { type: String, trim: true },
    },

    // Address (for party ledgers — debtors / creditors)
    contactDetails: {
      contactPerson: { type: String, trim: true },
      phone: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      address: { type: String, trim: true },
      city: { type: String, trim: true },
      state: { type: String, trim: true },
      stateCode: { type: String, trim: true },
      pincode: { type: String, trim: true },
      country: { type: String, default: "India" },
    },

    // Bill-wise tracking (Tally calls this "Maintain balances bill-by-bill")
    billWiseEnabled: { type: Boolean, default: false },
    creditPeriodDays: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0 },

    // Cost centre allocation
    costCentreApplicable: { type: Boolean, default: false },
    defaultCostCentreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCostCentre",
    },

    // CMS bridge — link this ledger to the rest of GRAV
    linkedCustomerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer" },
    linkedVendorId: { type: mongoose.Schema.Types.ObjectId, ref: "Vendor" },
    linkedEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: "Employee" },

    notes: { type: String, trim: true },
    isActive: { type: Boolean, default: true },

    // Tally provenance
    tallyGuid: { type: String },
    importedAt: { type: Date },
    importSource: {
      type: String,
      enum: ["manual", "tally_excel", "tally_xml", "tally_csv", "auto"],
      default: "manual",
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "AccountantDepartment",
    },
  },
  { timestamps: true, collection: "tally_ledgers" },
);

tallyLedgerSchema.index({ companyId: 1, name: 1 }, { unique: true });
tallyLedgerSchema.index({ companyId: 1, groupId: 1 });
tallyLedgerSchema.index({ companyId: 1, nature: 1 });
tallyLedgerSchema.index({ linkedCustomerId: 1 });
tallyLedgerSchema.index({ linkedVendorId: 1 });
tallyLedgerSchema.index({ aliases: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// 4. TALLY COST CENTRE
// ─────────────────────────────────────────────────────────────────────────────
// Cost Centres let you slice expense/income by department, project, branch.
const tallyCostCentreSchema = new mongoose.Schema(
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
      ref: "TallyCostCentre",
      default: null,
    },
    parentName: { type: String, trim: true },
    category: { type: String, trim: true }, // e.g. "Departments", "Branches", "Projects"
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
    notes: { type: String, trim: true },
  },
  { timestamps: true, collection: "tally_cost_centres" },
);

tallyCostCentreSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// 5. TALLY UNIT (of Measure)
// ─────────────────────────────────────────────────────────────────────────────
const tallyUnitSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCompany",
      required: true,
      index: true,
    },
    symbol: { type: String, required: true, trim: true }, // "Pcs", "Mtr", "Kg"
    formalName: { type: String, trim: true }, // "Pieces"
    decimalPlaces: { type: Number, default: 0 },
    type: { type: String, enum: ["simple", "compound"], default: "simple" },
    // For compound units, e.g. "1 Box = 12 Pcs"
    baseUnit: { type: String, trim: true },
    conversionFactor: { type: Number, default: 1 },
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
  },
  { timestamps: true, collection: "tally_units" },
);

tallyUnitSchema.index({ companyId: 1, symbol: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// 6. TALLY STOCK GROUP
// ─────────────────────────────────────────────────────────────────────────────
const tallyStockGroupSchema = new mongoose.Schema(
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
      ref: "TallyStockGroup",
      default: null,
    },
    parentName: { type: String, trim: true },
    shouldQuantitiesAdd: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
  },
  { timestamps: true, collection: "tally_stock_groups" },
);

tallyStockGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// 7. TALLY STOCK ITEM
// ─────────────────────────────────────────────────────────────────────────────
const tallyStockItemSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyCompany",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    aliases: [{ type: String, trim: true }],

    stockGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TallyStockGroup",
    },
    stockGroupName: { type: String, trim: true },

    baseUnit: { type: String, trim: true }, // symbol — "Pcs", "Mtr"
    altUnit: { type: String, trim: true },

    // Tax / statutory
    hsnCode: { type: String, trim: true },
    gstApplicable: { type: Boolean, default: true },
    taxRate: { type: Number, default: 0 }, // total GST %
    gstClassification: { type: String, trim: true },

    // Opening stock
    openingQuantity: { type: Number, default: 0 },
    openingValue: { type: Number, default: 0 },
    openingRate: { type: Number, default: 0 },

    // Current stock — recomputed on inventory vouchers
    closingQuantity: { type: Number, default: 0 },
    closingValue: { type: Number, default: 0 },
    closingRate: { type: Number, default: 0 },

    standardCost: { type: Number, default: 0 },
    standardSellingPrice: { type: Number, default: 0 },

    // CMS bridge
    linkedStockItemId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "StockItem",
    },
    linkedRawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem" },

    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
    importedAt: { type: Date },

    notes: { type: String, trim: true },
  },
  { timestamps: true, collection: "tally_stock_items" },
);

tallyStockItemSchema.index({ companyId: 1, name: 1 }, { unique: true });
tallyStockItemSchema.index({ companyId: 1, stockGroupId: 1 });
tallyStockItemSchema.index({ aliases: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// MODEL EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
const TallyCompany = mongoose.model("TallyCompany", tallyCompanySchema);
const TallyGroup = mongoose.model("TallyGroup", tallyGroupSchema);
const TallyLedger = mongoose.model("TallyLedger", tallyLedgerSchema);
const TallyCostCentre = mongoose.model(
  "TallyCostCentre",
  tallyCostCentreSchema,
);
const TallyUnit = mongoose.model("TallyUnit", tallyUnitSchema);
const TallyStockGroup = mongoose.model(
  "TallyStockGroup",
  tallyStockGroupSchema,
);
const TallyStockItem = mongoose.model("TallyStockItem", tallyStockItemSchema);

module.exports = {
  TallyCompany,
  TallyGroup,
  TallyLedger,
  TallyCostCentre,
  TallyUnit,
  TallyStockGroup,
  TallyStockItem,
  TALLY_DEFAULT_GROUPS,
};
