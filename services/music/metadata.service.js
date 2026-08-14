"use strict";

const VideoMetadata = require("../../models/music/VideoMetadata");
const youtube = require("./youtube.service");
const { ttl } = require("./recommendation.config");

/**
 * Get-or-fetch video metadata, backed by the `videometadatas` Mongo cache.
 *
 * The rule (spec §2): never re-request metadata from YouTube if a fresh cached
 * copy exists. "Fresh" = fetched within `ttl.videoMetadataMs`. Stale or missing
 * ids are fetched from YouTube in one batched `videos.list` call and upserted.
 *
 * Everything returns plain metadata objects (lean docs / normalized YouTube
 * rows), never Mongoose documents, so callers can treat them uniformly.
 */

function isFresh(doc) {
  if (!doc || !doc.fetchedAt) return false;
  return Date.now() - new Date(doc.fetchedAt).getTime() < ttl.videoMetadataMs;
}

async function upsert(meta) {
  if (!meta || !meta.videoId) return null;
  const doc = { ...meta, fetchedAt: new Date() };
  await VideoMetadata.updateOne(
    { videoId: meta.videoId },
    { $set: doc },
    { upsert: true },
  );
  return doc;
}

/**
 * Metadata for many ids at once. Serves fresh ones from Mongo, fetches the rest
 * from YouTube, upserts them, and returns a Map(videoId -> meta). Ids that come
 * back from neither (deleted/private) are simply absent from the map — that IS
 * the availability signal the hard filters use.
 */
async function getMany(ids) {
  const wanted = [...new Set((ids || []).filter(Boolean))];
  const result = new Map();
  if (!wanted.length) return result;

  const cached = await VideoMetadata.find({ videoId: { $in: wanted } }).lean();
  const cachedById = new Map(cached.map((d) => [d.videoId, d]));

  const stale = [];
  for (const id of wanted) {
    const doc = cachedById.get(id);
    if (doc && isFresh(doc)) {
      result.set(id, doc);
    } else {
      stale.push(id);
    }
  }

  if (stale.length && youtube.hasApiKey()) {
    let fetched = [];
    try {
      fetched = await youtube.videoDetails(stale);
    } catch {
      // On a YouTube failure, fall back to any stale cached copy rather than
      // dropping the video entirely — a slightly old title beats no candidate.
      for (const id of stale) {
        const old = cachedById.get(id);
        if (old) result.set(id, old);
      }
      return result;
    }
    const fetchedById = new Map(fetched.map((m) => [m.videoId, m]));
    await Promise.all(fetched.map((m) => upsert(m)));
    for (const id of stale) {
      const m = fetchedById.get(id);
      if (m) result.set(id, { ...m, fetchedAt: new Date() });
      else {
        // YouTube didn't return it. If we have a stale copy, keep it; otherwise
        // it's genuinely gone.
        const old = cachedById.get(id);
        if (old) result.set(id, old);
      }
    }
  } else if (stale.length) {
    // No API key: serve whatever we have cached, even if stale.
    for (const id of stale) {
      const old = cachedById.get(id);
      if (old) result.set(id, old);
    }
  }

  return result;
}

async function getMetadata(videoId) {
  const map = await getMany([videoId]);
  return map.get(videoId) || null;
}

module.exports = { getMetadata, getMany, upsert, isFresh };
