"use strict";

const youtube = require("./youtube.service");
const metadata = require("./metadata.service");
const text = require("./text.util");
const { candidates: cfg, ttl } = require("./recommendation.config");

/**
 * Candidate generation — the answer to "YouTube removed the related-video API".
 * Instead of asking YouTube what's related, we derive several search *concepts*
 * from the seed video's own metadata, run those searches ourselves, and pool
 * the results. Ranking happens later; this stage only assembles a broad,
 * deduplicated pool (spec §3, 50–200 items).
 *
 * The derivation is generic — it reads title/creator/tags/topic, not a
 * music-specific rulebook — so it degrades sensibly for any content: a
 * programming channel yields the channel + its tags, a news clip yields its
 * topic labels, and so on.
 */

// Channel titles carry noise that hurts as a search term: YouTube's auto-topic
// channels ("… - Topic"), VEVO, and "Official". Strip them.
function cleanCreator(channelTitle) {
  return String(channelTitle || "")
    .replace(/\s*-\s*topic$/i, "")
    .replace(/\bvevo\b/i, "")
    .replace(/\bofficial\b/i, "")
    .trim();
}

// "Artist - Song Title (Official Video)" is the dominant music title shape; the
// left of the first dash is usually the creator/artist. Returns null when there
// is no such split, so non-music titles don't get a bogus "artist".
function creatorFromTitle(title) {
  const t = String(title || "");
  const idx = t.indexOf(" - ");
  if (idx <= 0) return null;
  const left = t.slice(0, idx).trim();
  // Guard against a leading dash-phrase that's actually the song ("Live - ...").
  if (left.length < 2 || left.length > 60) return null;
  return left;
}

/**
 * Derive up to `maxSearchConcepts` distinct search strings from a seed video
 * (and optional user-interest hints). Ordered by usefulness; deduped
 * case-insensitively.
 */
function deriveConcepts(seed, userHints = {}) {
  const out = [];
  const push = (s) => {
    const v = String(s || "").trim();
    if (v) out.push(v);
  };

  const creatorTitle = creatorFromTitle(seed.title);
  const creatorChannel = cleanCreator(seed.channelTitle);

  // 1. Creator affinity — "more from this artist/creator" is the single most
  //    reliable relatedness signal we can build ourselves.
  if (creatorTitle) {
    push(`${creatorTitle} songs`);
    push(creatorTitle);
  }
  if (creatorChannel && creatorChannel.toLowerCase() !== (creatorTitle || "").toLowerCase()) {
    push(creatorChannel);
  }

  // 2. Tags — the uploader's own keywords. Strongest topical signal.
  for (const tag of (seed.tags || []).slice(0, 3)) push(tag);

  // 3. Topic labels (Wikipedia topic categories) — genre/subject.
  for (const topic of (seed.topicLabels || []).slice(0, 2)) push(topic);

  // 4. User's recent searches — current-interest signal (spec §18).
  for (const q of (userHints.recentSearches || []).slice(0, 2)) push(q);

  // 5. Last resort: the meaningful words of the title itself.
  const titleWords = text.tokenize(seed.title).slice(0, 4).join(" ");
  push(titleWords);

  // Dedupe case-insensitively, preserve order, cap.
  const seen = new Set();
  const concepts = [];
  for (const c of out) {
    const k = c.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    concepts.push(c);
    if (concepts.length >= cfg.maxSearchConcepts) break;
  }
  return concepts;
}

// A tiny in-memory pool cache keyed by seed video id. Autoplay + a 50–70%
// prefetch will ask for the same seed's pool within minutes; this avoids
// re-running several searches each time. Bounded by TTL only (the map is small
// — one entry per recently-seeded video).
const poolCache = new Map(); // seedId -> { ids, expires }

function cachedPool(seedId) {
  const hit = poolCache.get(seedId);
  if (!hit || hit.expires < Date.now()) {
    poolCache.delete(seedId);
    return null;
  }
  return hit.ids;
}

/**
 * Build a candidate pool for a seed video. Returns an array of candidate
 * metadata objects (seed excluded, availability-fetched). May be smaller than
 * `minPool` when searches are thin or the API key is absent — the caller's
 * fallbacks handle that.
 */
async function generateCandidates(seed, userHints = {}) {
  if (!seed || !seed.videoId) return [];

  let ids = cachedPool(seed.videoId);

  if (!ids) {
    const concepts = deriveConcepts(seed, userHints);
    const collected = [];
    // Run concept searches. Sequential-ish is fine (searches are cached and
    // coalesced), but fire them together for latency; failures are per-concept.
    const results = await Promise.allSettled(
      concepts.map((q) =>
        youtube.searchVideoIds(q, { maxResults: cfg.perConceptResults }),
      ),
    );
    for (const r of results) {
      if (r.status === "fulfilled") collected.push(...r.value);
    }
    // Dedupe, drop the seed, cap the pool.
    ids = [...new Set(collected)].filter((id) => id !== seed.videoId).slice(0, cfg.maxPool);
    poolCache.set(seed.videoId, { ids, expires: Date.now() + ttl.candidatePoolMs });
  }

  if (!ids.length) return [];
  const metaMap = await metadata.getMany(ids);
  // Preserve pool order; only keep ids we actually have playable metadata for.
  return ids.map((id) => metaMap.get(id)).filter(Boolean);
}

module.exports = {
  generateCandidates,
  // exported for tests
  _internal: { deriveConcepts, cleanCreator, creatorFromTitle },
};
