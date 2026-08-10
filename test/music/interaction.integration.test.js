"use strict";

/**
 * DB-backed tests for the interaction service against the in-memory Mongo from
 * test/setup.js. Covers the accumulation/upsert behaviour, the suppression and
 * recency filters, and the profile aggregation that pure tests can't reach.
 */

const interaction = require("../../services/music/interaction.service");
const UserVideoInteraction = require("../../models/music/UserVideoInteraction");
const VideoMetadata = require("../../models/music/VideoMetadata");

const U = "E-test-user";

describe("interaction.record — accumulation & bounded growth", () => {
  test("repeated events collapse into one (user, video) row", async () => {
    await interaction.record(U, { videoId: "v1", channelId: "cA", event: "started", durationSeconds: 200 });
    await interaction.record(U, { videoId: "v1", channelId: "cA", event: "started", durationSeconds: 200 });
    const rows = await UserVideoInteraction.find({ userId: U, videoId: "v1" });
    expect(rows).toHaveLength(1);
    expect(rows[0].timesPlayed).toBe(2);
  });

  test("bestCompletionRate takes the max across progress events", async () => {
    await interaction.record(U, { videoId: "v2", event: "started", durationSeconds: 200 });
    await interaction.record(U, { videoId: "v2", event: "progress", watchedSeconds: 100, durationSeconds: 200 });
    await interaction.record(U, { videoId: "v2", event: "progress", watchedSeconds: 60, durationSeconds: 200 });
    const row = await UserVideoInteraction.findOne({ userId: U, videoId: "v2" });
    expect(row.bestCompletionRate).toBeCloseTo(0.5, 5);
  });

  test("ended at >=95% counts a completion", async () => {
    await interaction.record(U, { videoId: "v3", event: "started", durationSeconds: 200 });
    await interaction.record(U, { videoId: "v3", event: "ended", watchedSeconds: 200, durationSeconds: 200 });
    const row = await UserVideoInteraction.findOne({ userId: U, videoId: "v3" });
    expect(row.timesCompleted).toBe(1);
    expect(row.bestCompletionRate).toBeCloseTo(1, 5);
  });
});

describe("filters derived from interactions", () => {
  test("recently-watched ids include a just-played video", async () => {
    await interaction.record(U, { videoId: "vr", event: "started", durationSeconds: 200 });
    const ids = await interaction.getRecentlyWatchedIds(U, 6);
    expect(ids.has("vr")).toBe(true);
  });

  test("a repeatedly-skipped, barely-watched video is suppressed", async () => {
    for (let i = 0; i < 3; i++) {
      await interaction.record(U, { videoId: "vs", event: "skipped", durationSeconds: 200, watchedSeconds: 2 });
    }
    const suppressed = await interaction.getSuppressedIds(U);
    expect(suppressed.has("vs")).toBe(true);
  });

  test("a disliked video is suppressed", async () => {
    await interaction.record(U, { videoId: "vd", event: "disliked" });
    const suppressed = await interaction.getSuppressedIds(U);
    expect(suppressed.has("vd")).toBe(true);
  });
});

describe("buildUserProfile aggregation", () => {
  test("a completed play produces positive channel/tag/category affinity", async () => {
    await VideoMetadata.create({
      videoId: "vp",
      channelId: "cRock",
      channelTitle: "Rock Chan",
      tags: ["rock", "guitar"],
      categoryId: "10",
    });
    await interaction.record(U, { videoId: "vp", channelId: "cRock", event: "started", durationSeconds: 200 });
    await interaction.record(U, { videoId: "vp", event: "ended", watchedSeconds: 200, durationSeconds: 200 });

    const profile = await interaction.buildUserProfile(U);
    expect(profile.hasHistory).toBe(true);
    expect(profile.channelScores.get("cRock")).toBeGreaterThan(0);
    expect(profile.tagScores.get("rock")).toBeGreaterThan(0);
    expect(profile.categoryScores.get("10")).toBeGreaterThan(0);
    expect(profile.avgCompletion).toBeGreaterThan(0.9);
  });

  test("empty history yields a neutral profile", async () => {
    const profile = await interaction.buildUserProfile("nobody");
    expect(profile.hasHistory).toBe(false);
    expect(profile.channelScores.size).toBe(0);
  });
});
