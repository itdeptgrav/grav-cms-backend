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
    /* ── WHAT THIS LINE IS ABOUT ──────────────────────────────────────────
     * `ledgerId` is the real binding. Actuals are summed from posted vouchers
     * against this head, which is the only way the budget can ever agree with
     * the trial balance and the P&L.
     *
     * `category` is kept because every pre-existing row has one and nothing
     * else. It is now a LABEL, not a join key — the old exact-string match
     * against Acc_Expense.category read zero the moment anyone renamed a
     * category, and counted expenses only. A line with no ledgerId still
     * renders, flagged `unbound`, rather than silently reporting comfort. */
    ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger", index: true },
    ledgerName: { type: String, trim: true }, // denormalised — survives renames
    groupName: { type: String, trim: true },

    category: { type: String, trim: true },

    /* ── WHERE THIS LINE CAME FROM (Chunk 3) ──────────────────────────────
     * Set when finance agrees a department request and the agreement becomes
     * an approved allocation. It is what makes agreeing the SAME request twice
     * update one line instead of quietly adding a second: without it, finance
     * revising an agreed amount from 3L to 4L would leave 7L allocated.
     *
     * Deliberately NOT unique and NOT a merge key across requests. Two
     * separate requests from the same department against the same head are
     * legitimate — two purposes, two asks — and collapsing them would destroy
     * the distinction the requests were raised to make. One request, one line.
     *
     * Absent on every hand-written line, which is the normal case. */
    sourceRequestId: {
      type: mongoose.Schema.Types.ObjectId,
      index: true,
    },

    /* Snapshot of the ledger group's nature at the time the line was written.
     * The ledger tree stays the authority at read time (see
     * budgetActuals.service.js); this exists so an unbound legacy line and an
     * offline export still know which way the variance sign runs. */
    nature: {
      type: String,
      enum: ["revenue", "expense"],
      default: "expense",
      index: true,
    },

    /* Which team owns the number. Still TEXT, and deliberately not a ref to
     * Acc_BudgetDepartment: budgets written before that registry existed have
     * to keep reading, and a company that never opens the departments screen
     * has to keep working. budgetDepartment.service turns whatever is stored
     * here into a stable identity, so "Logistics", "logistics" and
     * "LOGISTICS " group as one department whether or not anyone registered
     * it. Writes store the registry's spelling when it knows the department. */
    department: { type: String, trim: true, index: true },
    ownerEmail: { type: String, trim: true, lowercase: true },

    /* ── WHICH PROJECT THE LINE IS FOR ──────────────────────────────────────
     * Optional, and the ONLY thing that makes a project budget a control
     * rather than a label.
     *
     * Without it a line matches spend on ledger + company + date, so a budget
     * named after one project claims every rupee spent on that head across
     * every project. With it, actuals count only voucher allocations tagged to
     * this cost centre — see budgetActuals.hydrateLines.
     *
     * A real ref, unlike `department`: Acc_CostCentre is company-scoped,
     * already exists, and a cost centre's identity is an id rather than a
     * spelling, so none of the reasons department stayed text apply. The NAME
     * is snapshotted beside it so a deleted or renamed cost centre still reads
     * on an old budget. */
    costCentreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_CostCentre",
      index: true,
    },
    costCentreName: { type: String, trim: true },

    allocatedAmount: { type: Number, required: true, min: 0 },

    /* Optional seasonal weights, one per bucket of the period. Any scale —
     * they are normalised. A garment exporter does not earn one twelfth of its
     * revenue each month, and straight-lining a Diwali-heavy year makes every
     * month until October look like a miss. Empty ⇒ straight-line. */
    phasing: { type: [Number], default: undefined },

    /* ── HOW THE AMOUNT DIVIDES ACROSS THE MONTHS ──────────────────────────
     * `even` — the default and what every existing row behaves as: the amount
     * straight-lines across the months the period covers.
     * `custom_monthly` — `monthlyPhasing` carries absolute rupees per calendar
     * month, and must add up to `allocatedAmount`. A garment exporter does not
     * earn one twelfth of its revenue each month, and marketing does not spend
     * one twelfth against a festival; straight-lining either makes every month
     * before the spike read as a miss and the spike itself read as a breach.
     *
     * Applies to BOTH natures. An expense plan and a revenue target are the
     * same arithmetic here, and phasing only sales would leave every seasonal
     * cost straight-lined.
     *
     * Absolute amounts rather than weights on purpose: "do these twelve
     * figures add up to what was approved" is a question with one answer and
     * it is the one finance asks, where "is 3,1,1,1 right" has none. See
     * services/budgetPhasing.service.js — the only place this is interpreted. */
    phasingMode: {
      type: String,
      enum: ["even", "custom_monthly"],
      default: "even",
    },
    monthlyPhasing: {
      type: [
        {
          _id: false,
          month: { type: String, trim: true }, // "YYYY-MM", IST
          amount: { type: Number, min: 0 },
        },
      ],
      default: undefined,
    },

    /* Cached figures. Recomputed from vouchers on every read, so these are a
     * convenience for exports and list views, never the source of truth. */
    spentAmount: { type: Number, default: 0 },
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
      /* Millisecond timestamp ALONE is not unique enough for a uniquely-indexed
       * field: two budgets created in the same millisecond collided and the
       * second one's insert threw. Now matches the random-suffix pattern
       * `expenseId` and `transactionId` in this same file already use.
       * (`.slice` rather than their deprecated `.substr` — identical output.)
       *
       * Existing rows keep whatever budgetId they were given; this is a
       * default for new documents only, and nothing in the codebase parses or
       * queries this value by format. */
      default: () =>
        `BUD-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    },
    name: { type: String, required: true, trim: true },
    financialYear: { type: String, required: true },
    period: {
      type: String,
      enum: ["monthly", "quarterly", "half_yearly", "yearly"],
      required: true,
    },

    /* ── WHAT KIND OF BUDGET THIS IS (Slice A) ───────────────────────────────
     * Until now a budget was a name, a period and a list of lines, and nothing
     * said whether "Freight & Forwarding — Q2" was the company's freight
     * budget, Logistics' own envelope, or a site's. The list could not lead
     * with the right thing because it could not know — which is exactly why it
     * read as an arbitrary pile.
     *
     *   company     one shared envelope; departments appear as items[]
     *   department  one department owns the whole budget
     *   project     one project / cost centre owns the whole budget
     *
     * Defaults to `company` so every existing row keeps behaving exactly as it
     * does today without a migration: that is what they all are.
     *
     * DELIBERATELY INERT FOR NOW. Nothing about actuals, variance, budget
     * control or the roll-up reads this field yet. It is the identity the
     * later slices need — precedence when budgets overlap (Chunk B) and
     * cost-centre-aware actuals — and adding it early means those slices
     * inherit a populated field instead of paying for the migration too. */
    scope: {
      type: String,
      enum: ["company", "department", "project"],
      default: "company",
      index: true,
    },

    /* Owner of a `department`-scope budget.
     *
     * Text, matching `items[].department` and `budgetRequests[].department`,
     * and resolved through Acc_BudgetDepartment on read and write — see
     * budgetDepartment.service.js. Soft rather than a ref on purpose: this is
     * the IDENTITY of a department budget, so a hard ref would mean a company
     * could not save one until someone had populated a registry, and every
     * pre-registry budget would have to be migrated before it read again. */
    department: { type: String, trim: true },

    /* Owner of a `project`-scope budget.
     *
     * `Acc_CostCentre` exists as a model, so the reference is real. But zero
     * cost centres are defined and zero of ~1,700 vouchers tag one, so the id
     * is OPTIONAL and the name is stored beside it: a project budget can be
     * identified by name alone today and gain a real reference later without
     * a second migration.
     *
     * Note this does NOT make project actuals work — spend is still matched on
     * ledger + company + date, so a project budget still claims every rupee on
     * its heads company-wide. That is §5 of the brief, not this slice. */
    costCentreId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_CostCentre",
    },
    costCentreName: { type: String, trim: true },
    month: { type: Number, min: 1, max: 12 },
    quarter: { type: Number, min: 1, max: 4 },
    /* WHEN THE MONEY APPLIES. */
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },

    /* ── WHEN DEPARTMENTS MAY ASK ────────────────────────────────────────────
     * A different range from the two above, and normally not overlapping them
     * at all: departments budget for a year in the March BEFORE it starts.
     * Collapsing the two — which is what this module did until now — forced a
     * choice between letting departments submit into a year already half
     * spent, or bending "period" to mean the asking season and making the
     * money dates untrue.
     *
     * Optional, and absent means UNRESTRICTED. Every round created before this
     * existed keeps behaving exactly as it did: open whenever its status says
     * collecting. Setting a date is what begins enforcing one.
     *
     * Not required to sit inside the budget period, and deliberately not
     * validated against it — see budgetSubmissionWindow.service. */
    submissionStartDate: { type: Date },
    submissionEndDate: { type: Date },

    /* ── THE DRAFTS THIS CYCLE WENT THROUGH ─────────────────────────────────
     * A budget is not set in one pass. Draft 1 opens, departments submit, the
     * deadline closes it, THE MEETING happens, and Draft 2 opens carrying
     * whatever was not settled. Two of them; see budgetDraft.service for why
     * a third is the remainder of a remainder.
     *
     * ── WHY THIS IS HISTORY AND NOT ENFORCEMENT ─────────────────────────────
     * The two dates above remain the ACTIVE draft's window, and every existing
     * reader of them — the department's submission gate, `windowState`,
     * `isOpenForSubmissions` — keeps working without knowing drafts exist.
     * Opening Draft 2 moves those two dates. This array records what happened;
     * it is deliberately not a second source of truth about whether a
     * department may submit right now, because two of those eventually
     * disagree and then no screen knows which to believe.
     *
     * Absent on every cycle opened before this existed. Those are read as a
     * single Draft 1 using the window they already have — which is what they
     * always were, so nothing is migrated. */
    drafts: [
      {
        _id: false,
        number: { type: Number, required: true },
        opensOn: { type: Date },
        closesOn: { type: Date },
        openedBy: { type: String, trim: true },
        openedAt: { type: Date },
        /* When it actually stopped taking submissions, which is not always the
           day it was due to: finance may close a draft early once everybody
           has submitted, and the meeting is then held sooner. */
        closedAt: { type: Date },
        /* What the meeting decided, in the words of whoever opened the next
           draft. The one place the reason for a second round is recorded. */
        note: { type: String, trim: true },
        /* How many requests came into this draft from the previous one — the
           size of the argument still outstanding when it opened. */
        carriedForward: { type: Number, default: 0 },
      },
    ],

    items: [budgetItemSchema],

    /* Which books this belongs to. The app has a company selector and the
     * voucher aggregation filters on it, so a budget without one would read
     * every company's postings into its actuals. */
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Acc_Company",
      index: true,
    },

    totalAllocated: { type: Number, default: 0, min: 0 },
    totalSpent: { type: Number, default: 0, min: 0 },
    totalRemaining: { type: Number, default: 0 },

    /* Revenue and expense totals kept apart. A single "allocated" figure that
     * adds a sales target to a freight budget is a number with no meaning. */
    totalRevenueAllocated: { type: Number, default: 0 },
    totalExpenseAllocated: { type: Number, default: 0 },

    status: {
      type: String,
      enum: ["draft", "collecting", "review", "active", "closed", "exceeded"],
      default: "draft",
      index: true,
    },

    /* ── THE DEPARTMENT COLLECTION CYCLE ──────────────────────────────────
     * Budgets need inputs from every department, and a cycle that cannot close
     * because one team never replied is the normal failure. So the cycle has a
     * due date and an explicit per-department state, and finance can close it
     * with whatever arrived — the departments that did not submit are recorded
     * as such rather than quietly inheriting a number nobody argued about. */
    submissionsDueBy: { type: Date },
    submissions: [
      {
        department: { type: String, trim: true, required: true },
        state: {
          type: String,
          enum: ["awaiting", "submitted", "countered", "agreed", "defaulted"],
          default: "awaiting",
        },
        /* The envelope finance offered, and what the department asked for.
         * Both are kept so the negotiation has a memory. */
        envelopeAmount: { type: Number },
        requestedAmount: { type: Number },
        agreedAmount: { type: Number },
        submittedAt: { type: Date },
        submittedBy: { type: String, trim: true },
        note: { type: String, trim: true },
      },
    ],
    /* ── DEPARTMENT BUDGET REQUESTS (Chunk 2) ─────────────────────────────
     * A department saying: "for this period and this head, we need this much,
     * for this purpose, at this priority." An INPUT to finance review — not an
     * approved allocation. Nothing here becomes a budget line; converting a
     * request into `items[]` is a separate, deliberate step (Chunk 3).
     *
     * ── WHY A NEW ARRAY AND NOT MORE FIELDS ON `submissions` ──────────────
     * They have different cardinality, and that is not a stylistic preference.
     * `submissions` is ONE ROW PER DEPARTMENT: POST /:id/submissions upserts
     * by `.find(s => s.department === department)`, and close-collection walks
     * every row assuming it is that department's single answer, defaulting the
     * ones that never replied. A request is one row per department PER LEDGER
     * HEAD — Logistics asking for freight AND courier is two requests. Putting
     * those in `submissions` would make the upsert match the wrong row and
     * make close-collection mark a department "agreed" off whichever head it
     * happened to hit first. Existing rows, routes and tests are untouched by
     * a new array; they could not be by a widened one.
     *
     * The two are related but not the same conversation: `submissions` is the
     * envelope finance offers a department, `budgetRequests` is what the
     * department asks for against specific heads. */
    budgetRequests: [
      {
        /* Who is asking. Text matching `items[].department` and
         * `submissions[].department`, canonicalised on write against
         * Acc_BudgetDepartment — two spellings of one department in a single
         * collection round would make close-collection default one of them as
         * never having replied. */
        department: { type: String, trim: true, required: true },

        /* WHAT is being asked for. `ledgerId` is the real binding, for the
         * same reason budget lines bind to one: a head, not a free-text
         * category. Name and group are denormalised so a request stays
         * readable after a rename, exactly as `items[]` does. */
        /* NOT required, because a department may be budgeting for something
         * the chart of accounts has no head for yet — see `requestedHead`.
         * The invariant is "one of the two", enforced by the validator on
         * this subdocument and again at the route. An allocation is still
         * NEVER written without a real ledger: finance resolves the requested
         * head onto this very field before agree will run. */
        ledgerId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Acc_Ledger",
          index: true,
        },
        ledgerName: { type: String, trim: true },
        groupName: { type: String, trim: true },

        /* ── A HEAD THAT DOES NOT EXIST YET ───────────────────────────────
         * A tech department budgeting for Claude, Copilot and Codex should
         * not have to file all three under "Software Expenses" because that
         * is the only head on the list — a budget whose heads are the wrong
         * shape stops being a plan and becomes a formality.
         *
         * So the department asks for a head. It does NOT create a ledger:
         * that is an accounting decision with consequences for every report,
         * and it stays finance's. Finance maps the ask to an existing ledger,
         * creates one through the chart of accounts and maps it, or refuses.
         *
         * On resolution the real ledger is written onto `ledgerId` above, so
         * everything downstream — agree, syncAllocationFromRequest, the
         * department tracker — carries on unchanged. This subdocument is the
         * record of the conversation, not a second binding. */
        requestedHead: {
          type: {
            _id: false,
            name: { type: String, trim: true },
            nature: { type: String, enum: ["revenue", "expense"] },
            reason: { type: String, trim: true },
            suggestedGroupName: { type: String, trim: true },
            /* What the department thinks it might belong under, if anything.
             * A hint for finance, never a binding. */
            suggestedLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
            state: {
              type: String,
              enum: ["requested", "mapped", "created", "rejected", "clarification"],
              default: "requested",
            },
            resolvedLedgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
            resolvedLedgerName: { type: String, trim: true },
            financeNote: { type: String, trim: true },
            requestedBy: { type: String, trim: true },
            requestedAt: { type: Date },
            resolvedBy: { type: String, trim: true },
            resolvedAt: { type: Date },
          },
          default: undefined,
        },
        nature: {
          type: String,
          enum: ["revenue", "expense"],
          default: "expense",
        },

        requestedAmount: { type: Number, required: true, min: 0 },

        /* The department's PROPOSED split, and finance's counter to it.
         * Same shape as the allocation line's, so agreeing a request can hand
         * the phasing straight over without a translation step that could
         * disagree with itself.
         *
         * `monthlyPhasing` is what was asked for; `agreedMonthlyPhasing` is
         * what finance settled on. Kept apart for the same reason
         * `requestedAmount` and `agreedAmount` are: overwriting the ask with
         * the answer destroys the record of what was actually requested. */
        phasingMode: {
          type: String,
          enum: ["even", "custom_monthly"],
          default: "even",
        },
        monthlyPhasing: {
          type: [{ _id: false, month: { type: String, trim: true }, amount: { type: Number, min: 0 } }],
          default: undefined,
        },
        agreedPhasingMode: {
          type: String,
          enum: ["even", "custom_monthly"],
        },
        agreedMonthlyPhasing: {
          type: [{ _id: false, month: { type: String, trim: true }, amount: { type: Number, min: 0 } }],
          default: undefined,
        },

        priority: {
          type: String,
          enum: ["low", "normal", "high", "critical"],
          default: "normal",
        },

        /* Why. One of these is required at the route — a number with no stated
         * reason is not reviewable, and finance rejecting it has nothing to
         * respond to. */
        purpose: { type: String, trim: true },
        justification: { type: String, trim: true },

        /* ── THE LINE-BY-LINE DERIVATION ──────────────────────────────────
         * How the requested figure was built: 5 users × ₹6,000 × 12 months,
         * and so on. `justification` is prose a reviewer reads; this is
         * arithmetic a reviewer can argue with a row at a time.
         *
         * Every non-manual row's `amount` is RECOMPUTED server-side from its
         * own quantity, rate and multiplier — see budgetWorking.service.js.
         * A stored amount that disagrees with its own inputs would be a
         * derivation that does not derive, which is worse than no breakdown.
         *
         * `manualAmount` marks a row that genuinely does not fit the shape —
         * a negotiated lump sum, a quoted figure — so a reviewer can see which
         * numbers were computed and which were asserted. */
        workingLines: {
          type: [
            {
              _id: false,
              label: { type: String, trim: true },
              description: { type: String, trim: true },
              quantity: { type: Number, min: 0 },
              unit: { type: String, trim: true },
              rate: { type: Number, min: 0 },
              multiplier: { type: Number, min: 0 },
              multiplierUnit: { type: String, trim: true },
              amount: { type: Number, min: 0 },
              manualAmount: { type: Boolean, default: false },

              /* ── WHAT FINANCE SAID ABOUT THIS ROW ────────────────────────
               * Finance's answer used to be one number for the whole head,
               * which is too coarse for the argument they actually want to
               * have: yes to the festival, half the annual day, no to the
               * monthly lunches. Countering at a single figure says none of
               * that, and the department's next draft is a guess at which row
               * was meant.
               *
               * These rows do NOT become accounting lines. The allocation is
               * still one budget line per head, written by
               * syncAllocationFromRequest from `agreedAmount` — these only
               * DERIVE that figure, so the ledger never learns rows exist.
               * See services/budgetLineReview.service.js.
               *
               * Every field is additive and optional: a proposal written
               * before any of this reads correctly with all of them absent,
               * which is what "pending" means. */

              /* ── A ROW HAD NO WAY TO BE ADDRESSED ────────────────────────
               * This array is `_id: false`, so a row could only be pointed at
               * by its POSITION. Position is not identity: a department
               * revising an ask inserts and reorders rows, and a decision
               * recorded against index 2 would silently reattach itself to
               * whatever landed there. Assigned on first write rather than by
               * a migration over every budget in the system. */
              rowId: { type: String, trim: true },

              /* Absent IS pending — an unanswered row is not a stored state. */
              decision: {
                type: String,
                enum: ["approved", "countered", "refused"],
              },
              /* Stated rather than implied, including the zero on a refusal:
               * a refused row that kept its asked amount would roll up into
               * the head total as though it had been funded. */
              approvedAmount: { type: Number, min: 0 },
              /* Required by the route for a counter or a refusal. "₹70,000 →
               * ₹0" with no sentence beside it is not something a department
               * can revise against. */
              financeNote: { type: String, trim: true },
              decidedBy: { type: String, trim: true },
              decidedAt: { type: Date },

              /* ── WHOSE TURN IT IS ────────────────────────────────────────
               * A countered row is an open question, and turning one into an
               * allocation before the department has answered writes
               * finance's own figure into the budget and calls it agreement.
               * Cleared whenever the row is decided again, so an acceptance
               * of the PREVIOUS counter cannot make the new one look
               * answered. */
              departmentAccepted: { type: Boolean },
              departmentRespondedAt: { type: Date },

              /* ── A ROW THAT CARRIES ITS OWN MONTHS ───────────────────────
               * A month-wise line describes what each item costs in each
               * month rather than a quantity times a rate. The row's amount
               * is then the sum of these, and the line's monthly phasing is
               * the sum of every row's — so the plan and the working that
               * produced it can never drift apart.
               *
               * Optional and additive. A row without it behaves exactly as it
               * always has, which is what every existing proposal relies on.
               * Recomputed server-side like every other figure here — see
               * budgetWorking.service. */
              monthly: {
                type: [
                  {
                    _id: false,
                    month: { type: String, trim: true },
                    amount: { type: Number, min: 0 },
                  },
                ],
                default: undefined,
              },
            },
          ],
          default: undefined,
        },

        /* Set only when the ask deliberately differs from what its own rows
         * add up to. The reason is required at the route — an unexplained
         * mismatch is refused rather than stored, because it reads as a
         * derivation while not being one. */
        manualAmountOverride: { type: Boolean, default: false },
        manualOverrideReason: { type: String, trim: true },

        /* When the department expects to need it. `expectedMonth` (1-12) is
         * the convenience for a single-month ask; from/to covers a spread.
         * Both optional — plenty of requests are simply "this period". */
        expectedMonth: { type: Number, min: 1, max: 12 },
        expectedFrom: { type: Date },
        expectedTo: { type: Date },

        /* Same vocabulary as `submissions[].state`, deliberately: it is the
         * same negotiation shape, and two different words for "countered"
         * across one module would be worse than the duplication. */
        state: {
          type: String,
          /* ── `rejected` IS NOT "KILLED" ────────────────────────────────
           * Finance refusing an ask with a reason sends it BACK: the line
           * carries into the next draft, and the department revises it or
           * drops it themselves. A budget round has no way to delete somebody
           * else's priority — it can only decline to fund it and say why.
           *
           * It exists so that "answered" and "agreed" stop being the same
           * word. Draft 2 cannot open with anything unanswered, and before
           * this there was no way to answer NO. */
          enum: ["awaiting", "submitted", "countered", "agreed", "defaulted", "rejected"],
          default: "submitted",
          index: true,
        },

        /* Who answered this ask, and when. Written on a refusal; an agreement
           has `agreedAmount` and its own allocation line to date it. Without
           these two, the reject route's fields were dropped silently by strict
           mode and the trail recorded only that the state had changed. */
        decidedAt: { type: Date },
        decidedBy: { type: String, trim: true },

        /* ── WHICH DRAFT THIS BELONGS TO ────────────────────────────────
         * A budget is not set in one pass: Draft 1 is submitted, a meeting
         * happens, and Draft 2 reopens whatever was not settled. Absent on
         * every request raised before drafts existed, which is read as 1 —
         * they were all the first round, so nothing needs migrating.
         *
         * `revisionOf` points at the same ask in the previous draft, and
         * `supersededByDraft` marks the older row as history. Both, rather
         * than editing the original in place: what a department FIRST asked
         * for, against what they came back with, is the number the second
         * meeting is actually about, and an edit would destroy it. */
        draft: { type: Number, default: 1, index: true },
        revisionOf: { type: mongoose.Schema.Types.ObjectId },
        supersededByDraft: { type: Number },

        /* Finance's side of the exchange. Written by finance, not the
         * requester — Chunk 2 stores them; the UI that drives them is later. */
        financeNote: { type: String, trim: true },
        counterAmount: { type: Number, min: 0 },
        agreedAmount: { type: Number, min: 0 },

        note: { type: String, trim: true },

        /* Audit-friendly without inventing an audit system: who and when, for
         * both the original submission and the last edit. Server-derived — a
         * client that could set these could claim any author for a number. */
        submittedAt: { type: Date },
        submittedBy: { type: String, trim: true },
        updatedAt: { type: Date },
        updatedBy: { type: String, trim: true },
      },
    ],

    /* ── ONE OF THE TWO, ALWAYS ──────────────────────────────────────────────
     * A request names either a real ledger or a head it wants finance to
     * create. Neither is not a request — it is a number with nothing to post
     * against, and the route that let one through would be found weeks later
     * by a report that silently omitted it.
     *
     * Enforced on the schema as well as the route, because the route is one
     * of several places a request could be written from (an import, a script,
     * a future endpoint) and this invariant is the one that keeps
     * `syncAllocationFromRequest` honest. */
    /* ── ADJUSTMENTS (Chunk 7) ───────────────────────────────────────────────
     * The legitimate way to change an allocation after the budget is live.
     *
     * Chunk 6 made over-budget spend require a written override. That was the
     * point, but an override is meant to be exceptional — a team that needs
     * more money every week ends up writing the same excuse every week, and a
     * control everyone routinely waves through has stopped being a control.
     * This is the path that fixes the NUMBER instead of excusing the breach.
     *
     * Deliberately a separate array from `budgetRequests`. A request asks for
     * a head to be funded in the first place and produces a NEW `items[]`
     * line; an adjustment changes an allocation that already exists and
     * targets one. Widening `budgetRequests` to carry both would have made
     * `sourceRequestId` mean two different things and left every consumer
     * guessing which kind it was holding.
     *
     * Two shapes, one array, because they differ only in how the new number
     * is stated and share every rule about who may ask, who may approve, and
     * what approving does:
     *   supplementary — "₹5L MORE on top of what we have"  (delta)
     *   revision      — "make it ₹7L"                       (absolute) */
    adjustments: [
      {
        type: {
          type: String,
          enum: ["supplementary", "revision"],
          required: true,
        },

        /* The line being changed. An adjustment with no target is meaningless:
         * it is the whole difference between this and a budget request. */
        targetItemId: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
          index: true,
        },
        /* Set when the targeted line itself came from an agreed department
         * request, so the ask → allocation → top-up chain stays traceable. */
        sourceRequestId: { type: mongoose.Schema.Types.ObjectId },

        /* Denormalised from the target line at submit time, exactly as
         * `items[]` and `budgetRequests[]` denormalise theirs: the request has
         * to stay readable after a ledger rename or a re-parent. */
        department: { type: String, trim: true },
        ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
        ledgerName: { type: String, trim: true },
        groupName: { type: String, trim: true },
        nature: { type: String, enum: ["revenue", "expense"] },

        /* What the line was worth when this was asked for. A SNAPSHOT, not a
         * live read: finance approving next week must be able to see the
         * number the requester was actually looking at, and a supplementary
         * that silently re-based itself on a since-changed allocation would
         * approve an amount nobody asked for. */
        currentAllocatedAmount: { type: Number, default: 0 },

        /* Supplementary states the delta; revision states the destination.
         * Both are stored on every row — whichever the requester gave, the
         * route derives the other from the snapshot above — so a reader never
         * has to know the type to answer "what does this become?". */
        requestedDeltaAmount: { type: Number },
        requestedNewAmount: { type: Number },

        /* What finance actually granted, which need not be what was asked.
         * Absent until approval. */
        approvedDeltaAmount: { type: Number },
        approvedNewAmount: { type: Number },

        /* ── RAISING A BUDGET NEEDS THE SAME TWO PEOPLE AS BREAKING ONE ─────
         * Overspending escalates to finance and the CEO. If topping the
         * budget up did not, the way round the CEO would be obvious: ask the
         * department to raise a supplementary, have finance approve it alone,
         * and the same money goes out inside budget with nobody escalating
         * anything. One rule, both doors — see budgetEscalation.service. */
        signatures: [
          {
            _id: false,
            slot: { type: String },
            userId: { type: String },
            name: { type: String, trim: true },
            role: { type: String },
            reason: { type: String, trim: true },
            at: { type: Date },
          },
        ],

        reason: { type: String, trim: true },
        justification: { type: String, trim: true },

        /* The same line-by-line derivation a proposal can carry. "We need ₹5L
         * more" is not reviewable; "₹5L more because the seat count went from
         * 5 to 12" is. Optional, recomputed server-side by
         * budgetWorking.service exactly as a proposal's rows are — a stored
         * amount that disagrees with its own inputs is a derivation that does
         * not derive. */
        workingLines: {
          type: [
            {
              _id: false,
              label: { type: String, trim: true },
              description: { type: String, trim: true },
              quantity: { type: Number, min: 0 },
              unit: { type: String, trim: true },
              rate: { type: Number, min: 0 },
              multiplier: { type: Number, min: 0 },
              multiplierUnit: { type: String, trim: true },
              amount: { type: Number, min: 0 },
              manualAmount: { type: Boolean, default: false },

              /* ── A ROW THAT CARRIES ITS OWN MONTHS ───────────────────────
               * A month-wise line describes what each item costs in each
               * month rather than a quantity times a rate. The row's amount
               * is then the sum of these, and the line's monthly phasing is
               * the sum of every row's — so the plan and the working that
               * produced it can never drift apart.
               *
               * Optional and additive. A row without it behaves exactly as it
               * always has, which is what every existing proposal relies on.
               * Recomputed server-side like every other figure here — see
               * budgetWorking.service. */
              monthly: {
                type: [
                  {
                    _id: false,
                    month: { type: String, trim: true },
                    amount: { type: Number, min: 0 },
                  },
                ],
                default: undefined,
              },
            },
          ],
          default: undefined,
        },
        priority: {
          type: String,
          enum: ["low", "normal", "high", "critical"],
          default: "normal",
        },

        /* WHO RAISED IT. Not the same question as `sourceRequestId`, which
         * says the target LINE came from a department proposal — true whether
         * finance or the department later asked to change it. Finance weighs
         * a department's ask differently from its own, and the queue could
         * not tell them apart without this. */
        origin: {
          type: String,
          enum: ["finance", "department"],
          default: "finance",
        },

        state: {
          type: String,
          enum: ["submitted", "reviewed", "approved", "rejected", "cancelled"],
          default: "submitted",
          index: true,
        },

        /* `appliedAt` is the idempotency key, not a decoration. Approving is
         * the only operation here that MOVES money, and a double-click or a
         * retried request must not apply the delta twice — so the route
         * refuses to re-apply a row that already carries one. */
        appliedAt: { type: Date },

        /* Server-derived on every path. A client that could set these could
         * claim any author for a number, which is the whole audit trail. */
        requestedBy: { type: String, trim: true },
        requestedAt: { type: Date },
        reviewedBy: { type: String, trim: true },
        reviewedAt: { type: Date },
        financeNote: { type: String, trim: true },
      },
    ],

    /* ── TRANSFERS (Chunk 8) ─────────────────────────────────────────────────
     * Moving approved amount from one line to another inside the same budget.
     *
     * NOT extra money, which is what makes it different from an adjustment and
     * why it is a separate array. A supplementary raises the company's total
     * commitment; a transfer leaves it exactly where it was and changes only
     * who may spend it. Finance signs those off on different grounds — one is
     * "can we afford more?", the other "is Admin really not going to use
     * this?" — and a single list mixing them would hide that difference.
     *
     * The invariant a transfer must never break: you cannot move money that
     * has already been SPENT. `allocated` alone is not availability — a line
     * with ₹1L allocated and ₹90k consumed has ₹10k to give, not ₹1L, and
     * transferring against the allocation would leave the source instantly
     * over budget through no act of its own. */
    transfers: [
      {
        fromItemId: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
          index: true,
        },
        toItemId: {
          type: mongoose.Schema.Types.ObjectId,
          required: true,
          index: true,
        },
        amount: { type: Number, required: true },

        reason: { type: String, trim: true },
        /* WHO RAISED IT — the same distinction adjustments carry. Finance
         * weighs a department's ask differently from one of its own, and the
         * queue cannot tell them apart without this. */
        origin: {
          type: String,
          enum: ["finance", "department"],
          default: "finance",
        },

        state: {
          type: String,
          enum: ["submitted", "approved", "rejected", "cancelled"],
          default: "submitted",
          index: true,
        },

        /* Both sides as they stood when the transfer was raised, INCLUDING
         * the evaluated actual and what that left available. Finance
         * approving next week has to be able to see the case that was made —
         * "Admin Repairs has ₹1L unused" is the entire argument, and a bare
         * pair of ids would make it unreviewable. Snapshots, deliberately:
         * they are evidence of what was claimed, not a live read. */
        fromSnapshot: {
          department: { type: String, trim: true },
          ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
          ledgerName: { type: String, trim: true },
          groupName: { type: String, trim: true },
          nature: { type: String },
          allocatedAmount: { type: Number },
          actual: { type: Number },
          remaining: { type: Number },
        },
        toSnapshot: {
          department: { type: String, trim: true },
          ledgerId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Ledger" },
          ledgerName: { type: String, trim: true },
          groupName: { type: String, trim: true },
          nature: { type: String },
          allocatedAmount: { type: Number },
          actual: { type: Number },
          remaining: { type: Number },
        },

        /* Same idempotency key as adjustments, for the same reason: approving
         * is the only operation here that moves money, and a retried request
         * that moved ₹60k twice would leave both lines wrong with no ledger
         * anywhere to reveal it. */
        appliedAt: { type: Date },

        requestedBy: { type: String, trim: true },
        requestedAt: { type: Date },
        reviewedBy: { type: String, trim: true },
        reviewedAt: { type: Date },
        financeNote: { type: String, trim: true },
      },
    ],

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
  {
    timestamps: true,
    collection: "acc_budgets",
    /* ── OPTIMISTIC CONCURRENCY ────────────────────────────────────────────
     * `__v` existed but was never enforced, so a budget read by two requests
     * and saved by both kept only the second — a whole-document overwrite,
     * silently. That is survivable for a name edit and not survivable here:
     * approving two transfers at once would apply one and drop the other
     * while both told the caller they succeeded, and there is no ledger
     * anywhere that would ever reveal the loss.
     *
     * With this on, the second save fails with a VersionError instead. The
     * budget routes turn that into a 409 asking the caller to retry — the
     * one honest answer, and a far better outcome than a number quietly
     * going missing. */
    optimisticConcurrency: true,
  },
);
/**
 * A budget request names either a real ledger or a head it wants finance to
 * create — never neither.
 *
 * On the schema as well as the route, because a request can be written from
 * more than one place and this is the invariant that keeps
 * `syncAllocationFromRequest` honest: it allocates against `ledgerId`, so a
 * row with no binding at all is a number that can never be posted.
 */
budgetSchema.pre("validate", function ensureRequestHasAHead(next) {
  for (const [i, r] of (this.budgetRequests || []).entries()) {
    if (!r) continue;
    if (!r.ledgerId && !r.requestedHead?.name) {
      return next(
        new Error(
          `budgetRequests.${i}: a request needs a budget head — either an existing ledger or a requested head.`,
        ),
      );
    }
  }
  next();
});

budgetSchema.index({ financialYear: 1, period: 1 });
budgetSchema.index({ companyId: 1, status: 1, startDate: -1 });

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
