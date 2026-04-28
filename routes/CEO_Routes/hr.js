/**
 * routes/CEO_Routes/hr.js  (FIXED VERSION)
 *
 * Fixes:
 *  1. Removed invalid space-separated field string in .select() — causes 500 errors
 *  2. Salary excluded via projection object, not broken string
 *  3. Added /attendance/muster-roll endpoint (monthly grid view)
 *  4. Added /attendance/export endpoint (proxies to HR export)
 *
 * Endpoints:
 *   GET  /api/ceo/hr/employees
 *   GET  /api/ceo/hr/employees/:id
 *   GET  /api/ceo/hr/departments
 *   GET  /api/ceo/hr/attendance/daily
 *   GET  /api/ceo/hr/attendance/muster-roll     ← NEW
 *   GET  /api/ceo/hr/attendance/summary
 *   GET  /api/ceo/hr/attendance/departments
 *   GET  /api/ceo/hr/attendance/export          ← NEW (proxies HR export)
 *   POST /api/ceo/hr/attendance/sync
 */

"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const http = require("http");

const Employee = require("../../models/Employee");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");

// ── Auth ─────────────────────────────────────────────────────────────────────
function ceoAuth(req, res, next) {
    try {
        const token = req.cookies.auth_token;
        if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
        const decoded = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
        if (!["ceo", "admin", "hr_manager"].includes(decoded.role)) {
            return res.status(403).json({ success: false, message: "CEO access required" });
        }
        req.ceoUser = decoded;
        next();
    } catch {
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
//  EMPLOYEES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ceo/hr/employees
router.get("/employees", ceoAuth, async (req, res) => {
    try {
        const { page = 1, limit = 25, search = "", department = "", status = "active" } = req.query;

        const query = {};
        if (status === "active") query.isActive = true;
        else if (status === "inactive") query.isActive = false;
        if (department && department !== "all") query.department = department;

        if (search.trim()) {
            const re = new RegExp(search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
            query.$or = [
                { firstName: re }, { lastName: re }, { email: re },
                { biometricId: re }, { identityId: re }, { designation: re }, { department: re },
            ];
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);

        // Use projection object (not string) to exclude salary
        const projection = { salary: 0, password: 0, temporaryPassword: 0 };

        const [employees, total] = await Promise.all([
            Employee.find(query, projection)
                .sort({ firstName: 1, lastName: 1 })
                .skip(skip)
                .limit(parseInt(limit))
                .lean(),
            Employee.countDocuments(query),
        ]);

        res.json({
            success: true,
            data: employees,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / parseInt(limit)),
            },
        });
    } catch (err) {
        console.error("[CEO] GET /employees:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});

// GET /api/ceo/hr/employees/:id
router.get("/employees/:id", ceoAuth, async (req, res) => {
    try {
        const emp = await Employee.findById(req.params.id, { salary: 0, password: 0, temporaryPassword: 0 }).lean();
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
        res.json({ success: true, data: emp });
    } catch (err) {
        console.error("[CEO] GET /employees/:id:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});

// GET /api/ceo/hr/departments
router.get("/departments", ceoAuth, async (req, res) => {
    try {
        // Try Department model, fall back to aggregation
        let depts = [];
        try {
            const Department = require("../../models/HR_Models/Department");
            depts = await Department.find({ isActive: { $ne: false } })
                .select("name isActive")
                .sort({ name: 1 })
                .lean();
        } catch {
            depts = await Employee.aggregate([
                { $match: { isActive: true, department: { $exists: true, $ne: "" } } },
                { $group: { _id: "$department", count: { $sum: 1 } } },
                { $project: { name: "$_id", count: 1, _id: 0 } },
                { $sort: { name: 1 } },
            ]);
        }
        res.json({ success: true, data: depts });
    } catch (err) {
        console.error("[CEO] GET /departments:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
//  ATTENDANCE
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/ceo/hr/attendance/departments
router.get("/attendance/departments", ceoAuth, async (req, res) => {
    try {
        const depts = await Employee.distinct("department", { isActive: true, department: { $exists: true, $ne: "" } });
        res.json({ success: true, data: depts.filter(Boolean).sort() });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/ceo/hr/attendance/daily?date=YYYY-MM-DD&department=
router.get("/attendance/daily", ceoAuth, async (req, res) => {
    try {
        const { date, department } = req.query;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ success: false, message: "date param required (YYYY-MM-DD)" });
        }

        const doc = await DailyAttendance.findOne({ dateStr: date }).lean();

        if (!doc) {
            return res.json({ success: true, data: [], summary: {}, holiday: null, synced: false, syncedAt: null, dateStr: date });
        }

        let employees = doc.employees || [];
        if (department && department !== "all") {
            employees = employees.filter(e => e.department === department);
        }

        const records = employees.map(e => ({
            ...e,
            effectiveStatus: e.hrFinalStatus || e.systemPrediction || "AB",
            isOverwritten: !!(e.hrFinalStatus && e.hrFinalStatus !== e.systemPrediction),
        }));

        res.json({
            success: true,
            data: records,
            summary: doc.summary || {},
            holiday: doc.holiday || null,
            synced: true,
            syncedAt: doc.syncedAt,
            hrFinalised: doc.hrFinalised || false,
            finalisedAt: doc.finalisedAt,
            dateStr: date,
        });
    } catch (err) {
        console.error("[CEO] GET /attendance/daily:", err.message);
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/ceo/hr/attendance/muster-roll?yearMonth=YYYY-MM&department=
// Returns per-employee per-day status grid (same data HR muster roll uses)
router.get("/attendance/muster-roll", ceoAuth, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
            return res.status(400).json({ success: false, message: "yearMonth required (YYYY-MM)" });
        }

        // Fetch all days in this month
        const docs = await DailyAttendance.find({ yearMonth }).sort({ dateStr: 1 }).lean();

        if (!docs.length) {
            return res.json({ success: true, employees: [], days: [], grand: null, syncedDays: 0, yearMonth });
        }

        // Build days list
        const days = docs.map(d => ({
            dateStr: d.dateStr,
            dayOfWeek: new Date(d.dateStr + "T00:00:00").getDay(),
            holiday: d.holiday || null,
            hrFinalised: d.hrFinalised || false,
            syncedAt: d.syncedAt,
        }));

        // Build employee map: biometricId → { meta, days: { dateStr: status } }
        const empMap = {};

        for (const doc of docs) {
            for (const e of (doc.employees || [])) {
                if (department && department !== "all" && e.department !== department) continue;
                if (!empMap[e.biometricId]) {
                    empMap[e.biometricId] = {
                        biometricId: e.biometricId,
                        identityId: e.identityId || "",
                        employeeName: e.employeeName || "",
                        department: e.department || "",
                        designation: e.designation || "",
                        employeeType: e.employeeType || "operator",
                        days: {},
                        totals: { P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, leaves: 0, totalNetWorkMins: 0, totalOtMins: 0, totalLateMins: 0 },
                    };
                }

                const status = e.hrFinalStatus || e.systemPrediction || "AB";
                const isOverwritten = !!(e.hrFinalStatus && e.hrFinalStatus !== e.systemPrediction);

                empMap[e.biometricId].days[doc.dateStr] = {
                    status,
                    systemStatus: e.systemPrediction,
                    isOverwritten,
                    netWorkMins: e.netWorkMins || 0,
                    otMins: e.otMins || 0,
                    lateMins: e.lateMins || 0,
                    isLate: e.isLate || false,
                    inTime: e.inTime,
                    finalOut: e.finalOut,
                };

                // Accumulate totals
                const t = empMap[e.biometricId].totals;
                if (["P", "P*", "P~"].includes(status)) t.P++;
                if (status === "P*") t["P*"]++;
                if (status === "P~") t["P~"]++;
                if (status === "HD") t.HD++;
                if (status === "AB") t.AB++;
                if (status === "MP") t.MP++;
                if (["WO", "FH", "NH", "OH", "RH", "PH"].includes(status)) t.WO++;
                if (["L-CL", "L-SL", "L-EL", "LWP", "CO", "WFH"].includes(status)) t.leaves++;
                t.totalNetWorkMins += e.netWorkMins || 0;
                t.totalOtMins += e.otMins || 0;
                t.totalLateMins += e.lateMins || 0;
            }
        }

        const employees = Object.values(empMap).sort((a, b) => a.employeeName.localeCompare(b.employeeName));

        // Grand totals
        const grand = employees.reduce((acc, emp) => {
            acc.totalEmployees++;
            acc.totalPresent += emp.totals.P;
            acc.totalAbsent += emp.totals.AB;
            acc.totalLate += emp.totals["P*"];
            acc.totalHD += emp.totals.HD;
            acc.totalLeaves += emp.totals.leaves;
            acc.totalOtMins += emp.totals.totalOtMins;
            return acc;
        }, { totalEmployees: 0, totalPresent: 0, totalAbsent: 0, totalLate: 0, totalHD: 0, totalLeaves: 0, totalOtMins: 0, workingDays: days.length, syncedDays: docs.length });

        res.json({
            success: true,
            employees,
            days,
            grand,
            syncedDays: docs.length,
            yearMonth,
            monthLabel: new Date(yearMonth + "-01").toLocaleDateString("en-IN", { month: "long", year: "numeric" }),
        });
    } catch (err) {
        console.error("[CEO] GET /attendance/muster-roll:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});

// GET /api/ceo/hr/attendance/summary?yearMonth=YYYY-MM
router.get("/attendance/summary", ceoAuth, async (req, res) => {
    try {
        const { yearMonth } = req.query;
        if (!yearMonth || !/^\d{4}-\d{2}$/.test(yearMonth)) {
            return res.status(400).json({ success: false, message: "yearMonth required (YYYY-MM)" });
        }

        const docs = await DailyAttendance.find({ yearMonth }).select("dateStr summary hrFinalised syncedAt").lean();

        let totalPresent = 0, totalAbsent = 0, totalLate = 0, totalHD = 0;
        docs.forEach(d => {
            totalPresent += (d.summary?.presentCount || 0);
            totalAbsent += (d.summary?.AB || 0);
            totalLate += (d.summary?.["P*"] || 0);
            totalHD += (d.summary?.HD || 0);
        });

        res.json({
            success: true,
            data: {
                yearMonth, totalDays: docs.length,
                syncedDays: docs.filter(d => d.syncedAt).length,
                finalisedDays: docs.filter(d => d.hrFinalised).length,
                totalPresent, totalAbsent, totalLate, totalHD,
                days: docs.map(d => ({ dateStr: d.dateStr, summary: d.summary, hrFinalised: d.hrFinalised, syncedAt: d.syncedAt })),
            },
        });
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// GET /api/ceo/hr/attendance/export?yearMonth=YYYY-MM&department=
// Proxies to HR export endpoint
router.get("/attendance/export", ceoAuth, async (req, res) => {
    try {
        const { yearMonth, department } = req.query;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const qs = new URLSearchParams({ yearMonth, ...(department && department !== "all" && { department }) });
        const port = process.env.PORT || 5000;

        const proxyReq = http.request({
            hostname: "localhost",
            port,
            path: `/hr/attendance/export-muster-roll?${qs}`,
            method: "GET",
            headers: { Cookie: req.headers.cookie || "" },
        }, (proxyRes) => {
            res.status(proxyRes.statusCode);
            Object.entries(proxyRes.headers).forEach(([k, v]) => res.setHeader(k, v));
            proxyRes.pipe(res);
        });

        proxyReq.on("error", (err) => {
            console.error("[CEO] Export proxy error:", err.message);
            res.status(500).json({ success: false, message: "Export failed" });
        });
        proxyReq.end();
    } catch (err) {
        res.status(500).json({ success: false, message: "Server error" });
    }
});

// POST /api/ceo/hr/attendance/sync  body: { date: "YYYY-MM-DD" }
router.post("/attendance/sync", ceoAuth, async (req, res) => {
    try {
        const { date } = req.body;
        if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return res.status(400).json({ success: false, message: "date required (YYYY-MM-DD)" });
        }

        const port = process.env.PORT || 5000;
        const body = JSON.stringify({ fromDate: date, toDate: date });

        const syncResult = await new Promise((resolve, reject) => {
            const proxyReq = http.request({
                hostname: "localhost",
                port,
                path: "/hr/attendance/sync",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                    Cookie: req.headers.cookie || "",
                },
            }, (proxyRes) => {
                let data = "";
                proxyRes.on("data", chunk => { data += chunk; });
                proxyRes.on("end", () => {
                    try { resolve(JSON.parse(data)); }
                    catch { resolve({ success: false, message: "Parse error" }); }
                });
            });
            proxyReq.on("error", reject);
            proxyReq.write(body);
            proxyReq.end();
        });

        res.json(syncResult);
    } catch (err) {
        console.error("[CEO] POST /attendance/sync:", err.message);
        res.status(500).json({ success: false, message: "Sync failed: " + err.message });
    }
});

module.exports = router;