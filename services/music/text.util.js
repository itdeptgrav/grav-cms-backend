"use strict";

/**
 * Cheap, dependency-free text similarity. This is the Stage-1 stand-in for
 * semantic embeddings: it matches on shared words, not meaning, but it is
 * free, instant, deterministic, and good enough to rank a candidate pool.
 * Stage 3 swaps the *content-similarity* signal for embedding cosine while
 * leaving everything else in place.
 *
 * Nothing here calls an LLM or a network — that is the whole point.
 */

// A small English + music-noise stoplist. Kept short on purpose: an aggressive
// stoplist throws away signal ("live", "remix", "cover" are meaningful for
// music), so this only removes words that are pure noise for similarity.
const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "feat",
  "ft", "official", "video", "audio", "lyrics", "lyric", "hd", "4k", "full",
  "song", "songs", "music", "mv", "vevo", "new", "latest",
]);

/**
 * Normalize a string into a de-duplicated bag of meaningful tokens.
 * Lowercases, strips anything non-alphanumeric to spaces, drops stopwords and
 * 1-character tokens.
 */
function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9À-ɏऀ-ॿ]+/g, " ") // keep latin-ext + devanagari (Hindi)
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Term-frequency map from a token list. */
function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * Cosine similarity between two token bags, in [0, 1]. Operates on raw term
 * frequencies (no IDF — we have no corpus statistics at request time and don't
 * want to maintain them for Stage 1).
 */
function cosineSim(tokensA, tokensB) {
  if (!tokensA.length || !tokensB.length) return 0;
  const a = termFreq(tokensA);
  const b = termFreq(tokensB);
  let dot = 0;
  for (const [term, av] of a) {
    const bv = b.get(term);
    if (bv) dot += av * bv;
  }
  if (dot === 0) return 0;
  let magA = 0;
  for (const v of a.values()) magA += v * v;
  let magB = 0;
  for (const v of b.values()) magB += v * v;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Jaccard overlap of two arrays treated as sets, in [0, 1]. */
function jaccard(arrA, arrB) {
  const a = new Set((arrA || []).map((x) => String(x).toLowerCase()));
  const b = new Set((arrB || []).map((x) => String(x).toLowerCase()));
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Cosine similarity of two equal-length numeric vectors (for Stage-3 embeddings). */
function cosineVec(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return 0;
  }
  let dot = 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    ma += a[i] * a[i];
    mb += b[i] * b[i];
  }
  if (ma === 0 || mb === 0) return 0;
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

/**
 * Tokens of a title with parenthetical/bracketed qualifiers removed — used to
 * detect "same song, different upload". Re-uploads keep the core song + artist
 * + credit words and differ mostly in the "(Official Video)" / "[Lyrics]" noise,
 * so stripping those and comparing the remainder finds duplicates that an exact
 * videoId check misses.
 */
function coreTitleTokens(title) {
  const stripped = String(title || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ");
  return tokenize(stripped);
}

/**
 * A normalized "song name" key from a title, used to catch same-song uploads
 * that a whole-title comparison misses. Bollywood titles pile on shared credit
 * names (actors, composers) that inflate similarity between DIFFERENT songs of
 * one film while the actual song word varies little — so comparing the credits
 * is backwards. The song name almost always sits at the front: after an
 * "Artist - " prefix and before the first bracket / pipe / colon-section.
 *
 *   "Arijit Singh - Tujhko (from Cocktail 2) ... | Love Song"  -> "tujhko"
 *   "Tujhko (Video) Shahid, Rashmika | Pritam, Arijit Singh"   -> "tujhko"
 *   "Cocktail 2: Tujhko (Official Video)"                      -> "tujhko"
 *   "Arijit Singh - Jab Talak (Video - Cocktail 2)"            -> "jab talak"
 *
 * Returns "" when nothing usable can be isolated (caller then relies on the
 * fuzzy title comparison instead).
 */
function songTitleKey(title) {
  let t = String(title || "");
  const dash = t.indexOf(" - ");
  if (dash >= 0) t = t.slice(dash + 3); // drop a leading "Artist - "
  t = t.split(/[([|]/)[0]; // song name comes before brackets/pipes
  t = t.replace(/^[^:]{1,30}:\s*/, ""); // drop a leading "Movie:" style prefix
  return tokenize(t).join(" ");
}

/**
 * The text a video is "about", for similarity: title + channel + tags + topic
 * labels. Description is deliberately excluded — it is mostly boilerplate,
 * links, and credits that add noise, not signal.
 */
function contentText(meta) {
  if (!meta) return "";
  return [
    meta.title,
    meta.channelTitle,
    (meta.tags || []).join(" "),
    (meta.topicLabels || []).join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

module.exports = {
  tokenize,
  termFreq,
  cosineSim,
  jaccard,
  cosineVec,
  contentText,
  coreTitleTokens,
  songTitleKey,
  STOP,
};
