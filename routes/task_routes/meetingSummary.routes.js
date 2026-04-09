/**
 * grav-backend/routes/task_routes/meetingSummary.routes.js
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/meetingSummary.routes"));
 *
 * FLOW (Conveyor Belt Pipeline):
 *   1. Fetch audio records from Firestore (meeting_audio_recordings)
 *   2. For EACH file ONE BY ONE:
 *        a. Stream download from Google Drive  (no full RAM load)
 *        b. Upload stream to Gemini File API   (Storage Locker)
 *        c. Poll until file is ACTIVE          (State Check / Waiting Room)
 *        d. Delete temp reference              (Self-Cleaning)
 *   3. Send all Gemini file URIs + prompt to Gemini generateContent
 *   4. Parse response into structured sections
 *   5. Store in Firestore meeting_summaries/{meetId}
 *
 * ENV VARS:
 *   GEMINI_API_KEY=your_key  ← from aistudio.google.com
 *   GOOGLE_SERVICE_ACCOUNT_KEY=<json string>
 */

const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const { generateSummaryDocx } = require("./generateSummaryDocx");
const { db, admin } = require("../../config/firebaseAdmin");
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

// In-memory lock to prevent duplicate simultaneous requests for same meetId
const processingLocks = new Set();

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
        console.warn(`[Pipeline] Could not get file meta for ${fileId}:`, e.message);
        return { size: 0, mimeType: "audio/webm" };
    }
}

// ── STEP 2: Download from Google Drive → Upload to Gemini File API ────────────
// The Conveyor Belt core:
//   Drive stream → buffer (in chunks) → Gemini resumable upload
//   RAM stays at ~60MB constant regardless of meeting size
async function streamDriveToGeminiFileAPI(drive, fileId, mimeType, displayName, apiKey) {
    console.log(`[Pipeline] ▶️  Uploading: ${displayName}`);

    // Get file size (required for Gemini resumable upload header)
    const meta = await getDriveFileMeta(drive, fileId);
    if (meta.size > 0 && meta.size < 1000) {
        throw new Error(`File too small (${meta.size} bytes) — likely empty recording`);
    }
    // Use detected mimeType from Drive if not overridden
    const resolvedMime = mimeType || meta.mimeType || "audio/webm";

    console.log(`[Pipeline] File size: ${meta.size > 0 ? (meta.size / 1024 / 1024).toFixed(2) + " MB" : "unknown"}`);

    // ── Phase A: Initiate Gemini resumable upload session ─────────────────────
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

    console.log(`[Pipeline] Resumable upload session created for: ${displayName}`);

    // ── Phase B: Download file from Google Drive (streaming into buffer) ───────
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
    console.log(`[Pipeline] Downloaded ${(fullBuffer.length / 1024 / 1024).toFixed(2)} MB from Drive`);

    if (fullBuffer.length < 1000) {
        throw new Error(`Downloaded file too small (${fullBuffer.length} bytes) — skipping`);
    }

    // ── Phase C: Upload buffer to Gemini (single resumable upload call) ───────
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

    console.log(`[Pipeline] ✅ Uploaded to Gemini File API → ${geminiName}`);
    return { fileUri, geminiName, mimeType: resolvedMime };
}

// ── STEP 3: Poll until Gemini file is ACTIVE (Waiting Room) ──────────────────
async function waitForFileActive(geminiName, apiKey, maxWaitMs = 120000) {
    const startTime = Date.now();
    const pollInterval = 5000; // check every 5 seconds

    console.log(`[Pipeline] ⏳ Waiting for ACTIVE state: ${geminiName}`);

    while (Date.now() - startTime < maxWaitMs) {
        const cleanName = geminiName.replace("files/", "");
        const res = await fetch(`${GEMINI_BASE}/files/${cleanName}?key=${apiKey}`);

        if (!res.ok) {
            console.warn(`[Pipeline] Poll HTTP ${res.status} — retrying in 5s...`);
            await sleep(pollInterval);
            continue;
        }

        const data = await res.json();
        const state = data?.state;
        const waited = Math.round((Date.now() - startTime) / 1000);
        console.log(`[Pipeline] State: ${state} (${waited}s elapsed)`);

        if (state === "ACTIVE") {
            console.log(`[Pipeline] ✅ ACTIVE: ${geminiName}`);
            return true;
        }

        if (state === "FAILED") {
            throw new Error(`Gemini file processing FAILED for: ${geminiName}`);
        }

        // State is PROCESSING — wait and retry
        await sleep(pollInterval);
    }

    throw new Error(`File not ACTIVE after ${maxWaitMs / 1000}s: ${geminiName}`);
}

// ── STEP 4: Delete from Gemini File API (Self-Cleaning) ──────────────────────
async function deleteGeminiFile(geminiName, apiKey) {
    try {
        const cleanName = geminiName.replace("files/", "");
        await fetch(`${GEMINI_BASE}/files/${cleanName}?key=${apiKey}`, { method: "DELETE" });
        console.log(`[Pipeline] 🗑️  Deleted from Gemini: ${geminiName}`);
    } catch (e) {
        // Non-fatal: Gemini auto-deletes files after 48h anyway
        console.warn(`[Pipeline] Could not delete ${geminiName}:`, e.message);
    }
}

// ── Call Gemini generateContent using File API URIs ───────────────────────────
// Key difference from old approach: we send fileData URIs, NOT base64 inline
// This means: no 19MB limit, no timeout, Gemini reads from its own storage
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
        // Each model gets up to 2 attempts (1 retry on quota error)
        let attempts = 0;
        const MAX_ATTEMPTS = 2;

        while (attempts < MAX_ATTEMPTS) {
            attempts++;
            try {
                console.log(`[Gemini] Trying model: ${modelName} (attempt ${attempts}/${MAX_ATTEMPTS})`);
                const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;
                const body = {
                    contents: [{ parts }],
                    generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
                };

                const res = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(body),
                });

                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    const msg = err?.error?.message || `HTTP ${res.status}`;

                    // 429 = quota/rate limit — wait and retry same model once
                    if (res.status === 429 && attempts < MAX_ATTEMPTS) {
                        // Try to extract retry delay from error message (e.g. "retry in 19.7s")
                        const retryMatch = msg.match(/retry in (\d+(\.\d+)?)s/i);
                        const waitMs = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) * 1000 + 1000 : 25000;
                        console.warn(`[Gemini] ${modelName} quota hit — waiting ${waitMs / 1000}s then retrying...`);
                        await sleep(waitMs);
                        continue; // retry same model
                    }

                    // 404 = model not found — no point retrying, move to next model
                    if (res.status === 404) {
                        console.warn(`[Gemini] ${modelName} not found on v1beta — skipping`);
                        lastError = new Error(msg);
                        break; // exit while loop, try next model
                    }

                    console.warn(`[Gemini] ${modelName} failed (${res.status}): ${msg}`);
                    lastError = new Error(msg);
                    break; // exit while loop, try next model
                }

                const data = await res.json();
                const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

                if (!text) {
                    console.warn(`[Gemini] ${modelName} returned empty content`);
                    lastError = new Error("Empty response from Gemini");
                    break;
                }

                console.log(`[Gemini] ✅ Response from ${modelName} (${text.length} chars)`);
                return text; // ← success

            } catch (e) {
                console.warn(`[Gemini] ${modelName} error:`, e.message);
                lastError = e;
                break; // network error — move to next model
            }
        }
    }

    throw lastError || new Error("All Gemini models failed");
}

// ── Build Gemini prompt ───────────────────────────────────────────────────────
function buildPrompt(participantNames) {
    const names = participantNames.join(", ");
    return `These are individual voice recording files from a single meeting.
Each audio file contains ONLY ONE person's voice.
The participants in this meeting are: ${names}.

IMPORTANT: Analyze ALL audio files together. Reconstruct the full conversation in the ORDER it happened — based on what each person said in response to others.

Respond in this EXACT format (do not change the section headers):

## MEETING SUMMARY
[Write 3-5 sentences summarizing what was discussed and decided overall]

## CONVERSATION
[Show the FULL conversation in sequence — exactly who said what and when. Use this format for EVERY line:
{Name}: "{exact quote or close paraphrase of what they said}"

Example:
Rakesh: "Soumya, what is today's update on CAD?"
Soumya: "Everything is going okay. Keyframe recording is left."
Pramod: "Testing is in progress. Will update soon."
Rakesh: "When will it be finished?"
Soumya: "Day after tomorrow morning."

Show ALL back-and-forth dialogue in sequence — not just one line per person. A person can appear multiple times.]

## TASKS ASSIGNED
[Format each task on a new line:
- {Name}: {task description} [Deadline: {deadline or "Not specified"}]
If no tasks were assigned, write: No tasks were assigned]

## DEADLINES MENTIONED
[Format:
- {Person}: {task} by {date/time}
If none, write: No specific deadlines mentioned]

## ACTION ITEMS
[Format:
- {action item}
List the next steps decided in the meeting]

Rules:
- If audio is in Hindi, Odia, or mixed language → translate everything to English
- Each person can appear MULTIPLE TIMES in the CONVERSATION section
- Show the conversation in correct sequence as it happened
- Keep quotes natural — paraphrase if exact words unclear`;
}

// ── Parse Gemini response into structured sections ────────────────────────────
function parseResponse(text) {
    const get = (header, stops) => {
        const re = new RegExp(`##\\s*${header}[\\s\\S]*?\\n([\\s\\S]*?)(?=##\\s*(?:${stops.join("|")})|$)`, "i");
        const m = text.match(re);
        return m ? m[1].trim() : "";
    };

    const toList = (str) =>
        str.split("\n").map(l => l.replace(/^[-•*]\s*/, "").trim()).filter(l => l.length > 2);

    const convRaw = get("CONVERSATION", ["TASKS", "DEADLINES", "ACTION"]);
    const dialogue = [];
    const lineRe = /^([^:"]+?):\s*"?(.+?)"?\s*$/;
    convRaw.split("\n").forEach(line => {
        line = line.trim().replace(/^[-•*]\s*/, "");
        if (!line) return;
        const m = line.match(lineRe);
        if (m) {
            dialogue.push({ speaker: m[1].trim(), text: m[2].trim() });
        } else if (line.includes(":")) {
            const idx = line.indexOf(":");
            const spk = line.slice(0, idx).trim();
            const txt = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
            if (spk && txt) dialogue.push({ speaker: spk, text: txt });
        }
    });

    return {
        summary: get("MEETING SUMMARY", ["CONVERSATION", "TASKS", "DEADLINES", "ACTION"]),
        dialogue,
        conversationFlow: dialogue.map(d => `${d.speaker}: "${d.text}"`),
        tasksAssigned: toList(get("TASKS ASSIGNED", ["DEADLINES", "ACTION"])),
        deadlines: toList(get("DEADLINES MENTIONED", ["ACTION"])).filter(l => !l.toLowerCase().includes("no specific")),
        actionItems: toList(get("ACTION ITEMS", [])),
        rawText: text,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/test-gemini  — no auth, for debugging
// ─────────────────────────────────────────────────────────────────────────────
router.get("/audio/test-gemini", async (req, res) => {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });

    const results = {};

    for (const m of MODELS_TO_TRY) {
        try {
            const url = `${GEMINI_BASE}/models/${m}:generateContent?key=${apiKey}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: "Say hi" }] }] }),
            });
            results[m] = resp.ok ? "✅ TEXT works" : `❌ HTTP ${resp.status}`;
        } catch (e) {
            results[m] = `❌ ${e.message}`;
        }
    }

    // Test Gemini File API availability
    let fileApiStatus = "❌ Not tested";
    try {
        const listRes = await fetch(`${GEMINI_BASE}/files?key=${apiKey}`);
        fileApiStatus = listRes.ok ? "✅ File API accessible" : `❌ HTTP ${listRes.status}`;
    } catch (e) {
        fileApiStatus = `❌ ${e.message}`;
    }

    res.json({ apiKeySet: true, textTest: results, fileApiTest: fileApiStatus });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/summary/:meetId — return cached summary
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    "/audio/summary/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const doc = await db.collection("meeting_summaries").doc(req.params.meetId).get();
            if (!doc.exists) return res.json({ success: true, exists: false, summary: null });
            return res.json({ success: true, exists: true, summary: doc.data() });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/audio/summary/:meetId — generate summary using Gemini
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/audio/summary/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        // Track all uploaded Gemini files — cleaned up on success AND failure
        const uploadedGeminiFiles = [];

        try {
            const { meetId } = req.params;
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });

            // ── Duplicate request guard ───────────────────────────────────────
            // Blocks double processing when frontend calls API twice at once
            if (processingLocks.has(meetId)) {
                console.warn(`[MeetingSummary] Duplicate request blocked for ${meetId}`);
                return res.status(429).json({ error: "Summary generation already in progress. Please wait." });
            }
            processingLocks.add(meetId);

            // ── Return cached if < 24h old — UNLESS ?force=true is passed ─────
            const forceRegenerate = req.query.force === "true";
            const existing = await db.collection("meeting_summaries").doc(meetId).get();
            if (existing.exists && !forceRegenerate) {
                const d = existing.data();
                const ageHours = (Date.now() - (d.createdAtMs || 0)) / 3600000;
                if (ageHours < 24) {
                    console.log(`[MeetingSummary] Returning cached summary for ${meetId}`);
                    processingLocks.delete(meetId);
                    return res.json({ success: true, summary: d, cached: true });
                }
            }
            if (forceRegenerate) {
                console.log(`[MeetingSummary] Force regenerate requested for ${meetId} — bypassing cache`);
            }

            // ── Get audio records from Firestore ──────────────────────────────
            const snap = await db
                .collection("meeting_audio_recordings")
                .where("meetId", "==", meetId)
                .get();

            if (snap.empty) {
                return res.status(404).json({
                    error: "No audio recordings found for this meeting. Record a meeting first.",
                });
            }

            const recordings = snap.docs.map(d => d.data());
            console.log(`\n[Pipeline] 🚀 Starting conveyor belt — ${recordings.length} file(s) for meet: ${meetId}`);

            const drive = getDriveClient();
            const participantNames = [];

            // ═══════════════════════════════════════════════════════════════════
            // ██████████████████  CONVEYOR BELT  ████████████████████████████████
            //
            //  File 1: Drive Download → Gemini Upload → Poll ACTIVE → ✅
            //  File 2: Drive Download → Gemini Upload → Poll ACTIVE → ✅
            //  File N: ...
            //
            //  RAM stays at ~60MB CONSTANT — regardless of number of files
            //  No 19MB limit — Gemini File API supports up to 2GB per file
            // ═══════════════════════════════════════════════════════════════════

            for (let i = 0; i < recordings.length; i++) {
                const rec = recordings[i];
                console.log(`\n[Pipeline] ── File ${i + 1}/${recordings.length}: ${rec.fileName} ──`);

                try {
                    const mimeType = rec.mimeType || "audio/webm";
                    const displayName = `${meetId}_${rec.employeeName || rec.employeeId}_${Date.now()}`;

                    // BELT STEP 1+2: Drive stream → Gemini File API upload
                    const geminiFile = await streamDriveToGeminiFileAPI(
                        drive,
                        rec.driveFileId,
                        mimeType,
                        displayName,
                        apiKey
                    );

                    // BELT STEP 3: Wait until Gemini marks file as ACTIVE
                    await waitForFileActive(geminiFile.geminiName, apiKey);

                    // Collect file reference for batch generateContent call
                    uploadedGeminiFiles.push(geminiFile);
                    participantNames.push(rec.employeeName || rec.firstName || rec.employeeId);

                    console.log(`[Pipeline] ✅ File ${i + 1} ready in Gemini Storage`);

                    // Small courtesy pause between files
                    if (i < recordings.length - 1) await sleep(500);

                } catch (e) {
                    // Non-fatal: log and skip this file, continue with rest
                    console.error(`[Pipeline] ⚠️  Skipping ${rec.fileName}: ${e.message}`);
                }
            }

            // ═══════════════════════════════════════════════════════════════════

            if (uploadedGeminiFiles.length === 0) {
                return res.status(400).json({
                    error: "Could not upload any audio files to Gemini File API. Check Drive permissions.",
                });
            }

            console.log(`\n[Pipeline] 🎯 ${uploadedGeminiFiles.length}/${recordings.length} file(s) ready — sending to Gemini...`);

            // ── Send File URI references + prompt → Gemini generateContent ────
            const prompt = buildPrompt(participantNames);
            const rawText = await callGemini(apiKey, uploadedGeminiFiles, prompt);

            // ── Self-Cleaning: remove all files from Gemini File API ──────────
            console.log(`\n[Pipeline] 🧹 Cleaning up ${uploadedGeminiFiles.length} file(s) from Gemini...`);
            await Promise.all(
                uploadedGeminiFiles.map(f => deleteGeminiFile(f.geminiName, apiKey))
            );

            // ── Parse response ────────────────────────────────────────────────
            const parsed = parseResponse(rawText);

            // ── Fetch meeting title ───────────────────────────────────────────
            let meetTitle = meetId;
            try {
                const meetDoc = await db.collection("cowork_scheduled_meets").doc(meetId).get();
                if (meetDoc.exists) {
                    meetTitle = meetDoc.data().title || meetDoc.data().meetTitle || meetId;
                }
            } catch (_) { /* non-fatal */ }

            // ── Store in Firestore ────────────────────────────────────────────
            const summaryData = {
                meetId,
                meetTitle,
                summary: parsed.summary,
                conversationFlow: parsed.conversationFlow,
                dialogue: parsed.dialogue,
                tasksAssigned: parsed.tasksAssigned,
                deadlines: parsed.deadlines,
                actionItems: parsed.actionItems,
                rawText: parsed.rawText,
                participants: participantNames,
                audioFilesCount: uploadedGeminiFiles.length,
                audioFiles: recordings.map(r => ({
                    employeeId: r.employeeId,
                    employeeName: r.employeeName,
                    fileName: r.fileName,
                    driveViewUrl: r.driveViewUrl,
                })),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdAtMs: Date.now(),
                generatedBy: req.coworkUser.employeeId,
                summaryStatus: "completed",
                pipeline: "conveyor-belt-file-api-v2",
            };

            await db.collection("meeting_summaries").doc(meetId).set(summaryData);
            console.log(`[MeetingSummary] ✅ Summary stored for ${meetId}`);

            // Update meeting doc status (non-fatal)
            db.collection("cowork_scheduled_meets").doc(meetId)
                .update({
                    summary_status: "completed",
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                })
                .catch(() => { });

            processingLocks.delete(meetId);
            return res.json({ success: true, summary: summaryData, cached: false });

        } catch (e) {
            console.error("[MeetingSummary POST] Error:", e.message);
            processingLocks.delete(meetId); // always release lock

            // Emergency cleanup on failure — don't leave files in Gemini storage
            if (uploadedGeminiFiles.length > 0) {
                const apiKey = process.env.GEMINI_API_KEY;
                console.log(`[Pipeline] 🧹 Emergency cleanup of ${uploadedGeminiFiles.length} file(s)...`);
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/summary/:meetId/download
// Generate and stream a professional .docx file for download.
// (generateSummaryDocx.js is unchanged — no modifications needed there)
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    "/audio/summary/:meetId/download",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { meetId } = req.params;

            const doc = await db.collection("meeting_summaries").doc(meetId).get();
            if (!doc.exists) {
                return res.status(404).json({
                    error: "No summary found for this meeting. Generate a summary first.",
                });
            }

            const summary = doc.data();
            let meetTitle = summary.meetTitle || meetId;
            let meetDescription = summary.meetDescription || "";
            let meetDateTime = summary.meetDateTime || "";

            try {
                const meetDoc = await db.collection("cowork_scheduled_meets").doc(meetId).get();
                if (meetDoc.exists) {
                    const m = meetDoc.data();
                    meetTitle = m.title || m.meetTitle || meetTitle;
                    meetDescription = m.description || m.meetDescription || meetDescription;
                    meetDateTime = m.dateTime || m.meetDateTime || meetDateTime;
                }
            } catch (_) { /* non-fatal */ }

            const summaryWithMeta = { ...summary, meetTitle, meetDescription, meetDateTime };
            const safeName = (meetTitle || meetId)
                .replace(/[^a-zA-Z0-9_\- ]/g, "")
                .trim()
                .replace(/\s+/g, "_");
            const fileName = `Meeting_Summary_${safeName}_${meetId}.docx`;

            console.log(`[SummaryDocx] Generating docx for ${meetId} — "${meetTitle}"`);
            const buffer = await generateSummaryDocx(summaryWithMeta, meetId);

            res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
            res.setHeader("Content-Length", buffer.length);
            res.send(buffer);

            console.log(`[SummaryDocx] ✅ Sent ${fileName} (${buffer.length} bytes)`);
        } catch (e) {
            console.error("[SummaryDocx] Error:", e.message);
            res.status(500).json({ error: e.message });
        }
    }
);

module.exports = router;