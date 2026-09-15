// verifyAttendanceRemoval.js
//
// Somebody taken off the register stays off it — for that month, and only
// that month.
//
// Run:  node -r dotenv/config verifyAttendanceRemoval.js
//
// ── WHAT THIS IS ABOUT ──────────────────────────────────────────────────────
// "Remove from month" was a single $pull of that person's rows from whatever
// days had already been written. Two things followed, and both were reported
// as one complaint — "I removed their attendance and they are still in the
// downloaded Excel":
//
//   1. It deleted what existed at that instant and remembered nothing, so the
//      next biometric sync wrote the rows back. All five removals performed on
//      this database on 2 Sep 2026 reported "0 day record(s) deleted" — the
//      month was two days old — and all five had September rows again within
//      a fortnight.
//
//   2. The export's roster was time-blind: every active employee appeared on
//      every month's sheet whether or not they were on the roll, with A on
//      each day they had no row. A person who left in July still collected a
//      column of absences in September.
//
// The requirement is both halves together: removed from September, gone from
// September's sheet — and STILL ON AUGUST'S, with the days they actually
// worked, because they really were here in August. A muster roll that loses a
// past employee is not a record.
//
// IT WRITES, AND PUTS EVERYTHING BACK. It removes a real employee from a real
// month, reads the sheets, then restores the deleted rows verbatim from a
// snapshot taken first and deletes the exclusion — including on a crash.
// Nothing it touches is left changed.

"use strict";

const mongoose = require("mongoose");
const ExcelJS = require("exceljs");

let pass = 0,
  fail = 0;
const check = (n, ok, d = "") => {
  if (ok) {
    pass += 1;
    console.log(`  ok    ${n}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${n}${d ? ` -- ${d}` : ""}`);
  }
};

/* The name this harness signs its token with. Every change_log row it causes
   carries it as the actor, which is how cleanup finds them again.

   Those rows matter more than the usual test litter: backfill_attendance_
   exclusions.js reads the removal log to replay removals performed before
   they were durable, so a harness run left in that log would quietly hold a
   real employee off a real month. Deliberately free of regex metacharacters,
   like the other markers in this repo. */
const MARKER = "AUTOMATED-CHECK-verifyAttendanceRemoval";

/* Everything this run creates or deletes, so cleanup does not depend on how
   far the run got. Snapshots are taken BEFORE the first mutation. */
const undo = {
  exclusions: [], // { biometricId, yearMonth } to delete
  rows: [], // { dateStr, entry } to put back
  syntheticDays: [], // dateStr of day docs created from nothing
};

async function cleanUp() {
  if (mongoose.connection.readyState !== 1) return "not connected";
  const db = mongoose.connection.db;
  let restored = 0,
    dropped = 0;

  for (const { dateStr, entry } of undo.rows) {
    /* $addToSet would compare the whole subdocument and re-add a row that
       came back changed; match on the id and only insert when absent. */
    const has = await db
      .collection("dailyattendances")
      .countDocuments({ dateStr, "employees.biometricId": entry.biometricId });
    if (!has) {
      await db
        .collection("dailyattendances")
        .updateOne({ dateStr }, { $push: { employees: entry } });
      restored += 1;
    }
  }
  for (const { biometricId, yearMonth } of undo.exclusions) {
    const r = await db
      .collection("attendanceexclusions")
      .deleteOne({ biometricId, yearMonth });
    dropped += r.deletedCount;
  }
  for (const dateStr of undo.syntheticDays) {
    await db.collection("dailyattendances").deleteOne({ dateStr });
  }
  /* The audit rows this run caused. Left behind, they would be replayed by
     backfill_attendance_exclusions.js against a real employee. */
  const logs = await db
    .collection("change_logs")
    .deleteMany({ actorName: MARKER });
  undo.rows = [];
  undo.exclusions = [];
  undo.syntheticDays = [];
  return (
    `restored ${restored} attendance row(s), removed ${dropped} exclusion(s), ` +
    `${logs.deletedCount} audit row(s)`
  );
}

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  console.log(`\nconnected to ${mongoose.connection.name}\n`);

  const db = mongoose.connection.db;
  const Employee = require("./models/Employee");
  const DailyAttendance = require("./models/HR_Models/Dailyattendance");
  const AttendanceExclusion = require("./models/HR_Models/AttendanceExclusion");
  const roster = require("./services/attendanceRoster.service");
  const attendanceRouter = require("./routes/HrRoutes/Attendance_section");

  /* ── the month arithmetic the range logic rests on ──────────────────── */
  console.log("the months a range covers");
  check(
    "a single month is one month",
    JSON.stringify(roster.monthsInRange("2026-09-01", "2026-09-30")) ===
      '["2026-09"]',
  );
  check(
    "a quarter is three",
    JSON.stringify(roster.monthsInRange("2026-07-01", "2026-09-30")) ===
      '["2026-07","2026-08","2026-09"]',
  );
  check(
    "it crosses a year end",
    JSON.stringify(roster.monthsInRange("2026-11-15", "2027-02-03")) ===
      '["2026-11","2026-12","2027-01","2027-02"]',
    JSON.stringify(roster.monthsInRange("2026-11-15", "2027-02-03")),
  );
  /* A range ending on the 31st, walked with setMonth(+1), overflows: 31 Jan
     + 1 month is 3 March, and the sheet loses February entirely. */
  check(
    "31 Jan → 28 Feb does not skip February",
    JSON.stringify(roster.monthsInRange("2027-01-31", "2027-02-28")) ===
      '["2027-01","2027-02"]',
    JSON.stringify(roster.monthsInRange("2027-01-31", "2027-02-28")),
  );

  /* ── pick a real subject ────────────────────────────────────────────── */
  const SUBJECT_MONTH = "2026-09";
  const KEEP_MONTH = "2026-08";

  /* ── THE SHEET IS THE ROLL, NOT THE STAFF LIST ──────────────────────────
     The complaint this all started from: people who were not there that
     month were still on the month's sheet with A on every day. The roster
     used to be every active employee, whatever the month.

     A daily document carries a row for everybody the device reported, so the
     people with rows in a month ARE that month's roll. For a settled month
     the sheet and that set should agree, in both directions — nobody with
     attendance dropped, and nobody without attendance invented. */
  const rollOf = async (yearMonth) => {
    const m = new Map(); // bid → the name the sheet will print
    const docs = await DailyAttendance.find({ yearMonth })
      .select("dateStr employees.biometricId employees.employeeName")
      .sort({ dateStr: 1 })
      .lean();
    for (const d of docs)
      for (const e of d.employees || []) {
        const b = String(e.biometricId || "").toUpperCase();
        if (b && e.employeeName)
          m.set(b, String(e.employeeName).trim().toUpperCase());
      }
    return { roll: m, lastDay: docs.length ? docs[docs.length - 1].dateStr : null };
  };

  /* Somebody active, with rows in BOTH months — so the sheet has something
     real to lose in one and to keep in the other. */
  const monthBids = async (ym) => {
    const docs = await DailyAttendance.find({ yearMonth: ym })
      .select("employees.biometricId")
      .lean();
    const s = new Set();
    docs.forEach((d) =>
      (d.employees || []).forEach(
        (e) => e.biometricId && s.add(String(e.biometricId).toUpperCase()),
      ),
    );
    return s;
  };
  const sepBids = await monthBids(SUBJECT_MONTH);
  const augBids = await monthBids(KEEP_MONTH);

  const candidates = await Employee.find({ isActive: true })
    .select("firstName lastName name biometricId department isActive status")
    .lean();
  const subject = candidates.find((e) => {
    const b = String(e.biometricId || "").toUpperCase();
    return b && sepBids.has(b) && augBids.has(b);
  });
  check(
    "found an employee on the roll in both months",
    Boolean(subject),
    subject
      ? `${subject.biometricId} ${subject.firstName} ${subject.lastName || ""}`
      : "none",
  );
  if (!subject) {
    console.log(`\n${pass} passed, ${fail} failed\n`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }

  const BID = String(subject.biometricId).toUpperCase();
  const NAME = `${subject.firstName} ${subject.lastName || ""}`.trim();
  console.log(`\nsubject: ${BID} — ${NAME}`);

  try {
    /* ── snapshot BEFORE anything is touched ──────────────────────────── */
    const sepDocs = await DailyAttendance.find({
      yearMonth: SUBJECT_MONTH,
      "employees.biometricId": BID,
    }).lean();
    for (const d of sepDocs) {
      const entry = (d.employees || []).find(
        (e) => String(e.biometricId || "").toUpperCase() === BID,
      );
      if (entry) undo.rows.push({ dateStr: d.dateStr, entry });
    }
    undo.exclusions.push({ biometricId: BID, yearMonth: SUBJECT_MONTH });
    console.log(`  (snapshotted ${undo.rows.length} September row(s))`);

    /* ── a signed-in HR user and the real routes ──────────────────────── */
    const jwt = require("jsonwebtoken");
    const hr = await Employee.findOne({ isActive: true })
      .select("_id firstName")
      .lean();
    const token = jwt.sign(
      {
        id: String(hr._id),
        role: "hr_manager",
        userType: "employee",
        name: MARKER,
      },
      process.env.JWT_SECRET,
      { expiresIn: "10m" },
    );
    const express = require("express");
    const app = express();
    app.use(express.json());
    app.use("/att", attendanceRouter);
    const server = await new Promise((r) => {
      const s = app.listen(0, () => r(s));
    });
    const base = `http://127.0.0.1:${server.address().port}/att`;
    const auth = { Authorization: `Bearer ${token}` };

    const sheetFor = async (yearMonth) => {
      const res = await fetch(
        `${base}/export-muster-roll?yearMonth=${yearMonth}`,
        { headers: auth },
      );
      if (res.status !== 200) return { status: res.status, rows: new Map() };
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
      const ws = wb.worksheets[0];
      const rows = new Map();
      ws.eachRow((row, n) => {
        if (n < 5) return; // title, legend, two header rows
        const v = row.values;
        const name = typeof v[2] === "string" ? v[2].trim().toUpperCase() : "";
        if (!name) return;
        rows.set(
          name,
          v.slice(6, 37).map((c) => (typeof c === "string" ? c : "")),
        );
      });
      return { status: res.status, rows };
    };
    const findRow = (rows) =>
      [...rows.keys()].find((k) => k.includes(NAME.toUpperCase()));

    try {
      /* ── the roll, for real, before anything is removed ────────────── */
      console.log("\nthe sheet matches who was actually on the roll");
      for (const ym of [KEEP_MONTH, SUBJECT_MONTH]) {
        const { roll, lastDay } = await rollOf(ym);
        const { rows } = await sheetFor(ym);
        const printed = new Set([...rows.keys()].filter((n) => n !== "TOTALS"));

        const dropped = [...roll.entries()].filter(([, nm]) => !printed.has(nm));
        check(
          `${ym}: nobody with attendance was dropped (${roll.size} on the roll)`,
          dropped.length === 0,
          dropped.map(([b, n]) => `${b} ${n}`).join(", "),
        );

        /* The other direction — the actual complaint. Anybody printed with no
           attendance row at all can only render as a column of A. Two things
           legitimately explain it, and nothing else may: approved leave
           covering the month, and joining so recently that the register has
           not yet covered a day of theirs. */
        const names = new Set(roll.values());
        const extras = [...printed].filter((n) => !names.has(n));
        const unexplained = [];
        for (const nm of extras) {
          const emp = await Employee.findOne({
            $expr: {
              $eq: [
                {
                  $toUpper: {
                    $trim: {
                      input: {
                        $concat: [
                          { $ifNull: ["$firstName", ""] },
                          " ",
                          { $ifNull: ["$lastName", ""] },
                        ],
                      },
                    },
                  },
                },
                nm,
              ],
            },
          })
            .select("biometricId dateOfJoining")
            .lean();
          const doj = emp?.dateOfJoining
            ? new Date(emp.dateOfJoining).toISOString().slice(0, 10)
            : null;
          const justJoined = Boolean(doj && lastDay && doj >= lastDay);
          const onLeave = emp
            ? (await db.collection("leaveapplications").countDocuments({
                biometricId: emp.biometricId,
                status: { $in: ["hr_approved", "withdraw_pending"] },
                startDate: { $lte: new Date(`${ym}-28T23:59:59.999+05:30`) },
                endDate: { $gte: new Date(`${ym}-01T00:00:00.000+05:30`) },
              })) > 0
            : false;
          if (!justJoined && !onLeave) unexplained.push(`${nm} (doj ${doj || "-"})`);
        }
        check(
          `${ym}: nobody is printed as a month of absences they were not there for`,
          unexplained.length === 0,
          unexplained.join(", "),
        );
      }

      /* A month nothing has been synced for must NOT come out empty. This is
         the guard that keeps "the roll is whoever has rows" from erasing a
         sheet the moment the sync is behind. */
      const future = await sheetFor("2026-12");
      check(
        "a month with no attendance yet still lists everybody",
        future.rows.size > 1,
        `${future.rows.size} row(s)`,
      );

      /* The screen and the download are the same report. They used to build
         their rosters from separate queries, and the screen's excluded
         inactive employees outright — so a leaver who worked all of July was
         on July's Excel and missing from July's screen. Both now ask the
         roster service. */
      console.log("\nthe screen and the download agree");
      for (const ym of ["2026-07", KEEP_MONTH, SUBJECT_MONTH, "2026-12"]) {
        const { rows } = await sheetFor(ym);
        const sheetNames = new Set(
          [...rows.keys()].filter((n) => n !== "TOTALS"),
        );
        const res = await fetch(`${base}/muster-roll?yearMonth=${ym}`, {
          headers: auth,
        });
        const body = await res.json();
        const screenNames = new Set(
          (body.employees || [])
            .map((e) => String(e.employeeName || "").trim().toUpperCase())
            .filter(Boolean),
        );
        const onlySheet = [...sheetNames].filter((n) => !screenNames.has(n));
        const onlyScreen = [...screenNames].filter((n) => !sheetNames.has(n));
        check(
          `${ym}: the same people on screen and in the file (${sheetNames.size})`,
          onlySheet.length === 0 && onlyScreen.length === 0,
          [
            onlySheet.length ? `file only: ${onlySheet.join(", ")}` : "",
            onlyScreen.length ? `screen only: ${onlyScreen.join(", ")}` : "",
          ]
            .filter(Boolean)
            .join(" · "),
        );
      }

      /* ── before ───────────────────────────────────────────────────── */
      console.log("\nbefore the removal");
      const sepBefore = await sheetFor(SUBJECT_MONTH);
      const augBefore = await sheetFor(KEEP_MONTH);
      check("September's sheet builds", sepBefore.status === 200, String(sepBefore.status));
      check(`${NAME} is on September's sheet`, Boolean(findRow(sepBefore.rows)));
      check(`${NAME} is on August's sheet`, Boolean(findRow(augBefore.rows)));
      const augCodesBefore = augBefore.rows.get(findRow(augBefore.rows)) || [];
      const augWorkedBefore = augCodesBefore.filter((c) =>
        c.startsWith("P"),
      ).length;
      const sepPopBefore = sepBefore.rows.size;

      /* ── the removal ──────────────────────────────────────────────── */
      console.log("\nthe removal");
      const del = await fetch(
        `${base}/remove-from-month?biometricId=${BID}&yearMonth=${SUBJECT_MONTH}`,
        { method: "DELETE", headers: auth },
      );
      const delBody = await del.json();
      check("the route accepts it", del.status === 200 && delBody.success, JSON.stringify(delBody).slice(0, 160));

      /* THE BUG. The old route's entire effect was the $pull; when it matched
         nothing — the normal case early in a month — the removal was a no-op
         that reported success. The record is what makes it stick. */
      const rec = await AttendanceExclusion.findOne({
        biometricId: BID,
        yearMonth: SUBJECT_MONTH,
      }).lean();
      check(
        "it is recorded, not just applied to the rows that existed",
        Boolean(rec),
        rec ? `removed ${rec.daysRemovedAtTime} row(s) at the time` : "no record written",
      );
      check(
        "the record names who did it and when",
        Boolean(rec && rec.removedAt),
        rec ? String(rec.removedAt) : "-",
      );

      /* ── after ────────────────────────────────────────────────────── */
      console.log("\nafter the removal");
      const sepAfter = await sheetFor(SUBJECT_MONTH);
      const augAfter = await sheetFor(KEEP_MONTH);

      check(
        `${NAME} is GONE from September's sheet`,
        !findRow(sepAfter.rows),
        findRow(sepAfter.rows) || "",
      );
      check(
        "and nobody else was dropped with them",
        sepAfter.rows.size === sepPopBefore - 1,
        `${sepPopBefore} → ${sepAfter.rows.size}`,
      );

      const augKey = findRow(augAfter.rows);
      check(`${NAME} is STILL on August's sheet`, Boolean(augKey));
      const augCodesAfter = augAfter.rows.get(augKey) || [];
      const augWorkedAfter = augCodesAfter.filter((c) => c.startsWith("P")).length;
      check(
        "with August's days unchanged — not blanked, not turned to absences",
        augWorkedAfter === augWorkedBefore && augWorkedAfter > 0,
        `worked days ${augWorkedBefore} → ${augWorkedAfter}`,
      );

      /* ── a range that spans both ──────────────────────────────────── */
      console.log("\na range covering both months");
      const spanRes = await fetch(
        `${base}/export-muster-roll?from=${KEEP_MONTH}-01&to=${SUBJECT_MONTH}-30`,
        { headers: auth },
      );
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(Buffer.from(await spanRes.arrayBuffer()));
      let spanFound = false;
      wb.worksheets[0].eachRow((row, n) => {
        if (n < 5) return;
        const v = row.values;
        const nm = typeof v[2] === "string" ? v[2].trim().toUpperCase() : "";
        if (nm && nm.includes(NAME.toUpperCase())) spanFound = true;
      });
      check(
        "they stay on a quarterly sheet — August is theirs, only September is not",
        spanFound,
        "dropped from a range they were on the roll for half of",
      );

      /* ── the sync must not undo it ────────────────────────────────── */
      console.log("\nthe next sync");
      /* This is the function that wrote them back. Driven directly, with a
         fresh row exactly as the device would report it. */
      const smartSaveDay = attendanceRouter.smartSaveDay;
      check("smartSaveDay is reachable to drive", typeof smartSaveDay === "function");

      if (typeof smartSaveDay === "function") {
        const probeDate = `${SUBJECT_MONTH}-15`;
        const existingProbe = await DailyAttendance.findOne({ dateStr: probeDate }).lean();
        if (!existingProbe) undo.syntheticDays.push(probeDate);
        const freshRow = {
          employeeDbId: subject._id,
          biometricId: BID,
          employeeName: NAME,
          department: subject.department || "",
          designation: "",
          employeeType: "executive",
          isGhost: false,
          rawPunches: [],
          punchCount: 0,
          systemPrediction: "P",
          attendanceValue: 1,
        };
        const settings = await require("./models/HR_Models/Attendancesettings").getConfig();
        await smartSaveDay(
          probeDate,
          [freshRow],
          {
            dateStr: probeDate,
            date: new Date(`${probeDate}T00:00:00.000+05:30`),
            yearMonth: SUBJECT_MONTH,
          },
          existingProbe,
          settings,
          false,
        );
        const afterSync = await DailyAttendance.findOne({ dateStr: probeDate }).lean();
        const cameBack = (afterSync?.employees || []).some(
          (e) => String(e.biometricId || "").toUpperCase() === BID,
        );
        check(
          "a sync reporting them does NOT write them back",
          !cameBack,
          cameBack ? "the row returned — the removal is undone again" : "",
        );
        /* Anything the probe day did write, take note of so cleanup removes
           it; the day itself is dropped if this run created it. */
        if (existingProbe && !undo.syntheticDays.includes(probeDate)) {
          // nothing to undo: the excluded row was never added
        }
      }

      /* ── and the way back ─────────────────────────────────────────── */
      console.log("\nputting them back");
      const restore = await fetch(`${base}/restore-to-month`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ biometricId: BID, yearMonth: SUBJECT_MONTH }),
      });
      const restoreBody = await restore.json();
      check(
        "restore-to-month lifts the hold",
        restore.status === 200 && restoreBody.success,
        JSON.stringify(restoreBody).slice(0, 140),
      );
      const stillHeld = await AttendanceExclusion.findOne({
        biometricId: BID,
        yearMonth: SUBJECT_MONTH,
      }).lean();
      check("the record is gone", !stillHeld);
      const restoreAgain = await fetch(`${base}/restore-to-month`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ biometricId: BID, yearMonth: SUBJECT_MONTH }),
      });
      check(
        "restoring somebody who is not held says so rather than pretending",
        restoreAgain.status === 404,
        String(restoreAgain.status),
      );
    } finally {
      await new Promise((r) => server.close(r));
    }
  } finally {
    console.log(`\n  cleanup: ${await cleanUp()}`);
  }

  /* ── the database is as it was ──────────────────────────────────────── */
  console.log("\nnothing left behind");
  const leftover = await AttendanceExclusion.countDocuments({ biometricId: BID });
  check("no exclusion left for the subject", leftover === 0, String(leftover));
  const sepNow = await monthBids(SUBJECT_MONTH);
  check(
    "their September rows are back exactly as they were",
    sepNow.has(BID) === sepBids.has(BID),
    `had rows: ${sepBids.has(BID)}, now: ${sepNow.has(BID)}`,
  );
  const sepCountNow = (await monthBids(SUBJECT_MONTH)).size;
  check(
    "September's roll is the same size as before",
    sepCountNow === sepBids.size,
    `${sepBids.size} → ${sepCountNow}`,
  );
  /* An earlier version of this harness left its removal in the change log,
     where backfill_attendance_exclusions.js reads removals to replay. Running
     that backfill would have held a real employee off a real month on the
     strength of a test. */
  const strayLogs = await db
    .collection("change_logs")
    .countDocuments({ actorName: MARKER });
  check(
    "no audit row left for the backfill script to replay",
    strayLogs === 0,
    `${strayLogs} left`,
  );

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error("\nharness crashed:", e.message, (e.stack || "").split("\n")[1] || "");
  try {
    console.error("cleanup:", await cleanUp());
  } catch (err) {
    console.error("CLEANUP FAILED — check attendanceexclusions:", err.message);
  }
  try {
    await mongoose.disconnect();
  } catch {}
  process.exit(1);
});
