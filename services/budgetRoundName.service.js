// services/budgetRoundName.service.js
//
// WHAT A COMPANY BUDGET ROUND IS CALLED.
//
// A round's name is not information anybody has. It is the financial year and
// the period, written out — "Budget FY 2026-27 Q2" — and asking finance to
// type it invites three spellings of the same quarter and a name that says
// 27-28 on a row whose `financialYear` field says 2026-27. That exact mismatch
// is already in the data.
//
// So the name is DERIVED. Nobody types it for a company round, and two people
// opening the same quarter get the same string.
//
// ── WHY THE PERIOD INDEX COMES FROM startDate ───────────────────────────────
// `quarter` and `month` are optional on the schema; `startDate` is required.
// Reading the index off the date it actually covers means a round that was
// created before those fields existed, or by a client that never sent them,
// still names itself correctly — and the name can never disagree with the
// period the round really spans.
//
// ── FINANCIAL YEAR, NOT CALENDAR YEAR ───────────────────────────────────────
// April to March. Q1 is Apr–Jun and Q4 is Jan–Mar of the FOLLOWING calendar
// year, which is why the quarter is computed from an April-based month index
// rather than from `getMonth()` directly.

"use strict";

/** Apr → Mar, in the order a financial year runs. */
const FY_MONTHS = [
  "Apr", "May", "Jun", "Jul", "Aug", "Sep",
  "Oct", "Nov", "Dec", "Jan", "Feb", "Mar",
];

/**
 * How far into the financial year a date falls: 0 = April … 11 = March.
 * Returns null when the date is unusable, so callers can fall back rather
 * than name something "Q1" on the strength of an invalid date.
 */
function fyMonthIndex(startDate) {
  if (!startDate) return null;
  const d = startDate instanceof Date ? startDate : new Date(startDate);
  if (Number.isNaN(d.getTime())) return null;
  return (d.getMonth() - 3 + 12) % 12;
}

/**
 * The name for a company budget round.
 *
 * Deterministic: same financial year, same period, same date → same string,
 * every time and on both sides of the wire.
 *
 *   yearly       Budget FY 2026-27
 *   half_yearly  Budget FY 2026-27 H1
 *   quarterly    Budget FY 2026-27 Q2
 *   monthly      Budget FY 2026-27 Apr
 *
 * A period whose index cannot be read degrades to the plain year name rather
 * than guessing — a wrong quarter in a title is worse than no quarter.
 */
function roundName({ financialYear, period, startDate } = {}) {
  const fy = String(financialYear || "").trim();
  if (!fy) return "";

  const base = `Budget FY ${fy}`;
  const idx = fyMonthIndex(startDate);

  if (period === "monthly") {
    return idx === null ? base : `${base} ${FY_MONTHS[idx]}`;
  }
  if (period === "quarterly") {
    return idx === null ? base : `${base} Q${Math.floor(idx / 3) + 1}`;
  }
  if (period === "half_yearly") {
    return idx === null ? base : `${base} H${idx >= 6 ? 2 : 1}`;
  }
  /* yearly, and anything unrecognised: the year alone is always correct. */
  return base;
}

/** The financial year's starting calendar year: "2026-27" → 2026. */
function fyStartYear(financialYear) {
  const n = Number(String(financialYear || "").slice(0, 4));
  return Number.isFinite(n) && n > 1900 ? n : null;
}

const iso = (y, m, d) =>
  `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * The dates a company round covers, from its year and period.
 *
 * The form derives these too and sends them; this is the defensive half, for
 * an API caller that names a period and leaves the range out. Both sides read
 * the financial year as April–March, so Q4 and the last quarter of a monthly
 * run land in the FOLLOWING calendar year.
 *
 * `index` is FY-relative and 0-based: quarter 0 = Apr–Jun, month 0 = April.
 * Returns nulls when the year cannot be read, so a caller can fall through to
 * whatever it was going to do rather than invent a range.
 */
function roundDates({ financialYear, period, index = 0 } = {}) {
  const y = fyStartYear(financialYear);
  if (y === null) return { startDate: null, endDate: null };

  const lastDay = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  if (period === "monthly") {
    const i = Math.min(Math.max(Number(index) || 0, 0), 11);
    const cal = (3 + i) % 12;
    const year = y + (3 + i >= 12 ? 1 : 0);
    return { startDate: iso(year, cal, 1), endDate: iso(year, cal, lastDay(year, cal)) };
  }
  if (period === "quarterly") {
    const q = Math.min(Math.max(Number(index) || 0, 0), 3);
    const cal = (3 + q * 3) % 12;
    const year = y + (q === 3 ? 1 : 0);
    const endCal = (cal + 2) % 12;
    const endYear = year + (cal + 2 >= 12 ? 1 : 0);
    return { startDate: iso(year, cal, 1), endDate: iso(endYear, endCal, lastDay(endYear, endCal)) };
  }
  if (period === "half_yearly") {
    const h = Number(index) >= 1 ? 1 : 0;
    const cal = h === 1 ? 9 : 3;
    const endCal = (cal + 5) % 12;
    const endYear = y + (cal + 5 >= 12 ? 1 : 0);
    return { startDate: iso(y, cal, 1), endDate: iso(endYear, endCal, lastDay(endYear, endCal)) };
  }
  /* yearly: 1 April to 31 March. */
  return { startDate: iso(y, 3, 1), endDate: iso(y + 1, 2, 31) };
}

module.exports = { roundName, fyMonthIndex, roundDates, fyStartYear, FY_MONTHS };
