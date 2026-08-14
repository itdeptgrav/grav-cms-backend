"use strict";
/**
 * services/ai/toolRegistry.js — where feature modules expose authorised data.
 *
 * The central GRAV assistant has no built-in knowledge of HR, Sales, etc. Each
 * feature registers a "tool": a permission-gated context provider. The central
 * service only ever attaches a tool's data when BOTH are true:
 *   1. the signed-in employee passes the tool's `permission(user)` check, and
 *   2. the tool is relevant to the user's message (`matches(message)`).
 *
 * This is how "HR-specific data access is a permission-controlled tool of the
 * central assistant" — not a separate HR model or personality. Centralised does
 * not mean unrestricted: a non-authorised user's message never has that tool's
 * data attached, server-side.
 */

const tools = new Map();

/**
 * @param {object} tool
 * @param {string} tool.name         stable id, e.g. "hr_overview"
 * @param {string} tool.description  one line, for logging/inspection
 * @param {(user:object)=>boolean} tool.permission  authorisation check
 * @param {(message:string)=>boolean} tool.matches  relevance check
 * @param {(args:{user:object})=>Promise<object>} tool.provideContext
 */
function registerTool(tool) {
  if (!tool || !tool.name) throw new Error("registerTool: tool.name is required");
  tools.set(tool.name, {
    name: tool.name,
    description: tool.description || "",
    // JSON-Schema for the tool's parameters, used for LLM function-calling so the
    // model extracts date/name/department from natural language itself. Optional
    // (a tool with no inputs omits it); the regex `matches`/extraction path stays
    // as the fast fallback.
    parameters: tool.parameters || { type: "object", properties: {} },
    permission: typeof tool.permission === "function" ? tool.permission : () => false,
    matches: typeof tool.matches === "function" ? tool.matches : () => false,
    provideContext:
      typeof tool.provideContext === "function"
        ? tool.provideContext
        : async () => ({}),
  });
}

/** Tools this user is authorised to use (permission only). */
function authorizedTools(user) {
  return [...tools.values()].filter((t) => {
    try {
      return t.permission(user) === true;
    } catch {
      return false;
    }
  });
}

/** Authorised AND relevant to this message. */
function relevantTools(user, message) {
  const msg = typeof message === "string" ? message : "";
  return authorizedTools(user).filter((t) => {
    try {
      return t.matches(msg) === true;
    } catch {
      return false;
    }
  });
}

/** OpenAI/Ollama-style function definitions for every tool this user may use. */
function authorizedToolDefs(user) {
  return authorizedTools(user).map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Look up a registered tool by name (for executing an LLM tool call). */
function getTool(name) {
  return tools.get(name) || null;
}

/** Test seam. */
function _clear() {
  tools.clear();
}

module.exports = {
  registerTool,
  authorizedTools,
  relevantTools,
  authorizedToolDefs,
  getTool,
  _tools: tools,
  _clear,
};
