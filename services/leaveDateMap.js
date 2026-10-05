"use strict";
/**
 * services/leaveDateMap.js — which attendance status each day of an approved
 * leave becomes.
 *
 * Moved out of routes/HrRoutes/Attendance_section.js (5 Oct 2026) so it can be
 * tested without loading a 9,000-line router, and because it had a fault every
 * one of its four callers inherited:
 *
 * ── IT NEVER READ `isHalfDay` ──────────────────────────────────────────────
 * A half-day leave is one date with `totalDays: 0.5` and `paidDays: 0.5`. The
 * loop compared `paidUsed (0) < paidDays (0.5)`, which is true, and handed that
 * date the FULL-DAY code. So every approved half-day leave in the database was
 * written into attendance as a whole day — `L-SL` where it should be `P/SL`,
 * `L-CL` for `P/CL`, `L-EL` for `P/PL`. All twelve checked from August and
 * September 2026 were wrong the same way, and HR could never see a half day
 * that came from the leave flow.
 *
 * It was not only a label. `leaveAmountForStatus` (the day-override's balance
 * sync) counts `L-SL` as 1.0 SL and `P/SL` as 0.5. A half-day leave consumed
 * 0.5 when approved; the moment HR touched that day for any reason, the sync
 * read the stored status as a whole day and refunded 1.0 — handing back half a
 * day nobody had taken.
 *
 * The four callers — apply-on-approval, the per-date re-apply, and the two
 * calendar builders — all take the code verbatim and test it only for
 * truthiness, and every `P/…` code is already a valid status everywhere
 * (the HR override offers them, `leaveAmountForStatus` prices them, the
 * display labels name them). So fixing it here fixes all four, and nothing
 * downstream needed to learn a new word.
 *
 * Full-day leaves are untouched: the loop below is the original, line for line.
 */

/** A whole day of each leave type. */
const LEAVE_TYPE_TO_STATUS = Object.freeze({ CL: "L-CL", SL: "L-SL", PL: "L-EL", LOP: "LWP" });

/** Half a day present, half a day of that leave — the codes the HR override uses. */
const HALF_DAY_LEAVE_STATUS = Object.freeze({ CL: "P/CL", SL: "P/SL", PL: "P/PL" });

/**
 * The attendance calendar's date for a Date — identical to `dateStrOf` in
 * Attendance_section.js (an IST shift read through UTC getters), so a date this
 * module produces is a date that file looks up.
 */
const dateStrOf = (d) => {
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
};

/**
 * @param {object} leaveApp  a LeaveApplication (lean or live)
 * @param {Set<string>|null} holidaySetOrNull  dates to treat as rest days
 * @returns {Map<string,string>} dateStr → status code; rest days are absent
 */
function buildLeaveDateMap(leaveApp, holidaySetOrNull) {
  const totalDays = leaveApp.totalDays || 0;
  const paidDays = leaveApp.paidDays != null ? leaveApp.paidDays : totalDays;
  const leaveCode = LEAVE_TYPE_TO_STATUS[leaveApp.leaveType] || "LWP";
  const isFullLOP = leaveApp.leaveType === "LOP" || paidDays === 0;

  const map = new Map(); // dateStr → statusCode
  let paidUsed = 0;

  const start = new Date(leaveApp.fromDate + "T00:00:00");
  const end = new Date(leaveApp.toDate + "T00:00:00");

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const ds = dateStrOf(new Date(d));
    const dow = new Date(ds + "T00:00:00").getDay();
    const isSunday = dow === 0;
    const isHoliday = holidaySetOrNull ? holidaySetOrNull.has(ds) : false;

    if (isSunday || isHoliday) {
      // Rest day — don't consume a paid slot, skip from map
      continue;
    }

    let code;
    if (leaveApp.isHalfDay) {
      /* THE FIX. A half day is half a day whether it is paid or not: an
         approved half-day with no balance behind it (`paidDays: 0`, all
         LWP) is half present and half unpaid — `P/LWP`, the code payroll
         already deducts half a day for — not a whole day of LWP. */
      code = isFullLOP
        ? "P/LWP"
        : HALF_DAY_LEAVE_STATUS[leaveApp.leaveType] || "P/LWP";
    } else if (isFullLOP) {
      code = "LWP";
    } else if (paidUsed < paidDays) {
      code = leaveCode;
      paidUsed++;
    } else {
      code = "LWP";
    }
    map.set(ds, code);
  }
  return map;
}

module.exports = {
  buildLeaveDateMap,
  LEAVE_TYPE_TO_STATUS,
  HALF_DAY_LEAVE_STATUS,
};
