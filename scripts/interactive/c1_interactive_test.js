"use strict";
/**
 * c1_interactive_test.js — C1 Interactive Case Tester v2
 *
 * What's new vs v1:
 *   - Fixed SOP net prediction (reworksReceived:0 in final score, reworks pre-applied separately)
 *   - Full-flow cases (writeReworkDeduction × N → computeAndStoreTaskScore)
 *   - Cleanup option: deletes all test tasks + resets employee sopPoints for test year
 *   - Clearer output with pass/fail per metric
 *
 * Run from backend root:
 *   node -r dotenv/config c1_interactive_test.js
 */

const TEST_EMPLOYEE_ID = "GR0067";
const TEST_REVIEWER_ID = "GR0045";
const TEST_REVIEWER_NAME = "Rakesh Biswal";
const TEST_ETC_HOURS = 4;

// ── MongoDB connect ───────────────────────────────────────────────────────────
const mongoose = require("mongoose");
mongoose.connect(
    process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing"
).catch(e => { console.error("MongoDB error:", e.message); process.exit(1); });

const { db, admin } = require("./config/firebaseAdmin");
const c1Svc = require("./services/c1Service");
const Employee = require("./models/Employee");
const readline = require("readline");

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Live config (loaded from Firestore at startup) ────────────────────────────
let CFG = {
    baseScore: 1.0,
    deadlineDeduction: 0.5,
    extensionDeduction: 0.2,
    reworkDeduction: 0.2,
    rejectScore: 0,
    c1Max: 35,
};

// ── Task score formula (mirrors c1Service.calculateTaskScore) ─────────────────
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

// ── Test cases ────────────────────────────────────────────────────────────────
// Standard cases: computeAndStoreTaskScore only (no separate rework writes)
const STANDARD_CASES = [
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

// Full-flow cases: writeReworkDeduction called N times, then computeAndStoreTaskScore
// These test the writeReworkDeduction fix (+ not -)
const FLOW_CASES = [
    { id: 14, name: "Flow: 1 Rework → Approve", reworkCount: 1, deadlinesMissed: 0, extensionsFiled: 0, isRejected: false },
    { id: 15, name: "Flow: 2 Reworks → Approve", reworkCount: 2, deadlinesMissed: 0, extensionsFiled: 0, isRejected: false },
    { id: 16, name: "Flow: 1 Rework → Reject", reworkCount: 1, deadlinesMissed: 0, extensionsFiled: 0, isRejected: true },
    { id: 17, name: "Flow: 2 Reworks → Reject", reworkCount: 2, deadlinesMissed: 0, extensionsFiled: 0, isRejected: true },
];

// ── Read current state ────────────────────────────────────────────────────────
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

    // sopNet = -totalDeducted  (positive = net reward, negative = net penalty)
    // matches sop/page.js: displayTotal = -totalAll
    const sopNet = yearData ? -(yearData.totalDeducted) : 0;

    return {
        c1Net: c1Cache?.c1Net ?? 0,
        qualityRate: c1Cache?.qualityRate ?? 0,
        c1Max: c1Cache?.c1MaxPoints ?? CFG.c1Max,
        numerator: +curNum.toFixed(4),
        denominator: +curDen.toFixed(1),
        sopNet: +sopNet.toFixed(2),
        taskCount: c1Cache?.taskCount ?? 0,
        totalDeducted: yearData?.totalDeducted ?? 0,
    };
}

// ── Predict outcome for STANDARD cases ───────────────────────────────────────
// Standard cases call computeAndStoreTaskScore only.
// _writeC1BleachEntries uses reworksReceived:0 for the final entry
// (rework penalties are written separately via writeReworkDeduction in real flow).
function predictStandard(current, tc) {
    const ETC = TEST_ETC_HOURS;
    const taskScore = calcTaskScore(tc); // includes reworks in C1 calc

    // ── C1 score ──
    let predQR = current.qualityRate;
    let predC1 = current.c1Net;
    if (!tc.isExcluded) {
        const score = taskScore ?? 0;
        const newNum = Math.max(current.numerator + score * ETC, 0);
        const newDen = current.denominator + ETC;
        predQR = newDen > 0 ? Math.max(newNum / newDen, 0) : 0;
        predC1 = +(predQR * current.c1Max).toFixed(2);
    }

    // ── SOP net change ──
    // _writeC1BleachEntries writes the FINAL task entry with reworksReceived:0
    // so the SOP reward/penalty is based on: baseScore - deadline - extension only
    let sopChange = 0;
    if (!tc.isExcluded) {
        if (!tc.isRejected) {
            const finalScore = +(
                CFG.baseScore
                - CFG.deadlineDeduction * tc.deadlinesMissed
                - CFG.extensionDeduction * tc.extensionsFiled
            ).toFixed(2);
            if (finalScore > 0) {
                // reward (debit) → totalDeducted -= finalScore → sopNet += finalScore
                sopChange += finalScore;
            }
        } else if (CFG.rejectScore > 0) {
            // penalty (credit) → totalDeducted += rejectScore → sopNet -= rejectScore
            sopChange -= CFG.rejectScore;
        }
    }

    return {
        taskScore,
        predC1: +predC1.toFixed(2),
        predPct: +(predQR * 100).toFixed(1),
        sopChange: +sopChange.toFixed(2),
        predSopNet: +(current.sopNet + sopChange).toFixed(2),
    };
}

// ── Predict outcome for FULL-FLOW cases ──────────────────────────────────────
// Full-flow: writeReworkDeduction × N, then computeAndStoreTaskScore.
// After the fix, writeReworkDeduction adds +pts to totalDeducted (sopNet -= pts per rework).
function predictFlow(current, fc) {
    const ETC = TEST_ETC_HOURS;

    // reworksReceived for C1 calc = actual number of reworks
    const tc = {
        deadlinesMissed: fc.deadlinesMissed,
        extensionsFiled: fc.extensionsFiled,
        reworksReceived: fc.reworkCount,
        isRejected: fc.isRejected,
        isExcluded: false,
    };
    const taskScore = calcTaskScore(tc);

    // ── C1 score ──
    const score = taskScore ?? 0;
    const newNum = Math.max(current.numerator + score * ETC, 0);
    const newDen = current.denominator + ETC;
    const predQR = newDen > 0 ? Math.max(newNum / newDen, 0) : 0;
    const predC1 = +(predQR * current.c1Max).toFixed(2);

    // ── SOP net change ──
    // Each rework: totalDeducted += reworkDeduction → sopNet -= reworkDeduction
    let sopChange = -(fc.reworkCount * CFG.reworkDeduction);

    // Final approval/rejection entry (reworksReceived:0 passed to _writeC1BleachEntries)
    if (!fc.isRejected) {
        const finalScore = +(
            CFG.baseScore
            - CFG.deadlineDeduction * fc.deadlinesMissed
            - CFG.extensionDeduction * fc.extensionsFiled
        ).toFixed(2);
        if (finalScore > 0) sopChange += finalScore;
    } else if (CFG.rejectScore > 0) {
        sopChange -= CFG.rejectScore;
    }

    return {
        taskScore,
        reworkCount: fc.reworkCount,
        predC1: +predC1.toFixed(2),
        predPct: +(predQR * 100).toFixed(1),
        sopChange: +sopChange.toFixed(2),
        predSopNet: +(current.sopNet + sopChange).toFixed(2),
    };
}

// ── Run standard case ─────────────────────────────────────────────────────────
async function runStandard(tc) {
    const taskId = `C1T_S_${String(tc.id).padStart(2, "0")}_${Date.now()}`;
    const now = new Date().toISOString();
    const quarter = Math.ceil((new Date().getMonth() + 1) / 3);
    const year = new Date().getFullYear();

    const before = await getCurrentState();
    const pred = predictStandard(before, tc);

    printHeader(tc.id, tc.name);
    printBefore(before);
    printPredicted(pred, before.c1Max);
    console.log(`║  Running...`);

    await db.collection("cowork_tasks").doc(taskId).set(buildTaskDoc({
        taskId, tc, quarter, year, now,
    }));

    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    await c1Svc.computeAndStoreTaskScore({
        taskId,
        taskData: snap.data(),
        employeeId: TEST_EMPLOYEE_ID,
        isRejected: tc.isRejected,
        submittedAt: now,
    });

    await sleep(1800);

    const after = await getCurrentState();
    const actualTask = (await db.collection("cowork_tasks").doc(taskId).get()).data();
    const actualScore = actualTask?.c1?.taskScore ?? null;

    printActual(pred, after, actualScore, taskId);
}

// ── Run full-flow case ────────────────────────────────────────────────────────
async function runFlow(fc) {
    const taskId = `C1T_F_${String(fc.id).padStart(2, "0")}_${Date.now()}`;
    const now = new Date().toISOString();
    const quarter = Math.ceil((new Date().getMonth() + 1) / 3);
    const year = new Date().getFullYear();

    const tc = {
        deadlinesMissed: fc.deadlinesMissed,
        extensionsFiled: fc.extensionsFiled,
        reworksReceived: fc.reworkCount,
        isRejected: fc.isRejected,
        isExcluded: false,
    };

    const before = await getCurrentState();
    const pred = predictFlow(before, fc);

    printHeader(fc.id, fc.name);
    console.log(`║  Flow: ${fc.reworkCount} rework(s) → ${fc.isRejected ? "REJECT" : "APPROVE"}`);
    printBefore(before);
    printPredicted(pred, before.c1Max);
    console.log(`║  Running...`);

    // Create task doc
    await db.collection("cowork_tasks").doc(taskId).set(buildTaskDoc({
        taskId, tc, quarter, year, now,
    }));

    // Write rework deductions (tests the fix: + not -)
    for (let i = 1; i <= fc.reworkCount; i++) {
        await c1Svc.writeReworkDeduction({
            employeeId: TEST_EMPLOYEE_ID,
            taskId,
            taskTitle: `[C1-FLOW ${fc.id}] ${fc.name}`,
            reviewerId: TEST_REVIEWER_ID,
            reviewerName: TEST_REVIEWER_NAME,
            reworkNumber: i,
        });
        console.log(`║  ✓ Rework #${i} deduction written`);
    }

    await sleep(500);

    // Write rework deductions first (mirrors real production flow)
    if (tc.reworksReceived > 0) {
        for (let i = 1; i <= tc.reworksReceived; i++) {
            await c1Svc.writeReworkDeduction({
                employeeId: TEST_EMPLOYEE_ID,
                taskId,
                taskTitle: `[C1-TEST ${tc.id}] ${tc.name}`,
                reviewerId: TEST_REVIEWER_ID,
                reviewerName: TEST_REVIEWER_NAME,
                reworkNumber: i,
            });
            console.log(`║  ✓ Rework #${i} written (−${CFG.reworkDeduction} pts)`);
        }
        await sleep(400);
    }

    const snap = await db.collection("cowork_tasks").doc(taskId).get();
    await c1Svc.computeAndStoreTaskScore({
        taskId,
        taskData: snap.data(),
        employeeId: TEST_EMPLOYEE_ID,
        isRejected: tc.isRejected,
        submittedAt: now,
    });


    await sleep(1800);

    const after = await getCurrentState();
    const actualTask = (await db.collection("cowork_tasks").doc(taskId).get()).data();
    const actualScore = actualTask?.c1?.taskScore ?? null;

    printActual(pred, after, actualScore, taskId);
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
async function runCleanup() {
    console.log("\n  ⚠️  This will:");
    console.log("  1. Delete ALL C1T_ test tasks from Firestore");
    console.log("  2. Remove sopPoints for test year from MongoDB employee");
    console.log("  3. Reset cowork_c1_scores cache for test employee\n");

    const confirmed = await ask_confirm("  Type YES to proceed: ");
    if (confirmed !== "YES") { console.log("  Cancelled."); return; }

    // Delete test tasks from Firestore
    const snap = await db.collection("cowork_tasks")
        .where("assigneeIds", "array-contains", TEST_EMPLOYEE_ID)
        .get();

    let deleted = 0;
    const batch = db.batch();
    snap.docs.forEach(d => {
        if (d.id.startsWith("C1T_")) { batch.delete(d.ref); deleted++; }
    });
    if (deleted > 0) await batch.commit();

    // Reset sopPoints for current year in MongoDB
    const year = new Date().getFullYear();
    const emp = await Employee.findOne({ biometricId: TEST_EMPLOYEE_ID });
    if (emp) {
        emp.sopPoints = (emp.sopPoints || []).filter(sp => sp.year !== year);
        await emp.save();
    }

    // Reset Firestore C1 cache
    await db.collection("cowork_c1_scores").doc(TEST_EMPLOYEE_ID).delete();

    console.log(`\n  ✅ Cleanup done`);
    console.log(`  Deleted ${deleted} test task(s) from Firestore`);
    console.log(`  Cleared sopPoints for year ${year} in MongoDB`);
    console.log(`  Reset cowork_c1_scores cache\n`);
}

// ── Print helpers ─────────────────────────────────────────────────────────────
function printHeader(id, name) {
    console.log(`\n╔══════════════════════════════════════════════════════╗`);
    console.log(`║  Case ${String(id).padEnd(3)}: ${name}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
}

function printBefore(s) {
    console.log(`║  BEFORE`);
    console.log(`║  C1        : ${s.c1Net} / ${s.c1Max}   QR: ${(s.qualityRate * 100).toFixed(1)}%`);
    console.log(`║  SOP Net   : ${sign(s.sopNet)}${s.sopNet} pts   (totalDeducted: ${s.totalDeducted})`);
    console.log(`║  Tasks done: ${s.taskCount}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
}

function printPredicted(pred, c1Max) {
    console.log(`║  PREDICTED`);
    console.log(`║  Task Score: ${fmt(pred.taskScore)}`);
    console.log(`║  New C1    : ${pred.predC1} / ${c1Max}   QR: ${pred.predPct}%`);
    console.log(`║  SOP Δ     : ${sign(pred.sopChange)}${pred.sopChange} pts`);
    console.log(`║  New SOP   : ${sign(pred.predSopNet)}${pred.predSopNet} pts`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
}

function printActual(pred, after, actualScore, taskId) {
    const scoreOk = fmt(actualScore) === fmt(pred.taskScore);
    const c1Ok = String(after.c1Net) === String(pred.predC1);
    const sopOk = String(after.sopNet) === String(pred.predSopNet);

    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  ACTUAL vs PREDICTED`);
    console.log(`║  Task Score│ pred: ${pad(fmt(pred.taskScore))}  actual: ${pad(fmt(actualScore))}  ${scoreOk ? "✅" : "❌"}`);
    console.log(`║  C1 Score  │ pred: ${pad(pred.predC1)}  actual: ${pad(after.c1Net)}  ${c1Ok ? "✅" : "❌"}`);
    console.log(`║  QR        │ pred: ${pad(pred.predPct + "%")}  actual: ${pad((after.qualityRate * 100).toFixed(1) + "%")}`);
    console.log(`║  SOP Net   │ pred: ${pad(pred.predSopNet)}  actual: ${pad(after.sopNet)}  ${sopOk ? "✅" : "❌"}`);
    console.log(`║  totalDeducted now: ${after.totalDeducted}`);
    console.log(`╠══════════════════════════════════════════════════════╣`);
    console.log(`║  Task ID: ${taskId}`);
    console.log(`╚══════════════════════════════════════════════════════╝\n`);
}

function fmt(v) { return v === null || v === undefined ? "null" : String(v); }
function sign(v) { return v >= 0 ? "+" : ""; }
function pad(v) { return String(v).padEnd(10); }

// ── Build Firestore task document ─────────────────────────────────────────────
function buildTaskDoc({ taskId, tc, quarter, year, now }) {
    return {
        taskId,
        title: `[C1-TEST ${taskId}]`,
        description: "C1 interactive test",
        assignedBy: TEST_REVIEWER_ID,
        assignedByName: TEST_REVIEWER_NAME,
        assignedByRole: "tl",
        rootCreatedByRole: "tl",
        assigneeIds: [TEST_EMPLOYEE_ID],
        status: tc.isExcluded ? "cancelled" : "done",
        etcHours: TEST_ETC_HOURS,
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
    };
}

// ── Menu ──────────────────────────────────────────────────────────────────────
function printMenu() {
    console.log("\n─────────────────────────────────────────────────────────────");
    console.log("  STANDARD CASES  (computeAndStoreTaskScore only)");
    console.log("─────────────────────────────────────────────────────────────");
    STANDARD_CASES.forEach(c => {
        const score = calcTaskScore(c);
        console.log(`  ${String(c.id).padStart(2)}. ${c.name.padEnd(28)} score → ${score}`);
    });
    console.log("\n─────────────────────────────────────────────────────────────");
    console.log("  FULL-FLOW CASES  (writeReworkDeduction × N → score)");
    console.log("─────────────────────────────────────────────────────────────");
    FLOW_CASES.forEach(c => {
        console.log(`  ${String(c.id).padStart(2)}. ${c.name}`);
    });
    console.log("\n─────────────────────────────────────────────────────────────");
    console.log("  99. Cleanup (delete test data + reset employee)");
    console.log("   0. Exit");
    console.log("─────────────────────────────────────────────────────────────");
}

// ── Readline helpers ──────────────────────────────────────────────────────────
let rl;
function ask_confirm(prompt) {
    return new Promise(resolve => rl.question(prompt, ans => resolve(ans.trim())));
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n  Connecting to Firebase + MongoDB...");
    await sleep(2000);
    console.log("  ✅ Connected");

    // Load live config
    const realCfg = await c1Svc.getC1Config();
    CFG.baseScore = realCfg.c1BaseScore;
    CFG.deadlineDeduction = realCfg.c1DeadlineDeduction;
    CFG.extensionDeduction = realCfg.c1ExtensionDeduction;
    CFG.reworkDeduction = realCfg.c1ReworkDeduction;
    CFG.rejectScore = realCfg.c1RejectScore;
    CFG.c1Max = realCfg.c1MaxPoints;

    console.log(`\n  ── Config from Firestore ─────────────────────────`);
    console.log(`  Base Score          : ${CFG.baseScore}`);
    console.log(`  Deadline Deduction  : ${CFG.deadlineDeduction}`);
    console.log(`  Extension Deduction : ${CFG.extensionDeduction}`);
    console.log(`  Rework Deduction    : ${CFG.reworkDeduction}`);
    console.log(`  Reject Override     : ${CFG.rejectScore}`);
    console.log(`  C1 Max Points       : ${CFG.c1Max}`);

    const state = await getCurrentState();
    console.log(`\n  ── Current State ─────────────────────────────────`);
    console.log(`  C1       : ${state.c1Net} / ${state.c1Max}   QR: ${(state.qualityRate * 100).toFixed(1)}%`);
    console.log(`  SOP Net  : ${sign(state.sopNet)}${state.sopNet} pts   (totalDeducted stored: ${state.totalDeducted})`);
    console.log(`  Tasks    : ${state.taskCount} completed`);

    rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    const loop = () => {
        printMenu();
        rl.question("\n  Enter case number: ", async input => {
            const num = parseInt(input.trim());
            if (isNaN(num)) { console.log("  ⚠️  Enter a number."); loop(); return; }
            if (num === 0) { console.log("\n  Done.\n"); rl.close(); process.exit(0); }
            if (num === 99) { await runCleanup().catch(e => console.log(`  ❌ ${e.message}`)); loop(); return; }

            const standard = STANDARD_CASES.find(c => c.id === num);
            const flow = FLOW_CASES.find(c => c.id === num);

            if (standard) {
                await runStandard(standard).catch(e => console.log(`\n  ❌ ERROR: ${e.message}\n`));
            } else if (flow) {
                await runFlow(flow).catch(e => console.log(`\n  ❌ ERROR: ${e.message}\n`));
            } else {
                console.log("  ⚠️  Invalid. Try 1–17, 99, or 0.");
            }
            loop();
        });
    };

    loop();
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });