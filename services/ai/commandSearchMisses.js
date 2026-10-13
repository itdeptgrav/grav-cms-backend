"use strict";
/**
 * services/ai/commandSearchMisses.js — keep the searches Cmd/Ctrl K could not
 * answer, so the words in them can be taught to it.
 *
 * Anonymous and short-lived by construction — see
 * models/CMS_Models/AI/CommandSearchMiss.js. This module adds the two rules a
 * schema cannot hold:
 *
 *   · the text is cleaned before it is kept — lower-cased, and any phone
 *     number or email address blanked, because a search box is exactly where
 *     somebody pastes one;
 *   · a miss is RECORDED ONLY WHEN THE SERVER AGREES IT WAS ONE. The browser
 *     reports a search as unanswered when the palette closes; the search is run
 *     again here and kept only if it still finds nothing. A browser cannot
 *     write arbitrary text into the list by claiming a miss.
 *
 * No model, and nothing here is read back into an answer.
 */

const CommandSearchMiss = require("../../models/CMS_Models/AI/CommandSearchMiss");

const MISS_STATES = Object.freeze(["no_match", "unsupported"]);
const MIN_LENGTH = 3;
const MAX_LENGTH = 200;

/** The text as it is kept: lower-case, single-spaced, no phone or email. */
function clean(query) {
  return String(query || "")
    .toLowerCase()
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[email]")
    /* Seven or more digits, allowing the spaces and dashes phone numbers are
       written with. Document numbers ("PO/2026-27/0011") have shorter runs
       and survive, because an unknown reference is a useful miss. */
    .replace(/\+?\d[\d\s-]{5,}\d/g, (run) => (run.replace(/\D/g, "").length >= 7 ? "[number]" : run))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LENGTH);
}

/**
 * Record one unanswered search, if it really is one.
 *
 * @param {object}   args
 * @param {string}   args.app      the application whose palette it was ("store")
 * @param {string}   args.query    what was typed
 * @param {Function} args.search   `({ query }) => Promise<{state}>` — the same
 *                                 search the palette ran, run again here
 * @returns {Promise<{recorded: boolean, reason?: string}>}
 */
async function recordIfMiss({ app, query, search, at = new Date() }) {
  const text = clean(query);
  if (text.length < MIN_LENGTH) return { recorded: false, reason: "too short" };
  const out = await search({ query: String(query).trim().slice(0, MAX_LENGTH) });
  const state = out?.state;
  if (!MISS_STATES.includes(state)) return { recorded: false, reason: `answered (${state})` };
  await CommandSearchMiss.updateOne(
    { app, query: text },
    {
      $inc: { count: 1 },
      $set: { lastSeenAt: at, state },
      $setOnInsert: { firstSeenAt: at },
    },
    { upsert: true },
  );
  return { recorded: true };
}

/** The most-typed unanswered searches, for the weekly look. Read-only. */
async function topMisses({ app = "store", limit = 50 } = {}) {
  return CommandSearchMiss.find({ app })
    .sort({ count: -1, lastSeenAt: -1 })
    .limit(Math.min(500, Math.max(1, limit)))
    .select("query state count firstSeenAt lastSeenAt -_id")
    .lean();
}

module.exports = { MISS_STATES, clean, recordIfMiss, topMisses };
