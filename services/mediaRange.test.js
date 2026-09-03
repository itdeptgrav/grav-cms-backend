const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mediaResponse, parseByteRange } = require("./mediaRange");

/* ── The response shape ───────────────────────────────────────────────────── */

test("no range: a full 200 that ADVERTISES range support", () => {
  /* The single most important header — without it a video player downloads the
     whole file instead of seeking. An image/PDF/download takes this branch and
     is otherwise unchanged. */
  const r = mediaResponse({ range: null, driveStatus: 200, size: 5_000_000 });
  assert.equal(r.status, 200);
  assert.equal(r.headers["Accept-Ranges"], "bytes");
  assert.equal(r.headers["Content-Length"], "5000000");
  assert.equal(r.headers["Content-Range"], undefined);
});

test("a range Drive honoured: 206 with Drive's own Content-Range", () => {
  /* The whole point — a player asked for a slice and gets exactly that slice. */
  const r = mediaResponse({
    range: "bytes=0-1048575",
    driveStatus: 206,
    contentRange: "bytes 0-1048575/104857600",
    contentLength: 1048576,
  });
  assert.equal(r.status, 206);
  assert.equal(r.headers["Content-Range"], "bytes 0-1048575/104857600");
  assert.equal(r.headers["Content-Length"], "1048576");
  assert.equal(r.headers["Accept-Ranges"], "bytes");
});

test("a range Drive did NOT honour is never dressed up as 206", () => {
  /* If Drive sent the whole file (200), claiming 206 over a full body stalls the
     player. Fall back to a correct 200. */
  const r = mediaResponse({
    range: "bytes=0-1023",
    driveStatus: 200,
    contentLength: 104857600,
    size: 104857600,
  });
  assert.equal(r.status, 200);
  assert.equal(r.headers["Content-Range"], undefined);
  assert.equal(r.headers["Content-Length"], "104857600");
});

test("a 206 without a Content-Range is treated as a full reply", () => {
  /* Content-Range is what makes a 206 meaningful; without it, do not claim one. */
  const r = mediaResponse({ range: "bytes=0-99", driveStatus: 206, contentRange: null, size: 500 });
  assert.equal(r.status, 200);
});

test("Content-Length is optional and simply omitted when unknown", () => {
  const r = mediaResponse({ range: null, driveStatus: 200 });
  assert.equal(r.status, 200);
  assert.equal(r.headers["Accept-Ranges"], "bytes");
  assert.equal(r.headers["Content-Length"], undefined);
});

/* ── Parsing a byte range ─────────────────────────────────────────────────── */

test("a plain start-end range", () => {
  assert.deepEqual(parseByteRange("bytes=0-1023", 5000), { start: 0, end: 1023 });
  assert.deepEqual(parseByteRange("bytes=1000-1999", 5000), { start: 1000, end: 1999 });
});

test("an open-ended range runs to the last byte", () => {
  assert.deepEqual(parseByteRange("bytes=1000-", 5000), { start: 1000, end: 4999 });
});

test("a suffix range is the last N bytes", () => {
  assert.deepEqual(parseByteRange("bytes=-500", 5000), { start: 4500, end: 4999 });
});

test("unsatisfiable or malformed ranges are refused, not guessed", () => {
  assert.equal(parseByteRange("bytes=6000-7000", 5000), null); // past the end
  assert.equal(parseByteRange("bytes=2000-1000", 5000), null); // end before start
  assert.equal(parseByteRange("bytes=abc-def", 5000), null);
  assert.equal(parseByteRange("bytes=0-1,2-3", 5000), null); // multi-range
  assert.equal(parseByteRange("bytes=-", 5000), null);
  assert.equal(parseByteRange("", 5000), null);
  assert.equal(parseByteRange(null, 5000), null);
});

test("a suffix range without a known size cannot resolve", () => {
  assert.equal(parseByteRange("bytes=-500", null), null);
});

/* ── The route is wired to it ─────────────────────────────────────────────── */

const { readFileSync } = require("node:fs");

test("media/view forwards the Range and shapes the reply through the helper", () => {
  const route = readFileSync("routes/task_routes/mediaUpload.js", "utf8");
  /* The client's Range reaches Drive... */
  assert.match(route, /const range = req\.headers\.range \|\| null/);
  assert.match(route, /getDriveFileStream\(fileId, range\)/);
  /* ...and the status/headers come from the pure decision. */
  assert.match(route, /mediaResponse\(\{/);
  assert.match(route, /res\.status\(shaped\.status\)/);
  /* The immutable cache the route already had is not lost. */
  assert.match(route, /max-age=31536000, immutable/);
});

test("getDriveFileStream still works for a caller that passes no range", () => {
  /* callRecordings.js calls it with one argument. The default keeps that path
     byte-for-byte what it was. */
  const svc = readFileSync("services/mediaUpload.service.js", "utf8");
  assert.match(svc, /async function getDriveFileStream\(fileId, range = null\)/);
  assert.match(svc, /if \(range\) mediaOpts\.headers = \{ Range: range \}/);
});
