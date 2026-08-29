// verifyHrChangeHistory.js
//
// End-to-end check of the HR change-history spine, against the dev database.
//
// Run:  node -r dotenv/config verifyHrChangeHistory.js
//
// WRITES AND THEN DELETES its own rows in `change_logs`. Every row it creates
// carries entity "verify-harness", and the cleanup deletes exactly that — it
// never touches a real entry, and it reports what it deleted so a partial run
// can be cleaned by hand. Nothing else in the database is read or written.

"use strict";

const mongoose = require("mongoose");

const ChangeLog = require("./models/Access/ChangeLog");
const { recordChange, listChanges, fieldDiff } = require("./services/changeLog");
const { fieldLabel, sectionForPath, sectionsFor } = require("./services/auditSections");

const ENTITY = "verify-harness";
const SECTION = "hr:employees";

let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** A stand-in for an Express request: the actor, and nothing else. */
function reqAs(name, email, headers = {}) {
  return {
    user: { name, email, role: "hr_manager", id: "000000000000000000000001" },
    method: "PUT",
    originalUrl: "/api/employees/68f0a1b2c3d4e5f60718293a",
    headers,
  };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  console.log("pure functions");
  check("fieldLabel maps a known field", fieldLabel(SECTION, "grossPay") === "Gross salary");
  check(
    "fieldLabel reaches a nested leaf",
    fieldLabel("hr:attendance-daily", "rawPunches.1.inTime") === "In time",
  );
  check(
    "fieldLabel de-camel-cases an unknown one",
    fieldLabel(SECTION, "someUnknownThing") === "Some unknown thing",
  );
  check(
    "sectionForPath picks the specific route over the general",
    sectionForPath("/hr/attendance/shifts/9")?.section === "hr:attendance-shifts" &&
      sectionForPath("/hr/attendance/daily")?.section === "hr:attendance-daily",
  );
  check("HR has a section vocabulary", sectionsFor("hr").length > 20);

  const deep = fieldDiff(
    { name: "A", pay: 100, nested: { a: 1, b: 2 }, list: [{ t: "09:00" }] },
    { name: "A", pay: 200, nested: { a: 1, b: 3 }, list: [{ t: "09:14" }] },
  );
  check("deep diff ignores unchanged fields", !deep.some((d) => d.path === "name"));
  check("deep diff reaches into objects", deep.some((d) => d.path === "nested.b"));
  check("deep diff reaches into arrays", deep.some((d) => d.path === "list.0.t"));
  check(
    "deep diff treats a number and its string as equal",
    fieldDiff({ n: 5 }, { n: "5" }).length === 0,
  );
  check(
    "deep diff treats a Date and its ISO string as equal",
    fieldDiff({ d: new Date("2026-08-30T00:00:00Z") }, { d: "2026-08-30T00:00:00.000Z" }).length === 0,
  );

  console.log("\nrecording");
  const direct = await recordChange(reqAs("Priya Nair", "priya@grav.in"), {
    departmentSlug: "hr",
    section: SECTION,
    entity: ENTITY,
    entityId: "harness-1",
    entityLabel: "Harness employee",
    action: "update",
    before: { grossPay: 25000, designation: "Tailor", password: "hunter2" },
    after: { grossPay: 30000, designation: "Senior tailor", password: "hunter3" },
  });
  check("a direct change is recorded", Boolean(direct));
  check("the section is stored", direct?.section === SECTION);
  check("the section label is resolved", direct?.sectionLabel === "Employees");
  check("origin defaults to direct", direct?.origin === "direct");
  check("the actor is denormalised", direct?.actorName === "Priya Nair");
  // Three, not two: the password changed as well, and the point of the next
  // check is that it is REPORTED as having changed while its values are not.
  check(
    "per-field detail is written for every changed field",
    (direct?.fields || []).length === 3,
    `fields=${JSON.stringify(direct?.fields?.map((f) => f.path))}`,
  );
  check(
    "fields carry screen labels",
    direct?.fields?.some((f) => f.label === "Gross salary"),
  );
  const pw = direct?.fields?.find((f) => f.path === "password");
  check(
    "a password is redacted in the per-field detail too",
    pw && pw.from === "[redacted]" && pw.to === "[redacted]",
    JSON.stringify(pw),
  );
  check(
    "the summary never prints a redacted value",
    !/hunter/.test(direct?.summary || ""),
    direct?.summary,
  );
  check(
    "the summary is written from the diff",
    /Gross salary 25000 → 30000/.test(direct?.summary || ""),
    direct?.summary,
  );
  check(
    "a password is redacted in the patch",
    direct?.after?.password === "[redacted]",
    JSON.stringify(direct?.after),
  );

  const noop = await recordChange(reqAs("Priya Nair", "priya@grav.in"), {
    departmentSlug: "hr",
    section: SECTION,
    entity: ENTITY,
    entityId: "harness-1",
    action: "update",
    before: { grossPay: 30000 },
    after: { grossPay: 30000 },
  });
  check("an update that changed nothing is not recorded", noop === null);

  // The approval path: the change is made BY the editor and carries the
  // approver from the headers the loopback replay sets.
  const approved = await recordChange(
    reqAs("Rahul Das", "rahul@grav.in", {
      "x-grav-change-request": "68f0a1b2c3d4e5f607182999",
      "x-grav-approver-name": "Priya Nair",
      "x-grav-approver-email": "priya@grav.in",
      "x-grav-decision-note": "Agreed at the Monday review.",
    }),
    {
      departmentSlug: "hr",
      section: SECTION,
      entity: ENTITY,
      entityId: "harness-2",
      entityLabel: "Harness employee two",
      action: "update",
      before: { designation: "Cutter" },
      after: { designation: "Senior cutter" },
    },
  );
  check("an approved replay is recorded", Boolean(approved));
  check("origin flips to approval without being told", approved?.origin === "approval");
  check("the editor stays the actor", approved?.actorName === "Rahul Das");
  check("the approver is recorded separately", approved?.approvedByName === "Priya Nair");
  check("the decision note travels", approved?.decisionNote === "Agreed at the Monday review.");
  check(
    "actor and approver are different people",
    approved?.actorEmail !== approved?.approvedByEmail,
  );

  // The bug this section pins: the employee update route used to diff a
  // hand-picked list of nine fields, so editing anything else produced an entry
  // that said "Updated employee X" and listed nothing at all.
  console.log("\nan edit outside the old nine-field whitelist");
  const offList = await recordChange(reqAs("Priya Nair", "priya@grav.in"), {
    departmentSlug: "hr",
    section: SECTION,
    entity: ENTITY,
    entityId: "harness-3",
    entityLabel: "KRISHNA BEHERA",
    action: "update",
    before: {
      firstName: "KRISHNA",
      address: { line1: "12 MG Road", city: "Bhubaneswar" },
      bankDetails: { bankName: "SBI", branchName: "Saheed Nagar" },
      salary: { gross: 25000 },
    },
    after: {
      firstName: "KRISHNA",
      address: { line1: "44 Janpath", city: "Bhubaneswar" },
      bankDetails: { bankName: "SBI", branchName: "Nayapalli" },
      salary: { gross: 25000 },
    },
  });
  check("an off-list edit is recorded at all", Boolean(offList));
  check(
    "it names the fields that moved",
    (offList?.fields || []).length === 2,
    JSON.stringify(offList?.fields?.map((f) => f.path)),
  );
  check(
    "nested paths get their screen labels",
    offList?.fields?.some((f) => f.label === "Address line 1") &&
      offList?.fields?.some((f) => f.label === "Bank branch"),
    JSON.stringify(offList?.fields?.map((f) => f.label)),
  );
  check(
    "the summary says what changed, not just that something did",
    /Address line 1 12 MG Road → 44 Janpath/.test(offList?.summary || ""),
    offList?.summary,
  );
  check(
    "an unchanged nested value is not reported",
    !offList?.fields?.some((f) => f.path.includes("city")),
  );
  check(
    "an unchanged salary is not reported",
    !offList?.fields?.some((f) => f.path.startsWith("salary")),
  );

  const hike = await recordChange(reqAs("Priya Nair", "priya@grav.in"), {
    departmentSlug: "hr",
    section: SECTION,
    entity: ENTITY,
    entityId: "harness-4",
    entityLabel: "KRISHNA BEHERA",
    action: "update",
    before: { salary: { gross: 25000, hra: 5000 } },
    after: { salary: { gross: 30000, hra: 6000 } },
  });
  check(
    "a pay rise reads as a pay rise",
    /Gross salary 25000 → 30000/.test(hike?.summary || ""),
    hike?.summary,
  );
  check(
    "salary sub-fields are labelled, not redacted away",
    hike?.fields?.some((f) => f.label === "Gross salary" && f.to === 30000) &&
      hike?.fields?.some((f) => f.label === "HRA"),
    JSON.stringify(hike?.fields),
  );

  console.log("\nreading");
  const bySection = await listChanges({ departmentSlug: "hr", section: SECTION, entity: ENTITY });
  check("the section query finds them", bySection.total >= 2, `total=${bySection.total}`);

  const byOther = await listChanges({
    departmentSlug: "hr",
    section: "hr:payroll",
    entity: ENTITY,
  });
  check("another section does not see them", byOther.total === 0);

  const byActor = await listChanges({
    departmentSlug: "hr",
    entity: ENTITY,
    actorEmail: "rahul@grav.in",
  });
  check("filtering by actor works", byActor.total === 1, `total=${byActor.total}`);

  const bySearch = await listChanges({ departmentSlug: "hr", entity: ENTITY, q: "Senior cutter" });
  check("free-text search reaches the summary", bySearch.total >= 1);

  const badSearch = await listChanges({ departmentSlug: "hr", entity: ENTITY, q: "((" });
  check("a regex metacharacter in search does not throw", Array.isArray(badSearch.items));

  const byOrigin = await listChanges({
    departmentSlug: "hr",
    entity: ENTITY,
    origin: "approval",
  });
  check("filtering by origin works", byOrigin.total === 1);

  const paged = await listChanges({ departmentSlug: "hr", entity: ENTITY, limit: 1, page: 1 });
  check("paging returns one row and the true total", paged.items.length === 1 && paged.total >= 2);

  const otherDept = await listChanges({ departmentSlug: "sales", entity: ENTITY });
  check("another department cannot see HR's entries", otherDept.total === 0);

  console.log("\ncleanup");
  const { deletedCount } = await ChangeLog.deleteMany({ entity: ENTITY });
  check("every harness row was removed", deletedCount >= 2, `deleted=${deletedCount}`);
  const left = await ChangeLog.countDocuments({ entity: ENTITY });
  check("nothing is left behind", left === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err);
  try {
    const { deletedCount } = await ChangeLog.deleteMany({ entity: ENTITY });
    console.error(`cleaned up ${deletedCount} harness row(s) after the crash.`);
    await mongoose.disconnect();
  } catch {
    console.error("CLEANUP FAILED — delete change_logs rows with entity 'verify-harness' by hand.");
  }
  process.exit(1);
});
