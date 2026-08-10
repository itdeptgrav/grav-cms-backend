"use strict";
/**
 * services/hrOverviewContext.js — the ONLY data the HR Overview Assistant sees.
 *
 * The assistant must never be handed data the browser sends, and must never see
 * anything private. This module is the single choke point: it reads the SAME
 * aggregate source as GET /api/hr/overview/dashboard — the Employee,
 * DailyAttendance, LeaveApplication, CompanyHoliday and RegularizationRequest
 * collections — and returns a flat, aggregate-only snapshot.
 *
 * What is DELIBERATELY excluded (safety, not oversight):
 *   • No employee names, ids, designations or any individual record
 *     (so the dashboard's recentHires / today-on-leave name lists are dropped —
 *      only their counts survive).
 *   • No payroll, salary, bank, password, document, medical or profile data —
 *     none of those collections are read here at all.
 *   • No free-form database access — the queries below are the entire surface.
 *
 * The status-classification helpers mirror Overview-Section.js exactly (LHD to
 * present, LAB/EAB to absent, leave codes to leave). They are duplicated here
 * on purpose: this module must keep working untouched even if the dashboard
 * route is refactored, and the logic is small and stable.
 */

const Employee = require("../models/Employee");
const DailyAttendance = require("../models/HR_Models/Dailyattendance");
const {
  LeaveApplication,
  CompanyHoliday,
  RegularizationRequest,
} = require("../models/HR_Models/LeaveManagement");

// ── IST date helpers (same convention as the dashboard) ────────────────────
function dateStrOf(d) {
  const ist = new Date(d.getTime() + 330 * 60 * 1000);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}
function getTodayIST() {
  return dateStrOf(new Date());
}
function getThisMonthRange() {
  const now = new Date(Date.now() + 330 * 60 * 1000);
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1;
  const from = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  return { from, to };
}

// ── Status classification (mirrors Overview-Section.js) ────────────────────
const isPresent = (st) => ["P", "P*", "P~", "HD", "LHD"].includes(st);
const isAbsent = (st) => st === "AB" || st === "LAB" || st === "EAB";
const isHalfDay = (st) => st === "HD" || st === "LHD";
const isOnLeave = (st) => (st && st.startsWith("L-")) || ["LWP", "WFH", "CO"].includes(st);
const isRestDay = (st) => ["WO", "FH", "NH", "OH", "RH", "PH"].includes(st);
const statusOf = (e) => e.hrFinalStatus || e.systemPrediction;

/**
 * Build the aggregate-only HR overview snapshot.
 *
 * @param {object} [deps] optional model overrides (tests)
 * @returns {Promise<object>} aggregate context — safe to hand to the model
 */
async function buildHrOverviewContext(deps = {}) {
  const EmployeeModel = deps.Employee || Employee;
  const DailyAttendanceModel = deps.DailyAttendance || DailyAttendance;
  const LeaveApplicationModel = deps.LeaveApplication || LeaveApplication;
  const CompanyHolidayModel = deps.CompanyHoliday || CompanyHoliday;
  const RegularizationRequestModel = deps.RegularizationRequest || RegularizationRequest;

  const today = getTodayIST();
  const { from: monthStart, to: monthEnd } = getThisMonthRange();

  // 1. Headcount + department distribution (counts only)
  const [totalEmployees, activeEmployees, departmentBreakdown] = await Promise.all([
    EmployeeModel.countDocuments(),
    EmployeeModel.countDocuments({ $or: [{ status: "active" }, { isActive: true }] }),
    EmployeeModel.aggregate([
      { $match: { $or: [{ status: "active" }, { isActive: true }] } },
      { $group: { _id: "$department", count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]),
  ]);
  const inactiveEmployees = Math.max(0, totalEmployees - activeEmployees);

  // 2. Today's attendance (aggregate counts) + per-department present/absent
  const todayAttendance = await DailyAttendanceModel.findOne({ dateStr: today }).lean();
  const attendanceToday = {
    total: activeEmployees,
    present: 0,
    absent: 0,
    late: 0,
    onLeave: 0,
    halfDay: 0,
    weeklyOff: 0,
    pendingCheckout: 0,
    synced: false,
  };
  const deptTodayMap = {};
  if (todayAttendance && Array.isArray(todayAttendance.employees)) {
    const emps = todayAttendance.employees;
    attendanceToday.present = emps.filter((e) => isPresent(statusOf(e))).length;
    attendanceToday.late = emps.filter((e) => statusOf(e) === "P*" || e.isLate).length;
    attendanceToday.absent = emps.filter((e) => isAbsent(statusOf(e))).length;
    attendanceToday.onLeave = emps.filter((e) => isOnLeave(statusOf(e))).length;
    attendanceToday.halfDay = emps.filter((e) => isHalfDay(statusOf(e))).length;
    attendanceToday.weeklyOff = emps.filter((e) => isRestDay(statusOf(e))).length;
    attendanceToday.pendingCheckout = emps.filter((e) => e.inTime && !e.finalOut && !e.hrFinalStatus).length;
    attendanceToday.synced = true;
    for (const e of emps) {
      const dept = e.department || "Unknown";
      if (!deptTodayMap[dept]) deptTodayMap[dept] = { present: 0, absent: 0, onLeave: 0 };
      const st = statusOf(e);
      if (isPresent(st)) deptTodayMap[dept].present += 1;
      else if (isAbsent(st)) deptTodayMap[dept].absent += 1;
      else if (isOnLeave(st)) deptTodayMap[dept].onLeave += 1;
    }
  }
  attendanceToday.attendanceRate =
    activeEmployees > 0 ? Math.round((attendanceToday.present / activeEmployees) * 100) : 0;

  const departments = departmentBreakdown.map((d) => {
    const name = d._id || "Unknown";
    const t = deptTodayMap[name] || { present: 0, absent: 0, onLeave: 0 };
    return {
      department: name,
      headcount: d.count,
      present: t.present,
      absent: t.absent,
      onLeave: t.onLeave,
      attendanceRate: d.count > 0 ? Math.round((t.present / d.count) * 100) : 0,
    };
  });

  // 3. Monthly attendance summary (aggregate)
  const monthlyDocs = await DailyAttendanceModel.find({
    dateStr: { $gte: monthStart, $lte: monthEnd },
  })
    .select("dateStr summary")
    .lean();
  const monthly = {
    workingDays: 0,
    totalPresent: 0,
    totalAbsent: 0,
    totalLate: 0,
    totalLeaves: 0,
    avgAttendanceRate: 0,
  };
  for (const day of monthlyDocs) {
    if (!day.summary) continue;
    monthly.workingDays += 1;
    monthly.totalPresent +=
      (day.summary.P || 0) +
      (day.summary["P*"] || 0) +
      (day.summary["P~"] || 0) +
      (day.summary.HD || 0);
    monthly.totalAbsent += day.summary.AB || 0;
    monthly.totalLate += day.summary["P*"] || 0;
    monthly.totalLeaves +=
      (day.summary["L-CL"] || 0) + (day.summary["L-SL"] || 0) + (day.summary["L-EL"] || 0);
  }
  if (monthly.workingDays > 0 && activeEmployees > 0) {
    monthly.avgAttendanceRate = Math.round(
      (monthly.totalPresent / (monthly.workingDays * activeEmployees)) * 100,
    );
  }

  // 4. Leave + regularisation pending counts (counts only, no applicant data)
  const [pendingLeaveTotal, leavesAtManager, leavesAtHR, todayOnLeaveCount] = await Promise.all([
    LeaveApplicationModel.countDocuments({ status: { $in: ["pending", "manager_approved"] } }),
    LeaveApplicationModel.countDocuments({ status: "pending" }),
    LeaveApplicationModel.countDocuments({ status: "manager_approved" }),
    LeaveApplicationModel.countDocuments({
      status: "hr_approved",
      fromDate: { $lte: today },
      toDate: { $gte: today },
    }),
  ]);

  const [regPendingTotal, regAtManager, regAtHR] = await Promise.all([
    RegularizationRequestModel.countDocuments({ status: { $in: ["pending", "manager_approved"] } }),
    RegularizationRequestModel.countDocuments({ status: "pending" }),
    RegularizationRequestModel.countDocuments({ status: "manager_approved" }),
  ]);

  // 5. Upcoming holidays (public calendar info — name/date/type only)
  const holidayDocs = await CompanyHolidayModel.find({ date: { $gte: today } })
    .sort({ date: 1 })
    .limit(5)
    .lean();
  const upcomingHolidays = holidayDocs.map((h) => ({ date: h.date, name: h.name, type: h.type }));

  // 6. Alerts (already aggregate, message-level)
  const alerts = [];
  if (attendanceToday.pendingCheckout > 0) {
    alerts.push({
      category: "attendance",
      severity: "warning",
      message: `${attendanceToday.pendingCheckout} employee(s) have not checked out yet.`,
    });
  }
  if (pendingLeaveTotal > 0) {
    alerts.push({
      category: "leave",
      severity: "info",
      message: `${pendingLeaveTotal} leave application(s) pending approval.`,
    });
  }
  if (regPendingTotal > 0) {
    alerts.push({
      category: "regularization",
      severity: "info",
      message: `${regPendingTotal} regularisation request(s) pending.`,
    });
  }
  const absentRate =
    activeEmployees > 0 ? (attendanceToday.absent / activeEmployees) * 100 : 0;
  if (absentRate > 10) {
    alerts.push({
      category: "attendance",
      severity: "warning",
      message: `High absence rate today: ${Math.round(absentRate)}%.`,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    date: today,
    headcount: {
      total: totalEmployees,
      active: activeEmployees,
      inactive: inactiveEmployees,
    },
    departments,
    attendanceToday,
    attendanceMonthly: monthly,
    leaves: {
      pendingTotal: pendingLeaveTotal,
      pendingAtManager: leavesAtManager,
      pendingAtHR: leavesAtHR,
      onLeaveToday: todayOnLeaveCount,
    },
    regularizations: {
      pendingTotal: regPendingTotal,
      pendingAtManager: regAtManager,
      pendingAtHR: regAtHR,
    },
    upcomingHolidays,
    alerts,
  };
}

module.exports = { buildHrOverviewContext };
