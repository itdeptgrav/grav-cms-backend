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
  const voucher = async ({ ledger, amount, type, date, status = "posted", isOptional = false }) =>
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
          { ledgerId: ledger._id, ledgerName: ledger.name, type, amount },
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

  /* Q2-only spend on a head no other budget touches.
   *
   * The quarterly budget deliberately does NOT share a head with the yearly
   * one. It is perfectly legal to budget the same head in two overlapping
   * budgets, but the dashboard roll-up counts such a voucher once per budget
   * and the headline reads double — a real defect, pinned by a test in
   * budgets.route.test.js. Demo data should show the module working, not
   * showcase a known bug. */
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
        requestedBy: "admin@demo.example",
        requestedAt: ist(2026, 9, 5),
      },
    ],
    transfers: [],
  });

  /* The adjustment has to point at a REAL line, and the line ids only exist
   * once Mongo has assigned them. */
  main.adjustments[0].targetItemId = main.items[1]._id;
  await main.save();

  /* 2 — a quarterly budget that has been blown, so the attention lists and
   * the red states have something real to show. */
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
    items: [line(ocean, "Logistics", 1300000)],
  });

  /* 3 — near the limit but not over: the amber case between the two. Its own
   * head, for the same no-overlap reason as the quarterly budget above. */
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
    /* Project scope, named only — no cost centre is seeded, and naming one
     * would imply spend can be attributed to it, which it cannot yet. */
    scope: "project",
    costCentreName: "Greenfield Industrial Park",
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
    ],
  });

  /* 5 — a legacy row: no companyId, an unbound line. Proves the module still
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
