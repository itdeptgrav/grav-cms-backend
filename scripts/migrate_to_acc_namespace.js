const dns = require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
require("dotenv").config();
const mongoose = require("mongoose");
const readline = require("readline");

const LEGACY_COLLECTIONS = [
  // Tally-prefixed master / voucher / import
  "tally_companies",
  "tally_groups",
  "tally_ledgers",
  "tally_cost_centres",
  "tally_units",
  "tally_stock_groups",
  "tally_stock_items",
  "tally_vouchers",
  "tally_godowns",
  "tally_import_sessions",
  "tally_field_mappings",

  // Accountant_-prefixed org / settings / approvals
  "accountant_organizations",
  "accountant_users",
  "accountant_invites",
  "accountant_approval_requests",
  "accountant_settings",
  "accountant_row_priorities",
  "accountant_pinned_items",
  "accountant_ledger_reclass_requests",

  // Generic-named (collision-risk — these are the auto-pluralized names
  // Mongoose used for old models like Invoice/Expense/Budget that
  // didn't specify an explicit collection)
  "expenses",
  "invoices",
  "banktransactions",
  "budgets",
  "journalentries",
  "taxfilings",
  "chartofaccounts",
  "creditdebitnotes",
  "accountantactivitylogs",
  "accountantdepartments",
  "cashflowadjustments",
  "setuconsents",
  "proforma_invoices",
];

const NEW_ACC_COLLECTIONS = [
  // Master / voucher / import
  "acc_companies",
  "acc_groups",
  "acc_ledgers",
  "acc_cost_centres",
  "acc_units",
  "acc_stock_groups",
  "acc_stock_items",
  "acc_vouchers",
  "acc_godowns",
  "acc_import_sessions",
  "acc_field_mappings",

  // Org / auth / approvals
  "acc_organizations",
  "acc_users",
  "acc_invites",
  "acc_approval_requests",
  "acc_settings",
  "acc_row_priorities",
  "acc_pinned_items",
  "acc_ledger_reclass_requests",
  "acc_departments",

  // Operational
  "acc_expenses",
  "acc_invoices",
  "acc_bank_transactions",
  "acc_budgets",
  "acc_journal_entries",
  "acc_tax_filings",
  "acc_chart_of_accounts",
  "acc_credit_debit_notes",
  "acc_activity_logs",
  "acc_cashflow_adjustments",
  "acc_setu_consents",
  "acc_proforma_invoices",
];

// ─── PROTECTED LIST — never drop these even by mistake ───────────────────
// Defence-in-depth: if a typo somehow added one of these to the drop
// lists above, the protection check refuses to touch it.
const PROTECTED = new Set([
  // Customer module
  "customers",
  "customerrequests",
  "customeredits",
  // Vendor module (CMS)
  "vendors",
  "vendordetails",
  // HR / Employee
  "employees",
  "hrdepartments",
  "payrollruns",
  // CMS Inventory
  "stockitems",
  "rawitems",
  "units",
  "unitconversions",
  "warehouses",
  "workorders",
  "workspacegroups",
  "workspacemembers",
  "workspacemessages",
  "workspacetasks",
  "barcodes",
  "storedepartments",
  // Other GRAV modules
  "cowork_tasks",
  "cowork_employees",
  "cowork_scheduled_meets",
  "cuttingmasters",
  "qcdepartments",
  "ceodepartments",
  "productionsupervisordepartments",
  "packagingdispatchdepartments",
  // Sessions
  "sessions",
]);

// Anything not on the explicit drop list AND not on the protected list
// is still left alone — we only ever touch names we've explicitly named
// as accountant-owned.

function isExplicitlyAccountant(name) {
  return (
    LEGACY_COLLECTIONS.includes(name) || NEW_ACC_COLLECTIONS.includes(name)
  );
}

function isProtected(name) {
  return PROTECTED.has(name);
}

async function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const APPLY = args.has("--apply");
  const YES = args.has("--yes");

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("❌ MONGODB_URI not set in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("✅ Connected to MongoDB");
  console.log(`   Database: ${mongoose.connection.name}\n`);

  const db = mongoose.connection.db;
  const existing = (
    await db.listCollections({}, { nameOnly: true }).toArray()
  ).map((c) => c.name);
  const existingSet = new Set(existing);

  // ── Plan ─────────────────────────────────────────────────────────────
  const toDrop = []; // { name, count, bucket }
  const skippedMissing = []; // not present in DB
  const skippedProtected = []; // would have been dropped but is in PROTECTED

  for (const name of [...LEGACY_COLLECTIONS, ...NEW_ACC_COLLECTIONS]) {
    if (isProtected(name)) {
      skippedProtected.push(name);
      continue;
    }
    if (!existingSet.has(name)) {
      skippedMissing.push(name);
      continue;
    }
    const count = await db.collection(name).countDocuments();
    const bucket = LEGACY_COLLECTIONS.includes(name) ? "legacy" : "new";
    toDrop.push({ name, count, bucket });
  }

  // ── Summary ──────────────────────────────────────────────────────────
  console.log("─".repeat(72));
  console.log(APPLY ? "RESET PLAN" : "DRY RUN (no changes will be made)");
  console.log("─".repeat(72));

  if (toDrop.length === 0) {
    console.log(
      "✓ Nothing to drop. All accountant collections are already gone.",
    );
    await mongoose.disconnect();
    return;
  }

  const legacyDrops = toDrop.filter((c) => c.bucket === "legacy");
  const newDrops = toDrop.filter((c) => c.bucket === "new");

  if (legacyDrops.length > 0) {
    console.log(
      `\nLegacy (pre-rename) collections to drop: ${legacyDrops.length}`,
    );
    for (const c of legacyDrops) {
      const tag = c.count > 0 ? `${c.count} docs` : "empty";
      console.log(`   ✗  ${c.name.padEnd(42)} (${tag})`);
    }
  }

  if (newDrops.length > 0) {
    console.log(`\nNew acc_* collections to drop: ${newDrops.length}`);
    for (const c of newDrops) {
      const tag = c.count > 0 ? `${c.count} docs` : "empty";
      console.log(`   ✗  ${c.name.padEnd(42)} (${tag})`);
    }
  }

  if (skippedMissing.length > 0) {
    console.log(
      `\nSkipping (not present in DB): ${skippedMissing.length} name(s).`,
    );
  }
  if (skippedProtected.length > 0) {
    console.log(`\n⚠️  Skipping (protected): ${skippedProtected.join(", ")}`);
  }

  if (!APPLY) {
    console.log("\n" + "─".repeat(72));
    console.log("This was a DRY RUN — nothing was dropped.");
    console.log("To actually drop:");
    console.log("   node scripts/reset_accountant_collections.js --apply");
    console.log("─".repeat(72));
    await mongoose.disconnect();
    return;
  }

  // ── Confirmation ─────────────────────────────────────────────────────
  if (!YES) {
    console.log("\n" + "─".repeat(72));
    const totalDocs = toDrop.reduce((s, c) => s + c.count, 0);
    console.log(
      `About to drop ${toDrop.length} accountant collections ` +
        `(${totalDocs} total docs).`,
    );
    console.log("This will RESET your accountant module to empty state.");
    console.log(
      "Other GRAV modules (customers, vendors, employees, etc.) are untouched.",
    );
    console.log("This is IRREVERSIBLE.");
    console.log("─".repeat(72));
    const answer = await ask('Type "RESET" to confirm: ');
    if (answer !== "RESET") {
      console.log("Aborted — no changes made.");
      await mongoose.disconnect();
      return;
    }
  }

  // ── Execute ──────────────────────────────────────────────────────────
  console.log("\nDropping...");
  let dropped = 0;
  let failed = 0;
  for (const c of toDrop) {
    try {
      await db.collection(c.name).drop();
      console.log(`   ✓  ${c.name}`);
      dropped++;
    } catch (e) {
      console.log(`   ✗  ${c.name}: ${e.message}`);
      failed++;
    }
  }

  console.log("\n" + "─".repeat(72));
  console.log(`Done. ${dropped} dropped, ${failed} failed.`);
  console.log("─".repeat(72));
  console.log("\nNext steps:");
  console.log("  1. Restart your Node server: `node server.js`");
  console.log("  2. Open the app and use it normally — Mongoose will");
  console.log("     recreate the acc_* collections empty as they're needed.");
  console.log("  3. Verify in MongoDB Compass that only acc_* collections");
  console.log("     appear (no more tally_*, no more orphan generic-named).");

  await mongoose.disconnect();
}

main().catch((e) => {
  console.error("❌ Script failed:", e);
  process.exit(1);
});
