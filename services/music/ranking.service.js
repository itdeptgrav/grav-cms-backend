"use strict";

const text = require("./text.util");
const embedding = require("./embedding.service");
const { weights, flags } = require("./recommendation.config");

/**
 * The V1 ranking engine. Given a seed video, a candidate pool, and the user's
 * profile, it scores every candidate as a weighted sum of understandable
 * signals and returns them sorted, each with an optional per-signal `reasons`
 * breakdown for debugging (spec §5, §26). Weights live in config — nothing here
 * is a magic number.
 *
 * Every signal is normalized to [0, 1] before weighting. The final weighted sum
 * is then min-max normalized across the pool so the returned `score` is a clean
 * relative confidence, while `rawScore` preserves the absolute weighted value.
 */

// x in (-inf, inf) -> (0, 1). 0 -> 0.5 (neutral), positive -> >0.5, negative ->
// <0.5. Lets a disliked-channel affinity actually pull a candidate down while a
// loved one lifts it, without a hard cap distorting large sums.
function to01(x) {
  const squashed = x / (1 + Math.abs(x)); // (-1, 1)
  return (squashed + 1) / 2;
}

function contentSimilarity(seed, cand) {
  // Stage 3: prefer semantic cosine when both embeddings exist and the flag is on.
  if (embedding.embeddingsAvailable() && Array.isArray(seed.embedding) && Array.isArray(cand.embedding)) {
    return Math.max(0, text.cosineVec(seed.embedding, cand.embedding));
  }
  // Stage 1: lexical cosine over title + creator + tags + topics.
  return text.cosineSim(
    text.tokenize(text.contentText(seed)),
    text.tokenize(text.contentText(cand)),
  );
}

function topicSimilarity(seed, cand) {
  const seedTags = [...(seed.tags || []), ...(seed.topicLabels || [])];
  const candTags = [...(cand.tags || []), ...(cand.topicLabels || [])];
  const tagJaccard = text.jaccard(seedTags, candTags);
  const categoryMatch = seed.categoryId && seed.categoryId === cand.categoryId ? 1 : 0;
  const sameCreator = seed.channelId && seed.channelId === cand.channelId ? 1 : 0;
  // "More from the same creator" is a strong relatedness signal, so it lives here.
  return Math.min(1, 0.5 * tagJaccard + 0.2 * categoryMatch + 0.3 * sameCreator);
}

function creatorAffinity(cand, profile) {
  return to01(profile.channelScores.get(cand.channelId) || 0);
}

function userInterest(cand, profile) {
  if (!(cand.tags && cand.tags.length)) return 0.5; // unknown -> neutral
  let sum = 0;
  for (const tag of cand.tags) sum += profile.tagScores.get(String(tag).toLowerCase()) || 0;
  return to01(sum);
}

function watchHistoryAffinity(cand, profile) {
  return to01(profile.categoryScores.get(cand.categoryId) || 0);
}

function completionBehavior(cand, profile) {
  // How fully this user finishes things, nudged by whether they engage this
  // candidate's category at all. Same-ish across candidates by design — it's a
  // gentle global "is this user a finisher" prior, not a differentiator.
  const categoryInterest = to01(profile.categoryScores.get(cand.categoryId) || 0);
  return Math.max(0, Math.min(1, profile.avgCompletion * (0.6 + 0.4 * categoryInterest)));
}

function freshness(cand) {
  if (!cand.publishedAt) return 0.3;
  const ageDays = (Date.now() - new Date(cand.publishedAt).getTime()) / 86400000;
  if (ageDays < 0) return 1;
  return Math.exp(-ageDays / 365); // ~1 new, ~0.37 at 1yr, ~0.14 at 2yr
}

/**
 * Rank a candidate pool against a seed for a user.
 * @returns array of { meta, score, rawScore, reasons? } sorted by score desc.
 */
function rank(seed, candidates, { userProfile, debug = flags.debug } = {}) {
  const profile = userProfile || {
    channelScores: new Map(),
    tagScores: new Map(),
    categoryScores: new Map(),
    avgCompletion: 0,
  };
  if (!candidates || !candidates.length) return [];

  // Pool-relative popularity: min-max of log view counts.
  const logs = candidates.map((c) => Math.log10((c.viewCount || 0) + 1));
  const minLog = Math.min(...logs);
  const maxLog = Math.max(...logs);
  const popSpan = maxLog - minLog;

  const scored = candidates.map((cand, i) => {
    const signals = {
      contentSimilarity: contentSimilarity(seed, cand),
      topicSimilarity: topicSimilarity(seed, cand),
      creatorAffinity: creatorAffinity(cand, profile),
      userInterest: userInterest(cand, profile),
      watchHistoryAffinity: watchHistoryAffinity(cand, profile),
      completionBehavior: completionBehavior(cand, profile),
      popularity: popSpan > 0 ? (logs[i] - minLog) / popSpan : 0.5,
      freshness: freshness(cand),
    };
    let rawScore = 0;
    for (const key of Object.keys(weights)) {
      rawScore += weights[key] * (signals[key] || 0);
    }
    return { meta: cand, rawScore, signals };
  });

  // Min-max normalize the weighted sum across the pool -> clean [0,1] score.
  const raws = scored.map((s) => s.rawScore);
  const minRaw = Math.min(...raws);
  const maxRaw = Math.max(...raws);
  const span = maxRaw - minRaw;

  const out = scored.map((s) => {
    const score = span > 0 ? (s.rawScore - minRaw) / span : s.rawScore;
    const row = { meta: s.meta, score, rawScore: s.rawScore };
    if (debug) row.reasons = s.signals;
    return row;
  });

  out.sort((a, b) => b.score - a.score);
  return out;
}

module.exports = {
  rank,
  // exported for tests
  _internal: {
    contentSimilarity,
    topicSimilarity,
    creatorAffinity,
    userInterest,
    watchHistoryAffinity,
    completionBehavior,
    freshness,
    to01,
  },
};
