"use strict";
// scripts/internModel_test.js
//
// An intern is an Employee with employmentType "intern" and a stipend, and the
// pre-save hook is where that has to be enforced. The hook rewrites
// this.salary WHOLESALE from a computed object, so anything it forgets to
// name is silently dropped — and anything it names for the wrong employment
// type is silently invented.
//
// Two directions, both of which would be quiet money bugs:
//
//   employee -> intern   must lose the basic, HRA, EPF and ESI from their old
//                        contract. Leaving them would put an EPF deduction on
//                        an intern's payslip for a fund they are not in.
//   intern -> employee   must lose the stipend. Leaving it beside a real gross
//                        is a second pay figure nobody reconciles.
//
//   node scripts/internModel_test.js        (no DB, no network)

process.env.SALARY_ENCRYPTION_KEY =
  process.env.SALARY_ENCRYPTION_KEY ||
  require("crypto").randomBytes(32).toString("hex");

const path = require("path");
const ROOT = path.join(__dirname, "..");
const {
  decryptSalaryFields,
  encryptSalaryFields,
  SALARY_NUM_FIELDS,
} = require(path.join(ROOT, "utils/salaryEncryption"));
const Employee = require(path.join(ROOT, "models/Employee"));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

console.log("\n=== the stipend is treated as pay, not metadata ===");
check("in the encrypted field list", SALARY_NUM_FIELDS.includes("stipend"), true);
const enc = encryptSalaryFields({ stipend: 12000 });
check("stored as ciphertext", String(enc.stipend).startsWith("enc:"), true);
check("round-trips", decryptSalaryFields(enc).stipend, 12000);

console.log("\n=== the schema knows what an intern is ===");
for (const p of [
  "workPhone",
  "internship.stipendType",
  "internship.startDate",
  "internship.endDate",
  "salary.stipend",
]) {
  check(p, Employee.schema.paths[p]?.instance || "MISSING", Employee.schema.paths[p]?.instance);
  if (!Employee.schema.paths[p]) failures++;
}
const bad = new Employee({
  firstName: "T", lastName: "U", phone: "9999999999",
  employmentType: "intern", internship: { stipendType: "nonsense" },
});
check(
  'stipendType "nonsense" rejected',
  !!bad.validateSync()?.errors?.["internship.stipendType"],
  true,
);

// The hook is async and reads SalaryConfig from Mongo for the employee path,
// so only the intern branch — which reads nothing — can run without a DB.
console.log("\n=== employee -> intern drops the statutory components ===");
// Picked by looking for our own source, not by position: mongoose registers
// its own pre-save plugins around ours and their order is not ours to rely on.
const hook = Employee.schema.s.hooks._pres
  .get("save")
  .find((h) => /employmentType === "intern"/.test(h.fn.toString()));
if (!hook) {
  console.error("  FAIL  could not find the salary pre-save hook");
  process.exit(1);
}
const asIntern = {
  employmentType: "intern",
  salary: encryptSalaryFields({
    stipend: 15000,
    gross: 40000, basic: 20000, hra: 20000,
    epf: 1800, eeesic: 150, erEsic: 650, netSalary: 38050,
  }),
  updatedAt: null,
};
let hookErr = "never called";
hook.fn.call(asIntern, (e) => (hookErr = e ? e.message : null));
setTimeout(() => {
  check("hook ran clean", hookErr, null);
  const out = decryptSalaryFields(asIntern.salary);
  check("stipend kept", out.stipend, 15000);
  check("gross zeroed", out.gross, 0);
  check("basic zeroed", out.basic, 0);
  check("hra zeroed", out.hra, 0);
  check("epf zeroed", out.epf, 0);
  check("employee ESI zeroed", out.eeesic, 0);
  check("employer ESI zeroed", out.erEsic, 0);
  check("net pay is the stipend", out.netSalary, 15000);
  check("nothing deducted", out.totalDeduction, 0);
  console.log(
    failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}, 50);
