"use strict";
/**
 * routes/ai/assistant.js — the central GRAV assistant API.
 *
 *   POST /api/ai/assistant/message   { message, routeContext? }
 *   POST /api/ai/assistant/reset
 *   GET  /api/ai/assistant/history
 *
 * One endpoint for the whole CMS. ANY authenticated employee may talk to GRAV;
 * what business data GRAV can see is decided per-tool by the signed-in user's
 * permissions (see services/ai/toolRegistry), never by the page.
 *
 * Conversation is keyed by the verified user id, so navigating between the app
 * switcher and applications never resets it, and no user can read another's
 * conversation. `routeContext` is accepted as optional context only — it is
 * never used to authorise data or to change GRAV's identity.
 */

const express = require("express");
const router = express.Router();

const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const gravAssistant = require("../../services/ai/gravAssistant");
const convo = require("../../services/ai/conversationStore");
const { getHotwords } = require("../../services/ai/sttVocab");
const { correctTranscript } = require("../../services/ai/transcriptCorrect");
const { ensureSttServer, STT_URL } = require("../../services/ai/sttSidecar");
const { sendOllamaError } = require("../../services/hrAiShared");
const { OLLAMA_ERROR_CODES, warmup } = require("../../services/ollamaClient");

const MAX_MESSAGE_LEN = 2000;

// Preload the model AND the tool-decision prompt cache on boot (fire-and-forget)
// so the first user message is warm rather than paying the ~10s model-load and
// ~7s tool-prefix prompt-eval costs. Skipped under tests.
if (process.env.NODE_ENV !== "test") {
  warmup().then(() => gravAssistant.warmupTools());
  // Bring up the local Whisper speech-to-text sidecar (no-ops if already running).
  ensureSttServer();
}

// Friendly, user-facing message for an OllamaError code (SSE can't reuse the
// JSON-writing sendOllamaError helper).
function ollamaMessage(err) {
  switch (err && err.code) {
    case OLLAMA_ERROR_CODES.UNAVAILABLE:
      return "GRAV's local model isn't running right now.";
    case OLLAMA_ERROR_CODES.MODEL_NOT_FOUND:
      return "GRAV's model isn't installed on this server.";
    case OLLAMA_ERROR_CODES.TIMEOUT:
      return "GRAV took too long to respond. Please try again.";
    default:
      return "GRAV is unavailable right now. Please try again.";
  }
}

router.post("/assistant/message", EmployeeAuthMiddlewear, async (req, res) => {
  const user = req.user;
  if (!user || !user.id) {
    // Auth middleware already guarantees this, but fail closed regardless.
    return res.status(401).json({ success: false, message: "Authentication required." });
  }

  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  // routeContext is OPTIONAL context; it never authorises data or changes identity.
  const routeContext =
    typeof req.body?.routeContext === "string" ? req.body.routeContext : undefined;

  if (!message) {
    return res.status(400).json({ success: false, message: "A message is required." });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({
      success: false,
      message: `Message is too long. Keep it under ${MAX_MESSAGE_LEN} characters.`,
    });
  }

  try {
    const history = convo.getHistory(user.id);
    const { reply, model, toolsUsed } = await gravAssistant.chat({
      user,
      message,
      routeContext,
      history,
    });

    // Persist the exchange for this user (not the route).
    convo.append(user.id, { role: "user", content: message });
    convo.append(user.id, { role: "assistant", content: reply });

    return res.json({
      success: true,
      reply,
      meta: {
        model,
        toolsUsed, // which authorised tools contributed data, if any
        routeAware: Boolean(routeContext),
        assistant: "grav",
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    if (sendOllamaError(res, err)) return undefined;
    console.error("[AI] assistant error:", err);
    return res.status(500).json({ success: false, message: "Something went wrong." });
  }
});

// Streaming twin of /message: Server-Sent Events that surface GRAV's REAL
// reasoning as short rolling lines while it thinks, then the final reply.
// Events: `thinking` {text}, `reply` {reply, meta}, `error` {message}, `done`.
router.post("/assistant/stream", EmployeeAuthMiddlewear, async (req, res) => {
  const user = req.user;
  if (!user || !user.id) {
    return res.status(401).json({ success: false, message: "Authentication required." });
  }
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  const routeContext =
    typeof req.body?.routeContext === "string" ? req.body.routeContext : undefined;
  if (!message) {
    return res.status(400).json({ success: false, message: "A message is required." });
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return res.status(400).json({
      success: false,
      message: `Message is too long. Keep it under ${MAX_MESSAGE_LEN} characters.`,
    });
  }

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // don't let nginx buffer the stream
  });
  if (typeof res.flushHeaders === "function") res.flushHeaders();
  const sse = (event, data) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      /* client gone */
    }
  };

  // Abort the model stream ONLY if the client actually disconnects mid-stream.
  // Note: use res "close", not req "close" — on a POST whose body Express has
  // already parsed, the request stream emits "close" immediately, which would
  // abort our own model call the instant it starts (an instant false timeout).
  const ac = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) ac.abort();
  });
  const end = () => {
    finished = true;
    res.end();
  };

  // Condense the raw reasoning to ONE calm line. We deliberately DON'T show
  // every fragment: only whole sentences, at most one per ~1s, capped in length.
  // So the reader sees a settled thought that changes slowly, not a strobe.
  const MIN_GAP_MS = 1000;
  let thinkBuf = "";
  let lastLine = "";
  let lastEmit = 0;
  const onThinking = (delta) => {
    thinkBuf += delta;
    const now = Date.now();
    if (lastEmit && now - lastEmit < MIN_GAP_MS) return; // pace it out
    // The most recent COMPLETE sentence (ignore the still-forming tail).
    const sentences = thinkBuf.match(/[^.!?\n]+[.!?]/g);
    if (!sentences || !sentences.length) return;
    const line = sentences[sentences.length - 1].replace(/\s+/g, " ").trim().slice(0, 90);
    // Skip tiny filler fragments ("Okay.", "Hmm.").
    if (line && line !== lastLine && line.split(" ").length >= 3) {
      lastLine = line;
      lastEmit = now;
      sse("thinking", { text: line });
    }
  };

  // Stream the answer itself, token by token, so a long reply appears as it is
  // written instead of the user waiting for the whole thing.
  const onAnswer = (delta) => {
    if (delta) sse("token", { text: delta });
  };

  try {
    const history = convo.getHistory(user.id);
    const { reply, model, toolsUsed } = await gravAssistant.chatStreaming({
      user,
      message,
      routeContext,
      history,
      onThinking,
      onAnswer,
      signal: ac.signal,
    });

    // Persist only once we have a real reply (matches /message).
    if (reply) {
      convo.append(user.id, { role: "user", content: message });
      convo.append(user.id, { role: "assistant", content: reply });
    }
    sse("reply", {
      reply,
      meta: {
        model,
        toolsUsed,
        routeAware: Boolean(routeContext),
        assistant: "grav",
        generatedAt: new Date().toISOString(),
      },
    });
    sse("done", {});
    end();
  } catch (err) {
    console.error("[AI] assistant stream error:", err);
    sse("error", { message: ollamaMessage(err) });
    sse("done", {});
    end();
  }
});

// Speech-to-text: the browser records the spoken command and POSTs the raw audio
// here; we transcribe it with the local Whisper sidecar, biased by the live DB
// vocabulary (party / customer / employee names), and return the text. This
// REPLACES the browser's Web Speech API, which mangled Indian-accented English +
// business jargon. Audio stays on this host end to end.
router.post(
  "/assistant/transcribe",
  EmployeeAuthMiddlewear,
  express.raw({ type: () => true, limit: "25mb" }),
  async (req, res) => {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio || audio.length === 0) {
      return res.status(400).json({ success: false, message: "No audio received." });
    }
    try {
      const hotwords = await getHotwords().catch(() => "");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 30000);
      let sttRes;
      try {
        sttRes = await fetch(`${STT_URL}/transcribe`, {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            "X-Hotwords": hotwords.replace(/[\r\n]+/g, " ").slice(0, 900),
          },
          body: audio,
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (!sttRes.ok) {
        const detail = await sttRes.text().catch(() => "");
        console.error("[AI] STT sidecar error:", sttRes.status, detail);
        return res
          .status(503)
          .json({ success: false, message: "Speech recognition is unavailable right now." });
      }
      const data = await sttRes.json();
      // Fix the handful of domain terms Whisper reliably mis-hears (e.g. "ledger"
      // -> "leisure") before the assistant ever sees the text.
      const text = correctTranscript(typeof data.text === "string" ? data.text.trim() : "");
      return res.json({ success: true, text });
    } catch (err) {
      const offline = err?.name === "AbortError" || err?.cause?.code === "ECONNREFUSED";
      console.error("[AI] transcribe error:", err?.message || err, "| cause:", err?.cause?.code || err?.cause?.message || "");
      return res.status(503).json({
        success: false,
        message: offline
          ? "Speech recognition service isn't running."
          : "Couldn't transcribe the audio.",
      });
    }
  },
);

router.get("/assistant/history", EmployeeAuthMiddlewear, (req, res) => {
  if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required." });
  return res.json({ success: true, history: convo.getHistory(req.user.id) });
});

router.post("/assistant/reset", EmployeeAuthMiddlewear, (req, res) => {
  if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required." });
  convo.reset(req.user.id);
  return res.json({ success: true });
});

module.exports = router;
