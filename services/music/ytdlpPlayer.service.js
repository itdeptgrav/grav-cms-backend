"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SEARCH_TIMEOUT_MS = 45_000;
const RESOLVE_TIMEOUT_MS = 60_000;

function serviceError(message, code, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function runFile(binary, args, { timeout = SEARCH_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || ""));
      if (error.code === "ENOENT") {
        return reject(serviceError("yt-dlp is not installed on the GRAV backend.", "YTDLP_NOT_CONFIGURED", error));
      }
      const detail = String(stderr || error.message || "").trim().slice(0, 500);
      return reject(serviceError(detail || "yt-dlp could not complete the request.", "YTDLP_FAILED", error));
    });
  });
}

function validateVideoId(value) {
  const id = String(value || "").trim();
  if (!VIDEO_ID.test(id)) throw serviceError("A valid YouTube video id is required.", "INVALID_VIDEO_ID");
  return id;
}

function bestArtwork(row) {
  const thumbnails = Array.isArray(row?.thumbnails) ? row.thumbnails.filter((item) => item?.url) : [];
  thumbnails.sort((a, b) => Number(b.width || 0) - Number(a.width || 0));
  return thumbnails[0]?.url || row?.thumbnail || "";
}

function normalizeSearchRow(row) {
  if (!row || !VIDEO_ID.test(String(row.id || ""))) return null;
  return {
    id: row.id,
    title: String(row.title || "Untitled"),
    artist: String(row.channel || row.uploader || row.artist || "Unknown artist"),
    durationSeconds: Number.isFinite(Number(row.duration)) ? Number(row.duration) : null,
    artworkUrl: bestArtwork(row),
  };
}

function parseLines(stdout) {
  return String(stdout || "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function contentTypeFor(row) {
  if (row?.ext === "m4a" || String(row?.acodec || "").startsWith("mp4a")) return "audio/mp4";
  if (row?.ext === "webm") return "audio/webm";
  return "audio/mpeg";
}

function defaultBinary() {
  if (process.env.YTDLP_PATH) return process.env.YTDLP_PATH;
  const venv = path.resolve(__dirname, "../../.local-tools/yt-dlp-venv/bin/yt-dlp");
  if (fs.existsSync(venv)) return venv;
  const local = path.resolve(__dirname, "../../.local-tools/yt-dlp");
  return fs.existsSync(local) ? local : "yt-dlp";
}

function createYtDlpPlayer({ binary = defaultBinary(), run = runFile } = {}) {
  return {
    async health() {
      try {
        const version = (await run(binary, ["--version"], { timeout: 15_000 })).trim();
        return { available: true, version, binary };
      } catch (error) {
        return { available: false, code: error.code || "YTDLP_UNAVAILABLE", message: error.message };
      }
    },

    async search(value, { limit = 15 } = {}) {
      const query = String(value || "").trim();
      if (query.length < 2 || query.length > 120) {
        throw serviceError("Search must be between 2 and 120 characters.", "INVALID_QUERY");
      }
      const safeLimit = Math.min(25, Math.max(1, Number(limit) || 15));
      const stdout = await run(binary, [
        "--dump-json",
        "--flat-playlist",
        "--no-warnings",
        "--no-playlist",
        `ytsearch${safeLimit}:${query}`,
      ], { timeout: SEARCH_TIMEOUT_MS });
      return parseLines(stdout).map(normalizeSearchRow).filter(Boolean);
    },

    async resolve(value) {
      const id = validateVideoId(value);
      const stdout = await run(binary, [
        "--dump-single-json",
        "--no-warnings",
        "--no-playlist",
        "--format",
        "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio",
        `https://www.youtube.com/watch?v=${id}`,
      ], { timeout: RESOLVE_TIMEOUT_MS });
      let row;
      try {
        row = JSON.parse(stdout);
      } catch (error) {
        throw serviceError("yt-dlp returned an invalid stream response.", "YTDLP_INVALID_RESPONSE", error);
      }
      if (!/^https:\/\//i.test(String(row?.url || ""))) {
        throw serviceError("No playable audio stream was returned.", "YTDLP_NO_STREAM");
      }
      return {
        streamUrl: row.url,
        contentType: contentTypeFor(row),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        track: normalizeSearchRow(row) || { id, title: "Untitled", artist: "Unknown artist", durationSeconds: null, artworkUrl: "" },
      };
    },
  };
}

module.exports = {
  createYtDlpPlayer,
  normalizeSearchRow,
  validateVideoId,
  player: createYtDlpPlayer(),
};
