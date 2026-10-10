// services/cctv/manager.js
//
// One shared RTSP->HLS worker per camera+subtype, kept alive only while a viewer
// is watching, with a per-NVR connection limiter. Ported from grav-cctv-next's
// camera-manager into the CMS backend (single Express process, so a plain module
// singleton replaces the Next globalThis singleton).

const os = require("os");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const {
  CAMERAS, getCamera, getNvrCredentials,
  rtspForCamera, redactRtspUrl,
  resolveFfmpegPath, buildFfmpegArgs, outputDirFor, stopGraceMs,
} = require("./config");

/* ── tunables (ms) ──────────────────────────────────────────────────────── */
const SESSION_TIMEOUT_MS = 15_000;
const RECONNECT_BACKOFF_MS = [2_000, 3_000, 5_000];
const CONNECT_TIMEOUT_MS = 8_000;
const OFFLINE_AFTER_ATTEMPTS = 2;
const OFFLINE_RETRY_MS = 5_000;
const STALL_TIMEOUT_MS = 10_000;
const MONITOR_INTERVAL_MS = 500;
const SWEEP_INTERVAL_MS = 5_000;

const STATUS = {
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  WAITING: "WAITING_FOR_NVR_SLOT",
  LIVE: "LIVE",
  RECONNECTING: "RECONNECTING",
  OFFLINE: "OFFLINE",
  STOPPING: "STOPPING",
};

function log(...a) { console.log("[cctv]", ...a); }

/* ── per-NVR semaphore ──────────────────────────────────────────────────── */
class NvrLimiter {
  constructor(maxFor) {
    this.maxFor = maxFor || ((nvr) => getNvrCredentials(nvr).maxConnections);
    this.state = new Map();
  }
  stateFor(nvr) {
    let s = this.state.get(nvr);
    if (!s) { s = { active: 0, max: this.maxFor(nvr), queue: [] }; this.state.set(nvr, s); }
    return s;
  }
  tryAcquire(nvr) {
    const s = this.stateFor(nvr);
    if (s.active < s.max) { s.active++; return true; }
    return false;
  }
  acquire(nvr, signal) {
    const s = this.stateFor(nvr);
    if (s.active < s.max) { s.active++; return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const waiter = { resolve };
      const onAbort = () => {
        const i = s.queue.indexOf(waiter);
        if (i >= 0) s.queue.splice(i, 1);
        reject(new Error("aborted"));
      };
      waiter.onAbort = onAbort;
      waiter.signal = signal;
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
      }
      s.queue.push(waiter);
    });
  }
  release(nvr) {
    const s = this.stateFor(nvr);
    const next = s.queue.shift();
    if (next) {
      if (next.signal) { try { next.signal.removeEventListener("abort", next.onAbort); } catch {} }
      next.resolve();
      return;
    }
    s.active = Math.max(0, s.active - 1);
  }
  snapshot() {
    const out = {};
    for (const c of CAMERAS) {
      if (out[c.nvr]) continue;
      const s = this.stateFor(c.nvr);
      out[c.nvr] = { active: s.active, max: s.max, queued: s.queue.length };
    }
    return out;
  }
}

/* ── one worker per camera+subtype ──────────────────────────────────────── */
class CameraWorker {
  constructor({ camera, subtype, limiter }) {
    this.camera = camera;
    this.subtype = subtype;
    this.limiter = limiter;
    this.key = `${camera.id}:${subtype}`;
    this.outputDir = outputDirFor(camera.id, subtype);

    this.status = STATUS.IDLE;
    this.proc = null;
    this.slotHeld = false;
    this.attempts = 0;
    this.settledOffline = false;
    this.stderrTail = "";

    this.sessions = new Map();       // sessionId -> lastSeen
    this.monitorTimer = null;
    this.reconnectTimer = null;
    this.stopTimer = null;
    this.connectDeadline = 0;
    this.lastSegmentMtime = 0;
    this.stalledSince = 0;

    this.startPromise = null;
    this.abort = null;
  }

  get viewerCount() { return this.sessions.size; }

  addViewer() {
    const id = randomUUID();
    this.sessions.set(id, Date.now());
    if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
    this.ensureRunning();
    return id;
  }
  heartbeat(id) {
    if (this.sessions.has(id)) { this.sessions.set(id, Date.now()); return true; }
    return false;
  }
  removeViewer(id) {
    this.sessions.delete(id);
    if (this.viewerCount === 0) this.scheduleStop();
  }
  sweep() {
    const now = Date.now();
    for (const [id, seen] of this.sessions) {
      if (now - seen > SESSION_TIMEOUT_MS) this.sessions.delete(id);
    }
    if (this.viewerCount === 0 && this.status !== STATUS.IDLE) this.scheduleStop();
  }

  ensureRunning() {
    if (this.status === STATUS.LIVE || this.status === STATUS.CONNECTING ||
        this.status === STATUS.WAITING || this.status === STATUS.RECONNECTING) return;
    if (this.startPromise) return;
    this.abort = new AbortController();
    this.startPromise = this.runStart(this.abort.signal)
      .catch((e) => { if (e?.message !== "aborted") log(this.key, "start error", e?.message); })
      .finally(() => { this.startPromise = null; });
  }

  async runStart(signal) {
    const ffmpegPath = resolveFfmpegPath();
    if (!ffmpegPath) { this.status = STATUS.OFFLINE; return; }
    // Acquire an NVR slot (fast path, else wait).
    if (!this.limiter.tryAcquire(this.camera.nvr)) {
      this.status = STATUS.WAITING;
      await this.limiter.acquire(this.camera.nvr, signal);
    }
    if (signal.aborted) { this.limiter.release(this.camera.nvr); return; }
    this.slotHeld = true;
    this.spawnFfmpeg(ffmpegPath);
  }

  spawnFfmpeg(ffmpegPath) {
    try {
      fs.rmSync(this.outputDir, { recursive: true, force: true });
      fs.mkdirSync(this.outputDir, { recursive: true });
    } catch (e) { log(this.key, "mkdir failed", e?.message); }

    const url = rtspForCamera(this.camera, this.subtype);
    const args = buildFfmpegArgs(url, this.outputDir);
    this.status = STATUS.CONNECTING;
    this.connectDeadline = Date.now() + CONNECT_TIMEOUT_MS;
    this.lastSegmentMtime = 0;
    log(this.key, "spawn ffmpeg", redactRtspUrl(url));

    const proc = spawn(ffmpegPath, args, { windowsHide: true });
    this.proc = proc;
    proc.stderr.on("data", (d) => {
      this.stderrTail = (this.stderrTail + d.toString()).slice(-2000);
    });
    proc.on("exit", () => this.handleProcessDown());
    proc.on("error", (e) => { log(this.key, "ffmpeg error", e?.message); this.handleProcessDown(); });

    this.startMonitor();
  }

  startMonitor() {
    if (this.monitorTimer) clearInterval(this.monitorTimer);
    this.monitorTimer = setInterval(() => {
      const playlist = path.join(this.outputDir, "index.m3u8");
      let hasPlaylist = false, newestTs = 0;
      try {
        hasPlaylist = fs.existsSync(playlist);
        if (hasPlaylist) {
          for (const f of fs.readdirSync(this.outputDir)) {
            if (f.endsWith(".ts")) {
              const m = fs.statSync(path.join(this.outputDir, f)).mtimeMs;
              if (m > newestTs) newestTs = m;
            }
          }
        }
      } catch {}

      if (hasPlaylist && newestTs > 0) {
        if (this.status !== STATUS.LIVE) { this.status = STATUS.LIVE; log(this.key, "LIVE"); }
        this.attempts = 0;
        this.settledOffline = false;
        // stall detection
        if (this.lastSegmentMtime && newestTs === this.lastSegmentMtime) {
          if (Date.now() - this.stalledSince > STALL_TIMEOUT_MS) {
            log(this.key, "stalled -> reconnect");
            this.killProcess();          // exit handler reconnects
            return;
          }
        } else {
          this.lastSegmentMtime = newestTs;
          this.stalledSince = Date.now();
        }
        return;
      }

      // Not live yet — enforce connect timeout.
      if (Date.now() > this.connectDeadline) {
        log(this.key, "connect timeout -> kill (release slot, retry)");
        this.killProcess();
      }
    }, MONITOR_INTERVAL_MS);
  }

  handleProcessDown() {
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    this.proc = null;
    if (this.slotHeld) { this.limiter.release(this.camera.nvr); this.slotHeld = false; }

    if (this.status === STATUS.STOPPING) return;         // deliberate stop
    if (this.viewerCount === 0) { this.status = STATUS.IDLE; return; }

    this.attempts++;
    const offline = this.attempts >= OFFLINE_AFTER_ATTEMPTS;
    if (offline) { this.status = STATUS.OFFLINE; this.settledOffline = true; }
    else { this.status = STATUS.RECONNECTING; }

    const delay = offline
      ? OFFLINE_RETRY_MS
      : RECONNECT_BACKOFF_MS[Math.min(this.attempts - 1, RECONNECT_BACKOFF_MS.length - 1)];
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.viewerCount > 0) this.ensureRunning();
      else this.status = STATUS.IDLE;
    }, delay);
  }

  scheduleStop() {
    if (this.stopTimer) return;
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null;
      if (this.viewerCount === 0) this.stop();
    }, stopGraceMs());
  }

  killProcess() {
    const proc = this.proc;
    if (!proc) return;
    try {
      const pid = proc.pid;
      if (pid && process.platform === "win32") {
        spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      }
      proc.kill("SIGKILL");
    } catch {}
  }

  async stop() {
    this.status = STATUS.STOPPING;
    if (this.abort) { try { this.abort.abort(); } catch {} }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.monitorTimer) { clearInterval(this.monitorTimer); this.monitorTimer = null; }
    // stop reconnecting: remove exit->reconnect by killing after clearing handlers
    const proc = this.proc;
    if (proc) { proc.removeAllListeners("exit"); proc.removeAllListeners("error"); }
    this.killProcess();
    this.proc = null;
    if (this.slotHeld) { this.limiter.release(this.camera.nvr); this.slotHeld = false; }
    try { fs.rmSync(this.outputDir, { recursive: true, force: true }); } catch {}
    this.status = STATUS.IDLE;
    this.attempts = 0;
    this.settledOffline = false;
    log(this.key, "stopped");
    if (this.viewerCount > 0) this.ensureRunning();   // someone joined during teardown
  }
}

/* ── manager ────────────────────────────────────────────────────────────── */
class CameraManager {
  constructor() {
    this.limiter = new NvrLimiter();
    this.workers = new Map();     // "id:subtype" -> worker
    this.sessions = new Map();    // sessionId -> worker
    this.sweeper = setInterval(() => this.sweepAll(), SWEEP_INTERVAL_MS);
    if (this.sweeper.unref) this.sweeper.unref();
    for (const sig of ["SIGINT", "SIGTERM", "beforeExit"]) {
      process.on(sig, () => this.disposeAll());
    }
  }

  getOrCreateWorker(cameraId, subtype) {
    const camera = getCamera(cameraId);
    if (!camera) return null;
    const key = `${cameraId}:${subtype}`;
    let w = this.workers.get(key);
    if (!w) { w = new CameraWorker({ camera, subtype, limiter: this.limiter }); this.workers.set(key, w); }
    return w;
  }

  watch(cameraId, subtype) {
    const w = this.getOrCreateWorker(cameraId, subtype);
    if (!w) return null;
    const sessionId = w.addViewer();
    this.sessions.set(sessionId, w);
    return { sessionId, status: w.status };
  }
  heartbeat(sessionId) {
    const w = this.sessions.get(sessionId);
    if (!w) return false;
    return w.heartbeat(sessionId);
  }
  unwatch(sessionId) {
    const w = this.sessions.get(sessionId);
    if (!w) return false;
    w.removeViewer(sessionId);
    this.sessions.delete(sessionId);
    return true;
  }
  getWorker(cameraId, subtype) {
    return this.workers.get(`${cameraId}:${subtype}`) || null;
  }

  statusForCamera(cameraId) {
    // Prefer the sub-stream worker's status (what the grid shows), else main.
    const sub = this.workers.get(`${cameraId}:1`);
    const main = this.workers.get(`${cameraId}:0`);
    const w = sub || main;
    return w ? w.status : STATUS.IDLE;
  }

  getCameraViews() {
    return CAMERAS.map((c) => ({ id: c.id, name: c.name, nvr: c.nvr, channel: c.channel, status: this.statusForCamera(c.id) }));
  }

  getSystemStatus() {
    let active = 0;
    for (const w of this.workers.values()) if (w.status === STATUS.LIVE) active++;
    return { nvrs: this.limiter.snapshot(), activeStreams: active, totalCameras: CAMERAS.length };
  }

  sweepAll() {
    for (const w of this.workers.values()) w.sweep();
    // drop dead session pointers
    for (const [id, w] of this.sessions) if (!w.sessions.has(id)) this.sessions.delete(id);
  }

  disposeAll() {
    for (const w of this.workers.values()) { try { w.stop(); } catch {} }
  }
}

// Single module-level instance — one Express process owns everything.
module.exports = new CameraManager();
module.exports.STATUS = STATUS;
