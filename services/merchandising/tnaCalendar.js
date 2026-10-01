// services/merchandising/tnaCalendar.js
//
// WORKING-DAY ARITHMETIC, DETERMINISTIC AND WITHOUT A CLOCK.
//
// Every date this module handles is a CALENDAR DATE, not an instant. "Fabric
// in-house on 12 March" is the same fact in Delhi and in London, and the moment
// it becomes a `Date` it stops being that fact: `new Date("2026-03-12")` is
// midnight UTC, which is 11 March to anything reading it west of Greenwich and
// 12 March to anything east. A milestone that moves a day when a server is
// redeployed in another region is the defect this module exists to prevent.
//
// So the type is `String`, `YYYY-MM-DD`, throughout — and the arithmetic is
// done on an integer day number, never with `setDate`, never through `Date`,
// and therefore never through a DST transition.
//
// ── NO I/O, NO CLOCK, NO DATABASE ───────────────────────────────────────────
// Everything here is a pure function of its arguments. `todayInZone` is the one
// function that reads the wall clock, and it takes the zone explicitly rather
// than trusting the server's — "is this overdue" must be answered in the
// calendar's timezone, not in whichever region the process happens to run.
//
// ── AND IT ITERATES DAY BY DAY, ON PURPOSE ──────────────────────────────────
// `addWorkingDays` walks one day at a time. Week arithmetic would be faster and
// wrong: the exception list can declare a Tuesday a holiday and a Sunday a
// working day, so no closed form survives contact with a real calendar. At M5
// volumes — lead times of tens to low hundreds of days — the loop is fast,
// obviously correct, and trivially testable.
"use strict";

const { fail } = require("../storePurchase/errors");

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Is this a calendar date this module will accept? */
const isDateOnly = (v) => typeof v === "string" && DATE_ONLY.test(v);

function assertDate(value, field = "date") {
  if (!isDateOnly(value)) {
    throw fail("VALIDATION",
      `"${value}" is not a calendar date. Dates are written YYYY-MM-DD.`, { field });
  }
  return value;
}

/* ═══ CIVIL DATE ↔ DAY NUMBER ══════════════════════════════════════════════
   Howard Hinnant's days-from-civil algorithm. Exact for every date this
   system will ever hold, and entirely integer — which is what makes the rest
   of the module free of timezone behaviour. */

/** `YYYY-MM-DD` → days since 1970-01-01. */
function toDayNumber(dateStr) {
  assertDate(dateStr);
  const y = Number(dateStr.slice(0, 4));
  const m = Number(dateStr.slice(5, 7));
  const d = Number(dateStr.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > 31) {
    throw fail("VALIDATION", `"${dateStr}" is not a real calendar date.`, { field: "date" });
  }
  const yAdj = y - (m <= 2 ? 1 : 0);
  const era = Math.floor((yAdj >= 0 ? yAdj : yAdj - 399) / 400);
  const yoe = yAdj - era * 400;                                   // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Days since 1970-01-01 → `YYYY-MM-DD`. */
function fromDayNumber(z) {
  const zz = z + 719468;
  const era = Math.floor((zz >= 0 ? zz : zz - 146096) / 146097);
  const doe = zz - era * 146097;                                  // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524)
    - Math.floor(doe / 146096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  const year = y + (m <= 2 ? 1 : 0);
  return `${String(year).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** 0 = Monday … 6 = Sunday. 1970-01-01 was a Thursday, hence the +3. */
function mondayIndex(dayNumber) {
  return ((dayNumber + 3) % 7 + 7) % 7;
}

/* ═══ THE CALENDAR VERSION ═════════════════════════════════════════════════ */

/**
 * Index a calendar version once, so a long walk does not scan the exception
 * list on every step.
 *
 * Accepts a mongoose document or a plain object; a plan's forecast pass reads
 * one version many times and should not care which it was handed.
 */
function compile(calendarVersion) {
  if (calendarVersion && calendarVersion.__compiled) return calendarVersion;
  const raw = calendarVersion?.toObject ? calendarVersion.toObject() : (calendarVersion || {});
  const week = Array.isArray(raw.weekPattern) && raw.weekPattern.length === 7
    ? raw.weekPattern.map(Boolean)
    /* Monday–Friday, if a version somehow carries no pattern. Stated rather
       than assumed silently — a calendar with no pattern is a configuration
       error, and the publish guard refuses one. */
    : [true, true, true, true, true, false, false];

  const exceptions = new Map();
  for (const ex of raw.exceptions || []) {
    /* `working` must actually BE a boolean. Coercing here — `Boolean(undefined)`
       — would turn a misspelt field into a declared holiday, and a holiday
       nobody declared pushes every downstream date by a day with nothing in
       the record to show why. The publish validation refuses a non-boolean,
       so an ignored row here means data that predates it. */
    if (isDateOnly(ex?.date) && typeof ex.working === "boolean") {
      exceptions.set(ex.date, ex.working);
    }
  }
  return {
    __compiled: true,
    week,
    exceptions,
    horizonTo: isDateOnly(raw.horizonTo) ? raw.horizonTo : null,
    timezone: String(raw.timezone || "Asia/Kolkata"),
    calendarRef: String(raw.calendarRef || ""),
    versionNo: raw.versionNo ?? null,
  };
}

/**
 * Refuse to answer past the calendar's horizon.
 *
 * A calendar that answered for ever would quietly assume this company's
 * holidays are known until 2099. A plan whose forecast reaches the horizon is
 * a real operational signal: somebody must extend the calendar.
 */
function assertWithinHorizon(dateStr, cal) {
  if (cal.horizonTo && dateStr > cal.horizonTo) {
    throw fail("TNA_CALENDAR_HORIZON",
      `The working calendar answers up to ${cal.horizonTo}, and this needs ${dateStr}. `
      + "Extend the calendar before planning past it.",
      { horizonTo: cal.horizonTo, requested: dateStr, calendarRef: cal.calendarRef });
  }
}

/* ═══ THE FOUR PUBLIC RULES ════════════════════════════════════════════════ */

/** Is this date worked, per the week pattern and this version's exceptions? */
function isWorkingDay(dateStr, calendarVersion) {
  const cal = compile(calendarVersion);
  assertDate(dateStr);
  /* An exception overrides the pattern in BOTH directions: a declared holiday
     on a Tuesday, and a worked Sunday. */
  if (cal.exceptions.has(dateStr)) return cal.exceptions.get(dateStr);
  return cal.week[mondayIndex(toDayNumber(dateStr))] === true;
}

/**
 * `n` working days after `dateStr` — or before it, when `n` is negative.
 *
 * `n = 0` returns the date UNCHANGED, even when it is not a working day. This
 * is arithmetic, not rounding: "the day itself" is an answer, and quietly
 * shifting a Sunday to a Monday would make `addWorkingDays(d, 0)` a different
 * function from the identity everybody assumes it is.
 */
function addWorkingDays(dateStr, n, calendarVersion) {
  const cal = compile(calendarVersion);
  assertDate(dateStr);
  const steps = Number(n);
  if (!Number.isInteger(steps)) {
    throw fail("VALIDATION", "Working days must be a whole number.", { field: "offsetWorkingDays" });
  }
  if (steps === 0) {
    assertWithinHorizon(dateStr, cal);
    return dateStr;
  }

  const direction = steps > 0 ? 1 : -1;
  let remaining = Math.abs(steps);
  let day = toDayNumber(dateStr);

  while (remaining > 0) {
    day += direction;
    const at = fromDayNumber(day);
    /* Checked as the walk goes, so the refusal names the date that could not
       be answered rather than the far end of a long offset. */
    if (direction > 0) assertWithinHorizon(at, cal);
    if (isWorkingDay(at, cal)) remaining -= 1;
  }
  return fromDayNumber(day);
}

/**
 * Working days from `fromStr` to `toStr`, counting the days AFTER the start up
 * to and including the end — the inverse of `addWorkingDays`.
 *
 * Negative when `toStr` is earlier. Consistent in both directions by
 * construction, which is the property the tests hold it to.
 */
function workingDaysBetween(fromStr, toStr, calendarVersion) {
  const cal = compile(calendarVersion);
  assertDate(fromStr, "from");
  assertDate(toStr, "to");
  if (fromStr === toStr) return 0;

  const backwards = toStr < fromStr;
  const start = toDayNumber(backwards ? toStr : fromStr);
  const end = toDayNumber(backwards ? fromStr : toStr);

  let count = 0;
  for (let day = start + 1; day <= end; day += 1) {
    if (isWorkingDay(fromDayNumber(day), cal)) count += 1;
  }
  return backwards ? -count : count;
}

/**
 * Today, as a calendar date, in the calendar's own timezone.
 *
 * Never `new Date()` compared against a stored string: a server in Los Angeles
 * would call a Delhi milestone overdue half a day early, every day.
 */
function todayInZone(timezone = "Asia/Kolkata", instant = undefined) {
  /* An explicit instant is how a source event's UTC timestamp becomes the
     calendar date the plan runs on — a 23:40 UTC approval is tomorrow in
     Delhi, and tomorrow is the date the merchandiser will look for. */
  const when = instant instanceof Date && !Number.isNaN(instant.getTime()) ? instant : new Date();
  try {
    /* `en-CA` formats as YYYY-MM-DD, which is exactly the shape stored. */
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: String(timezone), year: "numeric", month: "2-digit", day: "2-digit",
    }).format(when);
  } catch {
    /* An unknown zone must not take the register down. UTC is stated rather
       than guessed, and the calendar's own validation refuses a bad zone at
       publish so this should be unreachable. */
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit",
    }).format(when);
  }
}

/** Whether an IANA zone is one this runtime understands. */
function isKnownTimezone(tz) {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: String(tz) });
    return true;
  } catch {
    return false;
  }
}

/** Every day in a range, with its answer — how a person checks a calendar. */
function explainRange(fromStr, toStr, calendarVersion) {
  const cal = compile(calendarVersion);
  assertDate(fromStr, "from");
  assertDate(toStr, "to");
  if (toStr < fromStr) {
    throw fail("VALIDATION", "The range ends before it starts.", { field: "to" });
  }
  const out = [];
  for (let day = toDayNumber(fromStr); day <= toDayNumber(toStr); day += 1) {
    const date = fromDayNumber(day);
    out.push({
      date,
      working: isWorkingDay(date, cal),
      /* Why, so a reader can tell a weekend from a declared holiday. */
      reason: cal.exceptions.has(date) ? "EXCEPTION" : "WEEK_PATTERN",
    });
    if (out.length > 400) break;                 // a bounded, honest answer
  }
  return out;
}

module.exports = {
  DATE_ONLY, isDateOnly, assertDate,
  toDayNumber, fromDayNumber, mondayIndex,
  compile, isWorkingDay, addWorkingDays, workingDaysBetween,
  todayInZone, isKnownTimezone, explainRange,
};
