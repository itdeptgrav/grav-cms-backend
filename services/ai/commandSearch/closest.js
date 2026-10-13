"use strict";
/**
 * services/ai/commandSearch/closest.js — when nothing matches exactly, the
 * records that come closest, for every application's Cmd/Ctrl K.
 *
 * Owner's call (9 Oct 2026): "we can't do verbatim — show the best possible
 * results while giving a small warning". Spoken and typed words arrive with
 * "off" for "of", a word missing ("1/4"), a typo, a word cut short. So a
 * NAME that matched nothing is compared word by word with the names of the
 * records the person may already see, and the closest are offered under a
 * note saying they are not an exact match.
 *
 * Only for names. A filtered question ("pending orders from Nobody"), a date
 * window or a document number is never answered with near misses — another
 * supplier's orders are not "close" to the question asked. Callers decide
 * that; this module only scores words.
 *
 * Pure: strings in, scores out. No database, no model.
 */

/* Words that carry no identity: question words, measures, and the of/off
   that speech-to-text confuses. */
const STOP = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "from", "give", "has", "have", "how", "i", "in", "is", "it",
  "me", "much", "many", "of", "off", "on", "or", "please", "show", "tell", "that", "the", "this", "to", "what",
  "where", "which", "who", "with", "find", "open", "get", "about", "details", "detail", "info", "stock",
  "quantity", "qty", "status", "price", "rate", "balance", "record", "records", "all", "my", "our",
]);

const tokensOf = (value) => (String(value || "").toLowerCase().match(/[a-z0-9]+/g) || []);
/** The words of a query that can name something. */
function queryTokens(query) {
  return [...new Set(tokensOf(query).filter((t) => !STOP.has(t) && (t.length >= 2 || /\d/.test(t))))];
}

/** Edit distance, capped — only "is it within 1 or 2" is ever asked. */
function within(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

/* The word without its ending: trader, traders, trading → "trad". */
const stem = (w) => (w.length > 5 ? w.replace(/(ings?|ers?|ed|es|s)$/, "") : w);

/* How an Indian name SOUNDS, so spellings speech-to-text picks for the same
   sound meet: Ravee/Ravi, Kumaar/Kumar, Shrma/Sharma's vowels, Phool/Fool,
   Vinod/Winod, doubled letters. */
const sound = (w) => w
  .replace(/ee|ie|ey$|y$/g, "i").replace(/oo|ou/g, "u").replace(/aa/g, "a")
  .replace(/ph/g, "f").replace(/w/g, "v").replace(/z/g, "j").replace(/sh/g, "s").replace(/th/g, "t")
  .replace(/(.)\1+/g, "$1");

/** How well one spoken/typed word matches one word of a name: 0…1. */
function wordScore(q, c) {
  if (q === c) return 1;
  if (q.length >= 3 && c.length >= 3 && sound(q) === sound(c)) return 0.85; // "Ravee" → "Ravi"
  if (q.length >= 4 && c.length >= 4 && stem(q) === stem(c)) return 0.8; // "traders" → "trading"
  if (q.length >= 3 && c.startsWith(q)) return 0.85;          // "arm" → "armhole"
  if (c.length >= 3 && q.startsWith(c) && q.length - c.length <= 2) return 0.75; // "folders" → "folder"
  if (q.length >= 4 && within(q, c, 1)) return 0.7;            // one typo
  if (q.length >= 7 && within(q, c, 2)) return 0.5;            // two, in a long word
  return 0;
}

/**
 * Score a candidate's words against the query's.
 * @returns {number} 0 when it should not be offered; else higher is closer
 */
function scoreWords(qTokens, cTokens) {
  if (!qTokens.length || !cTokens.length) return 0;
  let total = 0;
  let strong = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const c of cTokens) best = Math.max(best, wordScore(q, c));
    total += best;
    if (best >= 0.7) strong += 1; // exact, a word's start, or one typo
  }
  const coverage = total / qTokens.length;
  /* At least one word must really match, and most of what was said must be
     accounted for — "pending arm" is not close to "Feed of the Arm folder". */
  if (!strong || coverage < 0.6) return 0;
  /* A name that is mostly what was said ranks above a long name that merely
     contains it. */
  const tightness = Math.min(1, qTokens.length / cTokens.length);
  return coverage * 0.85 + tightness * 0.15;
}

/**
 * The closest candidates to what was asked.
 *
 * @param {string} query
 * @param {Array<{ label: string, words?: string }>} candidates  `words`: everything that names it (name, code, alias)
 * @param {{ limit?: number }} [opts]
 * @returns {Array<{ candidate: object, score: number }>} best first
 */
function closestMatches(query, candidates, { limit = 5 } = {}) {
  const qTokens = queryTokens(query);
  if (!qTokens.length) return [];
  const scored = [];
  for (const candidate of candidates || []) {
    const score = scoreWords(qTokens, [...new Set(tokensOf(`${candidate.label || ""} ${candidate.words || ""}`))]);
    if (score > 0) scored.push({ candidate, score });
  }
  scored.sort((a, b) => (b.score - a.score) || String(a.candidate.label).length - String(b.candidate.label).length);
  return scored.slice(0, limit);
}

/** The note shown above near matches. */
const approximateNote = (query) => `No exact match for "${String(query || "").trim().slice(0, 60)}" — closest matches.`;

module.exports = { closestMatches, queryTokens, scoreWords, wordScore, approximateNote };
