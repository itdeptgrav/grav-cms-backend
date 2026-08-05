/**
 * services/textAssist.service.js
 *
 * A small, single-purpose sibling to `aiAssist.service.js`: given a plain
 * string (a task title, description, acceptance-criterion draft, or an email
 * subject/body) and a mode, ask Gemini to fix it, rephrase it, or write it
 * from scratch, and hand back plain text — no tool-calling, no document/sheet
 * awareness. Kept separate from `aiAssist.service.js` because that module's
 * whole shape (function-declared tools, Docs/Sheets system instructions)
 * doesn't apply here; this is just "text in, text out."
 *
 * `surface` is what makes the instructions honest about WHAT the text is —
 * without it, the model has no way to know an email body needs a greeting
 * and a sign-off while a task title must stay one line, and it was treating
 * every field the same regardless of which one it actually was.
 */

const { GoogleGenerativeAI } = require("@google/generative-ai");

// Same model as aiAssist.service.js — see that file's comment for why the
// `-latest` alias is used instead of a dated model name.
const MODEL = "gemini-flash-lite-latest";

function isConfigured() {
  return typeof process.env.GEMINI_API_KEY === "string" && process.env.GEMINI_API_KEY.length > 0;
}

/**
 * What each field actually is, and the shape it has to keep. This is what
 * lets "rephrase" or "write from scratch" produce a real, structured email
 * for a mail body while keeping a task title to one line — the same request
 * against the wrong shape is exactly what made the assistant feel generic.
 */
const SURFACES = {
  "mail-subject": {
    noun: "an email subject line",
    rules:
      "A subject line is a single short line: no greeting, no sign-off, no line breaks, no more than one " +
      "sentence.",
  },
  "mail-body": {
    noun: "the body of an email",
    rules:
      "A real email has structure: an appropriate greeting if the tone calls for one, the message written in " +
      "clear paragraphs with a blank line between them, and a sign-off appropriate to the tone. Never return a " +
      "single unstructured line or one run-on paragraph for an email — if that is what the input looks like, " +
      "restructure it into a properly formatted email rather than just cleaning up its wording.",
  },
  "task-title": {
    noun: "a task title",
    rules:
      "A title is a single short, action-oriented line — never a greeting, a sign-off, or more than one " +
      "sentence.",
  },
  "task-description": {
    noun: "a task description",
    rules: "A few sentences of plain prose describing the work. No greeting or sign-off.",
  },
  "task-criterion": {
    noun: "one acceptance criterion",
    rules: "A single short, checkable sentence — one condition, not a list.",
  },
  generic: {
    noun: "a short piece of text from a workplace app",
    rules: "",
  },
};

function surfaceOf(surface) {
  return SURFACES[surface] || SURFACES.generic;
}

const REPLY_RULE =
  "Reply with ONLY the text and nothing else: no preamble, no quotes, no explanation, no markdown formatting.";

function editingInstruction(surface) {
  const s = surfaceOf(surface);
  return `You are editing ${s.noun}. ${s.rules} ${REPLY_RULE}`.replace(/\s+/g, " ").trim();
}

function writingInstruction(surface) {
  const s = surfaceOf(surface);
  return `You are writing ${s.noun} from scratch, following the request you are given below. ${s.rules} ${REPLY_RULE}`
    .replace(/\s+/g, " ")
    .trim();
}

function instructionsFor(surface) {
  const base = editingInstruction(surface);
  return {
    grammar:
      `${base} Fix only spelling, grammar, and punctuation errors. Preserve the original meaning, tone, ` +
      "wording, structure, and length as closely as possible — do not rephrase or embellish.",
    rephrase:
      `${base} Rephrase it to be clearer and more professionally worded, while also fixing any spelling or ` +
      "grammar mistakes. This is NOT a summarization task: every fact, requirement, and detail present in the " +
      "original must still be present afterward — only clean up the wording (and, per the rules above, the " +
      "structure, if the input doesn't yet have it). Keep the output within about 20% of the input's length, " +
      "just better phrased and properly shaped for what this text actually is.",
    /* Vague "make it shorter" left the model free to barely touch a short
       string and call it done — it did nothing because "shorter" without a
       concrete target is not a real instruction to a model, it is a
       suggestion it can politely ignore. A minimum percentage is not. */
    shorten:
      `${base} Cut it by at least a third in length compared to the input, while preserving every essential ` +
      "fact — tighten wording and cut filler and redundancy rather than dropping information the reader needs. " +
      "If the input is already very short (under about eight words), tighten it as much as honestly possible; " +
      "the result must still read as more concise than the input, never identical to it.",
    lengthen:
      `${base} Expand it to at least 50% more words than the input by adding concrete, relevant detail, ` +
      "examples, or context that plausibly belongs, without inventing facts the input didn't imply. If the " +
      "input is a single short line, grow it into multiple full sentences (or, for an email body, a properly " +
      "structured message per the rules above) — the result must be noticeably longer than the input, never " +
      "the same length.",
  };
}

/**
 * Freeform instruction mode — the user types what they want done.
 * With existing text, it's an edit instruction; with no text (the field was
 * empty), it's a "write this for me" request instead.
 */
function customInstruction(instruction, hasText, surface) {
  if (!hasText) return `${writingInstruction(surface)} Request: ${instruction}`;
  return `${editingInstruction(surface)} Apply this instruction to the text: ${instruction}`;
}

/** One retry on a transient failure, same model — matches aiAssist.service.js. */
async function withOneRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    await new Promise((r) => setTimeout(r, 600));
    return fn();
  }
}

/**
 * @param {{
 *   text: string,
 *   mode: "grammar" | "rephrase" | "shorten" | "lengthen" | "custom",
 *   instruction?: string,
 *   surface?: "mail-subject" | "mail-body" | "task-title" | "task-description" | "task-criterion",
 * }} params
 *   `text` may be empty only when `mode` is `"custom"` — that's the
 *   "write this for me" case, driven entirely by `instruction`. `surface`
 *   defaults to a generic workplace-text framing when omitted or unknown.
 * @returns {Promise<{ ok: true, text: string, model: string } | { ok: false, reason: string, message: string }>}
 */
async function improveText({ text, mode, instruction, surface }) {
  if (!isConfigured()) {
    return { ok: false, reason: "not_configured", message: "The assistant is not configured." };
  }

  const hasText = typeof text === "string" && text.trim().length > 0;
  const systemInstruction =
    mode === "custom"
      ? customInstruction(instruction, hasText, surface)
      : instructionsFor(surface)[mode];
  // Writing from scratch has no existing text to send as the turn's content —
  // the user's instruction IS the content in that case.
  const content = mode === "custom" && !hasText ? instruction : text;

  try {
    const client = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = client.getGenerativeModel({
      model: MODEL,
      systemInstruction,
      generationConfig: {
        // A bit above strictly deterministic — shorten/lengthen need enough
        // room to actually restructure rather than nudge a word here and
        // there, which is what made them look like they had "no effect".
        temperature: 0.4,
        maxOutputTokens: 1024,
      },
    });

    const result = await withOneRetry(() => model.generateContent(content));
    const out = result.response.text().trim();

    if (!out) {
      return { ok: false, reason: "empty", message: "The assistant had nothing to say." };
    }
    return { ok: true, text: out, model: MODEL };
  } catch (e) {
    const quota = /429|quota|rate.?limit/i.test(e.message || "");
    return {
      ok: false,
      reason: quota ? "quota" : "failed",
      message: quota
        ? "The assistant has hit its rate limit. Try again in a moment."
        : "The assistant could not reach Gemini.",
    };
  }
}

module.exports = { improveText, isConfigured, MODEL };
