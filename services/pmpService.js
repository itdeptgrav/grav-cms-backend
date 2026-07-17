"use strict";
/**
 * pmpService.js — PMP Score Calculation Engine
 *
 * Handles: C1, C2, C3, C4 (real %, via C4Config + DailyAttendance), Pace/Base
 * Score, Annual, Projected, Gap, Flags.
 *
 * PDF Reference: CW-DEV-PMP-01 v1.0 June 2026
 */

const { db, admin } = require("../config/firebaseAdmin");
const { getBandMaxForEmployee } = require("../models/BandConfig");
const c1Svc = require("./c1Service");
const Employee = require("../models/Employee");
const C4Config = require("../models/HR_Models/C4Config");
const DailyAttendance = require("../models/HR_Models/Dailyattendance");


// ── Quarter weights (PDF Section 03) ─────────────────────────────────────────
const QUARTER_WEIGHTS = { 1: 0.10, 2: 0.20, 3: 0.30, 4: 0.40 };

// ─────────────────────────────────────────────────────────────────────────────
// SMALL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Returns current quarter 1–4 from a JS Date */
function getQuarterFromDate(date = new Date()) {
    return Math.ceil((new Date(date).getMonth() + 1) / 3);
}

/** Returns current 4-digit year */
function getCurrentYear() {
    return new Date().getFullYear();
}

/** Returns day number within the current quarter (1–90) */
function getDayInQuarter(date = new Date()) {
    const d = new Date(date);
    const q = getQuarterFromDate(d);
    const qStart = new Date(d.getFullYear(), (q - 1) * 3, 1);
    return Math.ceil((d - qStart) / (1000 * 60 * 60 * 24)) + 1;
}

/**
 * getRating — maps a numeric score to label + design tokens
 * Matches PDF rating scale exactly
 */
function getRating(score) {
    if (score === null || score === undefined)
        return { label: "—", color: "#999999", bgColor: "#1E1E1E", class: "none" };
    if (score >= 95)
        return { label: "Exceptional", color: "#7F77DD", bgColor: "#1a1833", class: "exceptional" };
    if (score >= 85)
        return { label: "Strong", color: "#5BA3F5", bgColor: "#0d1f33", class: "strong" };
    if (score >= 70)
        return { label: "Solid", color: "#1D9E75", bgColor: "#0a1f18", class: "solid" };
    if (score >= 50)
        return { label: "Developing", color: "#EF9F27", bgColor: "#2a1f00", class: "developing" };
    return { label: "Critical", color: "#E24B4A", bgColor: "#2a0f0f", class: "critical" };
}

// ─────────────────────────────────────────────────────────────────────────────
// C1 — PER QUARTER
// PDF: Quality Rate = MAX(Σ(score × ETC) ÷ Σ(ETC), 0)
//      C1 Net       = Quality Rate × C1_max
// Only tasks with quarter+year match AND c1Status completed/rejected included.
// Cancelled tasks (isExcluded) and tasks with etcHours=0 are excluded.
// Returns null if no eligible closed tasks exist yet.
// ─────────────────────────────────────────────────────────────────────────────

async function computeC1ForQuarter(employeeId, quarter, year) {
    const cfg = await c1Svc.getC1Config();
    const bandMax = await getBandMaxForEmployee(employeeId);
    const c1Max = bandMax?.c1Max || cfg.c1MaxPoints || 50;

    const snap = await db.collection("cowork_tasks")
        .where("assigneeIds", "array-contains", employeeId)
        .where("c1.c1Status", "in", ["completed", "rejected"])
        .get();

    const tasks = snap.docs
        .map(d => d.data())
        .filter(t => {
            if (t.c1?.isExcluded) return false;

            // Quarter filter
            if (t.quarter && t.year) {
                return t.quarter === Number(quarter) && t.year === Number(year);
            }
            const createdDate = t.createdAtISO
                ? new Date(t.createdAtISO)
                : t.createdAt?.seconds
                    ? new Date(t.createdAt.seconds * 1000)
                    : null;
            if (!createdDate) return false;
            const taskQ = Math.ceil((createdDate.getMonth() + 1) / 3);
            const taskY = createdDate.getFullYear();
            return taskQ === Number(quarter) && taskY === Number(year);
        });

    if (tasks.length === 0) {
        return { c1Net: null, qualityRate: null, c1Max, taskCount: 0, tasks: [] };
    }

    // ── Hours priority: etcHours → deadlineWindowSecs → senderTimerWindowSecs → 1 (equal weight)
    const getHours = (t) => {
        if (Number(t.etcHours) > 0) return Number(t.etcHours);
        if (Number(t.deadlineWindowSecs) > 0) return Number(t.deadlineWindowSecs) / 3600;
        if (Number(t.senderTimerWindowSecs) > 0) return Number(t.senderTimerWindowSecs) / 3600;
        return 1; // equal weight fallback — task counts but with neutral weight
    };

    const numerator = tasks.reduce((s, t) => s + Number(t.c1.taskScore), 0);
    const denominator = tasks.length;
    const qualityRate = denominator > 0 ? Math.max(numerator / denominator, 0) : 0;
    const c1Net = +(qualityRate * 100).toFixed(2); // 0-100%, per PDF — no longer scaled to band c1Max


    return {
        c1Net,
        qualityRate: +qualityRate.toFixed(4),
        c1Max,
        taskCount: tasks.length,
        tasks: tasks.map(t => ({
            taskId: t.taskId,
            title: t.title || "",
            etcHours: getHours(t),
            taskScore: Number(t.c1.taskScore),
            deadlinesMissed: Number(t.c1.deadlinesMissed) || 0,
            extensionsFiled: Number(t.c1.extensionsFiled) || 0,
            reworksReceived: Number(t.c1.reworksReceived) || 0,
            c1Status: t.c1.c1Status,
            isRejected: t.c1.isRejected || false,
        })),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 — RUNNING (Gold Tasks are annual goals — not per quarter)
// PDF: pts_earned         = sum of points from completed gold tasks
//      pts_past_deadline  = sum of points from tasks whose deadline passed
//                           OR tasks already completed (early completion counts)
//      C2 Score = pts_earned / pts_past_deadline
//      C2 Net   = C2 Score × C2_max
// Returns null if nothing is measurable yet (no deadlines passed, none done).
// ─────────────────────────────────────────────────────────────────────────────

async function computeC2ForEmployee(employeeId) {
    const bandMax = await getBandMaxForEmployee(employeeId);
    const settingsSnap = await db.collection("cowork_sop_settings").doc("task_events").get();
    const globalMax = settingsSnap.exists ? Number(settingsSnap.data().c2GlobalMaxPoints) || 0 : 0;
    const c2Max = bandMax?.c2Max || globalMax || 50;

    const snap = await db.collection("cowork_tasks")
        .where("assigneeIds", "array-contains", employeeId)
        .where("isGoldTask", "==", true)
        .get();

    const now = Date.now();
    const tasks = snap.docs.map(d => d.data()).filter(t => t.status !== "cancelled");

    let ptsEarned = 0;
    let ptsAssigned = 0;      // PDF denominator — every assigned goal point, deadline irrelevant
    let ptsPastDeadline = 0;  // unchanged — kept for API compatibility, no live consumer now
    const taskBreakdown = [];

    tasks.forEach(t => {
        const maxPts = Number(t.c2Config?.taskMaxPoints) || 0;
        const activities = t.goalActivities || [];
        const isDone = t.status === "done";

        // ── GUARD 1: No components → fallback to task-level binary ───────────────
        if (activities.length === 0) {
            const dueDate = t.dueDate || t.fixedDeadline || null;
            const isDeadlinePast = dueDate ? new Date(dueDate).getTime() <= now : false;
            ptsAssigned += maxPts; // assigned counts immediately, regardless of deadline
            if (isDeadlinePast || isDone) ptsPastDeadline += maxPts;
            if (isDone) ptsEarned += maxPts;
            taskBreakdown.push({
                taskId: t.taskId, title: t.title || "",
                maxPts, weightagePercent: t.c2Config?.weightagePercent || 0,
                dueDate: dueDate || null, status: t.status,
                isDone, earned: isDone ? maxPts : 0,
                components: [],
            });
            return;
        }

        // ── Component-level scoring ───────────────────────────────────────────────
        let taskEarned = 0;
        let taskMeasurable = 0;
        let taskAssigned = 0;
        const compBreakdown = [];
        activities.forEach(comp => {
            // ── GUARD 2: missing comp.points → treat as 0 ─────────────────────────
            const pts = Number(comp.points) || 0;

            // ── GUARD 3: multi-user → use perUserStatus, fallback to comp-level ───
            const userStatus = (t.isMultiUserGold && comp.perUserStatus?.[employeeId])
                ? comp.perUserStatus[employeeId]
                : { status: comp.status, lateSubmission: comp.lateSubmission };

            const compDone = userStatus?.status === "done";
            const compLate = userStatus?.lateSubmission === true;
            const compDeadlinePast = comp.deadline
                ? new Date(comp.deadline).getTime() <= now
                : false;

            taskAssigned += pts; // assigned counts immediately, regardless of deadline

            // Measurable = comp deadline passed OR already completed early
            const measurable = compDeadlinePast || compDone; if (measurable) taskMeasurable += pts;

            // Earned = done AND not late
            const earned = (compDone && !compLate) ? pts : 0;
            taskEarned += earned;

            compBreakdown.push({
                heading: comp.heading || "",
                pts,
                deadline: comp.deadline || null,
                status: userStatus?.status || "pending",
                isLate: compLate,
                measurable,
                earned,
            });
        });

        ptsEarned += taskEarned;
        ptsPastDeadline += taskMeasurable;
        ptsAssigned += taskAssigned;

        taskBreakdown.push({
            taskId: t.taskId,
            title: t.title || "",
            maxPts,
            weightagePercent: t.c2Config?.weightagePercent || 0,
            status: t.status,
            isDone,
            earned: +taskEarned.toFixed(2),
            measurable: +taskMeasurable.toFixed(2),
            components: compBreakdown,
        });
    });

    if (ptsAssigned === 0) {
        return {
            c2Net: null, c2Score: null,
            ptsEarned: 0, ptsAssigned: 0, ptsPastDeadline: 0,
            c2Max, taskCount: tasks.length, tasks: taskBreakdown,
        };
    }

    const c2Score = ptsEarned / ptsAssigned; // PDF: earned / total assigned, deadline irrelevant
    const c2Net = +(c2Score * 100).toFixed(2); // 0-100%, per PDF

    return {
        c2Net,
        c2Score: +c2Score.toFixed(4),
        ptsEarned: +ptsEarned.toFixed(2),
        ptsAssigned: +ptsAssigned.toFixed(2),
        ptsPastDeadline: +ptsPastDeadline.toFixed(2),
        c2Max,
        taskCount: tasks.length,
        tasks: taskBreakdown,
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// PACE SCORE — PRIMARY METRIC
// PDF: Pace = (C1 + C2_pts_earned + C3 + C4) ÷ (C1_max + C2_pts_past_deadline) × 100
//
// CRITICAL: numerator uses C2_pts_earned (raw), NOT C2_net.
//           Using C2_net causes pace > 100% when hit rate is high. (PDF bug note)
// Returns null if nothing is measurable yet.
// ─────────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────────
// computeC3ForEmployee — reads C3 conduct breach deductions from MongoDB
// ─────────────────────────────────────────────────────────────────────────────
async function computeC3ForEmployee(employeeId, quarter, year) {
    const emp = await Employee.findOne({ biometricId: employeeId }).lean();
    if (!emp) return { c3Net: 0, totalDeductions: 0, breachCount: 0, breaches: [] };

    const yearData = emp.sopPoints?.find(sp => sp.year === year);
    if (!yearData) return { c3Net: 0, totalDeductions: 0, breachCount: 0, breaches: [] };

    const qStartMonth = (quarter - 1) * 3 + 1;
    const qEndMonth = qStartMonth + 2;

    let totalDeductions = 0;
    let breachCount = 0;
    const breaches = [];

    yearData.bleaches.forEach(b => {
        if (b.type !== "C3") return; // only conduct breaches
        if (b.bleachType !== "credit") return; // only penalties
        if (b.recheck?.status === "confirmed") return; // skip reversed entries
        if (!b.date) return;

        const month = parseInt(b.date.slice(5, 7), 10);
        if (month < qStartMonth || month > qEndMonth) return;

        totalDeductions = +(totalDeductions + Number(b.points)).toFixed(2);
        breachCount++;
        breaches.push({
            sopName: b.sopName,
            points: b.points,
            date: b.date,
            cutByName: b.cutByName,
        });
    });

    return {
        c3Net: +(0 - totalDeductions).toFixed(2),
        totalDeductions,
        breachCount,
        breaches,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// C4 — quarter-total attendance percentage.
// Base Points = workingDayCount × basePointsPerDay (dynamic, from C4Config).
// Penalty     = sum of every day's penalty this quarter (absent/late/early-
//               departure, flat points from C4Config) — summed straight,
//               not capped per day.
// Final Points = Base Points − Penalty.
// C4%          = (Final Points ÷ Base Points) × 100.
// A day counts as "working" unless its effective status is listed in
// C4Config.nonWorkingStatuses (default just "WO").
// Returns c4Net: null if there were no working days at all this quarter.
// ─────────────────────────────────────────────────────────────────────────────
async function computeC4ForEmployee(employeeId, quarter, year) {
    const cfg = await C4Config.getSingleton();
    const basePoints = Number(cfg.basePointsPerDay) || 0;
    const nonWorking = new Set(cfg.nonWorkingStatuses || ["WO"]);
    const lateThreshold = Number(cfg.lateThresholdMins) || 0;
    const earlyThreshold = Number(cfg.earlyThresholdMins) || 0;

    const qStartMonth = (quarter - 1) * 3 + 1;
    const qEndMonth = qStartMonth + 2;
    const pad = n => String(n).padStart(2, "0");
    const qStartDateStr = `${year}-${pad(qStartMonth)}-01`;
    const qEndDay = new Date(year, qEndMonth, 0).getDate();
    const qEndDateStr = `${year}-${pad(qEndMonth)}-${pad(qEndDay)}`;

    const days = await DailyAttendance.find(
        { dateStr: { $gte: qStartDateStr, $lte: qEndDateStr }, "employees.biometricId": employeeId },
        { dateStr: 1, "employees.$": 1 },
    ).lean();

    let workingDayCount = 0;
    let totalPenalty = 0;
    const breaches = [];

    for (const doc of days) {
        const entry = doc.employees?.[0];
        if (!entry) continue;

        const effStatus = entry.hrFinalStatus || entry.systemPrediction;
        if (nonWorking.has(effStatus)) continue;

        workingDayCount++;

        let penalty = 0;
        const reasons = [];
        if (effStatus === "AB") {
            penalty += Number(cfg.absencePoints) || 0;
            reasons.push("absent");
        } else {
            if (entry.isLate && entry.lateMins > lateThreshold) {
                penalty += Number(cfg.lateArrivalPoints) || 0;
                reasons.push(`late (${entry.lateMins}min)`);
            }
            if (entry.isEarlyDeparture && entry.earlyDepartureMins > earlyThreshold) {
                penalty += Number(cfg.earlyDeparturePoints) || 0;
                reasons.push(`early departure (${entry.earlyDepartureMins}min)`);
            }
        }

        totalPenalty += penalty;
        if (reasons.length > 0) {
            breaches.push({ date: doc.dateStr, status: effStatus, reasons: reasons.join(", "), penalty });
        }
    }

    if (workingDayCount === 0) {
        return { c4Net: null, workingDays: 0, totalBasePoints: 0, totalPenalty: 0, finalPoints: 0, breachCount: breaches.length, breaches };
    }

    const totalBasePoints = +(workingDayCount * basePoints).toFixed(4);
    const finalPoints = +(totalBasePoints - totalPenalty).toFixed(4);
    const c4Net = totalBasePoints > 0 ? +((finalPoints / totalBasePoints) * 100).toFixed(2) : null;

    return { c4Net, workingDays: workingDayCount, totalBasePoints, totalPenalty: +totalPenalty.toFixed(4), finalPoints, breachCount: breaches.length, breaches };
}

// ─────────────────────────────────────────────────────────────────────────────
// getSOPBreakdown — sums SOP bleach pts by band type for a specific quarter
// ─────────────────────────────────────────────────────────────────────────────
async function getSOPBreakdown(employeeId, quarter, year) {
    const emp = await Employee.findOne({ biometricId: employeeId }).lean();
    const yearData = emp?.sopPoints?.find(sp => sp.year === year);
    if (!yearData) return { c1: 0, c2: 0, c3: 0, c4: 0 };

    const qStartMonth = (quarter - 1) * 3 + 1;
    const qEndMonth = qStartMonth + 2;

    const totals = { c1: 0, c2: 0, c3: 0, c4: 0 };

    yearData.bleaches.forEach(b => {
        if (b.recheck?.status === "confirmed") return;
        if (!b.date) return;

        // Filter by quarter
        const entryYear = parseInt(b.date.slice(0, 4), 10);
        const entryMonth = parseInt(b.date.slice(5, 7), 10);
        if (entryYear !== year) return;
        if (entryMonth < qStartMonth || entryMonth > qEndMonth) return;

        const pts = Number(b.points) || 0;
        const delta = b.isCredit ? +pts : -pts;

        const key = (b.type || "").toLowerCase();

        if (key === "c1") totals.c1 = +(totals.c1 + delta).toFixed(2);
        else if (key === "c2") totals.c2 = +(totals.c2 + delta).toFixed(2);
        else if (key === "c3") totals.c3 = +(totals.c3 + delta).toFixed(2);
        else if (key === "c4") totals.c4 = +(totals.c4 + delta).toFixed(2);
    });

    return totals;
}

function computeBaseScore({ c1Net, c2Net, c4Net, c3 = 0 }) {
    const components = [c1Net, c2Net, c4Net].filter(v => v !== null && v !== undefined);
    const avg = components.length > 0
        ? components.reduce((s, v) => s + v, 0) / components.length
        : 0;
    if (components.length === 0 && (c3 || 0) === 0) return null;
    return +(avg + (c3 || 0)).toFixed(2);
}


function computePaceScore({ c1Net, c2Net, c4Net, c3 = 0 }) {
    return computeBaseScore({ c1Net, c2Net, c4Net, c3 });
}

function computeQuarterScore({ c1Net, c2Net, c4Net, c3 = 0 }) {
    return computeBaseScore({ c1Net, c2Net, c4Net, c3 });
}

// ─────────────────────────────────────────────────────────────────────────────
// ANNUAL SCORES — Live + Projected// PDF: Annual = (Q1×10% + Q2×20% + Q3×30% + Q4×40%) ÷ weights_used
//      Only STARTED quarters included — future quarters EXCLUDED.
// ─────────────────────────────────────────────────────────────────────────────
async function computeAnnualScores(employeeId, year) {
    const currentQ = getQuarterFromDate();
    const currentYear = getCurrentYear();

    if (Number(year) !== currentYear) {
        return { liveAnnual: null, projectedAnnual: null, quarters: [] };
    }

    // C2 is running total — same across all quarters
    const c2Data = await computeC2ForEmployee(employeeId);
    const dayInQ = getDayInQuarter();

    let liveSum = 0;
    let projSum = 0;
    let weightUsed = 0;
    const quarters = [];

    for (let q = 1; q <= 4; q++) {
        const weight = QUARTER_WEIGHTS[q];

        if (q > currentQ) {
            // Future quarter — not started
            quarters.push({ quarter: q, score: null, status: "future", weight });
            continue;
        }

        const c1Data = await computeC1ForQuarter(employeeId, q, year);
        const c3Data = await computeC3ForEmployee(employeeId, q, year);
        const c4Data = await computeC4ForEmployee(employeeId, q, year);
        const rawScore = computeQuarterScore({
            c1Net: c1Data.c1Net,
            c2Net: c2Data.c2Net,
            c4Net: c4Data.c4Net,
            c3: c3Data.c3Net,
        });

        weightUsed += weight;

        if (q < currentQ) {
            liveSum += rawScore * weight;
            projSum += rawScore * weight;
            quarters.push({
                quarter: q, score: rawScore, status: "closed", weight,
                c1: c1Data.c1Net, c2: c2Data.c2Net, c3: c3Data.c3Net, c4: c4Data.c4Net,
            });
        } else {
            liveSum += rawScore * weight;

            const projScore = computeQuarterScore({
                c1Net: c1Data.c1Net,
                c2Net: c2Data.c2Net,
                c4Net: c4Data.c4Net,
                c3: c3Data.c3Net,
            });
            projSum += projScore * weight;

            quarters.push({
                quarter: q, score: rawScore, projectedScore: projScore,
                status: "live", weight, dayInQuarter: dayInQ,
                c1: c1Data.c1Net, c2: c2Data.c2Net, c3: c3Data.c3Net, c4: c4Data.c4Net,
            });
        }
    }


    const liveAnnual = weightUsed > 0 ? +((liveSum / weightUsed)).toFixed(2) : null;
    const projectedAnnual = weightUsed > 0 ? +((projSum / weightUsed)).toFixed(2) : null;

    return { liveAnnual, projectedAnnual, quarters };
}

// ─────────────────────────────────────────────────────────────────────────────
// GAP TO NEXT RATING
// PDF Section 05
// ─────────────────────────────────────────────────────────────────────────────
function computeGapToNextRating(liveAnnual) {
    if (liveAnnual === null)
        return { gap: null, nextRating: "—", nextThreshold: null };
    if (liveAnnual >= 95)
        return { gap: 0, nextRating: "Exceptional achieved", nextThreshold: null };
    if (liveAnnual >= 85)
        return { gap: +(95 - liveAnnual).toFixed(2), nextRating: "Exceptional", nextThreshold: 95 };
    if (liveAnnual >= 70)
        return { gap: +(85 - liveAnnual).toFixed(2), nextRating: "Strong", nextThreshold: 85 };
    if (liveAnnual >= 50)
        return { gap: +(70 - liveAnnual).toFixed(2), nextRating: "Solid", nextThreshold: 70 };
    return { gap: +(50 - liveAnnual).toFixed(2), nextRating: "Developing", nextThreshold: 50 };
}

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD FLAGS
// PDF Section 09 — all flags that apply shown simultaneously
// ─────────────────────────────────────────────────────────────────────────────
function computeFlags({ pace, dayInQuarter, c2HitRate, liveAnnual }) {
    const flags = [];

    if (pace !== null && dayInQuarter >= 30) {
        if (pace < 30)
            flags.push({ key: "PACE-CRITICAL", label: "⚠ PACE-CRITICAL", type: "critical" });
        else if (pace < 60)
            flags.push({ key: "PACE-WARNING", label: "⚠ PACE-WARNING", type: "warning" });
    }

    if (c2HitRate !== null && c2HitRate < 0.5)
        flags.push({ key: "C2-WARNING", label: "⚠ C2-WARNING", type: "warning" });

    if (liveAnnual !== null && liveAnnual < 50 && dayInQuarter >= 45)
        flags.push({ key: "ANNUAL-CRITICAL", label: "⚠ ANNUAL-CRITICAL", type: "critical" });

    // On track — only if no other flags AND pace is healthy
    if (flags.length === 0 && pace !== null && pace >= 85)
        flags.push({ key: "ON-TRACK", label: "✓ On track", type: "ok" });

    return flags;
}

// ─────────────────────────────────────────────────────────────────────────────
// C2 WRITE — called when gold task is marked done in reviewCompletion()
// Writes earned points to cowork_c2_scores/{employeeId}
// Prevents double-writing via taskId key in breakdown
// ─────────────────────────────────────────────────────────────────────────────

async function writeC2ScoreOnComplete({ taskId, task, employeeId }) {
    if (!employeeId || !task?.isGoldTask) return;

    const maxPts = Number(task.c2Config?.taskMaxPoints) || 0;
    if (maxPts === 0) {
        console.warn(`[C2 write] Task ${taskId} has taskMaxPoints=0 — skipping`);
        return;
    }


    // ── Calculate earned pts from components ─────────────────────────────────
    const activities = task.goalActivities || [];
    let earnedPts;

    if (activities.length === 0) {
        // GUARD 1: No components → fallback to all-or-nothing
        earnedPts = maxPts;
    } else {
        earnedPts = activities.reduce((sum, comp) => {
            const pts = Number(comp.points) || 0;

            // GUARD 3: multi-user → use perUserStatus, fallback to comp-level
            const userStatus = (task.isMultiUserGold && comp.perUserStatus?.[employeeId])
                ? comp.perUserStatus[employeeId]
                : { status: comp.status, lateSubmission: comp.lateSubmission };

            const isDone = userStatus?.status === "done";
            const isLate = userStatus?.lateSubmission === true;

            return sum + (isDone && !isLate ? pts : 0);
        }, 0);
    }

    earnedPts = +earnedPts.toFixed(2);

    const scoreRef = db.collection("cowork_c2_scores").doc(employeeId);
    const snap = await scoreRef.get();
    const existing = snap.exists ? snap.data() : { employeeId, totalEarned: 0, taskBreakdown: {} };
    const breakdown = existing.taskBreakdown || {};

    // Guard: avoid double-writing
    if (breakdown[taskId]?.earned !== undefined) {
        console.log(`[C2 write] ${taskId} already recorded for ${employeeId} — skipping`);
        return;
    }

    breakdown[taskId] = {
        taskId,
        taskTitle: task.title || "",
        taskMaxPoints: maxPts,
        earnedPoints: earnedPts,
        weightagePercent: task.c2Config?.weightagePercent || 0,
        completedAt: new Date().toISOString(),
        quarter: task.quarter || null,
        year: task.year || null,
    };

    const totalEarned = +Object.values(breakdown)
        .reduce((s, t) => s + (t.earned || 0), 0)
        .toFixed(2);

    await scoreRef.set({
        employeeId,
        totalEarned,
        taskBreakdown: breakdown,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });


    console.log(`[C2 write] +${earnedPts}pts (of ${maxPts} max) for ${employeeId} on ${taskId}. Total: ${totalEarned}`);
}
// ─────────────────────────────────────────────────────────────────────────────
// MASTER DASHBOARD GETTER
// Returns everything the frontend needs in one call.
// ─────────────────────────────────────────────────────────────────────────────
async function getDashboardData(employeeId, quarter, year) {
    quarter = Number(quarter) || getQuarterFromDate();
    year = Number(year) || getCurrentYear();

    const [c1Data, c2Data, c3Data, c4Data, sopBreakdown] = await Promise.all([
        computeC1ForQuarter(employeeId, quarter, year),
        computeC2ForEmployee(employeeId),
        computeC3ForEmployee(employeeId, quarter, year),
        computeC4ForEmployee(employeeId, quarter, year),
        getSOPBreakdown(employeeId, quarter, year),
    ]);

    const c3 = c3Data.c3Net;
    const c4Net = c4Data.c4Net;

    const pace = computePaceScore({
        c1Net: c1Data.c1Net,
        c2Net: c2Data.c2Net,
        c4Net,
        c3,
    });

    const rawQuarterScore = computeQuarterScore({
        c1Net: c1Data.c1Net,
        c2Net: c2Data.c2Net,
        c4Net,
        c3,
    });

    const annualData = await computeAnnualScores(employeeId, year);
    const gapData = computeGapToNextRating(annualData.liveAnnual);
    const dayInQ = getDayInQuarter();

    const flags = computeFlags({
        pace,
        dayInQuarter: dayInQ,
        c2HitRate: c2Data.c2Score,
        liveAnnual: annualData.liveAnnual,
    });

    const paceComponents = [
        (c1Data.c1Net !== null && c1Data.c1Net !== undefined) ? { label: "C1%", value: c1Data.c1Net } : null,
        (c2Data.c2Net !== null && c2Data.c2Net !== undefined) ? { label: "C2%", value: c2Data.c2Net } : null,
        (c4Net !== null && c4Net !== undefined) ? { label: "C4%", value: c4Net } : null,
    ].filter(Boolean);
    const paceFormula = paceComponents.length > 0
        ? `(${paceComponents.map(p => p.label).join(" + ")}) / ${paceComponents.length} − C3%`
        : "Not enough data yet";
    return {
        employeeId,
        quarter,
        year,
        dayInQuarter: dayInQ,

        // ── C1 ────────────────────────────────────────────────────────────────────
        c1: {
            net: c1Data.c1Net,
            max: c1Data.c1Max,
            qualityRate: c1Data.qualityRate,
            taskCount: c1Data.taskCount,
            tasks: c1Data.tasks,
            sopPts: sopBreakdown.c1,
        },

        // ── C2 ────────────────────────────────────────────────────────────────────
        c2: {
            net: c2Data.c2Net,
            max: c2Data.c2Max,
            ptsEarned: c2Data.ptsEarned,
            ptsPastDeadline: c2Data.ptsPastDeadline,
            score: c2Data.c2Score,
            taskCount: c2Data.taskCount,
            tasks: c2Data.tasks,
            sopPts: sopBreakdown.c2,
        },
        c3: {
            net: c3Data.c3Net,
            totalDeductions: c3Data.totalDeductions,
            breachCount: c3Data.breachCount,
            breaches: c3Data.breaches,
            sopPts: sopBreakdown.c3,
        },
        c4: {
            net: c4Data.c4Net,
            workingDays: c4Data.workingDays,
            totalBasePoints: c4Data.totalBasePoints,
            totalPenalty: c4Data.totalPenalty,
            finalPoints: c4Data.finalPoints,
            breachCount: c4Data.breachCount,
            breaches: c4Data.breaches,
            sopPts: sopBreakdown.c4,
        },        // ── Pace ──────────────────────────────────────────────────────────────────
        pace: {
            score: pace,
            rating: getRating(pace),
            breakdown: paceComponents,
            c3Net: c3,
            formula: paceFormula,
        },

        // ── Quarter raw score ─────────────────────────────────────────────────────
        rawQuarterScore,

        // ── Annual ────────────────────────────────────────────────────────────────
        annual: {
            live: annualData.liveAnnual,
            projected: annualData.projectedAnnual,
            rating: getRating(annualData.liveAnnual),
            quarters: annualData.quarters,
        },

        // ── Gap to next rating ────────────────────────────────────────────────────
        gap: gapData,

        // ── Flags ─────────────────────────────────────────────────────────────────
        flags,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
    computeC1ForQuarter,
    computeC2ForEmployee,
    computePaceScore,
    computeQuarterScore,
    computeAnnualScores,
    computeGapToNextRating,
    computeFlags,
    writeC2ScoreOnComplete,
    getDashboardData,
    getRating,
    getQuarterFromDate,
    getCurrentYear,
    getDayInQuarter,
};