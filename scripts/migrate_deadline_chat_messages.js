#!/usr/bin/env node
/* eslint-disable no-console */
// =============================================================================
// One-time migration: rewrite stale wall-clock deadline chat messages
// =============================================================================
//
// Problem we are fixing
// ---------------------
// Under the old backend, the draft-chat and task-chat system messages for the
// deadline propose/counter/approve/accept flow stored a wall-clock timestamp:
//
//   "📅 Admin CEO suggested a new deadline: 21 Apr 2026, 10:11 am"
//
// Under the new live-deadline model the countdown only starts when the employee
// presses Play — so a fixed wall-clock time like "10:11 am" becomes misleading
// within minutes of being written.
//
// The backend has since been updated so NEW messages use a duration form like
//   "📅 Admin CEO suggested a new deadline: 2h to complete"
//
// But historical messages already sitting in Firestore still carry the old
// wall-clock text. This script rewrites them in place.
//
// Source of truth for the duration value
// --------------------------------------
// We do not re-parse the timestamp out of the message text — we use the
// authoritative field on the task document:
//
//   task.deadlineWindowSecs        ← approved / accepted messages
//   task.tlCounterWindowSecs       ← counter messages (if present)
//   (proposed duration falls back to tlCounterWindowSecs or deadlineWindowSecs)
//
// If the task document has been deleted or both fields are missing, that single
// message is skipped (logged) and the rest of the migration continues.
//
// Safety
// ------
// - Preserves the senderId / senderName / createdAt / messageType of every
//   message. Only the `text` field is rewritten.
// - Backs up the original text to a new `legacyText` field on each rewritten
//   doc, so you can roll back by running the inverse migration if needed.
// - Idempotent: running a second time is a no-op because the regexes no longer
//   match the new form.
// - Dry run by default. Pass --apply to actually write.
//
// Usage
// -----
//   cd grav-cms-backend
//   node scripts/migrate_deadline_chat_messages.js            # dry run
//   node scripts/migrate_deadline_chat_messages.js --apply    # write
//
// Requirements:
//   - Run from the backend root (so ../config/firebaseAdmin resolves).
//   - .env with FIREBASE_SERVICE_ACCOUNT must exist next to package.json.
//   - dotenv must be installed (it's already a dep of the main server).
// =============================================================================

const path = require("path");

// Load .env from the backend root so FIREBASE_SERVICE_ACCOUNT is available.
// (The main server does this via its own startup; standalone scripts must.)
try {
    require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
} catch {
    // dotenv not installed — that's okay if the env vars are already in the shell
}

// Reuse the backend's firebase init. Path matches grav-cms-backend/config/firebaseAdmin.js
let admin, db;
try {
    const fb = require(path.join(__dirname, "..", "config", "firebaseAdmin"));
    admin = fb.admin;
    db = fb.db;
} catch (e) {
    console.error("Could not load backend firebase init at ../config/firebaseAdmin.");
    console.error("Make sure this script is at backend/scripts/migrate_deadline_chat_messages.js");
    console.error("and that your .env contains FIREBASE_SERVICE_ACCOUNT.");
    console.error(e.message);
    process.exit(1);
}

const APPLY = process.argv.includes("--apply");

// ─── Duration formatter (matches backend _fmtDurationChat exactly) ────────────
function fmtDuration(secs) {
    if (!Number.isFinite(secs) || secs <= 0) return "?";
    const s = Math.round(secs);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) {
        const h = Math.floor(s / 3600);
        const m = Math.round((s % 3600) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }
    const days = Math.round(s / 86400);
    return days === 1 ? "1 day" : `${days} days`;
}



// One-time repair script — run once, then delete
const { db } = require("./config/firebaseAdmin");

async function repairDeadlineWindowSecs() {
    const snap = await db.collection("cowork_tasks")
        .where("status", "==", "pending_deadline_approval")
        .get();

    for (const doc of snap.docs) {
        const t = doc.data();
        const original = Number(t.originalWindowSecs) || 0;
        const extTotal = (t.extensions || [])
            .reduce((s, e) => s + (Number(e.addedSecs) || 0), 0);
        const correct = original + extTotal;

        if (correct > 0 && correct !== Number(t.deadlineWindowSecs)) {
            console.log(`Fixing ${doc.id}: ${t.deadlineWindowSecs} → ${correct}`);
            await doc.ref.update({ deadlineWindowSecs: correct });
        }
    }
    console.log("Done.");
}

repairDeadlineWindowSecs();

// ─── Regex patterns that identify stale messages ──────────────────────────────
// We match the exact prefixes written by the old backend, followed by a
// wall-clock substring (something like "21 Apr 2026, 10:11 am").
//
// The key identifier is the "<date>, <time> am|pm" shape. If that substring
// isn't present, the message is already in the new form or isn't one of ours.
const WALL_CLOCK_RE = /\d{1,2}\s+\w{3,}\s+\d{4},\s+\d{1,2}:\d{2}\s*(?:am|pm)/i;

const PATTERNS = [
    {
        // "📅 Alice proposed deadline: 21 Apr 2026, 10:11 am"
        test: /proposed deadline:\s*/i,
        rewrite: (text, task) => {
            const secs = task.deadlineWindowSecs || task.tlCounterWindowSecs;
            if (!secs) return null;
            return text.replace(
                /(proposed deadline:\s*)(.+?)(?:\s*$|\s*—)/i,
                `$1${fmtDuration(secs)} to complete`
            );
        },
    },
    {
        // "📅 Admin CEO suggested a new deadline: 21 Apr 2026, 10:11 am — \"msg\""
        test: /suggested a new deadline:\s*/i,
        rewrite: (text, task) => {
            const secs = task.tlCounterWindowSecs || task.deadlineWindowSecs;
            if (!secs) return null;
            // Preserve trailing — "message" part if present
            const trailing = text.match(/—\s*".*"\s*$/);
            const tail = trailing ? ` ${trailing[0]}` : "";
            return text.replace(
                /(suggested a new deadline:\s*)(.+?)(\s*—\s*".*"\s*$|\s*$)/i,
                `$1${fmtDuration(secs)} to complete${tail}`
            );
        },
    },
    {
        // "✅ Alice approved the deadline: 21 Apr 2026, 10:11 am. You can now confirm..."
        test: /approved the deadline:\s*/i,
        rewrite: (text, task) => {
            const secs = task.deadlineWindowSecs;
            if (!secs) return null;
            return text.replace(
                /(approved the deadline:\s*)([^.]+?)(\.|$)/i,
                `$1${fmtDuration(secs)} to complete$3`
            );
        },
    },
    {
        // "✅ Alice accepted the deadline: 21 Apr 2026, 10:11 am"
        test: /accepted the deadline:\s*/i,
        rewrite: (text, task) => {
            const secs = task.deadlineWindowSecs;
            if (!secs) return null;
            return text.replace(
                /(accepted the deadline:\s*)(.+?)(\s*$)/i,
                `$1${fmtDuration(secs)} to complete$3`
            );
        },
    },
];

// ─── Scan + rewrite a single subcollection ────────────────────────────────────
async function processSubcollection(taskDoc, subName) {
    const task = taskDoc.data();
    const snap = await taskDoc.ref.collection(subName).get();
    let rewritten = 0;
    let skipped = 0;

    for (const msg of snap.docs) {
        const d = msg.data();
        const text = d.text || "";
        if (!text || !WALL_CLOCK_RE.test(text)) continue;
        const pattern = PATTERNS.find(p => p.test.test(text));
        if (!pattern) continue;

        const next = pattern.rewrite(text, task);
        if (!next || next === text) {
            skipped++;
            continue;
        }

        if (APPLY) {
            await msg.ref.update({
                text: next,
                legacyText: text,
                migratedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
        }

        console.log(
            `  ${APPLY ? "REWROTE" : "WOULD REWRITE"}  [${subName}/${msg.id}]`
        );
        console.log(`    FROM: ${text}`);
        console.log(`    TO  : ${next}`);
        rewritten++;
    }

    return { rewritten, skipped };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
    console.log(`[migrate] mode: ${APPLY ? "APPLY (will write)" : "DRY RUN"}`);
    const tasks = await db.collection("cowork_tasks").get();
    console.log(`[migrate] scanning ${tasks.size} tasks...`);

    let totalRewritten = 0;
    let totalSkipped = 0;
    let tasksTouched = 0;

    for (const t of tasks.docs) {
        // Subcollection names MUST match what sendTaskChat / sendDraftChat actually write to:
        //   sendTaskChat  → "chat"
        //   sendDraftChat → "draft_chat"
        const r1 = await processSubcollection(t, "draft_chat");
        const r2 = await processSubcollection(t, "chat");
        const touched = r1.rewritten + r2.rewritten;
        if (touched > 0) {
            tasksTouched++;
            console.log(`[migrate] task ${t.id} ("${t.data().title || "?"}") → ${touched} msg(s)`);
        }
        totalRewritten += r1.rewritten + r2.rewritten;
        totalSkipped += r1.skipped + r2.skipped;
    }

    console.log("");
    console.log("─────────────────────────────────────");
    console.log(`[migrate] tasks touched : ${tasksTouched}`);
    console.log(`[migrate] messages ${APPLY ? "rewritten" : "would rewrite"}: ${totalRewritten}`);
    console.log(`[migrate] messages skipped (no window data on task): ${totalSkipped}`);
    console.log(`[migrate] done.`);
    process.exit(0);
})().catch(e => {
    console.error("[migrate] FATAL:", e);
    process.exit(1);
});