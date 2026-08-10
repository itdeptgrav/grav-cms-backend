"use strict";

const mongoose = require("mongoose");

/**
 * Cached YouTube metadata for any video the engine has encountered — as a seed,
 * a candidate, or a played track. The point is to NOT re-hit the YouTube Data
 * API for the same video's title/tags/category every time it shows up in a
 * candidate pool (that is how quota gets burned). Freshness is judged by
 * `fetchedAt` against `ttl.videoMetadataMs` in the config, in the service layer
 * — the model just stores.
 *
 * `videoId` is the natural key and is unique. This collection is effectively a
 * cache, so it is safe to let entries age and be refreshed in place.
 */
const videoMetadataSchema = new mongoose.Schema(
  {
    videoId: { type: String, required: true },

    title: { type: String, default: "" },
    description: { type: String, default: "" },
    channelId: { type: String, default: "" },
    channelTitle: { type: String, default: "" },

    // From videos.list snippet.tags — the strongest cheap similarity signal.
    tags: { type: [String], default: [] },
    categoryId: { type: String, default: "" },
    // topicDetails.topicCategories when available (Wikipedia topic URLs),
    // reduced to labels. Absent for many videos — treated as optional.
    topicLabels: { type: [String], default: [] },

    durationSeconds: { type: Number, default: null },
    publishedAt: { type: Date, default: null },
    thumbnails: {
      // Store just the two sizes the UI uses, not YouTube's full ladder.
      small: { type: String, default: "" },
      medium: { type: String, default: "" },
    },

    language: { type: String, default: "" },
    viewCount: { type: Number, default: null },

    // Availability facts used by the hard filters. `embeddable === false` or a
    // non-"none" liveState makes a candidate unplayable in our iframe.
    embeddable: { type: Boolean, default: null },
    liveState: {
      type: String,
      enum: ["none", "live", "upcoming"],
      default: "none",
    },

    /**
     * Stage-3 semantic vector for this video's text representation. Left null in
     * Stage 1. Kept on the metadata doc (rather than a separate collection) so a
     * single read gives the ranker everything it needs; a dedicated
     * VideoEmbedding collection / Atlas vector index can be introduced later
     * without moving this field.
     */
    embedding: { type: [Number], default: null },
    embeddingModel: { type: String, default: "" },

    fetchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

videoMetadataSchema.index({ videoId: 1 }, { unique: true });
videoMetadataSchema.index({ channelId: 1 });
videoMetadataSchema.index({ categoryId: 1 });

// Guard against OverwriteModelError under jest / hot reload (a convention some
// existing models in this repo already follow).
module.exports =
  mongoose.models.VideoMetadata ||
  mongoose.model("VideoMetadata", videoMetadataSchema);
