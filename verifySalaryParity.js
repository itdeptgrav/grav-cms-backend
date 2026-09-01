// verifySalaryParity.js
//
// The employee form's live preview agrees with the server's formula.
//
// Run:  node verifySalaryParity.js        (no database, no network, no writes)
//
// WHY THIS EXISTS
// The salary formula was written out THREE times: the route, the Employee
// pre-save hook, and — client-side — `calcSalary` in EmployeeForm.js, which is
// what HR actually watches update as they type. The first two are now one
// module. The third cannot be: it has to run in the browser before anything is
// saved, and this repo ships no shared package between the two codebases.
//
// So it stays a mirror, and this makes the mirror's accuracy checkable. It
// reads the client source and evaluates its arithmetic against the server's
// for the same inputs. It caught nothing on the day it was written — it exists
// because the CTC line had already drifted once, silently, and the symptom was
// a number on a form that nobody could trace back to a rule.

"use strict";

const fs = require("fs");
const path = require("path");
const { computeSalary } = require("./services/salaryFormula");

const FORM = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "employees", "new-employee", "components", "EmployeeForm.js",
);

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

console.log("");
if (!fs.existsSync(FORM)) {
  check("the employee form is where this expects it", false, FORM);
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(1);
}
const src = fs.readFileSync(FORM, "utf8");

/* Lift `calcSalary`'s body out of the component and run it in isolation. It
   closes over `salaryConfig` only, which is injected below. */
const start = src.indexOf("const calcSalary = (gross, manual = {}) => {");
check("calcSalary was found in the form", start !== -1);
if (start === -1) { console.log(`\n${pass} passed, ${fail} failed\n`); process.exit(1); }

/* Scan from the arrow's brace, not the first brace after `start` -- that one
   belongs to the `manual = {}` default parameter. */
const bodyStart = src.indexOf("=> {", start) + 3;
let depth = 0, i = bodyStart, end = -1;
for (; i < src.length; i += 1) {
  if (src[i] === "{") depth += 1;
  else if (src[i] === "}") { depth -= 1; if (depth === 0) { end = i + 1; break; } }
}
const body = "(gross, manual = {}) => " + src.slice(bodyStart, end);
// eslint-disable-next-line no-new-func
const makeClientCalc = new Function("salaryConfig", `return ${body};`);

console.log("\nthe form's preview matches the server, figure for figure");
const CONFIGS = [
  ["statutory defaults", {}],
  ["a raised EDLI ceiling", { edliCapAmount: 30000, edliMaxAmount: 200, adminWageCeiling: 30000, adminMaxAmount: 200 }],
  ["a tighter maximum", { edliMaxAmount: 20, adminMaxAmount: 20 }],
  ["a different basic split", { basicPct: 60, hraPct: 40 }],
];
const GROSSES = [12000, 20000, 30000, 45000, 80000, 200000];
const FIELDS = ["basic", "hra", "epf", "edli", "adminCharges", "eeesic", "erEsic", "employerCost", "totalDeduction", "netSalary"];

for (const [label, cfg] of CONFIGS) {
  const clientCalc = makeClientCalc(cfg);
  let mismatches = [];
  for (const gross of GROSSES) {
    const client = clientCalc(gross, {});
    const server = computeSalary({ gross }, cfg, "employee");
    for (const f of FIELDS) {
      const c = Number(client[f]);
      const s = Number(server[f]);
      if (c !== s) mismatches.push(`${gross}/${f}: form ${c} vs server ${s}`);
    }
  }
  check(`${label}: every figure agrees across ${GROSSES.length} salaries`,
    mismatches.length === 0, mismatches.slice(0, 4).join("; "));
}

console.log("\nand the two rules that were wrong agree specifically");
const c = makeClientCalc({});
const big = c(80000, {});
check("the form caps EDLI at 75 on a 40,000 basic", Number(big.edli) === 75, big.edli);
check("the form caps admin charges at 75", Number(big.adminCharges) === 75, big.adminCharges);
check("the form's CTC includes both",
  Number(big.employerCost) ===
    Number(big.gross ?? 80000) + Number(big.epf) + Number(big.edli) +
    Number(big.adminCharges) + Number(big.erEsic) + Number(big.foodAllowance),
  `${big.employerCost}`);

console.log("\noverrides behave the same on both sides");
const ovClient = c(80000, { edliOverride: true, edli: 999, adminOverride: true, adminCharges: 888 });
const ovServer = computeSalary(
  { gross: 80000, edliOverride: true, edli: 999, adminOverride: true, adminCharges: 888 }, {}, "employee");
check("an overridden EDLI is kept by both",
  Number(ovClient.edli) === 999 && ovServer.edli === 999);
check("and both carry it into CTC identically",
  Number(ovClient.employerCost) === ovServer.employerCost,
  `${ovClient.employerCost} vs ${ovServer.employerCost}`);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
