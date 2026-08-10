"use strict";
/**
 * services/ollamaClient.js — minimal local Ollama client.
 *
 * Talks to a locally running Ollama server over its HTTP API using the
 * runtime's native `fetch` (Node 18+). Deliberately NO SDK / AI dependency:
 * one POST to /api/chat is all we need.
 *
 * Defaults target the already-installed model:
 *   OLLAMA_BASE_URL   http://127.0.0.1:11434
 *   OLLAMA_MODEL      qwen3:8b
 *   OLLAMA_TIMEOUT_MS 60000
 * All three are overridable via environment variables. The timeout default is
 * generous because local 8B inference on CPU/modest GPU regularly needs
 * 20-40s for a full answer; tune it down where the hardware is faster.
 *
 * The one public function, `chatJson()`, asks the model for a single
 * JSON object (Ollama `format: "json"`) and returns the parsed object. Every
 * predictable failure — the server being down, the model not being pulled, a
 * slow response, or malformed output — is surfaced as an `OllamaError` with a
 * stable `.code`, so callers can map each to a sensible HTTP status without
 * string-matching.
 *
 * qwen3 is a "thinking" model: it can emit a <think>…</think> preamble. We ask
 * Ollama to disable that (`think: false`) AND strip any such block defensively,
 * so internal reasoning never reaches the caller or the user.
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:11434";
const DEFAULT_MODEL = "qwen3:8b";
const DEFAULT_TIMEOUT_MS = 60000;

/** Stable error codes so route handlers can branch without parsing messages. */
const OLLAMA_ERROR_CODES = Object.freeze({
  UNAVAILABLE: "OLLAMA_UNAVAILABLE", // server unreachable / connection refused
  MODEL_NOT_FOUND: "OLLAMA_MODEL_NOT_FOUND", // model not pulled
  TIMEOUT: "OLLAMA_TIMEOUT", // exceeded timeout budget
  BAD_STATUS: "OLLAMA_BAD_STATUS", // non-2xx that isn't a missing model
  MALFORMED: "OLLAMA_MALFORMED_RESPONSE", // empty / non-JSON model output
});

class OllamaError extends Error {
  constructor(code, message, { status = null, cause = null } = {}) {
    super(message);
    this.name = "OllamaError";
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

// How long Ollama keeps the model resident in memory after a request. The model
// takes several seconds to load; if it unloads between messages every reply pays
// that cost again. Keeping it warm is the single biggest latency win. "-1" pins
// it forever; a duration like "30m" unloads only after real idle.
const DEFAULT_KEEP_ALIVE = "30m";

function config() {
  return {
    baseUrl: (process.env.OLLAMA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ""),
    model: process.env.OLLAMA_MODEL || DEFAULT_MODEL,
    timeoutMs: Number(process.env.OLLAMA_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    keepAlive: process.env.OLLAMA_KEEP_ALIVE || DEFAULT_KEEP_ALIVE,
  };
}

/** Remove any <think>…</think> reasoning the model may still emit. */
function stripThink(text) {
  if (typeof text !== "string") return "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

/**
 * Some models wrap JSON in ```json fences or add prose around it even when
 * asked for pure JSON. Pull out the outermost {...} as a fallback.
 */
function extractJsonObject(text) {
  const cleaned = stripThink(text);
  try {
    return JSON.parse(cleaned);
  } catch {
    // fall through to brace extraction
  }
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(cleaned.slice(first, last + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

/**
 * Ask the local model for one JSON object.
 *
 * @param {object} args
 * @param {string} args.system   system prompt (role, rules, output contract)
 * @param {string} args.prompt   user prompt (the question + aggregate context)
 * @param {object} [args.schema] a JSON Schema. When given it is passed as
 *                 Ollama's `format` so the model is constrained to that exact
 *                 shape (structured outputs) instead of just "any valid JSON" —
 *                 which small models otherwise collapse to `{"answer": "..."}`.
 * @param {number} [args.temperature=0.2]
 * @param {number} [args.timeoutMs]  overrides OLLAMA_TIMEOUT_MS
 * @param {object} [args.fetchImpl] injectable fetch (tests)
 * @returns {Promise<{ data: object, model: string }>}
 * @throws {OllamaError}
 */
async function chatJson({ system, prompt, schema, temperature = 0.2, numPredict, timeoutMs, fetchImpl } = {}) {
  const { baseUrl, model, timeoutMs: cfgTimeout, keepAlive } = config();
  const doFetch = fetchImpl || globalThis.fetch;
  const budget = Number(timeoutMs) || cfgTimeout;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  let res;
  try {
    res = await doFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAlive, // keep the model warm between requests
        // A JSON Schema constrains the model to the exact shape (structured
        // outputs); plain "json" only guarantees valid-but-arbitrary JSON.
        format: schema || "json",
        think: false, // qwen3: suppress the <think> preamble at the source
        options: { temperature, ...(numPredict ? { num_predict: numPredict } : {}) },
        messages: [
          { role: "system", content: system || "" },
          { role: "user", content: prompt || "" },
        ],
      }),
    });
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new OllamaError(
        OLLAMA_ERROR_CODES.TIMEOUT,
        `Local AI model did not respond within ${budget}ms.`,
        { cause: err },
      );
    }
    // ECONNREFUSED / DNS / socket errors land here → server not running.
    throw new OllamaError(
      OLLAMA_ERROR_CODES.UNAVAILABLE,
      "Local AI service is unavailable. Is Ollama running?",
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    // Ollama returns 404 with "model ... not found" when the model isn't pulled.
    if (res.status === 404 || /not found|try pulling/i.test(bodyText)) {
      throw new OllamaError(
        OLLAMA_ERROR_CODES.MODEL_NOT_FOUND,
        `Model "${model}" is not available on the local Ollama server.`,
        { status: res.status },
      );
    }
    throw new OllamaError(
      OLLAMA_ERROR_CODES.BAD_STATUS,
      `Local AI service returned HTTP ${res.status}.`,
      { status: res.status },
    );
  }

  let payload;
  try {
    payload = await res.json();
  } catch (err) {
    throw new OllamaError(
      OLLAMA_ERROR_CODES.MALFORMED,
      "Local AI service returned a non-JSON envelope.",
      { cause: err },
    );
  }

  const content = payload && payload.message && payload.message.content;
  const data = extractJsonObject(content);
  if (!data || typeof data !== "object") {
    throw new OllamaError(
      OLLAMA_ERROR_CODES.MALFORMED,
      "Local AI model did not return a usable JSON object.",
    );
  }

  return { data, model };
}

/**
 * Streaming chat that surfaces the model's reasoning as it thinks.
 *
 * Unlike chatJson (which suppresses <think> and returns one JSON object), this
 * lets qwen3 think out loud and forwards the reasoning to `onThinking` while it
 * arrives, then returns the final plain-text answer. Two reasoning channels are
 * handled: newer Ollama exposes it as `message.thinking`; otherwise it is inline
 * in `message.content` as a <think>…</think> block — both are routed to
 * onThinking, and only the post-think text becomes the answer.
 *
 * @param {object} args
 * @param {string} args.system
 * @param {string} args.prompt
 * @param {(delta:string)=>void} [args.onThinking]  reasoning text, incrementally
 * @param {(delta:string)=>void} [args.onAnswer]    answer text, incrementally
 * @param {AbortSignal} [args.signal]               abort (e.g. client disconnect)
 * @param {number} [args.temperature=0.3]
 * @param {number} [args.timeoutMs]
 * @param {object} [args.fetchImpl]
 * @returns {Promise<{ reply: string, model: string }>}
 * @throws {OllamaError}
 */
async function chatStream({
  system,
  prompt,
  onThinking,
  onAnswer,
  signal,
  temperature = 0.3,
  // Thinking makes qwen3 ~4x slower (it generates a long reasoning preamble
  // before answering). For a conversational assistant that latency is not worth
  // it, so reasoning is OFF by default. Set think:true (or OLLAMA_THINK=1) to
  // bring back the streamed reasoning for complex tasks.
  think = process.env.OLLAMA_THINK === "1",
  numPredict = 512,
  timeoutMs,
  fetchImpl,
} = {}) {
  const { baseUrl, model, timeoutMs: cfgTimeout, keepAlive } = config();
  const doFetch = fetchImpl || globalThis.fetch;
  const budget = Number(timeoutMs) || cfgTimeout;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort);
  }
  const timer = setTimeout(() => controller.abort(), budget);
  const cleanup = () => {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  };

  let res;
  try {
    res = await doFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: true,
        keep_alive: keepAlive, // keep the model warm between requests
        // Reasoning is off by default for speed (see `think` above). When on,
        // qwen3 emits it as <think>…</think> in content and/or message.thinking;
        // both are routed to onThinking below.
        think,
        options: { temperature, num_predict: numPredict },
        messages: [
          { role: "system", content: system || "" },
          { role: "user", content: prompt || "" },
        ],
      }),
    });
  } catch (err) {
    cleanup();
    if (err && err.name === "AbortError") {
      throw new OllamaError(
        OLLAMA_ERROR_CODES.TIMEOUT,
        `Local AI model did not respond within ${budget}ms.`,
        { cause: err },
      );
    }
    throw new OllamaError(
      OLLAMA_ERROR_CODES.UNAVAILABLE,
      "Local AI service is unavailable. Is Ollama running?",
      { cause: err },
    );
  }

  if (!res.ok) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    cleanup();
    if (res.status === 404 || /not found|try pulling/i.test(bodyText)) {
      throw new OllamaError(
        OLLAMA_ERROR_CODES.MODEL_NOT_FOUND,
        `Model "${model}" is not available on the local Ollama server.`,
        { status: res.status },
      );
    }
    throw new OllamaError(
      OLLAMA_ERROR_CODES.BAD_STATUS,
      `Local AI service returned HTTP ${res.status}.`,
      { status: res.status },
    );
  }

  let answer = "";
  let inThink = false; // tracking an inline <think> block across chunks

  // Split a content delta into reasoning (<think>…</think>) vs answer text.
  const routeContent = (delta) => {
    let text = delta || "";
    while (text.length) {
      if (inThink) {
        const end = text.indexOf("</think>");
        if (end === -1) {
          if (onThinking) onThinking(text);
          return;
        }
        if (end > 0 && onThinking) onThinking(text.slice(0, end));
        text = text.slice(end + "</think>".length);
        inThink = false;
      } else {
        const start = text.indexOf("<think>");
        if (start === -1) {
          answer += text;
          if (onAnswer) onAnswer(text);
          return;
        }
        const before = text.slice(0, start);
        if (before) {
          answer += before;
          if (onAnswer) onAnswer(before);
        }
        text = text.slice(start + "<think>".length);
        inThink = true;
      }
    }
  };

  try {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue;
        }
        const msg = obj.message || {};
        if (msg.thinking && onThinking) onThinking(msg.thinking);
        if (msg.content) routeContent(msg.content);
        if (obj.done) {
          buf = "";
          break;
        }
      }
    }
  } catch (err) {
    cleanup();
    if (err && err.name === "AbortError") {
      // Client went away / timed out mid-stream — return what we have.
      return { reply: stripThink(answer).trim(), model };
    }
    throw new OllamaError(OLLAMA_ERROR_CODES.BAD_STATUS, "Local AI stream failed.", { cause: err });
  }

  cleanup();
  return { reply: stripThink(answer).trim(), model };
}

/**
 * Best-effort warm-up: load the model into memory so the first real user message
 * doesn't pay the multi-second cold-load cost. Fire-and-forget on server boot;
 * never throws (a warmup failure must not affect startup).
 */
async function warmup() {
  const { baseUrl, model, keepAlive } = config();
  const doFetch = globalThis.fetch;
  if (!doFetch) return;
  try {
    await doFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAlive,
        think: false,
        options: { num_predict: 1 },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
  } catch {
    /* Ollama not up yet / unreachable — the first real request will load it. */
  }
}

/**
 * One non-streaming round with function-calling tools. The model either returns
 * `toolCalls` (it wants data) or `content` (a direct answer). Used by the hybrid
 * assistant: the model itself chooses tools and extracts their arguments from
 * natural language, so dates/names/departments need no regex.
 *
 * @returns {Promise<{ toolCalls: Array, content: string, model: string }>}
 */
async function chatWithTools({ system, messages = [], tools, temperature = 0.2, timeoutMs, fetchImpl } = {}) {
  const { baseUrl, model, timeoutMs: cfgTimeout, keepAlive } = config();
  const doFetch = fetchImpl || globalThis.fetch;
  const budget = Number(timeoutMs) || cfgTimeout;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budget);

  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of messages) msgs.push(m);

  let res;
  try {
    res = await doFetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: keepAlive,
        think: false,
        options: { temperature },
        tools: tools && tools.length ? tools : undefined,
        messages: msgs,
      }),
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new OllamaError(OLLAMA_ERROR_CODES.TIMEOUT, `Local AI model did not respond within ${budget}ms.`, { cause: err });
    }
    throw new OllamaError(OLLAMA_ERROR_CODES.UNAVAILABLE, "Local AI service is unavailable. Is Ollama running?", { cause: err });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new OllamaError(OLLAMA_ERROR_CODES.BAD_STATUS, `Local AI service returned HTTP ${res.status}.`, { status: res.status });
  }
  const payload = await res.json().catch(() => null);
  const msg = (payload && payload.message) || {};
  return { toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [], content: stripThink(msg.content || ""), model };
}

module.exports = {
  chatJson,
  chatStream,
  chatWithTools,
  warmup,
  OllamaError,
  OLLAMA_ERROR_CODES,
  // exported for focused unit tests
  _internal: { stripThink, extractJsonObject, config, DEFAULT_BASE_URL, DEFAULT_MODEL },
};
