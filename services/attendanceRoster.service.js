"use strict";

/**
 * Who was on the attendance roll, for which months.
 *
 * Every surface that lists employees against days — the daily register, the
 * muster roll, the exported sheet, and the sync that writes the rows in the
 * first place — has to agree on this, or HR removes somebody and watches them
 * come back somewhere else. So the question is answered in one place.
 *
 * See models/HR_Models/AttendanceExclusion.js for why removal is a stored
 * record rather than a one-off delete.
 */

const AttendanceExclusion = require("../models/HR_Models/AttendanceExclusion");

/** "2026-08-14" → "2026-08". Accepts a bare "YYYY-MM" unchanged. */
function yearMonthOf(dateStr) {
  return String(dateStr || "").slice(0, 7);
}

/**
 * Every "YYYY-MM" touched by an inclusive YYYY-MM-DD range.
 *
 * Walked as a month counter rather than by stepping a Date, because
 * `setMonth(+1)` on the 31st overflows into the month after next and a range
 * ending in a short month would lose its last month.
 */
function monthsInRange(from, to) {
  const out = [];
  const [fy, fm] = yearMonthOf(from).split("-").map(Number);
  const [ty, tm] = yearMonthOf(to).split("-").map(Number);
  if (!fy || !fm || !ty || !tm) return out;
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); ) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/**
 * biometricId (upper) → Set of the months in this range they are off the roll
 * for. One query for the whole range.
 *
 * Callers get a Map rather than a flat Set on purpose: an employee removed
 * from September was still here in August, and a quarterly sheet has to show
 * both facts on one row.
 */
async function loadExclusionMap(from, to) {
  const months = monthsInRange(from, to);
  const map = new Map();
  if (!months.length) return map;
  const rows = await AttendanceExclusion.find({ yearMonth: { $in: months } })
    .select("biometricId yearMonth")
    .lean();
  for (const r of rows) {
    const bid = String(r.biometricId || "").toUpperCase();
    if (!bid) continue;
    if (!map.has(bid)) map.set(bid, new Set());
    map.get(bid).add(r.yearMonth);
  }
  return map;
}

/** The biometric ids taken off the roll for one month. */
async function excludedBidsForMonth(yearMonth) {
  const rows = await AttendanceExclusion.find({ yearMonth })
    .select("biometricId")
    .lean();
  return new Set(
    rows.map((r) => String(r.biometricId || "").toUpperCase()).filter(Boolean),
  );
}

/**
 * True when this person is off the roll for EVERY month the range covers —
 * i.e. the sheet has nothing to say about them and they should not be a row
 * on it at all. Excluded from only part of the range, they stay, and the
 * excluded days render as "not on the roll" instead.
 */
function excludedForWholeRange(exclusionMap, bid, from, to) {
  const months = monthsInRange(from, to);
  if (!months.length) return false;
  const theirs = exclusionMap.get(String(bid || "").toUpperCase());
  if (!theirs || !theirs.size) return false;
  return months.every((m) => theirs.has(m));
}

/** True when this particular day falls in a month they were removed from. */
function excludedOnDate(exclusionMap, bid, dateStr) {
  const theirs = exclusionMap.get(String(bid || "").toUpperCase());
  return Boolean(theirs && theirs.has(yearMonthOf(dateStr)));
}

/**
 * Who belongs on a sheet covering `from`..`to`.
 *
 * The rule, and why each clause is there:
 *
 *   A daily document carries a row for everybody the device reported that
 *   day, so the people with a row anywhere in the period ARE the period's
 *   roll. The employee record cannot answer this — there is no leaving date
 *   on it, and people who have left are routinely still flagged active — so
 *   before this, every active employee appeared on every month's sheet with
 *   A on each day they were not there. Fourteen people were collecting
 *   columns of absences on months they had already left.
 *
 * Three things must never be mistaken for "not on the roll", and each is a
 * clause below: a period nothing has been synced for, somebody away on
 * approved leave, and somebody who joined so recently that no synced day
 * could have recorded them yet.
 *
 * Returns a predicate over the biometric id. Callers pass the facts; this
 * decides, so the exported sheet and the screen cannot drift apart.
 */
function rollMembership({
  from,
  to,
  seenInRange, // Set<bid> — every id with a row in the period
  lastRegisterDay, // the last dateStr the register actually holds, or null
  exclusionMap = new Map(),
  dojByBid = new Map(),
  onLeaveInRange = new Set(),
  leaveUnknown = false,
}) {
  const rangeHasAttendance = seenInRange.size > 0;
  /**
   * @param bidRaw     the employee's biometric id
   * @param isOnStaff  whether the employee record still says they are with
   *                   the company. Only consulted when there is no
   *                   attendance to judge by at all.
   */
  return (bidRaw, isOnStaff = true) => {
    const bid = String(bidRaw || "").toUpperCase();
    // Removed from every month this sheet covers: HR's own answer, and it
    // outranks anything inferred from rows.
    if (bid && excludedForWholeRange(exclusionMap, bid, from, to)) return false;
    // On the roll, plainly.
    if (bid && seenInRange.has(bid)) return true;
    // No biometric id — nothing to judge them by, so judge them present.
    if (!bid) return true;
    /* Nothing written for this period at all: a future month, or a sync that
       has not run. There is no evidence either way, so fall back to the
       employee record — which is weak (people who have left are routinely
       still flagged active) but is the only thing left, and is right about
       the people it is sure of. A muster roll must never be emptied by a sync
       that is merely behind. */
    if (!rangeHasAttendance) return isOnStaff;
    // Away on approved leave — absent, not gone.
    if (leaveUnknown || onLeaveInRange.has(bid)) return true;
    // Joined by the end of the period, and so recently that no synced day
    // could have carried them yet.
    const doj = dojByBid.get(bid);
    if (doj && doj <= to && (!lastRegisterDay || doj >= lastRegisterDay))
      return true;
    return false;
  };
}

/**
 * The biometric ids with approved leave overlapping a period.
 *
 * Kept here rather than in the route because the sheet's leave codes come
 * from the attendance rows: somebody on leave for a whole month has no rows
 * to be found by, and dropping them would be the same mistake in the
 * opposite direction.
 */
async function leaveBidsInRange(LeaveApplication, from, to) {
  const apps = await LeaveApplication.find({
    status: { $in: ["hr_approved", "withdraw_pending"] },
    startDate: { $lte: new Date(`${to}T23:59:59.999+05:30`) },
    endDate: { $gte: new Date(`${from}T00:00:00.000+05:30`) },
  })
    .select("biometricId")
    .lean();
  const out = new Set();
  for (const a of apps) {
    const b = String(a.biometricId || "").toUpperCase();
    if (b) out.add(b);
  }
  return out;
}

module.exports = {
  yearMonthOf,
  monthsInRange,
  rollMembership,
  leaveBidsInRange,
  loadExclusionMap,
  excludedBidsForMonth,
  excludedForWholeRange,
  excludedOnDate,
};
