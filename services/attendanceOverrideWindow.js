// services/attendanceOverrideWindow.js
//
// THE ATTENDANCE OVERRIDE IS BEING RETIRED (14 Oct 2026, owner).
//
// HR could set any day to any status ("HR Override") and add, move or remove
// punches ("punch correction"). The owner wants both gone: attendance comes
// from the device, leave and regularization are applied for from the app, and
// holidays are defined in settings — a resync puts everything right. But "not
// now, let it be some more days", so the override keeps working until the
// SUNSET below and then switches itself off. Nothing has to be deployed on the
// day.
//
// ONE THING STAYS FOR GOOD: crediting a rest day somebody worked. Nobody can
// apply for comp-off from the app (regularization refuses a week-off or a
// holiday), and asking everyone who worked an extra day to apply would be
// worse. So after the sunset HR may still set a WEEK-OFF or HOLIDAY day to
// comp-off, Present or Half day — and take that back — and nothing else.
//
// Days already overridden are left exactly as they are (owner's decision); the
// resync merge keeps preserving them. Only new overrides stop.
"use strict";

/** The last day (IST) on which the full override still works. Extend with HR_OVERRIDE_SUNSET=YYYY-MM-DD. */
const DEFAULT_SUNSET = "2026-10-31";
/** A day the system already reads as a week-off or a holiday. */
const REST_DAY_CODES = Object.freeze(["WO", "FH", "NH", "OH", "RH", "PH"]);
/** What a worked rest day may be credited as after the sunset. */
const REST_DAY_CREDITS = Object.freeze(["CO", "P", "HD"]);

function sunset() {
  const v = String(process.env.HR_OVERRIDE_SUNSET || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : DEFAULT_SUNSET;
}
/** Today's date in India, YYYY-MM-DD. */
function todayIST(now = new Date()) {
  return new Date(now.getTime() + 330 * 60 * 1000).toISOString().slice(0, 10);
}
/** Is the full override (any status, punch corrections) still allowed? */
function overridesOpen(now = new Date()) {
  return todayIST(now) <= sunset();
}
const isRestDay = (code) => REST_DAY_CODES.includes(String(code || ""));

/**
 * After the sunset: may HR set this day to `status`? `row` is the employee's
 * entry for the day (or null when there is none). Returns "" when allowed,
 * else the refusal in words.
 */
function restDayCreditRefusal(row, status) {
  const restCode = row?.systemPrediction;
  if (!row || !isRestDay(restCode)) {
    return `Attendance overrides ended on ${sunset()}. Attendance now comes from the device, and leave and regularization are applied for from the app. Only a worked week-off or holiday can still be credited here.`;
  }
  /* back to what the day is (null / "" / the rest-day code itself) undoes a credit */
  if (status === null || status === "" || status === restCode) return "";
  if (!REST_DAY_CREDITS.includes(status)) {
    return `On a ${restCode} day only ${REST_DAY_CREDITS.join(", ")} can be credited — attendance overrides ended on ${sunset()}.`;
  }
  return "";
}

/** What the screens need to know, one read. */
function windowView(now = new Date()) {
  return {
    sunset: sunset(),
    open: overridesOpen(now),
    today: todayIST(now),
    restDayCodes: [...REST_DAY_CODES],
    restDayCredits: [...REST_DAY_CREDITS],
  };
}

module.exports = { DEFAULT_SUNSET, REST_DAY_CODES, REST_DAY_CREDITS, sunset, todayIST, overridesOpen, isRestDay, restDayCreditRefusal, windowView };
