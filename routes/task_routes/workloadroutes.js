"use strict";
/**
 * workloadroutes.js — Employee Workload Summary
 * Mount in server.js: app.use("/cowork", require("./routes/task_routes/workloadroutes"));
 *
 * GET /cowork/workload/summary
 *   CEO  → all employees (excluding E000)
 *   TL   → only employees in TL's own department
 */

const express = require("express");
const router = express.Router();
const { db } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyCeoOrTL } = require("../../Middlewear/coworkAuth");

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;
const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

// ── Always fetch from Firestore — never hardcode ──────────────────────────────
async function getOfficeSchedule() {
    const snap = await db.collection("cowork_settings").doc("office").get();
    if (!snap.exists || !snap.data().schedule) {
        throw new Error("Office schedule not set. Configure it in Task Settings first.");
    }
    return snap.data().schedule;
}

// "09:30" → minutes from midnight
function parseMins(t) {
    if (!t) return 0;
    const [h, m] = t.split(":").map(Number);
    return h * 60 + (m || 0);
}

// Office hours between now and dueDate using real schedule
function calcOfficeHours(now, dueDateStr, schedule) {
    const end = new Date(dueDateStr);
    if (end <= now) return { hours: 0, overdue: true };

    let totalMins = 0;
    const cursor = new Date(now);

    while (cursor < end) {
        const dayKey = DAY_KEYS[cursor.getDay()];
        const day = schedule[dayKey];

        if (day && !day.isOff) {
            const inMins = parseMins(day.inTime);
            const outMins = parseMins(day.outTime);

            const dayStart = new Date(cursor);
            dayStart.setHours(Math.floor(inMins / 60), inMins % 60, 0, 0);

            const dayEnd = new Date(cursor);
            dayEnd.setHours(Math.floor(outMins / 60), outMins % 60, 0, 0);

            const winStart = new Date(Math.max(now.getTime(), dayStart.getTime()));
            const winEnd = new Date(Math.min(end.getTime(), dayEnd.getTime()));

            if (winEnd > winStart) {
                totalMins += (winEnd.getTime() - winStart.getTime()) / 60000;
            }
        }

        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
    }

    return { hours: +(totalMins / 60).toFixed(1), overdue: false };
}

// Hours priority:
//  1. deadlineWindowSecs  — final negotiated timer
//  2. senderTimerWindowSecs — CEO/TL preset
//  3. etcHours            — manual estimate
//  4. dueDate             — office hours remaining until deadline

function getTaskHours(task, now, schedule) {
    let timerHours = 0;

    if (Number(task.deadlineWindowSecs) > 0)
        timerHours = +(Number(task.deadlineWindowSecs) / 3600).toFixed(1);
    else if (Number(task.senderTimerWindowSecs) > 0)
        timerHours = +(Number(task.senderTimerWindowSecs) / 3600).toFixed(1);
    else if (Number(task.etcHours) > 0)
        timerHours = +Number(task.etcHours).toFixed(1);

    // Task is overdue (dueDate in past)
    if (task.dueDate && new Date(task.dueDate) <= now) {
        if (timerHours > 0) {
            // Has timer — show timer hours + overdue
            return { hours: timerHours, overdue: true };
        }
        // No timer — calculate office hrs from createdAt → dueDate
        const createdAt = task.createdAt
            ? new Date(task.createdAt)
            : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // fallback 7 days ago
        const { hours } = calcOfficeHours(createdAt, task.dueDate, schedule);
        return { hours, overdue: true };
    }

    // Not overdue
    if (timerHours > 0) return { hours: timerHours, overdue: false };
    if (task.dueDate) return calcOfficeHours(now, task.dueDate, schedule);

    return { hours: 0, overdue: false };
}

// ── Main route ────────────────────────────────────────────────────────────────
router.get("/workload/summary", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeData } = req.coworkUser;
        const tlDepartment = employeeData?.department || null;

        // Fetch office schedule — throws if not configured
        const schedule = await getOfficeSchedule();
        const now = new Date();

        // 1. Fetch employees
        const empSnap = await db.collection("cowork_employees").get();
        let employees = empSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(e => e.employeeId !== "E000");

        if (role === "tl" && tlDepartment) {
            employees = employees.filter(e => e.department === tlDepartment);
        }

        if (employees.length === 0) return res.json({ success: true, employees: [] });

        // 2. Fetch all active tasks
        const tasksSnap = await db.collection("cowork_tasks")
            .where("status", "in", ["open", "in_progress"])
            .get();

        const allTasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));

        // 3. Group by assignee only (exclude created-by)
        const employeeIdSet = new Set(employees.map(e => e.employeeId));
        const tasksByEmployee = {};
        employees.forEach(e => { tasksByEmployee[e.employeeId] = []; });

        allTasks.forEach(task => {
            (task.assigneeIds || []).forEach(eid => {
                if (employeeIdSet.has(eid)) tasksByEmployee[eid].push(task);
            });
        });

        // 4. Aggregate per employee
        const result = employees.map(emp => {
            const tasks = tasksByEmployee[emp.employeeId] || [];
            const c1Tasks = tasks.filter(t => !t.isGoldTask);
            const c2Tasks = tasks.filter(t => t.isGoldTask === true);

            const c1Details = c1Tasks.map(t => {
                const { hours, overdue } = getTaskHours(t, now, schedule);
                return {
                    taskId: t.taskId,
                    title: t.title || "",
                    hours,
                    overdue,
                    dueDate: t.dueDate || null,
                    status: t.status,
                };
            });

            // Overdue tasks shown for info only — excluded from total workload
            const totalHours = +c1Details
                .filter(t => !t.overdue)
                .reduce((s, t) => s + t.hours, 0)
                .toFixed(1);

            const c2Details = c2Tasks.map(t => {
                const msLeft = t.dueDate ? (new Date(t.dueDate).getTime() - now) : 0;
                return {
                    taskId: t.taskId,
                    title: t.title || "",
                    monthsLeft: Math.max(0, Math.ceil(msLeft / MS_PER_MONTH)),
                    dueDate: t.dueDate || null,
                    status: t.status,
                };
            });

            return {
                employeeId: emp.employeeId,
                name: emp.name || "",
                department: emp.department || "—",
                role: emp.role || "employee",
                profilePicUrl: emp.profilePicUrl || null,
                totalHours,
                c1Count: c1Tasks.length,
                c2Count: c2Tasks.length,
                totalC2Months: c2Details.reduce((s, t) => s + t.monthsLeft, 0),
                c1Tasks: c1Details,
                c2Tasks: c2Details,
            };
        });

        result.sort((a, b) => b.totalHours - a.totalHours);
        res.json({ success: true, employees: result });

    } catch (e) {
        console.error("[workload/summary]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;