"use strict";

/**
 * Carry an employee's attendance rows from an old biometric ID to their
 * current one (12 Oct 2026).
 *
 * Attendance rows key on biometricId. When HR changes an employee's ID (to the
 * code the time office really uses), the rows already written under the old
 * ID stayed there. No active employee holds the old ID any more, so the
 * monthly register showed them as a GHOST with the person's own name and
 * department (RAHUL KUMAR ROUT, GR0199 → GR0126), while the days under the
 * new ID were still the device's ghost, or held off the month by a removal
 * made while the new ID was "nobody".
 *
 * Only rows that carry THIS employee's _id move, so another person who later
 * gets the old ID is never touched. A day that already has a row under the
 * new ID:
 *   - a ghost row there (the device's punches, unmatched) gives way: the
 *     employee's row is renamed onto the ID and the next sync merges the
 *     device's punches into it, keeping any HR override on it;
 *   - their own row there wins, and the old-ID row is dropped.
 */

const mongoose = require("mongoose");
const DailyAttendance = require("../models/HR_Models/Dailyattendance");
const AttendanceExclusion = require("../models/HR_Models/AttendanceExclusion");

const up = (v) => String(v || "").trim().toUpperCase();

function idsOf(employeeId) {
  const s = String(employeeId);
  return mongoose.Types.ObjectId.isValid(s) ? [new mongoose.Types.ObjectId(s), s] : [s];
}

/** What a move would do, without doing it. */
async function previewRekey({ employeeId, fromId, toId }) {
  const from = up(fromId), to = up(toId);
  const ids = idsOf(employeeId);
  const days = await DailyAttendance.find({
    employees: { $elemMatch: { biometricId: from, employeeDbId: { $in: ids } } },
  })
    .select("dateStr yearMonth")
    .sort({ dateStr: 1 })
    .lean();
  const ghostDays = await DailyAttendance.find({
    employees: { $elemMatch: { biometricId: to, isGhost: true } },
  })
    .select("dateStr yearMonth")
    .sort({ dateStr: 1 })
    .lean();
  const months = [...new Set([...days, ...ghostDays].map((d) => d.yearMonth || d.dateStr.slice(0, 7)))].sort();
  const held = months.length
    ? await AttendanceExclusion.find({ biometricId: to, yearMonth: { $in: months } })
        .select("yearMonth removedAt removedByName employeeName rowsDeleted")
        .sort({ yearMonth: 1 })
        .lean()
    : [];
  return {
    fromId: from,
    toId: to,
    rowsToMove: days.length,
    rowDates: days.map((d) => d.dateStr),
    ghostDaysOnNewId: ghostDays.map((d) => d.dateStr),
    months,
    held: held.map((h) => ({
      yearMonth: h.yearMonth,
      removedAt: h.removedAt,
      removedByName: h.removedByName || "",
      employeeName: h.employeeName || "",
    })),
  };
}

/**
 * Move the rows. `buildSummary` is the attendance router's own, so the day's
 * stored summary is recomputed by the same rule that wrote it.
 * Returns the dates touched, so the caller can re-sync them.
 */
async function rekeyAttendanceRows({ employeeId, fromId, toId, buildSummary }) {
  const from = up(fromId), to = up(toId);
  if (!from || !to || from === to) return { moved: 0, replacedGhost: 0, dropped: 0, dates: [] };
  const ids = idsOf(employeeId);
  const docs = await DailyAttendance.find({
    employees: { $elemMatch: { biometricId: from, employeeDbId: { $in: ids } } },
  });
  let moved = 0, replacedGhost = 0, dropped = 0;
  const mine = (e) => ids.some((i) => String(i) === String(e.employeeDbId || ""));
  for (const doc of docs) {
    const rows = doc.employees;
    const old = rows.find((e) => up(e.biometricId) === from && mine(e));
    if (!old) continue;
    const there = rows.find((e) => up(e.biometricId) === to);
    let next;
    if (!there) {
      old.biometricId = to;
      next = rows;
      moved++;
    } else if (there.isGhost && !mine(there)) {
      old.biometricId = to;
      next = rows.filter((e) => e !== there);
      replacedGhost++;
    } else {
      next = rows.filter((e) => e !== old);
      dropped++;
    }
    doc.employees = next;
    if (typeof buildSummary === "function") doc.summary = buildSummary(next);
    doc.markModified("employees");
    await doc.save();
  }
  return { moved, replacedGhost, dropped, dates: docs.map((d) => d.dateStr).sort() };
}

/** Lift the holds on `toId` for the given months (HR chose to, in words). */
async function liftHolds({ toId, months }) {
  if (!months?.length) return 0;
  const r = await AttendanceExclusion.deleteMany({ biometricId: up(toId), yearMonth: { $in: months } });
  return r.deletedCount || 0;
}

module.exports = { previewRekey, rekeyAttendanceRows, liftHolds };
