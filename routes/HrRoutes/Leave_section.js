"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Employee = require("../../models/Employee");
const { LeaveConfig, LeaveBalance, LeaveApplication, CompanyHoliday } = require("../../models/HR_Models/LeaveManagement");

// NEW: import helper that writes approved leaves into DailyAttendance
const Attendance_section = require("./Attendance_section");
const applyLeaveToAttendance = Attendance_section.applyLeaveToAttendance;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function parseLocalDate(str) {
    const [y, m, d] = str.split("-").map(Number);
    return new Date(y, m - 1, d);
}

function countCalendarDays(fromStr, toStr) {
    if (!fromStr || !toStr) return 0;
    const from = parseLocalDate(fromStr);
    const to = parseLocalDate(toStr);
    if (from > to) return 0;
    return Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
}

function workingDaysSince(joiningDate) {
    if (!joiningDate) return 0;
    const join = new Date(joiningDate);
    const today = new Date();
    let count = 0;
    const cur = new Date(join.getFullYear(), join.getMonth(), join.getDate());
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    while (cur <= end) {
        const dow = cur.getDay();
        if (dow !== 0) count++;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NAMED ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/config", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const config = await LeaveConfig.getConfig();
        res.json({ success: true, data: config });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.put("/config", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const allowed = ["initialWaitingDays", "clPerYear", "slPerYear", "plPerYear", "daysRequiredForPL", "slDocumentThreshold"];
        const updates = { updatedBy: req.user.id };
        for (const key of allowed) {
            if (req.body[key] != null) updates[key] = Number(req.body[key]);
        }
        const config = await LeaveConfig.findOneAndUpdate(
            { singleton: "global" }, { $set: updates }, { new: true, upsert: true }
        );
        res.json({ success: true, data: config, message: "Configuration updated" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/stats", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const y = Number(req.query.year) || new Date().getFullYear();
        const apps = await LeaveApplication.find({ fromDate: { $gte: `${y}-01-01` }, toDate: { $lte: `${y}-12-31` } }).lean();
        const stats = {
            total: apps.length,
            pending: apps.filter(a => a.status === "pending").length,
            manager_approved: apps.filter(a => a.status === "manager_approved").length,
            hr_approved: apps.filter(a => a.status === "hr_approved").length,
            hr_rejected: apps.filter(a => a.status === "hr_rejected" || a.status === "manager_rejected").length,
            byType: { CL: 0, SL: 0, PL: 0 },
            byMonth: Array(12).fill(0).map((_, i) => ({ month: i + 1, count: 0 })),
        };
        for (const a of apps) {
            if (stats.byType[a.leaveType] !== undefined) stats.byType[a.leaveType]++;
            const mo = parseLocalDate(a.fromDate).getMonth();
            stats.byMonth[mo].count++;
        }
        res.json({ success: true, data: stats });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/calendar", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { month, year, employeeId } = req.query;
        const y = Number(year) || new Date().getFullYear();
        const m = Number(month) || new Date().getMonth() + 1;
        const mStr = String(m).padStart(2, "0");
        const from = `${y}-${mStr}-01`;
        const to = `${y}-${mStr}-31`;

        const allHolidays = await CompanyHoliday.find({ date: { $gte: from, $lte: to } }).lean();
        const workingSundays = new Set(allHolidays.filter(h => h.type === "working_sunday").map(h => h.date));
        const holidays = allHolidays.filter(h => h.type !== "working_sunday");

        const daysInMonth = new Date(y, m, 0).getDate();
        const cal = {};
        for (let d = 1; d <= daysInMonth; d++) {
            const ds = `${y}-${mStr}-${String(d).padStart(2, "0")}`;
            const dow = new Date(y, m - 1, d).getDay();
            const isSunday = dow === 0;
            const hrHoliday = holidays.find(h => h.date === ds) || null;
            const isWorkingOverride = isSunday && workingSundays.has(ds);
            cal[ds] = {
                date: ds,
                weekend: false,
                isSunday,
                isWorkingOverride,
                holiday: isWorkingOverride ? null : isSunday
                    ? (hrHoliday || { date: ds, name: "Sunday", type: "company" })
                    : hrHoliday,
            };
        }
        res.json({ success: true, data: { calendar: Object.values(cal), holidays, workingSundays: [...workingSundays] } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/holidays", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { year } = req.query;
        const filter = year ? { date: { $gte: `${year}-01-01`, $lte: `${year}-12-31` } } : {};
        const holidays = await CompanyHoliday.find(filter).sort({ date: 1 }).lean();
        res.json({ success: true, data: holidays });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/holidays", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { date, name, description, type } = req.body;
        if (!date || !name) return res.status(400).json({ success: false, message: "date and name are required" });
        const h = await CompanyHoliday.findOneAndUpdate(
            { date },
            { date, name, description, type: type || "company", createdBy: req.user.id },
            { new: true, upsert: true }
        );
        res.status(201).json({ success: true, data: h, message: "Holiday added" });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ success: false, message: "Holiday already exists" });
        res.status(500).json({ success: false, message: err.message });
    }
});

router.patch("/holidays/sunday-override", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { date } = req.body;
        if (!date) return res.status(400).json({ success: false, message: "date required (YYYY-MM-DD)" });
        const [y, m, d] = date.split("-").map(Number);
        if (new Date(y, m - 1, d).getDay() !== 0)
            return res.status(400).json({ success: false, message: "Selected date is not a Sunday" });
        const existing = await CompanyHoliday.findOne({ date, type: "working_sunday" });
        if (existing) {
            await CompanyHoliday.deleteOne({ _id: existing._id });
            return res.json({ success: true, action: "restored", message: "Sunday restored as company holiday" });
        } else {
            await CompanyHoliday.create({ date, name: "Working Sunday", type: "working_sunday", createdBy: req.user?.id });
            return res.json({ success: true, action: "overridden", message: "Sunday marked as working day" });
        }
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.delete("/holidays/:id", EmployeeAuthMiddleware, async (req, res) => {
    try {
        await CompanyHoliday.findByIdAndDelete(req.params.id);
        res.json({ success: true, message: "Holiday removed" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.get("/balance/:employeeId", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const year = Number(req.query.year) || new Date().getFullYear();
        const bal = await LeaveBalance.findOne({ employeeId: req.params.employeeId, year }).lean();
        if (!bal) return res.json({ success: true, data: null });
        res.json({
            success: true,
            data: {
                ...bal,
                available: {
                    CL: Math.max(0, (bal.entitlement.CL || 0) - (bal.consumed.CL || 0)),
                    SL: Math.max(0, (bal.entitlement.SL || 0) - (bal.consumed.SL || 0)),
                    PL: Math.max(0, (bal.entitlement.PL || 0) - (bal.consumed.PL || 0)),
                },
            },
        });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/balance/init-year", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const year = Number(req.body.year) || new Date().getFullYear();
        const config = await LeaveConfig.getConfig();
        const emps = await Employee.find({ isActive: true }).select("_id biometricId").lean();
        let created = 0, updated = 0;
        for (const emp of emps) {
            const existing = await LeaveBalance.findOne({ employeeId: emp._id, year });
            if (!existing) {
                const prevBal = await LeaveBalance.findOne({ employeeId: emp._id, year: year - 1 });
                const plEligible = prevBal?.plEligible || false;
                await LeaveBalance.create({
                    employeeId: emp._id, biometricId: emp.biometricId, year,
                    entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: plEligible ? config.plPerYear : 0 },
                    plEligible,
                });
                created++;
            } else {
                existing.entitlement.CL = config.clPerYear;
                existing.entitlement.SL = config.slPerYear;
                if (existing.plEligible) existing.entitlement.PL = config.plPerYear;
                existing.consumed = { CL: 0, SL: 0, PL: 0 };
                await existing.save();
                updated++;
            }
        }
        res.json({ success: true, message: `Year ${year} initialized. Created: ${created}, Updated: ${updated}` });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

router.post("/balance/grant-pl", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { employeeId } = req.body;
        const config = await LeaveConfig.getConfig();
        const year = new Date().getFullYear();
        const emp = await Employee.findById(employeeId).select("dateOfJoining biometricId").lean();
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
        const workingDays = workingDaysSince(emp.dateOfJoining);
        if (workingDays < config.daysRequiredForPL)
            return res.status(400).json({ success: false, message: `Employee has ${workingDays}/${config.daysRequiredForPL} days` });
        const bal = await LeaveBalance.findOneAndUpdate(
            { employeeId, year },
            { $set: { plEligible: true, plGrantedDate: new Date(), "entitlement.PL": config.plPerYear } },
            { new: true, upsert: true }
        );
        res.json({ success: true, data: bal, message: "PL granted" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Bulk approve — NOW ALSO syncs to attendance ──────────────────────
router.patch("/bulk-approve", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids?.length) return res.status(400).json({ success: false, message: "No IDs provided" });

        const config = await LeaveConfig.getConfig();
        const apps = await LeaveApplication.find({ _id: { $in: ids }, status: { $in: ["pending", "manager_approved"] } });
        let attendanceAppliedCount = 0;

        for (const app of apps) {
            app.status = "hr_approved";
            app.hrApprovedBy = req.user.id;
            app.hrApprovedAt = new Date();
            await app.save();

            const year = parseLocalDate(app.fromDate).getFullYear();
            await LeaveBalance.findOneAndUpdate(
                { employeeId: app.employeeId, year },
                {
                    $setOnInsert: {
                        employeeId: app.employeeId,
                        biometricId: app.biometricId || "",
                        year,
                        entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
                    },
                    $inc: { [`consumed.${app.leaveType}`]: app.totalDays },
                },
                { upsert: true }
            );

            // NEW: Apply to DailyAttendance
            try {
                if (applyLeaveToAttendance) {
                    const result = await applyLeaveToAttendance(app);
                    if (result.applied > 0) attendanceAppliedCount++;
                }
            } catch (e) {
                console.warn(`[BULK-APPROVE] attendance sync failed for ${app._id}:`, e.message);
            }
        }
        res.json({ success: true, message: `${apps.length} leave(s) approved (${attendanceAppliedCount} synced to attendance)` });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// ── BACKFILL: retry attendance sync for already-approved leaves ────────
router.post("/backfill-attendance", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { employeeId, year } = req.body;
        const filter = { status: "hr_approved" };
        if (employeeId) filter.employeeId = employeeId;
        if (year) {
            filter.fromDate = { $gte: `${year}-01-01` };
            filter.toDate = { $lte: `${year}-12-31` };
        }
        const apps = await LeaveApplication.find(filter);

        const results = [];
        let totalApplied = 0, totalSkipped = 0;

        for (const app of apps) {
            try {
                const r = await applyLeaveToAttendance(app);
                totalApplied += r.applied;
                totalSkipped += r.skipped;
                results.push({
                    id: app._id,
                    employee: app.employeeName,
                    leaveType: app.leaveType,
                    range: `${app.fromDate} → ${app.toDate}`,
                    applied: r.applied,
                    skipped: r.skipped,
                });
            } catch (e) {
                results.push({ id: app._id, error: e.message });
            }
        }

        res.json({
            success: true,
            message: `Processed ${apps.length} approved leave(s). Applied to ${totalApplied} day(s), skipped ${totalSkipped}.`,
            totalLeaves: apps.length,
            totalApplied,
            totalSkipped,
            results,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ── DEBUG: trace why a specific leave isn't showing in attendance ─────
router.get("/debug-attendance/:id", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
        const app = await LeaveApplication.findById(req.params.id).lean();
        if (!app) return res.status(404).json({ success: false, message: "Not found" });

        const start = parseLocalDate(app.fromDate);
        const end = parseLocalDate(app.toDate);
        const trace = [];

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            const bid = String(app.biometricId || "").toUpperCase();

            const dayDoc = await DailyAttendance.findOne({ dateStr: ds }).lean();
            if (!dayDoc) {
                trace.push({ date: ds, status: "❌ Day not synced yet" });
                continue;
            }
            const entry = (dayDoc.employees || []).find(e => e.biometricId === bid);
            if (!entry) {
                trace.push({ date: ds, status: "⚠️ Employee not in day doc — would inject leave row" });
                continue;
            }
            trace.push({
                date: ds,
                systemPrediction: entry.systemPrediction,
                hrFinalStatus: entry.hrFinalStatus,
                wouldSkip: ["WO", "FH", "NH", "OH", "RH", "PH"].includes(entry.systemPrediction),
                status: entry.hrFinalStatus
                    ? `✓ Has hrFinalStatus = ${entry.hrFinalStatus}`
                    : ["WO", "FH", "NH", "OH", "RH", "PH"].includes(entry.systemPrediction)
                        ? `⚠️ Skipped (${entry.systemPrediction})`
                        : "Would set hrFinalStatus"
            });
        }

        res.json({
            success: true,
            leave: {
                id: app._id,
                employee: app.employeeName,
                biometricId: app.biometricId,
                leaveType: app.leaveType,
                fromDate: app.fromDate,
                toDate: app.toDate,
                status: app.status,
                appliedToAttendance: app.appliedToAttendance,
                appliedAt: app.appliedAt,
            },
            mappedTo: { CL: "L-CL", SL: "L-SL", PL: "L-EL" }[app.leaveType] || "UNKNOWN",
            trace,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
}); 

router.get("/", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { status, department, leaveType, month, year, search, page = 1, limit = 50 } = req.query;
        const filter = {};
        if (status && status !== "all") filter.status = status;
        if (department && department !== "all") filter.department = department;
        if (leaveType && leaveType !== "all") filter.leaveType = leaveType;
        if (month && year) {
            const mStr = month.padStart(2, "0");
            filter.fromDate = { $lte: `${year}-${mStr}-31` };
            filter.toDate = { $gte: `${year}-${mStr}-01` };
        }
        if (search) filter.$or = [{ employeeName: new RegExp(search, "i") }, { department: new RegExp(search, "i") }];

        const skip = (Number(page) - 1) * Number(limit);
        const total = await LeaveApplication.countDocuments(filter);
        const apps = await LeaveApplication.find(filter)
            .sort({ createdAt: -1 }).skip(skip).limit(Number(limit))
            .populate("employeeId", "firstName lastName biometricId profilePhoto").lean();

        const allApps = await LeaveApplication.find({}).lean();
        const stats = {
            total: allApps.length,
            pending: allApps.filter(a => a.status === "pending").length,
            manager_approved: allApps.filter(a => a.status === "manager_approved").length,
            hr_approved: allApps.filter(a => a.status === "hr_approved").length,
            hr_rejected: allApps.filter(a => a.status === "hr_rejected").length,
            manager_rejected: allApps.filter(a => a.status === "manager_rejected").length,
            cancelled: allApps.filter(a => a.status === "cancelled").length,
            byType: {
                CL: allApps.filter(a => a.leaveType === "CL").length,
                SL: allApps.filter(a => a.leaveType === "SL").length,
                PL: allApps.filter(a => a.leaveType === "PL").length,
            },
        };

        res.json({ success: true, data: { applications: apps, total, page: Number(page), pages: Math.ceil(total / Number(limit)), stats } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  WILDCARD ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

router.get("/:id", EmployeeAuthMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid application ID" });

        const app = await LeaveApplication.findById(req.params.id)
            .populate("employeeId", "firstName lastName biometricId designation department profilePhoto dateOfJoining primaryManager secondaryManager")
            .lean();
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });

        const year = new Date().getFullYear();
        const empId = app.employeeId?._id || app.employeeId;
        const rawBal = await LeaveBalance.findOne({ employeeId: empId, year }).lean();
        const employeeBalance = rawBal ? {
            entitlement: rawBal.entitlement,
            consumed: rawBal.consumed,
            available: {
                CL: Math.max(0, (rawBal.entitlement.CL || 0) - (rawBal.consumed.CL || 0)),
                SL: Math.max(0, (rawBal.entitlement.SL || 0) - (rawBal.consumed.SL || 0)),
                PL: Math.max(0, (rawBal.entitlement.PL || 0) - (rawBal.consumed.PL || 0)),
            },
        } : null;

        res.json({ success: true, data: { ...app, employeeBalance } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ── Approve — NOW ALSO syncs to attendance ────────────────────────────
router.patch("/:id/approve", EmployeeAuthMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid application ID" });

        const app = await LeaveApplication.findById(req.params.id);
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });
        if (app.status === "hr_approved")
            return res.status(400).json({ success: false, message: "Already approved" });

        app.status = "hr_approved";
        app.hrApprovedBy = req.user.id;
        app.hrApprovedAt = new Date();
        app.hrRemarks = (req.body && req.body.remarks) ? req.body.remarks : "";
        await app.save();

        const year = parseLocalDate(app.fromDate).getFullYear();
        const config = await LeaveConfig.getConfig();
        await LeaveBalance.findOneAndUpdate(
            { employeeId: app.employeeId, year },
            {
                $setOnInsert: {
                    employeeId: app.employeeId,
                    biometricId: app.biometricId || "",
                    year,
                    entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
                },
                $inc: { [`consumed.${app.leaveType}`]: app.totalDays },
            },
            { upsert: true, new: true }
        );

        // NEW: Sync to DailyAttendance
        let attendanceResult = { applied: 0, skipped: 0 };
        try {
            if (applyLeaveToAttendance) {
                attendanceResult = await applyLeaveToAttendance(app);
            }
        } catch (e) {
            console.warn("[APPROVE] attendance sync failed:", e.message);
        }

        res.json({
            success: true,
            data: app,
            message: `Leave approved. Attendance updated on ${attendanceResult.applied} day(s).`,
            attendanceSync: attendanceResult,
        });
    } catch (err) {
        console.error("Approve error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.patch("/:id/reject", EmployeeAuthMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid application ID" });

        const app = await LeaveApplication.findById(req.params.id);
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });

        app.status = "hr_rejected";
        app.rejectedBy = req.user.id;
        app.rejectedAt = new Date();
        app.rejectionReason = (req.body && req.body.rejectionReason) ? req.body.rejectionReason : "";
        await app.save();

        res.json({ success: true, data: app, message: "Leave rejected" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;