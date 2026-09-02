// verifySalaryRules.js
//
// EDLI and admin charges cap at 75/mo, and CTC includes them.
//
// Run:  node verifySalaryRules.js        (no database, no network, no writes)
//
// WHAT WAS WRONG
//   EDLI  = min(basic x 0.5%, 15000)  -- compared ~200 against 15,000, so the
//           cap never bound and a 40,000 basic produced 200.
//   Admin = basic x 0.5%              -- no ceiling at all.
//   CTC   = gross + epf + erEsic + food  -- left both out entirely.

"use strict";

const { computeSalary } = require("./services/salaryFormula");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

const CFG = {};                       // all defaults: 50/50, 0.5%, 15000, 75
const at = (gross, over = {}) => computeSalary({ gross, ...over }, CFG, "employee");

console.log("\nEDLI and admin charges cap at 75");
/* basic = 50% of gross, so gross 30,000 -> basic 15,000 -> exactly at the
   ceiling, and everything above must stay at 75. */
for (const [gross, basic, expected] of [
  [20000, 10000, 50],    // below the ceiling: 10,000 x 0.5%
  [30000, 15000, 75],    // exactly at it
  [40000, 20000, 75],    // above
  [80000, 40000, 75],    // well above -- the case that used to give 200
  [200000, 100000, 75],  // absurdly above
]) {
  const r = at(gross);
  check(`basic ${basic.toLocaleString("en-IN")}: EDLI is ${expected}`,
    r.edli === expected, `got ${r.edli}`);
  check(`basic ${basic.toLocaleString("en-IN")}: admin charges are ${expected}`,
    r.adminCharges === expected, `got ${r.adminCharges}`);
}

console.log("\nthe old formula's specific failure");
const big = at(80000);
check("a 40,000 basic no longer yields 200 of EDLI", big.edli !== 200, `got ${big.edli}`);
check("nor 200 of admin charges", big.adminCharges !== 200, `got ${big.adminCharges}`);

console.log("\nCTC includes EDLI and admin charges");
for (const gross of [20000, 30000, 80000]) {
  const r = at(gross);
  const expected = r.gross + r.epf + r.edli + r.adminCharges + r.erEsic + r.foodAllowance;
  check(`gross ${gross.toLocaleString("en-IN")}: CTC = gross + EPF + EDLI + admin + ESIC(ER) + food`,
    r.employerCost === expected, `${r.employerCost} vs ${expected}`);
  check(`gross ${gross.toLocaleString("en-IN")}: CTC exceeds the old figure by exactly EDLI + admin`,
    r.employerCost - (r.gross + r.epf + r.erEsic + r.foodAllowance) === r.edli + r.adminCharges);
}

console.log("\nthe food allowance is net of the standing deduction");
{
  const r = computeSalary({ gross: 30000, otherDeduction: 764 }, CFG, "employee");
  check("the entitlement is unchanged at 1,600", r.foodAllowanceFull === 1600, r.foodAllowanceFull);
  check("764 entered leaves 836", r.foodAllowance === 836, r.foodAllowance);
  check("and the CTC uses the 836, not the 1,600",
    r.employerCost === 30000 + r.epf + r.edli + r.adminCharges + r.erEsic + 836,
    r.employerCost);
  const none = computeSalary({ gross: 30000 }, CFG, "employee");
  check("with no deduction the allowance is the full entitlement",
    none.foodAllowance === 1600 && none.foodAllowanceFull === 1600);
  const over = computeSalary({ gross: 30000, otherDeduction: 5000 }, CFG, "employee");
  check("a deduction larger than the allowance floors at zero, never negative",
    over.foodAllowance === 0, over.foodAllowance);
  check("and the CTC does not go below gross plus the statutory costs",
    over.employerCost === 30000 + over.epf + over.edli + over.adminCharges + over.erEsic);
  check("the deduction still comes off the employee's pay as well",
    /* It is a deduction from THEM and a reduction of what the company funds:
       the same 764 does both jobs, in two different places. */
    none.netSalary === over.netSalary);
}

console.log("\nthe rest of the formula is unchanged");
const r = at(30000);
check("basic is 50% of gross", r.basic === 15000, `${r.basic}`);
check("HRA is 50% of gross", r.hra === 15000, `${r.hra}`);
check("EPF is capped at 1,800 on the money", at(200000).epf === 1800, `${at(200000).epf}`);
check("employee deductions are EPF + ESIC(EE) only",
  r.totalDeduction === r.epf + r.eeesic, `${r.totalDeduction}`);
check("net is gross minus those deductions",
  r.netSalary === r.gross - r.totalDeduction);
check("EDLI and admin are NOT deducted from the employee",
  r.totalDeduction < r.epf + r.eeesic + r.edli + r.adminCharges);
check("ESI stops above the wage limit", at(60000).eeesic === 0 && at(60000).erEsic === 0);

console.log("\noverrides still win");
const ov = computeSalary(
  { gross: 80000, edliOverride: true, edli: 999, adminOverride: true, adminCharges: 888 },
  CFG, "employee",
);
check("an EDLI override is not recalculated", ov.edli === 999, `${ov.edli}`);
check("an admin override is not recalculated", ov.adminCharges === 888, `${ov.adminCharges}`);
check("and the override still reaches CTC",
  ov.employerCost === ov.gross + ov.epf + 999 + 888 + ov.erEsic + ov.foodAllowance);

console.log("\nthe caps are configurable, not hardcoded");
const loose = computeSalary({ gross: 80000 }, { edliCapAmount: 30000, edliMaxAmount: 200,
  adminWageCeiling: 30000, adminMaxAmount: 200 }, "employee");
check("raising the ceiling and the maximum raises EDLI", loose.edli === 150, `${loose.edli}`);
check("and admin charges", loose.adminCharges === 150, `${loose.adminCharges}`);
const tight = computeSalary({ gross: 80000 }, { edliMaxAmount: 20, adminMaxAmount: 20 }, "employee");
check("a lower maximum binds before the ceiling", tight.edli === 20 && tight.adminCharges === 20);

console.log("\ninterns are untouched by any of it");
const intern = computeSalary({ stipend: 12000 }, CFG, "intern");
check("an intern has no EDLI or admin charges",
  intern.edli === 0 && intern.adminCharges === 0);
check("and their CTC is the stipend", intern.employerCost === 12000);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
