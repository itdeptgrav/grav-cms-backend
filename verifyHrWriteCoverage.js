// verifyHrWriteCoverage.js
//
// EVERY write in HR either goes to an approver or is deliberately exempt.
//
// Run:  node -r dotenv/config verifyHrWriteCoverage.js
//
// Read-only. It touches no data at all: it loads each HR router, walks its
// route table, and asks the REAL guard logic — the same READ_SHAPED list and
// the same exempt list server.js passes — what would happen to each path.
//
// The question it answers is the one a screenshot cannot: not "did this edit
// get held" but "is there a write anywhere in HR that quietly does not".

"use strict";

const path = require("path");

const departmentWrites = require("./Middlewear/departmentWriteGuard");
const { READ_SHAPED } = departmentWrites;

/* The exempt list from server.js. If these two drift, this harness is lying —
   so it is asserted against the file rather than retyped from memory. */
const EXEMPT = [
  "/api/hr/profile",
  "/api/hr/change-password",
  "/change-history",
  "/import-export",
  "/sync-period",
  "/backfill",
  "/day-range",
  "/notification-",
];

/* Every HR router, with the prefix server.js mounts it on. Kept in this shape
   so a router added to server.js and not here shows up as a gap below. */
const MOUNTS = [
  ["/api/employees", "./routes/HrRoutes/Employee-Section"],
  ["/api/employees/import-export", "./routes/HrRoutes/employeeImportExport"],
  ["/api/hr/overview", "./routes/HrRoutes/Overview-Section"],
  ["/hr/performance", "./routes/HrRoutes/Performance_section"],
  ["/api/hr", "./routes/HrRoutes/HrProfile-Section"],
  ["/api/hr/departments", "./routes/HrRoutes/Departments"],
  ["/api/hr/job-postings", "./routes/HrRoutes/JobPosting_Section"],
  ["/api/hr/candidates", "./routes/HrRoutes/Candidates_section"],
  ["/api/hr/tasks", "./routes/HrRoutes/EmployeeTasks_section"],
  ["/api/hr/payroll", "./routes/HrRoutes/Payroll_section"],
  ["/hr/attendance", "./routes/HrRoutes/Attendance_section"],
  ["/hr/shift-swaps", "./routes/HrRoutes/ShiftSwap_section"],
  ["/hr/face-registration", "./routes/HrRoutes/FaceRegistration_section"],
  ["/api/hr/leaves", "./routes/HrRoutes/Leave_section"],
  ["/api/hr/policy", "./routes/HrRoutes/policyRoutes"],
  ["/api/hr/sop", "./routes/HrRoutes/hrSopRoutes"],
  ["/api/hr/documents", "./routes/HrRoutes/EmployeeDocuments_section"],
  ["/hr/reports", "./routes/HrRoutes/Reports_section"],
  ["/api/hr/password-management", "./routes/HrRoutes/Passwordmanagement"],
  ["/api/hr/payslip", "./routes/HrRoutes/Payslip_section"],
];

const WRITE_METHODS = new Set(["post", "put", "patch", "delete"]);

function isReadShaped(p) {
  const low = String(p).toLowerCase().split("?")[0];
  return READ_SHAPED.some((frag) => low.includes(frag));
}
function isExempt(p) {
  const low = String(p).toLowerCase();
  return EXEMPT.some((frag) => low.includes(frag.toLowerCase()));
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

/* ------------------------------------------------------------------ */

console.log("\nthe guard is mounted where server.js says it is");

const server = require("fs").readFileSync(path.join(__dirname, "server.js"), "utf8");
for (const p of ["/api/hr", "/hr", "/api/employees"]) {
  check(
    `hrWrites covers ${p}`,
    new RegExp(`app\\.use\\("${p.replace(/\//g, "\\/")}", hrWrites\\)`).test(server),
  );
}
// The exempt list here must be the one actually passed, or every verdict below
// is about a guard that does not exist.
for (const frag of EXEMPT) {
  check(`the real mount exempts ${frag}`, server.includes(`"${frag}"`), "not found in server.js");
}

/* ------------------------------------------------------------------ */

const held = [];
const exemptHits = [];
const readShaped = [];
let routersLoaded = 0;

for (const [prefix, mod] of MOUNTS) {
  let router;
  try {
    router = require(mod);
    routersLoaded += 1;
  } catch (err) {
    console.log(`  FAIL  could not load ${mod} — ${err.message}`);
    fail += 1;
    continue;
  }
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods)) {
      if (!WRITE_METHODS.has(method)) continue;
      const full = prefix + (layer.route.path === "/" ? "" : layer.route.path);
      const row = { method: method.toUpperCase(), full };
      if (isReadShaped(full)) readShaped.push(row);
      else if (isExempt(full)) exemptHits.push(row);
      else held.push(row);
    }
  }
}

console.log(`\nwalked ${routersLoaded} HR routers`);
console.log(`  ${held.length} writes go to the approver`);
console.log(`  ${exemptHits.length} exempt by name`);
console.log(`  ${readShaped.length} read-shaped (search / export / report …)`);

/* ------------------------------------------------------------------ */

console.log("\nthe edits somebody actually makes are held");

// Named explicitly rather than counted: a count passes while the one route
// that matters is missing.
const MUST_BE_HELD = [
  ["PUT", "/api/employees/:id", "editing an employee"],
  ["DELETE", "/api/employees/:id", "removing an employee"],
  ["POST", "/api/employees", "adding an employee"],
  ["POST", "/api/hr/departments", "adding a department"],
  ["PUT", "/api/hr/leaves", "a leave decision"],
  ["POST", "/api/hr/documents", "issuing a document"],
];
for (const [method, prefix, label] of MUST_BE_HELD) {
  const hit = held.some((r) => r.method === method && r.full.startsWith(prefix.split("/:")[0]) && r.method === method);
  check(`${label} (${method} ${prefix})`, hit);
}

console.log("\nATTENDANCE — every edit, not just some");
const attendance = [...held, ...exemptHits, ...readShaped].filter((r) =>
  r.full.startsWith("/hr/attendance"),
);
const attHeld = attendance.filter((r) => held.includes(r));
const attExempt = attendance.filter((r) => exemptHits.includes(r));

check("attendance has writes at all", attendance.length > 0, String(attendance.length));
check(
  "and they are held, not silently exempt",
  attHeld.length > 0,
  `${attHeld.length} held of ${attendance.length}`,
);
console.log(`        ${attHeld.length} held · ${attExempt.length} exempt · ${attendance.length - attHeld.length - attExempt.length} read-shaped`);
for (const r of attHeld) console.log(`          held    ${r.method} ${r.full}`);
for (const r of attExempt) console.log(`          exempt  ${r.method} ${r.full}`);

// Only machine operations may be exempt here. A human's correction must not be.
const SUSPECT = attExempt.filter(
  (r) => !/sync-period|backfill|day-range|notification-/.test(r.full),
);
check(
  "no human-facing attendance edit is exempt",
  SUSPECT.length === 0,
  SUSPECT.map((r) => `${r.method} ${r.full}`).join(", "),
);

console.log("");
console.log("two administrative writes a bare-word exemption let through");
// Both were exempt until 31 Aug 2026 because "/profile" and "/change-password"
// are substrings of them. Named individually so shortening the exempt list
// again fails here rather than in production.
for (const [method, p, label] of [
  ["PATCH", "/api/employees/:id/profile-photo", "HR changing another person's photo"],
  ["PATCH", "/api/hr/password-management/change-password/:userType/:id", "HR resetting another person's password"],
]) {
  check(
    `${label} is HELD`,
    held.some((r) => r.method === method && r.full === p),
    exemptHits.some((r) => r.full === p) ? "still exempt" : "route not found",
  );
}

console.log("\nnothing is exempt by accident");
for (const r of exemptHits) {
  const why = EXEMPT.find((f) => r.full.toLowerCase().includes(f.toLowerCase()));
  console.log(`        ${r.method.padEnd(6)} ${r.full}  →  ${why}`);
}
check(
  "every exemption traces to a listed fragment",
  exemptHits.every((r) => EXEMPT.some((f) => r.full.toLowerCase().includes(f.toLowerCase()))),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
