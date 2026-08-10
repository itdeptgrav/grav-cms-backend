"use strict";

const metadata = require("./metadata.service");
const candidatesSvc = require("./candidates.service");
const interaction = require("./interaction.service");
const ranking = require("./ranking.service");
const youtube = require("./youtube.service");
const text = require("./text.util");
const VideoMetadata = require("../../models/music/VideoMetadata");
const { flags, filters, diversity } = require("./recommendation.config");

/**
 * Two videos are the "same song, different upload" when their core titles are
 * near-identical — or moderately similar AND the same length (a strong
 * corroborating signal, since a re-upload of a track runs the same duration).
 */
function isNearDuplicate(a, b) {
  // Strongest signal: the isolated song name matches (catches "Tujhko" variants
  // that differ wildly in their credit lists).
  const ka = text.songTitleKey(a.title);
  const kb = text.songTitleKey(b.title);
  if (ka && kb && ka === kb) return true;

  const sim = text.cosineSim(text.coreTitleTokens(a.title), text.coreTitleTokens(b.title));
  if (sim >= diversity.nearDupTitleSim) return true;
  if (
    sim >= diversity.nearDupTitleSimWithDuration &&
    a.durationSeconds &&
    b.durationSeconds &&
    Math.abs(a.durationSeconds - b.durationSeconds) <= diversity.nearDupDurationTolSec
  ) {
    return true;
  }
  return false;
}

/**
 * Drop candidates that are the same song as the seed (so autoplay never replays
 * the current track under a different upload), then collapse re-upload clusters
 * among the ranked results, keeping only the highest-ranked representative.
 * Operates on already-sorted rows.
 */
function collapseNearDuplicates(seed, rankedRows, recentSongs = []) {
  // The seed's song name, and whether it's specific enough to match on. Title
  // parsing is unreliable ("Song - Lyrics" vs "Artist - Song"), so for the seed
  // comparison we also use containment: a candidate that contains ALL of the
  // seed's song-name tokens is the same song, whatever else its title piles on.
  const seedKey = seed ? text.songTitleKey(seed.title) : "";
  const seedTokens = seedKey ? seedKey.split(" ").filter(Boolean) : [];
  const seedSpecific =
    seedTokens.length > 0 && (seedTokens.some((t) => t.length >= 4) || seedTokens.length >= 2);

  const sameSongAsSeed = (cand) => {
    if (isNearDuplicate(seed, cand)) return true;
    if (seedSpecific) {
      const ct = new Set(text.coreTitleTokens(cand.title));
      if (seedTokens.every((t) => ct.has(t))) return true;
    }
    return false;
  };

  const kept = [];
  for (const row of rankedRows) {
    if (seed && sameSongAsSeed(row.meta)) continue; // same song as the seed
    // Already heard this song (any version) recently this session — the cause of
    // autoplay tunnelling on one track's re-uploads, and where the unplayable
    // variants hide. Skip it so autoplay actually moves on.
    if (recentSongs.some((r) => isNearDuplicate(r, row.meta))) continue;
    if (kept.some((k) => isNearDuplicate(k.meta, row.meta))) continue; // re-upload of a kept one
    kept.push(row);
  }
  return kept;
}

/** Titles/durations of songs the user has recently played, for near-dup
 *  suppression. Cache-only (no YouTube calls) — these were just played, so
 *  their metadata is already stored. */
async function recentlyPlayedSongs(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return [];
  const rows = await VideoMetadata.find(
    { videoId: { $in: list } },
    { title: 1, durationSeconds: 1 },
  ).lean();
  return rows;
}

/**
 * The orchestrator — the only module routes talk to. It wires the pipeline:
 *
 *   seed metadata → candidate pool → hard filters → rank → diversity → result
 *
 * and owns the cross-cutting concerns: loop prevention, cold-start handling,
 * and graceful fallbacks. The guiding rule (spec §24): a failure anywhere in
 * here returns fewer/no recommendations, never throws into the caller —
 * playback must survive a sick recommender. The frontend keeps its own local
 * autoplay as the final safety net, so an empty result here is acceptable.
 */

// ── loop prevention: per-session recent-pick memory ──────────────────────────
// In-memory is the right scope: a "session" is one continuous listen, and this
// only needs to outlive a handful of autoplay hops. Bounded per session and by
// a coarse TTL so the map can't grow without bound.
const sessionHistory = new Map(); // sessionId -> { ids: string[], expires }
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;

function sessionIds(sessionId) {
  if (!sessionId) return [];
  const hit = sessionHistory.get(sessionId);
  if (!hit || hit.expires < Date.now()) {
    sessionHistory.delete(sessionId);
    return [];
  }
  return hit.ids;
}
function rememberPick(sessionId, videoId) {
  if (!sessionId || !videoId) return;
  const ids = sessionIds(sessionId);
  const next = [videoId, ...ids.filter((x) => x !== videoId)].slice(
    0,
    filters.sessionHistorySize,
  );
  sessionHistory.set(sessionId, { ids: next, expires: Date.now() + SESSION_TTL_MS });
}

// ── output shaping ───────────────────────────────────────────────────────────
function shape(row) {
  const m = row.meta;
  const out = {
    videoId: m.videoId,
    title: m.title,
    channelTitle: m.channelTitle,
    channelId: m.channelId,
    thumbnail: (m.thumbnails && (m.thumbnails.medium || m.thumbnails.small)) || "",
    duration: m.durationSeconds,
    score: Number(row.score.toFixed(4)),
  };
  if (flags.debug && row.reasons) out.reasons = row.reasons;
  return out;
}

// ── hard filters (spec §4) ───────────────────────────────────────────────────
function availabilityOk(meta) {
  if (!meta) return false;
  if (meta.embeddable === false) return false; // can't play in our iframe
  if (meta.liveState && meta.liveState !== "none") return false; // live/upcoming
  return true;
}

function applyHardFilters(candidates, { currentVideoId, excludeSet }) {
  const seen = new Set();
  const out = [];
  for (const meta of candidates) {
    if (!meta || !meta.videoId) continue;
    if (meta.videoId === currentVideoId) continue; // never the current video
    if (seen.has(meta.videoId)) continue; // dedupe
    if (excludeSet.has(meta.videoId)) continue; // recently watched / suppressed / session
    if (!availabilityOk(meta)) continue; // unavailable / non-embeddable / live
    seen.add(meta.videoId);
    out.push(meta);
  }
  return out;
}

// ── diversity (spec §16) ─────────────────────────────────────────────────────
function applyDiversity(ranked, limit) {
  if (ranked.length <= 1) return ranked.slice(0, limit);
  const cap = diversity.maxPerChannel;
  const channelCount = new Map();
  const chosen = [];
  const used = new Set();

  const tryAdd = (row) => {
    const ch = row.meta.channelId || "";
    const n = channelCount.get(ch) || 0;
    if (n >= cap) return false;
    channelCount.set(ch, n + 1);
    chosen.push(row);
    used.add(row.meta.videoId);
    return true;
  };

  // Exploitation: greedily take the top, channel-capped.
  const exploitTarget = Math.max(1, Math.round(limit * (1 - diversity.explorationRatio)));
  for (const row of ranked) {
    if (chosen.length >= exploitTarget) break;
    tryAdd(row);
  }
  // Exploration: pull from further down the ranking (evenly spaced, deterministic)
  // to add variety instead of 20 near-identical top hits.
  if (chosen.length < limit) {
    const remaining = ranked.filter((r) => !used.has(r.meta.videoId));
    const step = Math.max(1, Math.floor(remaining.length / Math.max(1, limit - chosen.length)));
    for (let i = 0; i < remaining.length && chosen.length < limit; i += step) {
      tryAdd(remaining[i]);
    }
    // Top up if channel caps left us short.
    for (const row of remaining) {
      if (chosen.length >= limit) break;
      if (!used.has(row.meta.videoId)) tryAdd(row);
    }
  }
  return chosen.slice(0, limit);
}

/**
 * Core pipeline shared by "next" and "suggested": produce a ranked, filtered,
 * diversified list for a seed. Returns [] on any inability to build one.
 */
async function buildRecommendations({
  userId,
  currentVideoId,
  sessionId,
  extraExclude = [],
  limit,
}) {
  if (!flags.enabled) return [];

  const seed = currentVideoId ? await metadata.getMetadata(currentVideoId) : null;
  if (!seed) return [];

  const profile = await interaction.buildUserProfile(userId);

  // Assemble the exclusion set: recently watched, suppressed, session picks,
  // and the caller-supplied recent-session ids (the frontend's own playedIds).
  const [recent, suppressed] = await Promise.all([
    interaction.getRecentlyWatchedIds(userId),
    interaction.getSuppressedIds(userId),
  ]);
  const excludeSet = new Set([
    ...recent,
    ...suppressed,
    ...sessionIds(sessionId),
    ...extraExclude,
  ]);
  // The current video is always excluded, but never treat the seed itself as
  // "recently watched" in a way that would empty the pool — that's handled by
  // the currentVideoId check in applyHardFilters, not the exclude set.
  excludeSet.delete(currentVideoId);

  const pool = await candidatesSvc.generateCandidates(seed, {
    recentSearches: profile.recentSearches,
  });
  const filtered = applyHardFilters(pool, { currentVideoId, excludeSet });
  if (!filtered.length) return [];

  const ranked = ranking.rank(seed, filtered, { userProfile: profile });
  // Collapse same-song re-uploads (spec §16) AND anything the user just heard
  // (breaks the same-song tunnel) before channel-diversity + limit.
  const recentSongs = await recentlyPlayedSongs([
    ...recent,
    ...sessionIds(sessionId),
    ...extraExclude,
  ]);
  const deduped = collapseNearDuplicates(seed, ranked, recentSongs);
  return applyDiversity(deduped, limit);
}

// ── public API (spec §23) ────────────────────────────────────────────────────

/** #2..N — the suggested-videos list for the current video. */
async function getSuggestedVideos({ userId, currentVideoId, limit = 20, exclude = [] }) {
  const rows = await buildRecommendations({
    userId,
    currentVideoId,
    extraExclude: exclude,
    limit,
  });
  return { currentVideoId, recommendations: rows.map(shape) };
}

/** #1 — the single best autoplay pick, with loop prevention. */
async function getNextVideo({ userId, currentVideoId, sessionId, exclude = [] }) {
  const rows = await buildRecommendations({
    userId,
    currentVideoId,
    sessionId,
    extraExclude: exclude,
    limit: 5, // rank a few, take the top; the rest cost nothing and aid diversity
  });
  const best = rows[0];
  if (!best) return { next: null };
  rememberPick(sessionId, best.meta.videoId); // so the next hop won't loop back
  return { next: shape(best) };
}

/**
 * Home / "For You" feed. Stage-1 lite: seed off the user's most recent
 * positively-engaged video (established user), or a broad popular search
 * (cold start). Full multi-shelf personalization ("Because you watched…",
 * "More from creators you like") is Stage 2.
 */
async function getHomeRecommendations({ userId, limit = 30 }) {
  const profile = await interaction.buildUserProfile(userId);

  if (profile.hasHistory) {
    // Newest positively-watched interaction as the seed.
    const history = await interaction.getUserInteractions(userId, { limit: 40 });
    const seedRow = history.find((r) => interaction.feedbackSignal(r) > 0.4) || history[0];
    if (seedRow) {
      const rows = await buildRecommendations({
        userId,
        currentVideoId: seedRow.videoId,
        limit,
      });
      if (rows.length) return { recommendations: rows.map(shape) };
    }
  }

  // Cold start / empty: broadly useful popular music (spec §11). Cheap and safe.
  if (youtube.hasApiKey()) {
    try {
      const ids = await youtube.searchVideoIds("popular music this week", { maxResults: limit });
      const metaMap = await metadata.getMany(ids);
      const metas = ids.map((id) => metaMap.get(id)).filter((m) => m && availabilityOk(m));
      return {
        recommendations: metas.slice(0, limit).map((m) =>
          shape({ meta: m, score: 0 }),
        ),
      };
    } catch {
      /* fall through to empty */
    }
  }
  return { recommendations: [] };
}

module.exports = {
  getSuggestedVideos,
  getNextVideo,
  getHomeRecommendations,
  // exported for tests
  _internal: {
    applyHardFilters,
    applyDiversity,
    availabilityOk,
    rememberPick,
    sessionIds,
    isNearDuplicate,
    collapseNearDuplicates,
  },
};
