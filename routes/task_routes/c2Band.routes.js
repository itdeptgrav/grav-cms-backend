/**
 * c2Band.routes.js
 * C2 Band (Gold Task) — API Routes
 * Mounted in server.js: app.use("/cowork", require("./routes/task_routes/c2Band.routes"));
 *
 * Endpoints:
 *   GET  /cowork/c2/config                   → global c2GlobalMaxPoints (all roles)
 *   GET  /cowork/c2/gold-tasks               → active gold tasks + weightage totals (CEO/TL)
 *   GET  /cowork/c2/scores/:employeeId       → per-employee C2 score (CEO/TL or self)
 *   GET  /cowork/c2/scores                   → all employees C2 scores (CEO/TL)
 *   POST /cowork/c2/validate-weightage       → HARD BLOCK validation before task creation
 */

"use strict";
const express = require("express");
const { getBandMaxForEmployee } = require("../../models/BandConfig");

const router = express.Router();
const {
    verifyCoworkToken,
    verifyCeoOrTL,
    verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const { db } = require("../../config/firebaseAdmin");

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Sum active gold task weightages, optionally excluding one taskId (edit mode). */
async function sumActiveWeightages(excludeTaskId = null) {
    const snap = await db
        .collection("cowork_tasks")
        .where("isGoldTask", "==", true)
        .where("status", "not-in", ["done", "cancelled"])
        .get();

    let total = 0;
    snap.docs.forEach((d) => {
        const t = d.data();
        if (excludeTaskId && t.taskId === excludeTaskId) return;
        total += Number(t.c2Config?.weightagePercent) || 0;
    });
    return +total.toFixed(2);
}

/** Fetch c2MaxPoints — band-specific if employeeId given, else global. */
async function fetchGlobalMax(employeeId = null) {
    if (employeeId) {
        const bandMax = await getBandMaxForEmployee(employeeId);
        if (bandMax?.c2Max) return bandMax.c2Max;
    }
    const snap = await db.collection("cowork_sop_settings").doc("task_events").get();
    return snap.exists ? Number(snap.data().c2GlobalMaxPoints) || 0 : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/c2/config
// Returns the global C2 pool size set by Admin in SOP settings.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/c2/config", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const c2GlobalMaxPoints = await fetchGlobalMax();
        const totalUsed = await sumActiveWeightages();
        const remaining = Math.max(0, +(100 - totalUsed).toFixed(2));

        res.json({ success: true, c2GlobalMaxPoints, totalUsed, remaining });
    } catch (e) {
        console.error("[c2/config]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/c2/gold-tasks
// Lists every active Gold Task with its weightage. CEO/TL only.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/c2/gold-tasks", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const snap = await db
            .collection("cowork_tasks")
            .where("isGoldTask", "==", true)
            .where("status", "not-in", ["done", "cancelled"])
            .get();

        const tasks = snap.docs.map((d) => {
            const t = d.data();
            return {
                taskId: t.taskId,
                title: t.title,
                assigneeIds: t.assigneeIds || [],
                weightagePercent: t.c2Config?.weightagePercent || 0,
                taskMaxPoints: t.c2Config?.taskMaxPoints || 0,
                globalMaxAtCreation: t.c2Config?.globalMaxPointsAtCreation || 0,
                status: t.status,
                createdAtISO: t.createdAtISO || "",
            };
        });

        const totalWeightage = tasks.reduce((s, t) => s + t.weightagePercent, 0);
        const remainingWeightage = Math.max(0, +(100 - totalWeightage).toFixed(2));
        const globalMaxPoints = await fetchGlobalMax();

        res.json({
            success: true,
            tasks,
            totalWeightage: +totalWeightage.toFixed(2),
            remainingWeightage,
            globalMaxPoints,
        });
    } catch (e) {
        console.error("[c2/gold-tasks]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/c2/scores/:employeeId
// Returns C2 Band score for one employee.
// CEO/TL can query any employee. Employees can only query themselves.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    "/c2/scores/:employeeId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { employeeId: requesterId, role } = req.coworkUser;
            const { employeeId } = req.params;

            if (role === "employee" && requesterId !== employeeId) {
                return res
                    .status(403)
                    .json({ error: "Employees can only view their own C2 scores." });
            }

            const [scoreDoc, globalMaxPoints] = await Promise.all([
                db.collection("cowork_c2_scores").doc(employeeId).get(),
                fetchGlobalMax(employeeId),
            ]);

            if (!scoreDoc.exists) {
                return res.json({
                    success: true,
                    employeeId,
                    globalMaxPoints,
                    totalEarned: 0,
                    taskBreakdown: {},
                    updatedAt: null,
                });
            }

            res.json({ success: true, ...scoreDoc.data(), globalMaxPoints });
        } catch (e) {
            console.error("[c2/scores/:id]", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/c2/scores
// All employees C2 scores — CEO/TL only.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/c2/scores", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const [scoresSnap, globalMaxPoints] = await Promise.all([
            db.collection("cowork_c2_scores").get(),
            fetchGlobalMax(),
        ]);

        const scores = scoresSnap.docs.map((d) => d.data());
        res.json({ success: true, scores, globalMaxPoints });
    } catch (e) {
        console.error("[c2/scores/all]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/c2/validate-weightage
//
// HARD BLOCK: Validates whether a new Gold Task with the given `weightagePercent`
// can be created without exceeding 100% of the active C2 pool.
//
// Body: { weightagePercent: number, excludeTaskId?: string }
// Returns: { valid: boolean, error?: string, remaining, totalUsed, ... }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/c2/validate-weightage",
    verifyCoworkToken,
    verifyCeoOrTL,
    async (req, res) => {
        try {
            const { weightagePercent, excludeTaskId = null } = req.body;
            const newW = Number(weightagePercent) || 0;

            if (newW <= 0 || newW > 100) {
                return res.json({
                    valid: false,
                    error: "Weightage must be between 1% and 100%.",
                });
            }

            const totalUsed = await sumActiveWeightages(excludeTaskId);
            const remaining = +(100 - totalUsed).toFixed(2);

            if (newW > remaining) {
                return res.json({
                    valid: false,
                    totalUsed,
                    remaining,
                    requested: newW,
                    error:
                        `Cannot create task. Only ${remaining}% weightage remains in the current ` +
                        `C2 Band pool, but you entered ${newW}%. Please adjust this task's weightage ` +
                        `or reduce the weightage of existing active tasks.`,
                });
            }

            res.json({
                valid: true,
                totalUsed,
                remaining,
                requested: newW,
                afterAdding: +(totalUsed + newW).toFixed(2),
            });
        } catch (e) {
            console.error("[c2/validate-weightage]", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

module.exports = router;