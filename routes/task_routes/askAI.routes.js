/**
 * grav-backend/routes/task_routes/askAI.routes.js
 *
 * REGISTER in server.js (add ONE line alongside your existing routes):
 *   app.use("/cowork", require("./routes/task_routes/askAI.routes"));
 *
 * ENDPOINT:
 *   POST /cowork/audio/ask/:meetId
 *   Body: { question: string }
 *
 * FLOW:
 *   1. Validate the user's question
 *   2. Pull all audio recording metadata from Firestore (meeting_audio_recordings)
 *   3. Download each audio file from Google Drive (same logic as meetingSummary.routes.js)
 *   4. Send audio files + user's question to Gemini
 *   5. Return Gemini's plain-text answer
 *
 * NOTE: Each question is independent — no memory/history is kept between calls.
 *       This mirrors the behaviour described in the product spec.
 */

const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const { db } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");

// ── Gemini config — same models + base as meetingSummary.routes.js ────────────
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const MODELS_TO_TRY = [
    "gemini-3-flash-preview",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
];

// ── Google Drive client (identical to meetingSummary.routes.js) ───────────────
function getDriveClient() {
    const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
    if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
    let key;
    try { key = JSON.parse(keyJson); } catch { throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY invalid JSON"); }
    if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, "\n");
    return google.drive({
        version: "v3",
        auth: new google.auth.GoogleAuth({
            credentials: { client_email: key.client_email, private_key: key.private_key },
            scopes: ["https://www.googleapis.com/auth/drive"],
        }),
    });
}

// ── Download audio from Google Drive (identical to meetingSummary.routes.js) ──
async function downloadFromDrive(fileId) {
    const drive = getDriveClient();
    const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
}

// ── Call Gemini — tries each model until one works (same logic) ───────────────
async function callGemini(apiKey, parts) {
    let lastError = null;
    for (const modelName of MODELS_TO_TRY) {
        try {
            console.log(`[AskAI] Trying model: ${modelName}`);
            const url = `${GEMINI_BASE}/${modelName}:generateContent?key=${apiKey}`;
            const body = {
                contents: [{ parts }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
            };
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const msg = err?.error?.message || `HTTP ${res.status}`;
                console.warn(`[AskAI] ${modelName} failed: ${msg}`);
                lastError = new Error(msg);
                continue;
            }

            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
                console.warn(`[AskAI] ${modelName} returned empty content`);
                lastError = new Error("Empty response from Gemini");
                continue;
            }

            console.log(`[AskAI] ✅ Got response from ${modelName} (${text.length} chars)`);
            return text;
        } catch (e) {
            console.warn(`[AskAI] ${modelName} error:`, e.message);
            lastError = e;
        }
    }
    throw lastError || new Error("All Gemini models failed");
}

// ── Build the Ask AI prompt ───────────────────────────────────────────────────
// Each audio file contains only one person's voice.
// We tell Gemini who the participants are and what the user wants to know.
function buildAskPrompt(participantNames, question) {
    const names = participantNames.join(", ");
    return `These are individual voice recording files from a single meeting.
Each audio file contains ONLY ONE person's voice.
The participants in this meeting are: ${names}.

Listen carefully to ALL audio files. Then answer the following question based ONLY on what was actually said in the recordings:

QUESTION: ${question}

Rules:
- Answer in clear, concise English.
- If the question asks about a specific person, focus on what that person said.
- If the audio is in Hindi, Odia, or a mixed language, translate relevant parts to English in your answer.
- If the answer cannot be found in the audio, say so clearly — do not guess or invent information.
- Do not repeat the question back. Give a direct, helpful answer.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/audio/ask/:meetId
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/audio/ask/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { meetId } = req.params;
            const { question } = req.body;

            // ── Validate input ────────────────────────────────────────────────
            if (!question || typeof question !== "string" || question.trim().length === 0) {
                return res.status(400).json({ error: "A question is required." });
            }
            if (question.trim().length > 500) {
                return res.status(400).json({ error: "Question is too long. Keep it under 500 characters." });
            }

            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });

            // ── Fetch audio records from Firestore ────────────────────────────
            const snap = await db
                .collection("meeting_audio_recordings")
                .where("meetId", "==", meetId)
                .get();

            if (snap.empty) {
                return res.status(404).json({
                    error: "No audio recordings found for this meeting. Record and finalize a meeting first.",
                });
            }

            const recordings = snap.docs.map(d => d.data());
            console.log(`[AskAI] Processing ${recordings.length} audio file(s) for meetId=${meetId}`);

            // ── Download audio files from Google Drive ────────────────────────
            const audioParts = [];
            const participantNames = [];

            for (const rec of recordings) {
                try {
                    console.log(`[AskAI] Downloading: ${rec.fileName}`);
                    const buffer = await downloadFromDrive(rec.driveFileId);

                    if (buffer.length < 1000) {
                        console.warn(`[AskAI] Skipping ${rec.fileName} — too small (${buffer.length} bytes)`);
                        continue;
                    }

                    // Limit to 19MB per file (Gemini inline limit)
                    const trimmed = buffer.length > 19 * 1024 * 1024
                        ? buffer.slice(0, 19 * 1024 * 1024)
                        : buffer;

                    audioParts.push({
                        inlineData: {
                            data: trimmed.toString("base64"),
                            mimeType: rec.mimeType || "audio/webm",
                        },
                    });

                    participantNames.push(rec.employeeName || rec.firstName || rec.employeeId);
                    console.log(`[AskAI] ✅ Downloaded ${rec.fileName} (${(buffer.length / 1024).toFixed(0)} KB)`);
                } catch (e) {
                    console.error(`[AskAI] Failed to download ${rec.fileName}:`, e.message);
                    // Non-fatal — continue with remaining files
                }
            }

            if (audioParts.length === 0) {
                return res.status(400).json({
                    error: "Could not download any audio files from Google Drive. Please check your Drive permissions.",
                });
            }

            // ── Send audio + question to Gemini ───────────────────────────────
            console.log(`[AskAI] Sending ${audioParts.length} audio file(s) + question to Gemini…`);
            const prompt = buildAskPrompt(participantNames, question.trim());
            const parts = [...audioParts, { text: prompt }];
            const answer = await callGemini(apiKey, parts);

            console.log(`[AskAI] ✅ Answer ready for meetId=${meetId} (${answer.length} chars)`);
            return res.json({ success: true, answer, audioFilesUsed: audioParts.length });

        } catch (e) {
            console.error("[AskAI] Error:", e.message);

            if (e.message?.includes("403") || e.message?.includes("suspended")) {
                return res.status(403).json({
                    error: "Gemini API key suspended or invalid. Create a new key at aistudio.google.com.",
                });
            }

            return res.status(500).json({ error: e.message });
        }
    }
);

module.exports = router;