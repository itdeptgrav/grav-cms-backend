// routes/cctv.js
//
// CCTV streaming API, served from inside the CMS backend (no separate server).
// Mounted at /api/cctv behind cctvAuth. The browser player calls:
//   POST /cameras/:id/watch      -> { sessionId, status }   (starts the worker)
//   POST /cameras/:id/heartbeat  -> { ok }
//   POST /cameras/:id/unwatch    -> { ok }                  (also accepts beacon)
//   GET  /hls/:id/:subtype/index.m3u8 | segN.ts             (HLS manifest/segments)
//   GET  /cameras | /status | /health

const express = require("express");
const path = require("path");
const fs = require("fs");

const manager = require("../services/cctv/manager");
const {
  getCamera, outputDirFor, ffmpegAvailable, ffmpegVersion, resolveFfmpegPath,
} = require("../services/cctv/config");

const router = express.Router();

const SAFE_NAME = /^[\w-]+\.(m3u8|ts)$/;

/* ── camera list + status ─────────────────────────────────────────────── */
router.get("/cameras", (req, res) => {
  res.json({ success: true, cameras: manager.getCameraViews() });
});

router.get("/status", (req, res) => {
  res.json({ success: true, ...manager.getSystemStatus() });
});

router.get("/health", (req, res) => {
  res.json({
    success: true,
    ffmpeg: { available: ffmpegAvailable(), path: resolveFfmpegPath(), version: ffmpegVersion() },
    ...manager.getSystemStatus(),
  });
});

/* ── watch lifecycle ──────────────────────────────────────────────────── */
router.post("/cameras/:id/watch", (req, res) => {
  const id = Number(req.params.id);
  if (!getCamera(id)) return res.status(404).json({ success: false, message: "No such camera" });
  const subtype = req.body?.subtype === 0 ? 0 : 1;
  const out = manager.watch(id, subtype);
  if (!out) return res.status(404).json({ success: false, message: "No such camera" });
  res.json({ success: true, ...out });
});

router.post("/cameras/:id/heartbeat", (req, res) => {
  const sessionId = req.body?.sessionId || req.query.sessionId;
  res.json({ success: true, ok: manager.heartbeat(sessionId) });
});

// sessionId comes in the query string so navigator.sendBeacon (tab close, no
// JSON body) works; also accept it from a JSON body as a fallback.
router.post("/cameras/:id/unwatch", (req, res) => {
  const sessionId = req.query.sessionId || req.body?.sessionId;
  res.json({ success: true, ok: manager.unwatch(sessionId) });
});

/* ── HLS manifest + segments ──────────────────────────────────────────── */
router.get("/hls/:id/:subtype/:file", (req, res) => {
  const cameraId = Number(req.params.id);
  if (!getCamera(cameraId)) return res.status(404).send("Not found");

  const subtype = req.params.subtype;
  if (subtype !== "0" && subtype !== "1") return res.status(404).send("Not found");

  const filename = req.params.file;
  if (!SAFE_NAME.test(filename)) return res.status(400).send("Bad request");

  const dir = path.resolve(outputDirFor(cameraId, subtype));
  const filePath = path.resolve(dir, filename);
  if (filePath !== dir && !filePath.startsWith(dir + path.sep)) return res.status(400).send("Bad request");

  fs.readFile(filePath, (err, data) => {
    if (err) return res.status(404).send("Not found");
    const isPlaylist = filename.endsWith(".m3u8");
    res.setHeader("Content-Type", isPlaylist ? "application/vnd.apple.mpegurl" : "video/mp2t");
    res.setHeader("Cache-Control", isPlaylist ? "no-store" : "public, max-age=2");
    res.status(200).end(data);
  });
});

module.exports = router;
