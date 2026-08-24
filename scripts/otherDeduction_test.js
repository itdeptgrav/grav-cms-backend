"use strict";
// scripts/otherDeduction_test.js
//
// A standing monthly recovery — canteen, transport, whatever the company takes
// back — charged for the days they were THERE.
//
//     amount x (days in month − approved leave days) / days in month
//
//     amount x payableDays / daysInMonth
//
// "There" is payableDays — the SAME figure the payroll drawer prints at the
// top as "Payable: 29 / 31", and the one the gross itself is prorated on. It
// was briefly computed as daysInMonth minus leave days, a different number: a
// screen reading "Payable 29 / 31" above a deduction charged for 28 days is
// one nobody can reconcile, and deriving the two separately is exactly how
// they came to disagree.
//
// A consequence worth stating: PAID leave is a payable day, so it is charged.
// Only unpaid days — LWP, LOP, absence — reduce the figure.
//
// And nothing can be recovered from pay that was never earned, so the charge
// is capped at what is left after the statutory deductions. Without that an
// unpaid intern lands on a negative net pay.
//
// Runs the REAL engine over a fabricated month — no DB, no network.
//
//   node scripts/otherDeduction_test.js

process.env.SALARY_ENCRYPTION_KEY =
  process.env.SALARY_ENCRYPTION_KEY ||
  require("crypto").randomBytes(32).toString("hex");

const path = require("path");
const ROOT = path.join(__dirname, "..");
const { computeEmployeePayroll } = require(
  path.join(ROOT, "routes/HrRoutes/Payroll_section"),
);

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

const settings = {
  payableDaysBasis: "calendar", roundingMode: "round", roundNetPay: true,
  mpTreatment: "half_day", sundayWorkExtraPay: false, sundayOffsetsAbsence: false,
  ptEnabled: false, clAutoAdjust: { enabled: false },
};
const salaryCfg = { epfCapAmount: 1800, eepfPct: 12, esiWageLimit: 21000, eeEsicPct: 0.75, erEsicPct: 3.25 };

/** A January (31 days) with the given day codes filled in from the 2nd. */
function monthWith(codes) {
  const m = new Map();
  let d = 2;
  for (const code of codes) {
    m.set(`2025-01-${String(d).padStart(2, "0")}`, { hrFinalStatus: code });
    d++;
  }
  for (; d <= 31; d++) {
    const ds = `2025-01-${String(d).padStart(2, "0")}`;
    if (new Date(ds + "T00:00:00").getDay() === 0) continue;
    m.set(ds, { hrFinalStatus: "P" });
  }
  m.set("2025-01-01", { hrFinalStatus: "P" });
  return m;
}

const staff = {
  _id: "e1", firstName: "Ravi", lastName: "K", biometricId: "GR0001",
  department: "DESIGN", employmentType: "full_time",
  salary: { gross: 31000, basic: 15500, hra: 15500, otherDeduction: 3100 },
  dateOfJoining: new Date("2024-01-01"),
};

function run(emp, codes) {
  return computeEmployeePayroll(emp, {
    month: 1, year: 2025, settings, salaryCfg,
    holidayMap: new Map(), attendanceByDate: monthWith(codes),
    leaveBalance: null, leaveConfig: { clPerYear: 12, slPerYear: 12, plPerYear: 15 },
  });
}

console.log("\n=== a clean month: charged in full ===");
let r = run(staff, []);
check("charged", r.deductions.otherDeductions, 3100);
check("chargeable days", r.otherDeductionChargeableDays, 31);
// 3100 / 31 = exactly 100 a day, which makes every figure below readable.
check("rate is 100/day", 3100 / 31, 100);
check("week-offs are payable, so charged", r.weekOffDays > 0, true);

console.log("\n=== chargeable days ARE the payable days on screen ===");
for (const [code, name, payable] of [
  ["LWP", "unpaid leave", 26],
  ["AB", "absence", 26],
]) {
  const five = run(staff, [code, code, code, code, code]);
  check(`5 days ${name}: payable`, five.payableDays, payable);
  check(`  chargeable matches it exactly`, five.otherDeductionChargeableDays, payable);
  check(`  charged`, five.deductions.otherDeductions, payable * 100);
}

console.log("\n=== paid leave is a payable day, so it is charged ===");
// This is the consequence of following the payable figure. CL, SL and PL are
// paid days; they do not reduce what is payable, so they do not reduce this.
const onCl = run(staff, ["L-CL", "L-CL", "L-CL"]);
check("3 days CL: payable", onCl.payableDays, 31);
check("  charged in full", onCl.deductions.otherDeductions, 3100);

console.log("\n=== nobody without a standing deduction is charged ===");
const none = run({ ...staff, salary: { ...staff.salary, otherDeduction: 0 } }, ["LWP"]);
check("no amount -> nothing", none.deductions.otherDeductions, 0);
check("  and no phantom working", none.otherDeductionFull, 0);

console.log("\n=== interns have standing deductions too ===");
const intern = run(
  {
    ...staff, employmentType: "intern", internship: { stipendType: "paid" },
    salary: { stipend: 15500, otherDeduction: 3100 },
  },
  ["LWP", "LWP"],
);
check("prorated the same way", intern.deductions.otherDeductions, 2900);
check("  and it is their ONLY deduction", intern.deductions.totalDeductions, 2900);
check("  no PF alongside it", intern.deductions.providentFund, 0);

console.log("\n=== never a negative net pay ===");
// An unpaid intern, or anybody whose month came out at zero, used to take the
// full deduction against a gross of nothing and land on a NEGATIVE net —
// which is not a payslip anybody can act on.
const unpaidIntern = run(
  {
    ...staff, employmentType: "intern", internship: { stipendType: "unpaid" },
    salary: { stipend: 0, otherDeduction: 764 },
  },
  [],
);
check("gross", unpaidIntern.earnings.grossEarnings, 0);
check("nothing deducted", unpaidIntern.deductions.totalDeductions, 0);
check("net pay is zero, not negative", unpaidIntern.roundedNetPay, 0);
check("the shortfall is recorded", unpaidIntern.otherDeductionUncollected, 764);

// Partial room: earnings smaller than the deduction.
const thin = run(
  { ...staff, salary: { gross: 1000, basic: 500, hra: 500, otherDeduction: 5000 } },
  [],
);
check("takes only what is there", thin.netPay >= 0, true);
check("  and says what it could not take", thin.otherDeductionUncollected > 0, true);

console.log("\n=== the working is recorded, not just the figure ===");
const five = run(staff, ["LWP", "LWP", "LWP", "LWP", "LWP"]);
check("full monthly amount", five.otherDeductionFull, 3100);
check("chargeable days", five.otherDeductionChargeableDays, 26);
check("matches payable days", five.otherDeductionChargeableDays, five.payableDays);
check("recurring portion", five.otherDeductionRecurring, 2600);
check("nothing uncollected", five.otherDeductionUncollected, 0);

console.log(
  failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
