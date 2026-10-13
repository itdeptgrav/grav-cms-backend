"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

function catalogError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function runFile(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || ""));
      if (error.code === "ENOENT") {
        return reject(catalogError("The YouTube Music catalogue helper is not installed.", "MUSIC_CATALOG_NOT_CONFIGURED", error));
      }
      const detail = String(stderr || error.message || "").trim().slice(0, 500);
      return reject(catalogError(detail || "YouTube Music search failed.", "MUSIC_CATALOG_FAILED", error));
    });
  });
}

function bestThumbnail(row) {
  const thumbnails = Array.isArray(row?.thumbnails) ? row.thumbnails.filter((item) => item?.url) : [];
  thumbnails.sort((a, b) => Number(b.width || 0) - Number(a.width || 0));
  return thumbnails[0]?.url || "";
}

function normalizeSong(row) {
  if (row?.resultType !== "song" || !VIDEO_ID.test(String(row?.videoId || ""))) return null;
  const artist = (Array.isArray(row.artists) ? row.artists : []).map((item) => item?.name).filter(Boolean).join(", ");
  return {
    id: row.videoId,
    title: String(row.title || "Untitled"),
    artist: artist || "Unknown artist",
    album: String(row.album?.name || ""),
    durationSeconds: Number.isFinite(Number(row.duration_seconds)) ? Number(row.duration_seconds) : null,
    artworkUrl: bestThumbnail(row),
  };
}

function defaultPython() {
  if (process.env.YTMUSIC_PYTHON_PATH) return process.env.YTMUSIC_PYTHON_PATH;
  const local = path.resolve(__dirname, "../../.local-tools/yt-dlp-venv/bin/python");
  return fs.existsSync(local) ? local : "python3";
}

function createYtMusicCatalog({
  python = defaultPython(),
  script = path.resolve(__dirname, "../../scripts/music/ytmusic_search.py"),
  run = runFile,
} = {}) {
  return {
    async health() {
      try {
        const output = await run(python, ["-c", "import ytmusicapi; print(ytmusicapi.__version__)"]);
        return { available: true, version: output.trim() };
      } catch (error) {
        return { available: false, code: error.code || "MUSIC_CATALOG_UNAVAILABLE", message: error.message };
      }
    },

    async search(value, { limit = 20 } = {}) {
      const query = String(value || "").trim();
      if (query.length < 2 || query.length > 120) {
        throw catalogError("Search must be between 2 and 120 characters.", "INVALID_QUERY");
      }
      const safeLimit = Math.min(25, Math.max(1, Number(limit) || 20));
      const output = await run(python, [script, query, String(safeLimit)]);
      let rows;
      try {
        rows = JSON.parse(output);
      } catch (error) {
        throw catalogError("YouTube Music returned an invalid search response.", "MUSIC_CATALOG_INVALID_RESPONSE", error);
      }
      return (Array.isArray(rows) ? rows : []).map(normalizeSong).filter(Boolean).slice(0, safeLimit);
    },
  };
}

module.exports = { createYtMusicCatalog, normalizeSong, catalog: createYtMusicCatalog() };
