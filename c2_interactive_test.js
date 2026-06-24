"use strict";
/**
 * c2_interactive_test.js — C2 Interactive Case Tester
 * 4 gold tasks (30+30+30+10 = 100%), C2 max = 30 pts
 * Simulates per-component approval via goal-credit flow
 *
 * Run: node -r dotenv/config c2_interactive_test.js
 */

const TEST_EMPLOYEE_ID = "GR0067";
const TEST_REVIEWER_ID = "GR0045";
const TEST_REVIEWER_NAME = "Rakesh Biswal";

const mongoose = require("mongoose");
mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing"
).catch(e => { console.error("MongoDB:", e.message); process.exit(1); });

const { db, admin } = require("./config/firebaseAdmin");
const pmpSvc = require("./services/pmpService");
const Employee = require("./models/Employee");
const readline = require("readline");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const PAST = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
const FUTURE = new Date(Date.now() + 30 * 24 * 3600000).toISOString();

// ─────────────────────────────────────────────────────────────────────────────
// 4 TASKS — 30+30+30+10 = 100%
// ─────────────────────────────────────────────────────────────────────────────
const CASES = [
    {
        id: 1,
        name: "Task 1 — 30% (9 pts) — 3 comps — ALL DONE ON TIME",
        weightage: 30, taskMaxPts: 9, taskStatus: "done",
        goalActivities: [
            { heading: "Comp A", points: 3, deadline: PAST, status: "done", lateSubmission: false },
            { heading: "Comp B", points: 3, deadline: PAST, status: "done", lateSubmission: false },
            { heading: "Comp C", points: 3, deadline: PAST, status: "done", lateSubmission: false },
        ],
        expectedEarned: 9, expectedMeasurable: 9,
        expectedSopDelta: 9,  // all 3 comps on time → +9 pts in SOP
    },
    {
        id: 2,
        name: "Task 2 — 30% (9 pts) — 3 comps — 1 LATE",
        weightage: 30, taskMaxPts: 9, taskStatus: "done",
        goalActivities: [
            { heading: "Comp A", points: 3, deadline: PAST, status: "done", lateSubmission: true },
            { heading: "Comp B", points: 3, deadline: PAST, status: "done", lateSubmission: false },
            { heading: "Comp C", points: 3, deadline: PAST, status: "done", lateSubmission: false },
        ],
        expectedEarned: 6, expectedMeasurable: 9,
        expectedSopDelta: 6,  // Comp A late → skipped. B+C → +6 pts
    },
    {
        id: 3,
        name: "Task 3 — 30% (9 pts) — 4 comps — MIXED (in_progress)",
        weightage: 30, taskMaxPts: 9, taskStatus: "in_progress",
        goalActivities: [
            { heading: "Comp A", points: 2, deadline: PAST, status: "done", lateSubmission: false },
            { heading: "Comp B", points: 2, deadline: PAST, status: "done", lateSubmission: true },
            { heading: "Comp C", points: 3, deadline: FUTURE, status: "pending", lateSubmission: false },
            { heading: "Comp D", points: 2, deadline: PAST, status: "pending", lateSubmission: false },
        ],
        expectedEarned: 2, expectedMeasurable: 6,
        // Comp A on time → +2 pts SOP. Comp B late → 0 pts. C+D not done → 0
        expectedSopDelta: 2,
    },
    {
        id: 4,
        name: "Task 4 — 10% (3 pts) — 3 comps — ALL DONE ON TIME",
        weightage: 10, taskMaxPts: 3, taskStatus: "done",
        goalActivities: [
            { heading: "Comp A", points: 1, deadline: PAST, status: "done", lateSubmission: false },
            { heading: "Comp B", points: 1, deadline: PAST, status: "done", lateSubmission: false },
            { heading: "Comp C", points: 1, deadline: PAST, status: "done", lateSubmission: false },
        ],
        expectedEarned: 3, expectedMeasurable: 3,
        expectedSopDelta: 3,
    },
];

// ── Pool check ────────────────────────────────────────────────────────────────
async function checkPool(requestedWeightage, excludeTaskId = null) {
    const snap = await db.collection("cowork_tasks")
        .where("isGoldTask", "==", true)
        .where("status", "not-in", ["done", "cancelled"])
        .get();
    let used = 0;
    snap.docs.forEach(d => {
        const t = d.data();
        if (excludeTaskId && t.taskId === excludeTaskId) return;
        used += Number(t.c2Config?.weightagePercent) || 0;
    });
    return { totalUsed: used, remaining: +(100 - used).toFixed(2), canCreate: requestedWeightage <= +(100 - used).toFixed(2) };
}

// ── Current state ─────────────────────────────────────────────────────────────
async function getCurrentState() {
    const r = await pmpSvc.computeC2ForEmployee(TEST_EMPLOYEE_ID);
    const emp = await Employee.findOne({ biometricId: TEST_EMPLOYEE_ID }).lean();
    const yr = new Date().getFullYear();
    const yd = emp?.sopPoints?.find(s => s.year === yr);
    const sopNet = yd ? +(-yd.totalDeducted).toFixed(2) : 0;
    return {
        ptsEarned: r.ptsEarned || 0,
        ptsMeasurable: r.ptsPastDeadline || 0,
        c2Net: r.c2Net || 0,
        c2Max: r.c2Max || 30,
        taskCount: r.taskCount || 0,
        sopNet,
    };
}

// ── Simulate goal-credit per component ───────────────────────────────────────
// This replicates exactly what soproute.js /goal-credit does
async function simulateGoalCredit({ comp, taskId, taskTitle, taskMaxPts, weightage, employeeId }) {
    const pts = Number(comp.points) || 0;
    if (pts <= 0) return { skipped: true, reason: "no pts" };
    if (comp.lateSubmission) return { skipped: true, reason: "late" };
    if (comp.status !== "done") return { skipped: true, reason: "not done" };

    const absPoints = pts;
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const year = now.getFullYear();

    // 1. Write SOP entry to MongoDB
    const emp = await Employee.findOne({ biometricId: employeeId });
    if (!emp) throw new Error(`Employee ${employeeId} not found`);

    const creditEntry = {
        sopName: comp.heading || "Goal Component",
        folderName: taskTitle || taskId,
        points: absPoints,
        description: `On-time goal node approved: ${comp.heading}`,
        date: today,
        cutBy: TEST_REVIEWER_ID,
        cutByName: TEST_REVIEWER_NAME,
        cutByRole: "tl",
        bleachType: "debit",
        isCredit: true,
        taskId,
        isC2Band: true,
        recheck: { status: "none", requestedAt: null, requestNote: "", reviewedBy: null, reviewedByName: null, reviewedAt: null, reviewNote: "" },
    };

    if (!emp.sopPoints) emp.sopPoints = [];
    const yi = emp.sopPoints.findIndex(sp => sp.year === year);
    if (yi >= 0) {
        emp.sopPoints[yi].bleaches.push(creditEntry);
        emp.sopPoints[yi].totalDeducted = +(emp.sopPoints[yi].totalDeducted - absPoints).toFixed(2);
    } else {
        emp.sopPoints.push({ year, totalDeducted: -absPoints, bleaches: [creditEntry] });
    }
    await emp.save();

    // 2. Update cowork_c2_scores cache (correct field names for frontend)
    const scoreRef = db.collection("cowork_c2_scores").doc(employeeId);
    const scoreSnap = await scoreRef.get();
    const existing = scoreSnap.exists ? scoreSnap.data() : { employeeId, totalEarned: 0, taskBreakdown: {} };
    const breakdown = existing.taskBreakdown || {};

    if (!breakdown[taskId]) {
        breakdown[taskId] = {
            taskId,
            taskTitle: taskTitle || "",
            taskMaxPoints: Number(taskMaxPts) || 0,
            earnedPoints: 0,
            weightagePercent: Number(weightage) || 0,
            completedAt: null,
        };
    }
    breakdown[taskId].earnedPoints = +((breakdown[taskId].earnedPoints || 0) + absPoints).toFixed(2);

    const totalEarned = +Object.values(breakdown)
        .reduce((s, t) => s + (t.earnedPoints || 0), 0).toFixed(2);

    await scoreRef.set({
        employeeId, totalEarned, taskBreakdown: breakdown,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { skipped: false, pts: absPoints };
}

// ── Run case ──────────────────────────────────────────────────────────────────
async function runCase(tc) {
    const taskId = `C2T_I_${String(tc.id).padStart(2, "0")}`;
    const now = new Date().toISOString();
    const quarter = Math.ceil((new Date().getMonth() + 1) / 3);
    const year = new Date().getFullYear();

    const before = await getCurrentState();
    const sign = v => v >= 0 ? "+" : "";
    const fmt = v => v === null ? "null" : String(v);

    // Prediction
    const predTotalEarned = +(before.ptsEarned + tc.expectedEarned).toFixed(2);
    const predTotalMeas = +(before.ptsMeasurable + tc.expectedMeasurable).toFixed(2);
    const predC2Score = predTotalMeas > 0 ? +(predTotalEarned / predTotalMeas).toFixed(4) : null;
    const predC2Net = predC2Score !== null ? +(predC2Score * before.c2Max).toFixed(2) : null;
    const predSopNet = +(before.sopNet + tc.expectedSopDelta).toFixed(2);

    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  ${tc.name}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  BEFORE`);
    console.log(`║  C2 Net     : ${before.c2Net} / ${before.c2Max}`);
    console.log(`║  Earned     : ${before.ptsEarned} pts`);
    console.log(`║  SOP Net    : ${sign(before.sopNet)}${before.sopNet} pts`);
    console.log(`╠══════════════════════════════════════════════════════╣`);

    // Pool check
    const pool = await checkPool(tc.weightage, taskId);
    console.log(`║  POOL: used=${pool.totalUsed}% remaining=${pool.remaining}% requested=${tc.weightage}%`);
    if (!pool.canCreate) {
        console.log(`║  ❌ BLOCKED — pool full. Run cleanup first.`);
        console.log(`╚══════════════════════════════════════════════════════╝\n`);
        return;
    }
    console.log(`║  ✅ Pool OK`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  CODE PREDICTS`);
    console.log(`║  Earned Δ    : ${sign(tc.expectedEarned)}${tc.expectedEarned} pts`);
    console.log(`║  Measurable Δ: ${sign(tc.expectedMeasurable)}${tc.expectedMeasurable} pts`);
    console.log(`║  New C2 Net  : ${fmt(predC2Net)} / ${before.c2Max}`);
    console.log(`║  SOP Δ       : ${sign(tc.expectedSopDelta)}${tc.expectedSopDelta} pts`);
    console.log(`║  New SOP Net : ${sign(predSopNet)}${predSopNet} pts`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  Running...`);

    // Write task to Firestore
    await db.collection("cowork_tasks").doc(taskId).set({
        taskId,
        title: `[C2-TEST ${tc.id}] ${tc.name}`,
        description: "C2 interactive test",
        assignedBy: TEST_REVIEWER_ID, assignedByName: TEST_REVIEWER_NAME,
        assignedByRole: "tl", rootCreatedByRole: "tl",
        assigneeIds: [TEST_EMPLOYEE_ID],
        status: tc.taskStatus,
        isGoldTask: true, isMultiUserGold: false,
        isFolder: false, isRepeat: false, isThirdParty: false, isGoal: true, hasTimer: false,
        quarter, year,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtISO: now, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        goalActivities: tc.goalActivities,
        c2Config: {
            weightagePercent: tc.weightage,
            taskMaxPoints: tc.taskMaxPts,
            globalMaxPointsAtCreation: before.c2Max,
        },
        completionStatus: tc.taskStatus === "done" ? "tl_final_approved" : null,
        tlReview: tc.taskStatus === "done"
            ? { reviewedBy: TEST_REVIEWER_ID, reviewedByName: TEST_REVIEWER_NAME, approved: true, reviewedAt: now }
            : null,
        c1: { deadlinesMissed: 0, extensionsFiled: 0, reworksReceived: 0, taskScore: null, c1Status: "open", isExcluded: false, isRejected: false, officialDeadline: null, scoreCalculatedAt: null },
    });

    console.log(`║  Task ${taskId} written`);
    console.log(`║`);
    console.log(`║  Components (simulating per-component goal-credit):`);

    // Simulate per-component approval via goal-credit
    let totalCredited = 0;
    for (const comp of tc.goalActivities) {
        const result = await simulateGoalCredit({
            comp, taskId,
            taskTitle: `[C2-TEST ${tc.id}] ${tc.name}`,
            taskMaxPts: tc.taskMaxPts,
            weightage: tc.weightage,
            employeeId: TEST_EMPLOYEE_ID,
        });

        if (result.skipped) {
            const reason = comp.lateSubmission ? "LATE → 0 pts" : comp.status !== "done" ? "not done yet" : "no pts";
            console.log(`║    ${comp.heading}: ${comp.points}pts | SKIPPED (${reason})`);
        } else {
            totalCredited += result.pts;
            console.log(`║    ${comp.heading}: ${comp.points}pts | ✅ +${result.pts}pts credited to SOP + C2 cache`);
        }
    }

    console.log(`║`);
    console.log(`║  Total credited via goal-credit: +${totalCredited} pts`);

    // Also fire writeC2ScoreOnComplete if task is done (for final reconciliation)
    if (tc.taskStatus === "done") {
        const snap = await db.collection("cowork_tasks").doc(taskId).get();
        await pmpSvc.writeC2ScoreOnComplete({
            taskId, task: snap.data(), employeeId: TEST_EMPLOYEE_ID,
        });
        console.log(`║  writeC2ScoreOnComplete fired (final reconciliation)`);
    }

    await sleep(1000);

    const after = await getCurrentState();
    const thisEarned = +(after.ptsEarned - before.ptsEarned).toFixed(2);
    const thisMeasurable = +(after.ptsMeasurable - before.ptsMeasurable).toFixed(2);
    const sopDelta = +(after.sopNet - before.sopNet).toFixed(2);

    const eOk = String(thisEarned) === String(tc.expectedEarned);
    const mOk = String(thisMeasurable) === String(tc.expectedMeasurable);
    const nOk = String(after.c2Net) === String(predC2Net);
    const sOk = String(sopDelta) === String(tc.expectedSopDelta);

    // Read C2 cache to verify field names
    const cacheSnap = await db.collection("cowork_c2_scores").doc(TEST_EMPLOYEE_ID).get();
    const cacheTask = cacheSnap.exists ? cacheSnap.data()?.taskBreakdown?.[taskId] : null;

    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  ACTUAL vs PREDICTED`);
    console.log(`║  Earned Δ    │ pred:${String(tc.expectedEarned).padEnd(8)} actual:${String(thisEarned).padEnd(8)} ${eOk ? "✅" : "❌"}`);
    console.log(`║  Measurable Δ│ pred:${String(tc.expectedMeasurable).padEnd(8)} actual:${String(thisMeasurable).padEnd(8)} ${mOk ? "✅" : "❌"}`);
    console.log(`║  C2 Net      │ pred:${String(fmt(predC2Net)).padEnd(8)} actual:${String(after.c2Net).padEnd(8)} ${nOk ? "✅" : "❌"}`);
    console.log(`║  SOP Net Δ   │ pred:${String(tc.expectedSopDelta).padEnd(8)} actual:${String(sopDelta).padEnd(8)} ${sOk ? "✅" : "❌"}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  C2 CACHE (what SOP page reads)`);
    if (cacheTask) {
        const maxOk = cacheTask.taskMaxPoints !== undefined;
        const earnOk = cacheTask.earnedPoints !== undefined;
        console.log(`║  taskMaxPoints  : ${cacheTask.taskMaxPoints}   ${maxOk ? "✅ field ok" : "❌ missing"}`);
        console.log(`║  earnedPoints   : ${cacheTask.earnedPoints}    ${earnOk ? "✅ field ok" : "❌ missing"}`);
        console.log(`║  taskTitle      : ${cacheTask.taskTitle?.slice(0, 30)}`);
        console.log(`║  weightagePercent: ${cacheTask.weightagePercent}%`);
        console.log(`║  → SOP page will show: ${cacheTask.earnedPoints || 0}/${cacheTask.taskMaxPoints || 0} pts ✅`);
    } else {
        console.log(`║  ℹ️  Task not in cache (in_progress tasks not cached — correct)`);
    }
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  → Refresh PMP dashboard → C2 card`);
    console.log(`║  → Refresh SOP page → C2 breakdown (should show correct pts now)`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
}

// ── Menu ──────────────────────────────────────────────────────────────────────
function printMenu() {
    console.log("\n─────────────────────────────────────────────────────────");
    console.log("  C2 TEST — 4 TASKS (30+30+30+10 = 100%)");
    console.log("─────────────────────────────────────────────────────────");
    let pool = 0;
    CASES.forEach(c => {
        pool += c.weightage;
        console.log(`  ${c.id}. ${c.name}`);
        console.log(`     pool after: ${pool}% | expected earned: ${c.expectedEarned}pts | SOP Δ: +${c.expectedSopDelta}pts`);
    });
    console.log("  0. Exit");
    console.log("─────────────────────────────────────────────────────────");
    console.log("  ⚠  Run in order 1→2→3→4");
    console.log("  ⚠  Run cleanup_test_data.js first if re-running");
    console.log("─────────────────────────────────────────────────────────");
}

async function main() {
    console.log("\n  Connecting...");
    await sleep(2000);
    console.log("  ✅ Connected");

    const s = await getCurrentState();
    const p = await checkPool(0);
    console.log(`\n  ── Current State ──`);
    console.log(`  C2 Net    : ${s.c2Net} / ${s.c2Max}`);
    console.log(`  Earned    : ${s.ptsEarned} pts`);
    console.log(`  SOP Net   : ${s.sopNet >= 0 ? "+" : ""}${s.sopNet} pts`);
    console.log(`  Pool used : ${p.totalUsed}% / 100%`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => {
        printMenu();
        rl.question("\n  Enter case number (1-4): ", async input => {
            const num = parseInt(input.trim());
            if (isNaN(num)) { console.log("  ⚠️  Enter a number."); ask(); return; }
            if (num === 0) { console.log("\n  Done.\n"); rl.close(); process.exit(0); }
            const tc = CASES.find(c => c.id === num);
            if (!tc) { console.log("  ⚠️  Invalid. Try 1–4."); ask(); return; }
            try { await runCase(tc); }
            catch (e) { console.log(`\n  ❌ ERROR: ${e.message}\n`); }
            ask();
        });
    };
    ask();
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });