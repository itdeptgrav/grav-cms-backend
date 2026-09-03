// models/Accountant_model/Acc_MasterModels.js
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

/* ══ WHAT DOCUMENTS A COMPANY CAN HAVE ═════════════════════════════════════
 *
 * One list, and it is the only one. The enum on the documents sub-document is
 * derived from it, the API serves it to the form, and the form renders it — so
 * a kind cannot exist in the dropdown but be rejected by the schema, which is
 * the failure mode of keeping a label list on the client and an enum on the
 * server.
 *
 * EVERY ONE OF THESE IS OPTIONAL. A sole proprietor has no MOA; a company that
 * does not import has no IEC. Nothing here is required, nothing is chased, and
 * a company with four documents on file is not incomplete — it is a company
 * with four documents. `group` only decides where it sits in the picker.
 *
 * `multi` is a HINT, not a rule: it marks the kinds that usually run to more
 * than one image so the form can say "Front / Back" or "Page 1, 2, 3" without
 * being asked. Every kind accepts several files regardless.
 */
const ACC_COMPANY_DOC_KINDS = [
  // The four that have their own row on the form, tied to the number above them
  { value: "gst", label: "GST registration certificate", group: "Statutory", multi: true },
  { value: "pan", label: "PAN card", group: "Statutory" },
  { value: "tan", label: "TAN allotment letter", group: "Statutory" },
  { value: "incorporation", label: "Certificate of incorporation", group: "Statutory", multi: true },

  // Constitution
  { value: "cin", label: "CIN document", group: "Constitution" },
  { value: "moa", label: "Memorandum of Association", group: "Constitution", multi: true },
  { value: "aoa", label: "Articles of Association", group: "Constitution", multi: true },
  { value: "partnership-deed", label: "Partnership deed", group: "Constitution", multi: true },
  { value: "llp-agreement", label: "LLP agreement", group: "Constitution", multi: true },
  { value: "board-resolution", label: "Board resolution", group: "Constitution", multi: true },

  // Premises
  { value: "address-proof", label: "Address proof", group: "Premises", multi: true },
  { value: "rent-agreement", label: "Rent / lease agreement", group: "Premises", multi: true },
  { value: "utility-bill", label: "Utility bill", group: "Premises" },
  { value: "property-tax", label: "Property tax receipt", group: "Premises" },

  // Banking
  { value: "bank", label: "Cancelled cheque", group: "Banking" },
  { value: "bank-statement", label: "Bank statement", group: "Banking", multi: true },

  // Registrations & licences
  { value: "msme", label: "Udyam / MSME registration", group: "Registrations" },
  { value: "iec", label: "Import Export Code (IEC)", group: "Registrations" },
  { value: "shop-establishment", label: "Shops & Establishment licence", group: "Registrations" },
  { value: "trade-license", label: "Trade licence", group: "Registrations" },
  { value: "fssai", label: "FSSAI licence", group: "Registrations" },
  { value: "professional-tax", label: "Professional tax registration", group: "Registrations" },
  { value: "epf", label: "EPF registration", group: "Registrations" },
  { value: "esic", label: "ESIC registration", group: "Registrations" },
  { value: "factory-license", label: "Factory licence", group: "Registrations" },
  { value: "pollution-consent", label: "Pollution control consent", group: "Registrations" },

  // People
  { value: "director-kyc", label: "Director / partner KYC", group: "People", multi: true },
  { value: "aadhaar", label: "Aadhaar (front & back)", group: "People", multi: true },
  { value: "signatory-authorisation", label: "Authorised signatory letter", group: "People" },
  { value: "digital-signature", label: "Digital signature certificate", group: "People" },

  // Anything else — the reason `label` exists on a document
  { value: "other", label: "Other document", group: "Other" },
];

const ACC_COMPANY_DOC_KIND_VALUES = ACC_COMPANY_DOC_KINDS.map((k) => k.value);
const ACC_COMPANY_DOC_KIND_BY_VALUE = new Map(
  ACC_COMPANY_DOC_KINDS.map((k) => [k.value, k]),
);

/**
 * A document's files, whichever era it was written in.
 *
 * New uploads populate `files`. Rows written before multi-file support carry
 * one file in the legacy top-level fields; those are synthesised into the same
 * shape here so every reader has exactly one path. See the note on `files` in
 * the schema for why this is a read-time fallback rather than a migration.
 */
function filesOfDoc(d) {
  if (!d) return [];
  if (Array.isArray(d.files) && d.files.length) return d.files;
  if (!d.driveFileId) return [];
  return [
    {
      _id: d._id,
      driveFileId: d.driveFileId,
      name: d.name,
      mimeType: d.mimeType,
      bytes: d.bytes,
      caption: "",
      uploadedByName: d.uploadedByName,
      uploadedAt: d.uploadedAt,
      isLegacy: true,
    },
  ];
}

/** What to call a document on screen: its own label, else its kind's. */
function labelOfDoc(d) {
  if (d?.label) return d.label;
  return ACC_COMPANY_DOC_KIND_BY_VALUE.get(d?.kind)?.label || "Document";
}

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

    /* ── STATUTORY DOCUMENTS ────────────────────────────────────────────
     * The certificates behind the identifiers above: the GST registration,
     * the PAN card, the certificate of incorporation. A sub-document array
     * rather than its own collection, and rather than rows in the /files
     * drive, for the reason models/Files/Doc_File.js states from the other
     * side — a file that exists only as evidence FOR one record belongs to
     * that record. Nobody browses to a company's PAN card; they open the
     * company and find it there.
     *
     * The bytes are on Drive and PRIVATE. There is deliberately no `url`
     * column: a provider URL is a permanent grant to anyone who ever sees
     * it, so reads go through the download route, which re-checks the
     * session every time. Same posture as employee letters and the drive. */
    documents: [
      {
        /* What the file IS, not what it is called. Free text would give us
           "pan", "PAN card", "Pan Card.pdf" and no way to ask whether the
           GST certificate is on file.

           The list is long because a company genuinely has this many kinds of
           proof, and every one of them is OPTIONAL — see ACC_COMPANY_DOC_KINDS
           below, which is the single place that says what each one is called
           and whether it usually runs to more than one image. */
        kind: {
          type: String,
          enum: ACC_COMPANY_DOC_KIND_VALUES,
          default: "other",
        },

        /* What THIS company calls it, when the kind is not specific enough.
           "Other" covers a hundred real documents — a franchise agreement, a
           pollution board consent, a lease addendum — and filing all of them
           under one word makes the list unreadable. The kind stays machine-
           readable and answerable ("is the GST certificate on file"); the label
           is what a person reads. */
        label: { type: String, trim: true, maxlength: 160, default: "" },

        /* ── ONE DOCUMENT, SEVERAL FILES ───────────────────────────────────
           An Aadhaar has a front and a back. A certificate of incorporation
           runs to four pages. A rent agreement runs to twenty. Before this,
           each of those had to be uploaded as a SEPARATE document, so the
           list showed "Aadhaar" twice with no way to tell which side was
           which, and a reader could not tell a two-page certificate from two
           unrelated files.

           BACKWARDS COMPATIBILITY, deliberately not a migration: rows written
           before this change carry their single file in the legacy top-level
           fields below and have an empty `files`. Nothing rewrites them —
           reads go through `filesOfDoc()`, which returns `files` when it has
           any and synthesises file zero from the legacy fields when it does
           not. A migration would have to touch every company on every
           deployment to fix data that reads correctly as it stands. */
        files: [
          {
            driveFileId: { type: String, default: "" },
            name: { type: String, trim: true, maxlength: 260 },
            mimeType: { type: String, default: "application/octet-stream" },
            bytes: { type: Number, default: 0 },
            /* "Front", "Back", "Page 2" — what this file is WITHIN the
               document. Free text on purpose: front/back and page numbers do
               not share a vocabulary, and an enum would have to guess which
               one a given document uses. */
            caption: { type: String, trim: true, maxlength: 80, default: "" },
            uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
            uploadedByName: { type: String, trim: true, default: "" },
            uploadedAt: { type: Date, default: Date.now },
          },
        ],

        /* ── LEGACY SINGLE-FILE FIELDS ─────────────────────────────────────
           Kept, never written to by new uploads. See the note on `files`. */
        name: { type: String, trim: true, maxlength: 260 },
        mimeType: { type: String, default: "application/octet-stream" },
        bytes: { type: Number, default: 0 },
        driveFileId: { type: String, default: "" },

        note: { type: String, trim: true, maxlength: 300 },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
        uploadedByName: { type: String, trim: true, default: "" },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    // Tally provenance
    isImportedFromTally: { type: Boolean, default: false },
    tallyCompanyGuid: { type: String }, // Tally's internal UUID if available
    lastTallySync: { type: Date },

    // CMS link — typically the host's own org
    isPrimary: { type: Boolean, default: false }, // set on the GRAV Clothing record itself
    isActive: { type: Boolean, default: true },

    /* The company-wide fallback credit period, used only when a bill's
       party ledger carries no term of its own — C0-F's historical backfill
       is the first consumer. `null` is the ONLY meaning of "unset". There is
       deliberately NO built-in default (not 30, not any other number): a
       bill dated off a number nobody at the company approved is a worse
       outcome than one left undated, because it looks authoritative while
       being invented. See docs/tasks/accountant-cash-flow-forecast.md
       §C1.4/§6.0 for the reasoning this repeats from the party-level
       credit-terms rule. Written only by
       `PATCH /api/accountant/tally/companies/:id/default-credit-days`
       (Acc_companies.js) — the Settings → Credit Terms section of the
       accountant app. */
    defaultCreditDays: { type: Number, default: null },
    defaultCreditDaysUpdatedAt: { type: Date, default: null },
    defaultCreditDaysUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },
    defaultCreditDaysUpdatedByName: { type: String, default: null },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
  },
  { timestamps: true, collection: "acc_companies" },
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
//   Capital Account, Loans & Advances (Liability), Current Liabilities, Suspense A/c,
//   Branch / Divisions, Misc. Expenses (Asset), Loans & Advances (Asset),
//   Investments, Current Assets, Fixed Assets, Sales Accounts,
//   Purchase Accounts, Direct Expenses, Indirect Expenses, Direct Incomes,
//   Indirect Incomes, …
const ACC_DEFAULT_GROUPS = [
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
    name: "Loans & Advances (Liability)",
    nature: "liability",
    isReserved: true,
    parent: null,
    isPrimary: true,
  },
  {
    name: "Bank OD A/c",
    nature: "liability",
    isReserved: true,
    parent: "Loans & Advances (Liability)",
  },
  {
    name: "Secured Loans",
    nature: "liability",
    isReserved: true,
    parent: "Loans & Advances (Liability)",
  },
  {
    name: "Unsecured Loans",
    nature: "liability",
    isReserved: true,
    parent: "Loans & Advances (Liability)",
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

  // Acc_Expense
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
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },

    // Either parent (sub-group) or null (one of the 28 primaries)
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Group",
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
    // alphabetical sort at render time. Same idea as Acc_Ledger.groupOrder.
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
      ref: "Acc_Department",
    },
  },
  { timestamps: true, collection: "acc_groups" },
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
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    aliases: [{ type: String, trim: true }], // alternate names — Tally supports these natively

    // Group reference
    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Group",
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
      ref: "Acc_User",
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

    /* ── CAN THIS HEAD CARRY A BUDGET? ──────────────────────────────────────
       A control layer over the chart of accounts. It changes NOTHING about
       bookkeeping — no posting, no debit, no credit reads this field. It
       decides only which heads budget screens offer and which the voucher
       budget check looks at.

       `nature` alone could not answer this. Round Off is an expense and is
       not a budget head; a tax control account an import parented under an
       expense group is not either. Three values, no more:

         expense_budget   controllable spend, including raw material, job
                          work, freight, consumables and services
         revenue_target   income — a floor to reach, never a spending cap
         not_budgeted     never offered, never checked, never reported as
                          missing a budget

       ── ABSENT MEANS "DERIVE IT" ─────────────────────────────────────────
       Deliberately no default. Every ledger written before this field is
       classified on read by budgetClassification.budgetControlOf(), from its
       own nature, group and name — so the whole system behaves correctly
       before the backfill runs, and the backfill is an optimisation rather
       than a precondition. A value stored here is finance's decision and is
       never re-derived: see `budgetControlSetAt`. */
    budgetControl: {
      type: String,
      enum: ["expense_budget", "revenue_target", "not_budgeted"],
      index: true,
    },
    /* Set only when a human chose. Its presence is what makes the backfill
       skip a row — without it there is no way to tell finance's deliberate
       "not budgeted" from a value the previous backfill guessed. */
    budgetControlSetAt: { type: Date },
    budgetControlSetBy: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_User" },
    budgetControlSetByName: { type: String, trim: true },

    // Opening balance — Tally stores this signed
    openingBalance: { type: Number, default: 0 }, // signed: positive = Dr, negative = Cr
    openingBalanceType: { type: String, enum: ["Dr", "Cr"], default: "Dr" },
    openingBalanceDate: { type: Date },

    // Running balance (re-computed on voucher post)
    currentBalance: { type: Number, default: 0 }, // signed
    currentBalanceType: { type: String, enum: ["Dr", "Cr"], default: "Dr" },

    // When true, openingBalance/currentBalance hold the AUTHORITATIVE
    // closing balance taken directly from the Tally Trial Balance
    // export (which already did opening + all movements). The Balance
    // Sheet then uses it AS-IS and does NOT re-add Day-Book movements
    // (re-adding caused period-gap / sign / double-count errors).
    balanceFromTrialBalance: { type: Boolean, default: false },

    // Tax & statutory
    gstApplicable: { type: Boolean, default: false },
    gstRegistrationType: {
      type: String,
      enum: ["regular", "composition", "consumer", "unregistered", "unknown"],
      default: "unknown",
    },
    gstin: { type: String, trim: true },
    // Additional GSTINs — for a vendor/customer with more than one GST
    // registration (e.g. branches in different states, or multiple
    // registrations under the same PAN). The PRIMARY GSTIN stays in `gstin`
    // above and remains what every report / voucher / e-way-bill reads by
    // default; these are extra options the user can pick from on a voucher.
    additionalGstins: [
      {
        _id: false,
        gstin: { type: String, trim: true },
        label: { type: String, trim: true }, // optional human label e.g. "Mumbai branch"
        stateCode: { type: String, trim: true },
        state: { type: String, trim: true },
      },
    ],
    /* ── WHAT THE GST NETWORK SAYS ABOUT THIS PARTY ─────────────────────
     * Stored, not merely displayed, because it is a fact about the books
     * rather than a state of a screen.
     *
     * A supplier whose registration was CANCELLED is not a cosmetic problem:
     * input tax credit claimed against a cancelled GSTIN is disallowed, and
     * it is found at assessment, long after the money is spent. A customer
     * with a dead GSTIN gets the wrong invoice treatment. Neither is visible
     * anywhere in the ledger today.
     *
     * `checkedAt` matters as much as `status`: a registration cancelled last
     * month makes a check from last year worthless, so every reader can see
     * how old the answer is and decide for itself.
     */
    gstVerification: {
      /* unchecked | active | cancelled | not-found | mismatch | unavailable
         `mismatch` = the register knows this GSTIN but under another name.
         `unavailable` = we could not ask; NOT a verdict on the party. */
      status: { type: String, default: "unchecked" },
      /* The name the register holds, kept verbatim so a mismatch can be read
         rather than just flagged. */
      legalName: { type: String, trim: true, default: "" },
      tradeName: { type: String, trim: true, default: "" },
      registrationDate: { type: String, trim: true, default: "" },
      taxpayerType: { type: String, trim: true, default: "" },
      cancelledDate: { type: String, trim: true, default: "" },
      /* Which provider answered, so a bad batch can be traced to its source. */
      source: { type: String, trim: true, default: "" },
      checkedAt: { type: Date, default: null },
      /* Why it could not be checked, when it could not be. */
      note: { type: String, trim: true, default: "" },
    },

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

    /* `creditPeriodDays` predates the cash-flow work. Its default of 0 means
       UNSET, not "due on receipt" — every one of the 441 ledgers held that
       default when credit-terms editing was added, so reading 0 as same-day
       terms would date every open bill to its own invoice date. Due-on-receipt,
       if it is ever wanted, needs to be its own explicit concept.
       See services/creditTerms.service.js. */
    creditPeriodDays: { type: Number, default: 0 },
    creditLimit: { type: Number, default: 0 },

    /* Provenance for the credit term. Written server-side only — a client that
       could set these could claim any origin for a number it invented.
       `creditTermsSource` is null while the term is unset, which is what
       separates "explicitly cleared" from "never touched". */
    creditTermsSource: {
      type: String,
      enum: ["manual", "inherited", "default", null],
      default: null,
    },
    creditTermsUpdatedAt: { type: Date },
    creditTermsUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Department",
    },
    creditTermsUpdatedByName: { type: String, trim: true },

    // Cost centre allocation
    costCentreApplicable: { type: Boolean, default: false },
    defaultCostCentreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_CostCentre",
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
      ref: "Acc_Department",
    },
  },
  { timestamps: true, collection: "acc_ledgers" },
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
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_CostCentre",
      default: null,
    },
    parentName: { type: String, trim: true },
    category: { type: String, trim: true }, // e.g. "Departments", "Branches", "Projects"
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
    notes: { type: String, trim: true },
  },
  { timestamps: true, collection: "acc_cost_centres" },
);

tallyCostCentreSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// 5. TALLY UNIT (of Measure)
// ─────────────────────────────────────────────────────────────────────────────
const tallyUnitSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
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
  { timestamps: true, collection: "acc_units" },
);

tallyUnitSchema.index({ companyId: 1, symbol: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// 6. TALLY STOCK GROUP
// ─────────────────────────────────────────────────────────────────────────────
const tallyStockGroupSchema = new mongoose.Schema(
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
      ref: "Acc_StockGroup",
      default: null,
    },
    parentName: { type: String, trim: true },
    shouldQuantitiesAdd: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
    tallyGuid: { type: String },
  },
  { timestamps: true, collection: "acc_stock_groups" },
);

tallyStockGroupSchema.index({ companyId: 1, name: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// 7. TALLY STOCK ITEM
// ─────────────────────────────────────────────────────────────────────────────
const tallyStockItemSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    aliases: [{ type: String, trim: true }],

    stockGroupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_StockGroup",
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
  { timestamps: true, collection: "acc_stock_items" },
);

tallyStockItemSchema.index({ companyId: 1, name: 1 }, { unique: true });
tallyStockItemSchema.index({ companyId: 1, stockGroupId: 1 });
tallyStockItemSchema.index({ aliases: 1 });

// ─────────────────────────────────────────────────────────────────────────────
// MODEL EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
const Acc_Company = mongoose.model("Acc_Company", tallyCompanySchema);
const Acc_Group = mongoose.model("Acc_Group", tallyGroupSchema);
const Acc_Ledger = mongoose.model("Acc_Ledger", tallyLedgerSchema);
const Acc_CostCentre = mongoose.model("Acc_CostCentre", tallyCostCentreSchema);
const Acc_Unit = mongoose.model("Acc_Unit", tallyUnitSchema);
const Acc_StockGroup = mongoose.model("Acc_StockGroup", tallyStockGroupSchema);
const Acc_StockItem = mongoose.model("Acc_StockItem", tallyStockItemSchema);

module.exports = {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
  Acc_CostCentre,
  Acc_Unit,
  Acc_StockGroup,
  Acc_StockItem,
  ACC_DEFAULT_GROUPS,

  // The document catalogue and its two readers. Exported so the route can
  // serve the list to the form and both can agree on what a document is
  // called — see the note above the catalogue.
  ACC_COMPANY_DOC_KINDS,
  ACC_COMPANY_DOC_KIND_VALUES,
  ACC_COMPANY_DOC_KIND_BY_VALUE,
  filesOfDoc,
  labelOfDoc,
};
