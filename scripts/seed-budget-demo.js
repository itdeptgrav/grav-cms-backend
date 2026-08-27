// scripts/seed-budget-demo.js
//
// Demo data for the Budget module, so the dashboard, the drilldown and the
// review flows can be looked at with something in them.
//
// ── IT IS BUILT TO BE DELETED ───────────────────────────────────────────────
// Every document this creates is recorded, by _id, in a manifest collection.
// `--purge` reads that manifest and deletes exactly those documents — it never
// pattern-matches on names, never guesses from a prefix, and so can never
// reach a record it did not create. Edit a seeded budget, rename it, move it:
// purge still removes precisely it and nothing else.
//
// ── IT NEVER TOUCHES REAL BOOKS ─────────────────────────────────────────────
// It creates its OWN company, groups and ledgers rather than attaching demo
// vouchers to whatever company happens to exist. Fabricated postings against a
// real ledger would land in the trial balance, the P&L and every budget actual
// on the system — and the budget dashboard sums posted vouchers, so they would
// show up as real spend. A separate company keeps all of it in a box you can
// throw away.
//
//   node scripts/seed-budget-demo.js --yes     create it
//   node scripts/seed-budget-demo.js --purge   remove every trace
//   node scripts/seed-budget-demo.js           dry run: says what it would do
//
// Re-running --yes purges first, so it is idempotent rather than cumulative.

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../models/Accountant_model/Acc_VoucherModels");
const { Acc_BudgetDepartment } = require("../models/Accountant_model/Acc_BudgetDepartment");
const DepartmentRole = require("../models/Access/DepartmentRole");
const AccessDepartment = require("../models/Access/AccessDepartment");
const { Acc_CostCentre } = require("../models/Accountant_model/Acc_MasterModels");
const departments = require("../services/budgetDepartment.service");

const MANIFEST = "acc_budget_demo_manifest";
const TAG = "budget-demo-seed";

/* The financial year the demo sits in. Kept as a constant so the whole set
 * moves together if it is ever re-pointed. */
const FY = "2026-27";
const FY_START = new Date("2026-04-01T00:00:00.000Z");
const FY_END = new Date("2027-03-31T00:00:00.000Z");

const args = process.argv.slice(2);
const wantsPurge = args.includes("--purge");
const confirmed = args.includes("--yes");

/* ── the manifest ───────────────────────────────────────────────────────── */

const created = []; // { collection, id }
const remember = (model, doc) => {
  created.push({ collection: model.collection.name, id: doc._id });
  return doc;
};

async function writeManifest(db) {
  await db.collection(MANIFEST).insertOne({
    tag: TAG,
    createdAt: new Date(),
    documents: created,
  });
}

async function purge(db) {
  const manifests = await db.collection(MANIFEST).find({ tag: TAG }).toArray();
  if (!manifests.length) {
    console.log("Nothing to purge — no demo data has been seeded from this manifest.");
    return 0;
  }

  /* Grouped per collection so this is a handful of deleteMany calls rather
   * than one round trip per document. */
  const byCollection = new Map();
  for (const m of manifests) {
    for (const d of m.documents || []) {
      if (!byCollection.has(d.collection)) byCollection.set(d.collection, []);
      byCollection.get(d.collection).push(new mongoose.Types.ObjectId(String(d.id)));
    }
  }

  let total = 0;
  for (const [collection, ids] of byCollection) {
    const res = await db.collection(collection).deleteMany({ _id: { $in: ids } });
    total += res.deletedCount;
    console.log(`  ${collection}: removed ${res.deletedCount} of ${ids.length}`);
  }
  await db.collection(MANIFEST).deleteMany({ tag: TAG });
  return total;
}

/* ── the data ───────────────────────────────────────────────────────────── */

const ist = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 6, 30, 0));

/** A month of spend/revenue, shaped so the chart has a real curve. */
const MONTHLY = [
  //  month           freight  repairs  marketing   sales
  [2026, 4, 180000, 40000, 60000, 900000],
  [2026, 5, 240000, 25000, 95000, 1200000],
  [2026, 6, 610000, 90000, 140000, 450000],
  [2026, 7, 320000, 55000, 210000, 1800000],
  [2026, 8, 455000, 30000, 85000, 760000],
  [2026, 9, 720000, 120000, 175000, 2100000],
  [2026, 10, 390000, 45000, 60000, 1350000],
  [2026, 11, 505000, 70000, 130000, 980000],
  [2026, 12, 280000, 35000, 40000, 1650000],
  [2027, 1, 640000, 95000, 165000, 2400000],
  [2027, 2, 410000, 50000, 75000, 1100000],
  [2027, 3, 300000, 20000, 55000, 1900000],
];

const PARTIES = [
  "Northline Facilities Management",
  "Mayfair Hotels & Resorts Private Limited",
  "Tata Steel Meramandali Township Services",
  "Qmax World Llp",
  "Kalinga Hospitality",
];

async function seed(db) {
  /* ── company, chart of accounts ───────────────────────────────────────── */
  const company = remember(
    Acc_Company,
    await Acc_Company.create({
      companyName: "Demo Co (budget preview)",
      booksFromDate: FY_START,
    }),
  );

  const mkGroup = async (name, nature) =>
    remember(Acc_Group, await Acc_Group.create({ companyId: company._id, name, nature }));

  const expGroup = await mkGroup("Indirect Expenses", "expense");
  const revGroup = await mkGroup("Direct Income", "revenue");
  const bankGroup = await mkGroup("Bank Accounts", "asset");

  const mkLedger = async (name, group) =>
    remember(
      Acc_Ledger,
      await Acc_Ledger.create({
        companyId: company._id,
        name,
        groupId: group._id,
        groupName: group.name,
        nature: group.nature,
      }),
    );

  const freight = await mkLedger("Freight & Forwarding", expGroup);
  const ocean = await mkLedger("Ocean Freight — Exports", expGroup);
  const facilities = await mkLedger("Site Facilities", expGroup);
  const repairs = await mkLedger("Repairs & Maintenance", expGroup);
  const marketing = await mkLedger("Marketing & Exhibitions", expGroup);
  const sales = await mkLedger("Export Sales", revGroup);
  const bank = await mkLedger("HDFC Current A/c", bankGroup);

  /* ── vouchers ─────────────────────────────────────────────────────────── */
  let n = 0;
  const voucher = async ({ ledger, amount, type, date, status = "posted", isOptional = false, costCentre = null }) =>
    remember(
      Acc_Voucher,
      await Acc_Voucher.create({
        companyId: company._id,
        voucherType: type === "Cr" ? "sales" : "purchase",
        voucherNumber: `DEMO/${FY}/${String(++n).padStart(4, "0")}`,
        voucherDate: date,
        financialYear: FY,
        status,
        isOptional,
        partyLedgerName: PARTIES[n % PARTIES.length],
        narration:
          type === "Cr"
            ? "Export consignment — consolidated invoice"
            : "Supply and services as per purchase order",
        grandTotal: amount,
        /* `sourceSystem` is an enum and rejects a custom tag — which is fine,
         * because the manifest already records this voucher by _id and that is
         * what purge reads. `sourceReference` is free text and carries the
         * marker for anyone reading the row in the Day Book. */
        sourceSystem: "manual",
        sourceReference: TAG,
        ledgerEntries: [
          {
            ledgerId: ledger._id,
            ledgerName: ledger.name,
            type,
            amount,
            /* Only the spend leg is ever tagged. The bank leg is how it was
             * PAID, not what it was spent on, and tagging it would count the
             * same money against the project twice. */
            ...(costCentre
              ? {
                  costCentreAllocations: [
                    { costCentreId: costCentre._id, costCentreName: costCentre.name, amount },
                  ],
                }
              : {}),
          },
          { ledgerId: bank._id, ledgerName: bank.name, type: type === "Cr" ? "Dr" : "Cr", amount },
        ],
      }),
    );

  for (const [y, m, fr, rp, mk, sl] of MONTHLY) {
    await voucher({ ledger: freight, amount: fr, type: "Dr", date: ist(y, m, 12) });
    await voucher({ ledger: repairs, amount: rp, type: "Dr", date: ist(y, m, 18) });
    await voucher({ ledger: marketing, amount: mk, type: "Dr", date: ist(y, m, 22) });
    await voucher({ ledger: sales, amount: sl, type: "Cr", date: ist(y, m, 26) });
  }

  /* Q2-only spend on a head the yearly budget does not carry, so the Q2
   * budget's own red state is unambiguous. The DELIBERATE overlap is the
   * freight head below — see the Q2 budget's second line. */
  await voucher({ ledger: ocean, amount: 520000, type: "Dr", date: ist(2026, 7, 16) });
  await voucher({ ledger: ocean, amount: 610000, type: "Dr", date: ist(2026, 8, 21) });
  await voucher({ ledger: ocean, amount: 405000, type: "Dr", date: ist(2026, 9, 11) });

  /* Facilities: 94% consumed — the amber "near the limit" case. */
  for (const [m, amt] of [[5, 140000], [7, 180000], [10, 160000], [1, 178000]]) {
    await voucher({ ledger: facilities, amount: amt, type: "Dr", date: ist(m === 1 ? 2027 : 2026, m, 14) });
  }

  /* Deliberately not counted anywhere. Their presence is the point: if any
   * figure on the dashboard moves when these are added, something is reading
   * unposted money. */
  await voucher({ ledger: freight, amount: 900000, type: "Dr", date: ist(2026, 8, 14), status: "draft" });
  await voucher({ ledger: freight, amount: 750000, type: "Dr", date: ist(2026, 10, 9), isOptional: true });

  /* A purchase return, so a negative contribution appears in the drilldown. */
  await voucher({ ledger: freight, amount: 65000, type: "Cr", date: ist(2026, 9, 28) });

  /* ── budgets ──────────────────────────────────────────────────────────── */
  const budget = async (doc) => remember(Acc_Budget, await Acc_Budget.create(doc));
  const line = (ledger, department, allocatedAmount, extra = {}) => ({
    ledgerId: ledger._id,
    ledgerName: ledger.name,
    groupName: ledger.groupName,
    nature: ledger.nature,
    department,
    allocatedAmount,
    ...extra,
  });

  /* ── The cost-centre master ───────────────────────────────────────────────
   * A real project, so the project budget below can bind to it. Without one a
   * project budget matches on ledger head alone and reports every rupee spent
   * on that head company-wide — a label rather than a control. */
  const greenfield = remember(
    Acc_CostCentre,
    await Acc_CostCentre.create({
      companyId: company._id,
      name: "Greenfield Industrial Park",
      category: "Projects",
    }),
  );

  /* ── The department registry ──────────────────────────────────────────────
   * So the picker has something to pick and the Departments tab shows
   * canonical names. "Logistics" carries a deliberate alias for a plausible
   * misspelling — the one case slugify cannot fold on its own, and the whole
   * reason aliases exist. */
  /* ── WHY EVERY ROW CARRIES AN accessSlug ──────────────────────────────────
   * `accessSlug` is the ONLY link between a budget department ("Logistics")
   * and a portal a human actually signs into ("packaging-dispatch"). The
   * department app resolves it from the database on every request and maps an
   * unlinked caller to NOTHING — see routes/Access/budgetProposals.js.
   *
   * Seeded without it, every document below is invisible to the half of the
   * feature the demo exists to show: finance sees a full queue, the
   * department app shows an empty screen, and the flow looks broken rather
   * than unmapped. Clear one of these to exercise the mapping screen — that
   * is the state it was built for. */
  for (const [name, aliases, accessSlug] of [
    ["Logistics", ["logistcs"], "packaging-dispatch"],
    ["Admin", [], "hr"],
    ["Marketing", [], "merchandiser"],
    ["Sales", [], "sales"],
    ["Facilities", [], "store"],
    /* Carried a request from the day this seed was written, but was never in
       the registry — so `resolver.resolve("Projects")` returned null and the
       Greenfield ask below could not be seen by anybody. */
    ["Projects", [], "project-manager"],
  ]) {
    remember(
      Acc_BudgetDepartment,
      await Acc_BudgetDepartment.create({
        companyId: company._id,
        slug: departments.slugify(name),
        name,
        aliases,
        accessSlug,
        createdBy: "demo-seed",
      }),
    );
  }

  /* ── ACCESS, THE WAY IT IS GRANTED NOW ────────────────────────────────────
   * One record per demo head: the Budget app, plus the departments it covers.
   * This is what Access Control writes, so the demo exercises the same path a
   * real grant takes rather than a shape only the seed produces.
   *
   * The `accessSlug` values above stay: they are the older indirection, still
   * honoured as a fallback, and leaving them here is what proves both paths
   * resolve at once without producing two rows for one department.
   *
   * These grant nothing to anybody real — the addresses are @demo.example and
   * no login exists for them. Recorded in the manifest, so --purge removes
   * them precisely. */
  /* ── THE DEPARTMENTS COMMAND CENTRE OFFERS ────────────────────────────────
   * Access resolves against the company's own department list, so the demo
   * has to put its departments there too — otherwise a grant naming
   * "logistics" refers to something that does not exist and resolves to
   * nothing, which is exactly the failure this seed is meant to prevent.
   *
   * Upserted rather than created: `slug` is globally unique and a real
   * installation may already have some of these. Only ever ADDS — an existing
   * row keeps its own name, path and flags untouched. That is also why these
   * are NOT recorded in the manifest: --purge must not delete a department the
   * company was already using. */
  for (const [slug, name] of [
    ["logistics", "Logistics"],
    ["admin", "Admin"],
    ["marketing", "Marketing"],
    ["facilities", "Facilities"],
    ["projects", "Projects"],
  ]) {
    await AccessDepartment.updateOne(
      { slug },
      {
        $setOnInsert: {
          key: slug.toUpperCase(),
          slug,
          name,
          dashboardPath: `/d/${slug}`,
          isActive: true,
          budgetEnabled: true,
          showOnOnboarding: false,
        },
      },
      { upsert: true },
    );
  }

  for (const [email, name, depts] of [
    ["logistics.head@demo.example", "Logistics Head", ["logistics"]],
    ["marketing.head@demo.example", "Marketing Head", ["marketing"]],
    ["projects.head@demo.example", "Projects Head", ["projects"]],
    /* Two departments on one grant — the case the picker has to handle. */
    ["admin@demo.example", "Admin & Facilities", ["admin", "facilities"]],
  ]) {
    remember(
      DepartmentRole,
      await DepartmentRole.create({
        departmentSlug: "budget",
        email,
        name,
        role: "editor",
        isActive: true,
        budgetDepartments: depts,
        grantedByEmail: "demo-seed",
      }),
    );
  }

  /* 1 — the main one: revenue and expense, mostly healthy, work waiting. */
  const main = await budget({
    name: "FY26-27 Company Budget",
    financialYear: FY,
    period: "yearly",
    status: "active",
    /* The shape the module was built for: one envelope, departments as lines,
     * and the request → review → allocation flow asking into it. */
    scope: "company",
    startDate: FY_START,
    endDate: FY_END,
    companyId: company._id,
    notes: "Demo data.",
    items: [
      line(freight, "Logistics", 5600000, {
        ownerEmail: "logistics.head@demo.example",
        notes: "Export freight for the full year.",
      }),
      line(repairs, "Admin", 900000, { ownerEmail: "admin@demo.example" }),
      line(marketing, "Marketing", 1400000, { ownerEmail: "marketing.head@demo.example" }),
      line(sales, "Sales", 16000000),
    ],
    budgetRequests: [
      {
        department: "Logistics",
        ledgerId: freight._id,
        ledgerName: freight.name,
        groupName: freight.groupName,
        nature: "expense",
        requestedAmount: 450000,
        priority: "high",
        state: "submitted",
        purpose: "Diwali peak carrier surcharge, not in the original plan",
        /* A surcharge is the textbook case for phasing: straight-lining it
           would make every month before the festival read as underspend and
           the festival itself read as a breach. Sums to requestedAmount —
           budgetPhasing.service refuses a split that does not. */
        phasingMode: "custom_monthly",
        monthlyPhasing: [
          { month: "2026-09", amount: 60000 },
          { month: "2026-10", amount: 150000 },
          { month: "2026-11", amount: 150000 },
          { month: "2026-12", amount: 90000 },
        ],
        /* And the derivation, so the number is reviewable rather than
           asserted. Recomputed server-side on any edit — quantity × rate ×
           multiplier — so these amounts must be the honest product. */
        workingLines: [
          {
            label: "Peak-season container surcharge",
            quantity: 30,
            unit: "container",
            rate: 12000,
            multiplier: 1,
            amount: 360000,
          },
          {
            label: "Expedited last-mile, metro deliveries",
            quantity: 900,
            unit: "shipment",
            rate: 100,
            multiplier: 1,
            amount: 90000,
          },
        ],
        submittedBy: "logistics.head@demo.example",
        submittedAt: ist(2026, 8, 20),
      },
      {
        department: "Marketing",
        ledgerId: marketing._id,
        ledgerName: marketing.name,
        groupName: marketing.groupName,
        nature: "expense",
        requestedAmount: 300000,
        priority: "normal",
        state: "countered",
        counterAmount: 180000,
        financeNote: "Half now; revisit after the Q3 review.",
        justification: "Two additional trade shows confirmed for H2.",
        workingLines: [
          { label: "Stand build and fit-out", quantity: 2, unit: "show", rate: 110000, multiplier: 1, amount: 220000 },
          { label: "Travel and per-diem", quantity: 4, unit: "person", rate: 20000, multiplier: 1, amount: 80000 },
        ],
        submittedBy: "marketing.head@demo.example",
        submittedAt: ist(2026, 8, 19),
      },
    ],
    adjustments: [
      {
        type: "supplementary",
        targetItemId: new mongoose.Types.ObjectId(), // rewritten below
        department: "Admin",
        ledgerId: repairs._id,
        ledgerName: repairs.name,
        groupName: repairs.groupName,
        nature: "expense",
        currentAllocatedAmount: 900000,
        requestedDeltaAmount: 150000,
        requestedNewAmount: 1050000,
        reason: "Compressor replacement was not foreseen at planning.",
        priority: "high",
        state: "submitted",
        /* Raised by the department, not by finance. Without it the review
           queue cannot tell its own housekeeping from somebody's ask, and the
           four-eyes rule has nothing to check. */
        origin: "department",
        requestedBy: "admin@demo.example",
        requestedAt: ist(2026, 9, 5),
      },
    ],
    /* Wired to real lines below — the ids do not exist until Mongo assigns
       them. A transfer moves budget between two lines and changes no total,
       which is the one shape neither a request nor an adjustment covers. */
    transfers: [
      {
        fromItemId: new mongoose.Types.ObjectId(), // rewritten below
        toItemId: new mongoose.Types.ObjectId(), // rewritten below
        amount: 120000,
        reason: "Repairs will not use its full year; freight peak needs it.",
        origin: "department",
        state: "submitted",
        requestedBy: "logistics.head@demo.example",
        requestedAt: ist(2026, 9, 8),
      },
    ],
  });

  /* The adjustment and the transfer have to point at REAL lines, and the line
   * ids only exist once Mongo has assigned them. */
  main.adjustments[0].targetItemId = main.items[1]._id;
  main.transfers[0].fromItemId = main.items[1]._id; // Repairs & Maintenance
  main.transfers[0].toItemId = main.items[0]._id; // Freight & Forwarding
  /* The case the requester was actually looking at, snapshotted. Finance
     reviewing next week reads these, not a re-read that has since moved. */
  main.transfers[0].fromSnapshot = {
    department: main.items[1].department,
    ledgerId: main.items[1].ledgerId,
    ledgerName: main.items[1].ledgerName,
    groupName: main.items[1].groupName,
    nature: main.items[1].nature,
    allocatedAmount: main.items[1].allocatedAmount,
  };
  main.transfers[0].toSnapshot = {
    department: main.items[0].department,
    ledgerId: main.items[0].ledgerId,
    ledgerName: main.items[0].ledgerName,
    groupName: main.items[0].groupName,
    nature: main.items[0].nature,
    allocatedAmount: main.items[0].allocatedAmount,
  };
  await main.save();

  /* 2 — a quarterly budget that has been blown, so the attention lists and
   * the red states have something real to show.
   *
   * It also carries the FREIGHT head, which the yearly budget carries too —
   * a deliberate overlap. Running a tight quarter inside a yearly envelope is
   * an ordinary thing to do, and until Chunk B it made the dashboard headline
   * read double. Now the Q2 budget owns August and September's freight (same
   * scope, narrower period) and the yearly one owns the other ten months. The
   * demo carries it so the "Overlapping actuals deduped" note has something
   * true to say. */
  await budget({
    name: "Freight & Forwarding — Q2",
    financialYear: FY,
    period: "quarterly",
    quarter: 2,
    status: "review",
    scope: "company",
    startDate: new Date("2026-07-01T00:00:00.000Z"),
    endDate: new Date("2026-09-30T00:00:00.000Z"),
    companyId: company._id,
    notes: "Demo data.",
    /* "logistics" lower-case, deliberately. Until Chunk C this was a SECOND
     * department: two rows on the Departments tab, each holding half the
     * answer, and a voucher tagged "Logistics" would not match this line in
     * budget control. It is left mis-spelled so the fix has something true to
     * demonstrate — and so the "2 spellings" hint has a reason to appear. */
    items: [line(ocean, "Logistics", 1300000), line(freight, "logistics", 1400000)],
  });

  /* 3 — near the limit but not over: the amber case between the two. On its
   * own head, so its 94% reading is its own and not a share of anything. */
  await budget({
    name: "Site Facilities — FY26-27",
    financialYear: FY,
    period: "yearly",
    status: "active",
    /* A department that owns its own envelope — so the card has something to
     * lead with other than the year. */
    scope: "department",
    department: "Facilities",
    startDate: FY_START,
    endDate: FY_END,
    companyId: company._id,
    notes: "Demo data.",
    items: [line(facilities, "Facilities", 700000)],
  });

  /* 4 — nothing approved yet, with requests waiting. Shows the empty state
   * and the "no approved allocations" attention row. */
  await budget({
    name: "Greenfield Industrial Park",
    financialYear: FY,
    period: "yearly",
    status: "collecting",
    /* Bound to a REAL cost centre, so its actuals are the project's spend and
     * not everything on its heads. */
    scope: "project",
    costCentreId: greenfield._id,
    costCentreName: greenfield.name,
    startDate: FY_START,
    endDate: FY_END,
    companyId: company._id,
    notes: "Demo data.",
    items: [],
    budgetRequests: [
      {
        department: "Projects",
        ledgerId: repairs._id,
        ledgerName: repairs.name,
        groupName: repairs.groupName,
        nature: "expense",
        requestedAmount: 2500000,
        priority: "critical",
        state: "submitted",
        purpose: "Site establishment and temporary works",
        submittedBy: "projects.head@demo.example",
        submittedAt: ist(2026, 8, 23),
      },
      /* ── A LINE WITH NO LEDGER ─────────────────────────────────────────────
       * The department needs to budget for something the chart of accounts
       * has no head for. It may not create one — that is an accounting
       * decision — so it asks, and the line carries `requestedHead` instead
       * of a `ledgerId`. Agreeing it returns 409 HEAD_UNRESOLVED until
       * finance maps or creates the ledger, which is the point. */
      {
        department: "Projects",
        ledgerId: undefined,
        requestedHead: {
          name: "Site Security & Watch-and-Ward",
          nature: "expense",
          reason: "Round-the-clock guarding for the site; nothing existing fits.",
          suggestedGroupName: "Indirect Expenses",
          state: "requested",
          requestedBy: "projects.head@demo.example",
          requestedAt: ist(2026, 8, 24),
        },
        nature: "expense",
        requestedAmount: 640000,
        priority: "normal",
        state: "submitted",
        purpose: "Two shifts of guarding for the build period",
        submittedBy: "projects.head@demo.example",
        submittedAt: ist(2026, 8, 24),
      },
    ],
  });

  /* 5 — a project budget that is actually WORKING: bound to a real cost
   * centre, with spend tagged to it.
   *
   * It shares the repairs head with the company budget, which is the whole
   * demonstration. Of the repairs spend below, the tagged part belongs to this
   * project and the untagged part stays with the company budget — the same
   * rupee is never counted twice, and the project does not claim spend that
   * was never attributed to it. */
  await budget({
    name: "Greenfield — Site Works",
    financialYear: FY,
    period: "yearly",
    status: "active",
    scope: "project",
    costCentreId: greenfield._id,
    costCentreName: greenfield.name,
    startDate: FY_START,
    endDate: FY_END,
    companyId: company._id,
    notes: "Demo data.",
    items: [
      line(repairs, "Projects", 900000, {
        costCentreId: greenfield._id,
        costCentreName: greenfield.name,
      }),
    ],
  });

  /* Repairs spend, half of it attributed to the project and half not. */
  await voucher({
    ledger: repairs,
    amount: 340000,
    type: "Dr",
    date: ist(2026, 9, 12),
    costCentre: greenfield,
  });
  await voucher({ ledger: repairs, amount: 210000, type: "Dr", date: ist(2026, 10, 8) });

  /* 6 — a legacy row: no companyId, an unbound line. Proves the module still
   * reads pre-rewrite data and that "not linked to a ledger" surfaces. */
  await budget({
    name: "Marketing — FY24-25 (legacy)",
    financialYear: "2024-25",
    period: "yearly",
    status: "closed",
    startDate: new Date("2024-04-01T00:00:00.000Z"),
    endDate: new Date("2025-03-31T00:00:00.000Z"),
    notes: "Demo data. Deliberately has no companyId.",
    items: [{ category: "marketing", nature: "expense", department: "", allocatedAmount: 200000 }],
  });

  return { company };
}

/* ── main ───────────────────────────────────────────────────────────────── */

(async () => {
  const host = MONGO_URI.replace(/\/\/[^@]*@/, "//***@");
  console.log(`\nDatabase: ${host}\n`);

  if (!wantsPurge && !confirmed) {
    console.log("DRY RUN — nothing was written.\n");
    console.log("This would create one demo company with its own chart of accounts,");
    console.log("50 vouchers across FY26-27, and five budgets covering the healthy,");
    console.log("over-budget, near-limit, nothing-approved and legacy cases.\n");
    console.log("  node scripts/seed-budget-demo.js --yes     create it");
    console.log("  node scripts/seed-budget-demo.js --purge   remove every trace\n");
    process.exit(0);
  }

  await mongoose.connect(MONGO_URI);
  const db = mongoose.connection.db;

  try {
    if (wantsPurge) {
      console.log("Purging demo data…");
      const removed = await purge(db);
      console.log(`\nDone — ${removed} document${removed === 1 ? "" : "s"} removed.\n`);
      return;
    }

    /* Purge first, so re-running replaces rather than accumulates. */
    console.log("Clearing any previous demo data…");
    await purge(db);

    console.log("Seeding…");
    const { company } = await seed(db);
    await writeManifest(db);

    console.log(`\nDone — ${created.length} documents created.`);
    console.log(`Company: "${company.companyName}"  (${company._id})`);
    console.log("\nPick that company in the app's company selector to see it.");
    console.log("Remove it all with:  node scripts/seed-budget-demo.js --purge\n");
  } finally {
    await mongoose.disconnect();
  }
})().catch((e) => {
  console.error("\nFailed:", e.message, "\n");
  process.exit(1);
});
