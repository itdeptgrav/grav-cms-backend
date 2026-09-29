// verifyInactiveLockout.js
//
// Somebody who no longer works here cannot get in, and cannot stay in.
//
// Run:  node verifyInactiveLockout.js      (no database, no network, no writes)
//
// WHAT WAS WRONG
// The question "is this person still employed?" was answered in four places,
// each slightly differently, and in one place it was never asked:
//
//   · the app's login query used `$or: [{status:"active"},{isActive:true}]`.
//     An OR needs only ONE of the two fields to still say "active", so a
//     half-written record let a former employee straight back in. HR's delete
//     writes both, which is the only reason it held.
//
//   · AllEmployeeAppMiddleware checked employment TYPE (interns) and never
//     employment STATUS. A token already issued therefore kept working for its
//     full 30 days — somebody let go on the 1st still had the app on the 30th.
//
//   · deptAuth and canonicalIdentity both tested the literal string
//     "inactive", so an employee marked "terminated" or "resigned" — words
//     `status` accepts, since it has no enum — signed in normally.
//
//   · the website's change-password path checked nothing at all.

"use strict";

const fs = require("fs");
const path = require("path");
const {
  isEmployed,
  EMPLOYED_QUERY,
  INACTIVE_REFUSAL,
  NOT_EMPLOYED_STATUSES,
} = require("./services/employmentStatus");

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};
const head = (t) => console.log(`\n${t}`);

const read = (...p) =>
  fs.readFileSync(path.join(__dirname, ...p), "utf8").split("\r\n").join("\n");

// ── the rule ────────────────────────────────────────────────────────────────
head("either field saying they have left is enough");
check("isActive false", isEmployed({ isActive: false, status: "active" }) === false);
check('status "inactive"', isEmployed({ isActive: true, status: "inactive" }) === false);
check(
  "HR's delete writes both, and both say no",
  isEmployed({ isActive: false, status: "inactive" }) === false,
);
check(
  "a current employee passes",
  isEmployed({ isActive: true, status: "active" }) === true,
);

head("the words HR actually uses, not just one of them");
for (const word of ["terminated", "resigned", "left", "separated", "suspended"]) {
  check(`"${word}" is not employed`, isEmployed({ status: word }) === false);
}
check(
  "and case or padding does not matter",
  isEmployed({ status: "  TERMINATED " }) === false &&
    isEmployed({ status: "Inactive" }) === false,
);

head("what must NOT be treated as a refusal");
check("an unknown id passes (the route behind says 'not found')", isEmployed(null) === true);
check("undefined passes", isEmployed(undefined) === true);
check(
  "a record predating both fields passes",
  isEmployed({ firstName: "Old" }) === true,
);
check(
  "an unrecognised status word passes rather than locking somebody out",
  isEmployed({ status: "probation" }) === true &&
    isEmployed({ status: "on_leave" }) === true,
);

head("the query form asks the same question");
check(
  "it excludes, rather than requiring 'active'",
  EMPLOYED_QUERY.isActive.$ne === false &&
    Array.isArray(EMPLOYED_QUERY.status.$nin),
);
check(
  "and lists every word the predicate knows",
  EMPLOYED_QUERY.status.$nin.length === NOT_EMPLOYED_STATUSES.size &&
    EMPLOYED_QUERY.status.$nin.every((w) => NOT_EMPLOYED_STATUSES.has(w)),
);

head("the refusal says what happened");
check("it is a 401-shaped body with a code", INACTIVE_REFUSAL.code === "EMPLOYEE_INACTIVE");
check(
  "and the sentence names the reason",
  /login has expired/i.test(INACTIVE_REFUSAL.message) &&
    /contact hr/i.test(INACTIVE_REFUSAL.message),
  INACTIVE_REFUSAL.message,
);

// ── every door ──────────────────────────────────────────────────────────────
head("the app: a token stops working the moment they are deactivated");
const MW = read("Middlewear", "AllEmployeeAppMiddleware.js");
check(
  "the middleware reads employment status, not only type",
  /isEmployed/.test(MW) && /EMPLOYMENT_SELECT/.test(MW),
  "without this a live token lasts its full 30 days",
);
check(
  "and refuses with the shared refusal",
  /INACTIVE_REFUSAL/.test(MW),
);
check(
  "the intern lock is still there beside it",
  /INTERN_NO_APP_ACCESS/.test(MW),
);
check(
  "a Mongo failure still lets the workforce through",
  /return \{ allowed: true \};/.test(MW),
  "signing everybody out over an infrastructure blip is the worse failure",
);

const HR = read("routes", "HrRoutes", "Employee-Section.js");
check(
  "deactivating in HR drops the cached decision at once",
  /invalidateAppAccess\(req\.params\.id\)/.test(HR),
  "otherwise the lock waits up to five minutes",
);
check(
  "and HR writes both fields",
  /isActive: false,\s*\n\s*status: "inactive",/.test(HR),
);

head("the app: they cannot sign in again either");
const LOGIN = read("routes", "Employee_Routes", "login.js");
check(
  "the login query uses EMPLOYED_QUERY",
  /\.\.\.EMPLOYED_QUERY,/.test(LOGIN),
);
check(
  "the OR that only worked by luck is gone",
  !/\$or: \[\{ status: "active" \}, \{ isActive: true \}\]/.test(LOGIN),
);

head("the website: sign-in, every session check, and the password path");
const IDENT = read("services", "access", "canonicalIdentity.service.js");
check(
  "sign-in uses the shared rule",
  /const employeeActive = \(e\) => Boolean\(e\) && isEmployed\(e\);/.test(IDENT),
);
const DEPT = read("routes", "auth", "deptAuth.js");
const guards = (DEPT.match(/refuseIfNotEmployed\(res, employee\)/g) || []).length;
check(
  `all four employee session paths are guarded (${guards})`,
  guards === 4,
  "three checked a literal string; the change-password path checked nothing",
);
check(
  "no literal status comparison is left in deptAuth",
  !/employee\.status === "inactive"/.test(DEPT),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
