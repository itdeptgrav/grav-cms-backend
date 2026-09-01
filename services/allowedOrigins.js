// services/allowedOrigins.js
//
// The live half of CORS origin management.
//
// The static `allowedOrigins` array at the top of server.js has always gated
// both CORS and the Socket.IO handshake, and adding a Vercel preview or a LAN
// IP meant an edit and a restart — the exact "opaque Not allowed by CORS"
// failure CLAUDE.md warns every new environment about. This adds a SECOND,
// additive list from the developer side (`ops.extraOrigins`), consulted at
// request time through the 30s settings cache.
//
// ADDITIVE ONLY. The static list can never be removed from here: the
// developer screen can open a door, it cannot close the ones the code opened
// — a mis-click in an admin UI must not be able to cut the production
// frontend off from its API. Removing a static origin stays a code change.
//
// Origins are validated at WRITE time (scheme + host + optional port, nothing
// else — no paths, no wildcards, no credentials) and re-filtered at read time
// so a bad value that somehow reached storage still cannot widen CORS.

"use strict";

/** ^http(s)://host[:port]$ — an ORIGIN, not a URL. */
const ORIGIN_RX = /^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i;

function isValidOrigin(o) {
  return ORIGIN_RX.test(String(o || "").trim());
}

/** The extra origins the settings currently grant, filtered defensively. */
async function extraOrigins() {
  try {
    const { getSetting } = require("./devConfig");
    const raw = await getSetting("ops.extraOrigins");
    return String(raw || "")
      .split(",")
      .map((x) => x.trim().replace(/\/+$/, ""))
      .filter(isValidOrigin);
  } catch {
    return [];
  }
}

/**
 * The CORS callback both the HTTP middleware and the Socket.IO handshake use.
 * `staticList` is the code-owned array from server.js; the dynamic list can
 * only ever ADD to it.
 */
function makeOriginCheck(staticList) {
  return async function originCheck(origin, cb) {
    try {
      if (!origin || staticList.includes(origin)) return cb(null, true);
      const extras = await extraOrigins();
      if (extras.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    } catch {
      // The static list is the safe answer when settings are unreachable.
      if (!origin || staticList.includes(origin)) return cb(null, true);
      return cb(new Error("Not allowed by CORS"));
    }
  };
}

module.exports = { isValidOrigin, extraOrigins, makeOriginCheck };
