"use strict";

const UserVideoInteraction = require("../../models/music/UserVideoInteraction");
const VideoMetadata = require("../../models/music/VideoMetadata");
const { feedback, filters } = require("./recommendation.config");

/**
 * Records what users do with videos and turns that into the signals the ranker
 * needs. Two responsibilities:
 *   1. `record(userId, event)` — upsert one (user, video) row from a checkpoint
 *      event, cheaply. Never one write per second — the frontend only posts at
 *      completion crossings (10/25/50/75/90/ended/skipped) and explicit
 *      actions (spec §1).
 *   2. `buildUserProfile(userId)` — collapse a user's rows into channel / tag /
 *      category affinity maps the ranker reads. This is the Stage-1 "interest
 *      profile" (spec §7), computed on read; Stage 2 can persist and decay it.
 */

function completionRate(watchedSeconds, durationSeconds) {
  if (!durationSeconds || durationSeconds <= 0) return 0;
  return Math.max(0, Math.min(1, (watchedSeconds || 0) / durationSeconds));
}

/**
 * Signed implicit-feedback signal for one interaction row, in ~[-1, 1], using
 * the centralized ladder. Explicit like/dislike overrides behavioural signal;
 * otherwise completion drives it, with a hard negative for quick bails and
 * small bonuses for replays / recommendation-clicks.
 */
function feedbackSignal(row) {
  if (!row) return 0;
  if (row.disliked) return feedback.disliked;
  if (row.liked) return feedback.liked;

  // Quick bail: repeatedly started and abandoned in seconds.
  if (
    row.timesSkipped > 0 &&
    row.bestCompletionRate < 0.1 &&
    (row.durationSeconds
      ? row.totalWatchedSeconds <= feedback.quickBailSeconds
      : true)
  ) {
    return feedback.quickBailSignal;
  }

  let signal = 0;
  for (const step of feedback.ladder) {
    if (row.bestCompletionRate >= step.atLeast) {
      signal = step.signal;
      break;
    }
  }
  if (row.timesReplayed > 0) signal = Math.max(signal, feedback.replayed);
  if (row.clickedFromRecommendation > 0) {
    signal = Math.min(1, signal + feedback.recommendationClick * 0.3);
  }
  return Math.max(-1, Math.min(1, signal));
}

/**
 * Apply one interaction event. Builds a Mongo update from disjoint operators
 * ($set / $inc / $max / $addToSet) so upsert is atomic and idempotent-ish.
 */
async function record(userId, event) {
  if (!userId || !event || !event.videoId || !event.event) {
    throw new Error("record requires userId and event.{videoId,event}");
  }
  const now = new Date();
  const rate = completionRate(event.watchedSeconds, event.durationSeconds);

  const set = { lastWatchedAt: now };
  const inc = {};
  const max = {};
  const addToSet = {};

  if (event.channelId) set.channelId = event.channelId;
  if (event.durationSeconds) set.durationSeconds = event.durationSeconds;
  if (event.watchedSeconds) max.totalWatchedSeconds = event.watchedSeconds;
  if (rate > 0) max.bestCompletionRate = rate;
  if (event.searchQuery) addToSet.searchQueries = String(event.searchQuery).slice(0, 120);
  if (event.clickedFromRecommendation) inc.clickedFromRecommendation = 1;

  switch (event.event) {
    case "started":
      inc.timesPlayed = 1;
      set.startedAt = now;
      break;
    case "progress":
      break; // handled by the generic max/set above
    case "ended":
      set.completedAt = now;
      if (rate >= 0.95) inc.timesCompleted = 1;
      break;
    case "skipped":
      inc.timesSkipped = 1;
      break;
    case "replayed":
      inc.timesReplayed = 1;
      inc.timesPlayed = 1;
      break;
    case "liked":
      set.liked = true;
      set.disliked = false;
      break;
    case "disliked":
      set.disliked = true;
      set.liked = false;
      break;
    case "recommendation_click":
      // clickedFromRecommendation already handled above if flagged; ensure it.
      if (!event.clickedFromRecommendation) inc.clickedFromRecommendation = 1;
      break;
    default:
      throw new Error(`unknown interaction event: ${event.event}`);
  }

  const update = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(inc).length) update.$inc = inc;
  if (Object.keys(max).length) update.$max = max;
  if (Object.keys(addToSet).length) update.$addToSet = addToSet;

  const doc = await UserVideoInteraction.findOneAndUpdate(
    { userId, videoId: event.videoId },
    update,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return doc;
}

async function getUserInteractions(userId, { limit = 300 } = {}) {
  if (!userId) return [];
  return UserVideoInteraction.find({ userId })
    .sort({ lastWatchedAt: -1 })
    .limit(limit)
    .lean();
}

/** Video ids the user watched within the recency window (hard-filter "just watched"). */
async function getRecentlyWatchedIds(userId, hours = filters.recentlyWatchedHours) {
  if (!userId) return new Set();
  const since = new Date(Date.now() - hours * 3600 * 1000);
  const rows = await UserVideoInteraction.find(
    { userId, lastWatchedAt: { $gte: since } },
    { videoId: 1 },
  ).lean();
  return new Set(rows.map((r) => r.videoId));
}

/** Video ids to suppress: disliked, or skipped past the threshold with no real watch. */
async function getSuppressedIds(userId) {
  if (!userId) return new Set();
  const rows = await UserVideoInteraction.find(
    {
      userId,
      $or: [
        { disliked: true },
        { timesSkipped: { $gte: filters.skipSuppressionCount }, bestCompletionRate: { $lt: 0.2 } },
      ],
    },
    { videoId: 1 },
  ).lean();
  return new Set(rows.map((r) => r.videoId));
}

/**
 * Collapse a user's interactions into affinity maps the ranker reads. Reads the
 * cached metadata of watched videos to attribute tag/category interest (the
 * interaction rows store only channelId, so tags come from VideoMetadata).
 */
async function buildUserProfile(userId) {
  const empty = {
    userId,
    channelScores: new Map(),
    tagScores: new Map(),
    categoryScores: new Map(),
    watchedIds: new Set(),
    recentSearches: [],
    avgCompletion: 0,
    hasHistory: false,
  };
  if (!userId) return empty;

  const rows = await getUserInteractions(userId, { limit: 300 });
  if (!rows.length) return empty;

  const metaMap = new Map();
  const metas = await VideoMetadata.find({
    videoId: { $in: rows.map((r) => r.videoId) },
  }).lean();
  for (const m of metas) metaMap.set(m.videoId, m);

  const channelScores = new Map();
  const tagScores = new Map();
  const categoryScores = new Map();
  const watchedIds = new Set();
  const recentSearches = [];
  const seenSearch = new Set();
  let completionSum = 0;
  let completionN = 0;

  const bump = (map, key, delta) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + delta);
  };

  for (const row of rows) {
    watchedIds.add(row.videoId);
    const signal = feedbackSignal(row);
    if (row.bestCompletionRate > 0) {
      completionSum += row.bestCompletionRate;
      completionN += 1;
    }
    // Searches that led to positively-watched videos are the freshest interest
    // signal (spec §18) — collect the most recent few, unique.
    if (signal > 0) {
      for (const q of row.searchQueries || []) {
        const k = q.toLowerCase();
        if (!seenSearch.has(k) && recentSearches.length < 5) {
          seenSearch.add(k);
          recentSearches.push(q);
        }
      }
    }
    bump(channelScores, row.channelId, signal);
    const meta = metaMap.get(row.videoId);
    if (meta) {
      for (const tag of meta.tags || []) bump(tagScores, String(tag).toLowerCase(), signal);
      bump(categoryScores, meta.categoryId, signal);
    }
  }

  return {
    userId,
    channelScores,
    tagScores,
    categoryScores,
    watchedIds,
    recentSearches,
    avgCompletion: completionN ? completionSum / completionN : 0,
    hasHistory: true,
  };
}

module.exports = {
  record,
  getUserInteractions,
  getRecentlyWatchedIds,
  getSuppressedIds,
  buildUserProfile,
  // exported for tests
  feedbackSignal,
  completionRate,
};
