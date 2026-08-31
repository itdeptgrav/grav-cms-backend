// verifyAuditFloor.js
//
// What the audit floor will and will not record.
//
// Run:  node verifyAuditFloor.js
//
// READS AND WRITES NOTHING. Every decision the floor makes before it reaches
// the database is decidable from the path, the method and the response status,
// so this pins the reported cases without touching Mongo or Drive.
//
// The cases below are the ones that actually went wrong: a GSTIN verification
// fired on blur showed up as "Created company", and unmapped accountant writes
// showed up as "Created record" — entries that were true, useless, and
// impossible to attribute to a page.

"use strict";

const { READ_SHAPED } = require("./Middlewear/departmentWriteGuard");
const { actionFor, fieldsFromBody } = require("./Middlewear/auditTrail");
const { sectionForPath } = require("./services/auditSections");

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

const isReadShaped = (p) =>
  READ_SHAPED.some((f) => String(p).toLowerCase().split("?")[0].includes(f));

/** The floor records a write only when it is not read-shaped AND it maps to a
 *  section. Mirrors Middlewear/auditTrail.js — see the note there. */
const wouldRecord = (path) => !isReadShaped(path) && Boolean(sectionForPath(path)?.section);

console.log("\nthings that are not changes, and must not be recorded");
check(
  "GSTIN/PAN verification (fires on blur while typing)",
  !wouldRecord("/api/accountant/tally/companies/verify"),
);
check("sidebar pins", !wouldRecord("/api/accountant/pins"));
check("saved priorities / nav preferences", !wouldRecord("/api/accountant/priorities"));
check("a search", !wouldRecord("/api/accountant/invoices/search"));
check("an export", !wouldRecord("/api/hr/leaves/export"));
check("a PDF render", !wouldRecord("/api/accountant/invoices/9/pdf"));
check("a connector status probe", !wouldRecord("/api/accountant/setu/status"));

console.log("\nthings that ARE changes, and must still be recorded");
check("creating a company", wouldRecord("/api/accountant/tally/companies"));
check("editing a company", wouldRecord("/api/accountant/tally/companies/68f0a1b2c3d4e5f60718293a"));
check("a voucher", wouldRecord("/api/accountant/vouchers"));
check("a journal entry", wouldRecord("/api/accountant/journal-entries"));
check("an HR leave approval", wouldRecord("/api/hr/leaves/9/approve"));
check("an attendance override", wouldRecord("/hr/attendance/day-override"));
check("an employee edit", wouldRecord("/api/employees/68f0a1b2c3d4e5f60718293a"));

console.log("\nwhat kind of change it says it is");
check(
  "a plain collection POST is a create",
  actionFor({ method: "POST" }, "/api/accountant/tally/companies") === "create",
);
check(
  "a POST to /<id>/<verb> is an update, not a create",
  actionFor({ method: "POST" }, "/api/accountant/vouchers/68f0a1b2c3d4e5f60718293a/post") ===
    "update",
);
check(
  "an approve reads as an approval",
  actionFor({ method: "POST" }, "/api/hr/leaves/68f0a1b2c3d4e5f60718293a/approve") === "approve",
);
check(
  "a DELETE reads as a delete",
  actionFor({ method: "DELETE" }, "/api/accountant/tally/companies/68f0a1b2c3d4e5f60718293a") ===
    "delete",
);

console.log("\nwhat it says changed");
check(
  "request bookkeeping is not reported as edited fields",
  !fieldsFromBody({ page: 2, limit: 50, companyName: "Acme" }).some((f) =>
    ["page", "limit"].includes(f.path),
  ),
);
check(
  "a real field is reported",
  fieldsFromBody({ companyName: "Acme" }).some((f) => f.path === "companyName"),
);
check(
  "an array is summarised, not exploded into a hundred rows",
  fieldsFromBody({ rows: [1, 2, 3] }).find((f) => f.path === "rows")?.to === "3 items",
);
check(
  "the floor never claims to know a previous value it cannot see",
  fieldsFromBody({ companyName: "Acme" }).every((f) => f.from === undefined),
);

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
