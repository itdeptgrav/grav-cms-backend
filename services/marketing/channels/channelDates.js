// services/marketing/channels/channelDates.js
//
// ONE STRICT CALENDAR DATE VALIDATOR, FOR EVERY CHANNEL CALL SITE.
//
// ── A SHAPE CHECK IS NOT A DATE CHECK ──────────────────────────────────────
// `/^\d{4}-\d{2}-\d{2}$/` accepts `2026-02-31`, `2026-13-01`, `2026-00-10` and
// `2025-02-29`. Every one of those looks like a date, passes the pattern, and is
// then sent to a provider — which either rejects it as a malformed request that
// GRAV surfaces as "the API changed", or, worse, silently normalises it. Google
// Ads has been known to accept an overflowing day and report on the month that
// followed, so a report labelled February would quietly contain March.
//
// ── ROUND-TRIPPED, NOT PARSED ──────────────────────────────────────────────
// `new Date("2026-02-31")` does not throw. It rolls over to 3 March and reports
// a perfectly valid timestamp, so parsing alone proves nothing. The only honest
// check is to build the date, read the year, month and day back out, and require
// that all three survived. A rollover changes at least one of them.
//
// UTC throughout, because these are calendar dates a provider will interpret in
// its own account timezone — not instants. Using local getters would make the
// same string valid or invalid depending on where the server happens to run.
"use strict";

const { fail } = require("../../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

/* Both ends are already proved real by the time this runs, so it can parse
   directly. UTC, so a day count does not change with the server's timezone or
   with a daylight-saving boundary inside the range. */
const utcOf = (isoDate) => {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};

/**
 * A calendar date in `YYYY-MM-DD`, or a refusal.
 *
 * @param {*} value
 * @param {string} field the caller-facing field name, so the refusal is actionable
 * @returns {string} the same string, proved to name a real day
 */
function assertCalendarDate(value, field) {
  const v = str(value);

  const match = SHAPE.exec(v);
  if (!match) {
    throw fail("VALIDATION", `${field} must be a date in YYYY-MM-DD form.`, { field });
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  /* Cheap bounds first, so `2026-13-01` and `2026-00-10` are named as month
     problems rather than reaching the round-trip and coming back as a generic
     "not a real date". */
  if (month < 1 || month > 12) {
    throw fail("VALIDATION", `${field} names month ${match[2]}, which does not exist.`, { field });
  }
  if (day < 1 || day > 31) {
    throw fail("VALIDATION", `${field} names day ${match[3]}, which does not exist.`, { field });
  }

  /* ── THE ROUND TRIP ───────────────────────────────────────────────────────
     `Date.UTC(2026, 1, 31)` is 3 March 2026, not an error. The only way to
     detect that is to read the three components back and require each to be
     what was asked for. This is what catches 31 February, 31 April and
     29 February in a common year — none of which a range check can see. */
  const built = new Date(Date.UTC(year, month - 1, day));
  if (built.getUTCFullYear() !== year
    || built.getUTCMonth() !== month - 1
    || built.getUTCDate() !== day) {
    throw fail("VALIDATION",
      `${field} is not a real date. ${v} does not exist in the calendar.`,
      { field });
  }

  return v;
}

/** The same, but an empty value is allowed and returns null. For optional filters. */
function assertOptionalCalendarDate(value, field) {
  const v = str(value);
  if (!v) return null;
  return assertCalendarDate(v, field);
}

/**
 * A date range, both ends real, ordered, and within a bound.
 *
 * @param {object} args
 * @param {number} args.maxDays inclusive day count the range may not exceed
 * @returns {{startDate:string, endDate:string, days:number}}
 */
function assertDateRange({ startDate, endDate, maxDays, required = true } = {}) {
  const from = str(startDate);
  const to = str(endDate);

  if (!from || !to) {
    if (!required) return null;
    throw fail("VALIDATION",
      "Name the date range. GRAV does not choose one, because a figure read from a range nobody named cannot be reproduced.",
      { fields: ["startDate", "endDate"] });
  }

  const start = assertCalendarDate(from, "startDate");
  const end = assertCalendarDate(to, "endDate");

  if (start > end) {
    /* String comparison is correct for ISO dates and does not depend on a
       timezone the way constructing two Dates and comparing them would. */
    throw fail("VALIDATION", "The start date is after the end date.", { field: "startDate" });
  }

  const days = Math.round((utcOf(end) - utcOf(start)) / 86_400_000) + 1;

  if (Number.isFinite(maxDays) && days > maxDays) {
    throw fail("VALIDATION",
      `A report may cover at most ${maxDays} days. This one covers ${days}.`,
      { field: "endDate", max: maxDays, requested: days });
  }

  return { startDate: start, endDate: end, days };
}

module.exports = { assertCalendarDate, assertOptionalCalendarDate, assertDateRange };
