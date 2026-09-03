/**
 * GRAV-CMS-BACKEND/services/httpCache.js
 *
 * ETag / 304 for read routes whose response is often byte-identical to the one
 * just sent — the employee directory above all, which measured 99% duplicate
 * traffic. The client keeps its copy; when nothing changed the server answers
 * `304 Not Modified` with an EMPTY body instead of the full payload.
 *
 * **Nothing about the data changes.** A 304 tells the browser "use what you
 * already have", and it does — the reader sees the same bytes. The only thing
 * saved is re-sending what they already hold. A client that does not revalidate
 * (sends no `If-None-Match`) is answered exactly as before, in full, so this is
 * safe to add to a route whether or not any caller uses it yet.
 *
 * The pieces are split so the decision is pure and testable: `etagFor` and
 * `matchesEtag` never touch a request or a response.
 */

const crypto = require("crypto");

/**
 * A stable, WEAK ETag for a JSON-serialisable payload.
 *
 * Weak (`W/`) because it is a semantic marker, not a promise of byte-for-byte
 * identity down to transfer encoding — which is exactly right for "is this the
 * same directory". Length is folded in ahead of the hash so two payloads can
 * never collide on the hash alone.
 */
function etagFor(payload) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const hash = crypto.createHash("sha1").update(body).digest("base64");
  return `W/"${Buffer.byteLength(body)}-${hash}"`;
}

/**
 * Does the client already hold this exact representation?
 *
 * `If-None-Match` is a comma-separated list and may be `*`. A weak validator
 * comparison ignores the `W/` prefix, so `"abc"` and `W/"abc"` match — which is
 * what lets a value the browser echoes back from a weak ETag still match.
 */
function matchesEtag(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const strip = (t) => t.trim().replace(/^W\//, "");
  const want = strip(etag);
  return ifNoneMatch
    .split(",")
    .map((t) => t.trim())
    .some((t) => t === "*" || strip(t) === want);
}

/**
 * Send JSON with an ETag, or a bare 304 when the client's copy is current.
 *
 * Returns `true` when it answered 304 (the caller has nothing more to do) and
 * `false` when it sent the body — mostly for tests and symmetry; a route can
 * ignore the return and simply `return sendJsonCached(...)`.
 *
 * `maxAge` seconds of freshness before the browser revalidates; 0 with
 * `must-revalidate` means "keep a copy but check every time", so the payload is
 * re-sent only when it actually changed and the reader never sees stale data.
 */
function sendJsonCached(req, res, payload, { maxAge = 0, scope = "private" } = {}) {
  const etag = etagFor(payload);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", `${scope}, max-age=${maxAge}, must-revalidate`);

  if (matchesEtag(req.headers && req.headers["if-none-match"], etag)) {
    res.status(304).end();
    return true;
  }
  res.json(payload);
  return false;
}

module.exports = { etagFor, matchesEtag, sendJsonCached };
