/**
 * scripts/verifyTimerSop.js
 *
 * Proves the timer -> deficit/overtime -> SOP points pipeline actually
 * writes to YOUR real MongoDB, not a stub. Run this from your backend
 * root directory (same place server.js lives), so it picks up your real
 * .env and real Firestore service account automatically.
 *
 * USAGE:
 *   node scripts/verifyTimerSop.js E018
 *                                  ^^^^ the employeeId to test (required)
 *
 * WHAT IT DOES, IN ORDER:
 *   1. Connects to your real MongoDB (same MONGODB_URI your server uses).
 *   2. Reads that employee's CURRENT state directly from Mongo — before
 *      touching anything. Prints it.
 *   3. Calls the REAL evaluateTimerSop(employeeId, name, { forceToday: true })
 *      — the exact function your server calls, forced to finalize today
 *      immediately instead of waiting for office hours to end.
 *   4. Disconnects, then RECONNECTS and does a FRESH, independent read
 *      from Mongo — not trusting the function's return value, actually
 *      going back to the database and asking again. If the write didn't
 *      really persist, this step catches it even if step 3 looked fine.
 *   5. Prints a clear before -> after diff and a PASS/FAIL line.
 *
 * WARNING: THIS WRITES REAL DATA. Pass a TEST employee's ID, not someone's
 *   real record, unless you're fine with a real point change landing on
 *   them. If you don't have a dedicated test employee, create one via the
 *   normal "add employee" flow first and use that ID here.
 *
 * WARNING: This forces TODAY to finalize immediately, bypassing the normal
 *   "wait for office hours to end" rule. That rule exists to stop a day
 *   being judged before it's over — you're deliberately bypassing it here,
 *   only for this test.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Employee = require("../models/Employee");
const { evaluateTimerSop } = require("../services/timerSop.service");

const employeeId = process.argv[2];

if (!employeeId) {
    console.error("\nUsage: node scripts/verifyTimerSop.js <employeeId>");
    console.error("Example: node scripts/verifyTimerSop.js E018\n");
    process.exit(1);
}

function snapshot(emp) {
    if (!emp) return null;
    const year = new Date().getFullYear();
    const yearEntry = (emp.sopPoints || []).find(y => y.year === year) || { totalDeducted: 0, bleaches: [] };
    return {
        timerDeficitAccumHrs: emp.timerDeficitAccumHrs || 0,
        timerOvertimeAccumHrs: emp.timerOvertimeAccumHrs || 0,
        lastFinalizedDate: emp.lastFinalizedDate || null,
        totalDeductedThisYear: yearEntry.totalDeducted || 0,
        bleachCountThisYear: (yearEntry.bleaches || []).length,
        timerBleachCount: (yearEntry.bleaches || []).filter(b => b.type === "C4" && b.folderName === "Time Tracking").length,
    };
}

function printSnap(label, s) {
    if (!s) { console.log(`${label}: EMPLOYEE NOT FOUND`); return; }
    console.log(`${label}:`);
    console.log(`  deficit accumulator   : ${s.timerDeficitAccumHrs}h`);
    console.log(`  overtime accumulator  : ${s.timerOvertimeAccumHrs}h`);
    console.log(`  lastFinalizedDate     : ${s.lastFinalizedDate}`);
    console.log(`  totalDeducted (${new Date().getFullYear()})  : ${s.totalDeductedThisYear} pts`);
    console.log(`  timer-tagged bleaches : ${s.timerBleachCount}`);
}

async function main() {
    console.log(`\n=== Verifying timer SOP engine for employeeId=${employeeId} ===\n`);

    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");
    console.log("Connected to MongoDB.\n");

    const before = await Employee.findOne({ biometricId: employeeId });
    if (!before) {
        console.error(`No Employee found with biometricId="${employeeId}". Check the ID and try again.`);
        await mongoose.disconnect();
        process.exit(1);
    }
    const beforeSnap = snapshot(before);
    printSnap("BEFORE", beforeSnap);

    console.log("\nCalling evaluateTimerSop(forceToday: true) — the real function, forced...\n");
    const name = [before.firstName, before.lastName].filter(Boolean).join(" ") || employeeId;
    const result = await evaluateTimerSop(employeeId, name, { forceToday: true });
    console.log("Function returned:");
    console.log(JSON.stringify(result, null, 2));

    // Disconnect and reconnect — force a genuinely fresh read, not a cached
    // document still sitting in memory from the same connection.
    await mongoose.disconnect();
    await mongoose.connect(process.env.MONGODB_URI || "mongodb://localhost:27017/grav_clothing");

    const after = await Employee.findOne({ biometricId: employeeId });
    const afterSnap = snapshot(after);
    console.log("");
    printSnap("AFTER (independent re-read from Mongo)", afterSnap);

    console.log("\n=== RESULT ===");
    const pointsChanged = afterSnap.totalDeductedThisYear !== beforeSnap.totalDeductedThisYear;
    const bleachAdded = afterSnap.timerBleachCount > beforeSnap.timerBleachCount;

    if (!result?.ok) {
        console.log(`FAILED: function did not run successfully: ${result?.reason || "unknown"} ${result?.message || ""}`);
    } else if (result.bleachesApplied?.length > 0 && pointsChanged && bleachAdded) {
        console.log(`CONFIRMED END TO END. ${result.bleachesApplied.length} point event(s) applied.`);
        console.log(`   totalDeducted: ${beforeSnap.totalDeductedThisYear} -> ${afterSnap.totalDeductedThisYear}`);
        console.log(`   Read back from MongoDB independently, not just trusted from the function's return value.`);
    } else if (result.bleachesApplied?.length === 0 && !pointsChanged) {
        console.log(`Function ran fine, but no threshold was crossed today for this employee — nothing SHOULD have changed, and nothing did. That's correct behavior for their actual numbers, not proof of a bug or of it working.`);
    } else {
        console.log(`MISMATCH — function says one thing, Mongo shows another. This is the actual bug signature to bring back: paste this entire output.`);
    }

    await mongoose.disconnect();
    console.log("\nDone.\n");
}

main().catch(e => {
    console.error("\nSCRIPT ERROR:", e);
    process.exit(1);
});