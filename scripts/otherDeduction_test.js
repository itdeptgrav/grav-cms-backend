"use strict";
// scripts/otherDeduction_test.js
//
// A standing monthly recovery — canteen, transport, whatever the company takes
// back — charged for the days they were THERE.
//
//     amount x (days in month − approved leave days) / days in month
//
// Approved leave only: CL, SL, PL and LWP are days somebody ARRANGED to be
// away, and the arrangement is what makes the charge unfair. An unexplained
// absence is not an arrangement, so it is still charged — which also stops the
// deduction being dodged by simply not turning up.
//
// The divisor is the real length of the month, the same one gross pay uses, so
// a February deduction and a February salary prorate identically.
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
check("counted in the total", r.deductions.totalDeductions >= 3100, true);
// 3100 / 31 = exactly 100 a day, which makes every figure below readable.
check("rate is 100/day", 3100 / 31, 100);

console.log("\n=== approved leave is not charged ===");
for (const [code, name] of [["L-CL", "casual"], ["L-SL", "sick"], ["L-EL", "earned"], ["LWP", "unpaid"]]) {
  const five = run(staff, [code, code, code, code, code]);
  check(`5 days ${name} leave -> 26 days`, five.otherDeductionChargeableDays, 26);
  check(`  charged`, five.deductions.otherDeductions, 2600);
}

console.log("\n=== an unexplained absence IS charged ===");
// Not an arrangement. Charging it is also what stops the deduction being
// avoided by simply not turning up.
const absent = run(staff, ["AB", "AB", "AB", "AB", "AB"]);
check("5 days absent -> still 31", absent.otherDeductionChargeableDays, 31);
check("  charged in full", absent.deductions.otherDeductions, 3100);

console.log("\n=== Sundays and holidays are charged — the month is the month ===");
// No leave at all here; January 2025 has four Sundays that nobody worked.
check("clean month still 31 chargeable", r.otherDeductionChargeableDays, 31);
check("week-offs counted", r.weekOffDays > 0, true);

console.log("\n=== nobody without a standing deduction is charged ===");
const none = run({ ...staff, salary: { ...staff.salary, otherDeduction: 0 } }, ["L-CL"]);
check("no amount -> nothing", none.deductions.otherDeductions, 0);
check("  and no phantom working", none.otherDeductionFull, 0);

console.log("\n=== interns have standing deductions too ===");
const intern = run(
  {
    ...staff, employmentType: "intern", internship: { stipendType: "paid" },
    salary: { stipend: 15500, otherDeduction: 3100 },
  },
  ["L-CL", "L-CL"],
);
check("prorated the same way", intern.deductions.otherDeductions, 2900);
check("  and it is their ONLY deduction", intern.deductions.totalDeductions, 2900);
check("  no PF alongside it", intern.deductions.providentFund, 0);

console.log("\n=== the working is recorded, not just the figure ===");
const five = run(staff, ["L-CL", "L-CL", "L-CL", "L-CL", "L-CL"]);
check("full monthly amount", five.otherDeductionFull, 3100);
check("leave days", five.otherDeductionLeaveDays, 5);
check("chargeable days", five.otherDeductionChargeableDays, 26);
check("recurring portion", five.otherDeductionRecurring, 2600);

console.log(
  failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
