/**
 * GRAV-CMS-BACKEND/services/mediaRange.js
 *
 * Byte-range replies for the media proxy, so a video is streamed in the pieces
 * a player asks for instead of whole. Measured tail: `media/view` returned
 * 100 MB+ for a single heavy record because it piped the entire file even when
 * a viewer watched a few seconds.
 *
 * ## How a browser uses this
 *
 * A `<video>` first issues an ordinary GET. If the reply says `Accept-Ranges:
 * bytes`, the player then requests only the byte ranges it needs as the viewer
 * plays and seeks — often 5-10% of the file. Without that header it has no
 * choice but to download everything. So the single most important thing here is
 * advertising `Accept-Ranges` on EVERY response; the 206 handling is what makes
 * the follow-up range requests cheap.
 *
 * ## Nothing else changes
 *
 * An image or a PDF is fetched in one shot and sends no `Range`, so it takes the
 * 200 branch and behaves exactly as before — now merely carrying an
 * `Accept-Ranges` header it is free to ignore. A plain download is unaffected.
 * The decision is pure so it can be tested without Drive or a socket.
 */

/**
 * The status and headers for a media reply.
 *
 * `range` — the client's raw `Range` header (or null).
 * `driveStatus` — what Drive answered the byte request with. 206 means it
 *   honoured the range; anything else means it sent the whole file, and we must
 *   NOT claim 206 over a full body.
 * `contentRange` / `contentLength` — Drive's own headers, forwarded verbatim
 *   because Drive is the authority on the bytes it just sent.
 * `size` — total file size, a fallback for Content-Length on a full reply.
 */
function mediaResponse({ range, driveStatus, contentRange, contentLength, size }) {
  const headers = { "Accept-Ranges": "bytes" };

  /* A partial reply ONLY when the client asked for a range and Drive actually
     delivered one. Sending 206 over a full body, or a Content-Range Drive did
     not confirm, is how a player ends up stalling or re-downloading. */
  if (range && driveStatus === 206 && contentRange) {
    headers["Content-Range"] = contentRange;
    if (contentLength != null) headers["Content-Length"] = String(contentLength);
    return { status: 206, headers };
  }

  /* Full reply. Content-Length lets the browser show progress and, together
     with Accept-Ranges, is what tells it seeking is available at all. */
  const len = contentLength != null ? contentLength : size != null ? size : null;
  if (len != null) headers["Content-Length"] = String(len);
  return { status: 200, headers };
}

/**
 * Parse a single `bytes=start-end` range against a known size.
 *
 * Not used to fetch (Drive is handed the raw header and does its own parsing),
 * but kept for validation and tests: it is the shape the proxy reasons about,
 * and a malformed or unsatisfiable range is worth recognising rather than
 * forwarding blindly. Returns null for anything it does not understand — a
 * suffix range, a multi-range, or one that runs past the file.
 */
function parseByteRange(rangeHeader, size) {
  if (typeof rangeHeader !== "string") return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const hasStart = m[1] !== "";
  const hasEnd = m[2] !== "";

  let start;
  let end;
  if (hasStart) {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : (size != null ? size - 1 : undefined);
  } else if (hasEnd) {
    /* Suffix: the last N bytes. Needs the size to resolve. */
    if (size == null) return null;
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    return null; // "bytes=-" is meaningless
  }

  if (!Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) return null;
  if (start < 0 || (end !== undefined && end < start)) return null;
  if (size != null && start >= size) return null; // unsatisfiable

  return { start, end };
}

module.exports = { mediaResponse, parseByteRange };
