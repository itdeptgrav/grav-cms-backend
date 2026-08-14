"use strict";

const axios = require("axios");
const { ttl, quota } = require("./recommendation.config");

/**
 * The one place the backend talks to the YouTube Data API v3, and the one place
 * `YOUTUBE_API_KEY` is read. Everything else (candidates, metadata) goes
 * through here so caching and quota accounting are centralized (spec §19).
 *
 * The key is server-side only and never returned to a caller. Callers get
 * normalized objects, not raw YouTube JSON.
 *
 * Three quota disciplines, all here:
 *   1. In-memory TTL cache — a repeated search or details fetch inside the TTL
 *      window costs zero units.
 *   2. Request coalescing — N concurrent identical calls share one HTTP request
 *      (an autoplay burst won't fire the same search five times).
 *   3. A soft daily budget — once the day's units are spent, calls throw a
 *      quota error rather than hammering an exhausted project quota.
 */

const API = "https://www.googleapis.com/youtube/v3";
const REQUEST_TIMEOUT_MS = 6000;

function apiKey() {
  return process.env.YOUTUBE_API_KEY || "";
}
function hasApiKey() {
  return !!apiKey();
}

// ── quota accounting (per calendar day, in-process) ──────────────────────────
let spent = 0;
let quotaDay = null; // yyyy-mm-dd of the window `spent` belongs to

function today() {
  return new Date().toISOString().slice(0, 10);
}
function rollQuotaWindow() {
  const d = today();
  if (quotaDay !== d) {
    quotaDay = d;
    spent = 0;
  }
}
function charge(units) {
  rollQuotaWindow();
  if (spent + units > quota.dailyUnits) {
    const err = new Error("YouTube API daily quota budget exhausted");
    err.code = "QUOTA_EXHAUSTED";
    throw err;
  }
  spent += units;
}
function quotaStatus() {
  rollQuotaWindow();
  return { spent, budget: quota.dailyUnits, remaining: quota.dailyUnits - spent };
}

// ── tiny TTL cache + in-flight coalescing ────────────────────────────────────
const cache = new Map(); // key -> { value, expires }
const inflight = new Map(); // key -> Promise

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}
function cacheSet(key, value, ttlMs) {
  cache.set(key, { value, expires: Date.now() + ttlMs });
}

/**
 * Run `fn` once for a given cache key even under concurrent callers, cache its
 * result for `ttlMs`, and serve subsequent callers from cache.
 */
async function coalesce(key, ttlMs, fn) {
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      cacheSet(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

// ── normalization ────────────────────────────────────────────────────────────

/** ISO-8601 duration (e.g. "PT3M12S") -> seconds, or null. */
function parseDuration(iso) {
  if (!iso) return null;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return null;
  const [, h, mn, s] = m;
  return (Number(h) || 0) * 3600 + (Number(mn) || 0) * 60 + (Number(s) || 0);
}

/** topicDetails.topicCategories are Wikipedia URLs; reduce to readable labels. */
function topicLabels(topicCategories) {
  if (!Array.isArray(topicCategories)) return [];
  return topicCategories
    .map((u) => {
      try {
        return decodeURIComponent(String(u).split("/").pop()).replace(/_/g, " ");
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

/** Normalize one `videos.list` item into our VideoMetadata shape. */
function normalizeVideo(item) {
  const sn = item.snippet || {};
  const cd = item.contentDetails || {};
  const st = item.status || {};
  const stat = item.statistics || {};
  const th = sn.thumbnails || {};
  const live = sn.liveBroadcastContent;
  return {
    videoId: item.id,
    title: sn.title || "",
    description: sn.description || "",
    channelId: sn.channelId || "",
    channelTitle: sn.channelTitle || "",
    tags: Array.isArray(sn.tags) ? sn.tags : [],
    categoryId: sn.categoryId || "",
    topicLabels: topicLabels((item.topicDetails || {}).topicCategories),
    durationSeconds: parseDuration(cd.duration),
    publishedAt: sn.publishedAt ? new Date(sn.publishedAt) : null,
    thumbnails: {
      small: (th.default && th.default.url) || (th.medium && th.medium.url) || "",
      medium: (th.medium && th.medium.url) || (th.high && th.high.url) || "",
    },
    language: sn.defaultAudioLanguage || sn.defaultLanguage || "",
    viewCount: stat.viewCount != null ? Number(stat.viewCount) : null,
    embeddable: st.embeddable != null ? !!st.embeddable : null,
    liveState: live === "live" ? "live" : live === "upcoming" ? "upcoming" : "none",
  };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * search.list for music. Returns an array of video ids (cheap — details are
 * fetched separately and cached hard, per YouTube's own recommended two-step).
 * Music is scoped with videoCategoryId=10 + videoEmbeddable=true so we don't
 * pay to rank things we can't play.
 */
async function searchVideoIds(query, { maxResults = 25 } = {}) {
  if (!hasApiKey()) {
    const err = new Error("YOUTUBE_API_KEY is not configured");
    err.code = "NO_API_KEY";
    throw err;
  }
  const q = String(query || "").trim();
  if (!q) return [];
  const key = `search:${maxResults}:${q.toLowerCase()}`;
  return coalesce(key, ttl.searchMs, async () => {
    charge(quota.costSearch);
    const { data } = await axios.get(`${API}/search`, {
      timeout: REQUEST_TIMEOUT_MS,
      params: {
        key: apiKey(),
        part: "snippet",
        type: "video",
        videoCategoryId: "10",
        videoEmbeddable: "true",
        maxResults: Math.min(50, Math.max(1, maxResults)),
        q,
      },
    });
    return (data.items || [])
      .map((it) => (it.id && it.id.videoId) || "")
      .filter(Boolean);
  });
}

/**
 * videos.list for a batch of ids (YouTube allows up to 50 per call, 1 unit).
 * Returns normalized metadata objects. Missing/private/deleted ids simply don't
 * come back — that's how the caller learns a candidate is unavailable.
 */
async function videoDetails(ids) {
  if (!hasApiKey()) {
    const err = new Error("YOUTUBE_API_KEY is not configured");
    err.code = "NO_API_KEY";
    throw err;
  }
  const unique = [...new Set((ids || []).filter(Boolean))];
  if (!unique.length) return [];
  const out = [];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const key = `videos:${batch.slice().sort().join(",")}`;
    const rows = await coalesce(key, ttl.videoMetadataMs, async () => {
      charge(quota.costList);
      const { data } = await axios.get(`${API}/videos`, {
        timeout: REQUEST_TIMEOUT_MS,
        params: {
          key: apiKey(),
          part: "snippet,contentDetails,status,statistics,topicDetails",
          id: batch.join(","),
          maxResults: 50,
        },
      });
      return (data.items || []).map(normalizeVideo);
    });
    out.push(...rows);
  }
  return out;
}

module.exports = {
  searchVideoIds,
  videoDetails,
  quotaStatus,
  hasApiKey,
  // exported for tests
  _internal: { parseDuration, topicLabels, normalizeVideo },
};
