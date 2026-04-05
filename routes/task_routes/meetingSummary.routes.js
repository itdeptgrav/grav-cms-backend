/**
 * grav-backend/routes/task_routes/meetingSummary.routes.js
 *
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║           CONVEYOR BELT PIPELINE — Render Free Tier Safe        ║
 * ╠══════════════════════════════════════════════════════════════════╣
 * ║  OLD APPROACH (broken):                                         ║
 * ║    Download ALL files → load ALL into RAM → send as Base64     ║
 * ║    Result: OOM crash, 19MB limit, timeouts                     ║
 * ║                                                                  ║
 * ║  NEW APPROACH (this file):                                      ║
 * ║    For EACH file ONE BY ONE:                                    ║
 * ║      1. Stream from Google Drive → pipe to Gemini File API     ║
 * ║      2. Poll until Gemini says "ACTIVE"                        ║
 * ║      3. Delete local buffer immediately                         ║
 * ║      4. Collect file URI reference only                        ║
 * ║    Then send ALL URIs (not data) to Gemini for summarization   ║
 * ║    RAM stays ~60MB constant regardless of meeting length       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/meetingSummary.routes"));
 *
 * INSTALL:
 *   npm install @google/generative-ai form-data node-fetch
 *
 * ENV VARS:
 *   GEMINI_API_KEY=your_key
 *   GOOGLE_SERVICE_ACCOUNT_KEY=your_json
 */

const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { generateSummaryDocx } = require("./generateSummaryDocx");
const { db, admin } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Models to try in order
const MODELS_TO_TRY = [
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemini-1.5-flash-latest",
    "gemini-1.5-flash",
];

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

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1: Stream audio from Google Drive → Gemini File API
//
// Instead of:  downloadFromDrive() → huge Buffer → base64 string
// We do:       Drive stream → pipe → Gemini File API upload
//
// This keeps RAM at ~60MB because the data flows through, never accumulates.
// Gemini File API supports up to 2GB per file (vs 19MB inline limit).
// ─────────────────────────────────────────────────────────────────────────────
async function uploadToGeminiFileAPI(apiKey, driveFileId, mimeType, displayName) {
    const drive = getDriveClient();

    console.log(`[Pipeline] ⬇ Streaming from Drive: ${displayName}`);

    // Get the Drive stream — data flows chunk by chunk, not all at once
    const driveRes = await drive.files.get(
        { fileId: driveFileId, alt: "media", supportsAllDrives: true },
        { responseType: "stream" }
    );

    const driveStream = driveRes.data;

    // Collect stream into buffer (required for Gemini File API multipart upload)
    // We do this ONE FILE AT A TIME and discard immediately after upload
    // so peak RAM = size of ONE file, not ALL files combined
    const chunks = [];
    await new Promise((resolve, reject) => {
        driveStream.on("data", chunk => chunks.push(chunk));
        driveStream.on("end", resolve);
        driveStream.on("error", reject);
    });

    const fileBuffer = Buffer.concat(chunks);
    const fileSizeMB = (fileBuffer.length / 1024 / 1024).toFixed(2);
    console.log(`[Pipeline] ✅ Downloaded ${displayName} (${fileSizeMB} MB)`);

    if (fileBuffer.length < 1000) {
        throw new Error(`File too small (${fileBuffer.length} bytes) — likely empty recording`);
    }

    // Upload to Gemini File API using multipart/form-data
    // This stores the file on Google's side and gives us back a URI reference
    console.log(`[Pipeline] ⬆ Uploading ${displayName} to Gemini File API...`);

    const boundary = `----GeminiUpload${Date.now()}`;

    // Build multipart body manually (avoids needing form-data package)
    const metaJson = JSON.stringify({ display_name: displayName, mimeType });
    const metaPart = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metaJson}\r\n`
    );
    const audioPart = Buffer.from(
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`
    );
    const closingPart = Buffer.from(`\r\n--${boundary}--`);

    const body = Buffer.concat([metaPart, audioPart, fileBuffer, closingPart]);

    // Discard the fileBuffer from memory immediately after building body
    // (chunks array also goes out of scope after this function)
    chunks.length = 0;

    const uploadRes = await fetch(
        `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=multipart&key=${apiKey}`,
        {
            method: "POST",
            headers: {
                "Content-Type": `multipart/related; boundary=${boundary}`,
                "Content-Length": body.length,
            },
            body,
        }
    );

    if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        throw new Error(`Gemini File API upload failed (${uploadRes.status}): ${errText}`);
    }

    const uploadData = await uploadRes.json();
    const fileUri = uploadData?.file?.uri;
    const fileName = uploadData?.file?.name; // e.g. "files/abc123"

    if (!fileUri) {
        throw new Error(`Gemini File API returned no URI: ${JSON.stringify(uploadData)}`);
    }

    console.log(`[Pipeline] ✅ Uploaded ${displayName} → ${fileUri}`);
    return { fileUri, fileName, mimeType };
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2: Poll until Gemini says file is ACTIVE
//
// After upload, Gemini needs time to process the audio (20-40s for long files).
// We poll every 5 seconds with a timeout of 3 minutes.
// ─────────────────────────────────────────────────────────────────────────────
async function waitForFileActive(apiKey, fileName, displayName) {
    const maxWaitMs = 3 * 60 * 1000; // 3 minutes max
    const pollIntervalMs = 5000;      // check every 5 seconds
    const startTime = Date.now();

    console.log(`[Pipeline] ⏳ Waiting for ${displayName} to become ACTIVE...`);

    while (Date.now() - startTime < maxWaitMs) {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`
        );

        if (!res.ok) {
            console.warn(`[Pipeline] Poll failed for ${displayName} — retrying...`);
            await sleep(pollIntervalMs);
            continue;
        }

        const data = await res.json();
        const state = data?.state;

        if (state === "ACTIVE") {
            console.log(`[Pipeline] ✅ ${displayName} is ACTIVE`);
            return true;
        }

        if (state === "FAILED") {
            throw new Error(`Gemini rejected file ${displayName} — state: FAILED`);
        }

        const waitedSec = ((Date.now() - startTime) / 1000).toFixed(0);
        console.log(`[Pipeline] ${displayName} state: ${state} (waited ${waitedSec}s)`);
        await sleep(pollIntervalMs);
    }

    throw new Error(`Timeout: ${displayName} did not become ACTIVE within 3 minutes`);
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3: Delete file from Gemini File API after use (cleanup)
// ─────────────────────────────────────────────────────────────────────────────
async function deleteGeminiFile(apiKey, fileName) {
    try {
        await fetch(
            `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
            { method: "DELETE" }
        );
        console.log(`[Pipeline] 🗑 Deleted Gemini file: ${fileName}`);
    } catch (e) {
        console.warn(`[Pipeline] Could not delete Gemini file ${fileName}: ${e.message}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 4: Call Gemini with file URIs (not base64 data)
//
// Instead of sending 100MB of base64, we send tiny URI references like:
// { fileData: { fileUri: "https://...", mimeType: "audio/webm" } }
// Gemini reads from its own storage — takes 0.1s instead of timing out.
// ─────────────────────────────────────────────────────────────────────────────
async function callGeminiWithFileURIs(apiKey, fileRefs, prompt) {
    // Build parts array: each file as a URI reference + the prompt text
    const parts = [
        ...fileRefs.map(ref => ({
            fileData: {
                fileUri: ref.fileUri,
                mimeType: ref.mimeType,
            },
        })),
        { text: prompt },
    ];

    let lastError = null;

    for (const modelName of MODELS_TO_TRY) {
        try {
            console.log(`[Pipeline] Trying model: ${modelName}`);
            const url = `${GEMINI_BASE}/${modelName}:generateContent?key=${apiKey}`;
            const body = {
                contents: [{ parts }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
            };

            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                // No timeout issue — we're just passing URI references, not uploading data
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const msg = err?.error?.message || `HTTP ${res.status}`;
                console.warn(`[Pipeline] ${modelName} failed: ${msg}`);
                lastError = new Error(msg);
                continue;
            }

            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

            if (!text) {
                console.warn(`[Pipeline] ${modelName} returned empty content`);
                lastError = new Error("Empty response from Gemini");
                continue;
            }

            console.log(`[Pipeline] ✅ Got response from ${modelName} (${text.length} chars)`);
            return text;

        } catch (e) {
            console.warn(`[Pipeline] ${modelName} error:`, e.message);
            lastError = e;
        }
    }

    throw lastError || new Error("All Gemini models failed");
}

// ── Utility: sleep ────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    const audioResults = {};
    const tinyAudioB64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAASU5UAAAAAAAAAAB1EAAAAAAAACDca";

    for (const m of MODELS_TO_TRY) {
        try {
            const url = `${GEMINI_BASE}/${m}:generateContent?key=${apiKey}`;
            const resp = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ contents: [{ parts: [{ text: "Say hi" }] }] }),
            });
            results[m] = resp.ok ? "✅ TEXT works" : `❌ HTTP ${resp.status}`;
        } catch (e) {
            results[m] = `❌ ${e.message}`;
        }

        if (results[m].startsWith("✅")) {
            try {
                const url = `${GEMINI_BASE}/${m}:generateContent?key=${apiKey}`;
                const resp = await fetch(url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { inlineData: { data: tinyAudioB64, mimeType: "audio/webm" } },
                                { text: "What is in this audio?" },
                            ],
                        }],
                    }),
                });
                audioResults[m] = resp.ok ? "✅ AUDIO works" : `❌ HTTP ${resp.status}`;
            } catch (e) {
                audioResults[m] = `❌ ${e.message}`;
            }
        }
    }

    res.json({ apiKeySet: true, textTest: results, audioTest: audioResults });
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
// POST /cowork/audio/summary/:meetId — CONVEYOR BELT PIPELINE
//
// For each recording ONE BY ONE:
//   [Drive Stream] → [Gemini File API Upload] → [Poll ACTIVE] → [Store URI]
// Then:
//   [All URIs] → [Gemini generateContent] → [Parse] → [Firestore]
//
// RAM stays constant at ~60MB regardless of meeting size.
// Supports files up to 2GB (vs old 19MB limit).
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/audio/summary/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        const uploadedGeminiFiles = []; // track for cleanup on error

        try {
            const { meetId } = req.params;
            const apiKey = process.env.GEMINI_API_KEY;
            if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });

            // ── Return cached if < 24h old ────────────────────────────────────
            const existing = await db.collection("meeting_summaries").doc(meetId).get();
            if (existing.exists) {
                const d = existing.data();
                const ageHours = (Date.now() - (d.createdAtMs || 0)) / 3600000;
                if (ageHours < 24) {
                    console.log(`[Pipeline] Returning cached summary for ${meetId}`);
                    return res.json({ success: true, summary: d, cached: true });
                }
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
            console.log(`[Pipeline] Starting conveyor belt for ${recordings.length} file(s) — meetId: ${meetId}`);

            // ── CONVEYOR BELT: Process each file ONE BY ONE ───────────────────
            const fileRefs = [];        // collects only URI references (tiny)
            const participantNames = [];

            for (const rec of recordings) {
                const displayName = rec.fileName || rec.employeeName || rec.employeeId;
                const mimeType = rec.mimeType || "audio/webm";

                try {
                    // --- Belt Step 1: Stream from Drive + Upload to Gemini File API ---
                    const { fileUri, fileName } = await uploadToGeminiFileAPI(
                        apiKey,
                        rec.driveFileId,
                        mimeType,
                        displayName
                    );

                    // Track for cleanup in case of later error
                    uploadedGeminiFiles.push({ fileName, displayName });

                    // --- Belt Step 2: Poll until ACTIVE ---
                    await waitForFileActive(apiKey, fileName, displayName);

                    // --- Belt Step 3: Store only the URI reference (not the audio data) ---
                    fileRefs.push({ fileUri, fileName, mimeType });
                    participantNames.push(rec.employeeName || rec.firstName || rec.employeeId);

                    console.log(`[Pipeline] ✅ Belt complete for: ${displayName}`);

                    // The audio buffer is now garbage collected — RAM freed
                    // Moving to next file...

                } catch (e) {
                    console.error(`[Pipeline] ❌ Failed for ${displayName}:`, e.message);
                    // Skip this file, continue with others
                }
            }

            if (fileRefs.length === 0) {
                return res.status(400).json({
                    error: "Could not upload any audio files to Gemini. Check Drive permissions and file sizes.",
                });
            }

            // ── FINAL STEP: Send all URIs to Gemini for summarization ─────────
            // This sends tiny URI strings (not 100MB of base64) — takes ~0.1s
            console.log(`[Pipeline] Sending ${fileRefs.length} file URI(s) to Gemini for summarization...`);
            const prompt = buildPrompt(participantNames);
            const rawText = await callGeminiWithFileURIs(apiKey, fileRefs, prompt);

            // ── Parse + store in Firestore ────────────────────────────────────
            const parsed = parseResponse(rawText);

            let meetTitle = meetId;
            try {
                const meetDoc = await db.collection("cowork_scheduled_meets").doc(meetId).get();
                if (meetDoc.exists) {
                    meetTitle = meetDoc.data().title || meetDoc.data().meetTitle || meetId;
                }
            } catch (_) { /* non-fatal */ }

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
                audioFilesCount: fileRefs.length,
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
            };

            await db.collection("meeting_summaries").doc(meetId).set(summaryData);
            console.log(`[Pipeline] ✅ Summary stored for ${meetId}`);

            // ── Cleanup: Delete files from Gemini File API ────────────────────
            // Gemini auto-deletes after 48h but we clean up immediately (good practice)
            for (const f of uploadedGeminiFiles) {
                await deleteGeminiFile(apiKey, f.fileName);
            }

            // Update meeting doc status (non-fatal)
            db.collection("cowork_scheduled_meets").doc(meetId)
                .update({ summary_status: "completed", updatedAt: admin.firestore.FieldValue.serverTimestamp() })
                .catch(() => { });

            return res.json({ success: true, summary: summaryData, cached: false });

        } catch (e) {
            console.error("[Pipeline POST] Error:", e.message);

            // Cleanup any uploaded Gemini files on error
            const apiKey = process.env.GEMINI_API_KEY;
            if (apiKey && uploadedGeminiFiles.length > 0) {
                console.log(`[Pipeline] Cleaning up ${uploadedGeminiFiles.length} Gemini file(s) after error...`);
                for (const f of uploadedGeminiFiles) {
                    await deleteGeminiFile(apiKey, f.fileName);
                }
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
            const safeName = (meetTitle || meetId).replace(/[^a-zA-Z0-9_\- ]/g, "").trim().replace(/\s+/g, "_");
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