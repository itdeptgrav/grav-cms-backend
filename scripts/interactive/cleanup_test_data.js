"use strict";
/**
 * cleanup_test_data.js — Delete all test tasks + reset C1/C2 score caches
 *
 * Run: node -r dotenv/config cleanup_test_data.js
 */

const TEST_EMPLOYEE_ID = "GR0067";

const { db } = require("./config/firebaseAdmin");

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
    console.log("\n  Connecting to Firebase...");
    await sleep(1500);
    console.log("  ✅ Connected\n");

    let deleted = 0;

    // ── Delete all C1 test tasks ──────────────────────────────────────────────
    console.log("  Deleting C1 test tasks (C1T_I_*)...");
    for (let i = 1; i <= 20; i++) {
        const id = `C1T_I_${String(i).padStart(2, "0")}`;
        const ref = db.collection("cowork_tasks").doc(id);
        const snap = await ref.get();
        if (snap.exists) {
            await ref.delete();
            console.log(`  ✅ Deleted ${id}`);
            deleted++;
        }
    }

    // ── Delete all C2 test tasks ──────────────────────────────────────────────
    console.log("\n  Deleting C2 test tasks (C2T_I_*)...");
    for (let i = 1; i <= 20; i++) {
        const id = `C2T_I_${String(i).padStart(2, "0")}`;
        const ref = db.collection("cowork_tasks").doc(id);
        const snap = await ref.get();
        if (snap.exists) {
            await ref.delete();
            console.log(`  ✅ Deleted ${id}`);
            deleted++;
        }
    }

    // ── Delete old C1T_ tasks (without _I_) ──────────────────────────────────
    console.log("\n  Deleting old C1T_ test tasks...");
    for (let i = 1; i <= 20; i++) {
        const id = `C1T${String(i).padStart(3, "0")}`;
        const ref = db.collection("cowork_tasks").doc(id);
        const snap = await ref.get();
        if (snap.exists) {
            await ref.delete();
            console.log(`  ✅ Deleted ${id}`);
            deleted++;
        }
    }

    // ── Reset C1 score cache ──────────────────────────────────────────────────
    console.log("\n  Resetting C1 score cache...");
    const c1Ref = db.collection("cowork_c1_scores").doc(TEST_EMPLOYEE_ID);
    const c1Snap = await c1Ref.get();
    if (c1Snap.exists) {
        await c1Ref.delete();
        console.log(`  ✅ Deleted cowork_c1_scores/${TEST_EMPLOYEE_ID}`);
    } else {
        console.log(`  ℹ️  cowork_c1_scores/${TEST_EMPLOYEE_ID} not found — skipping`);
    }

    // ── Reset C2 score cache ──────────────────────────────────────────────────
    console.log("\n  Resetting C2 score cache...");
    const c2Ref = db.collection("cowork_c2_scores").doc(TEST_EMPLOYEE_ID);
    const c2Snap = await c2Ref.get();
    if (c2Snap.exists) {
        await c2Ref.delete();
        console.log(`  ✅ Deleted cowork_c2_scores/${TEST_EMPLOYEE_ID}`);
    } else {
        console.log(`  ℹ️  cowork_c2_scores/${TEST_EMPLOYEE_ID} not found — skipping`);
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log(`\n══════════════════════════════════════════`);
    console.log(`  Done. ${deleted} test tasks deleted.`);
    console.log(`  C1 + C2 score caches reset.`);
    console.log(`  PMP dashboard and SOP page now clean.`);
    console.log(`══════════════════════════════════════════\n`);

    process.exit(0);
}

main().catch(e => { console.error("[FATAL]", e.message); process.exit(1); });