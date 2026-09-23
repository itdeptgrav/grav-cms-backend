// services/marketing/contentPlan/zonedTime.js
//
// A LOCAL DATE AND TIME IN A NAMED ZONE, AS AN INSTANT — AND BACK.
//
// ── NO LIBRARY, NO SERVER TIMEZONE ─────────────────────────────────────────
// Everything is computed from `Intl.DateTimeFormat`, which carries the IANA
// database, and from UTC arithmetic. Nothing reads the server's own zone, so a
// calendar built on a server in UTC and one built in India agree.
//
// ── A TIME THAT DOES NOT EXIST IS REFUSED ──────────────────────────────────
// 02:30 on the morning clocks spring forward never happens. Storing it as
// 03:30 would quietly move somebody's plan; storing it as 01:30 would put it
// before a time they did not choose. Both are guesses, so it is refused with
// the reason. A time that happens twice (clocks going back) is the FIRST of the
// two, which is the reading everybody means by "half past one".
"use strict";

const { fail } = require("../../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map();
function formatterFor(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** A recognised IANA zone name, or a refusal. */
function assertTimeZone(value, field = "timeZone") {
  const tz = str(value);
  if (!tz || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(tz)) {
    throw fail("VALIDATION", `${field} must be a time zone name like Asia/Kolkata.`, { field });
  }
  try {
    formatterFor(tz);
  } catch (_) {
    throw fail("VALIDATION", `${field} is not a time zone GRAV recognises. Use a name like Asia/Kolkata.`, { field });
  }
  return tz;
}

/** HH:MM on a 24-hour clock, or a refusal. */
function assertTime(value, field = "time") {
  const v = str(value);
  const m = TIME.exec(v);
  if (!m) throw fail("VALIDATION", `${field} must be a time in 24-hour HH:MM form.`, { field });
  return v;
}

/** The wall-clock parts of an instant, in a zone. */
function partsAt(ms, timeZone) {
  const out = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Minutes the zone is ahead of UTC at this instant. */
function offsetMinutes(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/**
 * The instant a local date and time name in a zone.
 *
 * @param {string} date     YYYY-MM-DD, already proved real
 * @param {string} time     HH:MM, already proved well-formed
 * @param {string} timeZone IANA, already proved recognised
 * @returns {Date}
 */
function toInstant(date, time, timeZone) {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);

  /* The two offsets either side of the wanted moment cover every transition:
     no zone changes offset twice within a day. Each gives a candidate, and a
     candidate counts only if it reads back as exactly the wall time asked for. */
  const candidates = [...new Set([
    offsetMinutes(wall - 12 * 3600_000, timeZone),
    offsetMinutes(wall + 12 * 3600_000, timeZone),
  ])]
    .map((off) => wall - off * 60_000)
    .filter((ms) => {
      const p = partsAt(ms, timeZone);
      return p.year === y && p.month === mo && p.day === d && p.hour === h && p.minute === mi;
    })
    .sort((a, b) => a - b);

  if (!candidates.length) {
    throw fail("VALIDATION",
      `${time} on ${date} does not exist in ${timeZone}: the clocks skip over it. Choose a different time.`,
      { field: "planned.time" });
  }
  return new Date(candidates[0]);
}

/** Midnight at the start of a date in a zone. Midnight can itself be skipped
 *  (a few zones change at 00:00), in which case the first minute that exists. */
function startOfDay(date, timeZone) {
  try {
    return toInstant(date, "00:00", timeZone);
  } catch (_) {
    return toInstant(date, "01:00", timeZone);
  }
}

/** The local date and time of an instant, in a zone. */
function localOf(ms, timeZone) {
  const p = partsAt(ms, timeZone);
  const pad = (n) => String(n).padStart(2, "0");
  return { date: `${p.year}-${pad(p.month)}-${pad(p.day)}`, time: `${pad(p.hour)}:${pad(p.minute)}` };
}

/** The day after a YYYY-MM-DD, as YYYY-MM-DD. Pure calendar arithmetic. */
function nextDate(date) {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

module.exports = {
  assertTimeZone, assertTime, toInstant, startOfDay, localOf, nextDate, offsetMinutes,
};
