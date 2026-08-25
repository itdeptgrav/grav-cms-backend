"use strict";
/**
 * services/payslipPayload.service.js
 *
 * One function that turns a PayrollItem plus an Employee into the payload the
 * payslip template renders.
 *
 * There used to be two of these — one in routes/HrRoutes/Payslip_section.js
 * for the HR dashboard, one in routes/Employee_Routes/Payslip.js for the
 * mobile app — and they had already drifted. HR's said the company was
 * "Grav Clothing ( OPC ) Pvt Ltd"; the app's said "Grav Clothing" with a
 * tagline of "GRAV CLOTHING LIMITED" and a logoUrl of "../../grav-logo.png",
 * a relative path that resolves to nothing from either caller. Nobody set out
 * to give employees a differently-headed payslip from the one HR downloads;
 * the second copy was edited once and the first was not.
 *
 * That is the same failure the payslip TEMPLATE had, and it is fixed the same
 * way: one definition, both callers importing it. The company name and logo
 * are not even set here — lib/payslipTemplate.mjs owns both, and passing them
 * in was how they came to disagree in the first place.
 */

const MONTH_NAMES = [
  "", "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function fmtDate(d) {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return "";
  return (
    `${String(dt.getDate()).padStart(2, "0")}.` +
    `${String(dt.getMonth() + 1).padStart(2, "0")}.` +
    `${dt.getFullYear()}`
  );
}

/**
 * Build the payslip payload.
 *
 * @param {object} item      a PayrollItem (lean or hydrated)
 * @param {object} employee  the Employee, salary already decrypted
 * @returns {object} the shape renderPayslipBody() expects
 */
function buildPayslipPayload(item, employee) {
  const fullName = [employee.firstName, employee.middleName, employee.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();

  const e = item.earnings || {};
  const d = item.deductions || {};

  // isIntern is read off the ITEM, not the employee. A payslip is a record of
  // what was paid that month — somebody promoted out of an internship in April
  // must not have their March payslip re-render as a salaried one.
  const isIntern = !!item.isIntern;

  // A stipend is one figure with no components, so it is one line. Printing it
  // as "Basic Salary" would describe an arrangement the intern is not party
  // to, and printing a zero HRA beside it would invite the question of where
  // the rest went.
  const earningsLines = (
    isIntern
      ? [
          { label: "Stipend", amount: e.stipend || e.grossEarnings || 0 },
          { label: "Bonus", amount: e.bonus || 0 },
          { label: "Incentives", amount: e.incentives || 0 },
          { label: "Other Earnings", amount: e.otherEarnings || 0 },
        ]
      : [
          { label: "Basic Salary", amount: e.basicSalary || 0 },
          { label: "House Rent Allowance", amount: e.houseRentAllowance || 0 },
          { label: "Travel Allowance", amount: e.travelAllowance || 0 },
          { label: "Medical Allowance", amount: e.medicalAllowance || 0 },
          { label: "Special Allowance", amount: e.specialAllowance || 0 },
          { label: "Overtime", amount: e.overtime || 0 },
          { label: "Bonus", amount: e.bonus || 0 },
          { label: "Incentives", amount: e.incentives || 0 },
          { label: "Other Earnings", amount: e.otherEarnings || 0 },
        ]
  ).filter((r) => r.amount > 0);

  // No Professional Tax — Odisha has removed it.
  // Every one of these is zero for an intern, so the list comes out empty and
  // the template prints no deduction rows. That is the correct document: they
  // are enrolled in nothing, so there is nothing to withhold.
  const deductionsLines = [
    { label: "Provident Fund", amount: d.providentFund || 0 },
    { label: "ESIC (Employee)", amount: d.esic || 0 },
    { label: "Income Tax (TDS)", amount: d.incomeTax || 0 },
    { label: "Loan Deduction", amount: d.loanDeduction || 0 },
    { label: "Advance Deduction", amount: d.advanceDeduction || 0 },
    { label: "Loss of Pay", amount: d.lopDeduction || 0 },
    { label: "Other Deductions", amount: d.otherDeductions || 0 },
  ].filter((r) => r.amount > 0);

  // Attendance from the PayrollItem, not recomputed (fixes the 0/31 bug).
  const payableDays = item.payableDays ?? item.presentDays ?? 0;
  const workingDays = item.workingDays ?? 31;
  const daysInMonth =
    item.daysInMonth ?? new Date(item.year, item.month, 0).getDate();

  return {
    // Deliberately no company name, tagline or logoUrl: lib/payslipTemplate
    // owns the masthead, and the embedded logo is a data URI precisely so it
    // cannot lose a race with the print call. Supplying either here is what
    // let the two old copies disagree.
    period: {
      month: item.month,
      year: item.year,
      label: `${MONTH_NAMES[item.month]} ${item.year}`,
    },
    employee: {
      id: employee._id,
      name: fullName,
      empNo: employee.biometricId || employee.identityId || "",
      payPeriod: `${MONTH_NAMES[item.month]} ${item.year}`,
      doj: fmtDate(employee.dateOfJoining),
      dob: fmtDate(employee.dateOfBirth),
      bankName:
        employee.bankDetails?.bankName || item.bankDetails?.bankName || "",
      bankAccountNo:
        employee.bankDetails?.accountNumber ||
        item.bankDetails?.accountNumber ||
        "",
      panNo: employee.documents?.panNumber || "",
      // Blank for an intern even where a number happens to be on file — they
      // are not enrolled, and the template drops empty statutory fields
      // rather than printing them as empty boxes.
      pfNo: isIntern ? "" : employee.documents?.pfNumber || "",
      uanNo: isIntern ? "" : employee.documents?.uanNumber || "",
      esiNo: isIntern ? "" : employee.documents?.esicNumber || "",
      department: employee.department || item.department || "",
      designation:
        employee.designation || employee.jobTitle || item.designation || "",
    },
    attendance: {
      payableDays,
      workingDays,
      daysInMonth,
      presentDays: item.presentDays || 0,
      absentDays: item.absentDays || 0,
      lopDays: item.lopDays || 0,
      paidLeaveDays: item.paidLeaveDays || 0,
    },
    summary: {
      grossEarnings: Math.round(e.grossEarnings || 0),
      totalDeduction: Math.round(d.totalDeductions || 0),
      netPay: Math.round(item.roundedNetPay ?? item.netPay ?? 0),
      takeHomePay: Math.round(item.roundedNetPay ?? item.netPay ?? 0),
    },
    employerContributions: {
      // Guarded rather than relying on the figures being zero: the template
      // prints a row for anything above zero, and "Employer PF Contribution"
      // on an intern's payslip would assert a fund that does not exist.
      epf: isIntern ? 0 : d.employerPF || d.providentFund || 0,
      esic: isIntern ? 0 : d.employerESIC || 0,
    },
    earnings: earningsLines,
    deductions: deductionsLines,
    isIntern,
    status: item.status,
    paymentDate: item.paymentDate,
    processedAt: item.processedAt,
  };
}

module.exports = { buildPayslipPayload, MONTH_NAMES, fmtDate };
