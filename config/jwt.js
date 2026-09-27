// config/jwt.js
//
// One signing secret, one place, one verifier.
//
// SEC-0 (25 Sep 2026): the two literal fallback secrets that used to be
// accepted here as "legacy" keys were published in this repository, so anyone
// holding a copy could mint a valid session for any identity — including one
// claiming `isAdmin`. They are no longer accepted anywhere. Every CMS verifier
// goes through `verifyCmsToken` below, which knows exactly one secret: the
// configured JWT_SECRET.
//
// Consequence, deliberately accepted: a token that was signed with one of the
// published values (only possible where JWT_SECRET was unset or set to one of
// them) no longer verifies, and its holder has to sign in again.
//
// Production refuses to start without a real secret. Every environment refuses
// a secret that is one of the values ever published in this repository. Outside production a
// missing secret becomes a random per-process value — never a known string —
// so a developer without JWT_SECRET gets sessions that die on restart rather
// than sessions anybody can forge.

"use strict";

const crypto = require("crypto");
const jwt = require("jsonwebtoken");

/* SHA-256 fingerprints of secrets that have appeared in this repository.
   This is a REJECTION check for configuration, not an acceptance list: no
   token is ever verified against these values. Kept as fingerprints so the
   published strings themselves are not re-published by this file. */
const PUBLISHED_SECRET_FINGERPRINTS = new Set([
  "37d6bb0fcf70291de9d953ae5c84fa8057b1a9ec28860eba6c5bafe0bf99e56b",
  "a85aeaa3bf2345eaf699f8a9f3a3032be8a1585bcdecf71b591a93195db402dd",
  "65795ca3364794b8d8afefb7ff3eb15124d8b4915016632385b931687e425af8",
  "c3f502c755858951d6557c0a71aeff7f7d7bf37f5e53ace98afa5ae40cf20a85",
]);

const fingerprint = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

/** Exported for the startup test; the module resolves once at require time. */
function resolveSecret(env = process.env) {
  const fromEnv = String(env.JWT_SECRET || "").trim();
  const production = env.NODE_ENV === "production";

  if (fromEnv && PUBLISHED_SECRET_FINGERPRINTS.has(fingerprint(fromEnv))) {
    // In every environment: a known value is not a secret, and a server that
    // starts with one silently accepts forged sessions.
    throw new Error(
      "JWT_SECRET is set to a value that has been published in the source " +
        "repository. Refusing to start: every token would be forgeable. " +
        "Generate a new random secret.",
    );
  }

  if (fromEnv) return fromEnv;

  if (production) {
    throw new Error(
      "JWT_SECRET is not set. Refusing to start in production without a " +
        "signing secret.",
    );
  }

  console.warn(
    "\n[jwt] JWT_SECRET is not set. Using a random per-process secret: every " +
      "session ends when this process restarts. Set JWT_SECRET in .env.\n",
  );
  return crypto.randomBytes(48).toString("hex");
}

const SECRET = resolveSecret();

/**
 * Verify a CMS session token against the configured secret — and only that.
 * Throws exactly what `jwt.verify` throws, so callers keep their own
 * expired-vs-invalid handling.
 */
function verifyCmsToken(token) {
  return jwt.verify(token, SECRET);
}

const TOKEN_TTL = "7d";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COOKIE_NAME = "auth_token";

/**
 * Is the browser sending this cookie back to a DIFFERENT site than the page it
 * is on? True for cms.grav.in → an api host that is not under grav.in.
 *
 * This used to be inferred from NODE_ENV alone, which quietly breaks in the two
 * cases that matter most. A deployment that forgets NODE_ENV=production gets
 * `SameSite=Lax; Secure=false` on an https cross-site response, and every
 * browser drops the cookie on the floor — the session simply never exists, and
 * nothing in the logs says so. Meanwhile a developer running the frontend on a
 * LAN IP or a tunnel is cross-site in development and needs the opposite.
 *
 * So it is now an explicit switch, with the old behaviour as the default:
 *   CROSS_SITE_COOKIES=true   always SameSite=None; Secure  (https required)
 *   CROSS_SITE_COOKIES=false  always SameSite=Lax
 *   unset                     as before — on in production, off otherwise
 */
function crossSite() {
  const flag = String(process.env.CROSS_SITE_COOKIES || "").toLowerCase();
  if (flag === "true" || flag === "1") return true;
  if (flag === "false" || flag === "0") return false;
  return process.env.NODE_ENV === "production";
}

/**
 * Cookie options, consistent across login, logout and refresh.
 *
 * COOKIE_DOMAIN is worth setting when the backend lives under the same
 * registrable domain as the frontend — `COOKIE_DOMAIN=.grav.in` with the API on
 * api.grav.in makes this cookie visible to cms.grav.in as a FIRST-party cookie.
 * That is strictly better than the Bearer-header fallback the frontend relies
 * on otherwise: it is not subject to third-party cookie blocking, it stays
 * HttpOnly, and the frontend middleware can read it directly. Leave it unset if
 * the API is on an unrelated domain, where a Domain attribute cannot help.
 */
function cookieOptions() {
  const isCrossSite = crossSite();

  const options = {
    httpOnly: true,
    // SameSite=None is only honoured on a Secure cookie. Setting one without
    // the other produces a cookie every modern browser rejects.
    secure: isCrossSite,
    sameSite: isCrossSite ? "none" : "lax",
    maxAge: TOKEN_TTL_MS,
    // Explicit, so clearCookie() built from these options matches what was set.
    // A cleared cookie with a different path is not the same cookie.
    path: "/",
  };

  const domain = String(process.env.COOKIE_DOMAIN || "").trim();
  if (domain) options.domain = domain;

  return options;
}

/**
 * The bearer of this request's session, wherever it was put.
 *
 * GAC-AR2 (25 Sep 2026): the HttpOnly COOKIE comes first. The server sets it on
 * every login, switch and password change, so when it is present it is the
 * newest session this browser holds. The `Authorization: Bearer` copy lives in
 * localStorage and is a compatibility bridge for browsers that block the
 * third-party cookie; when both were sent and disagreed, reading the header
 * first let a STALE local token override a newer session — a revoked or
 * downgraded identity kept answering. The header is still read when there is
 * no cookie (the cross-site production case the bridge exists for).
 *
 * Bridge deletion condition: once the API is served under the frontend's
 * registrable domain with COOKIE_DOMAIN set (first-party cookie everywhere),
 * the Bearer fallback and the frontend's cms_token copy can be removed.
 *
 * @param {import("express").Request} req
 * @param {string} [cookieName] override for modules with their own cookie
 * @returns {string|null}
 */
function readToken(req, cookieName = COOKIE_NAME) {
  if (!req) return null;

  const fromCookie = req.cookies?.[cookieName];
  if (fromCookie) return fromCookie;

  // Routes mounted before cookie-parser: parse the raw header.
  const raw = req.headers?.cookie || "";
  const match = raw.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  if (match) {
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }

  const header = req.headers?.authorization || req.headers?.Authorization || "";
  if (/^Bearer\s+/i.test(header)) {
    const bearer = header.replace(/^Bearer\s+/i, "").trim();
    if (bearer) return bearer;
  }

  return null;
}

module.exports = {
  SECRET,
  verifyCmsToken,
  resolveSecret,
  TOKEN_TTL,
  TOKEN_TTL_MS,
  COOKIE_NAME,
  cookieOptions,
  readToken,
};
