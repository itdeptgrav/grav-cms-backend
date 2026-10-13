"use strict";

const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const { player } = require("../../services/music/ytdlpPlayer.service");
const { catalog } = require("../../services/music/ytMusicCatalog.service");
const { SECRET } = require("../../config/jwt");

const router = express.Router();

function streamToken(videoId, userId) {
  return jwt.sign(
    { purpose: "cms-music-stream", videoId, sub: String(userId || "") },
    SECRET,
    { expiresIn: "10m", audience: "cms-music", issuer: "grav-cms" },
  );
}

function verifyStreamToken(token, videoId) {
  const claims = jwt.verify(token, SECRET, { audience: "cms-music", issuer: "grav-cms" });
  if (claims.purpose !== "cms-music-stream" || claims.videoId !== videoId) throw new Error("Invalid music stream token");
  return claims;
}

function fail(res, error) {
  const badInput = ["INVALID_QUERY", "INVALID_VIDEO_ID"].includes(error?.code);
  const unavailable = ["YTDLP_NOT_CONFIGURED", "MUSIC_CATALOG_NOT_CONFIGURED"].includes(error?.code);
  const status = badInput ? 400 : unavailable ? 503 : 502;
  if (!badInput) console.error("[cms/music]", error);
  return res.status(status).json({
    success: false,
    code: error?.code || "MUSIC_SERVICE_FAILED",
    message: unavailable
      ? "Music search is waiting for its backend runtime to be configured."
      : error?.message || "Music service could not complete this request.",
  });
}

router.get("/stream/:videoId", async (req, res) => {
  try {
    verifyStreamToken(req.query.token, req.params.videoId);
    const stream = await player.resolve(req.params.videoId);
    const upstream = await axios.get(stream.streamUrl, {
      responseType: "stream",
      timeout: 60_000,
      maxRedirects: 5,
      headers: req.headers.range ? { Range: req.headers.range } : {},
      validateStatus: (status) => status === 200 || status === 206,
    });
    res.status(upstream.status);
    for (const header of ["content-type", "content-length", "content-range", "accept-ranges"]) {
      if (upstream.headers[header]) res.set(header, upstream.headers[header]);
    }
    res.set("Cache-Control", "private, no-store");
    upstream.data.on("error", () => res.destroy());
    req.on("close", () => upstream.data.destroy());
    upstream.data.pipe(res);
  } catch (error) {
    if (error?.name === "JsonWebTokenError" || error?.name === "TokenExpiredError" || /stream token/i.test(error?.message || "")) {
      return res.status(401).json({ success: false, code: "INVALID_STREAM_TOKEN", message: "This music link has expired." });
    }
    return fail(res, error);
  }
});

router.use(EmployeeAuthMiddleware);

router.get("/health", async (_req, res) => {
  const [playback, search] = await Promise.all([player.health(), catalog.health()]);
  res.json({ success: true, data: { available: playback.available && search.available, playback, search } });
});

router.get("/search", async (req, res) => {
  try {
    const tracks = await catalog.search(req.query.q, { limit: req.query.limit });
    res.json({ success: true, data: { tracks } });
  } catch (error) {
    fail(res, error);
  }
});

router.post("/resolve", express.json({ limit: "2kb" }), async (req, res) => {
  try {
    const stream = await player.resolve(req.body?.videoId);
    const token = streamToken(stream.track.id, req.user.id || req.user.employeeId);
    res.set("Cache-Control", "private, no-store");
    res.json({
      success: true,
      data: {
        streamPath: `/api/cms/music/stream/${stream.track.id}?token=${encodeURIComponent(token)}`,
        contentType: stream.contentType,
        expiresAt: stream.expiresAt,
        track: stream.track,
      },
    });
  } catch (error) {
    fail(res, error);
  }
});

module.exports = router;
module.exports.helpers = { streamToken, verifyStreamToken };
