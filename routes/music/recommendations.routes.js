"use strict";

/**
 * Music recommendation + interaction endpoints for the Cowork app.
 *
 * Mounted in server.js:  app.use("/cowork/music", require("./routes/music/recommendations.routes"))
 *
 * All routes are Cowork-authed (Firebase token → `req.coworkUser`). The user
 * key throughout is `req.coworkUser.employeeId` (== Mongo Employee.biometricId).
 *
 *   GET  /cowork/music/recommendations/next?videoId=&sessionId=&exclude=a,b
 *   GET  /cowork/music/recommendations/videos/:videoId?limit=&exclude=a,b
 *   GET  /cowork/music/recommendations/home?limit=
 *   POST /cowork/music/interactions
 *
 * Design rule: reads never 500 into the client on an engine hiccup — they
 * return an empty result and the frontend falls back to its local autoplay.
 * Only genuinely bad input (missing videoId) is a 400.
 */

const express = require("express");
const router = express.Router();
const {
  verifyCoworkToken,
  verifyEmployeeToken,
} = require("../../Middlewear/coworkAuth");
const recommendation = require("../../services/music/recommendation.service");
const interaction = require("../../services/music/interaction.service");

const auth = [verifyCoworkToken, verifyEmployeeToken];

function parseExclude(q) {
  if (!q) return [];
  return String(q)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// #1 — best next video for autoplay.
router.get("/recommendations/next", auth, async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) return res.status(400).json({ error: "videoId is required" });
  try {
    const result = await recommendation.getNextVideo({
      userId: req.coworkUser.employeeId,
      currentVideoId: videoId,
      sessionId: req.query.sessionId || "",
      exclude: parseExclude(req.query.exclude),
    });
    res.json(result);
  } catch (e) {
    console.error("[music/recommendations/next]", e.message);
    res.json({ next: null }); // fail soft — frontend has a local fallback
  }
});

// #2..N — suggested videos list.
router.get("/recommendations/videos/:videoId", auth, async (req, res) => {
  const { videoId } = req.params;
  if (!videoId) return res.status(400).json({ error: "videoId is required" });
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  try {
    const result = await recommendation.getSuggestedVideos({
      userId: req.coworkUser.employeeId,
      currentVideoId: videoId,
      limit,
      exclude: parseExclude(req.query.exclude),
    });
    res.json(result);
  } catch (e) {
    console.error("[music/recommendations/videos]", e.message);
    res.json({ currentVideoId: videoId, recommendations: [] });
  }
});

// Home / "For You" feed.
router.get("/recommendations/home", auth, async (req, res) => {
  const limit = Math.min(60, Math.max(1, parseInt(req.query.limit, 10) || 30));
  try {
    const result = await recommendation.getHomeRecommendations({
      userId: req.coworkUser.employeeId,
      limit,
    });
    res.json(result);
  } catch (e) {
    console.error("[music/recommendations/home]", e.message);
    res.json({ recommendations: [] });
  }
});

// Record an interaction checkpoint / explicit action.
router.post("/interactions", auth, async (req, res) => {
  const body = req.body || {};
  if (!body.videoId || !body.event) {
    return res.status(400).json({ error: "videoId and event are required" });
  }
  try {
    await interaction.record(req.coworkUser.employeeId, {
      videoId: body.videoId,
      channelId: body.channelId,
      event: body.event,
      watchedSeconds: Number(body.watchedSeconds) || 0,
      durationSeconds: Number(body.durationSeconds) || null,
      clickedFromRecommendation: !!body.clickedFromRecommendation,
      searchQuery: body.searchQuery,
      sessionId: body.sessionId,
    });
    res.json({ success: true });
  } catch (e) {
    console.error("[music/interactions]", e.message);
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
