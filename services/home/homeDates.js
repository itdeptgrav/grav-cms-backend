// services/home/homeDates.js
//
// Pure date arithmetic for the employee home (GET /api/me/home). No database,
// no clock beyond the `now` passed in — tested in homeDates.test.js.
//
// Every day here is a day on India's calendar, read the way the rest of the
// backend reads it: `Date.now() + 5.5h`, then the UTC getters (CLAUDE.md,
// Domain notes). A date of birth or of joining is stored as a UTC midnight of
// the day picked, so its UTC getters ARE the calendar day.
//
// Two bugs in /api/employee/dashboard's birthday list are deliberately not
// repeated: it builds the birthday in the CURRENT year, so in late December
// every January birthday is missed; and it compares instants, so today's
// birthday drops out once the server clock passes midnight UTC.

"use strict";

const IST_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** {y, m, d} of today in India. m is 0-11. */
function istToday(now = new Date()) {
  const t = new Date(now.getTime() + IST_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/** "YYYY-MM-DD" of today in India — the form CompanyHoliday, LeaveApplication and DailyAttendance store. */
function istDateStr(now = new Date()) {
  const { y, m, d } = istToday(now);
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** {m, d} of a stored calendar date, or null. */
function monthDayOf(value) {
  if (!value) return null;
  const t = new Date(value);
  if (Number.isNaN(t.getTime())) return null;
  return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
}

/**
 * Days from today until the next occurrence of a month/day (0 = today).
 * 29 Feb falls on 28 Feb in a common year, as people celebrate it.
 */
function daysUntilNext({ m, d }, now = new Date()) {
  const today = istToday(now);
  const base = Date.UTC(today.y, today.m, today.d);
  const at = (y) => {
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const day = m === 1 && d === 29 && !leap ? 28 : d;
    return Date.UTC(y, m, day);
  };
  let next = at(today.y);
  if (next < base) next = at(today.y + 1);
  return Math.round((next - base) / DAY_MS);
}

/** Whole days since a stored date (0 = today, negative = in the future). */
function daysSince(value, now = new Date()) {
  const md = monthDayOf(value);
  if (!md) return null;
  const today = istToday(now);
  return Math.round((Date.UTC(today.y, today.m, today.d) - Date.UTC(md.y, md.m, md.d)) / DAY_MS);
}

/**
 * Upcoming birthdays, work anniversaries and recent joiners from a list of
 * people. A person is `{ id, name, dateOfBirth, dateOfJoining, ... }`; the
 * extra fields ride through untouched. The year of birth never leaves here.
 */
function peopleMoments(people, { now = new Date(), withinDays = 14, joinedWithinDays = 30, limit = 8 } = {}) {
  const birthdays = [];
  const anniversaries = [];
  const joiners = [];
  const today = istToday(now);

  for (const p of people || []) {
    const { dateOfBirth, dateOfJoining, ...rest } = p;
    const dob = monthDayOf(dateOfBirth);
    if (dob) {
      const inDays = daysUntilNext(dob, now);
      if (inDays <= withinDays) birthdays.push({ ...rest, inDays, month: dob.m + 1, day: dob.d });
    }
    const doj = monthDayOf(dateOfJoining);
    if (doj) {
      const since = daysSince(dateOfJoining, now);
      if (since !== null && since >= 0 && since <= joinedWithinDays) {
        joiners.push({ ...rest, joinedDaysAgo: since, joinedOn: istDateOf(doj) });
      }
      const inDays = daysUntilNext(doj, now);
      // The year the anniversary falls in, minus the year they joined.
      const annYear = Date.UTC(today.y, doj.m, doj.d) >= Date.UTC(today.y, today.m, today.d) ? today.y : today.y + 1;
      const years = annYear - doj.y;
      if (years >= 1 && inDays <= withinDays) anniversaries.push({ ...rest, inDays, years, month: doj.m + 1, day: doj.d });
    }
  }

  const soonest = (a, b) => a.inDays - b.inDays || String(a.name).localeCompare(String(b.name));
  birthdays.sort(soonest);
  anniversaries.sort(soonest);
  joiners.sort((a, b) => a.joinedDaysAgo - b.joinedDaysAgo || String(a.name).localeCompare(String(b.name)));
  return {
    birthdays: birthdays.slice(0, limit),
    anniversaries: anniversaries.slice(0, limit),
    joiners: joiners.slice(0, limit),
  };
}

function istDateOf({ y, m, d }) {
  return `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** Does a leave's `fromDate`..`toDate` (YYYY-MM-DD strings) cover a day? */
function covers(from, to, day) {
  const f = String(from || "").slice(0, 10);
  const t = String(to || from || "").slice(0, 10);
  return Boolean(f) && f <= day && day <= t;
}

/** A meeting time of any stored form (ISO string, Date, Firestore Timestamp) as a Date, or null. */
function asDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v.toDate === "function") return v.toDate();
  if (typeof v === "object" && typeof v._seconds === "number") return new Date(v._seconds * 1000);
  const t = new Date(v);
  return Number.isNaN(t.getTime()) ? null : t;
}

/** Is an instant on today's India calendar day? */
function isTodayIst(when, now = new Date()) {
  const d = asDate(when);
  return Boolean(d) && istDateStr(d) === istDateStr(now);
}

/** Display name from an Employee's name parts. */
function displayName(e) {
  if (!e) return "";
  const parts = [e.firstName, e.lastName].map((s) => String(s || "").trim()).filter(Boolean);
  return parts.join(" ") || String(e.name || "").trim();
}

module.exports = {
  istToday, istDateStr, daysUntilNext, daysSince, peopleMoments, covers, asDate, isTodayIst, displayName,
};
