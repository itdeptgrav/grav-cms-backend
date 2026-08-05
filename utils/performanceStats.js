"use strict";
/**
 * utils/performanceStats.js
 * ───────────────────────────────────────────────────────────────────────────
 * Shared attendance-tally logic for performance reporting.
 *
 * Lifted verbatim from routes/HrRoutes/Performance_section.js so the employee
 * app and the HR dashboard cannot drift apart on what "present" means. These
 * are pure functions over a DailyAttendance.employees[i] row — no I/O, no
 * model imports — which is why they are safe to share.
 *
 * NOTE: Performance_section.js still holds its own copies of these. They are
 * byte-identical today. Collapsing that file onto this module is a mechanical
 * change, deliberately left until the backend can actually be run and the HR
 * performance page re-checked — silently breaking a working HR screen to
 * de-duplicate a helper is a bad trade.
 */

// Statuses that count as "present" for attendance %. Mirrors the set used in
// Attendance_section.js — keep these in sync if you add more codes.
const PRESENT_SET = new Set([
  "P",
  "P*",
  "P~",
  "MP",
  "WFH",
  "P/CL",
  "P/SL",
  "P/PL",
  "P/LWP",
]);
const ABSENT_SET = new Set(["AB", "LAB", "EAB", "LWP"]);
const HALFDAY_SET = new Set(["HD", "LHD"]);
const LEAVE_SET = new Set(["L-CL", "L-SL", "L-EL", "CO"]);
const LATE_SET = new Set(["P*", "LHD", "LAB"]);

function monthsBetween(d1, d2) {
  if (!d1 || !d2) return 0;
  const a = new Date(d1);
  const b = new Date(d2);
  if (isNaN(a) || isNaN(b)) return 0;
  let m =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m);
}

function fullName(e) {
  return [e.firstName, e.middleName, e.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

// Reduce a single DailyAttendance.employees[i] row into category buckets.
// Half-day variants count as Present (the employee was there for half the
// day) AND bump the corresponding leave bucket by 0.5. P/LWP only bumps the
// LOP/half-day-LWP counter, not a leave type.
function tallyEntry(stats, entry) {
  const st = entry.hrFinalStatus || entry.systemPrediction;
  if (!st) return;
  if (PRESENT_SET.has(st)) stats.presentDays++;
  if (ABSENT_SET.has(st)) stats.absentDays++;
  if (HALFDAY_SET.has(st)) stats.halfDays++;
  if (LATE_SET.has(st)) stats.lateDays++;
  if (LEAVE_SET.has(st)) {
    stats.leaveDaysTotal++;
    if (st === "L-CL") stats.clDays++;
    else if (st === "L-SL") stats.slDays++;
    else if (st === "L-EL") stats.plDays++;
  }
  // Half-day leave variants — fractional leave usage.
  if (st === "P/CL") {
    stats.clDays += 0.5;
    stats.leaveDaysTotal += 0.5;
  } else if (st === "P/SL") {
    stats.slDays += 0.5;
    stats.leaveDaysTotal += 0.5;
  } else if (st === "P/PL") {
    stats.plDays += 0.5;
    stats.leaveDaysTotal += 0.5;
  } else if (st === "P/LWP" || st === "LWP") {
    stats.lopDays += st === "P/LWP" ? 0.5 : 1;
  }
}

function blankStats() {
  return {
    presentDays: 0,
    absentDays: 0,
    halfDays: 0,
    lateDays: 0,
    leaveDaysTotal: 0,
    clDays: 0,
    slDays: 0,
    plDays: 0,
    lopDays: 0,
  };
}

module.exports = {
  PRESENT_SET,
  ABSENT_SET,
  HALFDAY_SET,
  LEAVE_SET,
  LATE_SET,
  monthsBetween,
  fullName,
  tallyEntry,
  blankStats,
};
