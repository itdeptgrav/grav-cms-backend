"use strict";

/**
 * services/callSummary.service.js
 *
 * Turns a recorded sales call into a transcript AND a short, sales-readable
 * summary with Gemini.
 *
 * ── What was broken, and why (5 Sep 2026) ─────────────────────────────────
 *
 * This service used to summarise a transcript and nothing else. Its own header
 * said so plainly: "There is NO transcription here. If a recording has no
 * transcript, this reports that and stops."
 *
 * Measured against the live database on 5 Sep 2026, that made the feature
 * unreachable rather than merely limited:
 *
 *     call events total ............ 13
 *     with audio in Drive .......... 7
 *     with a transcript ............ 0     ← every single one
 *     with an AI summary ........... 0     ← nobody ever got one
 *
 * The Android recorder ships `transcription: null` on every row, so the ONLY
 * branch this service could ever take was the "no transcript yet" refusal. The
 * button was wired, the key was configured, the model worked — and the answer
 * was always "there is nothing to summarise", on recordings that contain a
 * perfectly good conversation. That is what the user reported: "this Ai summary
 * is not working even though an genuine information audio recording is there".
 *
 * ── The fix: transcribe the audio, the way Cowork already does ────────────
 *
 * Explicit instruction: "u need to refer to the Cowork platform meeting summary
 * in order to know how the summary is goona extract form gemini ok in industry
 * standard ok."
 *
 * So this now reuses that pipeline rather than inventing a second one —
 * `routes/task_routes/meetingSummary.routes.js` exports its Drive→Gemini
 * "conveyor belt" as `.helpers`, and `meetingTranscript.routes.js` already
 * consumes it the same way:
 *
 *     Drive (stream) → Gemini File API (resumable upload) → poll until ACTIVE
 *       → generateContent(fileData + prompt) → delete the temp Gemini file
 *
 * Sending a `fileData` URI rather than base64 inline is the part that matters:
 * inline audio caps out around 19 MB and times out well before that, while the
 * File API reads from Gemini's own storage with no practical size limit.
 *
 * Reusing `MODELS_TO_TRY` also buys the env-driven model ladder
 * (`GEMINI_MODELS`), which exists because Google retired three hardcoded model
 * names between April and August 2026. This file previously pinned
 * `gemini-flash-lite-latest` on its own; that name still resolves today, but
 * pinning it here meant the next retirement would break call summaries
 * separately from — and later than — everything else.
 *
 * ── Two paths, cheapest first ─────────────────────────────────────────────
 *
 *   1. A transcript already exists  → summarise the TEXT. No upload, no Drive
 *      read, cents instead of a file transfer.
 *   2. No transcript but audio in Drive → transcribe AND summarise in ONE
 *      Gemini call, then persist both. The transcript is the expensive part;
 *      asking for the summary in the same response makes it free, and means a
 *      second click never re-uploads the audio.
 *   3. Neither → say so. Unchanged, and now genuinely rare.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

/** Roughly 30–40 minutes of speech. Longer transcripts are head-trimmed. */
const MAX_TRANSCRIPT_CHARS = 24000;

/**
 * Audio this long is refused rather than uploaded. A 2-hour recording is
 * almost always a stuck recorder rather than a sales call, and finding that
 * out after a 300 MB transfer helps nobody.
 */
const MAX_AUDIO_SECONDS = 2 * 60 * 60;

/** Below this there is no conversation to hear — a misdial or a dropped call. */
const MIN_AUDIO_SECONDS = 3;

function isConfigured() {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
}

/**
 * The Cowork pipeline, required LAZILY.
 *
 * Deliberate: `meetingSummary.routes.js` pulls in firebaseAdmin and coworkAuth
 * at module load. Requiring it at the top of this file would make the Sales
 * call log fail to load whenever Firebase is misconfigured — two unrelated
 * subsystems, one shared failure. Inside the function, a Cowork problem can
 * only ever affect the request that actually needs the audio pipeline.
 */
function audioPipeline() {
  const helpers = require("../routes/task_routes/meetingSummary.routes").helpers;
  if (!helpers || !helpers.streamDriveToGeminiFileAPI) {
    throw new Error("The Drive→Gemini audio pipeline is unavailable.");
  }
  return helpers;
}

const SUMMARY_STYLE = `Write for someone who will open the customer's record tomorrow and needs to know where things stand — not for someone who wants the call replayed in prose.

Format the summary exactly like this:
- One opening line: what the call was about.
- "Discussed:" then 2 to 5 short bullets of substance — quantities, styles, fabrics, prices, sizes, delivery dates, complaints.
- "Next step:" one line. If no next step was agreed, write "None agreed on this call."

Hard rules:
- Use ONLY what was actually said. Never infer an order, a price, or a commitment that was not stated.
- Keep every number, date and name exactly as spoken. Do not round or tidy figures.
- If the call is too short, garbled, or clearly not a business call, say so in one line and write nothing else.
- Plain text. No markdown headings inside the summary, no preamble, no sign-off. Under 150 words.`;

const SYSTEM_TEXT = `You summarise recorded sales phone calls for a garment manufacturer's sales team in India.

${SUMMARY_STYLE}`;

/**
 * The audio prompt. Asks for BOTH sections in one pass, using the same
 * `## HEADER` convention the Cowork meeting summary uses — a format that has
 * survived real meetings here, rather than a new one invented for this file.
 *
 * The transcription rules are Cowork's too, for the same reasons: Indian sales
 * calls are routinely Hinglish/Odia, so the transcript is translated to English
 * while proper nouns are left alone, and unclear speech is marked rather than
 * silently dropped.
 */
function buildAudioPrompt(context) {
  return `This is a recording of ONE phone call between a garment manufacturer's salesperson and a customer.
${context ? `\nWhat we already know about this call:\n${context}\n` : ""}
Listen to the whole recording, then respond in this EXACT format (do not change the section headers):

## TRANSCRIPT
[The full conversation, in the order it happened, one line per speaker turn:
Salesperson: "..."
Customer: "..."

Transcription rules:
1. Do not skip any speaker turn — include greetings, filler and short utterances ("hmm", "okay", "haan", "theek hai").
2. One speaker turn = one line. Do not merge or summarise turns here.
3. Translate Hindi / Odia / Hinglish / any other language into English, but keep proper nouns (names, places, fabric names, product names) unchanged.
4. If words are unclear, transcribe best-effort and append "[unclear]" rather than dropping the line.
5. Label the two sides "Salesperson" and "Customer". If you genuinely cannot tell which is which, use "Speaker 1" and "Speaker 2" consistently.
6. If the recording contains no intelligible speech at all, write exactly: (no intelligible speech in this recording)]

## SUMMARY
[${SUMMARY_STYLE}]`;
}

/** Pull one `## HEADER` section out of a Gemini response. */
function section(text, header) {
  const re = new RegExp(`##\\s*${header}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

/** The context block both paths share — what we know without listening. */
function contextFor(recording) {
  const seconds = recording?.durationSec ?? (recording?.durationMillis ? recording.durationMillis / 1000 : null);
  const minutes = seconds ? Math.round(seconds / 60) : null;
  return [
    recording?.contactName ? `Contact as saved on the phone: ${recording.contactName}` : null,
    recording?.phoneNumber ? `Number: ${recording.phoneNumber}` : null,
    recording?.direction && recording.direction !== "UNKNOWN" ? `Direction: ${recording.direction.toLowerCase()}` : null,
    minutes ? `Duration: about ${minutes} minute${minutes === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/** Map a thrown provider error onto the reason codes the route already maps to HTTP. */
function providerFailure(e) {
  const msg = e?.message || "";
  if (/429|quota|rate.?limit/i.test(msg)) {
    return { ok: false, reason: "quota", message: "The AI summariser has hit its rate limit. Try again in a moment." };
  }
  return { ok: false, reason: "failed", message: `Could not reach the AI summariser. ${msg}`.trim() };
}

/**
 * Summarise from an existing transcript. The cheap path — no Drive read, no
 * upload, no File API.
 */
async function summariseFromTranscript(recording) {
  const transcript = (recording?.transcription || "").trim();
  const context = contextFor(recording);

  /* Trim the HEAD, not the tail: on a long call the outcome and the next step
     land at the end, and those are the two things the summary must carry. */
  const clipped =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? "[earlier part of the call omitted]\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS)
      : transcript;

  const { MODELS_TO_TRY } = audioPipeline();
  const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  let lastError = null;
  for (const modelName of MODELS_TO_TRY) {
    try {
      const model = client.getGenerativeModel({
        model: modelName,
        systemInstruction: SYSTEM_TEXT,
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
      });
      const result = await model.generateContent(
        `${context ? `Call details:\n${context}\n\n` : ""}Transcript:\n${clipped}`,
      );
      const text = (result.response.text() || "").trim();
      if (text) return { ok: true, summary: text, model: modelName, source: "transcript" };
      lastError = new Error("empty response");
    } catch (e) {
      lastError = e;
    }
  }
  return providerFailure(lastError || new Error("no model produced a summary"));
}

/**
 * Transcribe the Drive audio and summarise it in one Gemini call.
 *
 * Always cleans up the temporary Gemini file, including on failure — Gemini
 * expires them after 48h anyway, but leaving them behind makes the quota
 * harder to reason about for no benefit.
 */
async function summariseFromAudio(recording) {
  const {
    getDriveClient,
    streamDriveToGeminiFileAPI,
    waitForFileActive,
    deleteGeminiFile,
    callGemini,
  } = audioPipeline();

  const apiKey = process.env.GEMINI_API_KEY;
  const seconds = recording?.durationSec ?? (recording?.durationMillis ? recording.durationMillis / 1000 : 0);

  if (seconds && seconds > MAX_AUDIO_SECONDS) {
    return {
      ok: false,
      reason: "too_long",
      message: `This recording is ${Math.round(seconds / 60)} minutes long — too long to transcribe automatically.`,
    };
  }
  if (seconds && seconds < MIN_AUDIO_SECONDS) {
    return {
      ok: false,
      reason: "too_short",
      message: `This recording is only ${Math.round(seconds)} seconds long — there is no conversation to summarise.`,
    };
  }

  let uploaded = null;
  try {
    const drive = getDriveClient();
    uploaded = await streamDriveToGeminiFileAPI(
      drive,
      recording.driveFileId,
      recording.driveMimeType,
      recording.audioFileName || `call-${recording._id}`,
      apiKey,
    );
    await waitForFileActive(uploaded.geminiName, apiKey);

    /* `callGemini` returns the response TEXT as a plain string and throws once
       every model in the ladder has failed. It does not report which model
       answered, so `model` is genuinely unknown on this path — recorded as
       null rather than guessed at from the head of the ladder. */
    const text = String(
      await callGemini(
        apiKey,
        [{ fileUri: uploaded.fileUri, mimeType: uploaded.mimeType }],
        buildAudioPrompt(contextFor(recording)),
      ) || "",
    ).trim();
    if (!text) return { ok: false, reason: "empty", message: "The model returned an empty response." };

    const transcript = section(text, "TRANSCRIPT");
    const summary = section(text, "SUMMARY");

    /* No `## SUMMARY` header means the model answered in prose instead of the
       requested format. That is still a usable summary — the transcript is
       what would be wrong to guess at, so only that is left unset. */
    const noSpeech = /^\(no intelligible speech/i.test(transcript);
    return {
      ok: true,
      summary: summary || text,
      transcript: transcript && !noSpeech ? transcript : null,
      model: null,
      source: "audio",
    };
  } catch (e) {
    return providerFailure(e);
  } finally {
    if (uploaded?.geminiName) {
      try {
        await deleteGeminiFile(uploaded.geminiName, apiKey);
      } catch {
        /* non-fatal — Gemini expires its own files after 48h */
      }
    }
  }
}

/**
 * @param {object} recording  a CallEvent document (or lean object)
 * @returns {Promise<
 *   { ok:true, summary:string, transcript?:string|null, model:string|null, source:"transcript"|"audio" }
 *   | { ok:false, reason:string, message:string }
 * >}
 *   Never throws for an ordinary provider failure — the caller decides what the
 *   user sees.
 */
async function summariseCall(recording) {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", message: "AI summaries are not configured on this server." };
  }

  const transcript = (recording?.transcription || "").trim();
  if (transcript.length >= 40) return summariseFromTranscript(recording);

  if (recording?.driveFileId) return summariseFromAudio(recording);

  return {
    ok: false,
    reason: "no_audio",
    message: "This call has no recording and no transcript, so there is nothing to summarise.",
  };
}

module.exports = { summariseCall, isConfigured, MAX_AUDIO_SECONDS };
