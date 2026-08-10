"use strict";
/**
 * services/hrAiShared.js — pieces shared by every page-contextual HR AI tool.
 *
 * The Overview assistant (routes/HrRoutes/AiOverviewAssistant.js) predates this
 * module and is intentionally left untouched. New tools (starting with Daily
 * Attendance) reuse these helpers so the safety gate, error mapping and output
 * shaping stay identical across pages instead of drifting per route.
 */

const { OllamaError, OLLAMA_ERROR_CODES } = require("./ollamaClient");

const DISCLAIMER =
  "AI assistance based on the current HR data. Read-only — it describes what the records show and cannot approve, change or action anything. Verify before acting.";

/**
 * Restricted-intent gate. These topics are refused before any model call,
 * regardless of the (already aggregate/attendance-only) context. Beyond the
 * privacy set (pay, bank, medical, personal data) it also blocks employee
 * RANKING and MISCONDUCT/PERFORMANCE conclusions — an attendance assistant must
 * describe records, not judge people or drive disciplinary action.
 */
const RESTRICTED_PATTERNS = [
  /\b(salary|salaries|payroll|pay ?slip|ctc|wage|wages|bonus|increment|compensation)\b/i,
  /\b(bank|account number|ifsc|upi|pan\b|aadhaar|aadhar|passport)\b/i,
  /\b(password|credential|login|otp)\b/i,
  /\b(medical|health record|diagnosis|disability|pregnan)\b/i,
  /\b(home address|personal (phone|number|email)|date of birth|dob)\b/i,
  // Employment decisions / disciplinary action
  /\b(fire|terminate|termination|sack|lay ?off|dismiss|suspend|warning letter|disciplinary|show ?cause|penali[sz]e|deduct(ion)? for)\b/i,
  /\b(promote|promotion|appraisal rating|increment decision)\b/i,
  // Ranking / performance conclusions
  /\b(rank (the )?employees?|worst (employee|performer)|best (employee|performer)|who is the (worst|best)|laziest|most (absent|irregular) employee to punish|performance review|misconduct)\b/i,
  // Raw database / prompt-extraction attempts
  /\b(drop table|delete from|update .*set|db\.|mongo|aggregate\(|find\(|system prompt|ignore (the|all) (above|previous)|reveal your (prompt|instructions))\b/i,
];

function isRestricted(text) {
  return RESTRICTED_PATTERNS.some((re) => re.test(text));
}

/** Trim a model array field into a bounded array of clean strings. */
function asStringArray(v, max = 12) {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x) => typeof x === "string" && x.trim())
    .map((x) => x.trim())
    .slice(0, max);
}

/**
 * Map an Ollama failure to a clear, non-leaky HTTP response. Returns true when
 * it handled `err` (and wrote the response); false when `err` was not an
 * OllamaError and the caller should handle it.
 */
function sendOllamaError(res, err) {
  if (!(err instanceof OllamaError)) return false;
  const base = { success: false, code: err.code };
  switch (err.code) {
    case OLLAMA_ERROR_CODES.UNAVAILABLE:
      res.status(503).json({ ...base, message: "The local HR AI service is not running right now. Please try again later." });
      return true;
    case OLLAMA_ERROR_CODES.MODEL_NOT_FOUND:
      res.status(503).json({ ...base, message: "The HR AI model is not installed on the server." });
      return true;
    case OLLAMA_ERROR_CODES.TIMEOUT:
      res.status(504).json({ ...base, message: "The HR AI model took too long to respond. Please try a narrower question." });
      return true;
    case OLLAMA_ERROR_CODES.MALFORMED:
      res.status(502).json({ ...base, message: "The HR AI model returned an unreadable response. Please try again." });
      return true;
    default:
      res.status(502).json({ ...base, message: "The HR AI service could not complete the request." });
      return true;
  }
}

module.exports = {
  DISCLAIMER,
  RESTRICTED_PATTERNS,
  isRestricted,
  asStringArray,
  sendOllamaError,
};
