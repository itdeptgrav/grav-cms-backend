"use strict";
// scripts/payslipPayload_test.js
//
// The payslip is produced from ONE builder now. It used to be two — HR's and
// the app's — and they had drifted: the app headed the document
// "Grav Clothing" with a tagline and a logo path that resolved to nothing,
// HR's said "Grav Clothing ( OPC ) Pvt Ltd". Employees were downloading a
// different payslip from the one HR saw, and nobody had decided that.
//
// So the first thing checked is that both routes reach the same function, and
// then that the function describes an intern honestly:
//
//   one Stipend line, not a Basic Salary line — an intern has no basic, and
//     labelling one asserts an arrangement they are not party to
//   no deduction rows at all
//   no employer PF or ESIC row — the template prints those for any figure
//     above zero, and either would claim a fund they are not enrolled in
//   no PF / UAN / ESI numbers in the header, even if the record has one
//
//   node scripts/payslipPayload_test.js       (no DB, no network)

const path = require("path");
const ROOT = path.join(__dirname, "..");
const {
  buildPayslipPayload,
} = require(path.join(ROOT, "services/payslipPayload.service"));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(48)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

console.log("\n=== both routes use the one builder ===");
const hr = require(path.join(ROOT, "routes/HrRoutes/Payslip_section"));
const app = require(path.join(ROOT, "routes/Employee_Routes/Payslip"));
const src = (f) => require("fs").readFileSync(path.join(ROOT, f), "utf8");
for (const f of [
  "routes/HrRoutes/Payslip_section.js",
  "routes/Employee_Routes/Payslip.js",
]) {
  const t = src(f);
  check(
    `${path.basename(f)} imports it`,
    /require\(".*payslipPayload\.service"\)/.test(t),
    true,
  );
  check(
    `${path.basename(f)} defines no copy`,
    /function buildPayslipPayload/.test(t),
    false,
  );
}

// Somebody on file for PF and ESI who is nonetheless an intern — the numbers
// must not print, because the item says this month was paid as a stipend.
const employee = {
  _id: "i1", firstName: "Asha", lastName: "R", biometricId: "GR9001",
  department: "DESIGN", designation: "Design Intern",
  dateOfJoining: new Date("2025-01-06"), dateOfBirth: new Date("2003-04-11"),
  bankDetails: { bankName: "SBI", accountNumber: "123456789" },
  documents: { panNumber: "ABCDE1234F", pfNumber: "PF-STALE", uanNumber: "UAN-STALE", esicNumber: "ESI-STALE" },
};
const internItem = {
  month: 1, year: 2025, isIntern: true, internshipType: "paid",
  payableDays: 26, workingDays: 31, daysInMonth: 31, presentDays: 26, lopDays: 5,
  earnings: { stipend: 13000, basicSalary: 0, houseRentAllowance: 0, grossEarnings: 13000 },
  deductions: { providentFund: 0, esic: 0, employerPF: 0, employerESIC: 0, totalDeductions: 0 },
  roundedNetPay: 13000, status: "paid",
};

console.log("\n=== an intern's payslip ===");
let p = buildPayslipPayload(internItem, employee);
check("one earnings line", p.earnings.length, 1);
check("and it says Stipend", p.earnings[0].label, "Stipend");
check("  for the earned amount", p.earnings[0].amount, 13000);
check("no deduction rows", p.deductions.length, 0);
check("no employer PF", p.employerContributions.epf, 0);
check("no employer ESIC", p.employerContributions.esic, 0);
check("PF number suppressed", p.employee.pfNo, "");
check("UAN suppressed", p.employee.uanNo, "");
check("ESI number suppressed", p.employee.esiNo, "");
check("PAN still printed", p.employee.panNo, "ABCDE1234F");
check("net pay", p.summary.netPay, 13000);
check("worked days survive", [p.attendance.payableDays, p.attendance.workingDays], [26, 31]);

console.log("\n=== the masthead is the template's, not the payload's ===");
// This is the exact field that drifted between the two old copies.
check("no company block", p.company, undefined);

console.log("\n=== a salaried payslip is unchanged ===");
const staffItem = {
  month: 1, year: 2025, isIntern: false,
  payableDays: 31, workingDays: 31, daysInMonth: 31, presentDays: 31,
  earnings: { basicSalary: 15500, houseRentAllowance: 15500, grossEarnings: 31000 },
  deductions: { providentFund: 1800, esic: 117, employerPF: 1800, employerESIC: 504, totalDeductions: 1917 },
  roundedNetPay: 29083,
};
p = buildPayslipPayload(staffItem, {
  ...employee, designation: "Designer",
});
check("basic and HRA", p.earnings.map((r) => r.label), ["Basic Salary", "House Rent Allowance"]);
check("PF and ESIC deducted", p.deductions.map((r) => r.label), ["Provident Fund", "ESIC (Employee)"]);
check("employer PF printed", p.employerContributions.epf, 1800);
check("PF number printed", p.employee.pfNo, "PF-STALE");

console.log("\n=== a March payslip does not change when they are promoted ===");
// The flag is read off the ITEM, so the record of what was paid stays put.
p = buildPayslipPayload(internItem, { ...employee, employmentType: "full_time" });
check("still a stipend", p.earnings[0].label, "Stipend");

console.log(
  failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
