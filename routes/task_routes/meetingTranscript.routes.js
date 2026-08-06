/**
 * grav-backend/routes/task_routes/meetingTranscript.routes.js
 *
 * The transcript — a separate capability from meetingSummary.routes.js's
 * summary, not a replacement for it.
 *
 * Why this needs to exist alongside the summary: meetingSummary.routes.js's own
 * prompt for its CONVERSATION section explicitly says "Translate any Hindi /
 * Odia / Hinglish / other language into English" and "paraphrase if exact
 * words unclear" — that section is translate-and-best-guess by design, which is
 * the right choice for a quick-scan summary and the wrong one for a record
 * someone needs to trust word-for-word.
 *
 * Two modes, deliberately NOT one toggle on a shared prompt:
 *   - verbatim   — exact words, original language preserved (Hindi/Odia/etc.
 *                  stay in their own language), explicit uncertainty instead
 *                  of a confident guess. For someone who needs to trust the
 *                  record word-for-word, or who reads the original language.
 *   - translate  — renders everything into English, but MARKS what was
 *                  translated with [translated] rather than silently
 *                  blending it in — for a reader who doesn't read Odia/Hindi
 *                  script but still needs to know a translation happened,
 *                  not read a summary's silent paraphrase.
 * Both are stored side by side on the same document — generating one never
 * overwrites the other, since they answer different questions and a reader
 * may want to compare them.
 *
 * Reuses the existing conveyor-belt pipeline (Drive → Gemini File API →
 * generateContent) via meetingSummary.routes.js's additive `.helpers` export,
 * rather than a third copy of that plumbing.
 *
 * Storage: meeting_verbatim_transcripts/{meetId} — a new collection, NOT
 * meeting_transcripts, which already means something else (the live,
 * ephemeral Web-Speech-API captions with a 24h TTL — see transcript.routes.js).
 */

const express = require("express");
const router = express.Router();
const { db, admin } = require("../../config/firebaseAdmin");
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const summaryHelpers = require("./meetingSummary.routes").helpers;

const {
  MODELS_TO_TRY,
  getDriveClient,
  streamDriveToGeminiFileAPI,
  waitForFileActive,
  deleteGeminiFile,
  callGemini,
} = summaryHelpers;

const processingLocks = new Set();
const VALID_MODES = ["verbatim", "translate"];

/**
 * Each file is one person's own mic (LiveKit meetings only, at least for
 * this first version — see the header of the in-person, multi-device
 * version of this same rule in the python-audio-worker spike), so there is
 * no cross-device reconciliation to do here — only fidelity.
 */
function buildPrompt(mode, participantNames) {
  const names = participantNames.join(", ");
  const header = `These are individual voice recording files from a single meeting. Each audio file contains ONLY ONE person's voice. The participants are: ${names}.\n\n`;

  if (mode === "verbatim") {
    return `${header}Produce a VERBATIM transcript of the full conversation, merged into one chronological timeline across all files. Rules:
1. Transcribe exactly what is said, word for word, INCLUDING any Hindi, Odia, Hinglish, or other non-English words or phrases exactly as spoken — do NOT translate them. If someone code-switches mid-sentence, preserve that exactly.
2. Do not paraphrase, summarize, clean up grammar, or "improve" disfluencies. If someone repeats themselves or corrects themselves mid-sentence, transcribe that too.
3. Do not skip short utterances ("hmm", "okay", "haan", "acha") — every turn appears.
4. If you are not confident what was said or who said it, say so explicitly (e.g. "[unclear]" or "[uncertain: could be X or Y]") rather than guessing at a plausible-sounding answer.
5. Format each line as exactly: [MM:SS-MM:SS] Speaker: text
6. Use only the participant names given above as speakers.

Do not include a summary, task list, or any other section — verbatim transcript lines only.`;
  }

  return `${header}Produce an ENGLISH transcript of the full conversation, merged into one chronological timeline across all files. Rules:
1. Transcribe speech that is already in English exactly as said. For speech in Hindi, Odia, Hinglish, or any other language, translate it into natural English rather than transcribing the original words.
2. Mark every translated phrase with [translated] immediately before it, so the reader always knows a translation happened rather than reading it as if it were originally said in English.
3. Preserve meaning as faithfully as possible — do not add, invent, or omit content, and do not summarize.
4. Do not skip short utterances ("hmm", "okay") — every turn appears.
5. If you are not confident what was said or who said it, say so explicitly (e.g. "[unclear]") rather than guessing at a plausible-sounding answer.
6. Format each line as exactly: [MM:SS-MM:SS] Speaker: text
7. Use only the participant names given above as speakers.

Do not include a summary, task list, or any other section — transcript lines only.`;
}

/** Same [MM:SS-MM:SS] Speaker: text line format the python spike tool's
 * parser expects — kept identical on purpose so the two are interchangeable
 * if the in-person pipeline and this one are ever unified. */
function parseResponse(text) {
  const lineRe = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\s*[-–]\s*(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*([^:]{1,40}):\s*(.+)$/;
  const toSeconds = (ts) => {
    const parts = ts.split(":").map(Number);
    return parts.length === 2
      ? parts[0] * 60 + parts[1]
      : parts[0] * 3600 + parts[1] * 60 + parts[2];
  };
  const uncertaintyMarkers = ["unclear", "uncertain", "inaudible", "not sure", "can't make out"];

  const utterances = [];
  const unparsed = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(lineRe);
    if (!m) {
      unparsed.push(line);
      continue;
    }
    const utteranceText = m[4].trim();
    const lower = utteranceText.toLowerCase();
    utterances.push({
      start: toSeconds(m[1]),
      end: toSeconds(m[2]),
      speaker: m[3].trim(),
      text: utteranceText,
      needsReview: uncertaintyMarkers.some((mk) => lower.includes(mk)),
      translated: utteranceText.includes("[translated]"),
    });
  }
  return { utterances, unparsed };
}

// ── POST /cowork/audio/transcript/:meetId?mode=verbatim|translate ─────────────
router.post(
  "/audio/transcript/:meetId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    const { meetId } = req.params;
    const mode = VALID_MODES.includes(req.query.mode) ? req.query.mode : "verbatim";
    const forceRegenerate = req.query.force === "true";
    const lockKey = `${meetId}:${mode}`;

    if (processingLocks.has(lockKey)) {
      return res.status(409).json({ error: `${mode} transcript generation already in progress for this meeting.` });
    }

    try {
      const docRef = db.collection("meeting_verbatim_transcripts").doc(meetId);
      const existing = await docRef.get();
      const existingData = existing.exists ? existing.data() : null;
      if (existingData?.[mode] && !forceRegenerate) {
        return res.json({ success: true, transcript: existingData, cached: true });
      }

      const snap = await db
        .collection("meeting_audio_recordings")
        .where("meetId", "==", meetId)
        .get();
      if (snap.empty) {
        return res.status(404).json({
          error: "No audio recordings found for this meeting. Record a meeting first.",
        });
      }
      const recordings = snap.docs.map((d) => d.data());

      processingLocks.add(lockKey);
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) throw new Error("GEMINI_API_KEY not set");

      const drive = getDriveClient();
      const geminiFiles = [];
      const participantNames = [];
      try {
        for (const rec of recordings) {
          if (!rec.driveFileId) continue;
          const displayName = rec.employeeName || rec.employeeId || "participant";
          console.log(`[Transcript] Uploading ${displayName} for ${meetId} (${mode})...`);
          const uploaded = await streamDriveToGeminiFileAPI(
            drive, rec.driveFileId, rec.mimeType, displayName, apiKey,
          );
          await waitForFileActive(uploaded.geminiName, apiKey);
          geminiFiles.push(uploaded);
          participantNames.push(displayName);
        }

        if (geminiFiles.length === 0) {
          return res.status(404).json({ error: "No usable audio files for this meeting." });
        }

        const prompt = buildPrompt(mode, participantNames);
        const rawText = await callGemini(apiKey, geminiFiles, prompt);
        const { utterances, unparsed } = parseResponse(rawText);

        const modeResult = {
          utterances,
          unparsedLineCount: unparsed.length,
          rawText,
          createdAtMs: Date.now(),
        };

        // Merge into the existing doc rather than overwrite it — generating
        // "translate" must not erase an already-generated "verbatim" (or
        // vice versa). They are independently useful and a reader may want
        // to compare them.
        const record = {
          ...(existingData || {}),
          meetId,
          participantNames,
          audioFileCount: geminiFiles.length,
          pipeline: "verbatim-transcript-v2",
          [mode]: modeResult,
        };
        await docRef.set(record);

        res.json({ success: true, transcript: record, cached: false });
      } finally {
        for (const f of geminiFiles) {
          deleteGeminiFile(f.geminiName, apiKey).catch(() => {});
        }
      }
    } catch (e) {
      console.error(`[Transcript] Error for ${meetId} (${mode}):`, e.message);
      res.status(500).json({ error: e.message });
    } finally {
      processingLocks.delete(lockKey);
    }
  },
);

// ── GET /cowork/audio/transcript/:meetId — fetch (both modes, whichever exist) ─
router.get(
  "/audio/transcript/:meetId",
  verifyCoworkToken,
  verifyEmployeeToken,
  async (req, res) => {
    try {
      const doc = await db.collection("meeting_verbatim_transcripts").doc(req.params.meetId).get();
      if (!doc.exists) return res.status(404).json({ error: "No transcript generated yet." });
      res.json({ transcript: doc.data() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  },
);

module.exports = router;
