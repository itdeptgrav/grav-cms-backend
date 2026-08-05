"use strict";
/**
 * routes/Employee_Routes/leaderboard.js
 * ───────────────────────────────────────────────────────────────────────────
 * Daily / weekly / monthly standings for the employee app.
 *
 * Mount:
 *   const empLeaderboard = require("./routes/Employee_Routes/leaderboard");
 *   app.use("/api/employee/leaderboard", empLeaderboard);
 *
 *   GET /api/employee/leaderboard?period=daily|weekly|monthly
 *
 * A DELIBERATE SCOPING DECISION
 *
 * This ranks on POSITIVE signal only — days present and days on time. It does
 * not expose anyone's absences, leave reasons, LOP days or SOP deductions to
 * their colleagues.
 *
 * That is not squeamishness, it is what keeps the feature usable. A board
 * that surfaces why someone was absent leaks medical and personal
 * circumstances across the whole company, and a board that ranks people from
 * the bottom up publishes a shame list. Ranking on "showed up, on time" gives
 * the same motivating comparison without either.
 *
 * Everyone is ranked, but each response also carries `me` so the app can show
 * a person their own position without them having to scroll a long list.
 */

const express = require("express");
const router = express.Router();

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");

// Present-ish and on-time sets, consistent with utils/performanceStats.
const PRESENT = new Set(["P", "P*", "P~", "MP", "WFH", "P/CL", "P/SL", "P/PL", "P/LWP"]);
const LATE = new Set(["P*", "LHD", "LAB"]);

/**
 * Minutes -> the two largest useful units: "7w 3d", "12d 6h", "7h 45m", "45m".
 *
 * A year of work is ~1250 hours, and "1256h 45m" is both unreadable and too
 * wide for a list row. Rolling up to days and weeks keeps every value to a
 * handful of characters at any period, which is what lets the row fit on one
 * line. Two units, never three — "7w 3d 6h 12m" is a stopwatch, not a summary.
 *
 * A work day is counted as 8h and a work week as 5 days, because this measures
 * time WORKED, not elapsed: 1256 hours is 157 working days, not 52 calendar
 * days, and an employee reads it the first way.
 */
const MINS_PER_WORKDAY = 8 * 60;
const WORKDAYS_PER_WEEK = 5;

function humanMins(total) {
  const mins = Math.max(0, Math.round(total || 0));
  if (mins < 60) return `${mins}m`;

  const days = Math.floor(mins / MINS_PER_WORKDAY);
  if (days < 1) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
  }

  if (days < WORKDAYS_PER_WEEK) {
    const h = Math.round((mins - days * MINS_PER_WORKDAY) / 60);
    return h ? `${days}d ${h}h` : `${days}d`;
  }

  const weeks = Math.floor(days / WORKDAYS_PER_WEEK);
  const d = days % WORKDAYS_PER_WEEK;
  return d ? `${weeks}w ${d}d` : `${weeks}w`;
}

function rangeFor(period) {
  const now = new Date();
  // IST-shifted, matching how the rest of this backend computes attendance
  // dates (Date.now() + 5.5h, then read with getUTC*).
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = ist.getUTCMonth();
  const d = ist.getUTCDate();
  const iso = (dt) => dt.toISOString().split("T")[0];
  const today = new Date(Date.UTC(y, m, d));

  if (period === "year") {
    return { from: iso(new Date(Date.UTC(y, 0, 1))), to: iso(today) };
  }
  if (period === "quarter") {
    const qStart = Math.floor(m / 3) * 3;
    return { from: iso(new Date(Date.UTC(y, qStart, 1))), to: iso(today) };
  }
  return { from: iso(new Date(Date.UTC(y, m, 1))), to: iso(today) }; // month
}

router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    const meId = req.user?.id;
    if (!meId) {
      return res.status(401).json({ success: false, message: "Not authorized" });
    }

    const period = ["month", "quarter", "year"].includes(req.query.period)
      ? req.query.period
      : "month";
    const { from, to } = rangeFor(period);

    const docs = await DailyAttendance.find({ dateStr: { $gte: from, $lte: to } })
      .select("dateStr employees")
      .lean();

    // biometricId -> tally
    const tally = new Map();
    for (const doc of docs) {
      for (const e of doc.employees || []) {
        const bid = String(e.biometricId || "").toUpperCase();
        if (!bid) continue;
        const st = e.hrFinalStatus || e.systemPrediction;
        if (!st) continue;
        const row = tally.get(bid) || { present: 0, onTime: 0, minutes: 0 };
        if (PRESENT.has(st)) {
          row.present += 1;
          if (!LATE.has(st)) row.onTime += 1;
          // netWorkMins is span minus breaks — the honest "time worked".
          row.minutes += Number(e.netWorkMins) || 0;
        }
        tally.set(bid, row);
      }
    }

    if (tally.size === 0) {
      return res.json({
        success: true,
        data: { period, from, to, entries: [], me: null },
      });
    }

    const employees = await Employee.find({
      biometricId: { $in: [...tally.keys()] },
      // Ranking people who have left the company would be noise.
      $or: [{ isActive: true }, { isActive: { $exists: false } }],
    })
      .select("firstName middleName lastName biometricId department designation profileImage")
      .lean();

    const scored = employees
      .map((emp) => {
        const t = tally.get(String(emp.biometricId || "").toUpperCase()) || {
          present: 0,
          onTime: 0,
          minutes: 0,
        };
        return {
          employeeId: String(emp._id),
          name: [emp.firstName, emp.middleName, emp.lastName].filter(Boolean).join(" ").trim(),
          department: emp.department || null,
          designation: emp.designation || null,
          avatar: emp.profileImage || null,
          present: t.present,
          onTime: t.onTime,
          minutes: Math.round(t.minutes),
          // Pre-formatted server-side so every client renders it the same way.
          worked: humanMins(t.minutes),
          // Time worked IS the ranking. Days present break exact ties.
          score: Math.round(t.minutes) * 10 + t.present,
        };
      })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));

    // Ordinal ranking: 1, 2, 3, 4 … every row gets its own position.
    //
    // Competition ranking (1, 2, 2, …, 49) was correct arithmetic and terrible
    // information: when everyone had the same single on-time day, 47 people
    // shared rank 2 and the next row jumped to 49, which reads as a bug. Now
    // that the metric is minutes worked, exact ties are rare, and the sort is
    // already deterministic (minutes, then days, then name), so an ordinal is
    // stable between refreshes rather than arbitrary.
    scored.forEach((r, i) => {
      r.rank = i + 1;
    });

    const me = scored.find((r) => r.employeeId === String(meId)) || null;

    return res.json({
      success: true,
      data: { period, from, to, entries: scored.slice(0, 100), me },
    });
  } catch (err) {
    console.error("[employee/leaderboard]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load leaderboard" });
  }
});

module.exports = router;
