// services/cctv/config.js
//
// CCTV camera + NVR configuration, RTSP URL building, and ffmpeg resolution.
// Ported from the standalone grav-cctv-next app into the CMS backend so the
// whole system runs inside the single Express process — no separate CCTV server.
//
// Credentials live ONLY in env (NVR{1,2}_USERNAME/PASSWORD/HOST/PORT). The
// credentialed RTSP URL is built here and never leaves the server.

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

/* ── camera list ──────────────────────────────────────────────────────
   ids 1..13  -> NVR2 channels 1..13
   ids 14..25 -> NVR1 channels 3..14  (12 cameras)                        */
const NVR2_NAMES = {
  1: "Floor 19 - Storage",
  4: "Floor 9 - Cabin",
  8: "Floor 10 - Reception",
};

function buildCameras() {
  const cams = [];
  let id = 1;
  for (let channel = 1; channel <= 13; channel++) {
    cams.push({ id: id++, name: NVR2_NAMES[channel] || `NVR2 Cam ${channel}`, nvr: "NVR2", channel });
  }
  for (let channel = 3; channel <= 14; channel++) {
    cams.push({ id: id++, name: `NVR1 Cam ${channel}`, nvr: "NVR1", channel });
  }
  return cams;
}

const CAMERAS = buildCameras();
function getCamera(id) {
  return CAMERAS.find((c) => c.id === Number(id));
}

/** Grid layouts offered to the client. */
const LAYOUTS = [
  { key: "2x2", cols: 2, size: 4, label: "2 × 2" },
  { key: "3x3", cols: 3, size: 9, label: "3 × 3" },
  { key: "4x4", cols: 4, size: 16, label: "4 × 4" },
];

/* ── env helpers ──────────────────────────────────────────────────────── */
function num(v, fallback) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Per-NVR credentials + connection cap from env. Defaults point at the public
 * port-forward so it works whether the backend is on the CCTV LAN or remote;
 * override in .env for LAN IPs.
 */
function getNvrCredentials(nvr) {
  const p = nvr; // "NVR1" | "NVR2"
  const defaults = {
    NVR1: { host: "103.39.241.30", port: 10554, username: "grav_camera_01", password: "grav_camera_01" },
    NVR2: { host: "103.39.241.30", port: 20554, username: "ai_live", password: "LiveStreaming@123" },
  }[p] || { host: "192.168.1.1", port: 554, username: "", password: "" };
  return {
    host: process.env[`${p}_HOST`] || defaults.host,
    port: num(process.env[`${p}_PORT`], defaults.port),
    username: process.env[`${p}_USERNAME`] || defaults.username,
    password: process.env[`${p}_PASSWORD`] || defaults.password,
    maxConnections: num(process.env[`${p}_MAX_CONNECTIONS`], 6),
  };
}

// These cameras are H.265; ffmpeg must transcode to H.264 for the browser.
// Default ON (set TRANSCODE=0 only if a camera is already H.264).
function shouldTranscode() {
  return process.env.CCTV_TRANSCODE !== "0";
}
function ffmpegPathOverride() {
  const p = (process.env.FFMPEG_PATH || "").trim();
  return p || undefined;
}
function stopGraceMs() {
  return num(process.env.CCTV_STREAM_STOP_GRACE_MS, 4000);
}

/* ── RTSP ─────────────────────────────────────────────────────────────── */
function buildRtspUrl({ host, port, username, password, channel, subtype }) {
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return `rtsp://${user}:${pass}@${host}:${port}/cam/realmonitor?channel=${channel}&subtype=${subtype}`;
}
function redactRtspUrl(url) {
  return String(url).replace(/\/\/[^@/]*@/, "//***:***@");
}

/** RTSP URL for a camera + subtype, reading that NVR's env credentials. */
function rtspForCamera(camera, subtype) {
  const c = getNvrCredentials(camera.nvr);
  return buildRtspUrl({
    host: c.host, port: c.port, username: c.username, password: c.password,
    channel: camera.channel, subtype,
  });
}

/* ── ffmpeg ───────────────────────────────────────────────────────────── */
function resolveFfmpegPath() {
  const override = ffmpegPathOverride();
  if (override) return override;
  try {
    // ffmpeg-static's default export is the absolute path to the bundled binary.
    return require("ffmpeg-static") || null;
  } catch {
    return null;
  }
}
function ffmpegAvailable() {
  const p = resolveFfmpegPath();
  return Boolean(p && fs.existsSync(p));
}
let _ver = null;
function ffmpegVersion() {
  if (_ver !== null) return _ver;
  const p = resolveFfmpegPath();
  if (!p) return (_ver = null);
  try {
    const out = spawnSync(p, ["-version"], { windowsHide: true, timeout: 4000, encoding: "utf8" });
    const m = /ffmpeg version (\S+)/i.exec(out.stdout || "");
    return (_ver = m ? m[1] : "unknown");
  } catch {
    return (_ver = null);
  }
}

const GOP_FPS = "25";
function buildFfmpegArgs(rtspUrl, outputDir) {
  const playlist = `${outputDir}/index.m3u8`;
  const segmentPattern = `${outputDir}/seg%d.ts`;
  const input = [
    "-rtsp_transport", "tcp",
    "-fflags", "nobuffer",
    "-flags", "low_delay",
    "-i", rtspUrl,
    "-an",
  ];
  const codec = shouldTranscode()
    ? [
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "zerolatency",
        "-g", GOP_FPS,
        "-keyint_min", GOP_FPS,
        "-sc_threshold", "0",
        "-pix_fmt", "yuv420p",
      ]
    : ["-c:v", "copy"];
  const hls = [
    "-f", "hls",
    "-hls_time", "1",
    "-hls_list_size", "4",
    "-hls_flags", "delete_segments+append_list+omit_endlist",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", segmentPattern,
    playlist,
  ];
  return [...input, ...codec, ...hls];
}

/** Where a camera+subtype's HLS files are written / served from. */
const HLS_BASE_DIR = path.join(os.tmpdir(), "grav-cctv");
function outputDirFor(cameraId, subtype) {
  return path.join(HLS_BASE_DIR, String(cameraId), String(subtype));
}

module.exports = {
  CAMERAS, getCamera, LAYOUTS,
  getNvrCredentials, shouldTranscode, stopGraceMs,
  buildRtspUrl, redactRtspUrl, rtspForCamera,
  resolveFfmpegPath, ffmpegAvailable, ffmpegVersion, buildFfmpegArgs,
  HLS_BASE_DIR, outputDirFor,
};
