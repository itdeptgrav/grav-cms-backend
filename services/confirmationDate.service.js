// services/confirmationDate.service.js
//
// When probation ends, derived from when it started.
//
// ── WHY THIS IS ON THE SERVER ───────────────────────────────────────────────
// Joining date, probation months and confirmation date are one fact written
// three ways: somebody joins, serves N months, and is confirmed at the end of
// it. The HR form now works that out as you type — but the form is not the
// only way an employee is created. The spreadsheet import creates them in
// bulk, and it carried whatever the sheet happened to say, which was usually
// nothing: 84 of the 91 active employees in this database have no confirmation
// date at all, and 82 of those have a joining date sitting right beside an
// empty column.
//
// So the rule lives here, where every path reaches it, and the form's
// auto-fill becomes a convenience — you SEE the date and can change it —
// rather than the only place the arithmetic happens.
//
// ── IT ONLY EVER FILLS A BLANK ──────────────────────────────────────────────
// A confirmation that was moved — brought forward for good work, pushed back
// after a bad quarter — is a decision somebody made, and recomputing over it
// would erase that decision silently. If a date is present, it stands.

"use strict";

/**
 * A date N months on, clamped to the end of the target month.
 *
 * Not `setMonth(+n)`, which OVERFLOWS: 31 January plus one month becomes
 * 3 March, because February has no 31st. An employee joining on the last day
 * of a long month would be confirmed a few days into the wrong month — the
 * kind of error nobody checks because the date looks plausible. Four of the
 * seven cases in the harness differ between the two methods.
 */
function addMonths(date, months) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;

  const n = Number(months);
  if (!Number.isFinite(n)) return null;

  const day = d.getUTCDate();
  const target = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1),
  );
  /* Day 0 of the next month is the last day of this one. */
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

/**
 * The confirmation date implied by a joining date and a probation.
 *
 * Returns null when it cannot be worked out — no joining date, or a probation
 * that is not a number. A blank is honest; a guess is not.
 */
function deriveConfirmationDate(dateOfJoining, probationMonths) {
  if (!dateOfJoining) return null;
  const months = Number(probationMonths || 0);
  if (!Number.isFinite(months) || months < 0) return null;
  return addMonths(dateOfJoining, months);
}

/**
 * Fill `confirmationDate` on an employee-shaped object, only if it is empty.
 *
 * Mutates and returns the object, so it can sit in a create/update pipeline.
 * Returns the object unchanged whenever a date is already present — see the
 * note at the top about decisions somebody made.
 *
 * @param {object} emp  anything with dateOfJoining / probationPeriod
 * @returns {boolean}   true when a date was written
 */
function fillConfirmationDate(emp) {
  if (!emp) return false;
  if (emp.confirmationDate) return false;

  const derived = deriveConfirmationDate(
    emp.dateOfJoining,
    emp.probationPeriod,
  );
  if (!derived) return false;

  emp.confirmationDate = derived;
  return true;
}

module.exports = { addMonths, deriveConfirmationDate, fillConfirmationDate };
