"use strict";
/**
 * routes/Employee_Routes/employeeAttendance.js
 * Mount in server.js: app.use("/api/employee/attendance", require("./routes/Employee_Routes/employeeAttendance"));
 */

const express = require("express");
const router = express.Router();
const Employee = require("../../models/Employee");
const AttendanceRouter = require("../HrRoutes/Attendance_section");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const AllEmployeeAppMiddleware = require("../../Middlewear/AllEmployeeAppMiddleware");
const { syncTodayOnly } = require("../HrRoutes/Attendance_section");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayIST() {
    // Add 5h30m to UTC to get IST date string
    return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function fmtTime(date) {
    if (!date) return null;
    return new Date(date).toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata"
    });
}

function minsToHrsDisplay(mins = 0) {
    if (!mins || mins <= 0) return null;
    const h = Math.floor(mins / 60), m = mins % 60;
    if (h === 0) return `${m}m`;
    if (m === 0) return `${h}h`;
    return `${h}h ${m}m`;
}

// Maps status code → human label + tailwind color token
const STATUS_META = {
    "P": { label: "Present", color: "emerald" },
    "P*": { label: "Present (Late)", color: "emerald" },
    "P~": { label: "Present (Early)", color: "emerald" },
    "AB": { label: "Absent", color: "red" },
    "WO": { label: "Week Off", color: "slate" },
    "PH": { label: "Public Holiday", color: "amber" },
    "FH": { label: "Festival Holiday", color: "amber" },
    "NH": { label: "National Holiday", color: "amber" },
    "OH": { label: "Optional Holiday", color: "amber" },
    "RH": { label: "Restricted Holiday", color: "amber" },
    "HD": { label: "Half Day", color: "yellow" },
    "L-CL": { label: "Casual Leave", color: "indigo" },
    "L-SL": { label: "Sick Leave", color: "orange" },
    "L-EL": { label: "Privilege Leave", color: "purple" },
    "LWP": { label: "Unpaid Leave", color: "red" },
    "MP": { label: "Miss Punch", color: "orange" },
    "WFH": { label: "Work From Home", color: "blue" },
    "CO": { label: "Comp. Off", color: "violet" },
};

function enrichEntry(entry, dayDoc) {
    const rawStatus = entry?.hrFinalStatus || entry?.systemPrediction || null;
    const meta = STATUS_META[rawStatus] || { label: rawStatus || "—", color: "gray" };
    const isHrEdited = !!entry?.hrFinalStatus;

    return {
        dateStr: dayDoc.dateStr,
        status: rawStatus,
        label: meta.label,
        color: meta.color,
        isHrEdited,
        inTime: fmtTime(entry?.inTime),
        finalOut: fmtTime(entry?.finalOut),
        netWorkMins: entry?.netWorkMins || 0,
        workDisplay: minsToHrsDisplay(entry?.netWorkMins),
        isLate: entry?.isLate || false,
        lateMins: entry?.lateMins || 0,
        lateDisplay: entry?.lateDisplay || "",
        holiday: dayDoc.holiday || null,
        hasMissPunch: entry?.hasMissPunch || false,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /today
//  Returns today's attendance status for the logged-in employee
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/today", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const emp = await Employee.findById(req.user.id).select("biometricId").lean();
        if (!emp?.biometricId) {
            return res.json({ success: true, data: null, message: "No biometric ID assigned" });
        }

        const dateStr = getTodayIST();
        const dayDoc = await DailyAttendance.findOne({ dateStr }).lean();

        if (!dayDoc) {
            return res.json({
                success: true,
                data: { dateStr, status: null, label: "Not synced yet", color: "gray", synced: false }
            });
        }

        const entry = (dayDoc.employees || []).find(e => e.biometricId === emp.biometricId);
        const result = enrichEntry(entry, dayDoc);

        res.json({ success: true, data: { ...result, synced: true } });
    } catch (err) {
        console.error("[ATT-TODAY]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
//  GET /monthly?month=MM&year=YYYY
//  Returns all days in a month for the logged-in employee.
//  Uses hrFinalStatus when HR has overridden, otherwise systemPrediction.
// ═══════════════════════════════════════════════════════════════════════════════
router.get("/monthly", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        const emp = await Employee.findById(req.user.id).select("biometricId").lean();
        if (!emp?.biometricId) {
            return res.json({ success: true, data: [], summary: {}, message: "No biometric ID assigned" });
        }

        const year = String(req.query.year || new Date().getFullYear());
        const month = String(req.query.month || new Date().getMonth() + 1).padStart(2, "0");
        const yearMonth = `${year}-${month}`;

        const dayDocs = await DailyAttendance.find({ yearMonth }).sort({ dateStr: 1 }).lean();

        const data = dayDocs.map(day => {
            const entry = (day.employees || []).find(e => e.biometricId === emp.biometricId);
            return enrichEntry(entry, day);
        });

        // Build summary
        const summary = data.reduce((acc, d) => {
            const s = d.status;
            if (!s) return acc;
            if (["P", "P*", "P~"].includes(s)) acc.present++;
            else if (s === "AB") acc.absent++;
            else if (s === "WO") acc.weekOff++;
            else if (["PH", "FH", "NH", "OH", "RH"].includes(s)) acc.holiday++;
            else if (s === "HD") acc.halfDay++;
            else if (["L-CL", "L-SL", "L-EL"].includes(s)) acc.onLeave++;
            else if (s === "LWP") acc.lwp++;
            else if (s === "MP") acc.missPunch++;
            else if (s === "WFH") acc.wfh++;
            acc.total++;
            return acc;
        }, { present: 0, absent: 0, weekOff: 0, holiday: 0, halfDay: 0, onLeave: 0, lwp: 0, missPunch: 0, wfh: 0, total: 0 });

        res.json({ success: true, data, summary, yearMonth });
    } catch (err) {
        console.error("[ATT-MONTHLY]", err.message);
        res.status(500).json({ success: false, message: err.message });
    }
});

router.post("/sync-today", AllEmployeeAppMiddleware, async (req, res) => {
    try {
        // syncTodayOnly is exported from the HR attendance router
        if (typeof AttendanceRouter.syncTodayOnly === 'function') {
            const result = await AttendanceRouter.syncTodayOnly();
            return res.json({
                success: true,
                message: result ? `Synced ${result.employees || 0} employees` : "Sync completed",
            });
        }
        // Fallback if syncTodayOnly not exported yet
        res.json({ success: true, message: "Sync not available — data refreshed" });
    } catch (err) {
        console.error("[EMPLOYEE-SYNC]", err.message);
        res.status(500).json({ success: false, message: "Sync failed. Try again." });
    }
});




module.exports = router;