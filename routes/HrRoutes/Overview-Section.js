"use strict";
/**
 * Overview-Section.js — HR Dashboard Overview & Statistics
 * 
 * Provides real-time aggregated data for HR dashboard:
 * - Employee statistics (total, active, by department)
 * - Today's attendance summary (present, absent, late, on leave)
 * - Leave statistics (pending approvals, today's leaves)
 * - Recent activities & alerts
 * - Department-wise breakdown
 * - Upcoming holidays & events
 */

const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const { LeaveApplication, LeaveBalance, CompanyHoliday, RegularizationRequest } = require("../../models/HR_Models/LeaveManagement");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

// ═══════════════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

function dateStrOf(d) {
    const ist = new Date(d.getTime() + 330 * 60 * 1000);
    return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
}

function getTodayIST() {
    const now = new Date(Date.now() + 330 * 60 * 1000);
    return dateStrOf(now);
}

function getYesterdayIST() {
    const yesterday = new Date(Date.now() + 330 * 60 * 1000 - 86400000);
    return dateStrOf(yesterday);
}

function getThisMonthRange() {
    const now = new Date(Date.now() + 330 * 60 * 1000);
    const year = now.getUTCFullYear();
    const month = now.getUTCMonth() + 1;
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { from, to, yearMonth: `${year}-${String(month).padStart(2, "0")}` };
}

// ═══════════════════════════════════════════════════════════════════════════
//  MAIN DASHBOARD OVERVIEW
// ═══════════════════════════════════════════════════════════════════════════

router.get("/dashboard", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = getTodayIST();
        const yesterday = getYesterdayIST();
        const { from: monthStart, to: monthEnd } = getThisMonthRange();

        // ── 1. EMPLOYEE STATISTICS ────────────────────────────────────────
        const [totalEmployees, activeEmployees, departmentBreakdown] = await Promise.all([
            Employee.countDocuments(),
            Employee.countDocuments({
                $or: [{ status: "active" }, { isActive: true }]
            }),
            Employee.aggregate([
                {
                    $match: {
                        $or: [{ status: "active" }, { isActive: true }]
                    }
                },
                {
                    $group: {
                        _id: "$department",
                        count: { $sum: 1 }
                    }
                },
                { $sort: { count: -1 } }
            ])
        ]);

        const inactiveEmployees = totalEmployees - activeEmployees;

        // ── 2. TODAY'S ATTENDANCE ─────────────────────────────────────────
        const todayAttendance = await DailyAttendance.findOne({ dateStr: today }).lean();

        let attendanceStats = {
            total: activeEmployees,
            present: 0,
            absent: 0,
            late: 0,
            onLeave: 0,
            halfDay: 0,
            weeklyOff: 0,
            pendingCheckout: 0,
            notSynced: activeEmployees, // Default to all if not synced
        };

        if (todayAttendance?.employees) {
            const empData = todayAttendance.employees;

            attendanceStats.present = empData.filter(e => {
                const st = e.hrFinalStatus || e.systemPrediction;
                return ["P", "P*", "P~", "HD"].includes(st);
            }).length;

            attendanceStats.late = empData.filter(e => {
                const st = e.hrFinalStatus || e.systemPrediction;
                return st === "P*" || e.isLate;
            }).length;

            attendanceStats.absent = empData.filter(e => {
                const st = e.hrFinalStatus || e.systemPrediction;
                return st === "AB";
            }).length;

            attendanceStats.onLeave = empData.filter(e => {
                const st = e.hrFinalStatus || e.systemPrediction;
                return st?.startsWith("L-") || ["LWP", "WFH", "CO"].includes(st);
            }).length;

            attendanceStats.halfDay = empData.filter(e => {
                const st = e.hrFinalStatus || e.systemPrediction;
                return st === "HD";
            }).length;

            attendanceStats.weeklyOff = empData.filter(e => {
                const st = e.hrFinalStatus || e.systemPrediction;
                return ["WO", "FH", "NH", "OH", "RH", "PH"].includes(st);
            }).length;

            attendanceStats.pendingCheckout = empData.filter(e => {
                return e.inTime && !e.finalOut && !e.hrFinalStatus;
            }).length;

            attendanceStats.notSynced = 0; // Data is synced
        }

        // ── 3. LEAVE STATISTICS ───────────────────────────────────────────
        const [
            pendingLeaveApps,
            todayLeaves,
            managerPendingLeaves,
            hrPendingLeaves
        ] = await Promise.all([
            LeaveApplication.countDocuments({
                status: { $in: ["pending", "manager_approved"] }
            }),
            LeaveApplication.countDocuments({
                status: "hr_approved",
                fromDate: { $lte: today },
                toDate: { $gte: today }
            }),
            LeaveApplication.countDocuments({ status: "pending" }),
            LeaveApplication.countDocuments({ status: "manager_approved" })
        ]);

        // ── 4. REGULARIZATION REQUESTS ────────────────────────────────────
        const [
            pendingRegularizations,
            managerPendingReg,
            hrPendingReg
        ] = await Promise.all([
            RegularizationRequest.countDocuments({
                status: { $in: ["pending", "manager_approved"] }
            }),
            RegularizationRequest.countDocuments({ status: "pending" }),
            RegularizationRequest.countDocuments({ status: "manager_approved" })
        ]);

        // ── 5. MONTHLY ATTENDANCE SUMMARY ─────────────────────────────────
        const monthlyAttendance = await DailyAttendance.find({
            dateStr: { $gte: monthStart, $lte: monthEnd }
        }).select("dateStr summary").lean();

        const monthlyStats = {
            totalWorkingDays: 0,
            totalPresent: 0,
            totalAbsent: 0,
            totalLate: 0,
            totalLeaves: 0,
            avgAttendanceRate: 0
        };

        monthlyAttendance.forEach(day => {
            if (day.summary) {
                monthlyStats.totalWorkingDays++;
                monthlyStats.totalPresent += (day.summary.P || 0) + (day.summary["P*"] || 0) + (day.summary["P~"] || 0);
                monthlyStats.totalAbsent += day.summary.AB || 0;
                monthlyStats.totalLate += day.summary["P*"] || 0;
                monthlyStats.totalLeaves += (day.summary["L-CL"] || 0) + (day.summary["L-SL"] || 0) + (day.summary["L-EL"] || 0);
            }
        });

        if (monthlyStats.totalWorkingDays > 0 && activeEmployees > 0) {
            monthlyStats.avgAttendanceRate = Math.round(
                (monthlyStats.totalPresent / (monthlyStats.totalWorkingDays * activeEmployees)) * 100
            );
        }

        // ── 6. UPCOMING HOLIDAYS ──────────────────────────────────────────
        const upcomingHolidays = await CompanyHoliday.find({
            date: { $gte: today }
        }).sort({ date: 1 }).limit(5).lean();

        // ── 7. RECENT HIRES (Last 30 days) ────────────────────────────────
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000);
        const recentHires = await Employee.find({
            createdAt: { $gte: thirtyDaysAgo }
        })
            .select("firstName lastName department designation createdAt")
            .sort({ createdAt: -1 })
            .limit(5)
            .lean();

        // ── 8. ALERTS & NOTIFICATIONS ─────────────────────────────────────
        const alerts = [];

        // Miss punch alerts
        if (attendanceStats.pendingCheckout > 0) {
            alerts.push({
                type: "warning",
                category: "attendance",
                message: `${attendanceStats.pendingCheckout} employee(s) haven't checked out yet`,
                count: attendanceStats.pendingCheckout,
                action: "view_attendance"
            });
        }

        // Pending leave approvals
        if (pendingLeaveApps > 0) {
            alerts.push({
                type: "info",
                category: "leave",
                message: `${pendingLeaveApps} leave application(s) pending approval`,
                count: pendingLeaveApps,
                action: "view_leaves"
            });
        }

        // Pending regularizations
        if (pendingRegularizations > 0) {
            alerts.push({
                type: "info",
                category: "regularization",
                message: `${pendingRegularizations} regularization request(s) pending`,
                count: pendingRegularizations,
                action: "view_regularizations"
            });
        }

        // High absence rate
        const absentRate = activeEmployees > 0 ? (attendanceStats.absent / activeEmployees) * 100 : 0;
        if (absentRate > 10) {
            alerts.push({
                type: "warning",
                category: "attendance",
                message: `High absence rate today: ${Math.round(absentRate)}%`,
                count: attendanceStats.absent,
                action: "view_attendance"
            });
        }

        // ── RESPONSE ──────────────────────────────────────────────────────
        res.json({
            success: true,
            data: {
                // Employee Overview
                employees: {
                    total: totalEmployees,
                    active: activeEmployees,
                    inactive: inactiveEmployees,
                    byDepartment: departmentBreakdown.map(d => ({
                        department: d._id || "Unknown",
                        count: d.count
                    })),
                    recentHires: recentHires.map(e => ({
                        name: `${e.firstName} ${e.lastName}`,
                        department: e.department,
                        designation: e.designation,
                        joinedOn: e.createdAt
                    }))
                },

                // Attendance Overview
                attendance: {
                    today: attendanceStats,
                    monthly: monthlyStats,
                    lastSynced: todayAttendance?.syncedAt || null
                },

                // Leave Overview
                leaves: {
                    todayOnLeave: todayLeaves,
                    pendingApprovals: {
                        total: pendingLeaveApps,
                        atManager: managerPendingLeaves,
                        atHR: hrPendingLeaves
                    }
                },

                // Regularization Overview
                regularizations: {
                    pendingApprovals: {
                        total: pendingRegularizations,
                        atManager: managerPendingReg,
                        atHR: hrPendingReg
                    }
                },

                // Upcoming Events
                upcomingHolidays: upcomingHolidays.map(h => ({
                    date: h.date,
                    name: h.name,
                    type: h.type
                })),

                // Alerts
                alerts,

                // Metadata
                generatedAt: new Date(),
                todayDate: today
            }
        });

    } catch (err) {
        console.error("[OVERVIEW] Dashboard error:", err.message);
        res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  ATTENDANCE SUMMARY (Today + Yesterday comparison)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/attendance-summary", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = getTodayIST();
        const yesterday = getYesterdayIST();

        const [todayData, yesterdayData, activeCount] = await Promise.all([
            DailyAttendance.findOne({ dateStr: today }).lean(),
            DailyAttendance.findOne({ dateStr: yesterday }).lean(),
            Employee.countDocuments({
                $or: [{ status: "active" }, { isActive: true }]
            })
        ]);

        const buildStats = (data) => {
            if (!data?.employees) {
                return {
                    total: activeCount,
                    present: 0,
                    absent: activeCount,
                    late: 0,
                    onLeave: 0,
                    halfDay: 0,
                    weeklyOff: 0,
                    synced: false
                };
            }

            const emps = data.employees;
            return {
                total: activeCount,
                present: emps.filter(e => ["P", "P*", "P~", "HD"].includes(e.hrFinalStatus || e.systemPrediction)).length,
                absent: emps.filter(e => (e.hrFinalStatus || e.systemPrediction) === "AB").length,
                late: emps.filter(e => (e.hrFinalStatus || e.systemPrediction) === "P*" || e.isLate).length,
                onLeave: emps.filter(e => {
                    const st = e.hrFinalStatus || e.systemPrediction;
                    return st?.startsWith("L-") || ["LWP", "WFH", "CO"].includes(st);
                }).length,
                halfDay: emps.filter(e => (e.hrFinalStatus || e.systemPrediction) === "HD").length,
                weeklyOff: emps.filter(e => ["WO", "FH", "NH", "OH", "RH", "PH"].includes(e.hrFinalStatus || e.systemPrediction)).length,
                synced: true
            };
        };

        res.json({
            success: true,
            data: {
                today: {
                    date: today,
                    ...buildStats(todayData),
                    lastSynced: todayData?.syncedAt
                },
                yesterday: {
                    date: yesterday,
                    ...buildStats(yesterdayData),
                    lastSynced: yesterdayData?.syncedAt
                }
            }
        });

    } catch (err) {
        console.error("[OVERVIEW] Attendance summary error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  LEAVE SUMMARY
// ═══════════════════════════════════════════════════════════════════════════

router.get("/leave-summary", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = getTodayIST();
        const { yearMonth } = getThisMonthRange();

        const [
            pendingApps,
            approvedToday,
            monthlyLeaves,
            recentApplications
        ] = await Promise.all([
            LeaveApplication.find({
                status: { $in: ["pending", "manager_approved"] }
            })
                .select("employeeName leaveType fromDate toDate status createdAt")
                .sort({ createdAt: -1 })
                .limit(10)
                .lean(),

            LeaveApplication.find({
                status: "hr_approved",
                fromDate: { $lte: today },
                toDate: { $gte: today }
            })
                .select("employeeName leaveType fromDate toDate department")
                .lean(),

            LeaveApplication.aggregate([
                {
                    $match: {
                        status: "hr_approved",
                        fromDate: { $regex: `^${yearMonth}` }
                    }
                },
                {
                    $group: {
                        _id: "$leaveType",
                        count: { $sum: 1 },
                        totalDays: { $sum: "$totalDays" }
                    }
                }
            ]),

            LeaveApplication.find({})
                .select("employeeName leaveType fromDate toDate status createdAt")
                .sort({ createdAt: -1 })
                .limit(5)
                .lean()
        ]);

        res.json({
            success: true,
            data: {
                pending: {
                    count: pendingApps.length,
                    applications: pendingApps.map(app => ({
                        id: app._id,
                        employeeName: app.employeeName,
                        leaveType: app.leaveType,
                        from: app.fromDate,
                        to: app.toDate,
                        status: app.status,
                        appliedOn: app.createdAt
                    }))
                },
                todayOnLeave: {
                    count: approvedToday.length,
                    employees: approvedToday.map(app => ({
                        name: app.employeeName,
                        department: app.department,
                        leaveType: app.leaveType,
                        from: app.fromDate,
                        to: app.toDate
                    }))
                },
                monthlyBreakdown: monthlyLeaves.map(l => ({
                    leaveType: l._id,
                    applications: l.count,
                    totalDays: l.totalDays
                })),
                recentActivity: recentApplications.map(app => ({
                    employeeName: app.employeeName,
                    leaveType: app.leaveType,
                    from: app.fromDate,
                    to: app.toDate,
                    status: app.status,
                    appliedOn: app.createdAt
                }))
            }
        });

    } catch (err) {
        console.error("[OVERVIEW] Leave summary error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  QUICK STATS (Single endpoint for cards)
// ═══════════════════════════════════════════════════════════════════════════

router.get("/quick-stats", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = getTodayIST();

        const [
            totalEmployees,
            activeEmployees,
            todayPresent,
            pendingLeaves,
            pendingRegularizations
        ] = await Promise.all([
            Employee.countDocuments(),
            Employee.countDocuments({
                $or: [{ status: "active" }, { isActive: true }]
            }),
            DailyAttendance.findOne({ dateStr: today })
                .select("summary employees")
                .lean()
                .then(data => {
                    if (!data?.employees) return 0;
                    return data.employees.filter(e => {
                        const st = e.hrFinalStatus || e.systemPrediction;
                        return ["P", "P*", "P~", "HD"].includes(st);
                    }).length;
                }),
            LeaveApplication.countDocuments({
                status: { $in: ["pending", "manager_approved"] }
            }),
            RegularizationRequest.countDocuments({
                status: { $in: ["pending", "manager_approved"] }
            })
        ]);

        const attendanceRate = activeEmployees > 0
            ? Math.round((todayPresent / activeEmployees) * 100)
            : 0;

        res.json({
            success: true,
            data: {
                employees: {
                    total: totalEmployees,
                    active: activeEmployees,
                    inactive: totalEmployees - activeEmployees
                },
                attendance: {
                    present: todayPresent,
                    total: activeEmployees,
                    rate: attendanceRate
                },
                pendingActions: {
                    leaves: pendingLeaves,
                    regularizations: pendingRegularizations,
                    total: pendingLeaves + pendingRegularizations
                }
            }
        });

    } catch (err) {
        console.error("[OVERVIEW] Quick stats error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  DEPARTMENT BREAKDOWN
// ═══════════════════════════════════════════════════════════════════════════

router.get("/department-breakdown", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = getTodayIST();

        const [departments, todayAttendance] = await Promise.all([
            Employee.aggregate([
                {
                    $match: {
                        $or: [{ status: "active" }, { isActive: true }]
                    }
                },
                {
                    $group: {
                        _id: "$department",
                        total: { $sum: 1 }
                    }
                },
                { $sort: { total: -1 } }
            ]),
            DailyAttendance.findOne({ dateStr: today }).lean()
        ]);

        const deptStats = departments.map(dept => {
            const deptName = dept._id || "Unknown";
            let present = 0;
            let absent = 0;
            let onLeave = 0;

            if (todayAttendance?.employees) {
                const deptEmps = todayAttendance.employees.filter(e => e.department === deptName);

                present = deptEmps.filter(e => {
                    const st = e.hrFinalStatus || e.systemPrediction;
                    return ["P", "P*", "P~", "HD"].includes(st);
                }).length;

                absent = deptEmps.filter(e => {
                    const st = e.hrFinalStatus || e.systemPrediction;
                    return st === "AB";
                }).length;

                onLeave = deptEmps.filter(e => {
                    const st = e.hrFinalStatus || e.systemPrediction;
                    return st?.startsWith("L-") || ["LWP", "WFH", "CO"].includes(st);
                }).length;
            }

            return {
                department: deptName,
                total: dept.total,
                present,
                absent,
                onLeave,
                attendanceRate: dept.total > 0 ? Math.round((present / dept.total) * 100) : 0
            };
        });

        res.json({
            success: true,
            data: deptStats
        });

    } catch (err) {
        console.error("[OVERVIEW] Department breakdown error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  RECENT ACTIVITIES
// ═══════════════════════════════════════════════════════════════════════════

router.get("/recent-activities", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const limit = parseInt(req.query.limit) || 20;

        const [
            recentLeaves,
            recentHires,
            recentRegularizations
        ] = await Promise.all([
            LeaveApplication.find({})
                .select("employeeName leaveType fromDate toDate status createdAt")
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean(),

            Employee.find({})
                .select("firstName lastName department designation createdAt")
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean(),

            RegularizationRequest.find({})
                .select("employeeName requestType dateStr status createdAt")
                .sort({ createdAt: -1 })
                .limit(limit)
                .lean()
        ]);

        // Combine and sort all activities
        const activities = [
            ...recentLeaves.map(l => ({
                type: "leave_application",
                message: `${l.employeeName} applied for ${l.leaveType} leave`,
                details: `${l.fromDate} to ${l.toDate}`,
                status: l.status,
                timestamp: l.createdAt
            })),
            ...recentHires.map(e => ({
                type: "new_hire",
                message: `${e.firstName} ${e.lastName} joined as ${e.designation}`,
                details: e.department,
                status: "completed",
                timestamp: e.createdAt
            })),
            ...recentRegularizations.map(r => ({
                type: "regularization",
                message: `${r.employeeName} requested ${r.requestType} for ${r.dateStr}`,
                details: r.requestType,
                status: r.status,
                timestamp: r.createdAt
            }))
        ];

        // Sort by timestamp descending
        activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        res.json({
            success: true,
            data: activities.slice(0, limit)
        });

    } catch (err) {
        console.error("[OVERVIEW] Recent activities error:", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;