"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const Employee = require("../../models/Employee");
const { LeaveConfig, LeaveBalance, LeaveApplication, CompanyHoliday } = require("../../models/HR_Models/LeaveManagement");
const multer = require("multer");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");
const emailService = require("../../services/emailService");


// Import attendance sync helpers
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

// ─── Shared: apply leave + increment balance ──────────────────────────────────
async function finaliseApproval(app, approverId, remarks = "") {
    app.status = "hr_approved";
    app.hrApprovedBy = approverId;
    app.hrApprovedAt = new Date();
    app.hrRemarks = remarks;
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
                consumed: { CL: 0, SL: 0, PL: 0 },
            },
            $inc: { [`consumed.${app.leaveType}`]: app.totalDays },
        },
        { upsert: true, new: true }
    );

    // Sync to attendance
    let attendanceResult = { applied: 0, skipped: 0 };
    try {
        if (applyLeaveToAttendance) attendanceResult = await applyLeaveToAttendance(app);
    } catch (e) {
        console.warn("[APPROVE] attendance sync failed:", e.message);
    }
    return attendanceResult;
}


const hrUploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Only PDF, JPG, PNG or WEBP files are allowed."));
    },
}).single("document");


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

// ─── Stats — uses aggregation, NOT a full collection scan ─────────────────────
router.get("/stats", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const y = Number(req.query.year) || new Date().getFullYear();
        const fromStr = `${y}-01-01`;
        const toStr = `${y}-12-31`;

        const agg = await LeaveApplication.aggregate([
            { $match: { fromDate: { $gte: fromStr }, toDate: { $lte: toStr } } },
            {
                $group: {
                    _id: null,
                    total: { $sum: 1 },
                    pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                    manager_approved: { $sum: { $cond: [{ $eq: ["$status", "manager_approved"] }, 1, 0] } },
                    hr_approved: { $sum: { $cond: [{ $eq: ["$status", "hr_approved"] }, 1, 0] } },
                    hr_rejected: { $sum: { $cond: [{ $in: ["$status", ["hr_rejected", "manager_rejected"]] }, 1, 0] } },
                    CL: { $sum: { $cond: [{ $eq: ["$leaveType", "CL"] }, 1, 0] } },
                    SL: { $sum: { $cond: [{ $eq: ["$leaveType", "SL"] }, 1, 0] } },
                    PL: { $sum: { $cond: [{ $eq: ["$leaveType", "PL"] }, 1, 0] } },
                }
            },
        ]);

        const raw = agg[0] || { total: 0, pending: 0, manager_approved: 0, hr_approved: 0, hr_rejected: 0, CL: 0, SL: 0, PL: 0 };
        res.json({ success: true, data: { ...raw, byType: { CL: raw.CL, SL: raw.SL, PL: raw.PL } } });
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
                date: ds, weekend: false, isSunday, isWorkingOverride,
                holiday: isWorkingOverride ? null : isSunday
                    ? (hrHoliday || { date: ds, name: "Sunday", type: "company" })
                    : hrHoliday,
            };
        }
        res.json({ success: true, data: { calendar: Object.values(cal), holidays, workingSundays: [...workingSundays] } });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Holiday routes — canonical source of truth (attendance settings UI calls here too) ─
// Leave_section.js holidays are the ONLY ones that matter — Attendance_section.js
// holiday routes are deprecated stubs that just forward here.

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
        // Re-sync that day so holiday status is injected into DailyAttendance
        try { const { syncDayForce } = require("./Attendance_section"); await syncDayForce?.(date); }
        catch (e) { console.warn("[HOLIDAY] re-sync failed:", e.message); }
        res.status(201).json({ success: true, data: h, message: "Holiday added" });
    } catch (err) {
        if (err.code === 11000) return res.status(400).json({ success: false, message: "Holiday already exists on this date" });
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
        const h = await CompanyHoliday.findByIdAndDelete(req.params.id);
        if (h?.date) {
            try { const { syncDayForce } = require("./Attendance_section"); await syncDayForce?.(h.date); }
            catch (e) { console.warn("[HOLIDAY-DEL] re-sync failed:", e.message); }
        }
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

// ─── Bulk approve ─────────────────────────────────────────────────────────────
router.patch("/bulk-approve", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { ids } = req.body;
        if (!ids?.length) return res.status(400).json({ success: false, message: "No IDs provided" });

        // Only approve those that are pending OR manager_approved (ready for HR)
        const apps = await LeaveApplication.find({
            _id: { $in: ids },
            status: { $in: ["pending", "manager_approved"] },
        });
        let attendanceAppliedCount = 0;

        for (const app of apps) {
            const result = await finaliseApproval(app, req.user.id, "Bulk approved by HR");
            if (result.applied > 0) attendanceAppliedCount++;
        }
        res.json({ success: true, message: `${apps.length} leave(s) approved (${attendanceAppliedCount} synced to attendance)` });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Backfill attendance for already-approved leaves ─────────────────────────
router.post("/backfill-attendance", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { employeeId, year } = req.body;
        const filter = { status: "hr_approved" };
        if (employeeId) filter.employeeId = employeeId;
        if (year) { filter.fromDate = { $gte: `${year}-01-01` }; filter.toDate = { $lte: `${year}-12-31` }; }
        const apps = await LeaveApplication.find(filter);
        const results = [];
        let totalApplied = 0, totalSkipped = 0;
        for (const app of apps) {
            try {
                const r = await applyLeaveToAttendance(app);
                totalApplied += r.applied; totalSkipped += r.skipped;
                results.push({ id: app._id, employee: app.employeeName, leaveType: app.leaveType, range: `${app.fromDate} → ${app.toDate}`, applied: r.applied, skipped: r.skipped });
            } catch (e) { results.push({ id: app._id, error: e.message }); }
        }
        res.json({ success: true, message: `Processed ${apps.length} approved leave(s). Applied to ${totalApplied} day(s), skipped ${totalSkipped}.`, totalLeaves: apps.length, totalApplied, totalSkipped, results });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── Debug trace ──────────────────────────────────────────────────────────────
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
            if (!dayDoc) { trace.push({ date: ds, status: "❌ Day not synced yet" }); continue; }
            const entry = (dayDoc.employees || []).find(e => e.biometricId === bid);
            if (!entry) { trace.push({ date: ds, status: "⚠️ Employee not in day doc — would inject leave row" }); continue; }
            trace.push({
                date: ds, systemPrediction: entry.systemPrediction, hrFinalStatus: entry.hrFinalStatus,
                wouldSkip: ["WO", "FH", "NH", "OH", "RH", "PH"].includes(entry.systemPrediction),
                status: entry.hrFinalStatus ? `✓ Has hrFinalStatus = ${entry.hrFinalStatus}` : ["WO", "FH", "NH", "OH", "RH", "PH"].includes(entry.systemPrediction) ? `⚠️ Skipped (${entry.systemPrediction})` : "Would set hrFinalStatus"
            });
        }
        res.json({ success: true, leave: { id: app._id, employee: app.employeeName, biometricId: app.biometricId, leaveType: app.leaveType, fromDate: app.fromDate, toDate: app.toDate, status: app.status, appliedToAttendance: app.appliedToAttendance }, mappedTo: { CL: "L-CL", SL: "L-SL", PL: "L-EL" }[app.leaveType] || "UNKNOWN", trace });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// ─── GET / — applications list with efficient stats via aggregation ───────────
router.get("/", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { status, department, leaveType, month, year, search, page = 1, limit = 50 } = req.query;
        const filter = {};
        if (status && status !== "all") filter.status = status;
        if (department && department !== "all") filter.department = department;
        if (leaveType && leaveType !== "all") filter.leaveType = leaveType;
        if (month && year) {
            const mStr = String(month).padStart(2, "0");
            filter.fromDate = { $lte: `${year}-${mStr}-31` };
            filter.toDate = { $gte: `${year}-${mStr}-01` };
        } else if (year) {
            filter.fromDate = { $gte: `${year}-01-01` };
            filter.toDate = { $lte: `${year}-12-31` };
        }
        if (search) filter.$or = [{ employeeName: new RegExp(search, "i") }, { department: new RegExp(search, "i") }];

        const skip = (Number(page) - 1) * Number(limit);
        const [apps, total, statsAgg] = await Promise.all([
            LeaveApplication.find(filter)
                .sort({ createdAt: -1 }).skip(skip).limit(Number(limit))
                .populate("employeeId", "firstName lastName biometricId profilePhoto")
                .lean(),
            LeaveApplication.countDocuments(filter),
            // Aggregation over the SAME filter for stats — no full scan
            LeaveApplication.aggregate([
                { $match: filter },
                {
                    $group: {
                        _id: null,
                        total: { $sum: 1 },
                        pending: { $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] } },
                        manager_approved: { $sum: { $cond: [{ $eq: ["$status", "manager_approved"] }, 1, 0] } },
                        hr_approved: { $sum: { $cond: [{ $eq: ["$status", "hr_approved"] }, 1, 0] } },
                        hr_rejected: { $sum: { $cond: [{ $in: ["$status", ["hr_rejected", "manager_rejected"]] }, 1, 0] } },
                        cancelled: { $sum: { $cond: [{ $eq: ["$status", "cancelled"] }, 1, 0] } },
                        CL: { $sum: { $cond: [{ $eq: ["$leaveType", "CL"] }, 1, 0] } },
                        SL: { $sum: { $cond: [{ $eq: ["$leaveType", "SL"] }, 1, 0] } },
                        PL: { $sum: { $cond: [{ $eq: ["$leaveType", "PL"] }, 1, 0] } },
                    }
                },
            ]),
        ]);

        const s = statsAgg[0] || { total: 0, pending: 0, manager_approved: 0, hr_approved: 0, hr_rejected: 0, cancelled: 0, CL: 0, SL: 0, PL: 0 };
        const stats = { total: s.total, pending: s.pending, manager_approved: s.manager_approved, hr_approved: s.hr_approved, hr_rejected: s.hr_rejected, cancelled: s.cancelled, byType: { CL: s.CL, SL: s.SL, PL: s.PL } };

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

// ─── Approve — respects the primary→secondary manager flow ───────────────────
// HR can only finally approve once the primary manager has already approved
// (i.e. status = manager_approved) OR if the employee has no managers at all.
// If employee only has a primary manager (no secondary), primary approval = final.
router.patch("/:id/approve", EmployeeAuthMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid application ID" });

        const app = await LeaveApplication.findById(req.params.id);
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });
        if (app.status === "hr_approved")
            return res.status(400).json({ success: false, message: "Already approved" });

        const remarks = req.body?.remarks || "";

        // Validate workflow: if manager(s) exist and primary hasn't yet approved, block
        const hasPrimary = app.managersNotified.some(m => m.type === "primary");
        const hasSecondary = app.managersNotified.some(m => m.type === "secondary");
        const primaryApproved = app.managerDecisions.some(d => d.type === "primary" && d.decision === "approved");

        if (hasPrimary && !primaryApproved && app.status === "pending") {
            return res.status(400).json({
                success: false,
                message: "Primary manager approval is required before HR can approve this leave.",
            });
        }

        const attendanceResult = await finaliseApproval(app, req.user.id, remarks);

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
        if (["hr_approved", "hr_rejected"].includes(app.status))
            return res.status(400).json({ success: false, message: `Leave is already ${app.status}` });

        app.status = "hr_rejected";
        app.rejectedBy = req.user.id;
        app.rejectedAt = new Date();
        app.rejectionReason = req.body?.rejectionReason || "";
        await app.save();

        // Notify employee via email (non-fatal)
        try {
            if (emailService.sendLeaveRejectedToEmployee) {
                const emp = await Employee.findById(app.employeeId).select("email firstName lastName").lean();
                if (emp?.email) {
                    emailService.sendLeaveRejectedToEmployee({
                        employeeEmail: emp.email,
                        employeeName: app.employeeName,
                        leaveType: app.leaveType,
                        fromDate: app.fromDate,
                        toDate: app.toDate,
                        totalDays: app.totalDays,
                        reason: app.rejectionReason,
                    }).catch(e => console.warn("[REJECT-EMAIL]", e.message));
                }
            }
        } catch (_) { }

        res.json({ success: true, data: app, message: "Leave rejected" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

module.exports = router;


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

router.get("/employee-balance/:employeeId", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const year = new Date().getFullYear();
        const bal = await LeaveBalance.findOne({ employeeId: req.params.employeeId, year }).lean();
        if (!bal) return res.json({ success: true, data: null });
        const available = {
            CL: Math.max(0, (bal.entitlement?.CL || 0) - (bal.consumed?.CL || 0)),
            SL: Math.max(0, (bal.entitlement?.SL || 0) - (bal.consumed?.SL || 0)),
            PL: Math.max(0, (bal.entitlement?.PL || 0) - (bal.consumed?.PL || 0)),
            LWP: 999, CO: 999, WFH: 999,
        };
        res.json({ success: true, data: { ...bal, available } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// POST /api/hr/leaves/add-on-behalf
// HR adds leave for an employee — auto-approved, no HOD/manager flow
router.post("/add-on-behalf", EmployeeAuthMiddleware, async (req, res) => {
    try {
        const { employeeId, leaveType, startDate, endDate, isHalfDay, reason, hrRemarks } = req.body;

        if (!employeeId || !leaveType || !startDate || !endDate || !reason)
            return res.status(400).json({ success: false, message: "employeeId, leaveType, startDate, endDate, reason are required" });

        const emp = await Employee.findById(employeeId);
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

        const days = isHalfDay ? 0.5 : Math.max(1,
            Math.round((new Date(endDate) - new Date(startDate)) / 86400000) + 1
        );

        const app = await LeaveApplication.create({
            employeeId: emp._id,
            biometricId: emp.biometricId,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            department: emp.department,
            designation: emp.designation,
            leaveType,
            // Support both field name conventions used across your codebase
            startDate: new Date(startDate),
            endDate: new Date(endDate),
            fromDate: startDate,   // some helpers use fromDate/toDate
            toDate: endDate,
            isHalfDay: isHalfDay || false,
            numberOfDays: days,
            totalDays: days,
            reason,
            hrRemarks: hrRemarks || "",
            status: "hr_approved",   // auto-approved — no HOD needed
            addedByHR: true,
            addedByHRId: req.user.id,
            hrApprovedAt: new Date(),
            hrApprovedBy: req.user.id,
            managersNotified: [],
            applicationDate: new Date(),
        });

        // Deduct from balance for CL / SL / PL
        if (["CL", "SL", "PL"].includes(leaveType)) {
            const year = new Date(startDate).getFullYear();
            await LeaveBalance.findOneAndUpdate(
                { employeeId: emp._id, year },
                { $inc: { [`consumed.${leaveType}`]: days } },
                { upsert: false }
            );
        }

        // Reflect on attendance for any days that are today or already past
        try {
            const todayStr = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const startStr = new Date(startDate).toISOString().slice(0, 10);
            const endStr = new Date(endDate).toISOString().slice(0, 10);
            if (startStr <= todayStr) {
                const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
                const statusCode = { CL: "L-CL", SL: "L-SL", PL: "L-EL" }[leaveType] || `L-${leaveType}`;
                let cur = new Date(startStr + "T00:00:00Z");
                const todayDate = new Date(todayStr + "T00:00:00Z");
                while (cur <= todayDate && cur.toISOString().slice(0, 10) <= endStr) {
                    const ds = cur.toISOString().slice(0, 10);
                    await DailyAttendance.findOneAndUpdate(
                        { dateStr: ds, "employees.biometricId": emp.biometricId },
                        { $set: { "employees.$.hrFinalStatus": statusCode, "employees.$.hrRemarks": `Leave added by HR (${leaveType})`, "employees.$.hrReviewedAt": new Date() } }
                    ).catch(() => { });
                    cur.setUTCDate(cur.getUTCDate() + 1);
                }
            }
        } catch (syncErr) {
            console.warn("[HR-ADD-LEAVE] attendance sync failed:", syncErr.message);
        }

        res.json({ success: true, data: app, message: `Leave added and approved for ${emp.firstName}` });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});


router.post("/:id/upload-document", EmployeeAuthMiddleware, (req, res, next) => {
    hrUploadMiddleware(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        next();
    });
}, async (req, res) => {
    try {
        if (!req.file)
            return res.status(400).json({ success: false, message: "No file uploaded." });

        const app = await LeaveApplication.findById(req.params.id);
        if (!app)
            return res.status(404).json({ success: false, message: "Leave application not found." });

        const ext = req.file.originalname.includes(".")
            ? req.file.originalname.slice(req.file.originalname.lastIndexOf("."))
            : ".pdf";
        const safeName = (app.employeeName || "employee").replace(/[^a-zA-Z0-9]/g, "_");
        const fileName = `SL_${safeName}_${app.fromDate}_${Date.now()}${ext}`;

        const driveResult = await uploadToGoogleDrive(req.file.buffer, {
            fileName,
            mimeType: req.file.mimetype,
        });

        await LeaveApplication.updateOne(
            { _id: req.params.id },
            {
                $set: {
                    documentSubmitted: true,
                    documentUrl: driveResult.viewUrl || driveResult.url,
                    documentFileId: driveResult.fileId,
                    documentFileName: fileName,
                    documentUploadedAt: new Date(),
                },
            }
        );

        return res.json({
            success: true,
            message: "Document uploaded to Google Drive.",
            data: {
                documentUrl: driveResult.viewUrl || driveResult.url,
                documentFileName: fileName,
            },
        });
    } catch (err) {
        console.error("[HR-DOC-UPLOAD]", err.message);
        return res.status(500).json({ success: false, message: err.message || "Upload failed." });
    }
});


async function _notifyEmployeeApproved(app) {
    try {
        const emp = await Employee.findById(app.employeeId).select("email").lean();
        if (emp?.email) {
            emailService.sendLeaveApprovedToEmployee({
                employeeEmail: emp.email,
                employeeName: app.employeeName,
                leaveType: app.leaveType,
                fromDate: app.fromDate,
                toDate: app.toDate,
                totalDays: app.totalDays,
                isHalfDay: app.isHalfDay,
                approvedBy: "HR",
            }).catch(e => console.warn("[HR-APPROVE-EMAIL]", e.message));
        }
    } catch (e) { console.warn("[HR-APPROVE-EMAIL]", e.message); }
}

// Helper — fires-and-forgets email to employee on HR rejection
async function _notifyEmployeeRejected(app, rejectionReason) {
    try {
        const emp = await Employee.findById(app.employeeId).select("email").lean();
        if (emp?.email) {
            emailService.sendLeaveRejectedToEmployee({
                employeeEmail: emp.email,
                employeeName: app.employeeName,
                leaveType: app.leaveType,
                fromDate: app.fromDate,
                toDate: app.toDate,
                totalDays: app.totalDays,
                reason: rejectionReason || app.rejectionReason || "Not approved",
            }).catch(e => console.warn("[HR-REJECT-EMAIL]", e.message));
        }
    } catch (e) { console.warn("[HR-REJECT-EMAIL]", e.message); }
}

module.exports = router;