"use strict";
// scripts/internPayroll_test.js
//
// Interns are paid a prorated stipend and nothing else. Four things have to
// hold, and each one is a real way to get somebody's pay wrong:
//
//   1. The stipend prorates. Turn up for 20 of 31 days, get 20/31 of it.
//   2. It is not split into a basic and an HRA. The split is what every
//      deduction is computed FROM, so inventing one is how an intern ends up
//      with a provident fund.
//   3. Nothing is deducted. Not because the arithmetic happens to come out at
//      zero, but because they are enrolled in neither scheme — the money would
//      be withheld and remitted against a membership that does not exist.
//   4. No leave. No 24-day CL eligibility, and no auto-adjustment quietly
//      rescuing an absence out of a balance they do not have.
//
// Runs the REAL computeEmployeePayroll over a fabricated month — no DB, no
// network — so it tests the engine payroll actually uses rather than a
// restatement of it.
//
//   node scripts/internPayroll_test.js

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
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(48)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

const MONTH = 1; // January 2025 — 31 days, no month-end ambiguity
const YEAR = 2025;

const settings = {
  payableDaysBasis: "calendar",
  roundingMode: "round",
  roundNetPay: true,
  mpTreatment: "half_day",
  sundayWorkExtraPay: false,
  sundayOffsetsAbsence: false,
  ptEnabled: true,
  ptForBasic: (basic) => (basic > 20000 ? 200 : 0),
  clAutoAdjust: { enabled: true, maxABForAdjustment: 2, consumeFromBalance: false },
};
const salaryCfg = { epfCapAmount: 1800, eepfPct: 12, esiWageLimit: 21000, eeEsicPct: 0.75, erEsicPct: 3.25 };

/** A month where they were absent `absent` days and present the rest. */
function attendanceWith(absent) {
  const m = new Map();
  let left = absent;
  for (let d = 1; d <= 31; d++) {
    const dateStr = `2025-01-${String(d).padStart(2, "0")}`;
    const dow = new Date(dateStr + "T00:00:00").getDay();
    if (dow === 0) continue; // Sundays are left to the engine as week-offs
    const isAbsent = left > 0 && (left--, true);
    m.set(dateStr, { hrFinalStatus: isAbsent ? "AB" : "P" });
  }
  return m;
}

function run(employee, absent = 0) {
  return computeEmployeePayroll(employee, {
    month: MONTH, year: YEAR, settings, salaryCfg,
    holidayMap: new Map(),
    attendanceByDate: attendanceWith(absent),
    leaveBalance: null,
    leaveConfig: { clPerYear: 12, slPerYear: 12, plPerYear: 15 },
  });
}

const JOINED = new Date("2024-01-01"); // long-serving, so CL eligibility is live

const intern = {
  _id: "i1", firstName: "Asha", lastName: "R", biometricId: "GR9001",
  department: "DESIGN", employmentType: "intern",
  internship: { stipendType: "paid" },
  salary: { stipend: 15500, gross: 0, basic: 0, hra: 0 },
  dateOfJoining: JOINED,
};
const staff = {
  _id: "e1", firstName: "Ravi", lastName: "K", biometricId: "GR0001",
  department: "DESIGN", employmentType: "full_time",
  salary: { gross: 31000, basic: 15500, hra: 15500 },
  dateOfJoining: JOINED,
};

console.log("\n=== a full month: the stipend arrives whole ===");
let r = run(intern, 0);
check("flagged as an intern", r.isIntern, true);
check("arrangement recorded", r.internshipType, "paid");
check("gross earnings = the stipend", r.earnings.grossEarnings, 15500);
check("carried as a stipend", r.earnings.stipend, 15500);
check("no basic", r.earnings.basicSalary, 0);
check("no HRA", r.earnings.houseRentAllowance, 0);
check("nothing deducted", r.deductions.totalDeductions, 0);
check("take home = the stipend", r.roundedNetPay, 15500);

console.log("\n=== absences cut it, at the same rate a salary is cut ===");
const iAbsent = run(intern, 5);
const sAbsent = run(staff, 5);
// 31 days, 5 unpaid -> 26 payable for the intern. The employee lands on 28,
// because two of their absences are auto-adjusted into CL — which is exactly
// the difference this whole change is about, so they cannot be compared
// directly. The like-for-like comparison turns that rescue off.
const settingsNoRescue = { ...settings, clAutoAdjust: { enabled: false } };
const sBare = computeEmployeePayroll(staff, {
  month: MONTH, year: YEAR, settings: settingsNoRescue, salaryCfg,
  holidayMap: new Map(), attendanceByDate: attendanceWith(5),
  leaveBalance: null, leaveConfig: {},
});
check("intern payable days", iAbsent.payableDays, 26);
check("staff payable days, no rescue", sBare.payableDays, 26);
check(
  "intern loses 5/31 of the stipend",
  iAbsent.earnings.grossEarnings,
  Math.round((15500 / 31) * 26),
);
check(
  "the same proportion as staff",
  Math.round((iAbsent.earnings.grossEarnings / 15500) * 1000),
  Math.round((sBare.earnings.grossEarnings / 31000) * 1000),
);

console.log("\n=== the staff row still gets everything interns do not ===");
check("staff have a basic", sAbsent.earnings.basicSalary > 0, true);
check("staff have PF", sAbsent.deductions.providentFund > 0, true);
check("intern has none", iAbsent.deductions.providentFund, 0);
check("intern has no ESI", iAbsent.deductions.esic, 0);
check("intern has no employer ESI", iAbsent.deductions.employerESIC, 0);
check("intern has no professional tax", iAbsent.deductions.professionalTax, 0);

console.log("\n=== no leave, and nothing rescues an absence ===");
// clAutoAdjust is ENABLED above with consumeFromBalance false, so an employee
// gets 2 absences forgiven out of thin air. An intern must not.
check("staff: 2 absences auto-adjusted to CL", sAbsent.autoAdjustedCL, 2);
check("intern: none", iAbsent.autoAdjustedCL, 0);
check("intern is never CL-eligible", iAbsent.clEligible, false);
check("intern accrues no CL", iAbsent.leaveBalanceSnapshot.entitlement.CL, 0);
check("intern accrues no PL", iAbsent.leaveBalanceSnapshot.entitlement.PL, 0);
check("staff do accrue", sAbsent.leaveBalanceSnapshot.entitlement.CL > 0, true);
// The absences therefore stay unpaid, which is the point of all of the above.
check("intern keeps all 5 absences", iAbsent.absentDays, 5);
check("staff keep only 3", sAbsent.absentDays, 3);

console.log("\n=== unpaid and self-paid internships ===");
for (const kind of ["unpaid", "self_paid"]) {
  const free = run(
    { ...intern, internship: { stipendType: kind }, salary: { stipend: 0 } },
    2,
  );
  check(`${kind}: pays nothing`, free.roundedNetPay, 0);
  check(`${kind}: still has a row`, free.isIntern, true);
  check(`${kind}: attendance still counted`, free.payableDays, 29); // 31 - 2 absent
}

console.log(
  failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
