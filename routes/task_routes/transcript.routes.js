/**
 * routes/task_routes/transcript.routes.js
 *
 * REGISTER in server.js:
 *   const transcriptCron = require("./routes/task_routes/transcript.routes");
 *   app.use("/cowork", transcriptCron.router);
 *   transcriptCron.startCron(); // start the auto-delete cron
 *
 * ENDPOINTS:
 *   POST /cowork/transcript/save   → Save meeting transcript (called when meeting ends)
 *   GET  /cowork/transcript/:meetId → Get transcript for a meeting
 *
 * FIRESTORE STRUCTURE:
 *   meeting_transcripts/{meetId}
 *     meetId:     string
 *     meetTitle:  string
 *     meetDate:   string  (e.g. "2026-04-02")
 *     savedAt:    Timestamp
 *     deleteAt:   Timestamp  (savedAt + 24 hours)
 *     lines: [
 *       { name: "CEO", text: "Good morning everyone", time: "09:00 AM" },
 *       { name: "OMM", text: "Hello sir",             time: "09:01 AM" },
 *       ...
 *     ]
 *
 * NODE-CRON:
 *   Runs every hour.
 *   Deletes any document where deleteAt <= now.
 *   So if meeting was on 13th, deleteAt = 14th same time → deleted on 14th.
 */

const express = require("express");
const router = express.Router();
const cron = require("node-cron");
const { db } = require("../../config/firebaseAdmin");
const {
    verifyCoworkToken,
    verifyEmployeeToken,
    verifyCeoToken,
} = require("../../Middlewear/coworkAuth");

const COLLECTION = "meeting_transcripts";

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/transcript/save
// Called by frontend when meeting ends (or CEO clicks Download).
// Saves full transcript with a 24-hour TTL.
// Body: { meetId, meetTitle, meetDate, lines: [{name, text, time}] }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/transcript/save",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { meetId, meetTitle, meetDate, lines } = req.body;

            if (!meetId || !lines || !Array.isArray(lines)) {
                return res.status(400).json({ error: "meetId and lines[] are required" });
            }

            if (lines.length === 0) {
                return res.status(400).json({ error: "Transcript is empty — nothing to save" });
            }

            const now = new Date();
            const deleteAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // +24 hours

            const docData = {
                meetId,
                meetTitle: meetTitle || "CoWork Meeting",
                meetDate: meetDate || now.toISOString().split("T")[0],
                savedAt: now.toISOString(),
                deleteAt: deleteAt.toISOString(),  // ISO string for easy comparison
                deleteAtMs: deleteAt.getTime(),      // ms timestamp for cron query
                savedBy: req.coworkUser?.name || req.coworkUser?.employeeId || "unknown",
                lineCount: lines.length,
                lines,
            };

            // Use meetId as document ID so saving twice = upsert (no duplicates)
            await db.collection(COLLECTION).doc(meetId).set(docData);

            console.log(`[Transcript] Saved ${lines.length} lines for meeting ${meetId}. Deletes at ${deleteAt.toISOString()}`);

            return res.json({
                success: true,
                meetId,
                lineCount: lines.length,
                deleteAt: deleteAt.toISOString(),
                message: `Transcript saved. Auto-deletes on ${deleteAt.toLocaleDateString("en-IN")} at ${deleteAt.toLocaleTimeString("en-IN")}`,
            });

        } catch (err) {
            console.error("[Transcript] Save error:", err);
            return res.status(500).json({ error: err.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/transcript/:meetId
// Fetch transcript for a specific meeting.
// Returns 404 if expired/deleted.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    "/transcript/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { meetId } = req.params;
            const doc = await db.collection(COLLECTION).doc(meetId).get();

            if (!doc.exists) {
                return res.status(404).json({ error: "Transcript not found or already deleted" });
            }

            const data = doc.data();

            // Double-check: if expired, delete now and return 404
            if (data.deleteAtMs && Date.now() > data.deleteAtMs) {
                await db.collection(COLLECTION).doc(meetId).delete();
                return res.status(404).json({ error: "Transcript has expired and been deleted" });
            }

            return res.json({ success: true, transcript: data });

        } catch (err) {
            console.error("[Transcript] Fetch error:", err);
            return res.status(500).json({ error: err.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// NODE-CRON: Auto-delete expired transcripts
//
// Schedule: every hour at minute 0  →  "0 * * * *"
// Finds all documents where deleteAtMs <= Date.now() and deletes them.
// Firestore batch delete (max 500 per batch — transcripts won't hit this limit).
// ─────────────────────────────────────────────────────────────────────────────
function startCron() {
    // Run every hour
    cron.schedule("0 * * * *", async () => {
        console.log("[TranscriptCron] Running cleanup at", new Date().toISOString());

        try {
            const now = Date.now();
            const snapshot = await db
                .collection(COLLECTION)
                .where("deleteAtMs", "<=", now)
                .get();

            if (snapshot.empty) {
                console.log("[TranscriptCron] No expired transcripts to delete.");
                return;
            }

            // Batch delete (Firestore max 500 per batch)
            const batch = db.batch();
            let count = 0;

            snapshot.forEach((doc) => {
                console.log(`[TranscriptCron] Deleting transcript: ${doc.id} (expired ${doc.data().deleteAt})`);
                batch.delete(doc.ref);
                count++;
            });

            await batch.commit();
            console.log(`[TranscriptCron] Deleted ${count} expired transcript(s).`);

        } catch (err) {
            console.error("[TranscriptCron] Cleanup error:", err);
        }
    });

    console.log("[TranscriptCron] Auto-delete cron started — runs every hour.");
}

module.exports = { router, startCron };