// services/ppc/capacityCalendar.js
//
// CALENDAR ARITHMETIC ON `YYYY-MM-DD` STRINGS — AND NOTHING THAT KNOWS A ZONE.
//
// Every function here takes business dates as strings and returns strings or
// numbers. The only Date object ever constructed is `Date.UTC(y, m, d)`, used
// purely as a day counter: UTC has no daylight saving and no offset, so adding
// a day is always adding a day and the weekday of a date is always the same
// weekday, whatever `TZ` the server was started with. Reading a date with
// `new Date("2026-10-05")` and then `getDay()` would be correct in London and
// wrong in Los Angeles — a test runs this module under five timezones to prove
// it is never used.
//
// ── A DAY OUTSIDE A VERSION IS UNKNOWN, NOT CLOSED ──────────────────────────
// `netMinutesOn` answers three ways: open with N minutes, closed (0, with the
// reason — a holiday, a weekly rest day), or UNKNOWN because the version does
// not describe that day. The third must never be read as the second. A planner
// who books across a gap in the calendar would be booking against a zero that
// nobody stated.
"use strict";

const { isBusinessDate } = require("./businessDate");

const MS_PER_DAY = 86400000;
const MINUTES_PER_DAY = 1440;

/** The day number since the epoch, computed in UTC only. */
function dayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

function fromDayNumber(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

const addDays = (date, n) => fromDayNumber(dayNumber(date) + n);

/** Inclusive count of days from `a` to `b`. */
const spanDays = (a, b) => dayNumber(b) - dayNumber(a) + 1;

/** Monday = 0 … Sunday = 6, the order a week pattern is written in. */
function weekdayIndex(date) {
  const [y, m, d] = date.split("-").map(Number);
  const sundayFirst = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (sundayFirst + 6) % 7;
}

function* eachDay(from, to) {
  for (let n = dayNumber(from); n <= dayNumber(to); n += 1) yield fromDayNumber(n);
}

const clockMinutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

/**
 * One shift's net working minutes: clock span less its break.
 *
 * A shift that ends earlier on the clock than it starts runs overnight. One that
 * starts and ends at the same minute is refused rather than read as 24 hours or
 * as zero, because either reading would be a guess.
 */
function shiftNetMinutes(shift) {
  const start = clockMinutes(shift.start);
  const end = clockMinutes(shift.end);
  if (start === end) return null;
  const span = end > start ? end - start : end + MINUTES_PER_DAY - start;
  const net = span - Number(shift.breakMinutes || 0);
  return net > 0 ? net : null;
}

const sumShifts = (shifts) => (shifts || [])
  .reduce((acc, s) => acc + (shiftNetMinutes(s) || 0), 0);

/**
 * What one PUBLISHED version says about one date.
 *
 * @returns {{ known: boolean, working: boolean, minutes: number|null,
 *             reason: string, source: string }}
 */
function netMinutesOn(version, date) {
  if (!version || !isBusinessDate(date)) {
    return { known: false, working: false, minutes: null, reason: "NO_CALENDAR", source: "NONE" };
  }
  if (date < version.validFrom || (version.validTo && date > version.validTo)) {
    return {
      known: false, working: false, minutes: null,
      reason: "OUTSIDE_CALENDAR_VERSION", source: "NONE",
    };
  }
  const exception = (version.exceptions || []).find((e) => e.date === date);
  if (exception) {
    if (exception.kind === "WORKING_DAY") {
      const minutes = sumShifts(exception.shifts);
      return {
        known: true, working: minutes > 0, minutes,
        reason: exception.reason, source: "EXCEPTION_WORKING_DAY",
      };
    }
    return {
      known: true, working: false, minutes: 0,
      reason: exception.reason, source: `EXCEPTION_${exception.kind}`,
    };
  }
  const day = (version.weekPattern || [])[weekdayIndex(date)];
  if (!day || !day.working) {
    return { known: true, working: false, minutes: 0, reason: "WEEKLY_REST_DAY", source: "WEEK_PATTERN" };
  }
  const minutes = sumShifts(day.shifts);
  return { known: true, working: minutes > 0, minutes, reason: "", source: "WEEK_PATTERN" };
}

/**
 * Validate the content of a version a person is writing.
 *
 * Returns a list of problems, each naming its field, rather than throwing on the
 * first — a calendar is long, and fixing one mistake per round trip is how a
 * planner gives up and types a guess.
 */
function contentProblems({ validFrom, validTo, weekPattern, exceptions }) {
  const problems = [];
  if (!isBusinessDate(validFrom)) problems.push({ field: "validFrom", problem: "Write the first day as YYYY-MM-DD." });
  if (validTo !== null && validTo !== undefined && validTo !== "") {
    if (!isBusinessDate(validTo)) problems.push({ field: "validTo", problem: "Write the last day as YYYY-MM-DD." });
    else if (isBusinessDate(validFrom) && validTo < validFrom) {
      problems.push({ field: "validTo", problem: "The last day is before the first." });
    }
  }
  if (!Array.isArray(weekPattern) || weekPattern.length !== 7) {
    problems.push({ field: "weekPattern", problem: "A week pattern has seven days, Monday first." });
  } else {
    weekPattern.forEach((day, i) => {
      if (typeof day?.working !== "boolean") {
        problems.push({ field: `weekPattern[${i}].working`, problem: "Say whether this weekday is worked." });
        return;
      }
      if (day.working && !(day.shifts || []).length) {
        problems.push({ field: `weekPattern[${i}].shifts`, problem: "A working day needs at least one shift." });
      }
      if (!day.working && (day.shifts || []).length) {
        problems.push({ field: `weekPattern[${i}].shifts`, problem: "A rest day carries no shifts." });
      }
      (day.shifts || []).forEach((s, j) => {
        if (shiftNetMinutes(s) === null) {
          problems.push({ field: `weekPattern[${i}].shifts[${j}]`,
            problem: "A shift needs different start and end times and more working time than its break." });
        }
      });
    });
  }
  const seen = new Set();
  (exceptions || []).forEach((e, i) => {
    if (!isBusinessDate(e?.date)) {
      problems.push({ field: `exceptions[${i}].date`, problem: "Write the date as YYYY-MM-DD." });
      return;
    }
    if (seen.has(e.date)) problems.push({ field: `exceptions[${i}].date`, problem: "Two exceptions name the same day." });
    seen.add(e.date);
    if (!String(e.reason || "").trim()) {
      problems.push({ field: `exceptions[${i}].reason`, problem: "Say why this day is different." });
    }
    if (e.kind === "WORKING_DAY") {
      if (!(e.shifts || []).length || (e.shifts || []).some((s) => shiftNetMinutes(s) === null)) {
        problems.push({ field: `exceptions[${i}].shifts`, problem: "A make-up working day needs valid shifts." });
      }
    } else if ((e.shifts || []).length) {
      problems.push({ field: `exceptions[${i}].shifts`, problem: "Only a working day carries shifts." });
    }
  });
  return problems;
}

module.exports = {
  dayNumber, addDays, spanDays, weekdayIndex, eachDay,
  shiftNetMinutes, sumShifts, netMinutesOn, contentProblems,
};
