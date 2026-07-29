// config/jwt.js
//
// One signing secret, one place.
//
// The literal `"grav_clothing_secret_key"` appears as a fallback at 31 call
// sites, and a second literal `"grav_clothing_secret_key_2024"` at 7 more. A
// fallback secret is not a safety net — it is a published signing key, because
// the source is the same everywhere the code is. Anyone with the repository can
// mint a valid token for any role.
//
// This module refuses to start without a real secret in production, and warns
// loudly in development. New code imports SECRET from here; the existing call
// sites are migrated in a follow-up sweep so this can ship on its own.

"use strict";

const FALLBACK_DEV_SECRET = "dev-only-insecure-secret-change-me";

function resolveSecret() {
  const fromEnv = process.env.JWT_SECRET;

  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "JWT_SECRET is not set. Refusing to start in production with a " +
        "known signing key — every token would be forgeable by anyone " +
        "holding a copy of this repository.",
    );
  }

  console.warn(
    "\n[jwt] JWT_SECRET is not set. Falling back to a development-only secret.\n" +
      "[jwt] Tokens signed now are NOT secure and will not verify once the\n" +
      "[jwt] real secret is configured. Set JWT_SECRET in .env.\n",
  );
  return FALLBACK_DEV_SECRET;
}

const SECRET = resolveSecret();

// The historical secret. Kept ONLY so tokens issued before this module existed
// keep verifying through their remaining lifetime; remove once that window has
// passed. Never used for signing.
const LEGACY_SECRETS = [
  "grav_clothing_secret_key",
  "grav_clothing_secret_key_2024",
].filter((s) => s !== SECRET);

const TOKEN_TTL = "7d";
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const COOKIE_NAME = "auth_token";

/** Cookie options, consistent across login, logout and refresh. */
function cookieOptions() {
  const isProduction = process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    maxAge: TOKEN_TTL_MS,
  };
}

module.exports = {
  SECRET,
  LEGACY_SECRETS,
  TOKEN_TTL,
  TOKEN_TTL_MS,
  COOKIE_NAME,
  cookieOptions,
};
