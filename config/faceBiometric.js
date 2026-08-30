"use strict";

/**
 * faceBiometric.js — one place that knows where the face engine is.
 *
 * The engine is Python (InsightFace/onnxruntime is Python-side) but it is
 * backend-owned: the code lives in services/face-biometric, and everything
 * about where it runs and where its data sits is configured here rather than
 * assumed at each call site. Two routes each carrying their own idea of the
 * paths is how one of them ends up pointing at a volume that is no longer
 * mounted.
 *
 * Dev defaults still point at the original USB install, so nothing has to
 * move before this works. Production sets FACE_BIOMETRIC_ROOT (or the
 * individual paths) and nothing else changes.
 */

const os = require("os");
const path = require("path");

const BACKEND_ROOT = path.join(__dirname, "..");
const SERVICE_DIR = path.join(BACKEND_ROOT, "services", "face-biometric");

/** The interpreter that has insightface installed. */
const FACE_PYTHON =
  process.env.FACE_PYTHON ||
  path.join(os.homedir(), "phone_detc_venv", "bin", "python");

/** Where the engine keeps photos, the mapping and the status file. */
const FACE_BIOMETRIC_ROOT =
  process.env.FACE_BIOMETRIC_ROOT || "/Volumes/ESD-USB/PHONE_DETC";

const FACE_BIOMETRIC_REGISTERED_DIR =
  process.env.FACE_BIOMETRIC_REGISTERED_DIR ||
  path.join(FACE_BIOMETRIC_ROOT, "REGISTERED_PEOPLE");

const FACE_BIOMETRIC_PEOPLE_MAP =
  process.env.FACE_BIOMETRIC_PEOPLE_MAP ||
  path.join(FACE_BIOMETRIC_ROOT, "biometric_people.json");

const FACE_BIOMETRIC_STATUS_FILE =
  process.env.FACE_BIOMETRIC_STATUS_FILE ||
  path.join(FACE_BIOMETRIC_ROOT, "biometric_status.json");

const FACE_BIOMETRIC_PORT = Number(process.env.FACE_BIOMETRIC_PORT || 5001);

/** Where the running engine answers. Localhost: it has no auth of its own. */
const FACE_BIOMETRIC_SERVICE_URL =
  process.env.FACE_BIOMETRIC_SERVICE_URL ||
  `http://127.0.0.1:${FACE_BIOMETRIC_PORT}`;

/** The command an operator should run when the engine is not up. */
const START_COMMAND = "npm run face:service";

/** Environment the engine is started with, so a child process inherits it. */
function engineEnv(extra = {}) {
  return {
    ...process.env,
    FACE_BIOMETRIC_ROOT,
    FACE_BIOMETRIC_REGISTERED_DIR,
    FACE_BIOMETRIC_PEOPLE_MAP,
    FACE_BIOMETRIC_STATUS_FILE,
    ...extra,
  };
}

/**
 * Call the engine. Returns {status, json} or {status: 0, error} — never
 * throws, so a route can answer "the engine is down" instead of 500ing.
 */
async function callEngine(endpoint, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FACE_BIOMETRIC_SERVICE_URL}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  } catch (err) {
    return {
      status: 0,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** The engine's own health, or a usable explanation of why there is none. */
async function engineHealth(timeoutMs = 4000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${FACE_BIOMETRIC_SERVICE_URL}/health`, {
      signal: ctrl.signal,
    });
    const json = await res.json();
    return { running: true, ...json };
  } catch (err) {
    return {
      running: false,
      reason: "face_service_unreachable",
      detail: err.name === "AbortError" ? "timeout" : err.message,
      serviceUrl: FACE_BIOMETRIC_SERVICE_URL,
      startCommand: START_COMMAND,
      message:
        `The face service is not running at ${FACE_BIOMETRIC_SERVICE_URL}. ` +
        `Start it from the backend with \`${START_COMMAND}\`.`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** One shape for "the engine is down", used by every route that needs it. */
function serviceUnavailable(res, detail) {
  return res.status(503).json({
    success: false,
    reason: "face_service_unreachable",
    detail: detail || null,
    serviceUrl: FACE_BIOMETRIC_SERVICE_URL,
    startCommand: START_COMMAND,
    message:
      `The face service is not running at ${FACE_BIOMETRIC_SERVICE_URL}. ` +
      `Start it from the backend with \`${START_COMMAND}\`.`,
  });
}

module.exports = {
  BACKEND_ROOT,
  SERVICE_DIR,
  FACE_PYTHON,
  FACE_BIOMETRIC_ROOT,
  FACE_BIOMETRIC_REGISTERED_DIR,
  FACE_BIOMETRIC_PEOPLE_MAP,
  FACE_BIOMETRIC_STATUS_FILE,
  FACE_BIOMETRIC_PORT,
  FACE_BIOMETRIC_SERVICE_URL,
  START_COMMAND,
  engineEnv,
  callEngine,
  engineHealth,
  serviceUnavailable,
};
