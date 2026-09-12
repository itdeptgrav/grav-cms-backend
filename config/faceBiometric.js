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

const crypto = require("crypto");
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
  process.env.FACE_BIOMETRIC_ROOT || "/Volumes/ESD-USB/GRAV_BIOMETRIC";

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

/**
 * Where the running engine answers.
 *
 * Loopback by default, which is the right answer whenever Node and the engine
 * are the same machine. THEY ARE NOT THE SAME MACHINE IN PRODUCTION: the API
 * is hosted, the engine runs on the punch-in machine with the photos. There,
 * this must be the engine's tunnel hostname over https — a URL, not a port on
 * the API's own domain. See docs/face-biometric-deployment.md.
 */
const FACE_BIOMETRIC_SERVICE_URL =
  process.env.FACE_BIOMETRIC_SERVICE_URL ||
  `http://127.0.0.1:${FACE_BIOMETRIC_PORT}`;

/**
 * Shared secret with the engine, sent as X-Face-Key.
 *
 * The engine has no user accounts; this is the whole of its authentication.
 * Empty is correct ONLY on loopback, and the engine itself refuses to bind
 * anything else without one, so the two halves cannot disagree in the unsafe
 * direction.
 */
const FACE_ENGINE_KEY = (process.env.FACE_ENGINE_KEY || "").trim();

/**
 * Signing key for BROWSER tokens. Deliberately not FACE_ENGINE_KEY.
 *
 * FACE_ENGINE_KEY is this backend's credential: it never expires and it
 * authorises everything the engine can do, enrolment included. It must never
 * leave this process. What a browser gets instead is a token signed with this
 * separate key, valid for two minutes, scoped to one action and one session.
 *
 * Two keys rather than one so that a mistake in token handling — a claim
 * echoed into an error, a token logged — cannot expose the credential that
 * would let somebody enrol a stranger's face as an employee.
 */
const FACE_BROWSER_TOKEN_SECRET = (process.env.FACE_BROWSER_TOKEN_SECRET || "").trim();

/** Seconds a browser token is good for. Short: the page asks for one when it
    starts capturing and streams frames for a few seconds. */
const BROWSER_TOKEN_TTL_SEC = 120;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

/**
 * Mint a short-lived token a BROWSER may send to the engine.
 *
 * Claims, and why each is there:
 *
 *   aud  the engine, so a token minted for anything else is not accepted here
 *   act  what it permits — "verify" and nothing else. The engine enforces its
 *        own allowlist too, so a mis-minted act cannot widen anything
 *   sid  the capture session it belongs to; the engine rate-limits per session
 *   sub  OPTIONAL. Face sign-in identifies an unknown person FROM their face,
 *        so demanding a subject would mean naming the employee before the
 *        recognition that is supposed to determine it. Where the caller
 *        already knows who this is — re-verifying a signed-in employee — it is
 *        carried; otherwise the token is scoped to the kiosk session alone
 *   iat  when it was minted, so a token from a badly-skewed clock is refused
 *   exp  when it stops working, which is the main control here
 *   jti  a unique id, so the engine can bound replay
 *
 * Returns null when no signing key is configured. Callers must treat that as
 * "browser access is not available", never as "no token needed".
 */
function mintBrowserToken({ sessionId, employeeId = null, action = "verify", ttlSec = BROWSER_TOKEN_TTL_SEC }) {
  if (!FACE_BROWSER_TOKEN_SECRET) return null;
  const sid = String(sessionId || "").trim();
  if (!sid || sid.length > 128) throw new Error("a session id is required to mint a face token");

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    aud: "face-engine",
    act: [String(action)],
    sid,
    iat: now,
    exp: now + Math.min(Number(ttlSec) || BROWSER_TOKEN_TTL_SEC, BROWSER_TOKEN_TTL_SEC),
    jti: crypto.randomBytes(16).toString("hex"),
  };
  if (employeeId) claims.sub = String(employeeId).slice(0, 64);

  const payload = b64url(JSON.stringify(claims));
  const sig = crypto.createHmac("sha256", FACE_BROWSER_TOKEN_SECRET).update(payload).digest();
  return { token: `${payload}.${b64url(sig)}`, expiresAt: new Date(claims.exp * 1000).toISOString(),
           expiresInSec: claims.exp - now, sessionId: sid };
}

/** True when the engine is somewhere a stranger could also reach. */
function engineIsRemote() {
  try {
    const host = new URL(FACE_BIOMETRIC_SERVICE_URL).hostname.toLowerCase();
    return !["127.0.0.1", "::1", "localhost", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

/**
 * Headers for every engine call. One definition, because the alternative is
 * four copies of a fetch that each have to remember the key — and the one
 * that forgets fails closed with a 401 nobody can explain.
 */
function engineHeaders(extra = {}) {
  const headers = { "Content-Type": "application/json", ...extra };
  if (FACE_ENGINE_KEY) headers["X-Face-Key"] = FACE_ENGINE_KEY;
  return headers;
}

/* Said once at boot rather than per request. A remote engine with no key is
   an open enrolment endpoint, and /health hands out every biometric ID. */
if (engineIsRemote() && !FACE_ENGINE_KEY) {
  console.warn(
    `[face] FACE_BIOMETRIC_SERVICE_URL points at ${FACE_BIOMETRIC_SERVICE_URL} ` +
      `but FACE_ENGINE_KEY is not set. The engine will refuse these calls. ` +
      `Set the same key on both sides.`,
  );
}

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
      headers: engineHeaders(),
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
      headers: engineHeaders(),
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
  engineHeaders,
  engineIsRemote,
  FACE_ENGINE_KEY,
  /* Exported for the route that issues browser tokens. FACE_BROWSER_TOKEN_SECRET
     itself deliberately is NOT: nothing outside this module needs the key, and
     a value that cannot be reached cannot be logged, serialised into a response
     or spread into an object by accident. */
  mintBrowserToken,
  BROWSER_TOKEN_TTL_SEC,
  browserTokensConfigured: () => Boolean(FACE_BROWSER_TOKEN_SECRET),
  serviceUnavailable,
};
