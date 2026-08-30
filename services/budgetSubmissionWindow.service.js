// services/budgetSubmissionWindow.service.js
//
// WHEN DEPARTMENTS MAY ASK — which is not when the money applies.
//
// A round has two date ranges and they answer different questions:
//
//   budget period      01 Apr 2026 → 31 Mar 2027   when the money applies
//   submission window  01 Mar 2026 → 31 Mar 2026   when departments may ask
//
// They overlap only by accident. Departments budget for a year BEFORE it
// starts, so the window normally sits entirely in the month before the period.
// Treating them as one range — which is what the module did until now — meant
// either departments could submit into a year that was already half spent, or
// the "period" had to be bent to mean the asking season and the money dates
// stopped being true.
//
// ── THE DEFAULT WINDOW ──────────────────────────────────────────────────────
// Opens on the 1st of the month before the period starts; closes the day
// before it starts. For FY 2026-27 that is 01 Mar → 31 Mar 2026, and the same
// single rule gives a quarter starting 1 July a June window. One rule, so a
// quarterly round's window is never a surprise next to an annual one's.
//
// ── EXISTING ROUNDS HAVE NO WINDOW ──────────────────────────────────────────
// Every rule here treats a missing window as "no restriction". A round created
// before this existed keeps behaving exactly as it did — open whenever its
// status says collecting. Adding a date is what starts enforcing one.

"use strict";

const DAY = 24 * 60 * 60 * 1000;

/** A Date, or null when the value cannot be read as one. */
function asDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const iso = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(
    d.getUTCDate(),
  ).padStart(2, "0")}`;

/**
 * The window a round gets when nobody chooses one.
 *
 * Derived from the budget period's START, never from its end: the ask happens
 * before the spending, so a year's window has nothing to do with next March.
 *
 * Returns ISO date strings, or nulls when the period start is unreadable —
 * callers then leave the window unset, which means unrestricted.
 */
function defaultWindowFor(periodStart) {
  const start = asDate(periodStart);
  if (!start) return { submissionStartDate: null, submissionEndDate: null };

  /* The 1st of the previous month, in UTC so a date-only string cannot slide
     a day either way depending on where the server is. */
  const opens = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
  /* The day before the money starts applying. */
  const closes = new Date(start.getTime() - DAY);

  return { submissionStartDate: iso(opens), submissionEndDate: iso(closes) };
}

/**
 * The window a round GETS WHEN IT IS CREATED.
 *
 * ── THE ROUND THAT WAS BORN CLOSED ──────────────────────────────────────────
 * `defaultWindowFor` derives the window from the period start, which is right
 * for the normal case: a year is budgeted before it runs, so FY 2026-27 asks
 * in March 2026. But finance does not only open rounds in advance. Open FY
 * 2026-27 in August 2026 — a year already four months old, which is exactly
 * when somebody sets the module up for the first time — and the derived window
 * is 1–31 March 2026. Over before the round existed.
 *
 * The department then gets "Submissions closed on 31 Mar 2026" for a round
 * finance created minutes earlier, and nothing on either screen explains it.
 *
 * So the default never lands in the past: if the derived window has already
 * closed, the round opens today and runs for thirty days. Finance can still
 * set any window it likes — this is only what it gets for free.
 */
function windowForNewRound(periodStart, now = new Date()) {
  const derived = defaultWindowFor(periodStart);
  const end = asDate(derived.submissionEndDate);
  if (!end) return derived;

  const t = (asDate(now) ?? new Date()).getTime();
  /* Still to open, or open now — the derived window is the right one. The
     same whole-day inclusivity as windowState, or a window closing today
     would be treated as past. */
  if (end.getTime() + DAY - 1 >= t) return derived;

  const at = new Date(t);
  const opens = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return {
    submissionStartDate: iso(opens),
    submissionEndDate: iso(new Date(opens.getTime() + 30 * DAY)),
  };
}

/**
 * Is the window itself coherent?
 *
 * The ONLY rule is that it does not run backwards. Deliberately not checked:
 * whether it sits inside the budget period — it normally must not, since
 * departments ask before the year starts, and a validation that demanded
 * otherwise would reject every realistic window.
 */
function validateWindow({ submissionStartDate, submissionEndDate } = {}) {
  const s = asDate(submissionStartDate);
  const e = asDate(submissionEndDate);
  if (s && e && s.getTime() > e.getTime()) {
    return {
      error: "Submissions cannot close before they open.",
      code: "SUBMISSION_WINDOW_BACKWARDS",
    };
  }
  return { error: null };
}

/**
 * Where `now` sits relative to a round's window.
 *
 *   "unrestricted"  no window set — an older round, open whenever it collects
 *   "before"        the window has not opened yet
 *   "open"          inside it
 *   "after"         it has closed
 *
 * Both ends are INCLUSIVE to the whole day: a window closing on 31 March is
 * open all of 31 March. A date-only value parses as UTC midnight, so without
 * this the last day would be lost for anyone submitting after midnight UTC.
 */
function windowState({ submissionStartDate, submissionEndDate }, now = new Date()) {
  const s = asDate(submissionStartDate);
  const e = asDate(submissionEndDate);
  if (!s && !e) return "unrestricted";

  const t = asDate(now)?.getTime() ?? Date.now();
  if (s && t < s.getTime()) return "before";
  if (e && t > e.getTime() + DAY - 1) return "after";
  return "open";
}

/** May a department submit into this round right now? */
function isOpenForSubmissions(budget, now = new Date()) {
  return windowState(budget || {}, now) !== "before" && windowState(budget || {}, now) !== "after";
}

/**
 * What finance sees about a round's stage, in words rather than a stored enum.
 *
 * The stored `status` still decides what the module DOES — this only decides
 * what the screen SAYS, so a round whose window closed last week stops
 * claiming to be collecting without anybody having to remember to change it.
 *
 *   scheduled  window has not opened
 *   open       collecting, and inside the window
 *   review     collecting, but the window has closed — waiting on finance
 *   active     the money is live
 *   closed     finished
 */
function displayStage(budget, now = new Date()) {
  const status = String(budget?.status || "").toLowerCase();
  if (status === "active" || status === "exceeded") return "active";
  if (status === "closed") return "closed";
  if (status === "review") return "review";
  if (status === "draft") return "draft";

  /* collecting, and anything unrecognised: the window has the answer. */
  const state = windowState(budget || {}, now);
  if (state === "before") return "scheduled";
  if (state === "after") return "review";
  return "open";
}

module.exports = {
  defaultWindowFor,
  windowForNewRound,
  validateWindow,
  windowState,
  isOpenForSubmissions,
  displayStage,
  asDate,
};
