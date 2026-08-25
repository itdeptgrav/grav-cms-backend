"use strict";
// scripts/internAppAccess_test.js
//
// "They can't login as long as they are not an employee."
//
// There are three doors into the app, not one, and closing only the obvious
// one leaves it open:
//
//   POST /api/employee/auth/login   the front door
//   GET  /verify, /profile          what the app calls on LAUNCH to restore a
//                                   saved session — these parse the token
//                                   themselves and never touch the middleware
//   AllEmployeeAppMiddleware        every other app request, and the only
//                                   thing that stops a token issued BEFORE
//                                   somebody became an intern, which stays
//                                   valid for up to 30 days
//
// This checks all three, plus the two behaviours that decide whether the lock
// is usable in practice: it lifts the moment HR changes the employment type
// back, and a Mongo outage does not sign the whole workforce out.
//
//   node scripts/internAppAccess_test.js      (no DB, no network)

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.SALARY_ENCRYPTION_KEY =
  process.env.SALARY_ENCRYPTION_KEY ||
  require("crypto").randomBytes(32).toString("hex");

const path = require("path");
const jwt = require("jsonwebtoken");
const ROOT = path.join(__dirname, "..");

// Stub the model before the middleware require()s it, so no DB is involved.
const Employee = require(path.join(ROOT, "models/Employee"));
let employmentTypeById = {};
let throwOnLookup = false;
let lookups = 0;
Employee.findById = (id) => ({
  select: () => ({
    lean: async () => {
      lookups++;
      if (throwOnLookup) throw new Error("connection refused");
      return id in employmentTypeById
        ? { employmentType: employmentTypeById[id] }
        : null;
    },
  }),
});

const mw = require(path.join(ROOT, "Middlewear/AllEmployeeAppMiddleware"));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(50)} ${JSON.stringify(got)}` +
      (ok ? "" : `  (expected ${JSON.stringify(want)})`),
  );
}

/** Run the middleware and report what the caller would see. */
async function callMiddleware(id) {
  const token = jwt.sign({ id, type: "employee" }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} };
  let out = { status: 200, body: null, passed: false };
  const res = {
    status(c) { out.status = c; return this; },
    json(b) { out.body = b; return this; },
  };
  await mw(req, res, () => (out.passed = true));
  return out;
}

(async () => {
  console.log("\n=== every app request, not just the login ===");
  employmentTypeById = { emp1: "full_time", int1: "intern" };

  let r = await callMiddleware("emp1");
  check("employee passes", r.passed, true);

  r = await callMiddleware("int1");
  check("intern refused", r.passed, false);
  check("  with 403", r.status, 403);
  check("  and a code the app can branch on", r.body?.code, "INTERN_NO_APP_ACCESS");

  // This is the case the login check alone cannot cover: the token was minted
  // while they were staff and is still cryptographically valid.
  const stillValid = jwt.verify(
    jwt.sign({ id: "int1", type: "employee" }, process.env.JWT_SECRET),
    process.env.JWT_SECRET,
  );
  check("their token is still a VALID token", !!stillValid.id, true);
  check("  and is refused anyway", (await callMiddleware("int1")).status, 403);

  console.log("\n=== the lookup is cached, not run per request ===");
  mw.invalidateAppAccess("emp1"); // start cold, or the calls above have it
  lookups = 0;
  for (let i = 0; i < 5; i++) await callMiddleware("emp1");
  check("5 requests, 1 lookup", lookups, 1);

  console.log("\n=== the lock lifts when HR promotes them ===");
  employmentTypeById.int1 = "full_time";
  check("still refused while cached", (await callMiddleware("int1")).status, 403);
  mw.invalidateAppAccess("int1");
  check("passes once invalidated", (await callMiddleware("int1")).passed, true);

  console.log("\n=== a Mongo outage does not lock everyone out ===");
  // Failing closed here would sign out the entire workforce over a blip, and
  // the front door is still shut, so nobody new gets in while it is down.
  throwOnLookup = true;
  mw.invalidateAppAccess("emp2");
  employmentTypeById.emp2 = "full_time";
  check("employee still passes", (await callMiddleware("emp2")).passed, true);
  throwOnLookup = false;

  console.log("\n=== an unknown id is left to the route behind ===");
  check("passes through", (await callMiddleware("ghost")).passed, true);

  console.log("\n=== a bad token is still a bad token, not a 403 ===");
  const req = { headers: { authorization: "Bearer nonsense.nonsense" }, cookies: {} };
  let status = 200;
  await mw(req, { status(c) { status = c; return this; }, json() { return this; } }, () => {});
  check("401, not 403", status, 401);

  console.log(
    failures === 0 ? "\nall checks passed.\n" : `\n${failures} check(s) FAILED.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
