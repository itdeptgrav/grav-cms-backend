"use strict";

/**
 * Every tunable number for the recommendation engine lives here — nothing
 * downstream hardcodes a weight, a threshold, or a TTL. The spec is explicit
 * about this ("keep them centralized/configurable instead of scattering magic
 * numbers"), and it is what lets the ranking be tuned without hunting through
 * the services.
 *
 * Feature flags are read from the environment so the engine can be switched off
 * or have a stage disabled without a deploy. Defaults keep Stage 1 on and the
 * later-stage features off, matching the incremental build order.
 */

function flag(name, fallback) {
  const v = process.env[name];
  if (v === undefined) return fallback;
  return String(v).toLowerCase() === "true" || v === "1";
}

module.exports = {
  flags: {
    /** Master switch. When false the endpoints still respond, but with the
        safe non-personalized fallback only — playback must never depend on the
        engine being healthy. */
    enabled: flag("RECOMMENDATION_ENGINE_ENABLED", true),
    /** Stage 3. Semantic similarity via an embedding provider. */
    embeddings: flag("RECOMMENDATION_EMBEDDINGS_ENABLED", false),
    /** Stage 4. Collaborative ("people who watched X also watched Y"). */
    collaborative: flag("RECOMMENDATION_COLLABORATIVE_ENABLED", false),
    /** Exposes per-signal `reasons` on results and verbose scoring logs. Must
        stay off in production — it is development instrumentation. */
    debug: flag("RECOMMENDATION_DEBUG", false),
  },

  /**
   * V1 ranking weights. Starting points, per the spec — tune freely. They do
   * NOT need to sum to 1; the ranker normalizes the final score across the
   * candidate pool regardless, so these express relative importance.
   */
  weights: {
    contentSimilarity: 0.25, // lexical (Stage 1) / semantic (Stage 3) closeness to the seed
    topicSimilarity: 0.15, // tag + category overlap with the seed
    creatorAffinity: 0.1, // how much this user engages with this channel
    userInterest: 0.2, // candidate vs. this user's aggregate tag/category interests
    watchHistoryAffinity: 0.1, // positive history with this channel/category
    completionBehavior: 0.1, // how fully this user tends to finish similar content
    popularity: 0.05, // normalized view count — a weak tie-breaker, never dominant
    freshness: 0.05, // recency of publish date
  },

  /**
   * Implicit-feedback mapping. Turns raw watch behaviour into a signed signal
   * in roughly [-1, +1]. Centralized so "what counts as a positive" is one
   * decision, not a dozen inline comparisons. Thresholds are completion
   * fractions (watchedSeconds / durationSeconds).
   */
  feedback: {
    // completionRate -> signal
    ladder: [
      { atLeast: 0.95, signal: 1.0 }, // finished — very strong positive
      { atLeast: 0.8, signal: 0.8 }, // strong positive
      { atLeast: 0.5, signal: 0.5 }, // positive
      { atLeast: 0.2, signal: 0.0 }, // weak / neutral
      { atLeast: 0.0, signal: -0.6 }, // <20% watched — negative
    ],
    // a sub-10-second bail is a stronger negative than "watched <20%"
    quickBailSeconds: 10,
    quickBailSignal: -0.9,
    // explicit signals
    liked: 1.0,
    disliked: -1.0,
    replayed: 0.9,
    recommendationClick: 0.5,
    searchedTopic: 0.4,
  },

  filters: {
    /** A candidate the user watched within this window is suppressed as "just
        watched" — prevents immediately re-serving something. */
    recentlyWatchedHours: 6,
    /** Skip this video/channel enough times and it is filtered out entirely. */
    skipSuppressionCount: 3,
    /** Loop guard: how many of the session's most-recent picks to remember and
        exclude, so autoplay can't ping-pong A→B→A→B. */
    sessionHistorySize: 25,
  },

  candidates: {
    /** Aim for a pool in this range before ranking (spec: 50–200). */
    minPool: 50,
    maxPool: 200,
    /**
     * How many distinct search concepts to derive from one seed video. Each
     * concept is one YouTube `search.list` = 100 quota units, and the daily
     * budget is only ~100 searches, so this is the single biggest quota lever.
     * 3 (artist-songs / artist / top-tag) keeps the pool useful while cutting
     * ~40% of the cost vs. 5. Raise only if a quota increase is granted.
     */
    maxSearchConcepts: 3,
    /** Results to request per concept search (free — part of the same call). */
    perConceptResults: 40,
  },

  diversity: {
    /** Cap how many results in a returned list may share one channel, so a
        suggested feed isn't 20 videos from the same uploader. */
    maxPerChannel: 3,
    /** Exploration share: fraction of slots intentionally given to lower-ranked
        "explore" picks rather than pure top-N exploitation. */
    explorationRatio: 0.15,
    /**
     * "Same song, different upload" suppression (spec §16). A re-upload has a
     * different videoId, a different channel, and often high view count — so the
     * cheap filters miss it and the ranker actually LOVES it (near-identical
     * title = top content similarity). Caught by comparing core titles, with
     * duration as a corroborating signal (the same song is the same length).
     */
    nearDupTitleSim: 0.6, // core-title cosine at/above this = duplicate
    nearDupTitleSimWithDuration: 0.4, // lower bar when durations also match
    nearDupDurationTolSec: 3,
  },

  /**
   * Cache TTLs, in milliseconds. Mirror the frontend provider's discipline
   * (search results churn faster than immutable video details).
   */
  ttl: {
    videoMetadataMs: 6 * 60 * 60 * 1000, // 6h — title/tags/category rarely change
    searchMs: 30 * 60 * 1000, // 30m — search result sets drift
    candidatePoolMs: 20 * 60 * 1000, // 20m — reuse a seed's pool across autoplay hits
  },

  /**
   * YouTube Data API quota accounting. Units are Google's documented costs.
   * The daily budget is a soft self-imposed ceiling so a runaway loop can't
   * exhaust the project quota.
   */
  quota: {
    dailyUnits: 10000,
    costSearch: 100, // search.list
    costList: 1, // videos.list (any part combination, per call)
  },
};
