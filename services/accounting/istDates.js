"use strict";

/**
 * A date the accountant picks is an INDIAN calendar day (16 Oct 2026).
 *
 * `new Date("2026-04-01")` is UTC midnight — 05:30 in India — so a range built
 * that way starts five and a half hours late and ends five and a half hours
 * early. On this company 505 of the 1,959 vouchers (the Tally import, payroll)
 * are stored at India's midnight, 18:30 UTC the evening BEFORE, so every such
 * range dropped the vouchers of its first day and took in the next day's. The
 * day book, trial balance and P&L have always read days in India
 * (Acc_books.js parseDateRange); every other list now reads them the same way.
 *
 * A plain "YYYY-MM-DD" is read as that day in India: istStart = 00:00:00.000
 * IST, istEnd = 23:59:59.999 IST. Anything else (a full ISO timestamp, a Date)
 * is taken as the instant it already is. Empty → null.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function istStart(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  return DAY.test(s) ? new Date(`${s}T00:00:00.000+05:30`) : new Date(s);
}

function istEnd(v) {
  if (v === undefined || v === null || v === "") return null;
  if (v instanceof Date) return v;
  const s = String(v).trim();
  return DAY.test(s) ? new Date(`${s}T23:59:59.999+05:30`) : new Date(s);
}

/** The first and last instant of a calendar month in India (month 1–12). */
function istMonthBounds(year, month) {
  const IST = 330 * 60000;
  return {
    from: new Date(Date.UTC(year, month - 1, 1) - IST),
    to: new Date(Date.UTC(year, month, 1) - IST - 1),
  };
}

/** The India calendar day an instant falls on, "YYYY-MM-DD" — whatever the
    server's own time zone. */
function istYmd(d) {
  if (d === undefined || d === null || d === "") return null;
  const t = new Date(d).getTime();
  if (Number.isNaN(t)) return null;
  return new Date(t + 330 * 60000).toISOString().slice(0, 10);
}

/** The Indian financial year's start year for an instant (Apr–Mar, in India). */
function istFyStartYear(d) {
  const [y, m] = istYmd(d).split("-").map(Number);
  return m >= 4 ? y : y - 1;
}

module.exports = { istStart, istEnd, istMonthBounds, istYmd, istFyStartYear };
