"use strict";
/**
 * services/lateStreak.js — the late / early-out streak (HR policy).
 *
 * Moved out of routes/HrRoutes/Attendance_section.js (5 Oct 2026) so it can be
 * tested; Attendance_section and Payroll_section both use it through the
 * route module's re-export, unchanged.
 */

// ─────────────────────────────────────────────────────────────────────────────
// COUNT-BASED LATE/EARLY PROMOTION HELPER (per HR policy doc)
//   1st, 2nd late → P* (no deduction)
//   Nth late (lateHDOnCount=3)       → HD, counter resets
//   Nth late (lateFullDayOnCount=5)  → AB, counter resets
//   Same rule for early-out (P~) with earlyOut* settings
//   HR overrides and today are never promoted.
//
// state = { lateCount, earlyCount }  — mutated in-place
// Returns { promotedStatus: "HD"|"AB"|null, promoted: bool }
// ─────────────────────────────────────────────────────────────────────────────
function applyLateCountPromotion(entry, state, policy, dateStr, todayStr) {
  const none = { promotedStatus: null, promoted: false };
  if (!policy?.enabled) return none;
  const lateHDOn = policy.lateHDOnCount ?? 3;
  const lateFullDayOn = policy.lateFullDayOnCount ?? 5;
  const earlyHDOn = policy.earlyOutHDOnCount ?? 3;
  const earlyFullDayOn = policy.earlyOutFullDayOnCount ?? 5;

  /* WHAT COUNTS IS THE RAW LATENESS, NOT WHAT HR DECIDED ABOUT THE DAY.
     This used to return before incrementing whenever HR had overridden the
     day. So when HR pardoned somebody's 3rd late by marking it Present, that
     day vanished from the streak and the NEXT late inherited its position —
     the 4th late became "the 3rd" and was docked a half day. The pardon
     moved the penalty instead of removing it.

     A pardon forgives the deduction on that day. It does not un-late the day.
     So the count always advances on a raw late; only the PROMOTION is
     withheld when HR has already ruled on the day, or the day is still today
     and not yet over. */
  /* …AND A LEAVE OR ABSENT OVERRIDE MUST NOT UN-LATE THE DAY EITHER (5 Oct
     2026). Choosing a status with no times (PL, CL, SL, LWP, Absent, a
     holiday) used to send inTime/finalOut as null; the override route wiped
     the punches and recomputed `isLate` from nothing — false. So the 3rd late
     covered by PL dropped out of the streak and the 4th late was docked a
     half day in its place: exactly the pardon-moves-the-penalty bug above,
     through a different door. Both dialogs and the route now leave the
     punches alone for those statuses; for a day that was wiped anyway, the
     sync-time verdict stands. `systemPrediction` is not recomputed while HR
     has ruled on the day, so P* there is what the device recorded.

     Only an explicit null counts as wiped. A projection that did not select
     `inTime` reads it as undefined and keeps the old rule; and a day whose
     time HR CORRECTED to on-time still has an inTime, so its recomputed
     isLate=false is believed — a fixed device error is not a late. */
  const timesWiped = !!entry.hrFinalStatus && entry.inTime === null;
  const rawLate =
    (!!entry.isLate || timesWiped) &&
    ["P*", "LHD", "LAB"].includes(entry.systemPrediction);
  const rawEarly =
    !rawLate &&
    !!entry.isEarlyDeparture &&
    ["P~", "EAB"].includes(entry.systemPrediction);
  const mayPromote = !entry.hrFinalStatus && dateStr !== todayStr;

  if (rawLate) {
    state.lateCount++;
    if (state.lateCount >= lateFullDayOn) {
      state.lateCount = 0;
      return mayPromote ? { promotedStatus: "LAB", promoted: true } : none;
    }
    if (state.lateCount === lateHDOn) {
      return mayPromote ? { promotedStatus: "LHD", promoted: true } : none;
    }
    return none; // 4th (and any other in-between) late: counted, not docked
  }
  if (rawEarly) {
    state.earlyCount++;
    if (state.earlyCount >= earlyFullDayOn) {
      state.earlyCount = 0;
      return mayPromote ? { promotedStatus: "EAB", promoted: true } : none;
    }
    if (state.earlyCount === earlyHDOn) {
      return mayPromote ? { promotedStatus: "HD", promoted: true } : none;
    }
  }
  return none;
}

module.exports = { applyLateCountPromotion };
