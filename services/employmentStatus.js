// services/employmentStatus.js
//
// "Is this person still employed here?" — asked by every door.
//
// ── WHY IT IS ONE FUNCTION ──────────────────────────────────────────────────
// The answer was written differently everywhere it was asked, and in one place
// it was not asked at all:
//
//   · the app's login query used `$or: [{status:"active"},{isActive:true}]`,
//     which is only correct while BOTH fields are written together. HR's
//     delete does write both, so it held — but any other path that set one of
//     them left the other still saying "active", and an OR reads that as yes.
//
//   · AllEmployeeAppMiddleware checked employment TYPE (interns) and never
//     employment STATUS, so a token already issued kept working for its full
//     30 days. Somebody let go on the 1st still had the app on the 30th.
//
//   · the website's session check did not look either.
//
// Two fields carry the answer — `isActive` (boolean) and `status` (string) —
// because they were added years apart. Neither can be dropped without a
// migration, so both are read, and EITHER saying no is no. That is the
// opposite of the old OR, and it is the safe direction: a half-written record
// closes the door rather than opening it.
//
// ── A MISSING RECORD IS NOT A REFUSAL ───────────────────────────────────────
// An unknown id passes. The routes behind these doors already answer "employee
// not found" with something a person can act on, and turning it into "your
// login has expired" would send somebody to HR about an account that was
// deleted, not disabled.

"use strict";

/* Every spelling the workforce has been marked with. Lowercased before the
   test, so "Inactive" and "TERMINATED" are the same answer. `status` has no
   enum on the schema — it is a free string defaulting to "active" — so this
   list is the vocabulary, not a constraint. */
const NOT_EMPLOYED_STATUSES = new Set([
  "inactive",
  "terminated",
  "resigned",
  "left",
  "separated",
  "exited",
  "relieved",
  "suspended",
]);

/**
 * @param {object|null} emp  an Employee document or lean object. Needs
 *                           `isActive` and `status` to answer usefully.
 * @returns {boolean} false ONLY when the record says, in either field, that
 *                    this person no longer works here.
 */
function isEmployed(emp) {
  if (!emp) return true; // unknown id — see the note above
  if (emp.isActive === false) return false;
  const status = String(emp.status || "").trim().toLowerCase();
  if (status && NOT_EMPLOYED_STATUSES.has(status)) return false;
  return true;
}

/** The fields `isEmployed` reads, for a `.select()`. */
const EMPLOYMENT_SELECT = "isActive status";

/* One refusal, so the app and the website say the same thing and the client
   can branch on the code rather than on the sentence. 401, not 403: the app
   and the CMS both already send a 401 to the sign-in screen, and this IS a
   dead session — a 403 would be read as "signed in, not allowed here" and
   leave them staring at a page they cannot use. */
const INACTIVE_REFUSAL = {
  success: false,
  code: "EMPLOYEE_INACTIVE",
  message:
    "Your login has expired because this account is no longer active. " +
    "Please contact HR.",
};

/**
 * Refuse on `res` when `emp` is no longer employed.
 * @returns {boolean} true when it refused — the caller should stop.
 */
function refuseIfNotEmployed(res, emp) {
  if (isEmployed(emp)) return false;
  res.status(401).json(INACTIVE_REFUSAL);
  return true;
}

/* A Mongo filter for "still employed", for queries that must not return them
   at all. Expressed as NOT-inactive rather than IS-active so a record that
   predates either field still matches. */
const EMPLOYED_QUERY = {
  isActive: { $ne: false },
  status: { $nin: [...NOT_EMPLOYED_STATUSES] },
};

module.exports = {
  isEmployed,
  refuseIfNotEmployed,
  EMPLOYMENT_SELECT,
  EMPLOYED_QUERY,
  INACTIVE_REFUSAL,
  NOT_EMPLOYED_STATUSES,
};
