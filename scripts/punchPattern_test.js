"use strict";
// scripts/punchPattern_test.js
//
// A day is measured on two axes, and only one of them is the shift.
//
//   hours       when you are due in and out       -> the shift category
//   punches     how many times you touch the      -> employeeType
//               reader in a day
//
// Both used to be read off the employee's DEPARTMENT, which is what this
// change removes. Core is the 2-punch office day and General the 6-punch
// production one, so the category answers the second axis for them. Custom
// does not: housekeeping on 06:00-14:00 might punch twice or six times, and
// nothing about their hours says which. So HR is asked once, in attendance
// settings, and this proves that answer reaches the classifier.
//
// It matters because getting it wrong is not cosmetic. `hasMissPunch` is
// `punches < expected`, so expecting six from someone who makes two flags
// EVERY ONE of their days for HR to clear by hand.
//
//   node scripts/punchPattern_test.js       (no DB, no network)

const { resolveEmployeeType } = require("../routes/HrRoutes/Attendance_section");

let failures = 0;
function check(label, got, want) {
  const ok = got === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(52)} ${got}${ok ? "" : `  (expected ${want})`}`);
}

// Departments deliberately point the OPPOSITE way from the employee's own
// category, so a test that passes can only be reading the category.
const settings = {
  shifts: { custom: { punchPattern: "office" } },
  departmentCategories: { core: ["HOUSEKEEPING", "HR"], general: ["PRODUCTION"] },
  operatorDesignations: [],
  executiveDesignations: [],
};

console.log("\n=== the category answers it, whatever the department says ===");
check(
  "Core employee sitting in a production department",
  resolveEmployeeType({ workShift: { mode: "core" }, department: "PRODUCTION" }, settings),
  "executive",
);
check(
  "General employee sitting in an office department",
  resolveEmployeeType({ workShift: { mode: "general" }, department: "HR" }, settings),
  "operator",
);

console.log("\n=== Custom takes it from attendance settings ===");
const emp = { workShift: { mode: "custom", start: "06:00", end: "14:00" }, department: "HOUSEKEEPING" };
check("punchPattern office     -> 2-punch day", resolveEmployeeType(emp, settings), "executive");
check(
  "punchPattern production -> 6-punch day",
  resolveEmployeeType(emp, { ...settings, shifts: { custom: { punchPattern: "production" } } }),
  "operator",
);
check(
  "punchPattern unset      -> 2-punch day (the safe default)",
  resolveEmployeeType(emp, { ...settings, shifts: { custom: {} } }),
  "executive",
);

console.log("\n=== an employee the backfill has not reached yet ===");
// No mode at all. The department lists are gone from the settings UI but the
// stored values remain, so these people keep the classification they had
// yesterday rather than silently all becoming office workers.
check(
  "no shift, HOUSEKEEPING is in the core list",
  resolveEmployeeType({ department: "HOUSEKEEPING" }, settings),
  "operator",
);
check(
  "no shift, unlisted department",
  resolveEmployeeType({ department: "NOWHERE" }, settings),
  "executive",
);

console.log(
  failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
);
process.exit(failures === 0 ? 0 : 1);
