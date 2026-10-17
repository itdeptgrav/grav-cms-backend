// services/cctv/cctvStill.service.js
//
// One JPEG frame from a camera's MJPEG stream, for twin calibration. The frame
// comes from the same stream the person worker reads, so its pixels line up
// exactly with the detector's — a screenshot of the viewer is letterboxed or
// rescaled and quietly breaks the mapping. The CCTV key never leaves the
// server; the frame is returned to an administrator and not stored.
"use strict";

const { CctvLinkError } = require("./cctvLink");

const MAX_BYTES = 8 * 1024 * 1024;

function firstJpeg(buffer) {
  const start = buffer.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (start < 0) return null;
  const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), start + 3);
  return end < 0 ? null : buffer.subarray(start, end + 2);
}

/** The CCTV app's MJPEG URL for a stream; the key stays on this server. */
function streamUrl(streamIndex) {
  const key = String(process.env.CCTV_KEY || "").trim();
  const base = String(process.env.CCTV_APP_URL || "").trim().replace(/\/+$/, "");
  if (key.length < 8 || !/^https?:\/\//.test(base)) {
    throw new CctvLinkError(503, "CCTV_NOT_CONFIGURED", "The CCTV stream is not configured on this server.");
  }
  if (!Number.isInteger(streamIndex) || streamIndex < 0) {
    throw new CctvLinkError(404, "CAMERA_STREAM_UNKNOWN", "This camera has no stream in the CCTV registry.");
  }
  return `${base}/stream/${streamIndex}?key=${encodeURIComponent(key)}`;
}

async function grabStill(streamIndex, { timeoutMs = 8000 } = {}) {
  const url = streamUrl(streamIndex);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new CctvLinkError(502, "CCTV_REFUSED", `The CCTV stream answered HTTP ${res.status}.`);
    const reader = res.body.getReader();
    let buffer = Buffer.alloc(0);
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = Buffer.concat([buffer, Buffer.from(value)]);
      const jpeg = firstJpeg(buffer);
      if (jpeg) { ctrl.abort(); return Buffer.from(jpeg); }
      if (buffer.length > MAX_BYTES) break;
    }
    throw new CctvLinkError(502, "CCTV_NO_FRAME", "The camera stream did not deliver a frame.");
  } catch (err) {
    if (err instanceof CctvLinkError) throw err;
    throw new CctvLinkError(504, "CCTV_UNREACHABLE", "The camera stream could not be reached just now.");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Relay a camera's live MJPEG to one viewer (the twin's dev view): each whole
 * JPEG goes to onFrame(jpeg), at most `maxFps` a second, until `signal`
 * aborts or `maxMs` passes. Frames in between are dropped here rather than
 * sent: this stream leaves the backend as billed egress, and the detector it
 * is compared with runs at 2-4 fps anyway. Resolves when the stream ends.
 */
async function relayStream(streamIndex, { onFrame, signal, maxFps = 5, maxMs = 10 * 60 * 1000, connectTimeoutMs = 8000 } = {}) {
  const url = streamUrl(streamIndex);
  const ctrl = new AbortController();
  const stop = () => ctrl.abort();
  if (signal?.aborted) return;
  signal?.addEventListener("abort", stop, { once: true });
  const connect = setTimeout(stop, connectTimeoutMs);
  const limit = setTimeout(stop, maxMs);
  const gapMs = 1000 / Math.max(0.2, maxFps);
  let last = -Infinity;
  try {
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal });
    } catch (err) {
      if (signal?.aborted) return;
      throw new CctvLinkError(504, "CCTV_UNREACHABLE", "The camera stream could not be reached just now.");
    }
    clearTimeout(connect);
    if (!res.ok || !res.body) throw new CctvLinkError(502, "CCTV_REFUSED", `The CCTV stream answered HTTP ${res.status}.`);
    const reader = res.body.getReader();
    let buffer = Buffer.alloc(0);
    for (;;) {
      let chunk;
      try { chunk = await reader.read(); } catch { return; } // aborted: viewer left or time is up
      if (chunk.done) return;
      buffer = Buffer.concat([buffer, Buffer.from(chunk.value)]);
      for (let jpeg = firstJpeg(buffer); jpeg; jpeg = firstJpeg(buffer)) {
        buffer = buffer.subarray(jpeg.byteOffset - buffer.byteOffset + jpeg.length);
        const now = Date.now();
        if (now - last >= gapMs) { last = now; onFrame(Buffer.from(jpeg)); }
      }
      if (buffer.length > MAX_BYTES) throw new CctvLinkError(502, "CCTV_NO_FRAME", "The camera stream did not deliver a frame.");
    }
  } finally {
    clearTimeout(connect); clearTimeout(limit);
    signal?.removeEventListener("abort", stop);
    ctrl.abort();
  }
}

module.exports = { grabStill, relayStream, firstJpeg };
