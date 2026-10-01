// services/cctv/cctvLink.js
//
// Everything that crosses between this backend and the CCTV site
// (cctv.grav.in — grav-cctv, a separate Python server):
//
//   · mintSsoUrl(identity)   a 90-second HS256 sign-in token + the /sso URL the
//                            browser is sent to. The token names WHO (identity
//                            id, kind, token version, email) and nothing about
//                            WHAT they may do: the CCTV site asks
//                            GET /api/cctv/internal/access for that, every few
//                            seconds, so a revoked camera goes dark at once.
//   · isCctvService(req)     the CCTV site calling us (shared service key).
//   · fetchCameras()         the CCTV site's camera list for the Access Control
//                            editor. This database keeps NO camera registry —
//                            names, order and channels live in the CCTV app.
//   · notifyAccessChanged()  "forget what you know about this person" after a
//                            grant or department change (best effort; the CCTV
//                            site re-asks every few seconds anyway).
//
// SECRETS (names only; values in .env, never in source):
//   CCTV_SSO_SECRET   signs sign-in tokens; the CCTV site verifies them.
//   CCTV_SERVICE_KEY  server-to-server key, both directions (X-CCTV-Service-Key).
//   CCTV_APP_URL      the CCTV site's public origin.
// The shared key link (cctv.grav.in/?key=…) is NEVER handed out from here any
// more: it gave everybody every camera. It is now the administrators' own link,
// configured only on the CCTV site.
"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/** SHA-256 of values that were published in a git repository and must never
 *  be accepted again (the CCTV SSO secret once sat in grav-cctv/.env.example). */
const PUBLISHED_SECRET_SHA256 = new Set([
  "1bcf4ad1a01f516b148911442399bdd040cfcc8f0de14800afb9e7a201b4d9fa",
]);

const SSO_TTL_S = 90;
const SSO_AUDIENCE = "grav-cctv";
const SSO_ISSUER = "grav-cms";

class CctvLinkError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const sha256 = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");

function appUrl() {
  return String(process.env.CCTV_APP_URL || "").trim().replace(/\/+$/, "");
}

/** A usable secret from the environment, or a refusal naming what is wrong. */
function secretFrom(name) {
  const v = String(process.env[name] || "").trim();
  if (v.length < 32) {
    throw new CctvLinkError(503, "CCTV_NOT_CONFIGURED", `CCTV sign-in is not set up on this server (${name} missing or shorter than 32 characters).`);
  }
  if (PUBLISHED_SECRET_SHA256.has(sha256(v))) {
    throw new CctvLinkError(503, "CCTV_SECRET_PUBLISHED", `${name} is a value that was published in a git repository. Generate a new one (on both servers).`);
  }
  return v;
}

/**
 * The sign-in URL for an identity that resolveCctvAccess() has just allowed.
 * @param {{ id, subject, tv, email, name }} who
 */
function mintSsoUrl(who) {
  const secret = secretFrom("CCTV_SSO_SECRET");
  const base = appUrl();
  if (!/^https?:\/\//.test(base)) {
    throw new CctvLinkError(503, "CCTV_NOT_CONFIGURED", "CCTV_APP_URL is not set on this server.");
  }
  const token = jwt.sign(
    {
      sub: String(who.id || ""), subj: String(who.subject || ""), tv: Number(who.tv || 0),
      email: String(who.email || "").toLowerCase(), name: String(who.name || ""),
    },
    secret,
    { algorithm: "HS256", expiresIn: SSO_TTL_S, audience: SSO_AUDIENCE, issuer: SSO_ISSUER, jwtid: crypto.randomBytes(16).toString("hex") },
  );
  return `${base}/sso?token=${encodeURIComponent(token)}`;
}

/** Is this request the CCTV site, presenting the shared service key? */
function isCctvService(req) {
  let key;
  try { key = secretFrom("CCTV_SERVICE_KEY"); } catch { return false; }
  const got = String(req.headers?.["x-cctv-service-key"] || "");
  const a = Buffer.from(sha256(got));
  const b = Buffer.from(sha256(key));
  return got.length > 0 && crypto.timingSafeEqual(a, b);
}

/** Express guard for the endpoints only the CCTV site may call. */
function requireCctvService(req, res, next) {
  if (isCctvService(req)) return next();
  return res.status(401).json({ success: false, code: "CCTV_SERVICE_KEY_REQUIRED", message: "Not authorised." });
}

/** One request to the CCTV site, with the service key and a hard timeout. */
async function callCctv(path, { method = "GET", body, timeoutMs = 4000 } = {}) {
  const key = secretFrom("CCTV_SERVICE_KEY");
  const base = appUrl();
  if (!/^https?:\/\//.test(base)) throw new CctvLinkError(503, "CCTV_NOT_CONFIGURED", "CCTV_APP_URL is not set on this server.");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { "X-CCTV-Service-Key": key, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new CctvLinkError(502, "CCTV_REFUSED", `The CCTV site answered HTTP ${res.status}.`);
    return data;
  } catch (err) {
    if (err instanceof CctvLinkError) throw err;
    throw new CctvLinkError(502, "CCTV_UNREACHABLE", "The CCTV site could not be reached just now.");
  } finally {
    clearTimeout(t);
  }
}

let cameraCache = { at: 0, cameras: null };
const CAMERA_CACHE_MS = 30_000;

/**
 * The CCTV site's cameras: [{ key, displayName, technicalName, nvr, channel,
 * displayOrder, audio }], in display order. Cached briefly; a failure with a
 * recent copy in hand returns the copy (marked stale) rather than nothing.
 */
async function fetchCameras({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && cameraCache.cameras && now - cameraCache.at < CAMERA_CACHE_MS) {
    return { cameras: cameraCache.cameras, fetchedAt: new Date(cameraCache.at), stale: false };
  }
  try {
    const data = await callCctv("/api/internal/cameras");
    const cameras = (Array.isArray(data?.cameras) ? data.cameras : [])
      .filter((c) => c && typeof c.key === "string")
      .map((c) => ({
        key: String(c.key).toLowerCase(), displayName: String(c.displayName || c.technicalName || c.key),
        technicalName: String(c.technicalName || ""), nvr: String(c.nvr || ""), channel: Number(c.channel) || null,
        displayOrder: Number(c.displayOrder) || null, audio: String(c.audio || ""),
      }));
    cameraCache = { at: now, cameras };
    return { cameras, fetchedAt: new Date(now), stale: false };
  } catch (err) {
    if (cameraCache.cameras && now - cameraCache.at < 60 * 60_000) {
      return { cameras: cameraCache.cameras, fetchedAt: new Date(cameraCache.at), stale: true };
    }
    throw err;
  }
}

/** Display names by key from whatever camera list is already cached (never fetches). */
function cachedCameraNames() {
  return new Map((cameraCache.cameras || []).map((c) => [c.key, c.displayName]));
}

/**
 * Tell the CCTV site that somebody's access changed: `{ email }` for one
 * person, `{ all: true }` for a department switch. Never throws and never
 * delays the caller — the CCTV site re-checks every few seconds regardless;
 * this only makes a revoke take effect at once instead of within that window.
 */
function notifyAccessChanged(what) {
  const body = what?.all ? { all: true } : { email: String(what?.email || "").toLowerCase() };
  if (!body.all && !body.email) return;
  // Not linked to a CCTV site on this server (tests, other environments): nothing to tell.
  try { secretFrom("CCTV_SERVICE_KEY"); } catch { return; }
  if (!/^https?:\/\//.test(appUrl())) return;
  callCctv("/api/internal/access-changed", { method: "POST", body, timeoutMs: 3000 })
    .catch((err) => console.warn(`[cctvLink] access-change notice not delivered (${err.code || err.message}); the CCTV site re-checks within seconds`));
}

module.exports = {
  SSO_TTL_S,
  SSO_AUDIENCE,
  SSO_ISSUER,
  CctvLinkError,
  mintSsoUrl,
  isCctvService,
  requireCctvService,
  fetchCameras,
  cachedCameraNames,
  notifyAccessChanged,
  _resetForTests: () => { cameraCache = { at: 0, cameras: null }; },
};
