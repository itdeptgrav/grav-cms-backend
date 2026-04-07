/**
 * Attendance_section.js  –  v6  (GRAV Clothing)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Route: mounted at /hr/attendance in server.js
 *
 * Complete attendance management API:
 *  - Biometric sync (on-demand + status)
 *  - Daily view, monthly view, employee view
 *  - Muster roll
 *  - HR overrides (single, bulk, month-finalise)
 *  - Miss punch requests
 *  - Holidays CRUD
 *  - Settings
 *  - Shifts CRUD
 *  - Leave integration (apply, approve, balance)
 *  - Analytics dashboard
 *  - Sync status & debug
 */

"use strict";

const express = require("express");
const router = express.Router();

const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const Employee = require("../../models/Employee");
const { AttendanceSettings, Shift } = require("../../models/HR_Models/Attendancesettings");
const { LeaveBalance, LeaveApplication } = require("../../models/HR_Models/LeaveManagement");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

const engine = require("../../services/Attendanceengine");
const syncService = require("../../services/BiometricSyncService");

// Dependency bundle for the sync service
const deps = { DailyAttendance, Employee, AttendanceSettings };


// ═══════════════════════════════════════════════════════════════════════════════
//  SYNC ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * POST /sync — On-demand sync from eTimeOffice
 * Body: { fromDate: "YYYY-MM-DD", toDate: "YYYY-MM-DD", empCode?: "ALL"|"0072" }
 */
router.post("/sync", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { fromDate, toDate, empCode } = req.body;
        if (!fromDate || !toDate) {
            return res.status(400).json({ success: false, message: "fromDate and toDate required (YYYY-MM-DD)" });
        }
        const result = await syncService.syncDateRange(fromDate, toDate, empCode || "ALL", deps);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /sync/today — Quick sync for today (and yesterday for overnight punches)
 */
router.post("/sync/today", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0];
        const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
        const result = await syncService.syncDateRange(yesterday, today, "ALL", deps);
        res.json({ success: true, ...result });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /sync/status — Get current sync service status
 */
router.get("/sync/status", EmployeeAuthMiddlewear, async (req, res) => {
    res.json({ success: true, data: syncService.getStatus() });
});

/**
 * Helper: silent sync that doesn't throw (used before read operations)
 */
async function silentSync(fromDate, toDate, empCode = "ALL") {
    try {
        await syncService.syncDateRange(fromDate, toDate, empCode, deps);
    } catch (e) {
        console.warn("⚠️  Silent sync failed:", e.message);
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//  DAILY VIEW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /daily?date=YYYY-MM-DD&department=xxx
 * Returns all attendance records for a single day, with summary stats.
 */
router.get("/daily", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date) return res.status(400).json({ success: false, message: "date required (YYYY-MM-DD)" });

        // Auto-sync this day (silent — won't fail the request)
        await silentSync(date, date);

        const query = { dateStr: date };
        if (department && department !== "all") query.department = department;

        const records = await DailyAttendance.find(query).sort({ employeeName: 1 }).lean();
        const enriched = records.map(engine.enrichRecord);

        // Build summary
        const summary = {
            total: enriched.length,
            P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, MP: 0,
            leave: 0, unreviewed: 0, presentCount: 0,
        };
        enriched.forEach(r => {
            const s = r.effectiveStatus;
            if (summary[s] !== undefined) summary[s]++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "CO"].includes(s)) summary.leave++;
            if (!r.hrReviewed) summary.unreviewed++;
        });
        summary.presentCount = (summary.P || 0) + (summary["P*"] || 0) + (summary["P~"] || 0) + (summary.MP || 0);

        res.json({ success: true, data: enriched, count: enriched.length, summary });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * GET /today — Quick summary for today
 */
router.get("/today", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const today = new Date().toISOString().split("T")[0];
        await silentSync(today, today);

        const records = await DailyAttendance.find({ dateStr: today }).lean();
        const summary = { total: records.length, present: 0, absent: 0, late: 0, mp: 0, halfDay: 0, onLeave: 0, unreviewed: 0 };

        records.forEach(r => {
            const s = r.hrFinalStatus ?? r.systemPrediction ?? "AB";
            if (["P", "P*", "P~"].includes(s)) summary.present++;
            else if (s === "AB") summary.absent++;
            else if (s === "HD") summary.halfDay++;
            if (s === "MP") summary.mp++;
            if (s === "P*") summary.late++;
            if (["L-CL", "L-SL", "L-EL"].includes(s)) summary.onLeave++;
            if (!r.hrFinalStatus) summary.unreviewed++;
        });

        res.json({ success: true, date: today, summary, data: records.map(engine.enrichRecord) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  MONTHLY VIEW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /monthly?yearMonth=YYYY-MM&department=xxx&empCode=xxx
 * Returns monthly attendance for all employees with day-by-day breakdown + summary.
 */
router.get("/monthly", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department, empCode } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required (YYYY-MM)" });

        const [year, month] = yearMonth.split("-").map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const fromDate = `${yearMonth}-01`;
        const toDate = `${yearMonth}-${String(daysInMonth).padStart(2, "0")}`;

        await silentSync(fromDate, toDate, empCode || "ALL");

        const query = { yearMonth };
        if (department && department !== "all") query.department = department;
        if (empCode) query.biometricId = empCode;

        const records = await DailyAttendance.find(query)
            .sort({ employeeName: 1, dateStr: 1 })
            .lean();

        // Group by employee
        const byEmployee = {};
        records.forEach(r => {
            const key = r.biometricId;
            if (!byEmployee[key]) {
                byEmployee[key] = {
                    biometricId: r.biometricId,
                    numericId: r.numericId,
                    identityId: r.identityId,
                    employeeName: r.employeeName,
                    department: r.department,
                    designation: r.designation,
                    employeeType: r.employeeType,
                    days: [],
                    unreviewedDays: 0,
                };
            }
            const enriched = engine.enrichRecord(r);
            byEmployee[key].days.push(enriched);
            if (!enriched.hrReviewed) byEmployee[key].unreviewedDays++;
        });

        const result = Object.values(byEmployee).map(e => ({
            ...e,
            summary: engine.computeMonthSummary(e.days),
            totalNetWorkStr: engine.minsToHHMM(e.days.reduce((a, d) => a + (d.netWorkMins || 0), 0)),
            totalOtStr: engine.minsToHHMM(e.days.reduce((a, d) => a + (d.otMins || 0), 0)),
        }));

        res.json({ success: true, yearMonth, fromDate, toDate, data: result, employeeCount: result.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  SINGLE EMPLOYEE VIEW
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /employee/:empId?yearMonth=YYYY-MM
 * empId can be "0072", "GR072", "72", or a MongoDB _id
 */
router.get("/employee/:empId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { empId } = req.params;
        const { yearMonth } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const numericId = engine.normalizeId(empId);
        if (numericId === null) return res.status(400).json({ success: false, message: "Invalid employee ID" });

        const [y, m] = yearMonth.split("-").map(Number);
        const from = `${yearMonth}-01`;
        const to = `${yearMonth}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;

        await silentSync(from, to);

        const records = await DailyAttendance.find({ numericId, yearMonth }).sort({ dateStr: 1 }).lean();
        const enriched = records.map(engine.enrichRecord);
        const summary = engine.computeMonthSummary(enriched);

        // Also fetch leave balance for the employee
        let leaveBalance = null;
        if (records.length > 0 && records[0].employeeDbId) {
            const lb = await LeaveBalance.findOne({
                employeeId: records[0].employeeDbId,
                year: y
            }).lean();
            if (lb) {
                leaveBalance = {
                    entitlement: lb.entitlement,
                    consumed: lb.consumed,
                    available: {
                        CL: (lb.entitlement?.CL || 0) - (lb.consumed?.CL || 0),
                        SL: (lb.entitlement?.SL || 0) + (lb.carriedForward?.SL || 0) - (lb.consumed?.SL || 0),
                        EL: (lb.entitlement?.EL || 0) + (lb.carriedForward?.EL || 0) - (lb.consumed?.EL || 0),
                        CO: (lb.entitlement?.CO || 0) - (lb.consumed?.CO || 0),
                    },
                };
            }
        }

        res.json({ success: true, data: enriched, summary, leaveBalance });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  MUSTER ROLL (calendar-grid format)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /muster-roll?yearMonth=YYYY-MM&department=xxx
 * Returns data in the format needed for the muster roll grid (like the PDF report).
 */
router.get("/muster-roll", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const [year, month] = yearMonth.split("-").map(Number);
        const daysInMonth = new Date(year, month, 0).getDate();
        const fromDate = `${yearMonth}-01`;
        const toDate = `${yearMonth}-${String(daysInMonth).padStart(2, "0")}`;

        await silentSync(fromDate, toDate);

        const query = { yearMonth };
        if (department && department !== "all") query.department = department;
        const records = await DailyAttendance.find(query).sort({ employeeName: 1, dateStr: 1 }).lean();

        const byEmp = {};
        records.forEach(r => {
            const es = r.hrFinalStatus ?? r.systemPrediction ?? "AB";
            if (!byEmp[r.biometricId]) {
                byEmp[r.biometricId] = {
                    empCode: r.biometricId,
                    identityId: r.identityId || r.biometricId,
                    name: r.employeeName,
                    department: r.department,
                    designation: r.designation,
                    employeeType: r.employeeType,
                    days: {},
                    hasUnreviewed: false,
                    summary: { present: 0, absent: 0, halfDay: 0, late: 0, leave: 0, wo: 0, ph: 0, mp: 0, totalWorkMins: 0, totalOtMins: 0 },
                };
            }
            const emp = byEmp[r.biometricId];
            const dayNum = new Date(r.dateStr + "T00:00:00Z").getUTCDate();
            if (!r.hrFinalStatus) emp.hasUnreviewed = true;

            emp.days[dayNum] = {
                status: es,
                systemStatus: r.systemPrediction,
                hrStatus: r.hrFinalStatus,
                isVerified: r.hrFinalStatus !== null,
                inTime: r.inTime ? engine.dateToTimeStrIST(r.inTime) : "--:--",
                outTime: r.finalOut ? engine.dateToTimeStrIST(r.finalOut) : "--:--",
                netWork: engine.minsToHHMM(r.netWorkMins),
                otTime: engine.minsToHHMM(r.otMins),
                lateTime: engine.minsToHHMM(r.lateMins),
                breakTime: engine.minsToHHMM(r.totalBreakMins),
                punchCount: r.punchCount,
                hasMissPunch: r.hasMissPunch,
                isWeeklyOff: r.isWeeklyOff,
                isHoliday: r.isHoliday,
                holidayName: r.holidayName,
                hrRemarks: r.hrRemarks,
            };

            const s = emp.summary;
            if (["P", "P*", "P~", "MP"].includes(es)) s.present++;
            else if (es === "HD") s.halfDay++;
            else if (es === "AB") s.absent++;
            else if (es === "WO") s.wo++;
            else if (es === "PH") s.ph++;
            else if (["L-CL", "L-SL", "L-EL", "LWP", "CO"].includes(es)) s.leave++;
            if (es === "P*") s.late++;
            if (es === "MP") s.mp++;
            s.totalWorkMins += r.netWorkMins || 0;
            s.totalOtMins += r.otMins || 0;
        });

        const dowLabels = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
        const dayHeaders = Array.from({ length: daysInMonth }, (_, i) => {
            const d = new Date(year, month - 1, i + 1);
            return { day: i + 1, dow: dowLabels[d.getDay()], date: `${yearMonth}-${String(i + 1).padStart(2, "0")}` };
        });

        const employees = Object.values(byEmp).map(emp => {
            // Calculate late penalty
            const latePenalty = Math.floor(emp.summary.late / 4);
            return {
                ...emp,
                summary: {
                    ...emp.summary,
                    totalWorkStr: engine.minsToHHMM(emp.summary.totalWorkMins),
                    totalOtStr: engine.minsToHHMM(emp.summary.totalOtMins),
                    lateDeductionHalfDays: latePenalty,
                    effectivePresentDays: emp.summary.present + (emp.summary.halfDay * 0.5) - (latePenalty * 0.5),
                },
                daysArray: Array.from({ length: daysInMonth }, (_, i) => emp.days[i + 1] || {
                    status: null, inTime: "--:--", outTime: "--:--",
                    netWork: "00:00", otTime: "00:00", lateTime: "00:00", breakTime: "00:00",
                    punchCount: 0, hasMissPunch: false, isWeeklyOff: false, isHoliday: false, isVerified: false,
                }),
            };
        });

        res.json({
            success: true, yearMonth, daysInMonth, dayHeaders, employees,
            hasUnreviewed: employees.some(e => e.hasUnreviewed),
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  HR OVERRIDE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/** PUT /day-override — HR overrides status for a single day */
router.put("/day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, dateStr, hrFinalStatus, hrRemarks } = req.body;
        if (!dateStr || !hrFinalStatus) {
            return res.status(400).json({ success: false, message: "dateStr and hrFinalStatus required" });
        }

        const numericId = engine.normalizeId(biometricId);
        const record = await DailyAttendance.findOne({ numericId, dateStr });
        if (!record) return res.status(404).json({ success: false, message: "Attendance record not found" });

        record.hrFinalStatus = hrFinalStatus;
        record.hrRemarks = hrRemarks || null;
        record.hrUpdatedBy = req.user?.id || null;
        record.hrUpdatedAt = new Date();
        await record.save();

        res.json({ success: true, message: "HR override saved", data: engine.enrichRecord(record.toObject()) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /bulk-day-override — HR overrides multiple days at once */
router.put("/bulk-day-override", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { overrides } = req.body;
        if (!Array.isArray(overrides) || !overrides.length) {
            return res.status(400).json({ success: false, message: "overrides array required" });
        }

        const ops = overrides.map(o => ({
            updateOne: {
                filter: { numericId: engine.normalizeId(o.biometricId), dateStr: o.dateStr },
                update: {
                    $set: {
                        hrFinalStatus: o.hrFinalStatus,
                        hrRemarks: o.hrRemarks || null,
                        hrUpdatedBy: req.user?.id || null,
                        hrUpdatedAt: new Date(),
                    },
                },
            },
        }));

        const result = await DailyAttendance.bulkWrite(ops, { ordered: false });
        res.json({ success: true, modifiedCount: result.modifiedCount });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /month-finalise — Confirm all unreviewed days with system prediction */
router.put("/month-finalise", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, biometricId } = req.body;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const query = { yearMonth, hrFinalStatus: null };
        if (biometricId) query.numericId = engine.normalizeId(biometricId);

        const result = await DailyAttendance.updateMany(
            query,
            [{ $set: { hrFinalStatus: "$systemPrediction", hrUpdatedAt: new Date() } }]
        );
        res.json({
            success: true,
            message: `Finalised. ${result.modifiedCount} days confirmed.`,
            modifiedCount: result.modifiedCount,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  MISS PUNCH ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/** POST /miss-punch — Submit a miss punch request */
router.post("/miss-punch", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { biometricId, dateStr, punchSlot, requestedTime, reason } = req.body;
        if (!biometricId || !dateStr || !punchSlot || !requestedTime) {
            return res.status(400).json({ success: false, message: "biometricId, dateStr, punchSlot, requestedTime required" });
        }

        const numericId = engine.normalizeId(biometricId);
        let record = await DailyAttendance.findOne({ numericId, dateStr });
        if (!record) return res.status(404).json({ success: false, message: "No attendance record found for this date" });

        record.missPunchRequests.push({
            requestedBy: req.user?.id,
            requestedAt: new Date(),
            punchSlot: parseInt(punchSlot, 10),
            requestedTime: new Date(requestedTime),
            reason,
            status: "pending",
        });
        record.hasMissPunch = true;
        await record.save();

        res.json({ success: true, message: "Miss punch request submitted" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /miss-punch/:attendanceId/:requestId/approve — Approve at manager or HR level */
router.put("/miss-punch/:attendanceId/:requestId/approve", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { attendanceId, requestId } = req.params;
        const { stage } = req.body; // "manager" or "hr"

        const record = await DailyAttendance.findById(attendanceId);
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });

        const mpReq = record.missPunchRequests.id(requestId);
        if (!mpReq) return res.status(404).json({ success: false, message: "Request not found" });

        if (stage === "manager") {
            mpReq.status = "manager_approved";
            mpReq.managerApprovedBy = req.user?.id;
            mpReq.managerApprovedAt = new Date();
        } else if (stage === "hr") {
            if (mpReq.status !== "manager_approved") {
                return res.status(400).json({ success: false, message: "Manager must approve first" });
            }
            mpReq.status = "hr_approved";
            mpReq.hrApprovedBy = req.user?.id;
            mpReq.hrApprovedAt = new Date();

            // Apply the miss punch: inject the corrected time and recompute
            await applySettledMissPunch(record, mpReq);
        }

        await record.save();
        res.json({ success: true, message: `${stage} approval done`, data: engine.enrichRecord(record.toObject()) });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /miss-punch/:attendanceId/:requestId/reject */
router.put("/miss-punch/:attendanceId/:requestId/reject", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { attendanceId, requestId } = req.params;
        const { reason } = req.body;

        const record = await DailyAttendance.findById(attendanceId);
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });

        const mpReq = record.missPunchRequests.id(requestId);
        if (!mpReq) return res.status(404).json({ success: false, message: "Request not found" });

        mpReq.status = "rejected";
        mpReq.rejectedBy = req.user?.id;
        mpReq.rejectedAt = new Date();
        mpReq.rejectionReason = reason || "";

        await record.save();
        res.json({ success: true, message: "Request rejected" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /miss-punch/pending — List all pending miss punch requests */
router.get("/miss-punch/pending", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { department, stage } = req.query;
        const matchStatus = stage === "hr" ? "manager_approved" : "pending";

        const query = { "missPunchRequests.status": matchStatus };
        if (department && department !== "all") query.department = department;

        const records = await DailyAttendance.find(query).lean();

        const pending = [];
        records.forEach(r => {
            r.missPunchRequests.forEach(mp => {
                if (mp.status === matchStatus) {
                    pending.push({
                        attendanceId: r._id,
                        requestId: mp._id,
                        biometricId: r.biometricId,
                        employeeName: r.employeeName,
                        department: r.department,
                        dateStr: r.dateStr,
                        punchSlot: mp.punchSlot,
                        requestedTime: mp.requestedTime,
                        reason: mp.reason,
                        requestedAt: mp.requestedAt,
                        status: mp.status,
                    });
                }
            });
        });

        res.json({ success: true, data: pending, count: pending.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** Helper: apply an approved miss punch to the record and recompute */
async function applySettledMissPunch(record, mpReq) {
    const slotField = { 1: "inTime", 2: "lunchOut", 3: "lunchIn", 4: "teaOut", 5: "teaIn", 6: "finalOut" };
    const slotPunchType = { 1: "in", 2: "lunch_out", 3: "lunch_in", 4: "tea_out", 5: "tea_in", 6: "out" };

    const field = slotField[mpReq.punchSlot];
    if (!field) return;

    // Set the named punch time
    record[field] = mpReq.requestedTime;

    // Add to raw punches
    record.rawPunches.push({
        seq: mpReq.punchSlot,
        time: mpReq.requestedTime,
        punchType: slotPunchType[mpReq.punchSlot] || "unknown",
        source: "miss_punch",
    });
    record.punchCount = record.rawPunches.length;

    // Recompute the day using the engine
    const settings = await AttendanceSettings.getSingleton();
    engine.computeDay(record, settings, record.employeeType, settings.holidays || []);

    // Check if there are still pending miss punch requests
    record.hasMissPunch = record.missPunchRequests.some(
        r => r.status === "pending" || r.status === "manager_approved"
    );
}


// ═══════════════════════════════════════════════════════════════════════════════
//  LEAVE MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/** POST /leave/apply — Employee submits a leave request */
router.post("/leave/apply", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { employeeId, biometricId, leaveType, fromDate, toDate, totalDays, isHalfDay, halfDaySlot, reason } = req.body;

        if (!employeeId || !leaveType || !fromDate || !toDate || !reason) {
            return res.status(400).json({ success: false, message: "employeeId, leaveType, fromDate, toDate, reason required" });
        }

        // Fetch employee info
        const emp = await Employee.findById(employeeId).lean();
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

        // Check leave balance (except LWP which is unlimited)
        if (leaveType !== "LWP" && leaveType !== "WFH") {
            const year = parseInt(fromDate.substring(0, 4), 10);
            const balance = await LeaveBalance.getOrCreate(employeeId, year, biometricId);
            const available = (balance.entitlement?.[leaveType] || 0) +
                (balance.carriedForward?.[leaveType] || 0) -
                (balance.consumed?.[leaveType] || 0);

            if (available < (totalDays || 1)) {
                return res.status(400).json({
                    success: false,
                    message: `Insufficient ${leaveType} balance. Available: ${available}, Requested: ${totalDays || 1}`,
                });
            }
        }

        const application = await LeaveApplication.create({
            employeeId,
            biometricId,
            employeeName: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(),
            department: emp.department || emp.workInfo?.department,
            leaveType,
            fromDate,
            toDate,
            totalDays: totalDays || 1,
            isHalfDay: isHalfDay || false,
            halfDaySlot: halfDaySlot || null,
            reason,
            status: "pending",
        });

        res.json({ success: true, message: "Leave application submitted", data: application });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /leave/:id/approve — PM or HR approves a leave */
router.put("/leave/:id/approve", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { stage, remarks } = req.body; // stage: "pm" or "hr"
        const application = await LeaveApplication.findById(req.params.id);
        if (!application) return res.status(404).json({ success: false, message: "Leave application not found" });

        if (stage === "pm") {
            if (application.status !== "pending") {
                return res.status(400).json({ success: false, message: "Can only approve pending applications" });
            }
            application.status = "pm_approved";
            application.pmApprovedBy = req.user?.id;
            application.pmApprovedAt = new Date();
            application.pmRemarks = remarks || "";
        } else if (stage === "hr") {
            if (application.status !== "pm_approved") {
                return res.status(400).json({ success: false, message: "PM must approve first" });
            }
            application.status = "hr_approved";
            application.hrApprovedBy = req.user?.id;
            application.hrApprovedAt = new Date();
            application.hrRemarks = remarks || "";

            // Apply leave to attendance records and update balance
            await applyLeaveToAttendance(application);
        }

        await application.save();
        res.json({ success: true, message: `${stage.toUpperCase()} approval done`, data: application });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** PUT /leave/:id/reject */
router.put("/leave/:id/reject", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { reason, stage } = req.body;
        const application = await LeaveApplication.findById(req.params.id);
        if (!application) return res.status(404).json({ success: false, message: "Not found" });

        application.status = stage === "hr" ? "hr_rejected" : "pm_rejected";
        application.rejectedBy = req.user?.id;
        application.rejectedAt = new Date();
        application.rejectionReason = reason || "";
        await application.save();

        res.json({ success: true, message: "Leave rejected" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /leave/pending — List pending leave applications */
router.get("/leave/pending", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { stage, department } = req.query;
        const statusFilter = stage === "hr" ? "pm_approved" : "pending";
        const query = { status: statusFilter };
        if (department && department !== "all") query.department = department;

        const applications = await LeaveApplication.find(query)
            .sort({ createdAt: -1 })
            .lean();

        res.json({ success: true, data: applications, count: applications.length });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /leave/balance/:employeeId?year=YYYY */
router.get("/leave/balance/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const year = parseInt(req.query.year || new Date().getFullYear(), 10);
        const balance = await LeaveBalance.getOrCreate(employeeId, year);

        const available = {
            CL: (balance.entitlement?.CL || 0) - (balance.consumed?.CL || 0),
            SL: (balance.entitlement?.SL || 0) + (balance.carriedForward?.SL || 0) - (balance.consumed?.SL || 0),
            EL: (balance.entitlement?.EL || 0) + (balance.carriedForward?.EL || 0) - (balance.consumed?.EL || 0),
            CO: (balance.entitlement?.CO || 0) - (balance.consumed?.CO || 0),
        };

        res.json({ success: true, data: { ...balance.toObject(), available } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** Helper: apply approved leave to attendance records + update balance */
async function applyLeaveToAttendance(application) {
    const leaveStatusMap = { CL: "L-CL", SL: "L-SL", EL: "L-EL", CO: "CO", LWP: "LWP", WFH: "WFH" };
    const statusCode = leaveStatusMap[application.leaveType] || "L-CL";

    // Update attendance records for each day in the leave range
    const numericId = engine.normalizeId(application.biometricId);
    const start = new Date(application.fromDate + "T00:00:00Z");
    const end = new Date(application.toDate + "T00:00:00Z");

    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const dateStr = d.toISOString().split("T")[0];
        await DailyAttendance.updateOne(
            { numericId, dateStr },
            {
                $set: {
                    isOnLeave: true,
                    leaveType: application.leaveType,
                    leaveApplicationId: application._id,
                    systemPrediction: statusCode,
                },
            }
        );
    }

    // Update leave balance
    if (application.leaveType !== "WFH") {
        const year = parseInt(application.fromDate.substring(0, 4), 10);
        const balance = await LeaveBalance.getOrCreate(
            application.employeeId, year, application.biometricId
        );
        const field = `consumed.${application.leaveType}`;
        await LeaveBalance.updateOne(
            { _id: balance._id },
            { $inc: { [field]: application.totalDays } }
        );
    }

    application.appliedToAttendance = true;
    application.appliedAt = new Date();
}


// ═══════════════════════════════════════════════════════════════════════════════
//  ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /analytics?year=YYYY&quarter=Q1&month=YYYY-MM&department=xxx */
router.get("/analytics", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { year, quarter, month, department } = req.query;
        let yearMonths = [];

        if (month) {
            yearMonths = [month];
        } else if (quarter && year) {
            const qMap = { Q1: ["01", "02", "03"], Q2: ["04", "05", "06"], Q3: ["07", "08", "09"], Q4: ["10", "11", "12"] };
            yearMonths = (qMap[quarter] || []).map(m => `${year}-${m}`);
        } else if (year) {
            yearMonths = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
        } else {
            const n = new Date();
            yearMonths = [`${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`];
        }

        const query = { yearMonth: { $in: yearMonths } };
        if (department && department !== "all") query.department = department;
        const records = await DailyAttendance.find(query).lean();

        const totals = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, WO: 0, PH: 0, MP: 0, totalOtMins: 0 };
        const byMonth = {}, byDept = {}, byEmployee = {};

        records.forEach(r => {
            const s = r.hrFinalStatus ?? r.systemPrediction ?? "AB";
            totals[s] = (totals[s] || 0) + 1;
            totals.totalOtMins += r.otMins || 0;

            // By month
            if (!byMonth[r.yearMonth]) byMonth[r.yearMonth] = { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0 };
            byMonth[r.yearMonth][s] = (byMonth[r.yearMonth][s] || 0) + 1;

            // By department
            const dept = r.department || "Unknown";
            if (!byDept[dept]) byDept[dept] = { present: 0, absent: 0, late: 0, ot: 0 };
            if (["P", "P*", "P~", "MP"].includes(s)) byDept[dept].present++;
            else if (s === "AB") byDept[dept].absent++;
            if (s === "P*") byDept[dept].late++;
            byDept[dept].ot += r.otMins || 0;

            // By employee
            if (!byEmployee[r.biometricId]) {
                byEmployee[r.biometricId] = {
                    name: r.employeeName, dept: r.department, identityId: r.identityId, employeeType: r.employeeType,
                    present: 0, absent: 0, late: 0, ot: 0, hd: 0, latePenalty: 0,
                };
            }
            const emp = byEmployee[r.biometricId];
            if (["P", "P*", "P~", "MP"].includes(s)) emp.present++;
            else if (s === "AB") emp.absent++;
            else if (s === "HD") emp.hd++;
            if (s === "P*") emp.late++;
            emp.ot += r.otMins || 0;
        });

        // Calculate late penalties per employee
        Object.values(byEmployee).forEach(emp => {
            emp.latePenalty = Math.floor(emp.late / 4);
            emp.otStr = engine.minsToHHMM(emp.ot);
        });

        // Top OT and top late employees
        const topOT = Object.entries(byEmployee)
            .filter(([, v]) => v.employeeType === "operator") // OT only for operators
            .sort((a, b) => b[1].ot - a[1].ot)
            .slice(0, 10)
            .map(([id, v]) => ({ biometricId: id, ...v }));

        const topLate = Object.entries(byEmployee)
            .sort((a, b) => b[1].late - a[1].late)
            .slice(0, 10)
            .map(([id, v]) => ({ biometricId: id, ...v }));

        res.json({ success: true, yearMonths, totals, byMonth, byDepartment: byDept, topOT, topLate });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  SETTINGS & SHIFTS & HOLIDAYS
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getSingleton();
        const shifts = await Shift.find().lean();
        res.json({ success: true, data: settings, shifts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/settings", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const allowed = [
            "shiftStart", "shiftEnd", "lateThresholdMinutes", "executiveLateThresholdMinutes",
            "halfDayThresholdMinutes", "earlyDepartureThresholdMinutes", "otGracePeriodMins",
            "workingDays", "lunchBreakMins", "teaBreakMins",
            "overtimeEnabled", "overtimeMinimumMinutes", "overtimeMaxPerDay", "overtimeRateMultiplier",
            "latePenalty", "biometricAutoSync", "biometricSyncIntervalMinutes",
        ];
        const updates = {};
        allowed.forEach(k => { if (req.body[k] !== undefined) updates[k] = req.body[k]; });
        if (req.user?.id) updates.updatedBy = req.user.id;

        const settings = await AttendanceSettings.findOneAndUpdate(
            {}, { $set: updates }, { new: true, upsert: true, runValidators: true }
        );
        res.json({ success: true, message: "Settings saved", data: settings });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Holidays ─────────────────────────────────────────────────────────────────

router.post("/holidays", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { name, date, type, description, isRecurring } = req.body;
        if (!name || !date) return res.status(400).json({ success: false, message: "name and date required" });

        const settings = await AttendanceSettings.getSingleton();
        settings.holidays.push({ name, date, type: type || "company", description, isRecurring: isRecurring || false });
        await settings.save();

        // Update existing attendance records for this date
        await DailyAttendance.updateMany(
            { dateStr: date, punchCount: 0 },
            { $set: { isHoliday: true, holidayName: name, holidayType: type || "company", systemPrediction: "PH" } }
        );

        res.json({ success: true, message: "Holiday added", data: settings.holidays });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/holidays/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getSingleton();
        const h = settings.holidays.id(req.params.id);
        if (!h) return res.status(404).json({ success: false, message: "Holiday not found" });

        const { name, date, type, description, isRecurring } = req.body;
        if (name) h.name = name;
        if (date) h.date = date;
        if (type) h.type = type;
        if (description !== undefined) h.description = description;
        if (isRecurring !== undefined) h.isRecurring = isRecurring;
        await settings.save();

        res.json({ success: true, data: settings.holidays });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete("/holidays/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const settings = await AttendanceSettings.getSingleton();
        const h = settings.holidays.id(req.params.id);
        if (!h) return res.status(404).json({ success: false, message: "Holiday not found" });
        const dateToRestore = h.date;
        h.deleteOne();
        await settings.save();

        await DailyAttendance.updateMany(
            { dateStr: dateToRestore, punchCount: 0, isOnLeave: false },
            { $set: { isHoliday: false, holidayName: null, holidayType: null, systemPrediction: "AB" } }
        );

        res.json({ success: true, message: "Holiday removed" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── Shifts ───────────────────────────────────────────────────────────────────

router.get("/shifts", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const shifts = await Shift.find().sort({ name: 1 }).lean();
        res.json({ success: true, data: shifts });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/shifts", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const shift = await Shift.create(req.body);
        res.json({ success: true, data: shift });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.put("/shifts/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const shift = await Shift.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
        if (!shift) return res.status(404).json({ success: false, message: "Shift not found" });
        res.json({ success: true, data: shift });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

router.delete("/shifts/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        await Shift.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Shift deleted" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  UTILITY ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/** GET /departments — from Employee records */
router.get("/departments", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const depts = await Employee.distinct("department");
        res.json({ success: true, data: depts.filter(Boolean).sort() });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/** GET /debug-api — Debug eTimeOffice API connection */
router.get("/debug-api", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { fromDate = new Date().toISOString().split("T")[0], toDate, empCode = "ALL" } = req.query;
        const f = toDate || fromDate;
        const base = (process.env.TEAMOFFICE_BASE_URL || "https://api.etimeoffice.com/api").replace(/\/+$/, "");

        res.json({
            env: {
                TEAMOFFICE_BASE_URL: process.env.TEAMOFFICE_BASE_URL || "(not set)",
                TEAMOFFICE_AUTH_TOKEN: process.env.TEAMOFFICE_AUTH_TOKEN
                    ? `SET (len ${process.env.TEAMOFFICE_AUTH_TOKEN.length})`
                    : "(not set)",
            },
            resolvedBase: base,
            syncStatus: syncService.getStatus(),
            testUrls: {
                inOut: `${base}/DownloadInOutPunchData?Empcode=${empCode}&FromDate=${fromDate}&ToDate=${f}`,
                punch: `${base}/DownloadPunchData?Empcode=${empCode}&FromDate=${fromDate}&ToDate=${f}`,
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

/**
 * POST /recompute — Recompute all records for a date range
 * Useful after changing settings (thresholds, etc.)
 */
router.post("/recompute", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { fromDate, toDate, department } = req.body;
        if (!fromDate || !toDate) {
            return res.status(400).json({ success: false, message: "fromDate and toDate required" });
        }

        const settings = await AttendanceSettings.getSingleton();
        const holidays = settings.holidays || [];

        const query = { dateStr: { $gte: fromDate, $lte: toDate }, punchCount: { $gt: 0 } };
        if (department && department !== "all") query.department = department;

        const records = await DailyAttendance.find(query);
        let updated = 0;

        for (const record of records) {
            const oldPrediction = record.systemPrediction;
            engine.computeDay(record, settings, record.employeeType, holidays);
            if (record.systemPrediction !== oldPrediction || record.isModified()) {
                await record.save();
                updated++;
            }
        }

        res.json({ success: true, message: `Recomputed ${updated} records`, updated });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


module.exports = router;