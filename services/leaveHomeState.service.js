// services/leaveHomeState.service.js
//
// Which state an employee's monthly leave cap is judged against.
//
// ── WHY IT IS THE PERMANENT ADDRESS ─────────────────────────────────────────
// The cap exists because somebody travelling home to another state needs more
// days in one go than somebody who lives here. That is a fact about where home
// IS, not about where the person currently sleeps — and the current address is
// very often a rented room in Bhubaneswar, which is exactly the case the rule
// is meant to give MORE days to.
//
// The code read `current` first and fell back to `permanent`, so an employee
// from West Bengal renting locally was read as Odisha and capped at 7 instead
// of 10. The order is now the other way round.
//
// ── WHEN PERMANENT IS BLANK ─────────────────────────────────────────────────
// Falling back to current is right: a missing permanent address is a gap in
// the record, not a statement that the person is local, and refusing the leave
// application over it would punish the employee for HR's data entry. The
// result says which address it used and whether it had to fall back, so the
// caller can show it and HR can be told to fill the gap.
//
// ── "SAME AS CURRENT" ───────────────────────────────────────────────────────
// The employee form's checkbox COPIES current into permanent at the moment it
// is ticked, so there is no flag to read here — a permanent state is present
// either way, and this function needs no special case. What it does mean is
// that the copy must not be allowed to go stale: see the form, where ticking
// the box now keeps the two in step while it stays ticked.

"use strict";

/** The states the smaller cap applies to, however they are spelled. */
const HOME_STATES = new Set(["odisha", "orissa"]);

const norm = (v) => String(v || "").toLowerCase().trim();

/**
 * Resolve the state a leave cap should be judged against.
 *
 * @param {object} employee  an Employee document (or anything with .address)
 * @returns {{
 *   state: string,        normalised, "" when neither address has one
 *   source: string,       "permanent" | "current" | "none"
 *   usedFallback: boolean the permanent address had no state
 *   sameAsCurrent: boolean both addresses name the same state
 * }}
 */
function resolveLeaveState(employee = {}) {
  const permanent = norm(employee?.address?.permanent?.state);
  const current = norm(employee?.address?.current?.state);

  const state = permanent || current;
  const source = permanent ? "permanent" : current ? "current" : "none";

  return {
    state,
    source,
    usedFallback: !permanent && !!current,
    sameAsCurrent: !!permanent && !!current && permanent === current,
  };
}

/**
 * The monthly cap in days for an employee, from the leave config.
 *
 * Both numbers come from the config with the statutory-ish defaults the routes
 * have always used, so a config missing either field behaves as before.
 */
function monthlyLeaveCap(employee, config = {}) {
  const r = resolveLeaveState(employee);
  const isHome = HOME_STATES.has(r.state);
  return {
    ...r,
    isHomeState: isHome,
    cap: isHome
      ? config.maxLeaveDaysPerMonthOdisha || 7
      : config.maxLeaveDaysPerMonth || 10,
  };
}

module.exports = { resolveLeaveState, monthlyLeaveCap, HOME_STATES };
