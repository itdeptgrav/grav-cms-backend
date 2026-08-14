"use strict";
/**
 * services/ai/conversationStore.js — per-USER conversation state.
 *
 * Conversation is keyed by the signed-in user's id (from the verified JWT), NOT
 * by route or application. So moving between the app switcher, HR, Sales and any
 * other module keeps the same conversation; only the user identity scopes it.
 *
 * Because the key is the server-verified user id, one user can never read
 * another user's conversation (a caller cannot ask for someone else's id).
 *
 * This first version is in-memory: it survives navigation (the server stays up)
 * but not a server restart. A durable store (e.g. Mongo) can replace this later
 * without changing callers.
 */

const store = new Map(); // userId -> [{ role, content }]
const MAX_TURNS = 24; // keep the last N messages (user+assistant), bounded prompt

/** Return this user's conversation (a copy). */
function getHistory(userId) {
  return [...(store.get(userId) || [])];
}

/** Append one turn and trim to the window. */
function append(userId, turn) {
  if (!userId) return;
  const arr = store.get(userId) || [];
  arr.push({ role: turn.role, content: String(turn.content || "").slice(0, 4000) });
  while (arr.length > MAX_TURNS) arr.shift();
  store.set(userId, arr);
}

/** Clear this user's conversation. */
function reset(userId) {
  store.delete(userId);
}

/** Test seam. */
function _clearAll() {
  store.clear();
}

module.exports = { getHistory, append, reset, MAX_TURNS, _clearAll };
