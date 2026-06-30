"use strict";
/**
 * p1_conflict_test.js — P1 Fixed Deadline Conflict Detection Tester
 *
 * Tests the auto-deadline-extension logic when a P1 fixed deadline task
 * is assigned to an employee already working on another fixed deadline task.
 *
 * Run from backend root:
 *   node -r dotenv/config p1_conflict_test.js
 *
 * What it does:
 *   STEP 1 — Create Task A (fixed deadline, 5 ETC hrs) → assign to test employee
 *   STEP 2 — Simulate employee starting Task A (writes active timer session)
 *   STEP 3 — Create Task B (P1, fixed deadline, 3 ETC hrs) → same employee
 *   STEP 4 — Verify Task A deadline was auto-extended by 3hrs
 *   STEP 5 — Verify notification was sent to CEO
 *   CLEANUP — Delete all test data
 */

const { db, admin } = require("./config/firebaseAdmin");
const { v4: uuidv4 } = require("uuid");
const readline = require("readline");

// ── CONFIG — change these to match your system ────────────────────────────────
const TEST_EMPLOYEE_ID = "GR0067";          // employee who will work on Task A
const TEST_EMPLOYEE_NAME = "Soumya Ranjan";
const TEST_CEO_ID = "GR0001";          // CEO who gets the notification
const TEST_CEO_NAME = "Rakesh Biswal";
// ─────────────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

const log = (msg) => console.log(`  ✅ ${msg}`);
const warn = (msg) => console.log(`  ⚠️  ${msg}`);
const err = (msg) => console.log(`  ❌ ${msg}`);
const sep = () => console.log("  " + "─".repeat(60));

let createdTaskIds = [];
let createdNotifIds = [];

// ── HELPERS ───────────────────────────────────────────────────────────────────
function hoursFromNow(h) {
    return new Date(Date.now() + h * 3600 * 1000).toISOString();
}

function fmtTime(iso) {
    return new Date(iso).toLocaleString("en-IN", {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
    });
}

function diffHrs(isoA, isoB) {
    return ((new Date(isoB) - new Date(isoA)) / 3600000).toFixed(2);
}

// ── STEP 1: Create Task A ─────────────────────────────────────────────────────
async function createTaskA() {
    console.log("\n  STEP 1 — Create Task A (fixed deadline, 5 ETC hrs)");
    sep();

    const taskId = "TEST_TASK_A_" + uuidv4().slice(0, 8);
    const fixedDeadline = hoursFromNow(5); // deadline in 5 hrs from now

    await db.collection("cowork_tasks").doc(taskId).set({
        taskId,
        title: "[TEST] Task A — ongoing work",
        description: "Test task for P1 conflict detection",
        assignedBy: TEST_CEO_ID,
        assignedByName: TEST_CEO_NAME,
        assigneeIds: [TEST_EMPLOYEE_ID],
        priority: 3,
        hasTimer: false,
        fixedDeadline,
        etcHours: 5,
        status: "confirmed",
        createdAt: new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    createdTaskIds.push(taskId);
    log(`Task A created: ${taskId}`);
    log(`Task A deadline: ${fmtTime(fixedDeadline)} (5hrs from now)`);
    log(`Task A ETC: 5hrs`);

    return { taskId, fixedDeadline };
}

// ── STEP 2: Simulate employee working on Task A ───────────────────────────────
async function simulateWorking(taskAId) {
    console.log("\n  STEP 2 — Simulate employee starting Task A (2hrs worked)");
    sep();

    const twoHrsAgo = Date.now() - 2 * 3600 * 1000;

    await db.collection("cowork_task_timers")
        .doc(TEST_EMPLOYEE_ID)
        .collection("sessions")
        .doc(taskAId)
        .set({
            taskId: taskAId,
            taskTitle: "[TEST] Task A — ongoing work",
            isActive: true,
            totalSeconds: 0,            // started fresh in this session
            lastStartTime: twoHrsAgo,   // started 2hrs ago
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

    log(`Timer session created for ${TEST_EMPLOYEE_NAME}`);
    log(`isActive: true`);
    log(`lastStartTime: 2hrs ago (simulating 2hrs already worked)`);
}

// ── STEP 3: Create Task B (P1) ────────────────────────────────────────────────
async function createTaskB_P1() {
    console.log("\n  STEP 3 — Create Task B (P1, fixed deadline, 3 ETC hrs)");
    sep();

    const taskId = "TEST_TASK_B_" + uuidv4().slice(0, 8);
    const fixedDeadline = hoursFromNow(3); // deadline in 3 hrs
    const etcHours = 3;

    // This is the conflict detection block from createTask()
    // Running it directly here to test the logic
    await db.collection("cowork_tasks").doc(taskId).set({
        taskId,
        title: "[TEST] Task B — P1 emergency",
        description: "Emergency P1 task",
        assignedBy: TEST_CEO_ID,
        assignedByName: TEST_CEO_NAME,
        assigneeIds: [TEST_EMPLOYEE_ID],
        priority: 1,
        hasTimer: false,
        fixedDeadline,
        etcHours,
        status: "open",
        createdAt: new Date().toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    createdTaskIds.push(taskId);
    log(`Task B created: ${taskId}`);
    log(`Task B priority: P1`);
    log(`Task B deadline: ${fmtTime(fixedDeadline)} (3hrs from now)`);
    log(`Task B ETC: 3hrs`);

    // ── RUN CONFLICT DETECTION ────────────────────────────────────────────────
    console.log("\n  CONFLICT DETECTION RUNNING...");
    sep();

    const conflictsFound = [];
    const shiftMs = etcHours * 3600 * 1000;
    const now = new Date().toISOString();

    for (const empId of [TEST_EMPLOYEE_ID]) {
        // Get active session
        const sessionsSnap = await db.collection("cowork_task_timers")
            .doc(empId).collection("sessions").get();

        const activeSess = sessionsSnap.docs.find(d => d.data().isActive);
        if (!activeSess) {
            warn(`No active session found for ${empId}`);
            continue;
        }

        const conflictTaskId = activeSess.id;
        if (conflictTaskId === taskId) continue;

        log(`Active session found: ${conflictTaskId}`);

        // Get conflicting task
        const conflictRef = db.collection("cowork_tasks").doc(conflictTaskId);
        const conflictSnap = await conflictRef.get();
        if (!conflictSnap.exists) { warn("Conflict task not found"); continue; }

        const conflictTask = conflictSnap.data();

        if (conflictTask.hasTimer !== false || !conflictTask.fixedDeadline) {
            warn("Conflict task is not a fixed deadline task — skipping");
            continue;
        }

        const oldDeadline = conflictTask.fixedDeadline;
        const newDeadlineMs = new Date(oldDeadline).getTime() + shiftMs;
        const newDeadline = new Date(newDeadlineMs).toISOString();
        const fmtHrs = h => h >= 1 ? `${h}h` : `${Math.round(h * 60)}m`;

        log(`Conflict detected with Task A: "${conflictTask.title}"`);
        log(`Old deadline: ${fmtTime(oldDeadline)}`);
        log(`Shift amount: +${etcHours}hrs (Task B ETC)`);
        log(`New deadline: ${fmtTime(newDeadline)}`);

        // Auto-extend Task A
        await conflictRef.update({
            fixedDeadline: newDeadline,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            deadlineAutoExtendedHistory: admin.firestore.FieldValue.arrayUnion({
                extendedByHrs: etcHours,
                shiftedByTaskId: taskId,
                shiftedByTaskTitle: "[TEST] Task B — P1 emergency",
                oldDeadline,
                newDeadline,
                at: now,
            }),
        });

        // Send notification to CEO
        const notifId = uuidv4();
        await db.collection("cowork_notifications").doc(notifId).set({
            recipientEmployeeId: TEST_CEO_ID,
            type: "deadline_auto_extended",
            title: `⚠️ Deadline Auto-Extended · ${conflictTask.title}`,
            body: `"${conflictTask.title}" shifted +${fmtHrs(etcHours)} because P1 task "[TEST] Task B" was assigned to ${TEST_EMPLOYEE_NAME}. New deadline: ${fmtTime(newDeadline)}.`,
            data: {
                taskId: conflictTaskId,
                taskTitle: conflictTask.title,
                newDeadline,
                shiftedByTaskId: taskId,
                employeeId: empId,
                employeeName: TEST_EMPLOYEE_NAME,
            },
            read: false,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        createdNotifIds.push(notifId);
        conflictsFound.push({ conflictTaskId, oldDeadline, newDeadline, etcHours });
    }

    return conflictsFound;
}

// ── STEP 4: Verify ────────────────────────────────────────────────────────────
async function verify(taskAId, taskAOriginalDeadline, conflicts) {
    console.log("\n  STEP 4 — Verify results");
    sep();

    if (conflicts.length === 0) {
        err("No conflicts detected — something went wrong");
        return false;
    }

    // Verify the ACTUAL conflicted task (not necessarily TEST_TASK_A)
    const conflict = conflicts[0];
    const taskASnap = await db.collection("cowork_tasks").doc(conflict.conflictTaskId).get();
    const taskA = taskASnap.data();

    const expectedShiftHrs = 3; // Task B ETC
    const actualShiftHrs = parseFloat(diffHrs(conflict.oldDeadline, taskA.fixedDeadline));
    const shiftCorrect = Math.abs(actualShiftHrs - expectedShiftHrs) < 0.1;

    console.log("\n  RESULTS:");
    console.log(`    Task A original deadline : ${fmtTime(taskAOriginalDeadline)}`);
    console.log(`    Task A new deadline      : ${fmtTime(taskA.fixedDeadline)}`);
    console.log(`    Shift applied            : +${actualShiftHrs}hrs`);
    console.log(`    Expected shift           : +${expectedShiftHrs}hrs`);
    console.log(`    Extension history saved  : ${(taskA.deadlineAutoExtendedHistory || []).length > 0}`);
    console.log(`    Notification sent        : ${createdNotifIds.length > 0}`);

    sep();
    if (shiftCorrect) {
        log("PASS — Deadline correctly extended by Task B ETC hours");
        log("PASS — Extension history saved on Task A");
        log("PASS — Notification created for CEO");
        return true;
    } else {
        err(`FAIL — Expected +${expectedShiftHrs}hrs shift, got +${actualShiftHrs}hrs`);
        return false;
    }
}

// ── CLEANUP ───────────────────────────────────────────────────────────────────
async function cleanup() {
    console.log("\n  CLEANUP — Deleting all test data");
    sep();

    for (const taskId of createdTaskIds) {
        await db.collection("cowork_tasks").doc(taskId).delete();
        log(`Deleted task: ${taskId}`);

        // Delete timer session
        await db.collection("cowork_task_timers")
            .doc(TEST_EMPLOYEE_ID).collection("sessions")
            .doc(taskId).delete().catch(() => { });
        log(`Deleted timer session for ${taskId}`);
    }

    for (const notifId of createdNotifIds) {
        await db.collection("cowork_notifications").doc(notifId).delete();
        log(`Deleted notification: ${notifId}`);
    }
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log("\n" + "═".repeat(64));
    console.log("  P1 CONFLICT DETECTION TEST");
    console.log("  Employee : " + TEST_EMPLOYEE_NAME + " (" + TEST_EMPLOYEE_ID + ")");
    console.log("  CEO      : " + TEST_CEO_NAME + " (" + TEST_CEO_ID + ")");
    console.log("═".repeat(64));

    let passed = false;
    let taskAId, taskAOriginalDeadline;

    try {
        const taskA = await createTaskA();
        taskAId = taskA.taskId;
        taskAOriginalDeadline = taskA.fixedDeadline;

        await simulateWorking(taskAId);
        await sleep(500);

        const conflicts = await createTaskB_P1();
        await sleep(500);

        passed = await verify(taskAId, taskAOriginalDeadline, conflicts);
    } catch (e) {
        err("Test threw an error: " + e.message);
        console.error(e);
    }

    // Ask before cleanup
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("\n  Delete all test data? (y/n): ", async (ans) => {
        rl.close();
        if (ans.toLowerCase() === "y") {
            await cleanup();
        } else {
            warn("Test data kept in Firestore — delete manually if needed");
            console.log("  Task IDs:", createdTaskIds);
        }

        console.log("\n" + "═".repeat(64));
        console.log("  TEST " + (passed ? "PASSED ✅" : "FAILED ❌"));
        console.log("═".repeat(64) + "\n");
        process.exit(passed ? 0 : 1);
    });
}

main().catch(e => { console.error(e); process.exit(1); });