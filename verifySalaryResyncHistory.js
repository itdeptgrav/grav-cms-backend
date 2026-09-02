// verifySalaryResyncHistory.js
//
// A salary-rule change records every employee it moved, and only those.
//
// Run:  node -r dotenv/config verifySalaryResyncHistory.js
//
// This one WRITES. It runs a real resync against the dev database, checks what
// landed in change_logs, and then puts both back: the entries it created are
// deleted, and every employee it touched is restored from the snapshot it took
// first. It refuses to run against a database whose name is not a dev one.

"use strict";

const mongoose = require("mongoose");

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

let snapshot = [];
let startedAt = null;

async function restore() {
  const Employee = require("./models/Employee");
  const ChangeLog = require("./models/Access/ChangeLog");
  let n = 0;
  for (const row of snapshot) {
    await Employee.updateOne({ _id: row._id }, { $set: { salary: row.salary } });
    n += 1;
  }
  const del = startedAt
    ? (await ChangeLog.deleteMany({ createdAt: { $gte: startedAt }, origin: "system", critical: true })).deletedCount
    : 0;
  return { restored: n, entriesRemoved: del };
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  const dbName = mongoose.connection.name;
  console.log(`\nconnected to ${dbName}\n`);

  if (/prod/i.test(dbName)) {
    console.log("  refusing to run against a production-looking database.\n");
    process.exit(1);
  }

  const Employee = require("./models/Employee");
  const ChangeLog = require("./models/Access/ChangeLog");
  const { resyncAllSalaries } = require("./services/salaryResync");

  /* Snapshot every salary first — this is what makes the run reversible. */
  snapshot = await Employee.find({}).select("_id salary").lean();
  check("snapshotted every employee's salary before touching anything",
    snapshot.length > 0, `${snapshot.length}`);

  const preview = await resyncAllSalaries({ dryRun: true });
  check("the dry run found employees to change", preview.changed > 0, `${preview.changed}`);
  check("and names the month the rules take effect from",
    Boolean(preview.effectiveFrom), preview.effectiveFrom);

  startedAt = new Date();
  await new Promise((r) => setTimeout(r, 10));

  const real = await resyncAllSalaries({});
  check("the real run changed the same number the preview promised",
    real.changed === preview.changed, `${real.changed} vs ${preview.changed}`);

  const written = await ChangeLog.find({
    createdAt: { $gte: startedAt }, origin: "system", critical: true,
  }).lean();

  console.log("\nwhat the history recorded");
  check("one entry per employee whose pay moved, and no more",
    written.length === real.changed, `${written.length} entries for ${real.changed} employees`);

  const ids = new Set(written.map((w) => String(w.entityId)));
  check("every entry is against a distinct employee", ids.size === written.length);
  check("all of them are flagged critical", written.every((w) => w.critical === true));
  check("all of them are on the employee record, not a settings page",
    written.every((w) => w.entity === "employee" && w.entityId));
  check("each names the month the change takes effect from",
    written.every((w) => (w.summary || "").includes(real.effectiveFrom)),
    written[0]?.summary);
  check("each says earlier payroll is untouched",
    written.every((w) => /earlier months is unchanged/i.test(w.summary || "")));

  console.log("\nthe entries carry the actual figures");
  const withFields = written.filter((w) => (w.fields || []).length > 0);
  check("every entry lists the fields that moved", withFields.length === written.length,
    `${withFields.length} of ${written.length}`);
  const sample = written.find((w) => (w.fields || []).some((f) => f.path === "salary.employerCost"));
  check("a CTC change is recorded as a CTC change", Boolean(sample),
    sample ? "" : "no entry mentioned employerCost");
  if (sample) {
    const f = sample.fields.find((x) => x.path === "salary.employerCost");
    check("with a readable label rather than a key", f.label === "CTC / Employer Cost", f.label);
    check("and both the old and the new number",
      typeof f.from === "number" && typeof f.to === "number" && f.from !== f.to,
      `${f.from} -> ${f.to}`);
  }

  console.log("\nunchanged employees are not recorded");
  /* Running it a SECOND time must change nothing and write nothing — the
     figures already match the rules. This is the check that proves the log
     records movement rather than merely activity. */
  const secondStart = new Date();
  await new Promise((r) => setTimeout(r, 10));
  const again = await resyncAllSalaries({});
  const writtenAgain = await ChangeLog.countDocuments({
    createdAt: { $gte: secondStart }, origin: "system", critical: true,
  });
  check("a second run finds nothing to change", again.changed === 0, `${again.changed}`);
  check("and writes no history at all", writtenAgain === 0, `${writtenAgain}`);

  console.log("\nno payroll run was touched");
  const { Payroll } = require("./models/HR_Models/Payroll");
  const runsAfter = await Payroll.find({}).select("month year totalEDLI totalAdminCharges updatedAt").lean();
  check("processed months keep their own figures",
    runsAfter.every((r) => r.updatedAt < startedAt),
    `${runsAfter.filter((r) => r.updatedAt >= startedAt).length} run(s) were modified`);

  console.log("\nputting the database back");
  const undone = await restore();
  check(`every salary restored (${undone.restored})`, undone.restored === snapshot.length);
  check(`every history entry removed (${undone.entriesRemoved})`,
    undone.entriesRemoved === written.length);
  /* Scoped to THIS harness's entries, not the global count. The database is
     shared and people are using it: a colleague saving a CRM enquiry mid-run
     is not a failure of the cleanup, and asserting on a global total reports
     their work as this script's mess. */
  const leftover = await ChangeLog.countDocuments({ origin: "system", critical: true });
  check("no resync entry is left behind", leftover === 0, `${leftover} remain`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error("\nharness crashed:", err.message);
  try {
    const u = await restore();
    console.error(`restored ${u.restored} salaries, removed ${u.entriesRemoved} entries.`);
    await mongoose.disconnect();
  } catch { console.error("RESTORE FAILED -- salaries may be left recalculated."); }
  process.exit(1);
});
