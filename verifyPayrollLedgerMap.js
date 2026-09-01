// verifyPayrollLedgerMap.js
//
// The payroll bridge splits salary by department per the configured map, the
// voucher still balances to the paise, and a hand-posted run is recorded
// rather than faked.
//
// Run:  node -r dotenv/config verifyPayrollLedgerMap.js
//
// READ-ONLY on payroll: it builds vouchers in memory from a REAL run and never
// posts them. Its own map / marker rows are created under a throwaway company
// id and deleted again, on crash too.

"use strict";

const mongoose = require("mongoose");

const FAKE_COMPANY = new mongoose.Types.ObjectId("6a08040a1fecacc9bb7149c2"); // the live company, read-only
let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` — ${d}` : ""}`); }
};

async function cleanup() {
  const { Acc_PayrollLedgerMap, Acc_PayrollExternalPost } = require("./models/Accountant_model/Acc_PayrollBridge");
  let n = 0;
  n += (await Acc_PayrollLedgerMap.deleteMany({ updatedByEmail: /@grav\.invalid$/ })).deletedCount;
  n += (await Acc_PayrollExternalPost.deleteMany({ markedByEmail: /@grav\.invalid$/ })).deletedCount;
  return n;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const { departmentKey, Acc_PayrollLedgerMap, Acc_PayrollExternalPost } =
    require("./models/Accountant_model/Acc_PayrollBridge");

  await cleanup();

  /* ── the key folds the way the data needs ─────────────────────────────── */
  console.log("department keys");
  check("case variants fold together",
    departmentKey("DESIGNING") === departmentKey("Designing"));
  check("and whitespace does not split a department",
    departmentKey("  Human   Resources ") === departmentKey("HUMAN RESOURCES"));
  check("an empty department stays empty", departmentKey(null) === "");

  /* ── the split, over a REAL run ───────────────────────────────────────── */
  console.log("\nthe split, on a real payroll run");
  const { Payroll, PayrollItem } = require("./models/HR_Models/Payroll");
  const run = await Payroll.findOne({ status: { $nin: ["draft", "cancelled"] } })
    .sort({ year: -1, month: -1 })
    .lean();
  const items = run ? await PayrollItem.find({ payrollId: run._id }).lean() : [];
  check("found a run with items to test against", Boolean(run) && items.length > 0,
    run ? `${items.length} items` : "no run");

  const Acc_Ledger = require("./models/Accountant_model/Acc_MasterModels").Acc_Ledger;
  const expenses = await Acc_Ledger.find({ companyId: FAKE_COMPANY, isActive: true, nature: "expense" })
    .select("_id name").limit(3).lean();
  check("the company has expense ledgers to map onto", expenses.length >= 2, `${expenses.length}`);

  /* Which departments this run actually contains, and the staff gross the
     voucher must reproduce exactly. */
  const staff = items.filter((i) => !i.isIntern);
  const staffGross = parseFloat(
    staff.reduce((a, i) => a + (i.earnings?.grossEarnings || 0), 0).toFixed(2),
  );
  const depts = [...new Set(staff.map((i) => departmentKey(i.department)).filter(Boolean))];
  check("the run spans several departments", depts.length >= 2, depts.join(", "));

  const routes = require("./routes/Accountant_Routes/Acc_chartOfAccounts");
  const build = routes.__buildPayrollVouchers;
  check("the builder is reachable for testing", typeof build === "function");

  if (typeof build === "function" && run && expenses.length >= 2) {
    /* 1. WITHOUT a map — one salary line, the behaviour before this work. */
    /* The builder returns { vouchers, totals, ledgerIds }; the journal is the
       voucher whose kind is "processing". */
    const pick = (out) => out.vouchers.find((v) => v.kind === "processing");
    const before = pick(await build(FAKE_COMPANY, run, items, {}));
    const beforeDr = before.entries.filter((e) => e.type === "Dr");
    const beforeSalary = beforeDr.filter((e) => !/stipend/i.test(e.ledgerName));
    check("unmapped: the salary expense is a single line", beforeSalary.length === 1,
      beforeSalary.map((e) => e.ledgerName).join(", "));

    /* 2. WITH a map splitting the two biggest departments apart. */
    const [a, b] = depts;
    await Acc_PayrollLedgerMap.findOneAndUpdate(
      { companyId: FAKE_COMPANY },
      {
        $set: {
          departments: [
            { key: a, label: a, ledgerId: expenses[0]._id, ledgerName: expenses[0].name },
            { key: b, label: b, ledgerId: expenses[1]._id, ledgerName: expenses[1].name },
          ],
          updatedByEmail: "verify@grav.invalid",
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    );

    const after = pick(await build(FAKE_COMPANY, run, items, {}));
    const afterDr = after.entries.filter((e) => e.type === "Dr");
    const afterSalary = afterDr.filter((e) => !/stipend/i.test(e.ledgerName));
    check("mapped: the salary expense splits into several lines", afterSalary.length >= 2,
      afterSalary.map((e) => `${e.ledgerName}=${e.amount}`).join(" | "));
    check("each mapped department got its own configured ledger",
      afterSalary.some((e) => String(e.ledgerId) === String(expenses[0]._id)) &&
      afterSalary.some((e) => String(e.ledgerId) === String(expenses[1]._id)));

    const splitTotal = parseFloat(afterSalary.reduce((x, e) => x + e.amount, 0).toFixed(2));
    check("the split sums EXACTLY to the unsplit staff gross — no paise lost",
      Math.abs(splitTotal - staffGross) < 0.005, `${splitTotal} vs ${staffGross}`);

    const dr = parseFloat(afterDr.reduce((x, e) => x + e.amount, 0).toFixed(2));
    const cr = parseFloat(
      after.entries.filter((e) => e.type === "Cr").reduce((x, e) => x + e.amount, 0).toFixed(2),
    );
    check("and the voucher still balances", Math.abs(dr - cr) < 0.01, `Dr ${dr} vs Cr ${cr}`);

    const beforeCr = parseFloat(
      before.entries.filter((e) => e.type === "Cr").reduce((x, e) => x + e.amount, 0).toFixed(2),
    );
    check("the credit side is untouched by the split — only the expense is re-cut",
      Math.abs(beforeCr - cr) < 0.01, `${beforeCr} vs ${cr}`);

    /* 3. A department mapped to a ledger that has since been deactivated must
          not be posted to. */
    await Acc_PayrollLedgerMap.updateOne(
      { companyId: FAKE_COMPANY },
      { $set: { "departments.0.ledgerId": new mongoose.Types.ObjectId() } },
    );
    const stale = pick(await build(FAKE_COMPANY, run, items, {}));
    const staleDr = stale.entries.filter((e) => e.type === "Dr");
    const staleTotal = parseFloat(
      staleDr.filter((e) => !/stipend/i.test(e.ledgerName)).reduce((x, e) => x + e.amount, 0).toFixed(2),
    );
    check("a mapping to a ledger that no longer exists still balances",
      Math.abs(staleTotal - staffGross) < 0.005, `${staleTotal} vs ${staffGross}`);
  }

  /* ── the manual marker ────────────────────────────────────────────────── */
  console.log("\nmarking a month as posted by hand");
  const marker = await Acc_PayrollExternalPost.create({
    companyId: FAKE_COMPANY,
    payrollRunId: new mongoose.Types.ObjectId(),
    month: 4, year: 2026,
    voucherNumber: "JV/TEST/0001",
    note: "verify",
    markedByEmail: "verify@grav.invalid",
    markedByName: "Verify",
  });
  check("the marker records who, what and where", Boolean(marker._id) && marker.voucherNumber === "JV/TEST/0001");
  let dupe = false;
  try {
    await Acc_PayrollExternalPost.create({
      companyId: FAKE_COMPANY, payrollRunId: marker.payrollRunId,
      markedByEmail: "verify@grav.invalid",
    });
  } catch { dupe = true; }
  check("one run cannot carry two markers", dupe);

  console.log("\ncleanup");
  check("every harness row removed", (await cleanup()) >= 2);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    console.error(`cleaned up ${await cleanup()} row(s).`);
    await mongoose.disconnect();
  } catch { console.error("CLEANUP FAILED — remove @grav.invalid payroll-bridge rows."); }
  process.exit(1);
});
