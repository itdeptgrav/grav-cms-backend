"use strict";
/**
 * services/ai/gravAssistant.js — the ONE central AI service.
 *
 * TYPED QWEN tool use:
 *   1) Qwen sees only the user's authorised capability names/descriptions and
 *      chooses one. It receives no business records.
 *   2) Qwen fills only that capability's closed argument schema.
 *   3) GRAV validates, re-authorises and executes the deterministic read.
 *
 * A conversational message that needs no data is answered by the normal Qwen
 * response round after the planner chooses `conversation`.
 */

// Requiring the feature tool modules registers their permission-gated tools.
require("./tools/hrTools");
require("./tools/accountingTools");

const { chatJson } = require("../ollamaClient");
const { buildSystemPrompt } = require("./identity");
const { authorizedTools, getTool } = require("./toolRegistry");
const { planToolQuestion, STATUS: PLAN_STATUS, CONTROL: PLAN_CONTROL } = require("./qwenToolPlanner");
const { resolveHrAccess, resolveHrActor } = require("../access/hrAccess");
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
  /* The SAME resolved actor the mounted HR routes are checked against, so an
     HR tool and an HR endpoint cannot disagree about the same person. Attached
     here rather than inside each tool because `permission(user)` is
     synchronous — the tools ask a question, they do not perform a lookup.
     Failing closed: an unresolvable actor holds no capabilities. */
  if (user.hrActor === undefined) {
    try {
      user.hrActor = await resolveHrActor(user);
    } catch {
      user.hrActor = { capabilities: new Set(), hasHrApplicationAccess: false, template: null };
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

/**
 * Typed context selection. The model plans; GRAV validates, re-authorises and
 * executes exactly one deterministic capability.
 */
async function selectContext({ user, message, history = [], routeContext }) {
  await ensureAccess(user);
  const tools = authorizedTools(user);
  const toolData = [];
  const toolsUsed = [];
  let directAnswer = null;
  let contextState = null;

  if (!tools.length) return { toolData, toolsUsed, directAnswer, contextState };
  const plan = await planToolQuestion({ question: message, tools, history });
  if (plan.status !== PLAN_STATUS.OK) {
    // Planning is part of the model service. Fail visibly instead of silently
    // changing behaviour through phrase rules or attaching the wrong dataset.
    if (plan.error) throw plan.error;
    directAnswer = "I couldn't safely determine which authorised business data to use. Please rephrase the request with the subject and period you want.";
    return { toolData, toolsUsed, directAnswer, contextState };
  }
  if (plan.control === PLAN_CONTROL.CONVERSATION) {
    return { toolData, toolsUsed, directAnswer, contextState };
  }
  if (plan.control === PLAN_CONTROL.CLARIFY) {
    directAnswer = plan.clarification;
    return { toolData, toolsUsed, directAnswer, contextState };
  }

  const tool = getTool(plan.tool);
  if (!tool || tool.permission(user) !== true) {
    directAnswer = "I don't have permission to access that data.";
    return { toolData, toolsUsed, directAnswer, contextState };
  }
  try {
    const data = await tool.provideContext({ user, message, args: plan.arguments || {} });
    toolData.push({ tool: plan.tool, data });
    toolsUsed.push(plan.tool);
    contextState = { schema: "grav.assistant.plan/1", tool: plan.tool, arguments: plan.arguments || {} };
  } catch {
    directAnswer = "I couldn't read that data safely right now. Please try again.";
  }
  return { toolData, toolsUsed, directAnswer, contextState };
}

async function chat({ user, message, routeContext, history = [] } = {}) {
  const { toolData, toolsUsed, directAnswer, contextState } = await selectContext({ user, message, history, routeContext });
  if (directAnswer && !toolData.length) {
    return { reply: directAnswer.slice(0, 4000), model: "qwen3", toolsUsed: [], contextState };
  }
  const taskRules = [...ANSWER_RULES, 'Respond with a single JSON object: {"reply": string}. Put your whole answer in "reply".'].join("\n");
  const system = buildSystemPrompt({ taskRules }); // route deliberately omitted
  const { reply, model } = await generateGroundedReply({ system, toolData, history, message });
  return { reply: reply.slice(0, 4000), model, toolsUsed, contextState };
}

/**
 * Streaming-endpoint variant. When there IS business data we do NOT token-stream:
 * streamed tokens can't be un-said, and the grounding guard must be able to
 * refuse an unverifiable figure BEFORE the user sees it. So a data answer is
 * generated + verified, then emitted whole via onAnswer. A no-data
 * conversational reply is emitted as-is.
 */
async function chatStreaming({ user, message, routeContext, history = [], onThinking, onAnswer, signal } = {}) {
  const { toolData, toolsUsed, directAnswer, contextState } = await selectContext({ user, message, history, routeContext });
  if (directAnswer && !toolData.length) {
    if (onAnswer) onAnswer(directAnswer);
    return { reply: directAnswer.slice(0, 4000), model: "qwen3", toolsUsed: [], contextState };
  }
  const taskRules = [...ANSWER_RULES, 'Respond with a single JSON object: {"reply": string}. Put your whole answer in "reply".'].join("\n");
  const system = buildSystemPrompt({ taskRules }); // route deliberately omitted
  const { reply, model } = await generateGroundedReply({ system, toolData, history, message });
  const finalReply = (reply && reply.trim()) || "I couldn't produce a response for that.";
  if (onAnswer) onAnswer(finalReply);
  return { reply: finalReply.slice(0, 4000), model, toolsUsed, contextState };
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
    // `warmup()` already loads Qwen. Typed planning schemas vary by the caller's
    // authorised catalogue, so there is no single safe fake-user prompt to warm.
    return;
  } catch {
    /* ignore — first real request will just be a little slower */
  }
}

/** The exact tool-selection system prompt, for the offline routing evaluation
 *  (scripts/open-jev-pilot/evaluate.js) to compare against the same baseline. */
function toolSelectionSystemPrompt() {
  return buildSystemPrompt({ taskRules: todayLine() });
}

module.exports = { chat, chatStreaming, runStructured, warmupTools, toolSelectionSystemPrompt };
