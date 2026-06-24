"use strict";
/**
 * c1_interactive_test.js — C1 Interactive Case Tester
 * Loads real config from Firestore (no hardcoding)
 * Shows BEFORE → PREDICTS → runs → shows ACTUAL vs PREDICTED
 *
 * Run from backend root:
 *   node -r dotenv/config c1_interactive_test.js
 */

const TEST_EMPLOYEE_ID = "GR0067";
const TEST_REVIEWER_ID = "GR0045";
const TEST_REVIEWER_NAME = "Rakesh Biswal";

// ── MongoDB connect ───────────────────────────────────────────────────────────
const mongoose = require("mongoose");
mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing"
).catch(e => { console.error("MongoDB error:", e.message); process.exit(1); });

const { db, admin } = require("./config/firebaseAdmin");
const c1Svc = require("./services/c1Service");
const Employee = require("./models/Employee");
const readline = require("readline");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── Config — loaded from Firestore at startup ─────────────────────────────────
let CFG = {
    baseScore: 1.0,
    deadlineDeduction: 0.5,
    extensionDeduction: 0.2,
    reworkDeduction: 0.2,
    rejectScore: 0,
    c1Max: 35,
};

function calcTaskScore({ deadlinesMissed, extensionsFiled, reworksReceived, isRejected, isExcluded }) {
    if (isExcluded) return null;
    if (isRejected) return +Number(CFG.rejectScore).toFixed(2);
    return +(
        CFG.baseScore
        - (CFG.deadlineDeduction * deadlinesMissed)
        - (CFG.extensionDeduction * extensionsFiled)
        - (CFG.reworkDeduction * reworksReceived)
    ).toFixed(2);
}

// ── 13 test cases ─────────────────────────────────────────────────────────────
const CASES = [
    { id: 1, name: "Perfect", deadlinesMissed: 0, extensionsFiled: 0, reworksReceived: 0, isRejected: false, isExcluded: false },
    { id: 2, name: "1 Rework", deadlinesMissed: 0, extensionsFiled: 0, reworksReceived: 1, isRejected: false, isExcluded: false },
    { id: 3, name: "1 Extension", deadlinesMissed: 0, extensionsFiled: 1, reworksReceived: 0, isRejected: false, isExcluded: false },
    { id: 4, name: "1 Deadline Missed", deadlinesMissed: 1, extensionsFiled: 0, reworksReceived: 0, isRejected: false, isExcluded: false },
    { id: 5, name: "1 Deadline + 1 Rework", deadlinesMissed: 1, extensionsFiled: 0, reworksReceived: 1, isRejected: false, isExcluded: false },
    { id: 6, name: "1 Deadline + 1 Ext", deadlinesMissed: 1, extensionsFiled: 1, reworksReceived: 0, isRejected: false, isExcluded: false },
    { id: 7, name: "2 Reworks", deadlinesMissed: 0, extensionsFiled: 0, reworksReceived: 2, isRejected: false, isExcluded: false },
    { id: 8, name: "1 Ext + 1 Rework", deadlinesMissed: 0, extensionsFiled: 1, reworksReceived: 1, isRejected: false, isExcluded: false },
    { id: 9, name: "2 Deadlines Missed", deadlinesMissed: 2, extensionsFiled: 0, reworksReceived: 0, isRejected: false, isExcluded: false },
    { id: 10, name: "1 Deadline + 2 Reworks", deadlinesMissed: 1, extensionsFiled: 0, reworksReceived: 2, isRejected: false, isExcluded: false },
    { id: 11, name: "2 Deadlines + 1 Rework", deadlinesMissed: 2, extensionsFiled: 0, reworksReceived: 1, isRejected: false, isExcluded: false },
    { id: 12, name: "TL Rejected", deadlinesMissed: 0, extensionsFiled: 0, reworksReceived: 0, isRejected: true, isExcluded: false },
    { id: 13, name: "Cancelled", deadlinesMissed: 0, extensionsFiled: 0, reworksReceived: 0, isRejected: false, isExcluded: true },
];

// ── Read current state from Firebase + MongoDB ────────────────────────────────
async function getCurrentState() {
    const c1Snap = await db.collection("cowork_c1_scores").doc(TEST_EMPLOYEE_ID).get();
    const c1Cache = c1Snap.exists ? c1Snap.data() : null;

    let curNum = 0, curDen = 0;
    if (c1Cache?.taskBreakdown) {
        Object.values(c1Cache.taskBreakdown).forEach(t => {
            if (t.taskScore !== null && t.taskScore !== undefined && Number(t.etcHours) > 0) {
                curNum += Number(t.taskScore) * Number(t.etcHours);
                curDen += Number(t.etcHours);
            }
        });
    }

    const emp = await Employee.findOne({ biometricId: TEST_EMPLOYEE_ID }).lean();
    const year = new Date().getFullYear();
    const yearData = emp?.sopPoints?.find(s => s.year === year);
    const sopNet = yearData ? -(yearData.totalDeducted) : 0;

    return {
        c1Net: c1Cache?.c1Net ?? 0,
        qualityRate: c1Cache?.qualityRate ?? 0,
        c1Max: c1Cache?.c1MaxPoints ?? CFG.c1Max,
        numerator: +curNum.toFixed(4),
        denominator: +curDen.toFixed(1),
        sopNet: +sopNet.toFixed(2),
        taskCount: c1Cache?.taskCount ?? 0,
    };
}

// ── Predict what WILL happen ──────────────────────────────────────────────────
function predict(current, tc) {
    const ETC = 4;
    const taskScore = calcTaskScore(tc);

    let predQR, predC1, predPct;

    if (tc.isExcluded) {
        // Cancelled → no change to quality rate
        predQR = current.qualityRate;
        predC1 = current.c1Net;
    } else {
        const score = taskScore ?? 0;
        const newNum = Math.max(current.numerator + score * ETC, 0);
        const newDen = current.denominator + ETC;
        predQR = newDen > 0 ? Math.max(newNum / newDen, 0) : 0;
        predC1 = +(predQR * current.c1Max).toFixed(2);
    }
    predPct = +(predQR * 100).toFixed(1);

    // SOP net change from _writeC1BleachEntries:
    // → Reward (+baseScore) if not rejected AND taskScore > 0
    // → Deadline penalty (−deadlineDeduction × missed) if > 0
    // → Rejection penalty (−rejectScore) if rejected AND rejectScore > 0
    // Note: rework/extension deductions written separately in real flow
    //       test script simulates only final approval — not those intermediate steps
    let sopChange = 0;
    if (!tc.isExcluded && !tc.isRejected && (taskScore ?? 0) > 0) {
        sopChange += CFG.baseScore;
    }
    if (!tc.isExcluded && tc.isRejected && CFG.rejectScore > 0) {
        sopChange -= CFG.rejectScore;
    }
    if (!tc.isExcluded && tc.deadlinesMissed > 0) {
        sopChange -= tc.deadlinesMissed * CFG.deadlineDeduction;
    }

    return {
        taskScore,
        predC1: +predC1.toFixed(2),
        predPct: +predPct.toFixed(1),
        sopChange: +sopChange.toFixed(2),
        predSopNet: +(current.sopNet + sopChange).toFixed(2),
    };
}

// ── Run one case ──────────────────────────────────────────────────────────────
async function runCase(tc) {
    const taskId = `C1T_I_${String(tc.id).padStart(2, "0")}`;
    const now = new Date().toISOString();
    const quarter = Math.ceil((new Date().getMonth() + 1) / 3);
    const year = new Date().getFullYear();

    const before = await getCurrentState();
    const pred = predict(before, tc);

    const fmt = (v) => v === null ? "null" : String(v);
    const sign = (v) => v >= 0 ? "+" : "";

    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  Case ${tc.id}: ${tc.name}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  BEFORE`);
    console.log(`║  C1        : ${before.c1Net} / ${before.c1Max}   QR: ${(before.qualityRate * 100).toFixed(1)}%`);
    console.log(`║  SOP Net   : ${sign(before.sopNet)}${before.sopNet} pts`);
    console.log(`║  Tasks done: ${before.taskCount}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  CODE PREDICTS`);
    console.log(`║  Task Score: ${fmt(pred.taskScore)}`);
    console.log(`║  New C1    : ${pred.predC1} / ${before.c1Max}   QR: ${pred.predPct}%`);
    console.log(`║  SOP Δ     : ${sign(pred.sopChange)}${pred.sopChange} pts`);
    console.log(`║  New SOP   : ${sign(pred.predSopNet)}${pred.predSopNet} pts`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  Running...`);

    // Write task to Firestore
    await db.collection("cowork_tasks").doc(taskId).set({
        taskId,
        title: `[C1-TEST ${tc.id}] ${tc.name}`,
        description: "Interactive C1 test",
        assignedBy: TEST_REVIEWER_ID,
        assignedByName: TEST_REVIEWER_NAME,
        assignedByRole: "tl",
        rootCreatedByRole: "tl",
        assigneeIds: [TEST_EMPLOYEE_ID],
        status: tc.isExcluded ? "cancelled" : "done",
        etcHours: 4,
        isGoldTask: false, isFolder: false, isRepeat: false,
        isThirdParty: false, isGoal: false, hasTimer: true,
        quarter, year,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAtISO: now,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        completionStatus: tc.isRejected ? "tl_rejected"
            : tc.isExcluded ? null
                : "tl_final_approved",
        completionSubmission: {
            submittedBy: TEST_EMPLOYEE_ID,
            submittedByName: "Test",
            message: "test",
            submittedAt: now,
        },
        tlReview: tc.isRejected
            ? { reviewedBy: TEST_REVIEWER_ID, reviewedByName: TEST_REVIEWER_NAME, approved: false, rejectionReason: "test rejection", reviewedAt: now }
            : { reviewedBy: TEST_REVIEWER_ID, reviewedByName: TEST_REVIEWER_NAME, approved: true, reviewedAt: now },
        c1: {
            deadlinesMissed: tc.deadlinesMissed,
            extensionsFiled: tc.extensionsFiled,
            reworksReceived: tc.reworksReceived,
            taskScore: null,
            c1Status: "open",
            isExcluded: tc.isExcluded,
            isRejected: tc.isRejected,
            officialDeadline: null,
            scoreCalculatedAt: null,
        },
    });

    // Run C1 scoring
    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    await c1Svc.computeAndStoreTaskScore({
        taskId,
        taskData: snap.data(),
        employeeId: TEST_EMPLOYEE_ID,
        isRejected: tc.isRejected,
        submittedAt: now,
    });

    await sleep(1500);

    // Read ACTUAL results
    const after = await getCurrentState();
    const updatedTask = (await db.collection("cowork_tasks").doc(taskId).get()).data();
    const actualScore = updatedTask?.c1?.taskScore ?? null;

    const scoreOk = String(actualScore) === String(pred.taskScore);
    const c1Ok = String(after.c1Net) === String(pred.predC1);
    const sopOk = String(after.sopNet) === String(pred.predSopNet);

    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  ACTUAL vs PREDICTED`);
    console.log(`║  Task Score│ pred: ${String(fmt(pred.taskScore)).padEnd(10)} actual: ${String(fmt(actualScore)).padEnd(10)} ${scoreOk ? "✅" : "❌"}`);
    console.log(`║  C1 Score  │ pred: ${String(pred.predC1).padEnd(10)} actual: ${String(after.c1Net).padEnd(10)} ${c1Ok ? "✅" : "❌"}`);
    console.log(`║  QR        │ pred: ${String(pred.predPct + "%").padEnd(10)} actual: ${String((after.qualityRate * 100).toFixed(1) + "%").padEnd(10)}`);
    console.log(`║  SOP Net   │ pred: ${String(pred.predSopNet).padEnd(10)} actual: ${String(after.sopNet).padEnd(10)} ${sopOk ? "✅" : "❌"}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  → Refresh PMP dashboard → check C1 card`);
    console.log(`║  → Refresh SOP page      → check Net Penalty Score`);
    console.log(`║  → Task ID in Firestore: ${taskId}`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
}

// ── Menu loop ─────────────────────────────────────────────────────────────────
function printMenu(showScores = true) {
    console.log("\n─────────────────────────────────────────────────────");
    console.log("  PICK A CASE");
    console.log("─────────────────────────────────────────────────────");
    CASES.forEach(c => {
        const score = showScores ? calcTaskScore(c) : "?";
        console.log(`  ${String(c.id).padStart(2)}. ${c.name.padEnd(26)} score → ${score}`);
    });
    console.log("   0. Exit");
    console.log("─────────────────────────────────────────────────────");
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n  Connecting to Firebase + MongoDB...");
    await sleep(2000);
    console.log("  ✅ Connected");

    // Load real config from Firestore
    const realCfg = await c1Svc.getC1Config();
    CFG.baseScore = realCfg.c1BaseScore;
    CFG.deadlineDeduction = realCfg.c1DeadlineDeduction;
    CFG.extensionDeduction = realCfg.c1ExtensionDeduction;
    CFG.reworkDeduction = realCfg.c1ReworkDeduction;
    CFG.rejectScore = realCfg.c1RejectScore;
    CFG.c1Max = realCfg.c1MaxPoints;

    console.log(`\n  ── Config loaded from Firestore ──`);
    console.log(`  Base Score          : ${CFG.baseScore}`);
    console.log(`  Deadline Deduction  : ${CFG.deadlineDeduction}`);
    console.log(`  Extension Deduction : ${CFG.extensionDeduction}`);
    console.log(`  Rework Deduction    : ${CFG.reworkDeduction}`);
    console.log(`  Reject Override     : ${CFG.rejectScore}`);
    console.log(`  C1 Max Points       : ${CFG.c1Max}`);

    const state = await getCurrentState();
    console.log(`\n  ── Current State ──`);
    console.log(`  C1      : ${state.c1Net} / ${state.c1Max}   QR: ${(state.qualityRate * 100).toFixed(1)}%`);
    console.log(`  SOP Net : ${state.sopNet >= 0 ? "+" : ""}${state.sopNet} pts`);
    console.log(`  Tasks   : ${state.taskCount} completed`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const ask = () => {
        printMenu();
        rl.question("\n  Enter case number: ", async (input) => {
            const num = parseInt(input.trim());
            if (isNaN(num)) { console.log("  ⚠️  Enter a number."); ask(); return; }
            if (num === 0) { console.log("\n  Done.\n"); rl.close(); process.exit(0); }
            const tc = CASES.find(c => c.id === num);
            if (!tc) { console.log("  ⚠️  Invalid case. Try 1–13."); ask(); return; }
            try { await runCase(tc); }
            catch (e) { console.log(`\n  ❌ ERROR: ${e.message}\n`); }
            ask();
        });
    };

    ask();
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });