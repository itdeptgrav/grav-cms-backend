"use strict";
/**
 * pmpRoutes.js — PMP Dashboard API
 * Mount in server.js: app.use("/cowork", require("./routes/task_routes/pmpRoutes"));
 *
 * Endpoints:
 *   GET /pmp/:employeeId/dashboard?quarter=2&year=2026
 *   GET /pmp/:employeeId/c1?quarter=2&year=2026
 *   GET /pmp/:employeeId/c2
 *
 * Auth:
 *   CEO     → any employee
 *   TL      → own department only
 *   Employee → own data only
 */

const express = require("express");
const router = express.Router();
const { db } = require("../../config/firebaseAdmin");
const {
    verifyCoworkToken,
    verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const pmpSvc = require("../../services/pmpService");

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD HELPER
// CEO   → pass
// TL    → only if target employee is in TL's department
// Employee → only if requesting their own data
// ─────────────────────────────────────────────────────────────────────────────
async function canAccessEmployee(requester, targetEmployeeId) {
    const { role, employeeId: requesterId } = requester;

    if (role === "ceo") return true;

    if (role === "employee") {
        return requesterId === targetEmployeeId;
    }

    if (role === "tl") {
        // TL can see self
        if (requesterId === targetEmployeeId) return true;

        // TL can see employees in their own department
        const [tlSnap, targetSnap] = await Promise.all([
            db.collection("cowork_employees").where("employeeId", "==", requesterId).limit(1).get(),
            db.collection("cowork_employees").where("employeeId", "==", targetEmployeeId).limit(1).get(),
        ]);

        if (tlSnap.empty || targetSnap.empty) return false;

        const tlDept = tlSnap.docs[0].data().department || null;
        const targetDept = targetSnap.docs[0].data().department || null;

        return tlDept && tlDept === targetDept;
    }

    return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /pmp/:employeeId/dashboard?quarter=2&year=2026
// Master endpoint — returns everything the dashboard needs in one call.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pmp/:employeeId/dashboard", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const quarter = Number(req.query.quarter) || pmpSvc.getQuarterFromDate();
        const year = Number(req.query.year) || pmpSvc.getCurrentYear();

        // Auth check
        const allowed = await canAccessEmployee(req.coworkUser, employeeId);
        if (!allowed) {
            return res.status(403).json({
                error: "Access denied. You can only view employees in your department.",
            });
        }

        // Validate quarter
        if (quarter < 1 || quarter > 4) {
            return res.status(400).json({ error: "quarter must be 1, 2, 3, or 4." });
        }

        const data = await pmpSvc.getDashboardData(employeeId, quarter, year);

        // Fetch employee name + department for display
        const empSnap = await db.collection("cowork_employees")
            .where("employeeId", "==", employeeId)
            .limit(1)
            .get();

        const empData = empSnap.empty ? {} : empSnap.docs[0].data();

        res.json({
            success: true,
            employee: {
                employeeId,
                name: empData.name || "",
                department: empData.department || "",
                role: empData.role || "",
                designation: empData.designation || "",
            },
            ...data,
        });
    } catch (e) {
        console.error("[pmp/dashboard]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /pmp/:employeeId/c1?quarter=2&year=2026
// Returns per-quarter C1 breakdown with task-by-task scores.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pmp/:employeeId/c1", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId } = req.params;
        const quarter = Number(req.query.quarter) || pmpSvc.getQuarterFromDate();
        const year = Number(req.query.year) || pmpSvc.getCurrentYear();

        const allowed = await canAccessEmployee(req.coworkUser, employeeId);
        if (!allowed) {
            return res.status(403).json({ error: "Access denied." });
        }

        if (quarter < 1 || quarter > 4) {
            return res.status(400).json({ error: "quarter must be 1, 2, 3, or 4." });
        }

        const c1Data = await pmpSvc.computeC1ForQuarter(employeeId, quarter, year);
        const rating = pmpSvc.getRating(
            c1Data.c1Net !== null && c1Data.c1Max > 0
                ? (c1Data.c1Net / c1Data.c1Max) * 100
                : null
        );

        res.json({
            success: true,
            employeeId,
            quarter,
            year,
            c1Net: c1Data.c1Net,
            c1Max: c1Data.c1Max,
            qualityRate: c1Data.qualityRate,
            qualityPct: c1Data.qualityRate !== null
                ? +((c1Data.qualityRate) * 100).toFixed(1)
                : null,
            taskCount: c1Data.taskCount,
            rating,
            tasks: c1Data.tasks,
        });
    } catch (e) {
        console.error("[pmp/c1]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /pmp/:employeeId/c2
// Returns running C2 gold task breakdown.
// C2 is annual (not per quarter) — quarter param ignored.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pmp/:employeeId/c2", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId } = req.params;

        const allowed = await canAccessEmployee(req.coworkUser, employeeId);
        if (!allowed) {
            return res.status(403).json({ error: "Access denied." });
        }

        const c2Data = await pmpSvc.computeC2ForEmployee(employeeId);
        const rating = pmpSvc.getRating(
            c2Data.c2Net !== null && c2Data.c2Max > 0
                ? (c2Data.c2Net / c2Data.c2Max) * 100
                : null
        );

        res.json({
            success: true,
            employeeId,
            c2Net: c2Data.c2Net,
            c2Max: c2Data.c2Max,
            ptsEarned: c2Data.ptsEarned,
            ptsPastDeadline: c2Data.ptsPastDeadline,
            hitRate: c2Data.c2Score,
            hitRatePct: c2Data.c2Score !== null
                ? +((c2Data.c2Score) * 100).toFixed(1)
                : null,
            taskCount: c2Data.taskCount,
            rating,
            tasks: c2Data.tasks,
        });
    } catch (e) {
        console.error("[pmp/c2]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /pmp/employees
// Returns list of employees this requester is allowed to view.
// CEO → all employees. TL → own department. Employee → just themselves.
// Used by the frontend to populate the employee selector.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/pmp/employees", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { role, employeeId: requesterId, employeeData } = req.coworkUser;
        const empSnap = await db.collection("cowork_employees").get();
        let employees = empSnap.docs
            .map(d => d.data())
            .filter(e => e.employeeId !== "E000"); // exclude CEO from list

        if (role === "employee") {
            employees = employees.filter(e => e.employeeId === requesterId);
        } else if (role === "tl") {
            const tlDept = employeeData?.department || null;
            if (tlDept) {
                employees = employees.filter(e => e.department === tlDept);
            } else {
                employees = employees.filter(e => e.employeeId === requesterId);
            }
        }
        // CEO gets all

        res.json({
            success: true,
            employees: employees.map(e => ({
                employeeId: e.employeeId,
                name: e.name || "",
                department: e.department || "",
                designation: e.designation || "",
                role: e.role || "employee",
            })).sort((a, b) => a.name.localeCompare(b.name)),
        });
    } catch (e) {
        console.error("[pmp/employees]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;