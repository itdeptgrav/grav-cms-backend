/**
 * grav-backend/routes/task_routes/askAI.routes.js
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/askAI.routes"));
 *
 * ENDPOINT:
 *   POST /cowork/audio/ask/:meetId
 *   Body: { question: string }
 *
 * FLOW (Conveyor Belt Pipeline — same as meetingSummary.routes.js):
 *   1. Validate the user's question
 *   2. Pull all audio recording metadata from Firestore
 *   3. For EACH file ONE BY ONE:
 *        a. Stream download from Google Drive
 *        b. Upload to Gemini File API (Storage Locker)
 *        c. Poll until ACTIVE (Waiting Room)
 *   4. Send all file URIs + question to Gemini generateContent
 *   5. Cleanup files from Gemini File API (Self-Cleaning)
 *   6. Return Gemini's plain-text answer
 *
 * NOTE: Each question is independent — no memory/history kept between calls.
 */

const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const { db } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta";

// Models to try in order — verified against official Gemini API docs (April 2026)
const MODELS_TO_TRY = [
    "gemini-3-flash-preview",   // Gemini 3 Flash — latest, best free quota
    "gemini-2.5-flash",         // Stable — best price/performance in 2.5 family
    "gemini-2.5-flash-lite",    // Fastest + most budget friendly fallback
    "gemini-2.0-flash",         // Last resort fallback
];

// ── Helper: sleep ─────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Google Drive client ───────────────────────────────────────────────────────
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

// ── STEP 1: Get Google Drive file metadata ────────────────────────────────────
async function getDriveFileMeta(drive, fileId) {
    try {
        const meta = await drive.files.get({
            fileId,
            fields: "size,mimeType",
            supportsAllDrives: true,
        });
        return {
            size: parseInt(meta.data.size || "0", 10),
            mimeType: meta.data.mimeType || "audio/webm",
        };
    } catch (e) {
        console.warn(`[AskAI Pipeline] Could not get file meta for ${fileId}:`, e.message);
        return { size: 0, mimeType: "audio/webm" };
    }
}

// ── STEP 2: Drive → Gemini File API (Conveyor Belt core) ─────────────────────
async function streamDriveToGeminiFileAPI(drive, fileId, mimeType, displayName, apiKey) {
    console.log(`[AskAI Pipeline] ▶️  Uploading: ${displayName}`);

    const meta = await getDriveFileMeta(drive, fileId);
    if (meta.size > 0 && meta.size < 1000) {
        throw new Error(`File too small (${meta.size} bytes) — likely empty recording`);
    }
    const resolvedMime = mimeType || meta.mimeType || "audio/webm";

    console.log(`[AskAI Pipeline] File size: ${meta.size > 0 ? (meta.size / 1024 / 1024).toFixed(2) + " MB" : "unknown"}`);

    // Phase A: Initiate Gemini resumable upload session
    const initHeaders = {
        "Content-Type": "application/json",
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Type": resolvedMime,
    };
    if (meta.size > 0) {
        initHeaders["X-Goog-Upload-Header-Content-Length"] = meta.size.toString();
    }

    const initRes = await fetch(
        `${GEMINI_UPLOAD_BASE}/files?uploadType=resumable&key=${apiKey}`,
        {
            method: "POST",
            headers: initHeaders,
            body: JSON.stringify({ file: { display_name: displayName } }),
        }
    );

    if (!initRes.ok) {
        const errText = await initRes.text();
        throw new Error(`Gemini upload init failed (${initRes.status}): ${errText}`);
    }

    const uploadUrl = initRes.headers.get("x-goog-upload-url");
    if (!uploadUrl) throw new Error("No upload URL returned from Gemini File API");

    // Phase B: Stream download from Google Drive into buffer
    const driveRes = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
    );

    const chunks = [];
    await new Promise((resolve, reject) => {
        driveRes.data.on("data", (chunk) => chunks.push(chunk));
        driveRes.data.on("end", resolve);
        driveRes.data.on("error", reject);
    });

    const fullBuffer = Buffer.concat(chunks);
    console.log(`[AskAI Pipeline] Downloaded ${(fullBuffer.length / 1024 / 1024).toFixed(2)} MB from Drive`);

    if (fullBuffer.length < 1000) {
        throw new Error(`Downloaded file too small (${fullBuffer.length} bytes) — skipping`);
    }

    // Phase C: Upload buffer to Gemini resumable endpoint
    const uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
            "Content-Length": fullBuffer.length.toString(),
            "Content-Type": resolvedMime,
            "X-Goog-Upload-Offset": "0",
            "X-Goog-Upload-Command": "upload, finalize",
        },
        body: fullBuffer,
    });

    if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Gemini upload failed (${uploadRes.status}): ${errText}`);
    }

    const uploadData = await uploadRes.json();
    const fileUri = uploadData?.file?.uri;
    const geminiName = uploadData?.file?.name;

    if (!fileUri) throw new Error("No file URI returned from Gemini after upload");

    console.log(`[AskAI Pipeline] ✅ Uploaded → ${geminiName}`);
    return { fileUri, geminiName, mimeType: resolvedMime };
}

// ── STEP 3: Poll until Gemini file is ACTIVE ──────────────────────────────────
async function waitForFileActive(geminiName, apiKey, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000;

    console.log(`[AskAI Pipeline] ⏳ Waiting for ACTIVE: ${geminiName}`);

    while (Date.now() - startTime < maxWaitMs) {
        const cleanName = geminiName.replace("files/", "");
        const res = await fetch(`${GEMINI_BASE}/files/${cleanName}?key=${apiKey}`);

        if (!res.ok) {
            console.warn(`[AskAI Pipeline] Poll HTTP ${res.status} — retrying in 5s...`);
            await sleep(pollInterval);
            continue;
        }

        const data = await res.json();
        const state = data?.state;
        const waited = Math.round((Date.now() - startTime) / 1000);
        console.log(`[AskAI Pipeline] State: ${state} (${waited}s elapsed)`);

        if (state === "ACTIVE") return true;
        if (state === "FAILED") throw new Error(`Gemini file processing FAILED: ${geminiName}`);

        await sleep(pollInterval);
    }

    throw new Error(`File not ACTIVE after ${maxWaitMs / 1000}s: ${geminiName}`);
}

// ── STEP 4: Delete from Gemini File API (Self-Cleaning) ──────────────────────
async function deleteGeminiFile(geminiName, apiKey) {
    try {
        const cleanName = geminiName.replace("files/", "");
        await fetch(`${GEMINI_BASE}/files/${cleanName}?key=${apiKey}`, { method: "DELETE" });
        console.log(`[AskAI Pipeline] 🗑️  Deleted from Gemini: ${geminiName}`);
    } catch (e) {
        console.warn(`[AskAI Pipeline] Could not delete ${geminiName}:`, e.message);
    }
}

// ── Call Gemini generateContent with File API URIs ────────────────────────────
async function callGemini(apiKey, geminiFiles, prompt) {
    const parts = [
        ...geminiFiles.map(f => ({
            fileData: {
                mimeType: f.mimeType,
                fileUri: f.fileUri,
            },
        })),
        { text: prompt },
    ];

    let lastError = null;

    for (const modelName of MODELS_TO_TRY) {
        let attempts = 0;
        const MAX_ATTEMPTS = 2;

        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            try {
                console.log(`[AskAI] Trying model: ${modelName} (attempt ${attempts}/${MAX_ATTEMPTS})`);
                const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;
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

                    if (res.status === 429 && attempts < MAX_ATTEMPTS) {
                        const retryMatch = msg.match(/retry in (\d+(\.\d+)?)s/i);
                        const waitMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) * 1000 + 1000 : 25000;
                        console.warn(`[AskAI] ${modelName} quota hit — waiting ${waitMs / 1000}s then retrying...`);
                        await sleep(waitMs);
                        continue;
                    }

                    if (res.status === 404) {
                        console.warn(`[AskAI] ${modelName} not found on v1beta — skipping`);
                        lastError = new Error(msg);
                        break;
                    }

                    console.warn(`[AskAI] ${modelName} failed (${res.status}): ${msg}`);
                    lastError = new Error(msg);
                    break;
                }

                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

                if (!text) {
                    console.warn(`[AskAI] ${modelName} returned empty content`);
                    lastError = new Error("Empty response from Gemini");
                    break;
                }

                console.log(`[AskAI] ✅ Response from ${modelName} (${text.length} chars)`);
                return text;

            } catch (e) {
                console.warn(`[AskAI] ${modelName} error:`, e.message);
                lastError = e;
                break;
            }
        }
    }

    throw lastError || new Error("All Gemini models failed");
}

// ── Build the Ask AI prompt ───────────────────────────────────────────────────
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
        const uploadedGeminiFiles = []; // track for cleanup on success AND failure

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
            console.log(`\n[AskAI Pipeline] 🚀 Starting conveyor belt — ${recordings.length} file(s) for meet: ${meetId}`);

            const drive = getDriveClient();
            const participantNames = [];

            // ═══════════════════════════════════════════════════════════════════
            // CONVEYOR BELT: One file at a time
            //   Drive Download → Gemini Upload → Poll ACTIVE → Move to next
            //   RAM stays constant regardless of number of participants
            // ═══════════════════════════════════════════════════════════════════
            for (let i = 0; i < recordings.length; i++) {
                const rec = recordings[i];
                console.log(`\n[AskAI Pipeline] ── File ${i + 1}/${recordings.length}: ${rec.fileName} ──`);

                try {
                    const mimeType = rec.mimeType || "audio/webm";
                    const displayName = `ask_${meetId}_${rec.employeeName || rec.employeeId}_${Date.now()}`;

                    const geminiFile = await streamDriveToGeminiFileAPI(
                        drive,
                        rec.driveFileId,
                        mimeType,
                        displayName,
                        apiKey
                    );

                    await waitForFileActive(geminiFile.geminiName, apiKey);

                    uploadedGeminiFiles.push(geminiFile);
                    participantNames.push(rec.employeeName || rec.firstName || rec.employeeId);

                    console.log(`[AskAI Pipeline] ✅ File ${i + 1} ready in Gemini Storage`);

                    if (i < recordings.length - 1) await sleep(500);

                } catch (e) {
                    console.error(`[AskAI Pipeline] ⚠️  Skipping ${rec.fileName}: ${e.message}`);
                }
            }
            // ═══════════════════════════════════════════════════════════════════

            if (uploadedGeminiFiles.length === 0) {
                return res.status(400).json({
                    error: "Could not upload any audio files to Gemini File API. Check Drive permissions.",
                });
            }

            console.log(`\n[AskAI Pipeline] 🎯 ${uploadedGeminiFiles.length}/${recordings.length} file(s) ready — sending question to Gemini...`);

            // ── Send file URIs + question → Gemini ────────────────────────────
            const prompt = buildAskPrompt(participantNames, question.trim());
            const answer = await callGemini(apiKey, uploadedGeminiFiles, prompt);

            // ── Self-Cleaning ─────────────────────────────────────────────────
            console.log(`\n[AskAI Pipeline] 🧹 Cleaning up ${uploadedGeminiFiles.length} file(s) from Gemini...`);
            await Promise.all(
                uploadedGeminiFiles.map(f => deleteGeminiFile(f.geminiName, apiKey))
            );

            console.log(`[AskAI] ✅ Answer ready for ${meetId} (${answer.length} chars)`);
            return res.json({ success: true, answer, audioFilesUsed: uploadedGeminiFiles.length });

        } catch (e) {
            console.error("[AskAI] Error:", e.message);

            // Emergency cleanup on failure
            if (uploadedGeminiFiles.length > 0) {
                const apiKey = process.env.GEMINI_API_KEY;
                console.log(`[AskAI Pipeline] 🧹 Emergency cleanup of ${uploadedGeminiFiles.length} file(s)...`);
                await Promise.all(
                    uploadedGeminiFiles.map(f => deleteGeminiFile(f.geminiName, apiKey).catch(() => { }))
                );
            }

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