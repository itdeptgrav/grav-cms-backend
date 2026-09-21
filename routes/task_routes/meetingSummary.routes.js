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
const { generateSummaryDocx, needsActionGroups } = require("./generateSummaryDocx");

/**
 * **The same two documents, as PDF.**
 *
 * Asked for 21 September 2026: a PDF beside each Download .docx. Both routes
 * below branch on `?format=pdf` rather than gaining a path of their own —
 * one document, one URL, one permission check, and the only thing that differs
 * is how it is rendered.
 *
 * Chromium is shared and kept warm by `pdfRender.service`. When it cannot run
 * at all the caller is told so in those words rather than being handed a 500
 * that looks like the summary failed: the .docx is still there, and that is
 * the useful thing to say.
 */
const { summaryHtml, transcriptHtml } = require("./meetingPdf");
const {
  htmlToPdf,
  RendererUnavailableError,
} = require("../../services/pdfRender.service");

function pdfUnavailable(res, e) {
  console.error("[MeetingPdf] renderer unavailable:", e.message);
  return res.status(503).json({
    error:
      "The PDF renderer is not available on this server. The .docx download still works.",
  });
}
const { db, admin } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_UPLOAD_BASE =
  "https://generativelanguage.googleapis.com/upload/v1beta";

/**
 * Models to try in order.
 *
 * **Set GEMINI_MODELS in .env to change this without a deploy.** That is the
 * point of the env var: three of the four names hardcoded here previously were
 * retired by Google between April and August 2026, and every one of them was a
 * code edit in four separate files to fix. Google retires model names on its
 * own schedule, so the list is configuration, not logic.
 *
 * The defaults below were verified against THIS project's API key on
 * 28 August 2026 by listing `/v1beta/models` and sending each one a request:
 *
 *   gemini-3.6-flash        ✅  Google's own named replacement for 2.0-flash
 *   gemini-3-flash-preview  ✅  works, but it is a PREVIEW name — first to go
 *   gemini-3.5-transcribe   ✅  purpose-built for transcription
 *
 * Order is deliberate. `3.6-flash` leads because it is a stable name with a
 * 1M-token input window, and `callGemini` serves the summary as well as the
 * transcript. `3.5-transcribe` is last despite being the better transcriber:
 * its input window is 98k tokens, about a tenth of the others', so a long
 * meeting would not fit — it is a good fallback and a bad default.
 *
 * Retired and removed: gemini-2.0-flash (gone), gemini-2.5-flash and
 * gemini-2.5-flash-lite (both "no longer available to new users" — Google
 * grandfathered existing callers and this key was not one).
 */
const MODELS_TO_TRY = (
  process.env.GEMINI_MODELS ||
  "gemini-3.6-flash,gemini-3-flash-preview,gemini-3.5-transcribe"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// In-memory lock to prevent duplicate simultaneous requests for same meetId
const processingLocks = new Set();
const processingLockTimestamps = new Map(); // meetId -> timestamp when lock was acquired
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max — auto-expire stale locks

// ── Helper: sleep ─────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Google Drive client ───────────────────────────────────────────────────────
function getDriveClient() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  let key;
  try {
    key = JSON.parse(keyJson);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY invalid JSON");
  }
  if (key.private_key) key.private_key = key.private_key.replace(/\\n/g, "\n");
  return google.drive({
    version: "v3",
    auth: new google.auth.GoogleAuth({
      credentials: {
        client_email: key.client_email,
        private_key: key.private_key,
      },
      scopes: ["https://www.googleapis.com/auth/drive"],
    }),
  });
}

/**
 * Refuse a recording the model cannot parse, before it can spoil the rest.
 *
 * **One bad file among seven loses the whole meeting.** `generateContent` takes
 * every audio file in a single request, so an unparseable one is not a missing
 * participant — it is a 400 for the entire transcript, and the message Google
 * returns is the unimprovable "Request contains an invalid argument." with no
 * `error.details` naming which file. That is a very expensive way to find out
 * that one upload went wrong.
 *
 * The check is the container's magic number, which is four bytes and certain.
 * A WebM file begins `1A 45 DF A3` — the EBML header. Recordings have been
 * arriving with that first `0x1A` missing, starting `45 DF A3 9F` instead: one
 * byte short at the front, everything else intact, the file still 1MB of real
 * Opus audio and still perfectly ACTIVE in Gemini's storage. Nothing upstream
 * notices, because nothing upstream looks.
 *
 * Throwing here rather than repairing is deliberate. The per-file `try` in the
 * upload loop already skips a failure and carries on, so the meeting gets a
 * transcript from the recordings that ARE sound, and the log names the one that
 * is not. Silently prepending the missing byte would hide a corruption whose
 * cause is not yet understood — and a transcript built from a file we quietly
 * patched is not evidence of anything.
 */
function assertPlayableContainer(buffer, mime, displayName) {
  const base = (mime || "").split(";")[0].trim().toLowerCase();
  if (base !== "audio/webm" && base !== "video/webm") return;

  const magic = buffer.subarray(0, 4).toString("hex");
  if (magic === "1a45dfa3") return;

  /* Named precisely, because the whole point is that this used to be invisible.
     The `45dfa39f` case is the one seen in the wild; anything else that is not
     a WebM header is reported the same way. */
  const hint =
    magic === "45dfa39f"
      ? "the leading 0x1A of the EBML header is missing — the upload lost its first byte"
      : `expected an EBML header (1a45dfa3), found ${magic}`;
  throw new Error(
    `Corrupt WebM in ${displayName}: ${hint}. Skipping this recording so the rest of the meeting can still be transcribed.`,
  );
}

/**
 * A MIME type Gemini will actually accept for a recording.
 *
 * Drive reports whatever the file was uploaded as, and that is not always
 * something the model takes. Two cases, both verified against the live API on
 * 28 August 2026:
 *
 *   application/octet-stream → 400 "Unsupported MIME type". Drive's fallback
 *     when it cannot identify a file, and one such file among seven poisons
 *     the whole request — every participant's transcript lost to one bad row.
 *   video/webm → the upload is accepted but the file never reaches ACTIVE, and
 *     the request then fails with "not in an ACTIVE state". A browser that
 *     records with a video container reports this even for audio-only.
 *
 * Both become `audio/webm`, which is what the recorder actually produces — the
 * frontend's MediaRecorder writes a WebM/Opus container. `audio/webm;codecs=opus`
 * is left alone: it was tested and is accepted as-is, and narrowing it would
 * throw away a true description for no gain.
 */
function normaliseAudioMime(mime) {
  const raw = (mime || "").trim();
  if (!raw) return "audio/webm";

  const base = raw.split(";")[0].trim().toLowerCase();

  /* Anything Gemini documents for audio passes through untouched, codecs and
     all — the parameter is legal and carries real information. */
  if (base.startsWith("audio/")) return raw;

  if (base === "video/webm") return "audio/webm";
  if (base === "video/mp4") return "audio/mp4";

  /* Everything else — octet-stream, an empty string, something Drive invented
     — is a recording this pipeline uploaded, so it is WebM/Opus whatever Drive
     believes. Guessing right beats a 400 that loses the whole meeting. */
  console.warn(
    `[Pipeline] Drive reported '${raw}' for a recording — sending it as audio/webm`,
  );
  return "audio/webm";
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
    console.warn(
      `[Pipeline] Could not get file meta for ${fileId}:`,
      e.message,
    );
    return { size: 0, mimeType: "audio/webm" };
  }
}

// ── STEP 2: Download from Google Drive → Upload to Gemini File API ────────────
// The Conveyor Belt core:
//   Drive stream → buffer (in chunks) → Gemini resumable upload
//   RAM stays at ~60MB constant regardless of meeting size
async function streamDriveToGeminiFileAPI(
  drive,
  fileId,
  mimeType,
  displayName,
  apiKey,
) {
  console.log(`[Pipeline] ▶️  Uploading: ${displayName}`);

  // Get file size (required for Gemini resumable upload header)
  const meta = await getDriveFileMeta(drive, fileId);
  if (meta.size > 0 && meta.size < 1000) {
    throw new Error(
      `File too small (${meta.size} bytes) — likely empty recording`,
    );
  }
  // Use detected mimeType from Drive if not overridden
  const resolvedMime = normaliseAudioMime(mimeType || meta.mimeType);

  console.log(
    `[Pipeline] File size: ${meta.size > 0 ? (meta.size / 1024 / 1024).toFixed(2) + " MB" : "unknown"}`,
  );

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
    },
  );

  if (!initRes.ok) {
    const errText = await initRes.text();
    throw new Error(
      `Gemini upload init failed (${initRes.status}): ${errText}`,
    );
  }

  const uploadUrl = initRes.headers.get("x-goog-upload-url");
  if (!uploadUrl)
    throw new Error("No upload URL returned from Gemini File API");

  console.log(
    `[Pipeline] Resumable upload session created for: ${displayName}`,
  );

  // ── Phase B: Download file from Google Drive (streaming into buffer) ───────
  const driveRes = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );

  const chunks = [];
  await new Promise((resolve, reject) => {
    driveRes.data.on("data", (chunk) => chunks.push(chunk));
    driveRes.data.on("end", resolve);
    driveRes.data.on("error", reject);
  });

  const fullBuffer = Buffer.concat(chunks);
  console.log(
    `[Pipeline] Downloaded ${(fullBuffer.length / 1024 / 1024).toFixed(2)} MB from Drive`,
  );

  if (fullBuffer.length < 1000) {
    throw new Error(
      `Downloaded file too small (${fullBuffer.length} bytes) — skipping`,
    );
  }

  assertPlayableContainer(fullBuffer, resolvedMime, displayName);

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

  if (!fileUri)
    throw new Error("No file URI returned from Gemini after upload");

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
    await fetch(`${GEMINI_BASE}/files/${cleanName}?key=${apiKey}`, {
      method: "DELETE",
    });
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
    ...geminiFiles.map((f) => ({
      fileData: {
        mimeType: f.mimeType,
        fileUri: f.fileUri,
      },
    })),
    { text: prompt },
  ];

  /* Every failure, not just the last one — see `summariseFailures`. */
  const failures = [];

  for (const modelName of MODELS_TO_TRY) {
    // Each model gets up to 2 attempts (1 retry on quota error)
    let attempts = 0;
    const MAX_ATTEMPTS = 2;

    while (attempts < MAX_ATTEMPTS) {
      attempts++;
      try {
        console.log(
          `[Gemini] Trying model: ${modelName} (attempt ${attempts}/${MAX_ATTEMPTS})`,
        );
        const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;
        const body = {
          contents: [{ parts }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 32768 },
        };

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          /* `error.details` is where Google names the offending field on a 400.
             Dropping it is what made "Request contains an invalid argument."
             the whole of what anybody ever saw — a sentence that says a request
             was wrong without saying which part. */
          const extra = Array.isArray(err?.error?.details)
            ? ` | details: ${JSON.stringify(err.error.details).slice(0, 800)}`
            : "";
          const msg = (err?.error?.message || `HTTP ${res.status}`) + extra;

          // 429 = quota/rate limit — wait and retry same model once
          if (res.status === 429 && attempts < MAX_ATTEMPTS) {
            // Try to extract retry delay from error message (e.g. "retry in 19.7s")
            const retryMatch = msg.match(/retry in (\d+(\.\d+)?)s/i);
            const waitMs = retryMatch
              ? Math.ceil(parseFloat(retryMatch[1])) * 1000 + 1000
              : 25000;
            console.warn(
              `[Gemini] ${modelName} quota hit — waiting ${waitMs / 1000}s then retrying...`,
            );
            await sleep(waitMs);
            continue; // retry same model
          }

          // 404 = model not found — no point retrying, move to next model
          if (res.status === 404) {
            console.warn(
              `[Gemini] ${modelName} not found on v1beta — skipping`,
            );
            recordFailure(failures, modelName, res.status, msg);
            break; // exit while loop, try next model
          }

          console.warn(`[Gemini] ${modelName} failed (${res.status}): ${msg}`);
          recordFailure(failures, modelName, res.status, msg);
          break; // exit while loop, try next model
        }

        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!text) {
          console.warn(`[Gemini] ${modelName} returned empty content`);
          recordFailure(failures, modelName, 200, "Empty response from Gemini");
          break;
        }

        console.log(
          `[Gemini] ✅ Response from ${modelName} (${text.length} chars)`,
        );
        return text; // ← success
      } catch (e) {
        console.warn(`[Gemini] ${modelName} error:`, e.message);
        recordFailure(failures, modelName, 0, e.message);
        break; // network error — move to next model
      }
    }
  }

  throw new Error(summariseFailures(failures));
}

/**
 * How informative a failure is, for deciding which one to report.
 *
 * This exists because of a real afternoon. Four models were tried; the FIRST
 * returned 400 "Request contains an invalid argument" — a fault in the request
 * we were sending — and the other three returned 404 because their names had
 * been retired. The old code kept `lastError`, so the message that reached the
 * screen was "models/gemini-2.0-flash is no longer available", and the actual
 * blocker was invisible. Fixing every model name would have changed nothing
 * and the same 400 would have come back wearing a different name.
 *
 * So: a request-shaped failure outranks a name-shaped one. A 404 says the LIST
 * is stale, which is worth knowing and is never the reason a good request
 * failed.
 */
function failureRank(status) {
  if (status === 400) return 5; // the request itself is wrong — most actionable
  if (status === 403) return 4; // key, billing or permission
  if (status === 429) return 3; // quota
  if (status === 0 || status >= 500) return 2; // network or Google's end
  if (status === 404) return 1; // this model name is gone — least actionable
  return 2;
}

function recordFailure(failures, model, status, message) {
  failures.push({ model, status, message });
}

/**
 * One sentence leading with the failure worth acting on, then all of them.
 *
 * Every model is still listed, because "three of your model names are dead" is
 * a real finding even when it is not today's blocker — it is simply reported
 * behind the thing that is.
 */
function summariseFailures(failures) {
  if (failures.length === 0) return "All Gemini models failed";

  const ranked = [...failures].sort(
    (a, b) => failureRank(b.status) - failureRank(a.status),
  );
  const worst = ranked[0];
  const rest = failures
    .map((f) => `${f.model} (${f.status || "network"}): ${f.message}`)
    .join(" | ");

  return `${worst.model} failed with ${worst.status || "a network error"}: ${worst.message} — all ${failures.length} models tried: ${rest}`;
}

function buildPrompt(participantNames, timeline) {
  const names = participantNames.join(", ");

  // Build a plain-text timeline block Gemini can read.
  // Format: [HH:MM:SS] {SpeakerName} spoke for {N}s
  let timelineBlock = "";
  if (Array.isArray(timeline) && timeline.length > 0) {
    const first = timeline[0].startMs;
    const fmt = (ms) => {
      const s = Math.max(0, Math.floor((ms - first) / 1000));
      const hh = String(Math.floor(s / 3600)).padStart(2, "0");
      const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
      const ss = String(s % 60).padStart(2, "0");
      return `${hh}:${mm}:${ss}`;
    };
    const lines = timeline.map(
      (t, i) =>
        `${String(i + 1).padStart(3, "0")}. [${fmt(t.startMs)}] ${t.speaker} speaks (${(t.durationMs / 1000).toFixed(1)}s)`,
    );
    timelineBlock = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
AUTHORITATIVE CHRONOLOGICAL TIMELINE — USE THIS FOR ORDER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
This is the TRUE chronological order of who spoke when during the meeting.
Each line shows: turn number, timestamp (relative to meeting start), speaker, and how long they spoke.

${lines.join("\n")}

YOU MUST USE THIS TIMELINE TO ORDER THE CONVERSATION SECTION.
Do not order turns by which audio file you listened to first.
Go turn-by-turn in the timeline above, find what that speaker said at that timestamp in their audio file, and output the line.
If the timeline says turn 1 is Ritushree at 00:00:00, the FIRST line of CONVERSATION must be Ritushree's opening words.
If the timeline says turn 42 is Rakesh at 00:38:12, the LAST line of CONVERSATION must be Rakesh's closing words.
`;
  }

  return `These are individual voice recording files from a single meeting.
Each audio file contains ONLY ONE person's voice.
The participants in this meeting are: ${names}.


IMPORTANT: Analyze ALL audio files together. Reconstruct the full conversation in the ORDER it happened — based on what each person said in response to others.


━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ABSOLUTE RULES — READ CAREFULLY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. DO NOT skip any speaker turn. Every sentence a participant speaks MUST appear in the CONVERSATION section, even if it seems unimportant (greetings, filler, asides, jokes, repeated phrases).
2. DO NOT summarize or merge multiple sentences from one speaker into a single line — one speaker turn = one line.
3. DO NOT drop short utterances ("hmm", "okay", "yes", "got it", "noted") — include them.
4. If a speaker's words are unclear, transcribe best-effort and append "[unclear]" rather than dropping the line.
5. If two speakers overlap, show them in two consecutive lines in the order they started speaking.
6. Translate any Hindi / Odia / Hinglish / other language into English, but keep proper nouns (names, product names, file names) unchanged.
7. A single speaker usually appears MANY TIMES in CONVERSATION — not once.
8. PARTICIPANTS section = ONLY people whose VOICES are in the audio. If a name is only mentioned by others but has no audio file, put it in MEETING SUMMARY as a mentioned person, NOT in PARTICIPANTS.
9. ORDER THE CONVERSATION CHRONOLOGICALLY using the timeline above. The first turn in the timeline is the first line of CONVERSATION. The last turn is the last line.


Respond in this EXACT format (do not change the section headers):

## MEETING SUMMARY
[Write 5-7 sentences summarizing what was discussed and decided overall]

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




VOICES ACTUALLY HEARD IN AUDIO FILES (these are the ONLY participants):
${participantNames.map((name, i) => `  File ${i + 1}: ${name}`).join("\n")}

IMPORTANT DISTINCTION:
- "PARTICIPANTS" = ONLY the people whose VOICES are in the audio files above
- "MENTIONED PEOPLE" = People discussed in conversation but NOT present

EXAMPLE OF CORRECT OUTPUT:
If audio has voices of Rakesh and Jiten, and they discuss Pramod:

## PARTICIPANTS
- Rakesh Biswal
- Jiten Swain
(NOT Pramod - his voice is not in audio)

## CONVERSATION
Rakesh: "I talked to Pramod yesterday about the CAD files."
Jiten: "What did Pramod say?"
Rakesh: "He'll send them by Friday."

## MEETING SUMMARY
Rakesh and Jiten discussed Pramod's pending CAD files. Rakesh confirmed 
Pramod will deliver them by Friday.

Respond in this EXACT format:

## PARTICIPANTS
[List ONLY people whose VOICES are in the audio files above]

## MEETING SUMMARY
[3-5 sentences about what was discussed, including mentions of absent people]

## CONVERSATION
[Format: {Name}: "{what they said}"]

## TASKS ASSIGNED
[Format: - {Person}: {task} [Deadline: {date}]]

## DEADLINES MENTIONED
[Format: - {Task} by {date}]

## ACTION ITEMS
[Format: - {action item}]

RULES:
- If someone's voice is NOT in audio files, they CANNOT be in PARTICIPANTS
- If someone is mentioned in conversation, include that in SUMMARY and CONVERSATION
- Translate Hindi/Odia to English

Rules:
- If audio is in Hindi, Odia, or mixed language → translate everything to English
- Each person can appear MULTIPLE TIMES in the CONVERSATION section
- Show the conversation in correct sequence as it happened
- Keep quotes natural — paraphrase if exact words unclear`;
}

/**
 * **The summary, made from the transcript, in the same run.**
 *
 * Reported 21 September 2026: downloading a transcript gave a Summary box
 * reading "No summary has been generated for this meeting yet", because the
 * summary was a SEPARATE button that had never been pressed. The answer asked
 * for was not a better message — it was that there should be nothing to press:
 * "generate the Summary and Transcription at the same time from the same
 * meeting communication."
 *
 * So this runs at the end of the transcript route, and it reads the transcript
 * rather than the audio. That matters for three reasons:
 *
 *   · it is the same meeting communication, by construction — the summary
 *     cannot describe a different call from the one printed underneath it;
 *   · the audio is already uploaded, transcribed and deleted by then, and
 *     sending fifty minutes of it through the model a second time would double
 *     the slowest part of the job for nothing;
 *   · text is small, so this costs one quick call on top of a job that already
 *     took several minutes.
 *
 * The existing audio-based `/audio/summary` route is untouched and still works.
 * This does not replace it; it means nobody has to use it before a transcript
 * document is worth reading.
 *
 * The section headers are the ones `parseResponse` already reads, so the result
 * is the exact shape `meeting_summaries` holds and every reader of it — the
 * panel, the summary document, the transcript's own Summary box — keeps
 * working with no change.
 */
async function summariseFromTranscript(apiKey, utterances, participantNames, meetTitle) {
  const lines = (utterances || [])
    .map((u) => {
      const t = Number(u?.start) || 0;
      const clock = `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
      return `[${clock}] ${u?.speaker ?? "Unknown"}: ${u?.text ?? ""}`;
    })
    .join("\n");

  if (!lines.trim()) return null;

  const who = (participantNames || []).length
    ? `The people in this meeting were: ${participantNames.join(", ")}.`
    : "";

  const prompt = `Below is the full transcript of a meeting${
    meetTitle ? ` titled "${meetTitle}"` : ""
  }. ${who}

Read ALL of it and write a summary for somebody who was not there and will not read the transcript.

Respond in this EXACT format (do not change the section headers, and write nothing outside them):

## MEETING SUMMARY
[10 to 15 lines. Not five, not thirty. Cover, in this order and in plain sentences:
 - what the meeting was about and what was actually discussed;
 - the decisions taken and what was agreed;
 - any updates, numbers, dates or names that matter (order numbers, quantities, suppliers, systems);
 - anything left unresolved or waiting on somebody.
Write about what was really said. Do not invent anything that is not in the transcript, and do not pad it out with sentences that say nothing.]

## TASKS ASSIGNED
[One per line, exactly:
- {Name}: {what they have to do} [Deadline: {the deadline, or "Not specified"}]
{Name} must be the person who has to DO it, not the person who asked. Include every task anybody was asked to do or agreed to do.
If genuinely nobody was given anything to do, write: No tasks were assigned]

## DEADLINES MENTIONED
[One per line, exactly:
- {Person}: {what} by {date or time as it was said}
Only dates that were actually spoken. If none, write: No specific deadlines mentioned]

## ACTION ITEMS
[One per line, the next steps the meeting decided that are not already a named person's task above.
If none, write: No action items]

TRANSCRIPT:
${lines}`;

  /* No file parts — `callGemini` sends the prompt alone, which is what makes
     this the cheap call rather than a second pass over the audio. */
  const text = await callGemini(apiKey, [], prompt);
  const parsed = parseResponse(text);
  if (!parsed.summary && !parsed.tasksAssigned.length) return null;
  return parsed;
}

// ── Parse Gemini response into structured sections ────────────────────────────
function parseResponse(text) {
  const get = (header, stops) => {
    const re = new RegExp(
      `##\\s*${header}[\\s\\S]*?\\n([\\s\\S]*?)(?=##\\s*(?:${stops.join("|")})|$)`,
      "i",
    );
    const m = text.match(re);
    return m ? m[1].trim() : "";
  };

  const toList = (str) =>
    str
      .split("\n")
      .map((l) => l.replace(/^[-•*]\s*/, "").trim())
      .filter((l) => l.length > 2);

  const convRaw = get("CONVERSATION", ["TASKS", "DEADLINES", "ACTION"]);
  const dialogue = [];
  const lineRe = /^([^:"]+?):\s*"?(.+?)"?\s*$/;
  convRaw.split("\n").forEach((line) => {
    line = line.trim().replace(/^[-•*]\s*/, "");
    if (!line) return;
    const m = line.match(lineRe);
    if (m) {
      dialogue.push({ speaker: m[1].trim(), text: m[2].trim() });
    } else if (line.includes(":")) {
      const idx = line.indexOf(":");
      const spk = line.slice(0, idx).trim();
      const txt = line
        .slice(idx + 1)
        .trim()
        .replace(/^"|"$/g, "");
      if (spk && txt) dialogue.push({ speaker: spk, text: txt });
    }
  });

  return {
    summary: get("MEETING SUMMARY", [
      "CONVERSATION",
      "TASKS",
      "DEADLINES",
      "ACTION",
    ]),
    dialogue,
    conversationFlow: dialogue.map((d) => `${d.speaker}: "${d.text}"`),
    tasksAssigned: toList(get("TASKS ASSIGNED", ["DEADLINES", "ACTION"])),
    deadlines: toList(get("DEADLINES MENTIONED", ["ACTION"])).filter(
      (l) => !l.toLowerCase().includes("no specific"),
    ),
    actionItems: toList(get("ACTION ITEMS", [])),
    rawText: text,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/test-gemini  — no auth, for debugging
/**
 * A failure the caller should report as itself rather than as a 500.
 *
 * The gather step below has two outcomes a person can act on — nothing was
 * recorded, and nothing could be read from Drive — and both used to be written
 * as `res.status(...)` inside the summary handler. Lifting the block out means
 * they have to travel, so they travel as errors carrying their own status.
 */
class PipelineError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Everything a meeting's audio must become before Gemini can be asked anything
 * about it: found, uploaded, and ACTIVE.
 *
 * Lifted out of the summary handler so the transcript can ask the same question
 * of the same files. It is not a rewrite — the Drive union-scan that rescues
 * rejoin `(1).webm` files, the one-file-at-a-time conveyor that keeps RAM flat,
 * and the skip-and-continue on a bad file are the summary's own, unchanged.
 * Two features reading the same recordings must not hold two opinions about
 * which recordings there are.
 *
 * Appends to `uploadedGeminiFiles` rather than returning them, so the caller
 * keeps ownership of cleanup: those files have to be deleted from Gemini
 * storage on failure as well as success, and only the caller knows when it is
 * done with them.
 */
async function gatherMeetingAudio(meetId, apiKey, uploadedGeminiFiles) {
  // ── Get audio records from Firestore ──────────────────────────────
  const snap = await db
    .collection("meeting_audio_recordings")
    .where("meetId", "==", meetId)
    .get();

  if (snap.empty) {
    throw new PipelineError(
      404,
      "No audio recordings found for this meeting. Record a meeting first.",
    );
  }

  const recordings = snap.docs.map((d) => d.data());
  console.log(
    `\n[Pipeline] 🚀 Firestore has ${recordings.length} recording row(s) for meet: ${meetId}`,
  );

  const drive = getDriveClient();

  // ── BELT-AND-BRACES: also scan Drive folder for ANY (1)/(2)/... files ──
  // If a user rejoined and a Firestore row was overwritten, the (1).webm
  // file is still in Drive. We union-merge Drive scan results with
  // Firestore rows, keyed by driveFileId, so NO audio file is missed.
  try {
    const recordingsByDriveId = new Map(
      recordings
        .filter((r) => r.driveFileId)
        .map((r) => [r.driveFileId, r]),
    );

    // Navigate to the meeting folder: CoWork Audio Recording / meeting / {meetId}
    const findFolder = async (name, parentId) => {
      const q = parentId
        ? `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
        : `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const resp = await drive.files.list({
        q,
        fields: "files(id,name)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return resp.data.files?.[0]?.id || null;
    };

    const rootId = await findFolder("CoWork Audio Recording", null);
    if (rootId) {
      const mtgRootId = await findFolder("meeting", rootId);
      if (mtgRootId) {
        const meetFolderId = await findFolder(meetId, mtgRootId);
        if (meetFolderId) {
          const filesResp = await drive.files.list({
            q: `'${meetFolderId}' in parents and trashed=false and (mimeType contains 'audio' or name contains '.webm' or name contains '.mp4' or name contains '.ogg')`,
            fields: "files(id,name,mimeType,size)",
            pageSize: 500,
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
          });
          const driveFiles = filesResp.data.files || [];
          console.log(
            `[Pipeline] 🗂️  Drive folder scan found ${driveFiles.length} audio file(s) in meet ${meetId}`,
          );

          for (const f of driveFiles) {
            if (recordingsByDriveId.has(f.id)) continue; // already covered by Firestore

            // Parse filename: E015_RakeshBiswal_audio_M042 (1).webm
            const m = f.name.match(/^([A-Za-z0-9]+)_([A-Za-z0-9]+)_audio_/);
            const employeeId = m ? m[1] : "Unknown";
            const employeeName = m
              ? m[2].replace(/([A-Z])/g, " $1").trim()
              : f.name;

            const syntheticRec = {
              meetId,
              employeeId,
              employeeName,
              firstName: employeeName.split(" ")[0],
              fileName: f.name,
              mimeType: f.mimeType || "audio/webm",
              driveFileId: f.id,
              driveViewUrl: `https://drive.google.com/file/d/${f.id}/view`,
              status: "uploaded",
              isSynthetic: true, // flag — not from Firestore
            };
            recordings.push(syntheticRec);
            console.log(
              `[Pipeline] ➕ Picked up extra Drive file: ${f.name}`,
            );
          }
        }
      }
    }
  } catch (scanErr) {
    console.warn(
      `[Pipeline] ⚠️  Drive folder scan failed (continuing with Firestore rows only): ${scanErr.message}`,
    );
  }

  console.log(`[Pipeline] 📦 TOTAL files to process: ${recordings.length}`);
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
    console.log(
      `\n[Pipeline] ── File ${i + 1}/${recordings.length}: ${rec.fileName} ──`,
    );

    try {
      const mimeType = rec.mimeType || "audio/webm";
      const displayName = `${meetId}_${rec.employeeName || rec.employeeId}_${Date.now()}`;

      // BELT STEP 1+2: Drive stream → Gemini File API upload
      const geminiFile = await streamDriveToGeminiFileAPI(
        drive,
        rec.driveFileId,
        mimeType,
        displayName,
        apiKey,
      );

      // BELT STEP 3: Wait until Gemini marks file as ACTIVE
      await waitForFileActive(geminiFile.geminiName, apiKey);

      // Collect file reference for batch generateContent call
      uploadedGeminiFiles.push(geminiFile);
      participantNames.push(
        rec.employeeName || rec.firstName || rec.employeeId,
      );

      console.log(`[Pipeline] ✅ File ${i + 1} ready in Gemini Storage`);

      // Small courtesy pause between files
      if (i < recordings.length - 1) await sleep(500);
    } catch (e) {
      // Non-fatal: log and skip this file, continue with rest
      console.error(
        `[Pipeline] ⚠️  Skipping ${rec.fileName}: ${e.message}`,
      );
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  if (uploadedGeminiFiles.length === 0) {
    throw new PipelineError(
      400,
      "Could not upload any audio files to Gemini File API. Check Drive permissions.",
    );
  }

  /* `recordings` travels back too: the caller builds its speech timeline and
     its audioFiles record from the same rows, and re-reading them would risk a
     different answer than the one the files were uploaded from. */
  return { participantNames, recordings };
}

// ─────────────────────────────────────────────────────────────────────────────
router.get("/audio/test-gemini", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey)
    return res.status(500).json({ error: "GEMINI_API_KEY not set in .env" });

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
    fileApiStatus = listRes.ok
      ? "✅ File API accessible"
      : `❌ HTTP ${listRes.status}`;
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
      const doc = await db
        .collection("meeting_summaries")
        .doc(req.params.meetId)
        .get();
      if (!doc.exists)
        return res.json({ success: true, exists: false, summary: null });
      return res.json({ success: true, exists: true, summary: doc.data() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/summary/:meetId/public?token=... — NO Firebase auth.
// Gated by publicShareToken only (not publicShareEnabled/status), so this
// keeps working after the meeting ends — read-only, never triggers generation.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/audio/summary/:meetId/public", async (req, res) => {
  try {
    const { meetId } = req.params;
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: "token required" });

    const meetDoc = await db
      .collection("cowork_scheduled_meets")
      .doc(meetId)
      .get();
    if (!meetDoc.exists)
      return res.status(404).json({ error: "Meeting not found" });

    const meet = meetDoc.data();
    if (!meet.publicShareToken || meet.publicShareToken !== token) {
      return res.status(403).json({ error: "Invalid link for this meeting." });
    }

    const doc = await db.collection("meeting_summaries").doc(meetId).get();
    if (!doc.exists)
      return res.json({ success: true, exists: false, summary: null });
    return res.json({ success: true, exists: true, summary: doc.data() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
    /* Declared out here so the `finally` below can release the lock — it is a
       sibling block of the try and cannot see anything declared inside it. */
    const { meetId } = req.params;

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey)
        return res
          .status(500)
          .json({ error: "GEMINI_API_KEY not set in .env" });

      // ── Duplicate request guard ─────────────────────────────────────────
      // Auto-expire stale locks (prevents stuck locks from crashes/timeouts)
      if (processingLocks.has(meetId)) {
        const lockAge =
          Date.now() - (processingLockTimestamps.get(meetId) || 0);
        if (lockAge < LOCK_TIMEOUT_MS) {
          console.warn(
            `[MeetingSummary] Duplicate request blocked for ${meetId} (age: ${Math.round(lockAge / 1000)}s)`,
          );
          return res
            .status(429)
            .json({
              error: "Summary generation already in progress. Please wait.",
            });
        }
        // Stale lock — auto-release and continue
        console.warn(`[MeetingSummary] Stale lock auto-released for ${meetId}`);
        processingLocks.delete(meetId);
        processingLockTimestamps.delete(meetId);
      }
      processingLocks.add(meetId);
      processingLockTimestamps.set(meetId, Date.now());

      // ── Return cached if < 24h old — UNLESS ?force=true is passed ─────
      const forceRegenerate = req.query.force === "true";
      const existing = await db
        .collection("meeting_summaries")
        .doc(meetId)
        .get();
      if (existing.exists && !forceRegenerate) {
        const d = existing.data();
        const ageHours = (Date.now() - (d.createdAtMs || 0)) / 3600000;
        if (ageHours < 24) {
          console.log(
            `[MeetingSummary] Returning cached summary for ${meetId}`,
          );
          processingLocks.delete(meetId);
          processingLockTimestamps.delete(meetId);
          return res.json({ success: true, summary: d, cached: true });
        }
      }
      if (forceRegenerate) {
        console.log(
          `[MeetingSummary] Force regenerate requested for ${meetId} — bypassing cache`,
        );
      }

      // ── Find, upload and activate every recording for this meeting ────
      const { participantNames, recordings } = await gatherMeetingAudio(
        meetId,
        apiKey,
        uploadedGeminiFiles,
      );

      console.log(
        `\n[Pipeline] 🎯 ${uploadedGeminiFiles.length}/${recordings.length} file(s) ready — sending to Gemini...`,
      );

      // ── Build a chronological timeline from everyone's speechIntervals ──
      // Each participant's hook logged {startMs, endMs, durationMs} for every
      // unmute→mute transition. Merging all of these and sorting by startMs
      // gives Gemini the TRUE order of speaker turns across the whole meeting.
      const timeline = [];
      for (const rec of recordings) {
        if (!Array.isArray(rec.speechIntervals)) continue;
        const speaker =
          rec.employeeName || rec.firstName || rec.employeeId || "Unknown";
        for (const iv of rec.speechIntervals) {
          if (typeof iv.startMs !== "number" || typeof iv.endMs !== "number")
            continue;
          timeline.push({
            speaker,
            employeeId: rec.employeeId,
            startMs: iv.startMs,
            endMs: iv.endMs,
            durationMs: iv.durationMs || iv.endMs - iv.startMs,
          });
        }
      }
      timeline.sort((a, b) => a.startMs - b.startMs);
      console.log(
        `[Pipeline] 🕒 Timeline built: ${timeline.length} speaker turn(s) across ${new Set(timeline.map((t) => t.speaker)).size} speaker(s)`,
      );

      // ── Send File URI references + prompt → Gemini generateContent ────
      const prompt = buildPrompt(participantNames, timeline);
      const rawText = await callGemini(apiKey, uploadedGeminiFiles, prompt);

      // ── Self-Cleaning: remove all files from Gemini File API ──────────
      // ── Save Gemini URIs so Ask AI can reuse them (no re-upload) ──────
      await db
        .collection("meeting_gemini_files")
        .doc(meetId)
        .set({
          meetId,
          files: uploadedGeminiFiles.map((f, i) => ({
            fileUri: f.fileUri,
            geminiName: f.geminiName,
            mimeType: f.mimeType,
            employeeName: participantNames[i] || "",
          })),
          savedAt: Date.now(),
          expiresAt: Date.now() + 47 * 60 * 60 * 1000,
        });
      console.log(`[Pipeline] 💾 Gemini URIs saved for Ask AI reuse (47h TTL)`);

      // ── Parse response ────────────────────────────────────────────────
      const parsed = parseResponse(rawText);

      // ── Fetch meeting title ───────────────────────────────────────────
      let meetTitle = meetId;
      try {
        const meetDoc = await db
          .collection("cowork_scheduled_meets")
          .doc(meetId)
          .get();
        if (meetDoc.exists) {
          meetTitle =
            meetDoc.data().title || meetDoc.data().meetTitle || meetId;
        }
      } catch (_) {
        /* non-fatal */
      }

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
        audioFiles: recordings.map((r) => ({
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
      db.collection("cowork_scheduled_meets")
        .doc(meetId)
        .update({
          summary_status: "completed",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        })
        .catch(() => {});

      processingLocks.delete(meetId);
      processingLockTimestamps.delete(meetId);
      return res.json({ success: true, summary: summaryData, cached: false });
    } catch (e) {
      console.error("[MeetingSummary POST] Error:", e.message);
      processingLocks.delete(meetId);
      processingLockTimestamps.delete(meetId); // always release lock

      // Emergency cleanup on failure — don't leave files in Gemini storage
      if (uploadedGeminiFiles.length > 0) {
        const apiKey = process.env.GEMINI_API_KEY;
        console.log(
          `[Pipeline] 🧹 Emergency cleanup of ${uploadedGeminiFiles.length} file(s)...`,
        );
        await Promise.all(
          uploadedGeminiFiles.map((f) =>
            deleteGeminiFile(f.geminiName, apiKey).catch(() => {}),
          ),
        );
      }

      if (e.message?.includes("403") || e.message?.includes("suspended")) {
        return res.status(403).json({
          error:
            "Gemini API key suspended or invalid. Create a new key at aistudio.google.com.",
        });
      }
      /* "No audio recordings found" is a 404 the person can act on. Before the
         gather step was shared it WAS one; letting it fall through to 500 here
         would turn an instruction into a server fault. */
      return res.status(e.status || 500).json({ error: e.message });
    } finally {
      // ── Release the lock however we leave ──────────────────────────────
      // The success path and the catch each released it, but an early
      // `return` from inside the try reaches NEITHER. Two of them do exactly
      // that: "No audio recordings found" (404) and the Gemini-upload 400.
      //
      // So asking for a summary of a meeting that was never recorded — the
      // ordinary mistake — left the lock held, and every later attempt on
      // that meeting was refused with "Summary generation already in
      // progress. Please wait." for the full ten-minute timeout, INCLUDING
      // after a recording had been made. The one error a person can act on
      // was followed by ten minutes of an error they cannot.
      //
      // `finally` runs on every exit, so this cannot drift out of step with
      // the returns above again.
      processingLocks.delete(meetId);
      processingLockTimestamps.delete(meetId);
    }
  },
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
        const meetDoc = await db
          .collection("cowork_scheduled_meets")
          .doc(meetId)
          .get();
        if (meetDoc.exists) {
          const m = meetDoc.data();
          meetTitle = m.title || m.meetTitle || meetTitle;
          meetDescription =
            m.description || m.meetDescription || meetDescription;
          meetDateTime = m.dateTime || m.meetDateTime || meetDateTime;
        }
      } catch (_) {
        /* non-fatal */
      }

      const summaryWithMeta = {
        ...summary,
        meetTitle,
        meetDescription,
        meetDateTime,
      };
      const safeName = (meetTitle || meetId)
        .replace(/[^a-zA-Z0-9_\- ]/g, "")
        .trim()
        .replace(/\s+/g, "_");
      const wantsPdf = String(req.query.format || "").toLowerCase() === "pdf";
      const fileName = `Meeting_Summary_${safeName}_${meetId}.${wantsPdf ? "pdf" : "docx"}`;

      if (wantsPdf) {
        console.log(`[SummaryPdf] Rendering pdf for ${meetId} — "${meetTitle}"`);
        let pdf;
        try {
          pdf = await htmlToPdf(
            summaryHtml(
              summaryWithMeta,
              meetId,
              /* The docx builder's own reading, so the two documents cannot
                 disagree about what somebody has to do. */
              needsActionGroups(
                summaryWithMeta.tasksAssigned,
                summaryWithMeta.deadlines,
                summaryWithMeta.actionItems,
              ),
            ),
          );
        } catch (e) {
          if (e instanceof RendererUnavailableError || e?.rendererUnavailable) {
            return pdfUnavailable(res, e);
          }
          throw e;
        }
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.setHeader("Content-Length", pdf.length);
        return res.send(pdf);
      }

      console.log(
        `[SummaryDocx] Generating docx for ${meetId} — "${meetTitle}"`,
      );
      const buffer = await generateSummaryDocx(summaryWithMeta, meetId);

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`,
      );
      res.setHeader("Content-Length", buffer.length);
      res.send(buffer);

      console.log(`[SummaryDocx] ✅ Sent ${fileName} (${buffer.length} bytes)`);
    } catch (e) {
      console.error("[SummaryDocx] Error:", e.message);
      res.status(500).json({ error: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIPT — the words, as opposed to a reading of them
//
// The summary above paraphrases, reorders and translates by design; that is
// what makes it useful and what makes it unsuitable as a record. These two
// routes answer the other question — what was actually said — and they run on
// exactly the same audio, through `gatherMeetingAudio`, so the two can never
// disagree about which recordings a meeting has.
//
// Two modes, kept as two stored results rather than one toggled at read time:
//   · verbatim  — the exact words, in whatever language they were spoken
//   · translate — rendered into English, marking WHICH lines were translated
// Generating one never discards the other.
// ─────────────────────────────────────────────────────────────────────────────

const TRANSCRIPT_COLLECTION = "meeting_transcripts_gemini";

/**
 * The instruction, per mode.
 *
 * Both insist on `[unclear]` over a guess. A transcript that quietly invents a
 * plausible sentence is worse than one with a gap in it: the gap can be checked
 * against the recording, the invention cannot be told from the truth.
 */
/** Seconds as M:SS, or H:MM:SS past an hour — for the prompt's own copy. */
function clockOf(totalSecs) {
  const s = Math.max(0, Math.round(totalSecs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

/**
 * **One speaker's own microphone, transcribed on its own.**
 *
 * This used to hand all three files to one call and ask for a merged,
 * time-ordered transcript with the speakers worked out. On M084 that produced
 * 48 lines in which TRINAYAN DOLEY appeared **not once** — three people were
 * recorded and two made it to the page.
 *
 * It was the wrong job to give a model. Merging N streams, aligning them on a
 * shared clock and attributing every line is hard, and it was being asked
 * blind: `speechIntervals` is empty on every recording this product has
 * written, so the "speaking order" block that was supposed to carry the
 * attribution was never in the prompt at all.
 *
 * Per file, none of that arises. The file IS the speaker — `gatherMeetingAudio`
 * pushes the name and the upload together — so attribution stops being a guess
 * and becomes a fact, and each call has one voice and one timeline to follow.
 * The route merges the results on the timestamps afterwards, where merging is
 * arithmetic rather than judgement.
 *
 * `fromSecs` is the other half. A model given fifty minutes of audio returns an
 * opening and stops, so the caller asks again from where the last answer
 * reached — see `transcribeSpeaker`.
 */
function buildTranscriptPrompt(mode, speakerName, durationSecs, fromSecs) {
  const who = `This audio is ONE person's own microphone: ${speakerName}.

Transcribe ONLY what ${speakerName} says. Other people were in the same call and are faintly audible in the background of this recording — ignore them completely. Every line you write is ${speakerName} speaking, and the speaker name on every line is ${speakerName}.`;

  const order = "";

  /**
   * **How long it is, and that it must all be transcribed.**
   *
   * Reported 21 September 2026 with M084, a 50-minute meeting: the translated
   * transcript came back perfectly formatted, nothing for the parser to
   * reject — and it stopped at 2:18. The model had no idea how long the
   * recording was and nothing told it to reach the end, so it did what a model
   * does with a long input and a short example: produced an opening.
   *
   * So the length is stated, and finishing is stated. Both in terms of the
   * audio rather than a line count — asking for "at least N lines" invites
   * padding, and a quiet meeting genuinely has fewer.
   */
  const hasLength = Number.isFinite(durationSecs) && durationSecs > 0;
  const from = Number.isFinite(fromSecs) && fromSecs > 0 ? fromSecs : 0;

  const howLong = hasLength
    ? `\n\nThis recording is about ${Math.round(durationSecs / 60)} minutes long (${clockOf(durationSecs)}). Transcribe ALL of it, to the very end. Do not stop part-way, do not summarise, and do not give only the opening — the last line you write should be near ${clockOf(durationSecs)}. If a long stretch is silence, or ${speakerName} simply is not speaking, skip it and carry on with the next thing they say rather than stopping there.`
    : "";

  /* The resume. Stated as a hard boundary rather than a hint, because a model
     asked to "continue" will otherwise restate what it already gave and the
     caller cannot tell a repeat from a new line at the same second. */
  const resume = from > 0
    ? `\n\nYou have already transcribed everything before ${clockOf(from)}. Begin at ${clockOf(from)} and carry on from there to the end. Do NOT repeat anything earlier than ${clockOf(from)} — your first line must start at or after ${clockOf(from)}.`
    : "";

  const common = `${who}${howLong}${resume}

Return ONLY lines in exactly this format, one utterance per line, and nothing else — no preamble, no headings, no markdown, no code fences:

[start-end] Speaker Name: text

start and end are times from the beginning of the meeting, written as M:SS — or H:MM:SS once past an hour. For example:

[0:00-0:04] Rakesh Biswal: Good morning, shall we start?
[0:05-0:09] Pramod Biswal: Yes, I have the numbers ready.
[12:41-12:48] Rakesh Biswal: Right, and where did the fabric order get to?
[1:04:20-1:04:26] Pramod Biswal: It ships on the twenty-eighth.

Keep using that format for the whole recording, however far in you are.

Where you cannot make out what was said, write [unclear] in place of those words. Never guess at words you cannot hear, and never drop a line because it is hard.`;

  if (mode === "translate") {
    return `${common}

Render every line in ENGLISH. Where a line was originally spoken in another language, translate it and append the marker <<T>> at the very end of that line. Lines already in English get no marker. Do not silently blend the two — the marker is the point: a reader must be able to tell which words are the speaker's own and which are yours.

[0:00-0:04] Rakesh Biswal: Good morning, shall we start?
[0:05-0:09] Pramod Biswal: It will be done by tomorrow. <<T>>`;
  }

  /**
   * **Roman letters, not Devanagari.** Asked for 21 September 2026, looking at
   * a transcript where one speaker's Hindi came back as Devanagari and the
   * next speaker's came back as Hinglish — the same meeting, two scripts, and
   * half of it unreadable to anybody who does not read the script.
   *
   * The ask is precise and worth restating, because the obvious reading of it
   * is wrong: this is NOT a translation. The words and their meaning stay
   * exactly as spoken. Only the letters change. "Verbatim" still means
   * verbatim — the Translated tab is what renders speech into English, and it
   * is unchanged.
   *
   * Why the model needed telling: nothing in the prompt ever named a script,
   * so it picked one per request, and for Hindi it picks Devanagari about as
   * often as Roman. Stating it removes the coin toss.
   *
   * The examples do the work that the instruction cannot. A model told to
   * "use Roman letters" will happily transliterate one letter at a time and
   * produce "sakate hain" and "aura" — correct character by character and not
   * how a single person types Hindi. So the prompt shows the natural spelling
   * beside the mechanical one, and shows the translated version as a third
   * wrong answer so it cannot mistake romanising for translating.
   */
  return `${common}

Transcribe VERBATIM, in the language each line was actually spoken in. Do not translate. Do not tidy grammar, remove filler words, or turn speech into prose — if somebody says "um, so, yeah, we can, we can do that", write that.

Write every line in the LATIN ALPHABET (a-z), whatever language it was spoken in. Hindi, Odia, Bengali, Assamese and the rest go in Roman letters — the way people type them to each other in chat — never in Devanagari or any other script. This is NOT a translation: the words and the meaning stay exactly as spoken, and only the letters change.

One Hindi sentence, and the three ways it could come back:
  WRONG, right words but the wrong script: और आपका जो मेल है, अभी भी आप मेल खोल सकते हैं?
  WRONG, translated into English:          And your mail, can you still open it?
  RIGHT:                                   Aur aapka jo mail hai, abhi bhi aap mail khol sakte hain?

Spell each word the way somebody would actually type it, not one letter at a time: "sakte hain" rather than "sakate hain", "khol" rather than "khola", "aur" rather than "aura", "kiya" rather than "kiyaa". Proper nouns keep their usual English spelling.

A line that mixed Hindi and English stays mixed, with the English words spelled in English:

[0:21-0:30] Rakesh Biswal: Sir kal call kiya tha, aaj mujhe details batayenge, wo bole 28 taareek tak fabric hamare paas pahunch jayega.`;
}

/**
 * Parse the model's lines into utterances.
 *
 * Counts what it could NOT parse rather than dropping it silently: a transcript
 * that lost a third of its lines to a formatting wobble should say so on
 * screen, not merely look short.
 */
/**
 * A timestamp from the model, in seconds.
 *
 * Accepts what models actually write for a long recording: `58` (seconds),
 * `1:02` (minutes and seconds), `1:02:03` (hours too). Anything else reads as
 * NaN and the caller falls back, so a malformed stamp costs the line its time
 * rather than costing the whole line.
 */
function stampToSeconds(raw) {
  const parts = String(raw).split(":").map((p) => Number(p));
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  /* Right to left, so 1:02 is a minute and two seconds whether or not an hour
     was written. */
  return parts.reduce((total, n) => total * 60 + n, 0);
}

/**
 * How many times we will ask one file to carry on.
 *
 * A bound, not a target: the loop stops as soon as a pass reaches the end of
 * the recording or stops making progress. It exists so a model that answers
 * with the same opening every time cannot spin.
 */
const TRANSCRIBE_MAX_PASSES = 20;

/** Stop asking once we are within this of the end — the tail is usually goodbyes. */
const TRANSCRIBE_TAIL_SLACK_SECS = 45;

/**
 * Everything one participant said, from their own microphone.
 *
 * Asks repeatedly, each time from where the previous answer reached, because a
 * model handed fifty minutes of audio returns an opening and stops. Reported on
 * M084: a perfectly formatted transcript that ended at 2:18 of a 55-minute
 * meeting, and a second run that ended at 6:21.
 *
 * Every line is stamped with the file's owner rather than whatever name the
 * model wrote — the file is one person's microphone, so the speaker is known
 * and there is nothing to infer. That is what puts a participant back who was
 * missing from the page entirely.
 */
async function transcribeSpeaker(apiKey, file, speakerName, mode, durationSecs) {
  const utterances = [];
  let unparsedLineCount = 0;
  let reached = 0;

  /**
   * Enough passes to actually reach the end, bounded.
   *
   * A flat eight was not enough: a model answers roughly six minutes at a
   * time, so eight passes cover about forty-eight — and a 55-minute meeting
   * stopped seven minutes short with no sign that it had. The budget is now
   * the length of the recording, plus two for the passes that overlap, with a
   * hard ceiling so nothing can spin.
   */
  const passBudget = Math.min(
    TRANSCRIBE_MAX_PASSES,
    Math.max(4, Math.ceil((durationSecs > 0 ? durationSecs : 0) / 300) + 2),
  );

  for (let pass = 1; pass <= passBudget; pass++) {
    const text = await callGemini(
      apiKey,
      [file],
      buildTranscriptPrompt(mode, speakerName, durationSecs, reached),
    );
    const parsed = parseTranscript(text, mode);
    unparsedLineCount += parsed.unparsedLineCount;

    /* Only what is genuinely new. A resumed pass that restates an earlier line
       must not double it, and comparing on the END keeps a line that merely
       straddles the boundary. */
    const fresh = parsed.utterances.filter((u) => u.end > reached);
    for (const u of fresh) utterances.push({ ...u, speaker: speakerName });

    console.log(
      `[Transcript] ${speakerName} pass ${pass}: +${fresh.length} line(s), reached ${clockOf(
        fresh.length ? Math.max(...fresh.map((u) => u.end)) : reached,
      )}`,
    );

    if (!fresh.length) break;
    const now = Math.max(...fresh.map((u) => u.end));
    /* No length to aim at means one pass is all we can justify: without it
       there is no way to tell "finished" from "stopped early". */
    if (!Number.isFinite(durationSecs) || durationSecs <= 0) break;
    if (now >= durationSecs - TRANSCRIBE_TAIL_SLACK_SECS) break;
    if (now <= reached) break;
    reached = now;
  }

  return { utterances, unparsedLineCount };
}

function parseTranscript(text, mode) {
  const lines = String(text || "")
    .replace(/```[a-z]*\n?/gi, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const utterances = [];
  let unparsedLineCount = 0;

  for (const rawLine of lines) {
    /* A leading bullet is the commonest wrapper a model adds around lines it
       was asked to emit bare. Stripping it costs nothing and saves the line. */
    const line = rawLine.replace(/^[-*•]\s+/, "");

    /* `[12-18] Name: words` — a stamp, a speaker, the rest.
     *
     * **The stamp is read as a clock, not as an integer.** This was
     * `(\d+)\s*[-–]\s*(\d+)\s*`, which matches only whole seconds, and it is
     * what made a 50-minute meeting produce a one-minute transcript.
     *
     * Reported 21 September 2026 with M084: 9 lines parsed, **55 unparsed**,
     * and every surviving line ended at or before 0:58. Past the first minute
     * the model writes `[1:02-1:08]` — which is what anybody would write, and
     * what the prompt's own examples (all under ten seconds) never showed it
     * not to do. Every one of those lines was counted as unparseable and
     * dropped, so the transcript stopped dead at the end of minute one.
     *
     * Seconds still parse, so nothing already working changes. `to` and an `s`
     * suffix are accepted for the same reason: the cost of tolerating a
     * spelling is one alternation, and the cost of rejecting it is an hour of
     * somebody's meeting. */
    const m =
      /^\[\s*([\d:]+)\s*s?\s*(?:[-–—]|to)\s*([\d:]+)\s*s?\s*\]\s*([^:]{1,60}?)\s*:\s*(.*)$/.exec(
        line,
      ) ??
      /* A single stamp with no end. Worth keeping: a line with a time and words
         is a line, and guessing its end as its start loses nothing. */
      (() => {
        const one =
          /^\[\s*([\d:]+)\s*s?\s*\]\s*([^:]{1,60}?)\s*:\s*(.*)$/.exec(line);
        return one ? [one[0], one[1], one[1], one[2], one[3]] : null;
      })();
    if (!m) {
      unparsedLineCount++;
      continue;
    }
    let body = m[4].trim();
    const translated = /<<T>>\s*$/.test(body);
    if (translated) body = body.replace(/<<T>>\s*$/, "").trim();
    if (!body) {
      unparsedLineCount++;
      continue;
    }
    const start = stampToSeconds(m[1]);
    const end = stampToSeconds(m[2]);
    utterances.push({
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? Math.max(end, start) : start,
      speaker: m[3].trim() || "Unknown",
      text: body,
      needsReview: /\[unclear\]/i.test(body),
      ...(mode === "translate" ? { translated } : {}),
    });
  }

  utterances.sort((a, b) => a.start - b.start || a.end - b.end);
  return { utterances, unparsedLineCount, createdAtMs: Date.now() };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/transcript/:meetId — whatever has been generated so far
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/audio/transcript/:meetId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { meetId } = req.params;
      const doc = await db.collection(TRANSCRIPT_COLLECTION).doc(meetId).get();
      /* 404 reads as "nothing generated yet" to the panel, which is why this is
         not an empty object: absence and "generated but empty" are different
         things, and the panel draws them differently. */
      if (!doc.exists)
        return res.status(404).json({ error: "No transcript yet" });
      return res.json({ success: true, transcript: doc.data() });
    } catch (e) {
      console.error("[Transcript GET] Error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /cowork/audio/transcript/:meetId?mode=verbatim|translate[&force=true]
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/audio/transcript/:meetId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    const uploadedGeminiFiles = [];
    const { meetId } = req.params;
    const mode = req.query.mode === "translate" ? "translate" : "verbatim";
    const lockKey = `${meetId}:${mode}`;

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey)
        return res
          .status(500)
          .json({ error: "GEMINI_API_KEY not set in .env" });

      /* Locked per MODE, not per meeting: transcribing the verbatim version
         must not refuse somebody asking for the translated one. */
      if (processingLocks.has(lockKey)) {
        const age = Date.now() - (processingLockTimestamps.get(lockKey) || 0);
        if (age < LOCK_TIMEOUT_MS)
          return res.status(429).json({
            error: "Transcript generation already in progress. Please wait.",
          });
        processingLocks.delete(lockKey);
        processingLockTimestamps.delete(lockKey);
      }
      processingLocks.add(lockKey);
      processingLockTimestamps.set(lockKey, Date.now());

      const ref = db.collection(TRANSCRIPT_COLLECTION).doc(meetId);
      const existing = await ref.get();
      const force = req.query.force === "true";
      if (existing.exists && !force && existing.data()[mode]) {
        return res.json({
          success: true,
          transcript: existing.data(),
          cached: true,
        });
      }

      const { participantNames, recordings } = await gatherMeetingAudio(
        meetId,
        apiKey,
        uploadedGeminiFiles,
      );

      /* The same speaking order the summary builds, for the same reason: each
         participant's own mute/unmute log is the only reliable evidence of who
         was talking when. */
      const timeline = [];
      for (const rec of recordings) {
        const name = rec.employeeName || rec.firstName || rec.employeeId;
        for (const iv of rec.speechIntervals || []) {
          if (!iv || typeof iv.startMs !== "number") continue;
          timeline.push({
            name,
            start: Math.round(iv.startMs / 1000),
            end: Math.round((iv.endMs ?? iv.startMs) / 1000),
          });
        }
      }
      timeline.sort((a, b) => a.start - b.start);

      /**
       * How long the recording runs, for the prompt.
       *
       * The speech timeline first — but it is EMPTY on every recording this
       * product has written, which is how the first attempt at this shipped
       * doing nothing: `durationSecs` came out 0, so the "transcribe all of it"
       * paragraph was never added and the model went on stopping early.
       *
       * So the meeting's own clock is the real source. `startedAt` where the
       * organiser pressed start, the scheduled time otherwise; `endedAt` where
       * the room closed. It can run slightly long — somebody who joined late
       * recorded less than the meeting lasted — which is harmless: the model is
       * told to transcribe to the end of the audio, and the loop stops when a
       * pass stops making progress.
       */
      const fromTimeline = timeline.reduce(
        (latest, t) => Math.max(latest, t.end || 0),
        0,
      );
      let durationSecs = fromTimeline;
      if (!(durationSecs > 0)) {
        try {
          const meetDoc = await db
            .collection("cowork_scheduled_meets")
            .doc(meetId)
            .get();
          const meet = meetDoc.exists ? meetDoc.data() : null;
          const startMs = Date.parse(meet?.startedAt || meet?.dateTime || "");
          const endMs = Date.parse(meet?.endedAt || "") || Date.now();
          if (Number.isFinite(startMs) && endMs > startMs) {
            durationSecs = Math.round((endMs - startMs) / 1000);
          }
        } catch (e) {
          /* A length we could not read is not a reason to refuse a transcript.
             Without it each file gets a single pass, which is what this did
             before — less, never nothing. */
          console.warn("[Transcript] could not read meeting length:", e.message);
        }
      }
      console.log(
        `[Transcript] ${meetId} ${mode}: ${uploadedGeminiFiles.length} speaker file(s), length ${clockOf(durationSecs)}`,
      );

      /**
       * **One call per speaker, run together, merged on the clock.**
       *
       * In parallel because they are independent and a 55-minute meeting is
       * several passes each — run one after another it is the difference
       * between minutes and a quarter of an hour. `callGemini` already backs
       * off and retries on a quota error, which is what makes three at once
       * safe.
       */
      const perSpeaker = await Promise.all(
        uploadedGeminiFiles.map((file, i) =>
          transcribeSpeaker(
            apiKey,
            file,
            participantNames[i] || `Speaker ${i + 1}`,
            mode,
            durationSecs,
          ).catch((e) => {
            /* One participant's file failing must not cost the other two their
               transcript — the same reason `gatherMeetingAudio` skips a file it
               cannot upload rather than throwing. */
            console.error(
              `[Transcript] ${participantNames[i]} failed: ${e.message}`,
            );
            return { utterances: [], unparsedLineCount: 0 };
          }),
        ),
      );

      const result = {
        utterances: perSpeaker
          .flatMap((r) => r.utterances)
          .sort((a, b) => a.start - b.start || a.end - b.end),
        unparsedLineCount: perSpeaker.reduce(
          (n, r) => n + r.unparsedLineCount,
          0,
        ),
        createdAtMs: Date.now(),
      };

      /* Merged, never overwritten: generating the translation must not delete
         the verbatim transcript somebody may be reading. */
      await ref.set(
        {
          meetId,
          participantNames,
          audioFileCount: uploadedGeminiFiles.length,
          pipeline: "gemini-file-api",
          [mode]: result,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      console.log(
        `[Transcript] ${meetId} ${mode}: ${result.utterances.length} line(s), ${result.unparsedLineCount} unparsed`,
      );

      /**
       * **And the summary, from the transcript we just made.**
       *
       * Non-fatal on purpose: a transcript that exists is worth answering with
       * even if the summary step failed, and the next run will try again. The
       * write MERGES, so a richer summary made from the audio is not thrown
       * away — only the fields this produced are set.
       */
      try {
        const made = await summariseFromTranscript(
          apiKey,
          result.utterances,
          participantNames,
          undefined,
        );
        if (made) {
          const summaryRef = db.collection("meeting_summaries").doc(meetId);
          const already = await summaryRef.get();
          const payload = {
            meetId,
            participants: participantNames,
            summary: made.summary,
            tasksAssigned: made.tasksAssigned,
            deadlines: made.deadlines,
            actionItems: made.actionItems,
            audioFilesCount: uploadedGeminiFiles.length,
            createdAtMs: Date.now(),
            source: "transcript",
          };
          /* Only where the audio pass left nothing: its dialogue is richer than
             anything derivable here, and overwriting it with an empty list
             would cost the summary page its Conversation section. */
          if (!already.exists || !(already.data().conversationFlow || []).length) {
            payload.dialogue = made.dialogue;
            payload.conversationFlow = made.conversationFlow;
          }
          await summaryRef.set(payload, { merge: true });
          console.log(
            `[Transcript] ${meetId}: summary written — ${made.tasksAssigned.length} task(s)`,
          );
        }
      } catch (e) {
        console.error("[Transcript] summary step failed:", e.message);
      }

      const saved = await ref.get();
      return res.json({
        success: true,
        transcript: saved.data(),
        cached: false,
      });
    } catch (e) {
      console.error("[Transcript POST] Error:", e.message);
      if (e.message?.includes("403") || e.message?.includes("suspended"))
        return res.status(403).json({
          error:
            "Gemini API key suspended or invalid. Create a new key at aistudio.google.com.",
        });
      return res.status(e.status || 500).json({ error: e.message });
    } finally {
      /* Same lesson as the summary route: an early `return` reaches neither the
         success path nor the catch, so the release lives here. */
      processingLocks.delete(lockKey);
      processingLockTimestamps.delete(lockKey);
      if (uploadedGeminiFiles.length > 0) {
        const apiKey = process.env.GEMINI_API_KEY;
        await Promise.all(
          uploadedGeminiFiles.map((f) =>
            deleteGeminiFile(f.geminiName, apiKey).catch(() => {}),
          ),
        );
      }
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /cowork/audio/transcript/:meetId/download?mode=verbatim|translate
//
// The same shape as the summary download above: read what was stored, render
// it, stream it. `mode` decides WHICH of the two documents, so the file matches
// the tab the reader has open rather than being one fixed export.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/audio/transcript/:meetId/download",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const { meetId } = req.params;
      const mode = req.query.mode === "translate" ? "translate" : "verbatim";

      const snap = await db.collection(TRANSCRIPT_COLLECTION).doc(meetId).get();
      const result = snap.exists ? snap.data()[mode] : null;
      if (!result) {
        return res.status(404).json({
          error: `No ${mode === "translate" ? "translated" : "verbatim"} transcript yet. Generate it first.`,
        });
      }

      const t = snap.data();
      const suffix = mode === "translate" ? "Translated" : "Verbatim";

      /* For the Summary box at the front of both documents. Non-fatal: a
         transcript is worth having without one, and the box says so. */
      let summaryForBox = null;
      try {
        const sdoc = await db.collection("meeting_summaries").doc(meetId).get();
        if (sdoc.exists) summaryForBox = sdoc.data();
      } catch (e) {
        console.warn("[Transcript] summary read failed:", e.message);
      }

      if (String(req.query.format || "").toLowerCase() === "pdf") {
        let pdf;
        try {
          pdf = await htmlToPdf(
            transcriptHtml(
              t,
              result,
              mode,
              meetId,
              summaryForBox,
              summaryForBox
                ? needsActionGroups(
                    summaryForBox.tasksAssigned,
                    summaryForBox.deadlines,
                    summaryForBox.actionItems,
                  )
                : [],
            ),
          );
        } catch (e) {
          if (e instanceof RendererUnavailableError || e?.rendererUnavailable) {
            return pdfUnavailable(res, e);
          }
          throw e;
        }
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="Meeting_Transcript_${suffix}_${meetId}.pdf"`,
        );
        res.setHeader("Content-Length", pdf.length);
        return res.send(pdf);
      }

      const buffer = await renderTranscriptDocx(
        t,
        result,
        mode,
        meetId,
        summaryForBox,
      );
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="Meeting_Transcript_${suffix}_${meetId}.docx"`,
      );
      res.setHeader("Content-Length", buffer.length);
      return res.send(buffer);
    } catch (e) {
      console.error("[TranscriptDocx] Error:", e.message);
      return res.status(500).json({ error: e.message });
    }
  },
);

/**
 * The transcript as a Word document.
 *
 * Deliberately plainer than the summary's: this is a record, so it keeps the
 * order, the timestamps and the speakers, and writes the two markers as TEXT.
 * On screen "unclear" is a highlight and "translated" is a tint; in a file
 * that leaves the building, a reader has neither, and a translated line that
 * does not say so reads as the speaker's own words.
 */
/**
 * **A Summary box, before the transcript itself.**
 *
 * Asked for 21 September 2026: the transcript document opened straight onto
 * four hundred rows of dialogue. Somebody handed that file has to read the
 * whole meeting to find out what it was about, and a transcript is a record
 * rather than a briefing.
 *
 * So the summary goes in front of it: what was discussed, and what anybody was
 * asked to do. `summary` is read by the route and passed in — null where none
 * has been generated yet, which the box says plainly rather than leaving a gap
 * somebody has to interpret.
 *
 * The tasks are read through the SAME `needsActionGroups` the summary document
 * and the panel use. Three places now print what somebody has to do, and all
 * three read it once.
 */
async function renderTranscriptDocx(transcript, result, mode, meetId, summary) {
  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    WidthType, ShadingType, VerticalAlign, AlignmentType, TableLayoutType,
  } = require("docx");

  const CONTENT_W = 9746;
  const W_TIME = 1100;
  const W_WHO = 2100;
  const W_TEXT = CONTENT_W - W_TIME - W_WHO;

  const mmss = (s) => {
    const n = Number(s);
    if (!Number.isFinite(n) || n < 0) return "";
    return `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
  };

  const cell = (children, width, shading) =>
    new TableCell({
      children,
      width: { size: width, type: WidthType.DXA },
      shading: shading ? { type: ShadingType.CLEAR, fill: shading } : undefined,
      verticalAlign: VerticalAlign.TOP,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
    });

  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  const unclear = utterances.filter((u) => u && u.needsReview).length;

  const head = [
    new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({ text: "CoWork Meeting Transcript", bold: true, size: 28, color: "0D47A1" }),
      ],
    }),
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({
          text:
            mode === "translate"
              ? "Translated to English — lines marked [translated] were spoken in another language"
              : "Verbatim — the exact words, in the language they were spoken, written in Roman letters",
          size: 18,
          color: "5F6368",
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 40 },
      children: [
        new TextRun({
          text: `Meeting ${meetId}  ·  ${utterances.length} line(s)${unclear ? `  ·  ${unclear} marked unclear` : ""}${
            result.unparsedLineCount ? `  ·  ${result.unparsedLineCount} line(s) could not be read` : ""
          }`,
          size: 17,
          color: "5F6368",
        }),
      ],
    }),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new TextRun({
          text: `Participants: ${(transcript.participantNames || []).join(", ") || "not recorded"}`,
          size: 17,
          color: "5F6368",
        }),
      ],
    }),
  ];

  /* ── Meeting Summary, then the tasks, then the transcript ─────────────
   *
   * The order asked for on 21 September 2026, and the reason for it: somebody
   * handed this file should be able to close it after the first page knowing
   * what happened, who owes what and by when. The transcript is underneath for
   * when they need the exact words.
   */
  head.push(
    new Paragraph({
      spacing: { before: 80, after: 100 },
      border: { bottom: { style: "single", size: 6, color: "0D47A1", space: 4 } },
      children: [
        new TextRun({ text: "Meeting Summary", bold: true, size: 26, color: "0D47A1" }),
      ],
    }),
  );

  const summaryText = String(summary?.summary || "").trim();
  if (summaryText) {
    /* One paragraph per line the model wrote. It was asked for 10–15 lines, and
       collapsing them into a wall loses the shape it wrote them in. */
    const paras = summaryText.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    paras.forEach((line, i) =>
      head.push(
        new Paragraph({
          spacing: { before: i === 0 ? 40 : 20, after: 20 },
          shading: { type: ShadingType.CLEAR, fill: "F8FAFF" },
          children: [new TextRun({ text: line, size: 19, color: "202124" })],
        }),
      ),
    );
    head.push(new Paragraph({ spacing: { after: 140 }, children: [] }));
  } else {
    head.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: "A summary is written whenever a transcript is generated. This transcript predates that, so generating it again will produce one.",
            italics: true,
            size: 19,
            color: "9AA0A6",
          }),
        ],
      }),
    );
  }

  /* ── Tasks and action items ───────────────────────────────────────────── */
  const naGroups = summary
    ? needsActionGroups(
        summary.tasksAssigned,
        summary.deadlines,
        summary.actionItems,
      )
    : [];
  const naRows = naGroups.flatMap((g) =>
    g.items.map((i) => ({ what: i.what, who: g.owner || "Everyone", due: i.due })),
  );

  head.push(
    new Paragraph({
      spacing: { before: 120, after: 100 },
      border: { bottom: { style: "single", size: 6, color: "F29900", space: 4 } },
      children: [
        new TextRun({ text: "Tasks & Action Items", bold: true, size: 26, color: "F29900" }),
      ],
    }),
  );

  if (naRows.length === 0) {
    head.push(
      new Paragraph({
        spacing: { after: 200 },
        children: [
          new TextRun({
            text: "Nothing was assigned in this meeting.",
            italics: true,
            size: 19,
            color: "9AA0A6",
          }),
        ],
      }),
    );
  } else {
    /* A table, because three facts about one task belong on one line and a
       reader scans DOWN the column they care about — usually their own name. */
    const W_TASK = 5200;
    const W_WHO = 2500;
    const W_DUE = CONTENT_W - W_TASK - W_WHO;
    head.push(
      new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        columnWidths: [W_TASK, W_WHO, W_DUE],
        /* Same reason as the transcript table below — see its note. */
        layout: TableLayoutType.FIXED,
        rows: [
          new TableRow({
            tableHeader: true,
            children: [
              cell([new Paragraph({ children: [new TextRun({ text: "Task", bold: true, size: 18, color: "FFFFFF" })] })], W_TASK, "F29900"),
              cell([new Paragraph({ children: [new TextRun({ text: "Assigned To", bold: true, size: 18, color: "FFFFFF" })] })], W_WHO, "F29900"),
              cell([new Paragraph({ children: [new TextRun({ text: "Deadline", bold: true, size: 18, color: "FFFFFF" })] })], W_DUE, "F29900"),
            ],
          }),
          ...naRows.map((r, i) => {
            const zebra = i % 2 === 1 ? "FFF8EC" : undefined;
            return new TableRow({
              children: [
                cell([new Paragraph({ children: [new TextRun({ text: r.what, size: 19, color: "202124" })] })], W_TASK, zebra),
                cell([new Paragraph({ children: [new TextRun({ text: r.who, bold: true, size: 19, color: "0D47A1" })] })], W_WHO, zebra),
                cell(
                  [
                    new Paragraph({
                      children: [
                        new TextRun({
                          /* The words the meeting used, never a date nobody
                             said. An em dash where none was given, so the
                             column is never ambiguous about which it is. */
                          text: r.due || "—",
                          bold: Boolean(r.due),
                          size: 19,
                          color: r.due ? "F29900" : "9AA0A6",
                        }),
                      ],
                    }),
                  ],
                  W_DUE,
                  zebra,
                ),
              ],
            });
          }),
        ],
      }),
    );
    head.push(new Paragraph({ spacing: { after: 240 }, children: [] }));
  }

  /* ── The transcript itself ────────────────────────────────────────────── */
  head.push(
    new Paragraph({
      spacing: { before: 80, after: 100 },
      border: { bottom: { style: "single", size: 6, color: "0D47A1", space: 4 } },
      children: [
        new TextRun({ text: "Transcript", bold: true, size: 26, color: "0D47A1" }),
      ],
    }),
  );

  const rows = [
    new TableRow({
      tableHeader: true,
      children: [
        cell([new Paragraph({ children: [new TextRun({ text: "Time", bold: true, size: 18, color: "FFFFFF" })] })], W_TIME, "1A73E8"),
        cell([new Paragraph({ children: [new TextRun({ text: "Speaker", bold: true, size: 18, color: "FFFFFF" })] })], W_WHO, "1A73E8"),
        cell([new Paragraph({ children: [new TextRun({ text: "What was said", bold: true, size: 18, color: "FFFFFF" })] })], W_TEXT, "1A73E8"),
      ],
    }),
    ...utterances.map((u, i) => {
      const zebra = i % 2 === 1 ? "F8F9FA" : undefined;
      const runs = [new TextRun({ text: String(u?.text ?? ""), size: 19, color: "202124" })];
      if (u?.needsReview)
        runs.push(new TextRun({ text: "  [unclear]", bold: true, size: 16, color: "F29900" }));
      if (mode === "translate" && u?.translated)
        runs.push(new TextRun({ text: "  [translated]", italics: true, size: 16, color: "5F6368" }));
      return new TableRow({
        children: [
          cell([new Paragraph({ children: [new TextRun({ text: mmss(u?.start), size: 17, color: "5F6368" })] })], W_TIME, zebra),
          cell([new Paragraph({ children: [new TextRun({ text: String(u?.speaker ?? "Unknown"), bold: true, size: 18, color: "0D47A1" })] })], W_WHO, zebra),
          cell([new Paragraph({ children: runs })], W_TEXT, zebra),
        ],
      });
    }),
  ];

  const body = utterances.length
    ? new Table({
        width: { size: CONTENT_W, type: WidthType.DXA },
        /**
         * **The grid, and a fixed layout.**
         *
         * Reported 21 September 2026 with this document open in Google Docs:
         * the three columns had collapsed to one character wide, so the
         * header read T-i-m-e down the page and every line of speech was a
         * vertical ribbon.
         *
         * The table declared its own width and never declared its COLUMNS.
         * Word infers a grid from the cell widths and looks right; Google
         * Docs does not, and auto-fits to something unreadable. The other
         * tables in this codebase all carry `columnWidths` — this one was
         * the exception, which is why only this document was wrong.
         *
         * `TableLayoutType.FIXED` is the second half: it tells a reader to use the grid as
         * given rather than re-fitting it to the content, which is what
         * keeps a 400-row transcript from re-flowing per page.
         */
        columnWidths: [W_TIME, W_WHO, W_TEXT],
        layout: TableLayoutType.FIXED,
        rows,
      })
    : new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [
          new TextRun({ text: "No lines were captured for this meeting in this mode.", italics: true, size: 19, color: "5F6368" }),
        ],
      });

  const doc = new Document({
    sections: [
      {
        properties: { page: { margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } },
        children: [...head, body],
      },
    ],
  });

  return Packer.toBuffer(doc);
}

/**
 * The Drive → Gemini File API pipeline, shared with meetingTranscript.routes.
 *
 * **Restoring this, and why it must not be tidied away again.** It was added
 * with the verbatim-transcript route (0722697) so that route could reuse this
 * one's upload plumbing instead of carrying a fourth copy of it, and a later
 * cleanup of this file removed it. Nothing here referenced it, so it read as
 * dead code — but `meetingTranscript.routes.js` destructures these six names at
 * require time, so its absence was not a degraded feature: `require` returned a
 * router with no `.helpers`, the destructure threw `TypeError: Cannot
 * destructure property 'MODELS_TO_TRY' of 'summaryHelpers' as it is undefined`,
 * and server.js could not finish loading. **The whole backend refused to
 * start.**
 *
 * A plain property on the exported router, not a change to the export shape —
 * `require("./meetingSummary.routes")` still returns a working Express router
 * exactly as before; this only adds `.helpers` to it.
 */
router.helpers = {
  GEMINI_BASE,
  GEMINI_UPLOAD_BASE,
  MODELS_TO_TRY,
  getDriveClient,
  streamDriveToGeminiFileAPI,
  waitForFileActive,
  deleteGeminiFile,
  callGemini,
  /* Pure, and exported so they can be checked without a network or a key. */
  assertPlayableContainer,
  normaliseAudioMime,
  failureRank,
  summariseFailures,
};

module.exports = router;

