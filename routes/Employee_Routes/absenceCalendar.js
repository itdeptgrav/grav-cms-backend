"use strict";
/**
 * routes/Employee_Routes/absenceCalendar.js
 * ───────────────────────────────────────────────────────────────────────────
 * Who is away, by day — a planning view for the whole workforce.
 *
 * Mount:
 *   const empAbsenceCalendar = require("./routes/Employee_Routes/absenceCalendar");
 *   app.use("/api/employee/absence-calendar", empAbsenceCalendar);
 *
 *   GET /api/employee/absence-calendar?month=8&year=2026
 *        → per-day counts for the month, for the calendar grid
 *   GET /api/employee/absence-calendar/day?date=2026-08-14
 *        → the people away on that one day, for the detail sheet
 *
 * ── WHAT THIS DELIBERATELY DOES NOT RETURN ────────────────────────────────
 *
 * No leave reason. No leave TYPE either — and that second one is the part
 * worth being explicit about, because returning it looks harmless and is not.
 * "SL" means sick leave; publishing which of your colleagues took sick leave,
 * and when, is publishing their medical history to the entire company. The
 * same reasoning already governs the standings board (see the scoping note at
 * the top of leaderboard.js), and it has to hold here or the rule is
 * decorative.
 *
 * So a person is reported as either `absent` (did not come in, unplanned) or
 * `leave` (approved time off), and nothing finer. That distinction is what a
 * shift plan actually needs: whether the gap was known in advance.
 *
 * It also does not return a PHONE NUMBER. Identifying who is missing needs a
 * name, a face and the biometric ID people use on the floor; it does not need
 * a company-wide directory of everyone's mobile number, indexed by the days
 * they were out. That is a different and much larger disclosure than an
 * absence list, so the field is not selected from Mongo at all — a UI change
 * cannot reintroduce it, and it never reaches a log or a response body.
 *
 * ── PAST AND FUTURE COME FROM DIFFERENT PLACES ────────────────────────────
 *
 * Attendance is biometric-first: DailyAttendance is the record of what
 * happened, and it cannot know about tomorrow. But an approved leave
 * application IS known in advance, and "who is out next Tuesday" is the whole
 * reason to open a calendar rather than a report.
 *
 *   dateStr <= today  → DailyAttendance, the system of record
 *   dateStr >  today  → approved LeaveApplication rows, marked `planned: true`
 *
 * A future row also carries `confirmed`: true once HR has approved it,
 * false while it is only manager-approved and still in HR's hands. A planner
 * needs to know which of tomorrow's gaps are certain.
 *
 * Dates are IST throughout, computed the way the rest of this backend does it
 * (Date.now() + 5.5h, then read with getUTC*).
 */

const express = require("express");
const router = express.Router();

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { LeaveApplication } = require("../../models/HR_Models/LeaveManagement");
const { ABSENT_SET, LEAVE_SET, HALFDAY_SET } = require("../../utils/performanceStats");

// Half-day-present-on-leave codes. Someone on P/CL was at work for half the
// day, so they belong in the leave bucket but flagged, not counted as a full
// day's gap in the line.
const HALF_LEAVE_SET = new Set(["P/CL", "P/SL", "P/PL", "P/LWP"]);

const pad = (n) => String(n).padStart(2, "0");

/** Today's date in IST, as YYYY-MM-DD. */
function istToday() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${pad(ist.getUTCMonth() + 1)}-${pad(ist.getUTCDate())}`;
}

function monthBounds(month, year) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(days)}`,
    days,
  };
}

/** "absent" | "leave" | null — never the specific leave type. See the header. */
function bucketFor(status) {
  if (!status) return null;
  if (ABSENT_SET.has(status)) return "absent";
  if (LEAVE_SET.has(status) || HALF_LEAVE_SET.has(status)) return "leave";
  // HD/LHD are half days worked, not time off, so they are not a gap.
  if (HALFDAY_SET.has(status)) return null;
  return null;
}

function parseMonthYear(req) {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const month = Number(req.query.month) || now.getUTCMonth() + 1;
  const year = Number(req.query.year) || now.getUTCFullYear();
  if (month < 1 || month > 12 || year < 2000 || year > 2100) return null;
  return { month, year };
}

/** Every dateStr an approved leave covers, clipped to [from, to]. */
function leaveDatesWithin(app, from, to) {
  const out = [];
  const start = app.fromDate > from ? app.fromDate : from;
  const end = app.toDate < to ? app.toDate : to;
  if (start > end) return out;
  const d = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  // Guard against a malformed row producing an unbounded loop.
  let guard = 0;
  while (d <= last && guard++ < 400) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Approved, and not withdrawn. manager_approved is included because a planner
// needs to see it coming; `confirmed` tells the UI it is not final yet.
const FUTURE_LEAVE_STATUSES = ["hr_approved", "manager_approved"];

// ───────────────────────────────────────────────────────────────────────────
// GET /  → per-day counts for a month
// ───────────────────────────────────────────────────────────────────────────
router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const my = parseMonthYear(req);
    if (!my) {
      return res.status(400).json({ success: false, message: "Bad month or year" });
    }
    const { month, year } = my;
    const { from, to } = monthBounds(month, year);
    const today = istToday();

    // Counts only — no Employee lookup here. The grid needs a number per day,
    // and joining ~500 employee documents to render twelve badges would be the
    // expensive half of this feature for none of the value.
    const byDate = new Map(); // dateStr -> { absent, leave, planned }
    const bump = (dateStr, key) => {
      const row = byDate.get(dateStr) || { absent: 0, leave: 0, planned: 0 };
      row[key] += 1;
      byDate.set(dateStr, row);
    };

    const docs = await DailyAttendance.find({
      dateStr: { $gte: from, $lte: to <= today ? to : today },
    })
      .select("dateStr employees.biometricId employees.hrFinalStatus employees.systemPrediction")
      .lean();

    for (const doc of docs) {
      const seen = new Set();
      for (const e of doc.employees || []) {
        const bid = String(e.biometricId || "").toUpperCase();
        if (!bid || seen.has(bid)) continue;
        const bucket = bucketFor(e.hrFinalStatus || e.systemPrediction);
        if (!bucket) continue;
        seen.add(bid);
        bump(doc.dateStr, bucket);
      }
    }

    // Future days in this month, from approved leave.
    if (to > today) {
      const futureFrom = from > today ? from : today;
      const upcoming = await LeaveApplication.find({
        status: { $in: FUTURE_LEAVE_STATUSES },
        fromDate: { $lte: to },
        toDate: { $gte: futureFrom },
      })
        .select("biometricId employeeId fromDate toDate")
        .lean();

      for (const app of upcoming) {
        for (const dateStr of leaveDatesWithin(app, futureFrom, to)) {
          if (dateStr <= today) continue; // the attendance record already owns it
          bump(dateStr, "planned");
        }
      }
    }

    const days = [...byDate.entries()]
      .map(([dateStr, c]) => ({
        dateStr,
        absent: c.absent,
        leave: c.leave,
        planned: c.planned,
        away: c.absent + c.leave + c.planned,
      }))
      .filter((d) => d.away > 0)
      .sort((a, b) => a.dateStr.localeCompare(b.dateStr));

    return res.json({
      success: true,
      data: { month, year, from, to, today, days },
    });
  } catch (err) {
    console.error("[employee/absence-calendar]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load the absence calendar" });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// GET /day?date=YYYY-MM-DD  → the people away on one day
// ───────────────────────────────────────────────────────────────────────────
router.get("/day", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const date = String(req.query.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res
        .status(400)
        .json({ success: false, message: "date must be YYYY-MM-DD" });
    }
    const today = istToday();

    // biometricId (upper) -> { kind, halfDay, planned, confirmed }
    const away = new Map();

    if (date <= today) {
      const doc = await DailyAttendance.findOne({ dateStr: date })
        .select("employees.biometricId employees.hrFinalStatus employees.systemPrediction")
        .lean();

      for (const e of doc?.employees || []) {
        const bid = String(e.biometricId || "").toUpperCase();
        if (!bid || away.has(bid)) continue;
        const status = e.hrFinalStatus || e.systemPrediction;
        const kind = bucketFor(status);
        if (!kind) continue;
        away.set(bid, {
          kind,
          halfDay: HALF_LEAVE_SET.has(status),
          planned: false,
          confirmed: true,
        });
      }
    } else {
      const upcoming = await LeaveApplication.find({
        status: { $in: FUTURE_LEAVE_STATUSES },
        fromDate: { $lte: date },
        toDate: { $gte: date },
      })
        .select("biometricId status isHalfDay")
        .lean();

      for (const app of upcoming) {
        const bid = String(app.biometricId || "").toUpperCase();
        if (!bid || away.has(bid)) continue;
        away.set(bid, {
          kind: "leave",
          halfDay: !!app.isHalfDay,
          planned: true,
          confirmed: app.status === "hr_approved",
        });
      }
    }

    if (away.size === 0) {
      return res.json({
        success: true,
        data: { dateStr: date, today, counts: { absent: 0, leave: 0, away: 0 }, people: [] },
      });
    }

    const employees = await Employee.find({
      biometricId: { $in: [...away.keys()] },
      $or: [{ isActive: true }, { isActive: { $exists: false } }],
    })
      // No `phone`. See the header — not selected rather than dropped later,
      // so it cannot leak through a response body or a debug log.
      .select("firstName middleName lastName biometricId department designation profileImage")
      .lean();

    const people = employees
      .map((emp) => {
        const meta = away.get(String(emp.biometricId || "").toUpperCase());
        return {
          employeeId: String(emp._id),
          // The biometric ID is the number people actually call each other by
          // on the floor, so it is shown, not just used as a join key.
          biometricId: emp.biometricId || null,
          name:
            [emp.firstName, emp.middleName, emp.lastName]
              .filter(Boolean)
              .join(" ")
              .trim() || "Unnamed",
          avatar: emp.profileImage || null,
          department: emp.department || null,
          designation: emp.designation || null,
          kind: meta.kind, // "absent" | "leave" — never the leave type
          halfDay: meta.halfDay,
          planned: meta.planned,
          confirmed: meta.confirmed,
        };
      })
      .sort(
        (a, b) =>
          a.department?.localeCompare(b.department || "") ||
          a.name.localeCompare(b.name),
      );

    const counts = people.reduce(
      (acc, p) => {
        acc[p.kind] += 1;
        acc.away += 1;
        return acc;
      },
      { absent: 0, leave: 0, away: 0 },
    );

    return res.json({
      success: true,
      data: { dateStr: date, today, counts, people },
    });
  } catch (err) {
    console.error("[employee/absence-calendar/day]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load that day" });
  }
});

module.exports = router;
