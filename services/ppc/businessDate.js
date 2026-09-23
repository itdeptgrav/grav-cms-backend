// services/ppc/businessDate.js
//
// A FACTORY CALENDAR DAY IS NOT AN INSTANT.
//
// "Start production on the 5th of October" names a day on the factory's
// calendar. Stored as a `Date` it becomes midnight in whichever timezone parsed
// it, and every reader in a different timezone sees a different day: a planner
// in Dhaka types the 5th, a server in UTC stores the 4th at 18:00, and a screen
// in Los Angeles prints the 4th. Nothing fails; the plan is simply a day wrong.
//
// So a business date is a validated `YYYY-MM-DD` string from the browser to the
// database and back, and no `Date` is constructed from it anywhere on the way.
// Ordering is a string comparison, which is exact for this format. Events —
// created, planned, held, cancelled, superseded — stay instants, because those
// really are moments.
//
// There are no working-day calculations here. Those belong to capacity planning.
"use strict";

const PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const daysIn = (year, month) => [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28,
  31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/** True only for a real calendar day written exactly as `YYYY-MM-DD`. */
function isBusinessDate(value) {
  if (typeof value !== "string") return false;
  const m = PATTERN.exec(value);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (year < 1900 || year > 2999) return false;
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysIn(year, month);
}

/**
 * The calendar day an upstream INSTANT was recorded for.
 *
 * Merchandising stores a committed delivery date as the instant a date input
 * produced — midnight UTC of the chosen day — so the UTC calendar day is the day
 * that was chosen. Read in UTC deliberately: reading it in the server's local
 * zone is exactly the shift this module exists to prevent.
 */
function businessDateFromInstant(value) {
  if (value === null || value === undefined || value === "") return null;
  if (isBusinessDate(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** -1, 0 or 1. Both arguments must already be business dates. */
const compareBusinessDates = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

module.exports = { isBusinessDate, businessDateFromInstant, compareBusinessDates };
