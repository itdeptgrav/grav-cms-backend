/**
 * grav-backend/routes/task_routes/meetingSummary.routes.js
 *
 * REGISTER in server.js:
 *   app.use("/cowork", require("./routes/task_routes/meetingSummary.routes"));
 *
 * FLOW:
 *   1. Fetch audio records from Firestore (meeting_audio_recordings)
 *   2. Download each audio file from Google Drive
 *   3. Send all files as base64 inline to Gemini
 *   4. Parse response into structured sections
 *   5. Store in Firestore meeting_summaries/{meetId}
 *
 * ENV VARS:
 *   GEMINI_API_KEY=your_key  ← from aistudio.google.com
 */

const express = require("express");
const router = express.Router();
const { google } = require("googleapis");
const { generateSummaryDocx } = require("./generateSummaryDocx");
const { db, admin } = require("../../config/firebaseAdmin");
const { verifyCoworkToken, verifyEmployeeToken } = require("../../Middlewear/coworkAuth");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// gemini-3-flash-preview confirmed working — fallbacks in order
const MODELS_TO_TRY = [
    "gemini-3-flash-preview",
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

// ── Download audio from Google Drive using service account ────────────────────
async function downloadFromDrive(fileId) {
    const drive = getDriveClient();
    const res = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" }
    );
    return Buffer.from(res.data);
}

// ── Call Gemini REST API — tries each model until one works ───────────────────
async function callGemini(apiKey, parts) {
    let lastError = null;
    for (const modelName of MODELS_TO_TRY) {
        try {
            console.log(`[MeetingSummary] Trying model: ${modelName}`);
            const url = `${GEMINI_BASE}/${modelName}:generateContent?key=${apiKey}`;
            const body = {
                contents: [{ parts }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
            };
            const res = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                const msg = err?.error?.message || `HTTP ${res.status}`;
                console.warn(`[MeetingSummary] ${modelName} failed: ${msg}`);
                lastError = new Error(msg);
                continue;
            }

            const data = await res.json();
            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) {
                console.warn(`[MeetingSummary] ${modelName} returned empty content`);
                lastError = new Error("Empty response from Gemini");
                continue;
            }

            console.log(`[MeetingSummary] ✅ Got response from ${modelName} (${text.length} chars)`);
            return text;
        } catch (e) {
            console.warn(`[MeetingSummary] ${modelName} error:`, e.message);
            lastError = e;
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

    // Parse CONVERSATION section into array of { speaker, dialogue }
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
            // Fallback: split on first colon
            const idx = line.indexOf(":");
            const spk = line.slice(0, idx).trim();
            const txt = line.slice(idx + 1).trim().replace(/^"|"$/g, "");
            if (spk && txt) dialogue.push({ speaker: spk, text: txt });
        }
    });

    return {
        summary: get("MEETING SUMMARY", ["CONVERSATION", "TASKS", "DEADLINES", "ACTION"]),
        dialogue,                                  // ← structured dialogue array
        conversationFlow: dialogue.map(d => `${d.speaker}: "${d.text}"`), // backwards compat
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

    // Small silent webm blob (44 bytes) — just enough to test audio support
    const tinyAudioB64 = "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQRChYECGFOAZwEAAAAAAAASU5UAAAAAAAAAAB1EAAAAAAAACDca";

    for (const m of MODELS_TO_TRY) {
        // Text test
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

        // Audio test (only test models that passed text)
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
// POST /cowork/audio/summary/:meetId — generate summary using Gemini
// ─────────────────────────────────────────────────────────────────────────────
router.post(
    "/audio/summary/:meetId",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
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
                    console.log(`[MeetingSummary] Returning cached summary for ${meetId}`);
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
            console.log(`[MeetingSummary] Processing ${recordings.length} audio file(s) for ${meetId}`);

            // ── Download audio files from Drive ───────────────────────────────
            const audioParts = [];
            const participantNames = [];

            for (const rec of recordings) {
                try {
                    console.log(`[MeetingSummary] Downloading: ${rec.fileName}`);
                    const buffer = await downloadFromDrive(rec.driveFileId);

                    if (buffer.length < 1000) {
                        console.warn(`[MeetingSummary] Skipping ${rec.fileName} — too small`);
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
                    console.log(`[MeetingSummary] ✅ Downloaded ${rec.fileName} (${(buffer.length / 1024).toFixed(0)}KB)`);
                } catch (e) {
                    console.error(`[MeetingSummary] Failed to download ${rec.fileName}:`, e.message);
                }
            }

            if (audioParts.length === 0) {
                return res.status(400).json({ error: "Could not download any audio files from Drive." });
            }

            // ── Send to Gemini ────────────────────────────────────────────────
            console.log(`[MeetingSummary] Sending ${audioParts.length} audio file(s) to Gemini...`);
            const prompt = buildPrompt(participantNames);
            const parts = [...audioParts, { text: prompt }];
            const rawText = await callGemini(apiKey, parts);

            // ── Parse + store in Firestore ────────────────────────────────────
            const parsed = parseResponse(rawText);
            // ── Fetch meeting title from cowork_scheduled_meets ───────────────
            let meetTitle = meetId; // fallback
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
                audioFilesCount: audioParts.length,
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
            console.log(`[MeetingSummary] ✅ Summary stored for ${meetId}`);

            // Update meeting doc status (non-fatal)
            db.collection("cowork_scheduled_meets").doc(meetId)
                .update({ summary_status: "completed", updatedAt: admin.firestore.FieldValue.serverTimestamp() })
                .catch(() => { });

            return res.json({ success: true, summary: summaryData, cached: false });

        } catch (e) {
            console.error("[MeetingSummary POST] Error:", e.message);
            if (e.message?.includes("403") || e.message?.includes("suspended")) {
                return res.status(403).json({ error: "Gemini API key suspended or invalid. Create a new key at aistudio.google.com." });
            }
            return res.status(500).json({ error: e.message });
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/summary/:meetId/download
// Generate and stream a professional .docx file for download.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
    "/audio/summary/:meetId/download",
    verifyCoworkToken,
    verifyEmployeeToken,
    async (req, res) => {
        try {
            const { meetId } = req.params;

            // Fetch summary from Firestore
            const doc = await db.collection("meeting_summaries").doc(meetId).get();
            if (!doc.exists) {
                return res.status(404).json({ error: "No summary found for this meeting. Generate a summary first." });
            }

            const summary = doc.data();

            // Fetch actual meeting title + description from cowork_scheduled_meets
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

            // Merge fetched info into summary object for docx
            const summaryWithMeta = {
                ...summary,
                meetTitle,
                meetDescription,
                meetDateTime,
            };
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