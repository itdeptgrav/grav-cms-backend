// verifyLeaveHomeState.js
//
// The monthly leave cap is judged on the PERMANENT address.
//
// Run:  node verifyLeaveHomeState.js      (no database, no network, no writes)
//
// WHY THIS EXISTS
// The cap gives somebody whose home is in another state more days in one go
// than somebody who lives here — 10 against 7. The code read the CURRENT
// address first and fell back to permanent, which inverts the rule for exactly
// the person it was written for: an employee from West Bengal renting a room
// in Bhubaneswar has a current address in Odisha, and was capped at 7.
//
// The rule also existed twice — once in the apply route, once in the mobile
// app's LeaveScreen, which is the number the employee reads before applying.
// The server resolves it now and the app reports what it is told, so the
// screen cannot promise a number the server will refuse.

"use strict";

const fs = require("fs");
const path = require("path");
const {
  resolveLeaveState,
  monthlyLeaveCap,
} = require("./services/leaveHomeState.service");

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`);
  }
};
const head = (t) => console.log(`\n${t}`);

const emp = (permanent, current) => ({
  address: {
    permanent: permanent === null ? {} : { state: permanent },
    current: current === null ? {} : { state: current },
  },
});
const CFG = { maxLeaveDaysPerMonth: 10, maxLeaveDaysPerMonthOdisha: 7 };

// ── the bug this was written for ────────────────────────────────────────────
head("the bug this was written for");
const renter = emp("West Bengal", "Odisha");
check(
  "somebody from West Bengal renting in Bhubaneswar gets 10, not 7",
  monthlyLeaveCap(renter, CFG).cap === 10,
  String(monthlyLeaveCap(renter, CFG).cap),
);
check(
  "and the cap says it read the permanent address",
  monthlyLeaveCap(renter, CFG).source === "permanent",
);
const local = emp("Odisha", "West Bengal");
check(
  "the mirror case — permanent Odisha, posted elsewhere — gets 7",
  monthlyLeaveCap(local, CFG).cap === 7,
  String(monthlyLeaveCap(local, CFG).cap),
);

// ── resolution ──────────────────────────────────────────────────────────────
head("which address is read");
check(
  "permanent wins whenever it has a state",
  resolveLeaveState(emp("Kerala", "Odisha")).state === "kerala",
);
check(
  "a blank permanent falls back to current",
  resolveLeaveState(emp(null, "Odisha")).source === "current" &&
    resolveLeaveState(emp(null, "Odisha")).state === "odisha",
);
check(
  "and the fallback is flagged, so it can be said out loud",
  resolveLeaveState(emp(null, "Odisha")).usedFallback === true,
);
check(
  "a permanent address is not a fallback",
  resolveLeaveState(emp("Odisha", "Odisha")).usedFallback === false,
);
check(
  "neither address leaves the state empty rather than guessing",
  resolveLeaveState(emp(null, null)).state === "" &&
    resolveLeaveState(emp(null, null)).source === "none",
);
check(
  "an employee with no address object at all does not throw",
  resolveLeaveState({}).source === "none" && resolveLeaveState().source === "none",
);

// ── "same as current" ───────────────────────────────────────────────────────
head('"same as current" is a copy, and it still has to be read as permanent');
const same = emp("Odisha", "Odisha");
check("both addresses naming one state is reported as such", resolveLeaveState(same).sameAsCurrent === true);
check("and it is still read as the permanent address", resolveLeaveState(same).source === "permanent");
check("the cap is the same either way", monthlyLeaveCap(same, CFG).cap === 7);
check(
  "different states are not reported as the same",
  resolveLeaveState(emp("Bihar", "Odisha")).sameAsCurrent === false,
);

// ── spelling and whitespace ─────────────────────────────────────────────────
head("how the state is written does not decide somebody's leave");
for (const spelling of ["Odisha", "odisha", "ODISHA", "Orissa", "  Odisha  "]) {
  check(
    `"${spelling}" is the 7-day cap`,
    monthlyLeaveCap(emp(spelling, null), CFG).cap === 7,
  );
}
check(
  "a state nobody configured gets the larger cap",
  monthlyLeaveCap(emp("Tamil Nadu", null), CFG).cap === 10,
);

// ── the config still drives the numbers ─────────────────────────────────────
head("the numbers are settings, not constants");
const CUSTOM = { maxLeaveDaysPerMonth: 12, maxLeaveDaysPerMonthOdisha: 5 };
check("a raised non-home cap is used", monthlyLeaveCap(emp("Assam", null), CUSTOM).cap === 12);
check("and a lowered home cap", monthlyLeaveCap(emp("Odisha", null), CUSTOM).cap === 5);
check(
  "an empty config falls back to 10 and 7",
  monthlyLeaveCap(emp("Assam", null), {}).cap === 10 &&
    monthlyLeaveCap(emp("Odisha", null), {}).cap === 7,
);

// ── one copy of the rule ────────────────────────────────────────────────────
head("the rule is in one place");
const ROUTE = fs.readFileSync(
  path.join(__dirname, "routes", "Employee_Routes", "leaveRoutes.js"), "utf8",
);
check(
  "the apply route calls monthlyLeaveCap",
  /monthlyLeaveCap\(emp, config\)/.test(ROUTE),
);
check(
  "and has no Odisha test of its own left",
  !/\["odisha", "orissa"\]/.test(ROUTE),
  "a second copy of the rule is a second answer",
);
check(
  "it no longer reads the current address first",
  !/address\?\.current\?\.state \|\|\s*\n?\s*emp\.address\?\.permanent/.test(ROUTE),
);
check(
  "/balance selects the address it needs to resolve the cap",
  /\.select\("biometricId dateOfJoining address"\)/.test(ROUTE),
  "without this the resolved cap is computed on an absent address",
);
check(
  "/balance returns the resolved cap and which address it came from",
  /monthlyCap: \(\(\) => \{/.test(ROUTE) && /usedFallback: c\.usedFallback/.test(ROUTE),
);

// ── the screen the employee reads ───────────────────────────────────────────
head("the app reports the cap rather than deciding it");
const SCREEN = path.join(__dirname, "..", "App", "src", "screens", "LeaveScreen.js");
if (!fs.existsSync(SCREEN)) {
  check("the leave screen is where this expects it", false, SCREEN);
} else {
  const src = fs.readFileSync(SCREEN, "utf8");
  check(
    "it takes the cap from the server when there is one",
    /const serverCap = balance\?\.monthlyCap/.test(src) &&
      /Number\(serverCap\?\.days\) > 0/.test(src),
  );
  check(
    "its offline fallback reads PERMANENT first, like the server",
    /user\?\.address\?\.permanent\?\.state \|\|\s*\n\s*user\?\.address\?\.current\?\.state/.test(src),
    "a fallback that disagrees is the same bug with extra steps",
  );
  check(
    "a cap computed off the current address is shown to the employee",
    /capFromCurrentOnly/.test(src) && /no permanent address is on record/.test(src),
  );
  check(
    "the PL row shows the monthly bound it is actually limited by",
    /avail · \$\{num\(monthlyRemaining\)\}\/\$\{monthlyCap\} mo/.test(src),
  );
}

// ── the copy that feeds it ──────────────────────────────────────────────────
head('"same as current" must not go stale');
const FORM = path.join(
  __dirname, "..", "grav-cms",
  "app", "hr", "dashboard", "employees", "new-employee", "components", "EmployeeForm.js",
);
if (!fs.existsSync(FORM)) {
  check("the employee form is where this expects it", false, FORM);
} else {
  const src = fs.readFileSync(FORM, "utf8");
  check(
    "the form has a table of the fields permanent mirrors",
    /const MIRRORED_ADDRESS = \{/.test(src),
  );
  check(
    "it is at module scope, so the dependency-free setField sees it",
    /^const MIRRORED_ADDRESS = \{/m.test(src),
  );
  check(
    "editing a current field while the box is ticked updates permanent",
    /const mirror = MIRRORED_ADDRESS\[key\];\s*\n\s*if \(mirror && prev\.sameAsCurrent\) next\[mirror\] = value;/.test(
      src,
    ),
    "otherwise the copy is whatever was typed at the moment the box was ticked",
  );
  const mirrored = (src.match(/current(Street|City|State|Pincode|Country): "permanent/g) || []).length;
  check(
    "all five address fields are mirrored, not just the state",
    mirrored === 5,
    `${mirrored} of 5`,
  );
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
