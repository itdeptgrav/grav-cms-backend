const assert = require("node:assert/strict");
const { test } = require("node:test");
const { etagFor, matchesEtag, sendJsonCached } = require("./httpCache");

/* ── The ETag itself ──────────────────────────────────────────────────────── */

test("identical payloads get identical ETags; different ones differ", () => {
  const a = { employees: [{ id: "E1", name: "Ray" }] };
  const b = { employees: [{ id: "E1", name: "Ray" }] };
  const c = { employees: [{ id: "E1", name: "Priya" }] };
  assert.equal(etagFor(a), etagFor(b), "same data must revalidate as unchanged");
  assert.notEqual(etagFor(a), etagFor(c), "a real change must break the ETag");
});

test("the ETag is weak and shaped as length-hash", () => {
  const e = etagFor({ x: 1 });
  assert.match(e, /^W\/"\d+-[A-Za-z0-9+/=]+"$/);
});

test("a string payload and its JSON produce the same ETag", () => {
  const obj = { a: 1 };
  assert.equal(etagFor(obj), etagFor(JSON.stringify(obj)));
});

/* ── Matching what the client holds ───────────────────────────────────────── */

test("a client holding the current ETag matches", () => {
  const e = etagFor({ a: 1 });
  assert.equal(matchesEtag(e, e), true);
});

test("weak and strong forms of the same validator match", () => {
  assert.equal(matchesEtag('"abc"', 'W/"abc"'), true);
  assert.equal(matchesEtag('W/"abc"', '"abc"'), true);
});

test("a comma list and a star both match", () => {
  const e = etagFor({ a: 1 });
  assert.equal(matchesEtag(`"other", ${e}`, e), true);
  assert.equal(matchesEtag("*", e), true);
});

test("a stale or absent validator does not match", () => {
  const e = etagFor({ a: 1 });
  assert.equal(matchesEtag('W/"stale"', e), false);
  assert.equal(matchesEtag("", e), false);
  assert.equal(matchesEtag(undefined, e), false);
  assert.equal(matchesEtag(null, e), false);
});

/* ── The response wrapper ─────────────────────────────────────────────────── */

function fakeRes() {
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    ended: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

test("a first request gets the full body and an ETag", () => {
  const payload = { employees: [1, 2, 3] };
  const res = fakeRes();
  const sent304 = sendJsonCached({ headers: {} }, res, payload);
  assert.equal(sent304, false);
  assert.deepEqual(res.body, payload, "the body must be sent in full");
  assert.ok(res.headers.etag, "an ETag must be set");
  assert.match(res.headers["cache-control"], /must-revalidate/);
});

test("a revalidation with the current ETag gets a bare 304, no body", () => {
  const payload = { employees: [1, 2, 3] };
  const etag = etagFor(payload);
  const res = fakeRes();
  const sent304 = sendJsonCached({ headers: { "if-none-match": etag } }, res, payload);
  assert.equal(sent304, true);
  assert.equal(res.statusCode, 304);
  assert.equal(res.ended, true);
  assert.equal(res.body, undefined, "a 304 must carry no body — that is the saving");
});

test("a revalidation with a STALE ETag gets the fresh body", () => {
  /* The data changed since the client last read it — they must receive the new
     version, never a 304. This is the freshness guarantee. */
  const res = fakeRes();
  const sent304 = sendJsonCached(
    { headers: { "if-none-match": 'W/"old"' } },
    res,
    { employees: [9] },
  );
  assert.equal(sent304, false);
  assert.deepEqual(res.body, { employees: [9] });
  assert.equal(res.statusCode, 200);
});

test("a client that does not revalidate is answered exactly as before", () => {
  /* The safety property: a caller sending no If-None-Match (e.g. cache:no-store)
     gets the full body, identical to the un-cached route. Nothing breaks by
     adding this. */
  const payload = { a: 1 };
  const res = fakeRes();
  sendJsonCached({ headers: {} }, res, payload);
  assert.deepEqual(res.body, payload);
  assert.equal(res.statusCode, 200);
});

/* ── The routes are actually wired to it (Layer 1) ────────────────────────── */

const { readFileSync } = require("node:fs");

test("the three hot read routes send through the ETag helper", () => {
  const routes = readFileSync("routes/task_routes/cowork.js", "utf8");
  /* list-members — the 47MB duplicate — plus the two smaller repeat-readers. */
  assert.match(routes, /sendJsonCached\(req, res, \{ employees: safe \}\)/);
  assert.match(routes, /sendJsonCached\(req, res, \{ success: true, blockedDates: blocked \}\)/);
  assert.match(routes, /sendJsonCached\(req, res, \{ success: true, primaryManager, secondaryManager \}\)/);
  /* And nothing here 500s for lack of the import. */
  assert.match(routes, /require\("\.\.\/\.\.\/services\/httpCache"\)/);
});

/* ── The directory's DB read is cached and invalidated on write (Layer 2) ─── */

test("the employee directory has a TTL cache that a write clears", () => {
  /*
   * Layer 2 already existed for the hottest collection: `listCoworkEmployees`
   * serves from a TTL cache, so 972 directory fetches do not become 972 Firestore
   * reads. The guarantee that matters is that a change is not hidden by the
   * cache — every employee write clears it.
   */
  const svc = readFileSync("services/cowork.service.js", "utf8");
  assert.match(svc, /if \(_empListCache && Date\.now\(\) < _empListCacheExp\) return _empListCache/);
  assert.match(svc, /function invalidateEmpListCache\(\)/);

  const routes = readFileSync("routes/task_routes/cowork.js", "utf8");
  /* Called on the create and edit paths, so a new or changed employee shows at
     once rather than up to the TTL later. */
  const invalidations = (routes.match(/invalidateEmpListCache\(\)/g) || []).length;
  assert.ok(invalidations >= 2, "employee writes do not clear the directory cache");
});
