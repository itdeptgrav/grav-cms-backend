"use strict";
/**
 * routes/Employee_Routes/leaveRoutes.js
 * Mounted at: /api/employee/leave-applications
 * Auth: AllEmployeeAppMiddleware (cookie: employee_token)
 *
 * Endpoints:
 *  GET  /                     — my leave applications
 *  POST /                     — apply for leave (validates all rules)
 *  GET  /balance              — my leave balance + eligibility
 *  GET  /config               — get leave config (so frontend shows correct limits)
 *  GET  /holidays             — company holidays (public to employees)
 *  GET  /calendar             — my calendar (own leaves + holidays)
 *  GET  /:id                  — single application detail
 *  PATCH/:id/cancel           — cancel a pending application
 *
 *  — Manager endpoints (employee who IS a manager) —
 *  GET  /manager/pending      — applications assigned to me as manager
 *  PATCH/manager/:id/approve  — manager approve
 *  PATCH/manager/:id/reject   — manager reject
 */

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const multer = require("multer");
const { notifyManagerOnLeaveApply, notifySecondaryOnPrimaryApproval, notifyEmployeeOnLeaveAction } = require("../../services/leaveNotification.service");
const { uploadToGoogleDrive } = require("../../services/mediaUpload.service");

// multer — memory storage, max 10 MB, PDF + images only
const uploadMiddleware = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = ["application/pdf", "image/jpeg", "image/jpg", "image/png", "image/webp"];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error("Only PDF, JPG, PNG or WEBP files are allowed."));
    },
}).single("document");

const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const Employee = require("../../models/Employee");
const { LeaveConfig, LeaveBalance, LeaveApplication, CompanyHoliday } = require("../../models/HR_Models/LeaveManagement");

// ─── Helper: count CALENDAR days inclusive (from=9 to=12 = 4 days) ───────────
// Both start and end dates count. No weekend skipping.
// User picks "from Jan 9 to Jan 12" → should be 4 days of leave, not 2.
// Count leave days — rules:
//  1. All calendar days counted (Mon-Sun inclusive).
//  2. Single Saturday only = 0 days (not a valid leave day by itself).
//  3. Saturday inside a multi-day range = counted (sandwiched).
//  4. Sunday always counts (sandwich rule).
function countLeaveDays(startStr, endStr) {
    if (!startStr || !endStr) return 0;
    const [sy, sm, sd] = startStr.split("-").map(Number);
    const [ey, em, ed] = endStr.split("-").map(Number);
    const from = new Date(sy, sm - 1, sd); // local constructor, no UTC shift
    const to = new Date(ey, em - 1, ed);
    if (from > to) return 0;
    // Single Saturday = 0 (not a valid standalone leave day)
    if (from.getTime() === to.getTime() && from.getDay() === 6) return 0;
    // All other ranges: count every calendar day inclusive
    return Math.round((to - from) / (24 * 60 * 60 * 1000)) + 1;
}

// ─── Helper: working days since joining (used ONLY for eligibility checks) ────
function workingDaysSinceJoining(joiningDate) {
    if (!joiningDate) return 0;
    const join = new Date(joiningDate);
    const today = new Date();
    let count = 0;
    const cur = new Date(join.getFullYear(), join.getMonth(), join.getDate());
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    while (cur <= end) {
        const dow = cur.getDay();
        // Only Sunday (0) is a non-working day. Saturday (6) IS a working day.
        if (dow !== 0) count++;
        cur.setDate(cur.getDate() + 1);
    }
    return count;
}

// ─── Helper: ensure balance record exists AND always reflects latest config ────
// FIX: HR can change CL/SL/PL entitlement at any time.
// We always sync entitlement.CL and entitlement.SL from the live config.
// PL is only synced if the employee is already eligible.
// This means: if HR changes CL from 5→10, the employee immediately sees 10.
async function ensureBalance(employeeId, year, biometricId, config) {
    let bal = await LeaveBalance.findOne({ employeeId, year });
    if (!bal) {
        // First time — create with current config values
        bal = await LeaveBalance.create({
            employeeId,
            biometricId: biometricId || "",
            year,
            entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
            consumed: { CL: 0, SL: 0, PL: 0 },
            plEligible: false,
        });
    } else {
        // Always sync CL and SL entitlement from live config
        // so HR config changes are reflected immediately
        let dirty = false;
        if (bal.entitlement.CL !== config.clPerYear) { bal.entitlement.CL = config.clPerYear; dirty = true; }
        if (bal.entitlement.SL !== config.slPerYear) { bal.entitlement.SL = config.slPerYear; dirty = true; }
        // PL: only sync if already eligible
        if (bal.plEligible && bal.entitlement.PL !== config.plPerYear) { bal.entitlement.PL = config.plPerYear; dirty = true; }
        if (dirty) await bal.save();
    }
    return bal;
}


// ═══════════════════════════════════════════════════════════════════════════════
//  PUBLIC TO EMPLOYEES
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/employee/leave-applications/config
router.get("/config", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const config = await LeaveConfig.getConfig();
        res.json({ success: true, data: config });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/employee/leave-applications/holidays
router.get("/holidays", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { year } = req.query;
        const y = year || new Date().getFullYear();
        const holidays = await CompanyHoliday.find({
            date: { $gte: `${y}-01-01`, $lte: `${y}-12-31` },
        }).sort({ date: 1 }).lean();
        res.json({ success: true, data: holidays });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/employee/leave-applications/balance
router.get("/balance", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const employeeId = req.user.id;
        const year = Number(req.query.year) || new Date().getFullYear();
        const config = await LeaveConfig.getConfig();
        const emp = await Employee.findById(employeeId).select("biometricId dateOfJoining").lean();

        const bal = await ensureBalance(employeeId, year, emp?.biometricId, config);

        // Check if employee has completed waiting period
        const workingDays = workingDaysSinceJoining(emp?.dateOfJoining);
        const waitingComplete = workingDays >= config.initialWaitingDays;
        const plComplete = workingDays >= config.daysRequiredForPL;

        // Auto-grant PL if eligible and not yet marked
        if (plComplete && !bal.plEligible) {
            bal.plEligible = true;
            bal.plGrantedDate = new Date();
            bal.entitlement.PL = config.plPerYear;
            await bal.save();
        }

        // Always compute available using LIVE config entitlement — never stale DB values.
        // If HR changed CL from 5→10, employee sees 10 immediately.
        const liveEntitlement = {
            CL: config.clPerYear,
            SL: config.slPerYear,
            PL: bal.plEligible ? config.plPerYear : 0,
        };
        const available = {
            CL: Math.max(0, liveEntitlement.CL - bal.consumed.CL),
            SL: Math.max(0, liveEntitlement.SL - bal.consumed.SL),
            PL: Math.max(0, liveEntitlement.PL - bal.consumed.PL),
        };

        res.json({
            success: true,
            data: {
                balance: bal,
                available,
                entitlement: bal.entitlement,
                consumed: bal.consumed,
                config: {
                    initialWaitingDays: config.initialWaitingDays,
                    clPerYear: config.clPerYear,
                    slPerYear: config.slPerYear,
                    plPerYear: config.plPerYear,
                    daysRequiredForPL: config.daysRequiredForPL,
                    slDocumentThreshold: config.slDocumentThreshold,
                },
                eligibility: {
                    waitingComplete,
                    plComplete,
                    workingDays,
                    canApplyCL: waitingComplete,
                    canApplySL: waitingComplete,
                    canApplyPL: plComplete,
                },
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/employee/leave-applications
router.get("/", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { status, leaveType, year } = req.query;
        const filter = { employeeId: req.user.id };
        if (status && status !== "all") filter.status = status;
        if (leaveType && leaveType !== "all") filter.leaveType = leaveType;
        if (year) {
            filter.fromDate = { $gte: `${year}-01-01` };
            filter.toDate = { $lte: `${year}-12-31` };
        }

        const apps = await LeaveApplication.find(filter).sort({ createdAt: -1 }).lean();
        res.json({ success: true, data: apps });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/employee/leave-applications/calendar
router.get("/calendar", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { month, year } = req.query;
        const y = Number(year) || new Date().getFullYear();
        const m = Number(month) || new Date().getMonth() + 1;
        const mStr = String(m).padStart(2, "0");
        const from = `${y}-${mStr}-01`;
        const to = `${y}-${mStr}-31`;

        const [myLeaves, holidays] = await Promise.all([
            LeaveApplication.find({
                employeeId: req.user.id,
                fromDate: { $lte: to },
                toDate: { $gte: from },
            }).lean(),
            CompanyHoliday.find({ date: { $gte: from, $lte: to } }).lean(),
        ]);

        const daysInMonth = new Date(y, m, 0).getDate();
        const calendar = [];

        for (let d = 1; d <= daysInMonth; d++) {
            const ds = `${y}-${mStr}-${String(d).padStart(2, "0")}`;
            // Parse as local date to avoid UTC shift
            const [py, pm, pd] = ds.split("-").map(Number);
            const dow = new Date(py, pm - 1, pd).getDay();
            const isSunday = dow === 0;
            const hrHoliday = holidays.find(h => h.date === ds) || null;

            // Sunday = company holiday (pink). Saturday = normal working day (no grey).
            // HR-defined holidays show on any day.
            const holidayObj = isSunday
                ? (hrHoliday || { date: ds, name: "Sunday", type: "company" })
                : hrHoliday;

            const leave = myLeaves.find(a => a.fromDate <= ds && a.toDate >= ds && a.status === "hr_approved");

            const status = holidayObj
                ? "holiday"
                : leave
                    ? leave.leaveType
                    : "workday";

            calendar.push({
                date: ds,
                dayOfWeek: dow,
                weekend: false,      // Saturday is a normal working day — NOT grey
                holiday: holidayObj, // Sunday + HR holidays shown as pink
                leave: leave ? { leaveType: leave.leaveType, status: leave.status } : null,
                status,
            });
        }

        res.json({ success: true, data: { calendar, holidays, leaves: myLeaves } });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER ENDPOINTS  ←  ALL here BEFORE /:id (prevents /:id swallowing them)
// ═══════════════════════════════════════════════════════════════════════════════

// GET /api/employee/leave-applications/manager/my-team
// Returns employees where the logged-in user is their primary OR secondary manager.
// Empty result means this person is not a manager → hide Team Leave tab in the app.
router.get("/manager/my-team", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const myId = req.user.id;
        const team = await Employee.find({
            isActive: true,
            $or: [
                { "primaryManager.managerId": myId },
                { "secondaryManager.managerId": myId },
            ],
        })
            .select("firstName lastName biometricId department designation primaryManager secondaryManager")
            .lean();
        res.json({ success: true, data: team });
    } catch (err) {
        console.error("[my-team]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/employee/leave-applications/manager/pending
// Shows apps where I am primary/secondary manager and need to act.
router.get("/manager/pending", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const myId = req.user.id;
        const apps = await LeaveApplication.find({
            $or: [
                // Primary: I need to act first
                { "managersNotified": { $elemMatch: { managerId: myId, type: "primary" } }, status: "pending" },
                // Secondary / HR: primary already approved, waiting for me
                { "managersNotified": { $elemMatch: { managerId: myId, type: "secondary" } }, status: "manager_approved" },
            ],
        }).sort({ createdAt: -1 }).lean();

        res.json({ success: true, data: apps });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// POST /api/employee/leave-applications/manager/add-on-behalf
// Manager submits leave for an offline team member.
// Backend validates the target employee is actually under this manager.
router.post("/manager/add-on-behalf", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { employeeId, leaveType, fromDate, toDate, reason, isHalfDay, halfDaySlot, managerRemarks } = req.body;
        if (!employeeId || !leaveType || !fromDate || !toDate || !reason)
            return res.status(400).json({ success: false, message: "employeeId, leaveType, fromDate, toDate, reason are required" });
        if (!["CL", "SL", "PL"].includes(leaveType))
            return res.status(400).json({ success: false, message: "Invalid leave type" });

        const myId = req.user.id;
        const targetEmp = await Employee.findById(employeeId)
            .select("firstName lastName biometricId designation department dateOfJoining primaryManager secondaryManager email")
            .lean();
        if (!targetEmp) return res.status(404).json({ success: false, message: "Employee not found" });

        // Strict manager check — must be primary OR secondary manager
        const isPrimary = String(targetEmp.primaryManager?.managerId) === String(myId);
        const isSecondary = String(targetEmp.secondaryManager?.managerId) === String(myId);
        if (!isPrimary && !isSecondary)
            return res.status(403).json({ success: false, message: "You are not a manager of this employee." });

        const config = await LeaveConfig.getConfig();
        const year = new Date(fromDate).getFullYear();
        const workingDays = workingDaysSinceJoining(targetEmp.dateOfJoining);

        if (workingDays < config.initialWaitingDays)
            return res.status(400).json({ success: false, message: `Employee hasn't completed waiting period (${workingDays}/${config.initialWaitingDays} days).`, code: "WAITING_PERIOD" });
        if (leaveType === "PL" && workingDays < config.daysRequiredForPL)
            return res.status(400).json({ success: false, message: `Employee not eligible for PL (${workingDays}/${config.daysRequiredForPL} days).`, code: "PL_NOT_ELIGIBLE" });

        const totalDays = isHalfDay ? 0.5 : countLeaveDays(fromDate, toDate);
        if (totalDays <= 0) return res.status(400).json({ success: false, message: "No valid leave days in selected range" });

        const activeConflict = await LeaveApplication.findOne({
            employeeId, status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
            fromDate: { $lte: toDate }, toDate: { $gte: fromDate },
        });
        if (activeConflict)
            return res.status(400).json({ success: false, message: `Employee already has a leave from ${activeConflict.fromDate} to ${activeConflict.toDate}.`, code: "OVERLAP" });

        const bal = await ensureBalance(employeeId, year, targetEmp.biometricId, config);
        if (leaveType === "PL" && !bal.plEligible) { bal.plEligible = true; bal.plGrantedDate = new Date(); bal.entitlement.PL = config.plPerYear; await bal.save(); }
        const liveEnt = { CL: config.clPerYear, SL: config.slPerYear, PL: bal.plEligible ? config.plPerYear : 0 };
        const available = Math.max(0, liveEnt[leaveType] - bal.consumed[leaveType]);
        if (totalDays > available)
            return res.status(400).json({ success: false, message: `Insufficient ${leaveType} balance. Available: ${available}, Requested: ${totalDays}.`, code: "INSUFFICIENT_BALANCE" });

        const requiresDocument = leaveType === "SL" && totalDays > config.slDocumentThreshold;
        const managersNotified = [];
        if (targetEmp.primaryManager?.managerId)
            managersNotified.push({ managerId: targetEmp.primaryManager.managerId, managerName: targetEmp.primaryManager.managerName || "", type: "primary" });
        if (targetEmp.secondaryManager?.managerId)
            managersNotified.push({ managerId: targetEmp.secondaryManager.managerId, managerName: targetEmp.secondaryManager.managerName || "", type: "secondary" });

        const myEmp = await Employee.findById(myId).select("firstName lastName").lean();
        const myName = myEmp ? `${myEmp.firstName || ""} ${myEmp.lastName || ""}`.trim() : "Manager";

        const managerDecisions = [{
            managerId: myId, managerName: myName,
            type: isPrimary ? "primary" : "secondary",
            decision: "approved", remarks: managerRemarks || "Added on behalf by manager", decidedAt: new Date(),
        }];
        const hasSecondaryManager = !!targetEmp.secondaryManager?.managerId;
        const status = (isPrimary && hasSecondaryManager) ? "manager_approved" : "hr_approved";

        const app = await LeaveApplication.create({
            employeeId, biometricId: targetEmp.biometricId,
            employeeName: `${targetEmp.firstName} ${targetEmp.lastName}`.trim(),
            designation: targetEmp.designation, department: targetEmp.department,
            leaveType, applicationDate: new Date().toISOString().split("T")[0],
            fromDate, toDate, totalDays, reason,
            isHalfDay: isHalfDay ? true : false,
            halfDaySlot: isHalfDay ? (halfDaySlot || "first_half") : null,
            requiresDocument, managersNotified, managerDecisions, status,
            hrRemarks: status === "hr_approved" ? `Approved on behalf by manager: ${myName}` : undefined,
            hrApprovedAt: status === "hr_approved" ? new Date() : undefined,
        });

        if (status === "hr_approved") {
            try {
                const existBal = await LeaveBalance.findOne({ employeeId, year });
                if (existBal) {
                    existBal.consumed[leaveType] = (existBal.consumed[leaveType] || 0) + totalDays;
                    await existBal.save();
                } else {
                    const initConsumed = { CL: 0, SL: 0, PL: 0 };
                    initConsumed[leaveType] = totalDays;
                    await LeaveBalance.create({
                        employeeId, biometricId: targetEmp.biometricId || "", year,
                        entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
                        consumed: initConsumed,
                    });
                }
            } catch (e) { console.warn("[MGR-ONBEHALF] balance:", e.message); }
            try {
                const { applyLeaveToAttendance } = require("../HrRoutes/Attendance_section");
                if (applyLeaveToAttendance) await applyLeaveToAttendance(app);
            } catch (e) { console.warn("[MGR-ONBEHALF] attendance:", e.message); }
            if (targetEmp.email) {
                try {
                    const emailService = require("../../services/emailService");
                    if (emailService.sendLeaveApprovedToEmployee) emailService.sendLeaveApprovedToEmployee({ employeeEmail: targetEmp.email, employeeName: app.employeeName, leaveType, fromDate, toDate, totalDays, isHalfDay: app.isHalfDay, approvedBy: myName }).catch(() => { });
                } catch (_) { }
            }
        }

        res.status(201).json({
            success: true, data: app,
            message: status === "hr_approved"
                ? `Leave added and approved for ${targetEmp.firstName}.`
                : "Leave added and routed to secondary manager.",
        });
    } catch (err) {
        console.error("[MGR-ONBEHALF]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// GET /api/employee/leave-applications/:id
router.get("/:id", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid ID" });

        const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user.id }).lean();
        if (!app) return res.status(404).json({ success: false, message: "Not found" });
        res.json({ success: true, data: app });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════════
//  APPLY FOR LEAVE
// ═══════════════════════════════════════════════════════════════════════════════

// POST /api/employee/leave-applications
router.post("/", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { leaveType, applicationDate, fromDate, toDate, reason, isHalfDay, halfDaySlot } = req.body;

        if (!leaveType || !applicationDate || !fromDate || !toDate || !reason) {
            return res.status(400).json({ success: false, message: "All fields are required" });
        }
        if (!["CL", "SL", "PL"].includes(leaveType)) {
            return res.status(400).json({ success: false, message: "Invalid leave type. Must be CL, SL, or PL" });
        }
        if (new Date(toDate) < new Date(fromDate)) {
            return res.status(400).json({ success: false, message: "To date cannot be before from date" });
        }

        // ── Load employee ──
        const emp = await Employee.findById(req.user.id)
            .select("firstName lastName biometricId designation department dateOfJoining primaryManager secondaryManager")
            .lean();
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

        // ── Load config ──
        const config = await LeaveConfig.getConfig();
        const year = new Date(fromDate).getFullYear();

        // ── Rule 1: Waiting period ──
        const workingDays = workingDaysSinceJoining(emp.dateOfJoining);
        if (workingDays < config.initialWaitingDays) {
            return res.status(400).json({
                success: false,
                message: `You need to complete ${config.initialWaitingDays} working days before applying for leave. You have ${workingDays} working days so far.`,
                code: "WAITING_PERIOD",
            });
        }

        // ── Rule 2: PL eligibility ──
        if (leaveType === "PL" && workingDays < config.daysRequiredForPL) {
            return res.status(400).json({
                success: false,
                message: `Privilege Leave is available only after ${config.daysRequiredForPL} working days. You have ${workingDays} working days.`,
                code: "PL_NOT_ELIGIBLE",
            });
        }

        // ── Calculate days ──
        // Rule 1+2: Saturday-only = 0 days (blocked)
        const [fsy, fsm, fsd] = fromDate.split("-").map(Number);
        const fromDateObj = new Date(fsy, fsm - 1, fsd);
        const [tsy, tsm, tsd] = toDate.split("-").map(Number);
        const toDateObj = new Date(tsy, tsm - 1, tsd);
        if (fromDateObj.getTime() === toDateObj.getTime() && fromDateObj.getDay() === 6) {
            return res.status(400).json({
                success: false,
                message: "Saturday is not a valid leave day. You cannot apply leave for Saturday alone.",
                code: "SATURDAY_BLOCKED",
            });
        }

        // Half-day = always 0.5 regardless of date range
        // Full day = count calendar days from fromDate to toDate
        const totalDays = isHalfDay ? 0.5 : countLeaveDays(fromDate, toDate);
        if (totalDays <= 0) {
            return res.status(400).json({ success: false, message: "No valid leave days in selected range" });
        }

        // Rule 3: consecutive leave — no overlapping or same-end-date leaves allowed
        // Next leave must start STRICTLY AFTER the end date of any active leave
        const activeConflict = await LeaveApplication.findOne({
            employeeId: req.user.id,
            status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
            fromDate: { $lte: toDate },   // existing starts before or on our end
            toDate: { $gte: fromDate }, // existing ends on or after our start
        });
        if (activeConflict) {
            return res.status(400).json({
                success: false,
                message: `You already have a leave from ${activeConflict.fromDate} to ${activeConflict.toDate}. Your next leave can only start from ${(() => { const [cy, cm, cd] = activeConflict.toDate.split("-").map(Number); const next = new Date(cy, cm - 1, cd); next.setDate(next.getDate() + 1); return next.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" }); })()} onwards.`,
                code: "OVERLAP",
            });
        }

        // ── Rule 3: Check balance using LIVE config entitlement ──
        const bal = await ensureBalance(req.user.id, year, emp.biometricId, config);

        // Auto-grant PL if eligible
        if (leaveType === "PL" && !bal.plEligible) {
            bal.plEligible = true;
            bal.plGrantedDate = new Date();
            bal.entitlement.PL = config.plPerYear;
            await bal.save();
        }

        // Always use live config for entitlement so HR changes reflect immediately
        const liveEnt = {
            CL: config.clPerYear,
            SL: config.slPerYear,
            PL: bal.plEligible ? config.plPerYear : 0,
        };
        const available = Math.max(0, liveEnt[leaveType] - bal.consumed[leaveType]);
        if (totalDays > available) {
            return res.status(400).json({
                success: false,
                message: `Insufficient ${leaveType} balance. Available: ${available} days, Requested: ${totalDays} days.`,
                code: "INSUFFICIENT_BALANCE",
            });
        }

        // ── Rule 4: SL document warning ──
        const requiresDocument = leaveType === "SL" && totalDays > config.slDocumentThreshold;

        // ── Build managers list ──
        const managersNotified = [];
        if (emp.primaryManager?.managerId) {
            managersNotified.push({
                managerId: emp.primaryManager.managerId,
                managerName: emp.primaryManager.managerName || "",
                type: "primary",
            });
        }
        if (emp.secondaryManager?.managerId) {
            managersNotified.push({
                managerId: emp.secondaryManager.managerId,
                managerName: emp.secondaryManager.managerName || "",
                type: "secondary",
            });
        }

        // ── Create application ──
        const app = await LeaveApplication.create({
            employeeId: req.user.id,
            biometricId: emp.biometricId,
            employeeName: `${emp.firstName} ${emp.lastName}`.trim(),
            designation: emp.designation,
            department: emp.department,
            leaveType,
            applicationDate,
            fromDate,
            toDate,
            totalDays,
            reason,
            isHalfDay: isHalfDay ? true : false,
            halfDaySlot: isHalfDay ? (halfDaySlot || "first_half") : null,
            requiresDocument,
            managersNotified,
            status: "pending",
        });

        // ── Notify HR via email (non-fatal) ──
        try {
            const emailService = require("../../services/emailService");
            if (emailService.sendLeaveAppliedToHR) {
                emailService.sendLeaveAppliedToHR({
                    employeeName: app.employeeName,
                    department: app.department,
                    designation: app.designation,
                    leaveType: app.leaveType,
                    fromDate: app.fromDate,
                    toDate: app.toDate,
                    totalDays: app.totalDays,
                    reason: app.reason,
                    isHalfDay: app.isHalfDay,
                    requiresDocument: app.requiresDocument,
                    applicationId: app._id.toString(),
                }).catch(e => console.warn("[LEAVE-APPLY-EMAIL]", e.message));
            }
        } catch (_) { }

        // ── Real-time notification to primary manager (socket.io) ──
        try {
            const io = req.app.get("io");
            if (io && managersNotified.length > 0) {
                const primaryMgr = managersNotified.find(m => m.type === "primary");
                if (primaryMgr?.managerId) {
                    io.to(String(primaryMgr.managerId)).emit("leave_notification", {
                        type: "leave_applied",
                        leaveId: app._id.toString(),
                        employeeName: app.employeeName,
                        leaveType: app.leaveType,
                        fromDate: app.fromDate,
                        toDate: app.toDate,
                        totalDays: app.totalDays,
                        message: `${app.employeeName} has applied for ${app.leaveType} leave (${app.fromDate} – ${app.toDate})`,
                        timestamp: new Date().toISOString(),
                    });
                }
            }
        } catch (_) { }

        notifyManagerOnLeaveApply(emp, app).catch(e =>
            console.warn("[LEAVE-PUSH] Manager notification failed:", e.message)
        );

        const responseMsg = requiresDocument
            ? `Leave application submitted. Note: You need to submit supporting documents for ${totalDays} days of Sick Leave.`
            : "Leave application submitted successfully";

        res.status(201).json({
            success: true,
            data: app,
            message: responseMsg,
            requiresDocument,
        });
    } catch (err) {
        console.error("Apply leave error:", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

// PATCH /api/employee/leave-applications/:id/cancel
router.patch("/:id/cancel", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user.id });
        if (!app) return res.status(404).json({ success: false, message: "Not found" });

        if (!["pending", "manager_approved"].includes(app.status)) {
            return res.status(400).json({ success: false, message: "Cannot cancel an already processed application" });
        }

        app.status = "cancelled";
        app.cancelledBy = req.user.id;
        app.cancelledAt = new Date();
        app.cancelReason = req.body.cancelReason || "";
        await app.save();

        res.json({ success: true, data: app, message: "Leave cancelled" });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// PUT /api/employee/leave-applications/:id  — Edit a PENDING leave (dates/reason)
router.put("/:id", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid ID" });

        const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user.id });
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });
        if (app.status !== "pending")
            return res.status(400).json({ success: false, message: `Cannot edit — leave is already ${app.status}. Only pending leaves can be edited.` });

        const { fromDate, toDate, reason, isHalfDay, halfDaySlot } = req.body;
        const newFrom = fromDate || app.fromDate;
        const newTo = (isHalfDay ? newFrom : (toDate || app.toDate));

        // Saturday-only check
        const [fy, fm, fd] = newFrom.split("-").map(Number);
        const [ty, tm, td] = newTo.split("-").map(Number);
        const fromObj = new Date(fy, fm - 1, fd), toObj = new Date(ty, tm - 1, td);
        if (fromObj.getTime() === toObj.getTime() && fromObj.getDay() === 6)
            return res.status(400).json({ success: false, message: "Saturday is not a valid leave day." });

        const newTotalDays = (isHalfDay !== undefined ? isHalfDay : app.isHalfDay) ? 0.5 : countLeaveDays(newFrom, newTo);
        if (newTotalDays <= 0)
            return res.status(400).json({ success: false, message: "No valid leave days in selected range." });

        // Overlap check (exclude self)
        const conflict = await LeaveApplication.findOne({
            _id: { $ne: req.params.id }, employeeId: req.user.id,
            status: { $nin: ["hr_rejected", "manager_rejected", "cancelled"] },
            fromDate: { $lte: newTo }, toDate: { $gte: newFrom },
        });
        if (conflict)
            return res.status(400).json({ success: false, message: `Conflicts with leave ${conflict.fromDate} – ${conflict.toDate}.`, code: "OVERLAP" });

        app.fromDate = newFrom;
        app.toDate = newTo;
        app.totalDays = newTotalDays;
        if (reason !== undefined) app.reason = reason;
        if (isHalfDay !== undefined) { app.isHalfDay = isHalfDay; app.halfDaySlot = isHalfDay ? (halfDaySlot || "first_half") : null; }
        await app.save();
        res.json({ success: true, data: app, message: "Leave updated." });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});

// DELETE /api/employee/leave-applications/:id  — Permanently delete a PENDING leave
// Record is fully removed — no trace on HR side
router.delete("/:id", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid ID" });

        const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user.id });
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });
        if (app.status !== "pending")
            return res.status(400).json({ success: false, message: `Cannot delete — leave is ${app.status}. Only pending leaves can be deleted.` });

        await LeaveApplication.deleteOne({ _id: req.params.id });
        res.json({ success: true, message: "Leave deleted permanently." });
    } catch (err) { res.status(500).json({ success: false, message: err.message }); }
});


// POST /api/employee/leave-applications/:id/upload-document
// Upload SL supporting document to Google Drive
router.post("/:id/upload-document", AllEmployeeAppMiddleware, (req, res, next) => {
    uploadMiddleware(req, res, (err) => {
        if (err) return res.status(400).json({ success: false, message: err.message });
        next();
    });
}, async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id))
            return res.status(400).json({ success: false, message: "Invalid ID" });

        if (!req.file)
            return res.status(400).json({ success: false, message: "No file uploaded. Please attach a PDF or image." });

        const app = await LeaveApplication.findOne({ _id: req.params.id, employeeId: req.user.id });
        if (!app) return res.status(404).json({ success: false, message: "Application not found" });
        if (!app.requiresDocument)
            return res.status(400).json({ success: false, message: "This leave does not require a supporting document." });

        // Upload to Google Drive
        const fileName = `SL_${app.employeeName || "employee"}_${app.fromDate}_${Date.now()}${req.file.originalname.includes(".") ? req.file.originalname.slice(req.file.originalname.lastIndexOf(".")) : ".pdf"}`;
        const driveResult = await uploadToGoogleDrive(req.file.buffer, {
            fileName,
            mimeType: req.file.mimetype,
        });

        app.documentSubmitted = true;
        app.documentUrl = driveResult.viewUrl;
        app.documentFileId = driveResult.fileId;
        app.documentFileName = fileName;
        app.documentUploadedAt = new Date();
        await app.save();

        res.json({
            success: true,
            message: "Document uploaded successfully.",
            data: {
                documentUrl: driveResult.viewUrl,
                documentFileName: fileName,
                embedUrl: driveResult.embedUrl,
            },
        });
    } catch (err) {
        console.error("Document upload error:", err);
        res.status(500).json({ success: false, message: err.message || "Upload failed." });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MANAGER APPROVAL/REJECT ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// PATCH /api/employee/leave-applications/manager/:id/approve
// Workflow:
//   Primary approves → status becomes manager_approved (waits for secondary if exists)
//   Secondary approves → status becomes hr_approved + balance consumed + attendance synced
router.patch("/manager/:id/approve", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { remarks } = req.body;
        const myId = req.user.id;

        const app = await LeaveApplication.findOne({
            _id: req.params.id,
            "managersNotified.managerId": myId,
        });
        if (!app) return res.status(404).json({ success: false, message: "Not found or not your application" });

        const mgr = app.managersNotified.find(m => String(m.managerId) === String(myId));
        const mgrType = mgr?.type || "primary";

        // Guard: primary can only approve when status=pending
        if (mgrType === "primary" && app.status !== "pending")
            return res.status(400).json({ success: false, message: `Cannot approve — current status is ${app.status}` });

        // Guard: secondary can only approve when primary has already approved
        if (mgrType === "secondary" && app.status !== "manager_approved")
            return res.status(400).json({ success: false, message: "Primary manager must approve first" });

        // Record decision
        if (!app.managerDecisions.find(d => String(d.managerId) === String(myId))) {
            app.managerDecisions.push({
                managerId: myId,
                managerName: mgr?.managerName || "",
                type: mgrType,
                decision: "approved",
                remarks: remarks || "",
                decidedAt: new Date(),
            });
        }

        const hasSecondary = app.managersNotified.some(m => m.type === "secondary");

        if (mgrType === "primary" && hasSecondary) {
            // Primary approved — now route to secondary manager
            app.status = "manager_approved";
            await app.save();

            // Notify secondary manager via socket
            try {
                const io = req.app.get("io");
                if (io) {
                    const secMgr = app.managersNotified.find(m => m.type === "secondary");
                    if (secMgr?.managerId) {
                        io.to(String(secMgr.managerId)).emit("leave_notification", {
                            type: "leave_pending_approval",
                            leaveId: app._id.toString(),
                            employeeName: app.employeeName,
                            leaveType: app.leaveType,
                            fromDate: app.fromDate,
                            toDate: app.toDate,
                            totalDays: app.totalDays,
                            message: `${app.employeeName}'s ${app.leaveType} leave needs your approval`,
                            timestamp: new Date().toISOString(),
                        });
                    }
                }
            } catch (_) { }

            notifySecondaryOnPrimaryApproval(app).catch(e =>
                console.warn("[LEAVE-PUSH] Secondary manager notification failed:", e.message)
            );


            return res.json({ success: true, data: app, message: "Leave approved by primary manager. Awaiting secondary manager approval." });
        }

        // Either primary-only approval, or secondary approval → final HR approve
        const { LeaveConfig: LC, LeaveBalance: LB } = require("../../models/HR_Models/LeaveManagement");
        const { applyLeaveToAttendance } = require("../HrRoutes/Attendance_section");

        app.status = "hr_approved";
        app.hrApprovedAt = new Date();
        app.hrRemarks = remarks || `Approved by ${mgrType} manager`;
        await app.save();

        // Consume balance
        const year = new Date(app.fromDate).getFullYear();
        const config = await LC.getConfig();
        const existingBal = await LB.findOne({ employeeId: app.employeeId, year });
        if (existingBal) {
            existingBal.consumed[app.leaveType] = (existingBal.consumed[app.leaveType] || 0) + app.totalDays;
            await existingBal.save();
        } else {
            const newConsumed = { CL: 0, SL: 0, PL: 0 };
            newConsumed[app.leaveType] = app.totalDays;
            await LB.create({
                employeeId: app.employeeId,
                biometricId: app.biometricId || "",
                year,
                entitlement: { CL: config.clPerYear, SL: config.slPerYear, PL: 0 },
                consumed: newConsumed,
            });
        }

        // Sync to attendance
        let attendanceResult = { applied: 0, skipped: 0 };
        try {
            if (applyLeaveToAttendance) attendanceResult = await applyLeaveToAttendance(app);
        } catch (e) { console.warn("[MGR-APPROVE] attendance sync:", e.message); }

        // Notify the employee that their leave is approved
        try {
            const io = req.app.get("io");
            if (io) {
                io.to(String(app.employeeId)).emit("leave_notification", {
                    type: "leave_approved",
                    leaveId: app._id.toString(),
                    leaveType: app.leaveType,
                    fromDate: app.fromDate,
                    toDate: app.toDate,
                    totalDays: app.totalDays,
                    message: `Your ${app.leaveType} leave (${app.fromDate} – ${app.toDate}) has been approved`,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch (_) { }

        const mgrName = mgr?.managerName || "Manager";
        notifyEmployeeOnLeaveAction(app, "approved", mgrName).catch(e =>
            console.warn("[LEAVE-PUSH] Employee approval notification failed:", e.message)
        );

        res.json({
            success: true,
            data: app,
            message: `Leave fully approved. Attendance updated on ${attendanceResult.applied} day(s).`,
            attendanceSync: attendanceResult,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// PATCH /api/employee/leave-applications/manager/:id/reject
router.patch("/manager/:id/reject", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const { remarks } = req.body;
        const app = await LeaveApplication.findOne({
            _id: req.params.id,
            "managersNotified.managerId": req.user.id,
        });
        if (!app) return res.status(404).json({ success: false, message: "Not found or not your application" });

        const mgr = app.managersNotified.find(m => String(m.managerId) === req.user.id);
        app.managerDecisions.push({
            managerId: req.user.id,
            managerName: mgr?.managerName || "",
            type: mgr?.type || "primary",
            decision: "rejected",
            remarks: remarks || "",
            decidedAt: new Date(),
        });

        app.status = "manager_rejected";
        app.rejectedBy = req.user.id;
        app.rejectedAt = new Date();
        app.rejectionReason = remarks || "";
        await app.save();

        // Notify employee of rejection
        try {
            const io = req.app.get("io");
            if (io) {
                io.to(String(app.employeeId)).emit("leave_notification", {
                    type: "leave_rejected",
                    leaveId: app._id.toString(),
                    leaveType: app.leaveType,
                    fromDate: app.fromDate,
                    toDate: app.toDate,
                    rejectionReason: remarks || "",
                    message: `Your ${app.leaveType} leave (${app.fromDate} – ${app.toDate}) was not approved`,
                    timestamp: new Date().toISOString(),
                });
            }
        } catch (_) { }

        const rejMgrName = mgr?.managerName || "Manager";
        notifyEmployeeOnLeaveAction(app, "rejected", rejMgrName).catch(e =>
            console.warn("[LEAVE-PUSH] Employee rejection notification failed:", e.message)
        );

        res.json({ success: true, data: app, message: "Leave rejected by manager" });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});


module.exports = router;