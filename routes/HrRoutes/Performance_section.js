"use strict";
/**
 * routes/HrRoutes/Performance_section.js
 * ─────────────────────────────────────────────────────────────────────────────
 * HR Performance module — employee-level performance overview.
 *
 * Mount in your main router file (e.g. index.js):
 *   app.use("/hr/performance", require("./routes/HrRoutes/Performance_section"));
 *
 * Endpoints:
 *   GET  /hr/performance/overview?year=YYYY&department=...&search=...&page=&limit=
 *     Returns paginated list of active employees with their aggregate
 *     performance metrics for the year:
 *       • attendance: presentDays, absentDays, lateDays, halfDays, lopDays
 *       • leaves: total taken (by type) + balance remaining
 *       • tenure: months since joining
 *       • SOPs: count assigned, count acknowledged (best-effort, optional)
 *   GET  /hr/performance/:employeeId?year=YYYY
 *     Detailed metrics for one employee — used by the per-employee view.
 *     Pulls the same data the list returns plus a month-by-month attendance
 *     breakdown.
 *
 * Performance design:
 *   The /overview endpoint is the hot path. It runs ONE aggregate over
 *   DailyAttendance + one over LeaveApplication + a single Employee.find,
 *   then stitches them in JS — far cheaper than per-employee queries.
 */

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const {
  LeaveBalance,
  LeaveApplication,
  LeaveConfig,
} = require("../../models/HR_Models/LeaveManagement");

// Optional SOP model — only used if present, otherwise we silently skip the
// SOP columns. Lets this route work in environments where SOPs aren't set up
// yet without crashing on require.
let SOP = null;
let SOPAcknowledgement = null;
try {
  const sopModule = require("../../models/HR_Models/SOP");
  SOP = sopModule.SOP || sopModule;
  SOPAcknowledgement =
    sopModule.SOPAcknowledgement || sopModule.Acknowledgement || null;
} catch (_) {}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

// Statuses that count as "present" for attendance %. Mirrors the same set
// used in Attendance_section.js — keep these in sync if you add more codes.
const PRESENT_SET = new Set([
  "P",
  "P*",
  "P~",
  "MP",
  "WFH",
  "P/CL",
  "P/SL",
  "P/PL",
  "P/LWP",
]);
const ABSENT_SET = new Set(["AB", "LAB", "EAB", "LWP"]);
const HALFDAY_SET = new Set(["HD", "LHD"]);
const LEAVE_SET = new Set(["L-CL", "L-SL", "L-EL", "CO"]);
const LATE_SET = new Set(["P*", "LHD", "LAB"]);

function monthsBetween(d1, d2) {
  if (!d1 || !d2) return 0;
  const a = new Date(d1);
  const b = new Date(d2);
  if (isNaN(a) || isNaN(b)) return 0;
  let m =
    (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
  if (b.getDate() < a.getDate()) m--;
  return Math.max(0, m);
}

function fullName(e) {
  return [e.firstName, e.middleName, e.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
}

// Reduce a single DailyAttendance.employees[i] row into category buckets.
// Half-day variants count as Present (the employee was there for half the
// day) AND bump the corresponding leave bucket by 0.5. P/LWP only bumps
// the LOP/half-day-LWP counter, not a leave type.
function tallyEntry(stats, entry) {
  const st = entry.hrFinalStatus || entry.systemPrediction;
  if (!st) return;
  if (PRESENT_SET.has(st)) stats.presentDays++;
  if (ABSENT_SET.has(st)) stats.absentDays++;
  if (HALFDAY_SET.has(st)) stats.halfDays++;
  if (LATE_SET.has(st)) stats.lateDays++;
  if (LEAVE_SET.has(st)) {
    stats.leaveDaysTotal++;
    if (st === "L-CL") stats.clDays++;
    else if (st === "L-SL") stats.slDays++;
    else if (st === "L-EL") stats.plDays++;
  }
  // Half-day leave variants — fractional leave usage.
  if (st === "P/CL") {
    stats.clDays += 0.5;
    stats.leaveDaysTotal += 0.5;
  } else if (st === "P/SL") {
    stats.slDays += 0.5;
    stats.leaveDaysTotal += 0.5;
  } else if (st === "P/PL") {
    stats.plDays += 0.5;
    stats.leaveDaysTotal += 0.5;
  } else if (st === "P/LWP" || st === "LWP") {
    stats.lopDays += st === "P/LWP" ? 0.5 : 1;
  }
}

function blankStats() {
  return {
    presentDays: 0,
    absentDays: 0,
    halfDays: 0,
    lateDays: 0,
    leaveDaysTotal: 0,
    clDays: 0,
    slDays: 0,
    plDays: 0,
    lopDays: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /overview — list view
// ─────────────────────────────────────────────────────────────────────────────
router.get("/overview", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const department = req.query.department || "all";
    const search = (req.query.search || "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const skip = (page - 1) * limit;

    // Build the employee filter. We always restrict to active employees;
    // perf view is for current staff.
    const empFilter = { isActive: true };
    if (department !== "all") empFilter.department = department;
    if (search) {
      const rx = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      empFilter.$or = [
        { firstName: rx },
        { lastName: rx },
        { biometricId: rx },
        { department: rx },
        { designation: rx },
      ];
    }

    const total = await Employee.countDocuments(empFilter);
    const employees = await Employee.find(empFilter)
      .select(
        "firstName middleName lastName biometricId department designation dateOfJoining profilePhoto email phone primaryManager",
      )
      .sort({ firstName: 1, lastName: 1 })
      .skip(skip)
      .limit(limit)
      .lean();

    if (!employees.length)
      return res.json({
        success: true,
        data: { rows: [], total, page, pages: 0, year },
      });

    // Year date range, used by both attendance and leave queries.
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;
    const bids = employees
      .map((e) => String(e.biometricId || "").toUpperCase())
      .filter(Boolean);
    const empIds = employees.map((e) => e._id);

    // ── Attendance aggregate ────────────────────────────────────────────
    // We pull every DailyAttendance doc for the year and let JS tally
    // categories per biometricId. The alternative — a Mongo aggregate with
    // $unwind + $group on the employees array — would be more elegant but
    // doesn't handle the half-day-variant fractional leave bookkeeping
    // cleanly. Year-spanning queries for ~80 employees are ~366 docs total,
    // so JS aggregation is well within budget here.
    const attDocs = await DailyAttendance.find({
      dateStr: { $gte: yearStart, $lte: yearEnd },
      "employees.biometricId": { $in: bids },
    })
      .select("dateStr employees")
      .lean();

    const statsByBid = new Map();
    for (const bid of bids) statsByBid.set(bid, blankStats());
    for (const doc of attDocs) {
      for (const entry of doc.employees || []) {
        const bid = String(entry.biometricId || "").toUpperCase();
        const s = statsByBid.get(bid);
        if (!s) continue;
        tallyEntry(s, entry);
      }
    }

    // ── Leave balance lookup ────────────────────────────────────────────
    const balances = await LeaveBalance.find({
      employeeId: { $in: empIds },
      year,
    }).lean();
    const balByEmpId = new Map(balances.map((b) => [String(b.employeeId), b]));

    // ── SOP acknowledgements (optional) ─────────────────────────────────
    // If the SOP model isn't installed, sopAssigned/sopAcknowledged stay
    // at 0 across the board (frontend can hide those columns).
    const sopByEmpId = new Map();
    if (SOPAcknowledgement) {
      try {
        const acks = await SOPAcknowledgement.aggregate([
          { $match: { employeeId: { $in: empIds } } },
          {
            $group: {
              _id: "$employeeId",
              acknowledged: {
                $sum: { $cond: [{ $eq: ["$acknowledged", true] }, 1, 0] },
              },
              assigned: { $sum: 1 },
            },
          },
        ]);
        for (const a of acks)
          sopByEmpId.set(String(a._id), {
            assigned: a.assigned,
            acknowledged: a.acknowledged,
          });
      } catch (_) {}
    }

    // ── Stitch rows ─────────────────────────────────────────────────────
    const rows = employees.map((e) => {
      const bid = String(e.biometricId || "").toUpperCase();
      const s = statsByBid.get(bid) || blankStats();
      const bal = balByEmpId.get(String(e._id));
      const sop = sopByEmpId.get(String(e._id)) || {
        assigned: 0,
        acknowledged: 0,
      };
      const tenureMonths = monthsBetween(e.dateOfJoining, new Date());

      // Attendance % = present / (present + absent + half + leave + lop)
      // (i.e. excludes WO and Holiday days from the denominator so it
      // measures performance on workdays, not calendar days).
      const workDays =
        s.presentDays +
        s.absentDays +
        s.halfDays +
        s.leaveDaysTotal +
        s.lopDays;
      const attendancePct =
        workDays > 0 ? Math.round((s.presentDays / workDays) * 100) : null;

      return {
        employeeId: String(e._id),
        biometricId: e.biometricId || "",
        name: fullName(e),
        department: e.department || "",
        designation: e.designation || "",
        dateOfJoining: e.dateOfJoining,
        tenureMonths,
        email: e.email || "",
        phone: e.phone || "",
        profilePhoto: e.profilePhoto?.url || null,
        manager: e.primaryManager?.managerName || "",
        attendance: {
          presentDays: s.presentDays,
          absentDays: s.absentDays,
          halfDays: s.halfDays,
          lateDays: s.lateDays,
          lopDays: Math.round(s.lopDays * 10) / 10,
          attendancePct,
          workDays,
        },
        leaves: {
          totalTaken: Math.round(s.leaveDaysTotal * 10) / 10,
          clTaken: Math.round(s.clDays * 10) / 10,
          slTaken: Math.round(s.slDays * 10) / 10,
          plTaken: Math.round(s.plDays * 10) / 10,
          clAvailable: bal
            ? Math.max(0, (bal.entitlement?.CL || 0) - (bal.consumed?.CL || 0))
            : 0,
          slAvailable: bal
            ? Math.max(0, (bal.entitlement?.SL || 0) - (bal.consumed?.SL || 0))
            : 0,
          plAvailable: bal
            ? Math.max(0, (bal.entitlement?.PL || 0) - (bal.consumed?.PL || 0))
            : 0,
          plEligible: bal?.plEligible || false,
        },
        sop,
      };
    });

    res.json({
      success: true,
      data: {
        rows,
        total,
        page,
        pages: Math.ceil(total / limit),
        year,
      },
    });
  } catch (err) {
    console.error("[PERFORMANCE/overview]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:employeeId — detail view
// Used by the per-employee performance drill-down.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/:employeeId", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { employeeId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(employeeId))
      return res
        .status(400)
        .json({ success: false, message: "Invalid employee id" });
    const year = Number(req.query.year) || new Date().getFullYear();

    const emp = await Employee.findById(employeeId)
      .populate(
        "primaryManager.managerId",
        "firstName lastName biometricId department designation",
      )
      .lean();
    if (!emp)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    const bid = String(emp.biometricId || "").toUpperCase();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    // ── Year-wide attendance tally + per-month breakdown ──────────────
    const attDocs = await DailyAttendance.find({
      dateStr: { $gte: yearStart, $lte: yearEnd },
      "employees.biometricId": bid,
    })
      .select("dateStr employees")
      .lean();
    const yearStats = blankStats();
    const monthly = Array.from({ length: 12 }, () => blankStats());
    for (const doc of attDocs) {
      const entry = (doc.employees || []).find(
        (x) => String(x.biometricId || "").toUpperCase() === bid,
      );
      if (!entry) continue;
      tallyEntry(yearStats, entry);
      const m = parseInt(doc.dateStr.split("-")[1], 10) - 1;
      if (m >= 0 && m < 12) tallyEntry(monthly[m], entry);
    }

    // ── Leave balance + recent applications ───────────────────────────
    const [bal, recentLeaves] = await Promise.all([
      LeaveBalance.findOne({ employeeId, year }).lean(),
      LeaveApplication.find({
        employeeId,
        fromDate: { $gte: yearStart },
        toDate: { $lte: yearEnd },
      })
        .sort({ fromDate: -1 })
        .limit(20)
        .lean(),
    ]);

    // ── SOPs (optional) ───────────────────────────────────────────────
    let sopList = [];
    if (SOPAcknowledgement) {
      try {
        sopList = await SOPAcknowledgement.find({ employeeId })
          .sort({ updatedAt: -1 })
          .limit(20)
          .lean();
      } catch (_) {}
    }

    const tenureMonths = monthsBetween(emp.dateOfJoining, new Date());
    const tenureYears = Math.floor(tenureMonths / 12);
    const tenureRemMonths = tenureMonths % 12;

    res.json({
      success: true,
      data: {
        employee: {
          id: String(emp._id),
          name: fullName(emp),
          biometricId: emp.biometricId,
          email: emp.email,
          phone: emp.phone,
          department: emp.department,
          designation: emp.designation,
          dateOfJoining: emp.dateOfJoining,
          profilePhoto: emp.profilePhoto?.url || null,
          manager: emp.primaryManager?.managerName || "",
          managerInfo: emp.primaryManager?.managerId
            ? {
                id: String(emp.primaryManager.managerId._id),
                name: [
                  emp.primaryManager.managerId.firstName,
                  emp.primaryManager.managerId.lastName,
                ]
                  .filter(Boolean)
                  .join(" "),
                biometricId: emp.primaryManager.managerId.biometricId,
                department: emp.primaryManager.managerId.department,
                designation: emp.primaryManager.managerId.designation,
              }
            : null,
          tenureMonths,
          tenureLabel: `${tenureYears}y ${tenureRemMonths}m`,
        },
        year,
        yearStats: {
          ...yearStats,
          lopDays: Math.round(yearStats.lopDays * 10) / 10,
          leaveDaysTotal: Math.round(yearStats.leaveDaysTotal * 10) / 10,
        },
        monthly: monthly.map((m, i) => ({
          month: i + 1,
          monthLabel: new Date(year, i, 1).toLocaleDateString("en-IN", {
            month: "short",
          }),
          ...m,
          lopDays: Math.round(m.lopDays * 10) / 10,
          leaveDaysTotal: Math.round(m.leaveDaysTotal * 10) / 10,
        })),
        balance: bal
          ? {
              entitlement: bal.entitlement,
              consumed: bal.consumed,
              available: {
                CL: Math.max(
                  0,
                  (bal.entitlement?.CL || 0) - (bal.consumed?.CL || 0),
                ),
                SL: Math.max(
                  0,
                  (bal.entitlement?.SL || 0) - (bal.consumed?.SL || 0),
                ),
                PL: Math.max(
                  0,
                  (bal.entitlement?.PL || 0) - (bal.consumed?.PL || 0),
                ),
              },
              plEligible: bal.plEligible,
            }
          : null,
        recentLeaves: recentLeaves.map((l) => ({
          id: String(l._id),
          leaveType: l.leaveType,
          fromDate: l.fromDate,
          toDate: l.toDate,
          totalDays: l.totalDays,
          paidDays: l.paidDays,
          lwpDays: l.lwpDays,
          status: l.status,
          reason: l.reason,
        })),
        sopList: sopList.map((s) => ({
          id: String(s._id),
          title: s.title || s.sopTitle || "",
          acknowledged: !!s.acknowledged,
          updatedAt: s.updatedAt,
        })),
      },
    });
  } catch (err) {
    console.error("[PERFORMANCE/:id]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
