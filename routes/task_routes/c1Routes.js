"use strict";
/**
 * c1Routes.js — C1 Execution Quality Score API
 * Mount in server.js: app.use("/cowork", require("./routes/task_routes/c1Routes"));
 *
 * Endpoints:
 *   GET  /cowork/c1/config                  → C1 settings (all roles)
 *   GET  /cowork/c1/scores/:employeeId      → C1 score for one employee
 *   GET  /cowork/c1/scores                  → All employees C1 scores (CEO/TL)
 *   POST /cowork/c1/preview                 → Preview task score before approval
 */

const express = require("express");
const router = express.Router();
const { verifyCoworkToken, verifyCeoOrTL, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");
const { db } = require("../../config/firebaseAdmin");
const { getC1Config, calculateTaskScore, C1_DEFAULTS } = require("../../services/c1Service");

// ── GET /cowork/c1/config ─────────────────────────────────────────────────────
router.get("/c1/config", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const cfg = await getC1Config();
        res.json({ success: true, ...cfg });
    } catch (e) {
        console.error("[c1/config]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /cowork/c1/scores/:employeeId ─────────────────────────────────────────
// CEO/TL can query any employee. Employees can only query themselves.
router.get("/c1/scores/:employeeId", verifyCoworkToken, verifyEmployeeToken, async (req, res) => {
    try {
        const { employeeId: requesterId, role } = req.coworkUser;
        const { employeeId } = req.params;

        if (role === "employee" && requesterId !== employeeId) {
            return res.status(403).json({ error: "Employees can only view their own C1 scores." });
        }

        const [scoreDoc, cfg] = await Promise.all([
            db.collection("cowork_c1_scores").doc(employeeId).get(),
            getC1Config(),
        ]);

        if (!scoreDoc.exists) {
            return res.json({
                success: true, employeeId,
                qualityRate: null, c1Net: null,
                c1MaxPoints: cfg.c1MaxPoints,
                taskBreakdown: {}, taskCount: 0, updatedAt: null,
            });
        }

        res.json({ success: true, ...scoreDoc.data(), c1MaxPoints: cfg.c1MaxPoints });
    } catch (e) {
        console.error("[c1/scores/:id]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── GET /cowork/c1/scores ─────────────────────────────────────────────────────
// All employees — CEO/TL only
router.get("/c1/scores", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const [scoresSnap, cfg] = await Promise.all([
            db.collection("cowork_c1_scores").get(),
            getC1Config(),
        ]);
        const scores = scoresSnap.docs.map(d => d.data());
        res.json({ success: true, scores, c1MaxPoints: cfg.c1MaxPoints });
    } catch (e) {
        console.error("[c1/scores/all]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── POST /cowork/c1/preview ───────────────────────────────────────────────────
// Preview the task score impact before TL approves/reworks/rejects
// Body: { taskId, isRejected?, submittedAt? }
router.post("/c1/preview", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { taskId, isRejected = false, submittedAt = null, dueDate: bodyDueDate = null } = req.body;
        if (!taskId) return res.status(400).json({ error: "taskId required" });

        const [taskDoc, cfg] = await Promise.all([
            db.collection("cowork_tasks").doc(taskId).get(),
            getC1Config(),
        ]);
        if (!taskDoc.exists) return res.status(404).json({ error: "Task not found" });

        const task = taskDoc.data();
        const c1 = task.c1 || {};

        // Deadline: use officialDeadline → task.dueDate → bodyDueDate (fallback from frontend)
        const officialDeadline = c1.officialDeadline || task.dueDate || task.fixedDeadline || bodyDueDate || null;
        const submittedDate = submittedAt ? new Date(submittedAt) : null;
        const deadlineDate = officialDeadline ? new Date(officialDeadline) : null;
        let deadlinesMissed = Number(c1.deadlinesMissed) || 0;
        const deadlineMissedNow = submittedDate && deadlineDate && submittedDate > deadlineDate;
        if (deadlineMissedNow) deadlinesMissed += 1;

        const extensionsFiled = Number(c1.extensionsFiled) || 0;
        const reworksReceived = Number(c1.reworksReceived) || 0;
        const rejectionsReceived = Number(c1.rejectionsReceived) || 0;

        const taskScore = calculateTaskScore(cfg, { deadlinesMissed, extensionsFiled, reworksReceived, isRejected });

        res.json({
            success: true,
            cfg,
            deadlinesMissed, deadlineMissedNow,
            extensionsFiled, reworksReceived, rejectionsReceived,
            taskScore: +taskScore.toFixed(3),
            etcHours: Number(task.etcHours) || 0,
            isRejected,
        });
    } catch (e) {
        console.error("[c1/preview]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;