"use strict";

/**
 * Provider-neutral call states. Provider adapters translate their own words
 * before a value reaches CallEvent or a browser response.
 */
const CALL_STATES = Object.freeze([
  "QUEUED",
  "AGENT_RINGING",
  "CUSTOMER_RINGING",
  "IN_PROGRESS",
  "COMPLETED",
  "AGENT_NO_ANSWER",
  "AGENT_BUSY",
  "CUSTOMER_NO_ANSWER",
  "CUSTOMER_BUSY",
  "FAILED",
  "CANCELLED",
]);

const TERMINAL_STATES = new Set([
  "COMPLETED",
  "AGENT_NO_ANSWER",
  "AGENT_BUSY",
  "CUSTOMER_NO_ANSWER",
  "CUSTOMER_BUSY",
  "FAILED",
  "CANCELLED",
]);

const PROGRESS_RANK = Object.freeze({
  QUEUED: 0,
  AGENT_RINGING: 1,
  CUSTOMER_RINGING: 2,
  IN_PROGRESS: 3,
});

function canonicalState(value) {
  const state = String(value || "").trim().toUpperCase();
  if (!CALL_STATES.includes(state)) {
    const error = new Error(`Unsupported call state: ${state || "<empty>"}`);
    error.code = "UNSUPPORTED_CALL_STATE";
    throw error;
  }
  return state;
}

function isTerminal(value) {
  return TERMINAL_STATES.has(canonicalState(value));
}

/**
 * Webhooks can skip an intermediate notification, so any live state may move
 * directly to a terminal state. A terminal state is final, and live states
 * may not move backwards.
 */
function canTransition(from, to) {
  const current = canonicalState(from);
  const next = canonicalState(to);
  if (current === next) return true;
  if (TERMINAL_STATES.has(current)) return false;
  if (TERMINAL_STATES.has(next)) return true;
  return PROGRESS_RANK[next] >= PROGRESS_RANK[current];
}

module.exports = { CALL_STATES, TERMINAL_STATES, canonicalState, isTerminal, canTransition };

