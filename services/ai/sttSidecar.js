"use strict";
/**
 * services/ai/sttSidecar.js — keep the local Whisper speech-to-text server alive.
 *
 * The GRAV assistant transcribes spoken commands with faster-whisper running as a
 * tiny Python sidecar (services/ai/stt_server.py) on 127.0.0.1:5060. Rather than
 * ask the user to run a second process, the backend spawns it on boot if it isn't
 * already up. Running it by hand still works — we no-op when the port answers.
 *
 * Everything is local; no audio leaves the machine. Paths are overridable via env
 * for non-default setups:
 *   GRAV_STT_PYTHON  path to the venv's python  (has faster-whisper installed)
 *   GRAV_STT_MODEL   whisper model id           (default small.en)
 *   GRAV_STT_PORT    port                       (default 5060)
 *   GRAV_STT_URL     full base url the backend calls (default http://127.0.0.1:PORT)
 */

const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

// NOT 5060/5061 — those are on the Fetch spec's blocked-ports list (SIP), so
// Node's fetch / browsers refuse them (curl works, which hid the bug). 5757 is
// unrestricted.
const PORT = process.env.GRAV_STT_PORT || "5757";
const URL = process.env.GRAV_STT_URL || `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.GRAV_STT_PYTHON || path.join(os.homedir(), ".grav-stt-venv/bin/python");
const SCRIPT = path.join(__dirname, "stt_server.py");
const MODEL = process.env.GRAV_STT_MODEL || "small.en";
const LOG_PATH = path.join(os.tmpdir(), "grav-stt.log");

async function isUp() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${URL}/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

let started = false;

/**
 * Ensure the STT sidecar is running. Idempotent and non-fatal: if Python/venv is
 * missing it logs a hint and leaves speech-to-text unavailable (the assistant
 * still works by text). Never throws.
 */
async function ensureSttServer() {
  if (started) return;
  started = true;
  try {
    if (await isUp()) {
      console.log(`[grav-stt] sidecar already running at ${URL}`);
      return;
    }
    if (!fs.existsSync(PYTHON)) {
      console.warn(
        `[grav-stt] python not found at ${PYTHON} — voice transcription is off. ` +
          `Set GRAV_STT_PYTHON or create the venv (see services/ai/stt_server.py).`,
      );
      return;
    }
    const out = fs.openSync(LOG_PATH, "a");
    const child = spawn(PYTHON, [SCRIPT], {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, GRAV_STT_MODEL: MODEL, GRAV_STT_PORT: PORT },
    });
    child.unref(); // let it outlive nodemon reloads; it self-noops if already up
    console.log(`[grav-stt] launching sidecar (model=${MODEL}) -> ${URL}, log: ${LOG_PATH}`);
  } catch (err) {
    console.warn("[grav-stt] could not start sidecar:", err && err.message);
  }
}

module.exports = { ensureSttServer, STT_URL: URL };
