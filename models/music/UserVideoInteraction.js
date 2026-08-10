"use strict";

const mongoose = require("mongoose");

/**
 * One document per (userId, videoId) — NOT one per play event. This is the
 * deliberate bounded-growth choice from the implementation note: a user who
 * replays a song 40 times produces one row with `timesPlayed: 40`, not 40 rows.
 * It also happens to be exactly the shape the ranker wants — "what is this
 * user's standing relationship with this video / its channel" — so no
 * aggregation step is needed at read time.
 *
 * `userId` is the Cowork `employeeId` string (== Mongo `Employee.biometricId`,
 * e.g. "E014"), taken from `req.coworkUser.employeeId`. Per-session detail
 * (this-session watch %, this-session skips) is not persisted here; the session
 * profile is an in-memory / request-scoped concern (Stage 2), and long-term
 * signal is what lives in Mongo.
 */
const userVideoInteractionSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    videoId: { type: String, required: true },
    channelId: { type: String, default: "" },

    // Best (max) completion this user has reached on this video. Max rather than
    // last, because a single full listen is a positive signal even if a later
    // partial replay dipped the average.
    bestCompletionRate: { type: Number, default: 0 }, // 0..1
    totalWatchedSeconds: { type: Number, default: 0 },
    durationSeconds: { type: Number, default: null },

    // Counters accumulated across events.
    timesPlayed: { type: Number, default: 0 },
    timesCompleted: { type: Number, default: 0 }, // reached >= 95%
    timesSkipped: { type: Number, default: 0 }, // bailed early
    timesReplayed: { type: Number, default: 0 },
    clickedFromRecommendation: { type: Number, default: 0 },

    // Explicit feedback — last known state, not a counter.
    liked: { type: Boolean, default: false },
    disliked: { type: Boolean, default: false },

    // The search query (if any) that led to this video being played. Kept as a
    // small set of distinct queries — a valuable current-interest signal
    // (spec §18) without a second collection.
    searchQueries: { type: [String], default: [] },

    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    lastWatchedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

// The hot read path is "all interactions for this user", often filtered by
// recency or channel — so compound indexes lead with userId.
userVideoInteractionSchema.index({ userId: 1, videoId: 1 }, { unique: true });
userVideoInteractionSchema.index({ userId: 1, lastWatchedAt: -1 });
userVideoInteractionSchema.index({ userId: 1, channelId: 1 });

module.exports =
  mongoose.models.UserVideoInteraction ||
  mongoose.model("UserVideoInteraction", userVideoInteractionSchema);
