"use strict";

/**
 * services/callSummary.service.js
 *
 * Turns a call transcript into a short sales-readable summary with Gemini.
 *
 * ── Why this exists at all ────────────────────────────────────────────────
 *
 * `CallRecording.summary` is whatever the Android recorder shipped, and it is
 * null far more often than not. The Sales team's ask is to read a call without
 * listening to it, so when a transcript exists and a device summary does not,
 * this fills the gap — writing to `aiSummary`, never over `summary`.
 *
 * ── Model choice ─────────────────────────────────────────────────────────
 *
 * `gemini-flash-lite-latest`, matching `services/aiAssist.service.js`. The
 * dated ids (`gemini-2.5-flash-lite`) are listed by `models.list` for this
 * project's key but 404 on `generateContent`; the `-latest` alias is what a
 * key with no special access can actually reach. Same trap, same fix — see the
 * long comment in aiAssist.service.js.
 *
 * There is NO transcription here. If a recording has no transcript, this
 * reports that and stops; it does not silently download 40 MB of audio from
 * Drive and bill a speech model for it. Adding transcription is a deliberate
 * follow-up, not something a summarise button should trigger by surprise.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

const MODEL = "gemini-flash-lite-latest";

/** Roughly 30–40 minutes of speech. Longer transcripts are tail-trimmed. */
const MAX_TRANSCRIPT_CHARS = 24000;

function isConfigured() {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
}

const SYSTEM = `You summarise recorded sales phone calls for a garment manufacturer's sales team in India.

Write for someone who will open the customer's record tomorrow and needs to know where things stand — not for someone who wants the call replayed in prose.

Format, exactly:
- One opening line: what the call was about.
- "Discussed:" then 2 to 5 short bullets of substance — quantities, styles, fabrics, prices, sizes, delivery dates, complaints.
- "Next step:" one line. If no next step was agreed, write "None agreed on this call."

Hard rules:
- Use ONLY what is in the transcript. Never infer an order, a price, or a commitment that was not said.
- Keep every number, date and name exactly as spoken. Do not round or tidy figures.
- If the transcript is too short, garbled, or clearly not a business call, say so in one line and write nothing else.
- Plain text. No markdown headings, no preamble, no sign-off. Under 150 words.`;

/**
 * @param {object} recording  a CallRecording document (or lean object)
 * @returns {Promise<{ok:true, summary:string, model:string} | {ok:false, reason:string, message:string}>}
 *          Never throws for an ordinary provider failure — the caller decides
 *          what the user sees.
 */
async function summariseCall(recording) {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", message: "AI summaries are not configured on this server." };
  }

  const transcript = (recording?.transcription || "").trim();
  if (transcript.length < 40) {
    return {
      ok: false,
      reason: "no_transcript",
      message: "This recording has no transcript yet, so there is nothing to summarise.",
    };
  }

  const minutes = recording.durationMillis ? Math.round(recording.durationMillis / 60000) : null;
  const context = [
    recording.contactName ? `Contact as saved on the phone: ${recording.contactName}` : null,
    recording.phoneNumber ? `Number: ${recording.phoneNumber}` : null,
    recording.direction && recording.direction !== "UNKNOWN" ? `Direction: ${recording.direction.toLowerCase()}` : null,
    minutes ? `Duration: about ${minutes} minute${minutes === 1 ? "" : "s"}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  /* Trim the HEAD, not the tail: on a long call the outcome and the next step
     land at the end, and those are the two things the summary must carry. */
  const clipped =
    transcript.length > MAX_TRANSCRIPT_CHARS
      ? "[earlier part of the call omitted]\n" + transcript.slice(-MAX_TRANSCRIPT_CHARS)
      : transcript;

  try {
    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = client.getGenerativeModel({
      model: MODEL,
      systemInstruction: SYSTEM,
      generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
    });

    const result = await withOneRetry(() =>
      model.generateContent(`${context ? `Call details:\n${context}\n\n` : ""}Transcript:\n${clipped}`),
    );
    const text = (result.response.text() || "").trim();
    if (!text) return { ok: false, reason: "empty", message: "The model returned an empty summary." };
    return { ok: true, summary: text, model: MODEL };
  } catch (e) {
    // A quota wall and a connection failure call for different user reactions,
    // so they are not collapsed into one message.
    const quota = /429|quota|rate.?limit/i.test(e.message || "");
    return {
      ok: false,
      reason: quota ? "quota" : "failed",
      message: quota
        ? "The AI summariser has hit its rate limit. Try again in a moment."
        : "Could not reach the AI summariser.",
    };
  }
}

/** One retry on a transient failure, same model — not a fallback ladder. */
async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 600));
    return fn();
  }
}

module.exports = { summariseCall, isConfigured, MODEL };
