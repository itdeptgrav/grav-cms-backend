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

// ── 2-min cache for workload summary ─────────────────────────────────────────
const _wlCache = new Map();
const WL_TTL = 2 * 60 * 1000;
function _getWL(key) {
    const e = _wlCache.get(key);
    if (!e || Date.now() > e.exp) { _wlCache.delete(key); return null; }
    return e.data;
}
function _setWL(key, data) { _wlCache.set(key, { data, exp: Date.now() + WL_TTL }); }

// ── Always fetch from Firestore — never hardcode ──────────────────────────────
async function getOfficeSchedule() {
    const snap = await db.collection("cowork_settings").doc("office").get();
    if (!snap.exists || !snap.data().schedule) {
        return null; // no schedule configured — hours will show as 0
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

    const deadline = task.dueDate || task.fixedDeadline || null;

    // No schedule configured — fall back to timer/etc hours only
    if (!schedule) {
        const overdue = deadline ? new Date(deadline) <= now : false;
        return { hours: timerHours, overdue };
    }

    // Task is overdue (deadline in past)
    if (deadline && new Date(deadline) <= now) {
        if (timerHours > 0) {
            return { hours: timerHours, overdue: true };
        }
        const createdAt = task.createdAt
            ? new Date(task.createdAt)
            : new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        const { hours } = calcOfficeHours(createdAt, deadline, schedule);
        return { hours, overdue: true };
    }

    // Not overdue
    if (timerHours > 0) return { hours: timerHours, overdue: false };
    if (deadline) return calcOfficeHours(now, deadline, schedule);

    return { hours: 0, overdue: false };
}

// Reverse of calcOfficeHours — given start + hours, returns end datetime
function addOfficeHours(startDate, hoursToAdd, schedule) {
    if (!hoursToAdd || hoursToAdd <= 0) return new Date(startDate);
    let minsLeft = hoursToAdd * 60;
    const cursor = new Date(startDate);

    while (minsLeft > 0) {
        const dayKey = DAY_KEYS[cursor.getDay()];
        const day = schedule[dayKey];

        if (day && !day.isOff) {
            const inMins = parseMins(day.inTime);
            const outMins = parseMins(day.outTime);

            const dayStart = new Date(cursor);
            dayStart.setHours(Math.floor(inMins / 60), inMins % 60, 0, 0);

            const dayEnd = new Date(cursor);
            dayEnd.setHours(Math.floor(outMins / 60), outMins % 60, 0, 0);

            const pos = new Date(Math.max(cursor.getTime(), dayStart.getTime()));
            if (pos < dayEnd) {
                const availMins = (dayEnd.getTime() - pos.getTime()) / 60000;
                if (availMins >= minsLeft) {
                    return new Date(pos.getTime() + minsLeft * 60000);
                }
                minsLeft -= availMins;
            }
        }
        cursor.setDate(cursor.getDate() + 1);
        cursor.setHours(0, 0, 0, 0);
    }
    return cursor;
}

// ── Main route ────────────────────────────────────────────────────────────────
router.get("/workload/summary", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { role, employeeData } = req.coworkUser;
        const tlDepartment = employeeData?.department || null;

        // ── Cache check ───────────────────────────────────────────────────────
        const cacheKey = `${role}_${tlDepartment || "all"}`;
        const cached = _getWL(cacheKey);
        if (cached) return res.json(cached);

        // Fetch office schedule — null if not configured (hours default to 0)
        const schedule = await getOfficeSchedule();
        if (!schedule) return res.json({ success: true, employees: [], scheduleNotSet: true });
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

        // 2. Fetch all active + pending-review tasks
        const tasksSnap = await db.collection("cowork_tasks")
            .where("status", "in", ["open", "in_progress", "done"])
            .get();

        // Hide only when fully approved — everything else stays visible
        const APPROVED = ["tl_final_approved", "ceo_approved"];
        const allTasks = tasksSnap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(t => !APPROVED.includes(t.completionStatus));

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
        const response = { success: true, employees: result };
        _setWL(cacheKey, response);
        res.json(response);

    } catch (e) {
        console.error("[workload/summary]", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ── Per-employee calendar route ───────────────────────────────────────────────
router.get("/workload/employee/:employeeId/calendar", verifyCoworkToken, verifyCeoOrTL, async (req, res) => {
    try {
        const { employeeId } = req.params;

        const empSnap = await db.collection("cowork_employees")
            .where("employeeId", "==", employeeId).limit(1).get();
        if (empSnap.empty) return res.status(404).json({ error: "Employee not found" });
        const empData = empSnap.docs[0].data();

        const schedule = await getOfficeSchedule();

        const tasksSnap = await db.collection("cowork_tasks")
            .where("assigneeIds", "array-contains", employeeId)
            .where("status", "in", ["open", "in_progress", "done"])
            .get();

        const APPROVED = ["tl_final_approved", "ceo_approved"];
        const tasks = tasksSnap.docs
            .map(d => d.data())
            .filter(t => !APPROVED.includes(t.completionStatus))
            .sort((a, b) => new Date(a.createdAtISO || a.createdAt || 0) - new Date(b.createdAtISO || b.createdAt || 0));

        let chainEnd = null;
        const scheduled = tasks.map(t => {
            const createdAt = t.createdAtISO
                ? new Date(t.createdAtISO)
                : t.createdAt?.toDate
                    ? t.createdAt.toDate()
                    : t.createdAt?._seconds
                        ? new Date(t.createdAt._seconds * 1000)
                        : new Date();
            const startTime = (chainEnd && chainEnd > createdAt) ? new Date(chainEnd) : createdAt;

            // Fixed deadline task → end time IS the fixedDeadline
            // Timer task → calculate end from deadlineWindowSecs / senderTimerWindowSecs / etcHours
            let etcHours = 0;
            let endTime;

            if (t.hasTimer === false && t.fixedDeadline) {
                // Fixed deadline — use deadline directly as end time
                endTime = new Date(t.fixedDeadline);
                etcHours = schedule
                    ? calcOfficeHours(startTime, t.fixedDeadline, schedule).hours
                    : +((endTime - startTime) / 3600000).toFixed(1);
            } else {
                if (Number(t.deadlineWindowSecs) > 0)
                    etcHours = +(Number(t.deadlineWindowSecs) / 3600).toFixed(1);
                else if (Number(t.senderTimerWindowSecs) > 0)
                    etcHours = +(Number(t.senderTimerWindowSecs) / 3600).toFixed(1);
                else if (Number(t.etcHours) > 0)
                    etcHours = +Number(t.etcHours).toFixed(1);

                endTime = (schedule && etcHours > 0)
                    ? addOfficeHours(startTime, etcHours, schedule)
                    : new Date(startTime.getTime() + etcHours * 3600000);
            }

            const overlap = !!(chainEnd && chainEnd > createdAt);
            chainEnd = endTime;
            return {
                taskId: t.taskId,
                title: t.title || "",
                isGoldTask: t.isGoldTask === true,
                etcHours,
                startTime: startTime.toISOString(),
                endTime: endTime.toISOString(),
                createdAt: createdAt.toISOString(),
                status: t.status,
                overlap,
                overlapsWith: [],
            };
        });

        // Mark overlapping pairs
        for (let i = 0; i < scheduled.length; i++) {
            for (let j = i + 1; j < scheduled.length; j++) {
                const a = scheduled[i], b = scheduled[j];
                if (new Date(a.startTime) < new Date(b.endTime) &&
                    new Date(a.endTime) > new Date(b.startTime)) {
                    a.overlap = true; b.overlap = true;
                    if (!a.overlapsWith.includes(b.taskId)) a.overlapsWith.push(b.taskId);
                    if (!b.overlapsWith.includes(a.taskId)) b.overlapsWith.push(a.taskId);
                }
            }
        }

        res.json({
            success: true,
            employee: {
                employeeId: empData.employeeId,
                name: empData.name || "",
                department: empData.department || "—",
                role: empData.role || "employee",
            },
            tasks: scheduled,
            scheduleConfigured: !!schedule,
        });
    } catch (e) {
        console.error("[workload/employee/calendar]", e.message);
        res.status(500).json({ error: e.message });
    }
});

module.exports = router;