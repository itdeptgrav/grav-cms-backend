// middleware/conditionalGet.js
//
// "You already have this" — answered in 200 bytes instead of 200 KB.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// `GET /api/employees/all` sent 63 MB in a week over 320 calls: the same
// ~192 KB roster, re-sent to five different HR pages every time somebody
// navigated. The browser had it already; nothing let it say so.
//
// Express does attach a weak ETag to res.json, but the freshness check does
// not survive this app's response pipeline (measured: a request carrying the
// exact ETag back still got a full 200). Rather than depend on that, this
// answers the conditional request itself, before the body is written.
//
// ── HOW ─────────────────────────────────────────────────────────────────────
// A strong ETag over the serialized body. If the request carried the same one
// in `If-None-Match`, the answer is 304 with no body at all — the client keeps
// what it has. The server still did the work; what is saved is the wire, which
// on a Mumbai-database/Oregon-server/Mumbai-browser path is most of the wait.
//
// `Cache-Control: private, no-cache` is deliberate and is not a contradiction:
// "private" — never store this in a shared cache, it is one person's data;
// "no-cache" — the browser may keep it but must revalidate before reusing it.
// So the client always asks, and the answer is usually 304. Nothing is ever
// served stale by the browser without asking, which is what makes this safe
// for payroll and attendance data.
//
// ── WHAT IT DOES NOT DO ─────────────────────────────────────────────────────
// Only GET, only 200, only JSON. Anything else passes through untouched: a
// 304 for a write, or for an error, would be a bug that hides itself.

"use strict";

const crypto = require("crypto");

/** Hash of exactly the bytes we would have sent. */
function etagOf(payload) {
  return `"${crypto.createHash("sha1").update(payload).digest("base64")}"`;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.minBytes=1024]  below this the round trip costs more
 *                                       than the body; not worth a header.
 */
function conditionalGet({ minBytes = 1024 } = {}) {
  return function conditionalGetMiddleware(req, res, next) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    const json = res.json.bind(res);
    res.json = function conditionalJson(body) {
      try {
        if (res.statusCode !== 200) return json(body);

        const payload = JSON.stringify(body);
        if (!payload || payload.length < minBytes) return json(body);

        const tag = etagOf(payload);
        res.setHeader("ETag", tag);
        res.setHeader("Cache-Control", "private, no-cache");

        /* A client may send several, and a proxy may weaken ours; compare
           against both forms so a `W/` prefix does not defeat the match. */
        const asked = String(req.headers["if-none-match"] || "");
        if (asked) {
          const bare = tag.replace(/^W\//, "");
          const matched = asked
            .split(",")
            .map((t) => t.trim().replace(/^W\//, ""))
            .some((t) => t === bare || t === "*");
          if (matched) {
            res.status(304);
            /* 304 must carry no body — removing the length header as well,
               or the client waits for bytes that never arrive. */
            res.removeHeader("Content-Type");
            res.removeHeader("Content-Length");
            return res.end();
          }
        }

        res.setHeader("Content-Type", "application/json; charset=utf-8");
        return res.send(payload);
      } catch (err) {
        /* Never let a caching nicety cost a response. */
        console.warn("[conditional-get]", err.message);
        return json(body);
      }
    };

    next();
  };
}

module.exports = conditionalGet;
module.exports.etagOf = etagOf;
