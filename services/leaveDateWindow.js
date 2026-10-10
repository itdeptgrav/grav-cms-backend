"use strict";
/**
 * services/leaveDateWindow.js — a leave cannot start before the person worked here.
 *
 * `POST /api/employee/leave-applications` and the manager's `add-on-behalf`
 * both take `fromDate` from the request and never checked it against anything
 * except `toDate`. Both already load `dateOfJoining` on the line above, for
 * the waiting-period rule, and neither looked at it.
 *
 * So a half-day sick leave was filed on **2025-09-05** by somebody who joined
 * on **2026-05-04** — a date eight months before their first day, and a year
 * before the day they meant. It was accepted, it minted a LeaveBalance for
 * 2025, and it sat pending for ever. The day they actually meant, 2026-09-05,
 * went on reading HD in HR, because nothing had been applied to it: HR was
 * reporting the truth about a day no leave had ever named.
 *
 * ── WHY ONLY THE JOINING DATE ───────────────────────────────────────────────
 * Backdating a leave is NORMAL and must keep working: sick leave is routinely
 * filed the morning after, and HR files older corrections deliberately. There
 * is no backdating window anywhere in this codebase — no config field, no
 * policy document — so inventing one here would be inventing company policy in
 * a validator.
 *
 * The joining date is not a policy. It is a fact about the person, already
 * stored, already loaded, and a leave before it is meaningless under any
 * policy: there was no employment to be absent from. That is the whole bound,
 * and it is enough to have refused the application above.
 *
 * An employee with NO joining date recorded is NOT refused. That is a gap in
 * their HR record, and the person it would punish is the one who did not
 * create it; the waiting-period rule in the same handlers already treats a
 * missing joining date as "no working days yet" and refuses on its own terms.
 */

/* ── THE COMPARISON FRAME ────────────────────────────────────────────────────
   Every `dateOfJoining` in this database is stored at exactly 00:00:00.000Z
   (all 102 of them) — the usual date-only convention, a calendar date wearing
   a timestamp. `fromDate` arrives as a plain "YYYY-MM-DD" string.

   So both are compared as CALENDAR DATES in UTC, never through the server's
   local timezone. Reading 2026-05-04T00:00:00Z with local getters gives 4 May
   in Asia/Kolkata and 3 May on a host west of UTC, which would refuse a leave
   on somebody's own joining day depending on where the process happens to
   run. A day number (20260504) has no timezone to get wrong. */

/** A calendar date as YYYYMMDD, or null if there is no reading it. */
function dayNumber(value) {
  /* Already one. `readableDate` is handed the compared value rather than the
     raw input, so that what the message prints is exactly what was judged. */
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 10000101 && value <= 99991231 ? value : null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.getUTCFullYear() * 10000 + (value.getUTCMonth() + 1) * 100 + value.getUTCDate();
  }
  const text = String(value ?? "").trim();
  /* The wire format, read literally rather than through Date — `new Date("…")`
     on a bare YYYY-MM-DD is UTC midnight, which is right, but reading the
     digits says so without depending on it. */
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (m) return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
  if (!text) return null;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** `2026-05-04T00:00:00.000Z` → `4 May 2026`, for a message somebody reads. */
function readableDate(value) {
  const n = dayNumber(value);
  if (!n) return "";
  const y = Math.floor(n / 10000), mo = Math.floor((n % 10000) / 100), d = n % 100;
  /* Built in UTC and formatted in UTC, so the printed day is the day that was
     compared. en-IN renders this as “5 Sept 2025” — the same words the
     employee app shows the person, which is the point of naming the date at
     all. */
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString("en-IN", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

/**
 * Is this leave's start date on or after the employee's first day?
 *
 * @param {object} employee  anything carrying `dateOfJoining`
 * @param {string|Date} fromDate  the leave's start
 * @returns {{ok: true} | {ok: false, code: string, message: string}}
 *   `ok` when there is nothing to refuse — including when the date is
 *   unreadable (the caller's own "All fields required" / date parsing owns
 *   that) and when no joining date is recorded.
 */
function checkLeaveStartsAfterJoining(employee, fromDate) {
  const joined = dayNumber(employee?.dateOfJoining);
  const from = dayNumber(fromDate);
  if (!joined || !from) return { ok: true };

  if (from < joined) {
    return {
      ok: false,
      code: "BEFORE_DATE_OF_JOINING",
      /* Names BOTH dates. The mistake that produced this was a year picked by
         accident on a date wheel, and "that is before you joined" alone leaves
         somebody staring at a date that looks right to them — it is the year
         that is wrong, and seeing the two side by side is what shows it. */
      message:
        `Leave cannot start on ${readableDate(from)} — that is before the ` +
        `joining date on record, ${readableDate(joined)}. Check the year on ` +
        `the date you picked.`,
    };
  }

  return { ok: true };
}

module.exports = { checkLeaveStartsAfterJoining, readableDate };
