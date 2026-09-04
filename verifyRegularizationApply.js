// verifyRegularizationApply.js
//
// An approved correction reaches the attendance record — including on the day
// it most often has to, one the device never recorded at all.
//
// Run:  node -r dotenv/config verifyRegularizationApply.js
//
// THE BUG THIS PINS
// DailyAttendance requires `date` and `yearMonth`. The applier created a
// missing day with only `dateStr`, so save() threw a ValidationError, the
// approval route caught it as a generic "apply_failed", and the reason was
// discarded. The branch existed precisely for days with no attendance row —
// and that was the one case it could never handle.
//
// It WRITES: it applies a synthetic request to a throwaway date, then removes
// the day it created. On crash too.

"use strict";

const mongoose = require("mongoose");

/* Far enough out that no real attendance, payroll or leave touches it. */
const TEST_DATE = "2099-12-31";
const TEST_BID = "ZZVERIFY";

let pass = 0, fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ok    ${n}`); }
  else { fail += 1; console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`); }
};

async function cleanup() {
  const DailyAttendance = require("./models/HR_Models/Dailyattendance");
  return (await DailyAttendance.deleteMany({ dateStr: TEST_DATE })).deletedCount;
}

(async () => {
  await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const DailyAttendance = require("./models/HR_Models/Dailyattendance");
  const { applyRegularizationToAttendance } = require("./routes/HrRoutes/Attendance_section");

  await cleanup();

  console.log("the schema's own requirements");
  const bare = new DailyAttendance({ dateStr: TEST_DATE, employees: [] });
  const err = bare.validateSync();
  check("a day built from dateStr alone does NOT validate",
    Boolean(err) && Boolean(err.errors?.date) && Boolean(err.errors?.yearMonth),
    err ? Object.keys(err.errors).join(", ") : "it validated");
  console.log("        (that is exactly what the applier used to construct)");

  console.log("\napplying a correction to a day with no attendance row");
  const existing = await DailyAttendance.findOne({ dateStr: TEST_DATE }).lean();
  check("the day genuinely does not exist yet", !existing);

  const request = {
    dateStr: TEST_DATE,
    biometricId: TEST_BID,
    employeeId: new mongoose.Types.ObjectId(),
    employeeName: "Verify Harness",
    department: "Verification",
    designation: "Test",
    appliedToAttendance: false,
    requestedStatus: "P",
    type: "forgot_punch",
    punches: [],
  };

  let res;
  try {
    res = await applyRegularizationToAttendance(request, { name: "verify" });
  } catch (e) {
    res = { applied: false, skipped: `threw: ${e.message}` };
  }

  check("it applied rather than failing", res.applied === true, res.skipped);
  check("and did not report the old validation failure",
    !/validation|required/i.test(String(res.skipped || "")), res.skipped);

  const created = await DailyAttendance.findOne({ dateStr: TEST_DATE }).lean();
  check("the day row now exists", Boolean(created));
  if (created) {
    /* Read in IST, not UTC. Midnight IST is 18:30Z the PREVIOUS day, so
       toISOString() on a correctly-stamped row reports the day before and the
       check fails on code that is right. This is the module's own idiom:
       add 5.5h, then read the UTC parts. */
    const istDay = new Date(created.date.getTime() + 5.5 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);
    check("with the required `date`, derived from the day being corrected",
      created.date instanceof Date && istDay === TEST_DATE,
      `${istDay} (stored ${created.date.toISOString()})`);
    check("and the required `yearMonth`, matching that day",
      created.yearMonth === TEST_DATE.slice(0, 7), created.yearMonth);
    check("stamped with the corrected day, not with today",
      created.yearMonth !== new Date().toISOString().slice(0, 7) ||
        TEST_DATE.startsWith(new Date().toISOString().slice(0, 7)));
    const emp = (created.employees || []).find((e) => e.biometricId === TEST_BID);
    check("and the employee was seeded onto it", Boolean(emp),
      `${(created.employees || []).length} employee row(s)`);
  }

  console.log("\nit stays idempotent");
  /* A retry must not stack a second punch — the whole reason re-approving is
     safe as a retry. */
  const again = await applyRegularizationToAttendance(
    { ...request, appliedToAttendance: true },
    { name: "verify" },
  );
  check("an already-applied request is skipped, not applied twice",
    again.applied === false && again.skipped === "already_applied", again.skipped);

  console.log("\ncleanup");
  check("the day this harness created was removed", (await cleanup()) >= 1);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message);
  try {
    console.error(`cleaned up ${await cleanup()} row(s).`);
    await mongoose.disconnect();
  } catch { console.error(`CLEANUP FAILED — remove dailyattendances dateStr=${TEST_DATE}.`); }
  process.exit(1);
});
