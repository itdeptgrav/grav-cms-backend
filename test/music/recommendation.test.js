"use strict";

/**
 * Unit tests for the recommendation engine's pure logic — ranking, filters,
 * diversity, implicit feedback, candidate concepts, and loop prevention. No DB
 * or network (those paths are covered in interaction.integration.test.js). They
 * cover the behaviors the spec (§25) calls out as must-test.
 */

const text = require("../../services/music/text.util");
const ranking = require("../../services/music/ranking.service");
const interaction = require("../../services/music/interaction.service");
const candidates = require("../../services/music/candidates.service");
const recommendation = require("../../services/music/recommendation.service");

const { deriveConcepts, creatorFromTitle } = candidates._internal;
const {
  applyHardFilters,
  applyDiversity,
  availabilityOk,
  rememberPick,
  sessionIds,
  isNearDuplicate,
  collapseNearDuplicates,
} = recommendation._internal;
const { completionBehavior } = ranking._internal;

function meta(over = {}) {
  return {
    videoId: "v",
    title: "Song",
    description: "",
    channelId: "c",
    channelTitle: "Chan",
    tags: [],
    topicLabels: [],
    categoryId: "10",
    durationSeconds: 200,
    publishedAt: new Date(),
    thumbnails: { small: "", medium: "" },
    viewCount: 100,
    embeddable: true,
    liveState: "none",
    ...over,
  };
}

describe("text similarity", () => {
  test("cosine is 1 for identical bags, 0 for disjoint", () => {
    const a = text.tokenize("arijit singh tum hi ho");
    expect(text.cosineSim(a, a)).toBeCloseTo(1, 5);
    expect(text.cosineSim(text.tokenize("hello world"), text.tokenize("foo bar"))).toBe(0);
  });
  test("shared words produce partial similarity", () => {
    const s = text.cosineSim(
      text.tokenize("arijit singh tum hi ho"),
      text.tokenize("arijit singh best songs"),
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
  test("jaccard overlap", () => {
    expect(text.jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
  });
});

describe("candidate concept derivation", () => {
  test("derives 'Artist' and 'Artist songs' from an 'Artist - Title' seed", () => {
    const concepts = deriveConcepts(
      meta({ title: "Arijit Singh - Tum Hi Ho", channelTitle: "T-Series", tags: ["bollywood"] }),
    );
    expect(concepts).toContain("Arijit Singh songs");
    expect(concepts).toContain("Arijit Singh");
  });
  test("creatorFromTitle handles the dash split and its absence", () => {
    expect(creatorFromTitle("Arijit Singh - Tum Hi Ho")).toBe("Arijit Singh");
    expect(creatorFromTitle("No Dash Here")).toBeNull();
  });
});

describe("implicit feedback signal", () => {
  test("high completion is a strong positive", () => {
    expect(interaction.feedbackSignal({ bestCompletionRate: 0.96 })).toBe(1.0);
    expect(interaction.feedbackSignal({ bestCompletionRate: 0.85 })).toBe(0.8);
  });
  test("watching under 20% is negative", () => {
    expect(interaction.feedbackSignal({ bestCompletionRate: 0.1 })).toBe(-0.6);
  });
  test("a quick skip is a strong negative", () => {
    const s = interaction.feedbackSignal({
      timesSkipped: 1,
      bestCompletionRate: 0.05,
      durationSeconds: 200,
      totalWatchedSeconds: 5,
    });
    expect(s).toBeLessThanOrEqual(-0.8);
  });
  test("explicit like / dislike override behaviour", () => {
    expect(interaction.feedbackSignal({ liked: true, bestCompletionRate: 0 })).toBe(1.0);
    expect(interaction.feedbackSignal({ disliked: true, bestCompletionRate: 0.99 })).toBe(-1.0);
  });
});

describe("hard filters", () => {
  const pool = [
    meta({ videoId: "current" }),
    meta({ videoId: "A", channelId: "cA" }),
    meta({ videoId: "A", channelId: "cA" }),
    meta({ videoId: "B", embeddable: false }),
    meta({ videoId: "C", liveState: "live" }),
    meta({ videoId: "D" }),
    meta({ videoId: "E", channelId: "cE" }),
  ];
  test("removes current video, dedupes, drops unavailable, honours exclude set", () => {
    const out = applyHardFilters(pool, {
      currentVideoId: "current",
      excludeSet: new Set(["D"]),
    });
    expect(out.map((m) => m.videoId)).toEqual(["A", "E"]);
  });
  test("availabilityOk rejects non-embeddable and live", () => {
    expect(availabilityOk(meta())).toBe(true);
    expect(availabilityOk(meta({ embeddable: false }))).toBe(false);
    expect(availabilityOk(meta({ liveState: "upcoming" }))).toBe(false);
  });
});

describe("ranking", () => {
  const seed = meta({ videoId: "seed", title: "Love Song", channelId: "cSeed", tags: ["romantic"] });

  test("scores are normalized to [0,1], sorted desc, top = 1", () => {
    const out = ranking.rank(seed, [
      meta({ videoId: "A", title: "Love Song", tags: ["romantic"], channelId: "c1" }),
      meta({ videoId: "B", title: "Death Metal", tags: ["metal"], channelId: "c2" }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].score).toBeCloseTo(1, 5);
    for (const r of out) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
    expect(out[0].score).toBeGreaterThanOrEqual(out[1].score);
  });

  test("liked-creator boost: same content, loved channel ranks first", () => {
    const profile = {
      channelScores: new Map([["cLoved", 5]]),
      tagScores: new Map(),
      categoryScores: new Map(),
      avgCompletion: 0,
    };
    const out = ranking.rank(
      seed,
      [
        meta({ videoId: "A", title: "Love Song", tags: ["romantic"], channelId: "cNeutral" }),
        meta({ videoId: "B", title: "Love Song", tags: ["romantic"], channelId: "cLoved" }),
      ],
      { userProfile: profile },
    );
    expect(out[0].meta.videoId).toBe("B");
  });

  test("cold start: ranking works with no user profile", () => {
    const out = ranking.rank(seed, [meta({ videoId: "A" }), meta({ videoId: "B" })]);
    expect(out).toHaveLength(2);
    expect(out.every((r) => Number.isFinite(r.score))).toBe(true);
  });

  test("completion-behavior signal rises with the user's avg completion", () => {
    const hi = completionBehavior(meta(), { categoryScores: new Map(), avgCompletion: 0.9 });
    const lo = completionBehavior(meta(), { categoryScores: new Map(), avgCompletion: 0.2 });
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("diversity", () => {
  test("caps how many results share one channel", () => {
    const ranked = Array.from({ length: 10 }, (_, i) => ({
      meta: meta({ videoId: `v${i}`, channelId: "sameChannel" }),
      score: 1 - i * 0.05,
    }));
    const out = applyDiversity(ranked, 10);
    expect(out.length).toBeLessThanOrEqual(3);
    expect(out.every((r) => r.meta.channelId === "sameChannel")).toBe(true);
  });
  test("keeps variety across channels", () => {
    const ranked = [
      { meta: meta({ videoId: "a1", channelId: "cA" }), score: 0.9 },
      { meta: meta({ videoId: "a2", channelId: "cA" }), score: 0.8 },
      { meta: meta({ videoId: "b1", channelId: "cB" }), score: 0.7 },
      { meta: meta({ videoId: "c1", channelId: "cC" }), score: 0.6 },
    ];
    const out = applyDiversity(ranked, 4);
    expect(new Set(out.map((r) => r.meta.channelId)).size).toBeGreaterThanOrEqual(2);
  });
});

describe("same-song / near-duplicate suppression", () => {
  const seed = meta({
    videoId: "seed",
    title: "Arijit Singh - Tujhko (from Cocktail 2) | Love Song 2026",
    durationSeconds: 210,
  });

  test("a re-upload of the seed song is flagged as a near-duplicate", () => {
    const reupload = meta({
      videoId: "dup",
      title: "Tujhko (Video) Arijit Singh | Cocktail 2",
      durationSeconds: 211,
    });
    expect(isNearDuplicate(seed, reupload)).toBe(true);
    expect(isNearDuplicate(seed, meta({ title: "Kesariya - Brahmastra", durationSeconds: 240 }))).toBe(
      false,
    );
  });

  test("collapse drops seed re-uploads and keeps one per cluster", () => {
    const ranked = [
      { meta: meta({ videoId: "dup1", title: "Tujhko Arijit Singh Cocktail 2", durationSeconds: 210 }), score: 1 },
      { meta: meta({ videoId: "dup2", title: "Tujhko (Lyrics) Arijit Singh Cocktail 2", durationSeconds: 210 }), score: 0.9 },
      // The "Song - Lyrics | credits" shape that fools the Artist-Song split;
      // caught by seed song-word containment instead.
      { meta: meta({ videoId: "dup3", title: "Tujhko - Lyrics | Arijit Singh, Sunidhi Chauhan", durationSeconds: 205 }), score: 0.85 },
      { meta: meta({ videoId: "other", title: "Mashooqa Arijit Singh Cocktail 2", durationSeconds: 250 }), score: 0.8 },
    ];
    const out = collapseNearDuplicates(seed, ranked);
    const ids = out.map((r) => r.meta.videoId);
    expect(ids).not.toContain("dup1"); // same song as the seed
    expect(ids).not.toContain("dup2");
    expect(ids).not.toContain("dup3"); // containment path
    expect(ids).toContain("other"); // a genuinely different track survives
  });
});

describe("autoplay loop prevention", () => {
  test("remembered picks are reported and bounded per session", () => {
    const sid = "sessionX";
    rememberPick(sid, "v1");
    rememberPick(sid, "v2");
    expect(sessionIds(sid)[0]).toBe("v2");
    expect(sessionIds(sid)).toContain("v1");
    for (let i = 0; i < 40; i++) rememberPick(sid, `x${i}`);
    expect(sessionIds(sid).length).toBeLessThanOrEqual(25);
  });
});
