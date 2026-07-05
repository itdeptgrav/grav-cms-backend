"use strict";
/**
 * c1Service.js — C1 Execution Quality Score calculation engine
 *
 * Formula:
 *   Task Score = c1BaseScore
 *              − (c1DeadlineDeduction × deadlinesMissed)
 *              − (c1ExtensionDeduction × extensionsFiled)
 *              − (c1ReworkDeduction    × reworksReceived)
 *
 *   → Override to c1RejectScore when TL rejects
 *   → Excluded (null) when task is cancelled
 *
 *   Quality Rate = MAX( Σ(taskScore × etcHours) ÷ Σ(etcHours) , 0 )
 *   C1 Net       = Quality Rate × c1MaxPoints  (null if no closed tasks)
 */

const { db, admin } = require("../config/firebaseAdmin");
const Employee = require("../models/Employee");
const { getBandMaxForEmployee } = require("../models/BandConfig");

// ── Default C1 config (used as fallback if admin hasn't saved settings yet) ──
const C1_DEFAULTS = {
    c1MaxPoints: 35,
    c1BaseScore: 1.0,
    c1DeadlineDeduction: 0.5,
    c1ExtensionDeduction: 0.2,
    c1ReworkDeduction: 0.2,
    c1RejectScore: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// getC1Config — fetch admin-set C1 settings from Firestore
// ─────────────────────────────────────────────────────────────────────────────
async function getC1Config() {
    try {
        const snap = await db.collection("cowork_sop_settings").doc("task_events").get();
        if (!snap.exists) return { ...C1_DEFAULTS };
        const d = snap.data();
        return {
            c1MaxPoints: Number(d.c1MaxPoints) || C1_DEFAULTS.c1MaxPoints,
            c1BaseScore: Number(d.c1BaseScore) ?? C1_DEFAULTS.c1BaseScore,
            c1DeadlineDeduction: Number(d.c1DeadlineDeduction) ?? C1_DEFAULTS.c1DeadlineDeduction,
            c1ExtensionDeduction: Number(d.c1ExtensionDeduction) ?? C1_DEFAULTS.c1ExtensionDeduction,
            c1ReworkDeduction: Number(d.c1ReworkDeduction) ?? C1_DEFAULTS.c1ReworkDeduction,
            c1RejectScore: Number(d.c1RejectScore) ?? C1_DEFAULTS.c1RejectScore,
        };
    } catch (e) {
        console.error("[c1Service.getC1Config]", e.message);
        return { ...C1_DEFAULTS };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateTaskScore — single task score
// ─────────────────────────────────────────────────────────────────────────────

function calculateTaskScore(cfg, { deadlinesMissed = 0, extensionsFiled = 0, reworksReceived = 0, rejectionsReceived = 0, isRejected = false }) {
    if (isRejected) return +Number(cfg.c1RejectScore).toFixed(2);
    return +Math.max(0,
        Number(cfg.c1BaseScore) -
        (Number(cfg.c1DeadlineDeduction) * deadlinesMissed) -
        (Number(cfg.c1ExtensionDeduction) * extensionsFiled) -
        (Number(cfg.c1ReworkDeduction) * reworksReceived) -
        (Number(cfg.c1RejectScore) * rejectionsReceived)
    ).toFixed(2);
}


// ─────────────────────────────────────────────────────────────────────────────
// calculateQualityRate — ETC-weighted average across all closed tasks
// Cancelled tasks excluded. Returns null if no eligible tasks.
// ─────────────────────────────────────────────────────────────────────────────
function calculateQualityRate(tasks) {
    // Only tasks with a computed score and positive ETC
    const eligible = tasks.filter(t =>
        t.c1?.taskScore !== null &&
        t.c1?.taskScore !== undefined &&
        !t.c1?.isExcluded &&
        Number(t.etcHours) > 0
    );
    if (eligible.length === 0) return null;

    const numerator = eligible.reduce((s, t) => s + (Number(t.c1.taskScore) * Number(t.etcHours)), 0);
    const denominator = eligible.reduce((s, t) => s + Number(t.etcHours), 0);
    if (denominator === 0) return null;

    return Math.max(numerator / denominator, 0); // Floor at 0
}

// ─────────────────────────────────────────────────────────────────────────────
// calculateC1Net
// ─────────────────────────────────────────────────────────────────────────────
function calculateC1Net(qualityRate, c1MaxPoints) {
    if (qualityRate === null || qualityRate === undefined) return null;
    return +(qualityRate * Number(c1MaxPoints)).toFixed(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// computeAndStoreTaskScore
// Called when TL/CEO approves or rejects a task.
// Reads current task's c1 counters, calculates score, stores on task doc,
// and updates cowork_c1_scores/{employeeId} cache in Firestore.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// _writeC1BleachEntries
// Writes C1 deductions to MongoDB Employee.sopPoints so they show in SOP history
// ─────────────────────────────────────────────────────────────────────────────
async function _writeC1BleachEntries({ employeeId, taskId, taskTitle, reviewerName, reviewerId,
    deadlinesMissed, extensionsFiled, reworksReceived, isRejected, cfg }) {
    try {
        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return;

        const today = new Date().toISOString().split("T")[0];
        const year = new Date().getFullYear();
        const entries = [];

        // ── Single entry — final task score ──────────────────────────────────────
        // taskScore already includes ALL deductions (rework + extension + deadline)
        // We write ONE entry only — the net earned score.
        // Rework/extension are NOT written separately (they are included in taskScore)
        // Deadline is NOT written separately (included in taskScore)
        // reworksReceived already written to SOP immediately via writeReworkDeduction
        // exclude here to avoid double-counting
        const taskScore = calculateTaskScore(cfg, {
            deadlinesMissed, extensionsFiled, reworksReceived: 0, isRejected
        });

        if (isRejected) {
            // Rejection — write as penalty if rejectScore > 0
            if (Number(cfg.c1RejectScore) > 0) {
                entries.push({
                    sopName: "C1 — Task Rejected",
                    type: "C1",
                    folderName: taskTitle || taskId,
                    points: +Number(cfg.c1RejectScore).toFixed(2),
                    description: `Task rejected · Penalty: ${cfg.c1RejectScore} pts · ${taskTitle || taskId}`,
                    isC1: true, bleachType: "credit", isCredit: false,
                    date: today, cutBy: reviewerId, cutByName: reviewerName, cutByRole: "tl",
                    taskId, recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
                });
            }
        } else if (taskScore > 0) {
            // Approved — write final earned score as single reward entry
            const events = [];
            if (deadlinesMissed > 0) events.push(`${deadlinesMissed} deadline`);
            if (extensionsFiled > 0) events.push(`${extensionsFiled} ext`);
            if (reworksReceived > 0) events.push(`${reworksReceived} rework`);
            const eventStr = events.length > 0 ? ` · ${events.join(", ")}` : "";

            entries.push({
                sopName: "C1 — Task Completed",
                type: "C1",
                folderName: taskTitle || taskId,
                points: +taskScore.toFixed(2),
                description: `Task approved · Score: ${taskScore.toFixed(2)}${eventStr} · ${taskTitle || taskId}`,
                isC1: true, bleachType: "debit", isCredit: true,
                date: today, cutBy: reviewerId, cutByName: reviewerName, cutByRole: "tl",
                taskId, recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
            });
        }

        if (entries.length === 0) return;

        if (!employee.sopPoints) employee.sopPoints = [];
        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        // Credits (debit) reduce totalDeducted (reward), debits (credit) increase it (penalty)
        const totalDeduction = +entries.reduce((s, e) =>
            e.bleachType === "credit" ? s + e.points : s - e.points
            , 0).toFixed(2);

        if (yearIndex >= 0) {
            entries.forEach(e => employee.sopPoints[yearIndex].bleaches.push(e));
            employee.sopPoints[yearIndex].totalDeducted = +(
                employee.sopPoints[yearIndex].totalDeducted + totalDeduction
            ).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: totalDeduction, bleaches: entries });
        }

        await employee.save();
        console.log(`[C1 bleach] Wrote ${entries.length} deduction(s) for ${employeeId} on task ${taskId}`);
    } catch (e) {
        console.error("[_writeC1BleachEntries]", e.message);
    }
}

async function computeAndStoreTaskScore({ taskId, taskData, employeeId, isRejected = false, submittedAt = null }) {
    try {
        const cfg = await getC1Config();
        // Band-specific C1 max (overrides global if employee has a band)
        const bandMax = await getBandMaxForEmployee(employeeId);
        if (bandMax?.c1Max) cfg.c1MaxPoints = bandMax.c1Max;
        const c1 = taskData.c1 || {};

        // ── Deadline check ───────────────────────────────────────────────────────
        // Use officialDeadline if TL waived deduction on extension (new deadline)
        // else use task's original dueDate
        const officialDeadline = c1.officialDeadline || taskData.dueDate || taskData.fixedDeadline || null;
        // If no submittedAt recorded, use current time (TL approving now = effective submission time)
        const submittedAtDate = submittedAt ? new Date(submittedAt) : new Date();
        const deadlineDate = officialDeadline ? new Date(officialDeadline) : null;

        let deadlinesMissed = Number(c1.deadlinesMissed) || 0;
        if (deadlineDate && !isNaN(deadlineDate) && submittedAtDate > deadlineDate) {
            deadlinesMissed += 1;
        }

        const extensionsFiled = Number(c1.extensionsFiled) || 0;
        const reworksReceived = Number(c1.reworksReceived) || 0;
        const etcHours = Number(taskData.etcHours) || 0;
        const rejectionsReceived = Number(c1.rejectionsReceived) || 0;

        const taskScore = calculateTaskScore(cfg, { deadlinesMissed, extensionsFiled, reworksReceived, rejectionsReceived, isRejected });

        // ── Store score on task document ─────────────────────────────────────────
        const taskRef = db.collection("cowork_tasks").doc(taskId);
        await taskRef.update({
            "c1.taskScore": taskScore,
            "c1.deadlinesMissed": deadlinesMissed,
            "c1.extensionsFiled": extensionsFiled,
            "c1.reworksReceived": reworksReceived,
            "c1.rejectionsReceived": isRejected ? (rejectionsReceived + 1) : rejectionsReceived,
            "c1.c1Status": isRejected ? "rejected" : "completed",
            "c1.scoreCalculatedAt": new Date().toISOString(),
            "c1.isRejected": isRejected,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // ── Write C1 entries to SOP bleach history (always — reward + any deductions)
        if (employeeId) {
            setImmediate(() => _writeC1BleachEntries({
                employeeId,
                taskId,
                taskTitle: taskData.title || taskId,
                reviewerName: taskData.tlReview?.reviewedByName || taskData.ceoReview?.reviewedByName || "TL",
                reviewerId: taskData.tlReview?.reviewedBy || taskData.ceoReview?.reviewedBy || "",
                deadlinesMissed, extensionsFiled, reworksReceived, isRejected, cfg,
            }).catch(e => console.error("[c1 bleach]", e.message)));
        }

        // ── Update employee C1 score cache (non-blocking) ─────────────────────────
        if (employeeId && etcHours > 0) {
            setImmediate(() => _updateC1ScoreCache(employeeId, cfg).catch(e => console.error("[c1 cache]", e.message)));
        }

        return { taskScore, deadlinesMissed, extensionsFiled, reworksReceived, etcHours };
    } catch (e) {
        console.error("[computeAndStoreTaskScore]", e.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// _updateC1ScoreCache — recalculates and stores C1 aggregate for one employee
// ─────────────────────────────────────────────────────────────────────────────

async function _updateC1ScoreCache(employeeId, cfg) {
    if (!cfg) cfg = await getC1Config();
    // Band-specific C1 max
    const bandMax = await getBandMaxForEmployee(employeeId);
    if (bandMax?.c1Max) cfg = { ...cfg, c1MaxPoints: bandMax.c1Max };

    // Fetch all tasks assigned to this employee that have a c1 score
    const quarter = Math.ceil((new Date().getMonth() + 1) / 3);
    const year = new Date().getFullYear();
    const snap = await db.collection("cowork_tasks")
        .where("assigneeIds", "array-contains", employeeId)
        .where("c1.c1Status", "in", ["completed", "rejected"])
        .where("quarter", "==", quarter)
        .where("year", "==", year)
        .get();


    const tasks = snap.docs.map(d => d.data());
    const qualityRate = calculateQualityRate(tasks);
    const c1Net = calculateC1Net(qualityRate, cfg.c1MaxPoints);

    // Build task breakdown
    const taskBreakdown = {};
    tasks.filter(t => t.c1?.taskScore !== null && !t.c1?.isExcluded).forEach(t => {
        taskBreakdown[t.taskId] = {
            taskId: t.taskId,
            taskTitle: t.title || "",
            etcHours: Number(t.etcHours) || 0,
            taskScore: Number(t.c1.taskScore),
            deadlinesMissed: Number(t.c1.deadlinesMissed) || 0,
            extensionsFiled: Number(t.c1.extensionsFiled) || 0,
            reworksReceived: Number(t.c1.reworksReceived) || 0,
            c1Status: t.c1.c1Status,
            scoreCalculatedAt: t.c1.scoreCalculatedAt || null,
        };
    });

    await db.collection("cowork_c1_scores").doc(employeeId).set({
        employeeId,
        qualityRate: qualityRate,
        c1Net: c1Net,
        c1MaxPoints: cfg.c1MaxPoints,
        taskBreakdown,
        taskCount: tasks.filter(t => !t.c1?.isExcluded).length,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { qualityRate, c1Net };
}

// ─────────────────────────────────────────────────────────────────────────────
// markTaskCancelled — exclude cancelled tasks from C1
// ─────────────────────────────────────────────────────────────────────────────
async function markTaskCancelled(taskId) {
    try {
        await db.collection("cowork_tasks").doc(taskId).update({
            "c1.isExcluded": true,
            "c1.c1Status": "cancelled",
            "c1.taskScore": null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e) {
        console.error("[markTaskCancelled]", e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// writeReworkDeduction — called IMMEDIATELY when TL confirms rework
// Writes −0.2 (or whatever admin set) to SOP history right away
// ─────────────────────────────────────────────────────────────────────────────
async function writeReworkDeduction({ employeeId, taskId, taskTitle, reviewerId = "", reviewerName = "", reworkNumber }) {
    try {
        const cfg = await getC1Config();
        const pts = +Number(cfg.c1ReworkDeduction).toFixed(2);
        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return;
        const today = new Date().toISOString().split("T")[0];
        const year = new Date().getFullYear();
        const entry = {
            sopName: "C1 — Rework",
            type: "C1",
            folderName: taskTitle || taskId,
            points: pts,
            description: `Rework #${reworkNumber} · −${pts} pts · ${taskTitle || taskId}`,
            isC1: true, bleachType: "debit", isCredit: false,
            date: today, cutBy: reviewerId, cutByName: reviewerName, cutByRole: "tl",
            taskId, recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
        };
        if (!employee.sopPoints) employee.sopPoints = [];
        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(entry);
            employee.sopPoints[yearIndex].totalDeducted = +(employee.sopPoints[yearIndex].totalDeducted + pts).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: pts, bleaches: [entry] });
        }
        await employee.save();
        console.log(`[C1 rework] Wrote −${pts} pts for ${employeeId} on task ${taskId}`);
    } catch (e) {
        console.error("[writeReworkDeduction]", e.message);
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// writeExtensionDeduction — called IMMEDIATELY when TL confirms extension deduction
// ─────────────────────────────────────────────────────────────────────────────
async function writeExtensionDeduction({ employeeId, taskId, taskTitle, reviewerId, reviewerName }) {
    try {
        const cfg = await getC1Config();
        const pts = +Number(cfg.c1ExtensionDeduction).toFixed(2);
        const employee = await Employee.findOne({ biometricId: employeeId });
        if (!employee) return;
        const today = new Date().toISOString().split("T")[0];
        const year = new Date().getFullYear();
        const entry = {
            sopName: "C1 — Deadline Extension",
            type: "C1",
            folderName: taskTitle || taskId,
            points: pts,
            description: `Extension filed · −${pts} pts · ${taskTitle || taskId}`,
            isC1: true, bleachType: "debit", isCredit: false,
            date: today, cutBy: reviewerId, cutByName: reviewerName, cutByRole: "tl",
            taskId, recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
        };
        if (!employee.sopPoints) employee.sopPoints = [];
        const yearIndex = employee.sopPoints.findIndex(sp => sp.year === year);
        if (yearIndex >= 0) {
            employee.sopPoints[yearIndex].bleaches.push(entry);
            employee.sopPoints[yearIndex].totalDeducted = +(employee.sopPoints[yearIndex].totalDeducted + pts).toFixed(2);
        } else {
            employee.sopPoints.push({ year, totalDeducted: pts, bleaches: [entry] });
        }
        await employee.save();
        console.log(`[C1 extension] Wrote −${pts} pts for ${employeeId} on task ${taskId}`);
    } catch (e) {
        console.error("[writeExtensionDeduction]", e.message);
    }
}

module.exports = {
    getC1Config,
    calculateTaskScore,
    calculateQualityRate,
    calculateC1Net,
    computeAndStoreTaskScore,
    markTaskCancelled,
    writeReworkDeduction,
    writeExtensionDeduction,
    C1_DEFAULTS,
};