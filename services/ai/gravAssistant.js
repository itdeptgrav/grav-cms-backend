"use strict";
/**
 * services/ai/gravAssistant.js — the ONE central AI service.
 *
 * HYBRID tool use:
 *   1) The model itself sees the user's authorised tools (function-calling) and
 *      chooses which to call, extracting parameters (date, employee, department)
 *      from natural language — so "was Umang present on the fifth of August"
 *      needs no regex; the model resolves it.
 *   2) FAST FALLBACK: if the (small) model doesn't call a tool but the message
 *      clearly maps to HR data by keyword, the regex `relevantTools` path fetches
 *      it anyway. So we get natural-language understanding without losing
 *      reliability.
 *
 * A conversational message that needs no data is answered in the single
 * tool-decision round (no second call).
 */

// Requiring the feature tool modules registers their permission-gated tools.
require("./tools/hrTools");
require("./tools/accountingTools");

const { chatJson, chatStream, chatWithTools } = require("../ollamaClient");
const { buildSystemPrompt } = require("./identity");
const { relevantTools, authorizedToolDefs, getTool } = require("./toolRegistry");
const { resolveHrAccess } = require("../access/hrAccess");
const { resolveAccountingAccess } = require("../access/accountingAccess");

const REPLY_SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };

const ANSWER_RULES = [
  "Use the attached authorised data when it is relevant. If the user asks for business data that is not attached and you have no authorised source for it, say you don't have access to that data — do not invent it.",
  "NEVER refuse, limit, or qualify an answer based on which page, screen, module or route the user is on. The current page is irrelevant to what you can answer; do not mention it as a reason. If you lack the data, it is because it wasn't attached, not because of where the user is.",
  "Only state names, numbers, dates and facts that literally appear in the attached data. NEVER invent or guess an employee's name. If you have a count but not the individual names, give the count and say you can list specifics if asked.",
  "Express money amounts in the INDIAN numbering system — thousand, lakh, crore — NOT million or billion. When the data gives a 'lakh'/'crore' figure, quote that. E.g. say '26.3 lakh' or '2.13 crore', never '2.6 million'.",
  "For account balances keep the abbreviations 'Dr' and 'Cr' exactly as given — do NOT expand them to 'debit' or 'credit'.",
  "When you report a ledger, party, account, customer or employee, use the EXACT name spelled in the attached data — even if the user spelled or pronounced it differently. Never echo the user's mis-spelling; if the data says 'Debidutt Mangilall', say that, not the user's version.",
  "Do not use emojis, emoticons or decorative symbols. Write plain text that reads naturally when spoken aloud (the reply may be read out by text-to-speech).",
];

function todayLine() {
  const ist = new Date(Date.now() + 330 * 60 * 1000);
  const d = `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}-${String(ist.getUTCDate()).padStart(2, "0")}`;
  return `Today's date is ${d} (IST). Resolve relative or spelled-out dates ("yesterday", "the fifth of August") against it.`;
}

function historyBlock(history) {
  if (!history || history.length === 0) return "Conversation so far: (this is the first message).";
  const lines = history.map((t) => `${t.role === "user" ? "User" : "GRAV"}: ${t.content}`);
  return `Conversation so far:\n${lines.join("\n")}`;
}

function buildPrompt(toolData, history, message) {
  const contextBlock = toolData.length
    ? `Authorised business data for this message (only what this user may see):\n${JSON.stringify(toolData)}`
    : "No additional business data is attached to this message.";
  return [contextBlock, historyBlock(history), `User: ${message}`].join("\n\n");
}

// ── Anti-hallucination grounding guard ────────────────────────────────────────
// After the model answers, verify that every DATE and every meaningful NUMBER /
// AMOUNT it stated actually appears in the source data. Invented dates/amounts
// (the dangerous case, e.g. accounting) are caught here — no prompt can fully
// prevent them, but this can refuse to state a figure that isn't in the data.
function verifyGrounding(reply, toolData) {
  if (!toolData || !toolData.length) return { ok: true, bad: [] };
  const hay = JSON.stringify(toolData);
  const hayDigits = hay.replace(/[,\s]/g, "");
  const bad = [];
  const seen = new Set();
  const flag = (v) => {
    if (!seen.has(v)) {
      seen.add(v);
      bad.push(v);
    }
  };

  // Dates (YYYY-MM-DD) are never "computed" — an invented one is a hallucination.
  for (const m of String(reply).matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    if (!hay.includes(m[0])) flag(m[0]);
  }

  // All numbers present in the source, for verifying Indian-unit amounts. (NOTE:
  // "cr"/"Cr" is NOT treated as crore — it is the accounting Credit suffix.)
  const dataNums = (hay.match(/\d[\d,]*(?:\.\d+)?/g) || [])
    .map((s) => parseFloat(s.replace(/,/g, "")))
    .filter(Number.isFinite);

  let text = String(reply);
  // Indian-unit amounts ("26.3 lakh", "2.13 crore"): verify the SCALED value is a
  // real data figure (within a rounding tolerance), then blank the span so the
  // bare-number pass below doesn't re-flag "26.3" as an unknown decimal.
  text = text.replace(/(\d[\d,]*(?:\.\d+)?)\s*(crores?|lakhs?|lacs?|thousand)\b/gi, (full, numStr, unit) => {
    const num = parseFloat(String(numStr).replace(/,/g, ""));
    const u = unit.toLowerCase();
    const mult = /crore/.test(u) ? 1e7 : /lakh|lac/.test(u) ? 1e5 : 1e3;
    if (Number.isFinite(num)) {
      const scaled = num * mult;
      const ok = dataNums.some((d) => Math.abs(d - scaled) <= Math.max(mult / 100, Math.abs(d) * 0.01));
      if (!ok) flag(full.trim());
    }
    return " ";
  });

  // Remaining bare currency / large numbers and any decimal must appear in the
  // data. Small plain integers (counts like "1", "43") are skipped.
  for (const m of text.matchAll(/(?:₹|rs\.?\s*)?(\d[\d,]*(?:\.\d+)?)/gi)) {
    const raw = m[1];
    const digits = raw.replace(/[,\s]/g, "");
    const isDecimal = /\.\d+/.test(raw);
    const num = Number(digits);
    if (!Number.isFinite(num)) continue;
    if (num < 1000 && !isDecimal) continue;
    if (!hayDigits.includes(digits)) flag(raw);
  }
  return { ok: bad.length === 0, bad };
}

// Generate an answer from the tool data and REFUSE to emit unverifiable figures:
// draft -> verify -> one correction pass -> if still bad, drop the specifics.
async function generateGroundedReply({ system, toolData, history, message }) {
  const prompt = buildPrompt(toolData, history, message);
  const pick = (data) =>
    [data.reply, data.answer, data.text, data.response].find((v) => typeof v === "string" && v.trim())?.trim() || "";

  let { data, model } = await chatJson({ system, prompt, schema: REPLY_SCHEMA, temperature: 0 });
  let reply = pick(data);
  let check = verifyGrounding(reply, toolData);

  if (!check.ok) {
    const correction =
      `${prompt}\n\nYour draft answer was: "${reply}"\n` +
      `These values do NOT appear in the data above and may be wrong: ${check.bad.join(", ")}.\n` +
      `Rewrite the answer using ONLY dates and numbers that literally appear in the data. ` +
      `If a specific date or amount cannot be found in the data, do NOT state it — say you don't have that exact detail.`;
    const retry = await chatJson({ system, prompt: correction, schema: REPLY_SCHEMA, temperature: 0 });
    reply = pick(retry.data) || reply;
    model = retry.model || model;
    check = verifyGrounding(reply, toolData);
    if (!check.ok) {
      // Still unverifiable — safest to not state the specific figures at all.
      reply =
        "I can see the relevant record, but I couldn't confirm the exact figures from the data with confidence, so I won't state them. Please check the precise values in the source record.";
    }
  }
  return { reply: reply || "I couldn't produce a response for that.", model };
}

async function ensureAccess(user) {
  if (!user) return;
  if (user.hrAccess === undefined) {
    try {
      user.hrAccess = await resolveHrAccess(user);
    } catch {
      user.hrAccess = { allowed: false, via: null };
    }
  }
  if (user.accountingAccess === undefined) {
    try {
      user.accountingAccess = await resolveAccountingAccess(user);
    } catch {
      user.accountingAccess = { allowed: false, via: null };
    }
  }
}

const SELECT_RULES = [
  "You can call tools that fetch authorised business data. When the user's message needs such data (employees, attendance, leave, departments, overtime, holidays, policies, payroll, etc.), CALL the appropriate tool(s), extracting each parameter from the message yourself (resolve dates to YYYY-MM-DD).",
  "If the message is general conversation that needs no data, just reply directly.",
].join("\n");

/**
 * HYBRID context selection. Returns the fetched tool data (and which tools ran),
 * or a `directAnswer` when the model answered a no-data conversational message.
 */
async function selectContext({ user, message, history = [], routeContext }) {
  await ensureAccess(user);
  const tools = authorizedToolDefs(user);
  const toolData = [];
  const toolsUsed = [];
  let directAnswer = null;

  if (tools.length) {
    // Keep the system + tool schemas IDENTICAL across requests so Ollama caches
    // that ~900-token prefix (first call ~7s of prompt-eval, cached calls ~0.1s).
    // The per-request route goes in the user message, NOT the system, so it
    // doesn't break the cache. Today's date changes only daily (re-warms fine).
    const system = buildSystemPrompt({ taskRules: `${todayLine()}\n${SELECT_RULES}` });
    // The current route is deliberately NOT sent to the model: it is irrelevant to
    // what GRAV can answer, and injecting it made the model invent route-based
    // refusals ("not accessible from the onboarding route"). Access is decided by
    // the account's permissions only.
    const messages = [
      ...history.map((h) => ({ role: h.role === "user" ? "user" : "assistant", content: h.content })),
      { role: "user", content: message },
    ];
    try {
      const decision = await chatWithTools({ system, messages, tools });
      if (decision.toolCalls.length) {
        for (const call of decision.toolCalls) {
          const fn = call.function || {};
          const tool = getTool(fn.name);
          if (!tool || tool.permission(user) !== true) continue; // re-check permission
          let args = fn.arguments;
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          try {
            const data = await tool.provideContext({ user, message, args: args || {} });
            toolData.push({ tool: fn.name, data });
            toolsUsed.push(fn.name);
          } catch {
            /* a failing tool must not block the assistant */
          }
        }
      } else if (decision.content && decision.content.trim()) {
        directAnswer = decision.content.trim();
      }
    } catch {
      /* tool round failed -> regex fallback below */
    }
  }

  // Fast fallback: model fetched nothing, but the message maps to HR tools by
  // keyword — fetch via the regex path so an 8B miss doesn't lose the answer.
  if (!toolData.length) {
    const rel = relevantTools(user, message);
    if (rel.length) {
      directAnswer = null; // we have real data to attach; don't shortcut
      for (const t of rel) {
        try {
          toolData.push({ tool: t.name, data: await t.provideContext({ user, message }) });
          toolsUsed.push(t.name);
        } catch {
          /* omit */
        }
      }
    }
  }

  return { toolData, toolsUsed, directAnswer };
}

async function chat({ user, message, routeContext, history = [] } = {}) {
  const { toolData, toolsUsed, directAnswer } = await selectContext({ user, message, history, routeContext });
  if (directAnswer && !toolData.length) {
    return { reply: directAnswer.slice(0, 4000), model: "qwen3", toolsUsed: [] };
  }
  const taskRules = [...ANSWER_RULES, 'Respond with a single JSON object: {"reply": string}. Put your whole answer in "reply".'].join("\n");
  const system = buildSystemPrompt({ taskRules }); // route deliberately omitted
  const { reply, model } = await generateGroundedReply({ system, toolData, history, message });
  return { reply: reply.slice(0, 4000), model, toolsUsed };
}

/**
 * Streaming-endpoint variant. When there IS business data we do NOT token-stream:
 * streamed tokens can't be un-said, and the grounding guard must be able to
 * refuse an unverifiable figure BEFORE the user sees it. So a data answer is
 * generated + verified, then emitted whole via onAnswer. A no-data
 * conversational reply is emitted as-is.
 */
async function chatStreaming({ user, message, routeContext, history = [], onThinking, onAnswer, signal } = {}) {
  const { toolData, toolsUsed, directAnswer } = await selectContext({ user, message, history, routeContext });
  if (directAnswer && !toolData.length) {
    if (onAnswer) onAnswer(directAnswer);
    return { reply: directAnswer.slice(0, 4000), model: "qwen3", toolsUsed: [] };
  }
  const taskRules = [...ANSWER_RULES, 'Respond with a single JSON object: {"reply": string}. Put your whole answer in "reply".'].join("\n");
  const system = buildSystemPrompt({ taskRules }); // route deliberately omitted
  const { reply, model } = await generateGroundedReply({ system, toolData, history, message });
  const finalReply = (reply && reply.trim()) || "I couldn't produce a response for that.";
  if (onAnswer) onAnswer(finalReply);
  return { reply: finalReply.slice(0, 4000), model, toolsUsed };
}

/**
 * Structured feature task through the same identity/model, returning validated
 * JSON. Unchanged by the hybrid work.
 */
async function runStructured({ taskRules, prompt, schema, routeContext } = {}) {
  const system = buildSystemPrompt({ routeContext, taskRules });
  return chatJson({ system, prompt, schema });
}

/**
 * Warm the tool-decision prompt cache on boot: send one throwaway function-call
 * request with the full HR tool set so Ollama caches the ~900-token system+tools
 * prefix. Without this the FIRST real query pays ~7s of prompt-eval. Best-effort.
 */
async function warmupTools() {
  try {
    const tools = authorizedToolDefs({ hrAccess: { allowed: true }, accountingAccess: { allowed: true }, role: "ceo" });
    if (!tools.length) return;
    const system = buildSystemPrompt({ taskRules: `${todayLine()}\n${SELECT_RULES}` });
    await chatWithTools({ system, messages: [{ role: "user", content: "hello" }], tools });
  } catch {
    /* ignore — first real request will just be a little slower */
  }
}

module.exports = { chat, chatStreaming, runStructured, warmupTools };
