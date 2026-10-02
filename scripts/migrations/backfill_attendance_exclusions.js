// backfill_attendance_exclusions.js
//
// Make the removals that were already performed actually take effect.
//
//   node -r dotenv/config backfill_attendance_exclusions.js           # dry run
//   node -r dotenv/config backfill_attendance_exclusions.js --apply   # writes
//   node -r dotenv/config backfill_attendance_exclusions.js --undo    # reverses
//
// ── WHAT THIS IS FOR ────────────────────────────────────────────────────────
// "Remove from month" used to be a single $pull of whatever rows existed at
// that moment, with nothing recorded. On this database every removal ever
// performed — five of them, on 2 Sep 2026 — reported "0 day record(s)
// deleted", because September was two days old and those people had no rows
// yet. The button reported success and did nothing, and all five had
// September rows again within a fortnight.
//
// Removal is now a stored hold that the sync honours, so it works from here
// on. This script is only about the past: it reads the change log for
// removals that were performed under the old behaviour and writes the hold
// that should have been created at the time.
//
// ── READ THIS BEFORE RUNNING IT ─────────────────────────────────────────────
// It changes who appears on a month's muster roll, and the muster roll feeds
// payroll. Four of the five people below are still marked ACTIVE, which the
// employee record cannot distinguish between "left the company" and "removed
// from one month for some other reason". So the dry run prints each person,
// their status, and what they currently have on that month's register — check
// that list against what you actually intended before passing --apply.
//
// It does NOT delete any attendance rows. It only writes the hold, which
// filters them out of the register, the muster roll and the export. Every
// punch stays in the database, and --undo puts things back exactly.

"use strict";

const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");
const UNDO = process.argv.includes("--undo");

(async () => {
  await mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing",
  );
  const db = mongoose.connection.db;
  console.log(`\nconnected to ${mongoose.connection.name}`);
  console.log(
    UNDO ? "MODE: undo" : APPLY ? "MODE: apply — this writes" : "MODE: dry run — nothing is written",
  );

  const AttendanceExclusion = require("./models/HR_Models/AttendanceExclusion");

  /* Removals recorded by the old route. entityId is "BID:YYYY-MM". */
  const logs = await db
    .collection("change_logs")
    .find({ section: "hr:attendance-daily", entity: "attendance-day", action: "delete" })
    .sort({ createdAt: 1 })
    .toArray();

  const wanted = [];
  for (const l of logs) {
    const [bid, ym] = String(l.entityId || "").split(":");
    if (!bid || !/^\d{4}-\d{2}$/.test(ym || "")) continue;
    if (!wanted.some((w) => w.bid === bid && w.ym === ym))
      wanted.push({ bid: bid.toUpperCase(), ym, at: l.createdAt, by: l.actorName || l.performedByName || "" });
  }

  if (!wanted.length) {
    console.log("\nno past removals found in the change log — nothing to do.\n");
    await mongoose.disconnect();
    return;
  }

  console.log(`\n${wanted.length} removal(s) recorded under the old behaviour:\n`);

  for (const w of wanted) {
    const emp = await db.collection("employees").findOne({ biometricId: w.bid });
    const name = emp ? `${emp.firstName || ""} ${emp.lastName || ""}`.trim() : "(no employee record)";
    const status = emp ? (emp.isActive === false || emp.status === "inactive" ? "INACTIVE" : "active") : "-";
    const rows = await db.collection("dailyattendances").countDocuments({
      yearMonth: w.ym,
      "employees.biometricId": w.bid,
    });
    const held = await AttendanceExclusion.countDocuments({ biometricId: w.bid, yearMonth: w.ym });
    console.log(
      `  ${w.bid.padEnd(8)} ${name.padEnd(24)} ${status.padEnd(9)} ${w.ym}` +
        `  rows now: ${String(rows).padStart(2)}  ${held ? "(already held)" : ""}`,
    );
    console.log(
      `           removed ${String(w.at).slice(0, 24)}${w.by ? ` by ${w.by}` : ""}`,
    );
  }

  if (UNDO) {
    let n = 0;
    for (const w of wanted) {
      const r = await AttendanceExclusion.deleteOne({ biometricId: w.bid, yearMonth: w.ym });
      n += r.deletedCount;
    }
    console.log(`\nundone — ${n} hold(s) removed. Everyone is back on their month's register.\n`);
    await mongoose.disconnect();
    return;
  }

  if (!APPLY) {
    console.log(
      "\nDry run. Check the list above — anyone marked `active` was removed from that\n" +
        "month but is still on the payroll, so make sure that is what you meant.\n" +
        "Run again with --apply to write the holds, and --undo to reverse them.\n",
    );
    await mongoose.disconnect();
    return;
  }

  let written = 0;
  for (const w of wanted) {
    const emp = await db.collection("employees").findOne({ biometricId: w.bid });
    const res = await AttendanceExclusion.updateOne(
      { biometricId: w.bid, yearMonth: w.ym },
      {
        $setOnInsert: {
          employeeName: emp ? `${emp.firstName || ""} ${emp.lastName || ""}`.trim() : "",
          removedAt: w.at || new Date(),
          removedByName: w.by || "(backfilled from the change log)",
          reason: "Backfilled: removal performed before removals were durable",
          daysRemovedAtTime: 0,
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) written += 1;
  }
  console.log(
    `\napplied — ${written} hold(s) written (${wanted.length - written} already existed).\n` +
      `No attendance rows were deleted. Reverse with --undo.\n`,
  );

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error("\nfailed:", e.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
