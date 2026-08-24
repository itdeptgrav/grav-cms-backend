"use strict";
// scripts/payrollVoucher_test.js
//
// The payroll journal. This is the one place in the whole flow where a mistake
// stops being a screen and becomes an accounting entry, so it gets its own
// test with no database behind it.
//
// What it has to get right, now that interns are in the run:
//
//   Dr  Salaries A/c            staff gross
//   Dr  Stipend to Interns      intern gross      <- not folded into Salaries
//       Cr  PF Payable
//       Cr  ESI Payable
//       Cr  Other Deductions Payable
//       Cr  Salary Payable      staff net
//       Cr  Stipend Payable     intern net        <- its own liability
//
// and on payment, BOTH payables are cleared — clearing only Salary Payable
// for the whole net would leave Stipend Payable standing on the balance sheet
// after the interns had actually been paid.
//
// A zero line is omitted rather than posted: a company with no interns should
// not grow a Stipend row in every month's journal.
//
//   node scripts/payrollVoucher_test.js       (no DB, no network)

const path = require("path");
// A real ObjectId — the models cast companyId, and a COMPANY placeholder throws
// before any of the logic under test runs.
const COMPANY = new (require("mongoose").Types.ObjectId)();
const ROOT = path.join(__dirname, "..");

// Stub the ledger lookup BEFORE requiring the route, so no database is
// touched. What is under test is the arithmetic and which ledger each amount
// is routed to — not how a ledger comes into existence.
const { Acc_Ledger, Acc_Group } = require(
  path.join(ROOT, "models/Accountant_model/Acc_MasterModels"),
);
// findOrCreateLedger tries each candidate name in turn and returns the first
// that exists. Handing back a synthetic ledger for whatever it asks for means
// it never reaches the group lookup or the create path, and the test stays
// about the journal rather than about chart-of-accounts seeding.
let nextId = 1;
const byName = new Map();
Acc_Ledger.findOne = (q) => ({
  lean: async () => {
    // q.name is /^Some Name$/i — recover the literal it was built from.
    const name = String(q.name.source).replace(/^\^|\$$/g, "").replace(/\\/g, "");
    if (!byName.has(name))
      byName.set(name, {
        _id: `led${nextId++}`,
        name,
        groupName: "Test Group",
      });
    return byName.get(name);
  },
});
Acc_Ledger.find = () => ({ lean: async () => [] });
Acc_Group.find = () => ({ lean: async () => [] });
Acc_Group.findOne = () => ({ lean: async () => null });
// The paid run needs a bank ledger. Supplying one explicitly is the same path
// the UI uses when the accountant picks the account to pay from.
const BANK = new (require("mongoose").Types.ObjectId)();
Acc_Ledger.findById = () => ({
  lean: async () => ({
    _id: BANK, name: "HDFC Current A/c", groupName: "Bank Accounts",
    companyId: COMPANY,
  }),
});

const acc = require(path.join(ROOT, "routes/Accountant_Routes/Acc_chartOfAccounts"));
const { buildPayrollVouchers } = acc;

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

const item = (over = {}) => ({
  earnings: { grossEarnings: 0 }, deductions: {}, netPay: 0, ...over,
});

function staff(gross, pf, esi, net) {
  return item({
    isIntern: false,
    earnings: { grossEarnings: gross },
    deductions: { providentFund: pf, esic: esi, totalDeductions: pf + esi },
    netPay: net,
  });
}
function intern(gross, other, net) {
  return item({
    isIntern: true,
    earnings: { grossEarnings: gross, stipend: gross },
    deductions: { otherDeductions: other, totalDeductions: other },
    netPay: net,
  });
}

const run = { _id: "r1", year: 2025, month: 1, payPeriod: "January 2025", status: "processed" };

/** Sum the Dr / Cr amounts against a ledger whose name contains `needle`. */
const amountOn = (entries, needle, type) =>
  entries
    .filter((e) => e.ledgerName.toLowerCase().includes(needle) && e.type === type)
    .reduce((a, e) => a + e.amount, 0);

(async () => {
  console.log("\n=== a mixed run: staff and interns ===");
  const items = [
    staff(31000, 1800, 0, 29200),
    staff(20000, 1800, 150, 18050),
    intern(15000, 1000, 14000),
    intern(12000, 0, 12000),
  ];
  const built = await buildPayrollVouchers(COMPANY, run, items, {});
  const proc = built.vouchers.find((v) => v.kind === "processing");
  const e = proc.entries;

  check("staff gross to Salaries", amountOn(e, "salar", "Dr"), 51000);
  check("intern gross to Stipend", amountOn(e, "stipend", "Dr"), 27000);
  check("staff net to Salary Payable", amountOn(e, "salary payable", "Cr"), 47250);
  check("intern net to Stipend Payable", amountOn(e, "stipend payable", "Cr"), 26000);
  check("PF credited", amountOn(e, "pf payable", "Cr"), 3600);
  check("ESI credited", amountOn(e, "esi payable", "Cr"), 150);
  check("other deductions credited", amountOn(e, "other deductions", "Cr"), 1000);

  const dr = e.filter((x) => x.type === "Dr").reduce((a, x) => a + x.amount, 0);
  const cr = e.filter((x) => x.type === "Cr").reduce((a, x) => a + x.amount, 0);
  check("the journal balances", Math.round((dr - cr) * 100), 0);
  check("stipends did NOT land in Salaries", amountOn(e, "salaries", "Dr"), 51000);

  console.log("\n=== payment clears BOTH payables ===");
  const paid = await buildPayrollVouchers(COMPANY, { ...run, status: "paid" }, items, { bankLedgerId: BANK });
  const pay = paid.vouchers.find((v) => v.kind === "payment");
  check("salary payable cleared", amountOn(pay.entries, "salary payable", "Dr"), 47250);
  check("stipend payable cleared", amountOn(pay.entries, "stipend payable", "Dr"), 26000);
  const bank = pay.entries.filter((x) => x.type === "Cr").reduce((a, x) => a + x.amount, 0);
  check("bank credited the whole net", bank, 73250);
  const pdr = pay.entries.filter((x) => x.type === "Dr").reduce((a, x) => a + x.amount, 0);
  check("payment balances", Math.round((pdr - bank) * 100), 0);

  console.log("\n=== a company with no interns grows no Stipend row ===");
  const staffOnly = await buildPayrollVouchers(COMPANY, run, [staff(31000, 1800, 0, 29200)], {});
  const soEntries = staffOnly.vouchers.find((v) => v.kind === "processing").entries;
  check("no stipend line at all", soEntries.filter((x) => /stipend/i.test(x.ledgerName)).length, 0);

  console.log("\n=== a run of interns only grows no empty Salaries row ===");
  const internOnly = await buildPayrollVouchers(COMPANY, run, [intern(15000, 0, 15000)], {});
  const ioEntries = internOnly.vouchers.find((v) => v.kind === "processing").entries;
  check("no Salaries Dr", amountOn(ioEntries, "salaries", "Dr"), 0);
  check("no Salary Payable Cr", amountOn(ioEntries, "salary payable", "Cr"), 0);
  check("stipend Dr", amountOn(ioEntries, "stipend to interns", "Dr"), 15000);

  console.log(
    failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error("\nthe builder threw:", err.message);
  process.exit(1);
});
