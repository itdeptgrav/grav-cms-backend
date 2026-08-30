// scripts/clear-budget-data.js
//
// Wipe the budget module back to empty, and nothing else.
//
// ── WHY THIS EXISTS SEPARATELY FROM THE DEMO PURGE ──────────────────────────
// `seed-budget-demo.js --purge` removes exactly the documents that seed
// created, by id, from its manifest. It cannot touch a round somebody opened
// by hand — which is the usual reason a books environment ends up with a mix
// of half-finished rounds and orphaned lines that nobody wants to keep.
//
// This clears the budget module itself: every round, and every canonical
// department name. It is deliberately blunt, because "start fresh" is what it
// is for.
//
// ── WHAT IT NEVER TOUCHES ───────────────────────────────────────────────────
// Companies, groups, ledgers, vouchers, cost centres — the books. Access
// departments and access grants — who can open Budget and submit for what,
// which lives in Command Centre and is not budget data. Clearing rounds must
// not quietly revoke somebody's access, and re-granting it by hand afterwards
// is exactly the setup tax the access work removed.
//
// Pass --with-access to also drop the Budget grants, for a truly bare start.
//
//   node scripts/clear-budget-data.js                dry run: says what it would remove
//   node scripts/clear-budget-data.js --yes          remove it
//   node scripts/clear-budget-data.js --yes --with-access
//
// There is no undo. The dry run is the default for that reason.

require("dotenv").config();
const mongoose = require("mongoose");

const MONGO_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing";

const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../models/Accountant_model/Acc_BudgetDepartment");
const { Acc_Company } = require("../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../models/Access/DepartmentRole");

const args = process.argv.slice(2);
const confirmed = args.includes("--yes");
const withAccess = args.includes("--with-access");

const money = (n) => "₹ " + Number(n || 0).toLocaleString("en-IN");

async function main() {
  await mongoose.connect(MONGO_URI);
  console.log(`\nDatabase: ${MONGO_URI.replace(/\/\/[^@]*@/, "//***@")}\n`);

  const rounds = await Acc_Budget.find({}).lean();
  const depts = await Acc_BudgetDepartment.find({}).select("name slug companyId").lean();
  const grants = await DepartmentRole.find({ departmentSlug: "budget" })
    .select("email budgetDepartments")
    .lean();

  const companyNames = new Map(
    (
      await Acc_Company.find({ _id: { $in: rounds.map((r) => r.companyId).filter(Boolean) } })
        .select("_id companyName")
        .lean()
    ).map((c) => [String(c._id), c.companyName]),
  );

  console.log(`BUDGET ROUNDS — ${rounds.length}`);
  for (const b of rounds) {
    const allocated = (b.items || []).reduce((s, i) => s + (Number(i.allocatedAmount) || 0), 0);
    console.log(
      `  • ${b.name} [${b.status}] FY${b.financialYear} — ` +
        `${(b.items || []).length} line(s) ${money(allocated)}, ` +
        `${(b.budgetRequests || []).length} request(s), ` +
        `${(b.adjustments || []).length} adjustment(s), ` +
        `${(b.transfers || []).length} transfer(s)`,
    );
    console.log(
      `      company: ${companyNames.get(String(b.companyId)) || "*** none — orphaned row ***"}`,
    );
  }

  console.log(`\nDEPARTMENT NAMES — ${depts.length}`);
  for (const d of depts) console.log(`  • ${d.name}`);

  console.log(`\nBUDGET ACCESS GRANTS — ${grants.length}${withAccess ? " (will be removed)" : " (kept)"}`);
  for (const g of grants) {
    console.log(`  • ${g.email} → ${JSON.stringify(g.budgetDepartments || [])}`);
  }

  console.log("\nNever touched: companies, groups, ledgers, vouchers, cost centres,");
  console.log("access departments" + (withAccess ? "." : ", access grants."));

  if (!confirmed) {
    console.log("\nDRY RUN — nothing was removed.");
    console.log("  node scripts/clear-budget-data.js --yes                 clear rounds + names");
    console.log("  node scripts/clear-budget-data.js --yes --with-access   also clear Budget grants\n");
    await mongoose.disconnect();
    return;
  }

  const a = await Acc_Budget.deleteMany({});
  const b = await Acc_BudgetDepartment.deleteMany({});
  const c = withAccess
    ? await DepartmentRole.deleteMany({ departmentSlug: "budget" })
    : { deletedCount: 0 };

  console.log(`\nRemoved ${a.deletedCount} round(s), ${b.deletedCount} department name(s)` +
    (withAccess ? `, ${c.deletedCount} grant(s).` : "."));
  console.log("Budget module is empty. Open a round from /accountant/budgets to start.\n");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("Failed:", e.message);
  process.exit(1);
});
