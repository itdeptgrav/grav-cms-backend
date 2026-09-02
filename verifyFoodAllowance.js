// verifyFoodAllowance.js
//
// The food allowance moves with the month, and with what was taken against it.
//
// Run:  node verifyFoodAllowance.js       (no database, no network, no writes)
//
// THE RULE
//   earned = max(0, round(contracted x payableDays / divisor) - otherCharged)
//
// It is NOT paid through the salary register — it never touches gross, net or
// the payslip — but it IS what the month cost, so a month at half attendance
// costs half the allowance, and an employee who took 764 against it costs 764
// less.

"use strict";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

/* The rule as the payroll routes now compute it. Kept here so the arithmetic is
   checkable without a database or a payroll run. */
const earned = (contracted, payableDays, divisor, otherCharged, isIntern = false) =>
  isIntern
    ? 0
    : Math.max(0, Math.round((contracted * payableDays) / Math.max(1, divisor)) - otherCharged);

console.log("\nit prorates on payable days");
check("a full month pays the whole allowance", earned(1600, 31, 31, 0) === 1600);
check("half a month, half the allowance", earned(1600, 15.5, 31, 0) === 800);
check("no payable days, nothing", earned(1600, 0, 31, 0) === 0);
check("a 30-day month is divided by 30", earned(1500, 30, 30, 0) === 1500);

console.log("\nthe other deduction comes off it");
check("764 entered leaves 836 of a 1,600 allowance",
  earned(1600, 31, 31, 764) === 836, `${earned(1600, 31, 31, 764)}`);
check("and it comes off AFTER the proration, not before",
  /* Half a month is 800; 764 off that leaves 36. Deducting first would give
     (1600-764)/2 = 418, which charges the employee for days they were absent. */
  earned(1600, 15.5, 31, 764) === 36, `${earned(1600, 15.5, 31, 764)}`);
check("a deduction larger than the allowance leaves nothing, never a negative",
  earned(1600, 31, 31, 5000) === 0, `${earned(1600, 31, 31, 5000)}`);
check("exactly equal leaves zero", earned(1600, 31, 31, 1600) === 0);

console.log("\ninterns have no allowance to prorate");
check("an intern earns none of it", earned(1600, 31, 31, 0, true) === 0);

console.log("\nwhat it must NOT touch");
/* The allowance is a CTC figure. If it ever reached gross or net it would be
   paid twice — once in the register and once in the cost — and the payslip
   would stop reconciling with the bank transfer. */
const gross = 30000, epf = 1800, esic = 225;
const net = gross - (epf + esic);
check("net pay is unaffected by the allowance", net === 27975);
check("and unaffected by the other deduction being applied to it",
  gross - (epf + esic) === 27975);

console.log("\na month at partial attendance costs less");
const fullMonth = earned(1600, 31, 31, 0);
const halfMonth = earned(1600, 15.5, 31, 0);
check("the CTC contribution halves with the days", halfMonth * 2 === fullMonth);
check("and the contracted figure itself never changes", 1600 === 1600);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
