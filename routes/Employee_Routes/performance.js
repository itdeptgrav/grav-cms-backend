"use strict";
/**
 * routes/Employee_Routes/performance.js
 * ───────────────────────────────────────────────────────────────────────────
 * The logged-in employee's own performance, for the mobile app.
 *
 * Mount:
 *   const employeePerformance = require("./routes/Employee_Routes/performance");
 *   app.use("/api/employee/performance", employeePerformance);
 *
 * Endpoint:
 *   GET /api/employee/performance?year=YYYY
 *
 * WHY THIS EXISTS RATHER THAN REUSING /hr/performance/:employeeId
 *
 *   1. Auth audience. The HR route sits behind EmployeeAuthMiddleware, which
 *      authenticates CMS *department* users. The mobile app authenticates
 *      with AllEmployeeAppMiddleware. An app token does not authenticate
 *      against the HR route at all, so the app could not call it regardless.
 *
 *   2. Authorization. /hr/performance/:employeeId takes an arbitrary id and
 *      returns that person's record. That is correct for HR and wrong for an
 *      employee-facing app — shipping it would let any employee read a
 *      colleague's attendance, leave and deductions by changing one path
 *      segment. Here the id comes from the verified token and there is no
 *      parameter to tamper with, so cross-employee access is impossible by
 *      construction rather than by a check someone can forget.
 *
 * The attendance tally is shared with the HR route via utils/performanceStats
 * so the two can never disagree on what "present" means.
 */

const express = require("express");
const router = express.Router();

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { LeaveBalance } = require("../../models/HR_Models/LeaveManagement");
const {
  monthsBetween,
  tallyEntry,
  blankStats,
} = require("../../utils/performanceStats");

/**
 * LeaveBalance stores `entitlement` and `consumed` and exposes the remaining
 * days through an `available` VIRTUAL. Virtuals do not survive `.lean()`, so
 * reading `balance.available` here would be undefined — the subtraction has
 * to be done by hand. Mirrors leaveBalanceSchema.virtual("available"),
 * including its clamp at zero.
 */
function buildLeave(balance) {
  const ent = balance.entitlement || {};
  const con = balance.consumed || {};
  const remaining = (k) => Math.max(0, (ent[k] || 0) - (con[k] || 0));
  return {
    cl: remaining("CL"),
    sl: remaining("SL"),
    pl: remaining("PL"),
    entitlement: { cl: ent.CL || 0, sl: ent.SL || 0, pl: ent.PL || 0 },
    consumed: { cl: con.CL || 0, sl: con.SL || 0, pl: con.PL || 0 },
  };
}

router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
  try {
    // The subject is always the caller. No :employeeId param by design.
    const employeeId = req.user?.id;
    if (!employeeId) {
      return res
        .status(401)
        .json({ success: false, message: "Not authorized" });
    }

    const year = Number(req.query.year) || new Date().getFullYear();

    const emp = await Employee.findById(employeeId)
      .select(
        "firstName middleName lastName biometricId department designation dateOfJoining sopPoints",
      )
      .lean();

    if (!emp) {
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    }

    const bid = String(emp.biometricId || "").toUpperCase();
    const yearStart = `${year}-01-01`;
    const yearEnd = `${year}-12-31`;

    // ── Attendance: one query for the year, tallied in JS ──────────────────
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

    // Attendance rate over days that actually carry a decided status —
    // dividing by calendar days would understate everyone in January.
    const decided =
      yearStats.presentDays + yearStats.absentDays + yearStats.leaveDaysTotal;
    const attendanceRate =
      decided > 0 ? Math.round((yearStats.presentDays / decided) * 1000) / 10 : null;

    // ── Leave balance ──────────────────────────────────────────────────────
    let balance = null;
    try {
      balance = await LeaveBalance.findOne({
        employeeId: emp._id,
        year,
      }).lean();
    } catch (_) {
      // A missing balance record is normal for a new joiner — report null
      // rather than failing the whole response.
    }

    // ── SOP deductions for the year, from the existing sopPoints ledger ────
    const yearLedger = (emp.sopPoints || []).find((p) => Number(p.year) === year);
    const bleaches = (yearLedger?.bleaches || []).slice();
    // Newest first — the app shows the most recent handful.
    bleaches.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

    return res.json({
      success: true,
      data: {
        year,
        employee: {
          name: [emp.firstName, emp.middleName, emp.lastName]
            .filter(Boolean)
            .join(" ")
            .trim(),
          biometricId: emp.biometricId,
          department: emp.department,
          designation: emp.designation,
          tenureMonths: monthsBetween(emp.dateOfJoining, new Date()),
        },
        attendance: { ...yearStats, attendanceRate, monthly },
        leave: balance ? buildLeave(balance) : null,
        sop: {
          totalDeducted: yearLedger?.totalDeducted || 0,
          entries: bleaches.slice(0, 20).map((b) => ({
            name: b.sopName,
            type: b.type,
            points: b.points,
            isCredit: b.isCredit,
            description: b.description,
            date: b.date,
            folderName: b.folderName,
          })),
        },
      },
    });
  } catch (err) {
    console.error("[employee/performance]", err);
    return res
      .status(500)
      .json({ success: false, message: "Could not load performance" });
  }
});

module.exports = router;
