// middleware/coexistence.test.js
//
// firestoreBandwidth.js and bandwidthTracker.js both wrap the SAME Firestore
// prototypes and both wrap res.end. This file exists to prove that adding the
// second one did not quietly switch the first one off.
//
// The failure it guards against is silent, which is why it is worth a test:
// both modules originally guarded on `db.__bandwidthInstrumented`, so whichever
// was instrumented second would return early, wrap nothing, and report zero
// Firestore reads forever - a number that looks like an answer.
//
//   npm test

const test = require("node:test");
const assert = require("node:assert");
const express = require("express");

const legacy = require("./firestoreBandwidth");
const tracker = require("./bandwidthTracker");

// --- A Firestore stub -------------------------------------------------------
// Just enough shape for both instrumenters: the four prototypes they patch,
// and network-free refs for the fallback lookups they do when the SDK does not
// expose a class directly.
function makeFirestore() {
  class Query {
    async get() { return { size: 7, docs: [] }; }
  }
  class CollectionReference extends Query {
    doc() { return new DocumentReference(); }
  }
  class DocumentReference {
    async get() { return { exists: true }; }
    async set() { return {}; }
    async update() { return {}; }
    async delete() { return {}; }
  }
  class WriteBatch {
    set() { return this; }
    update() { return this; }
    delete() { return this; }
    async commit() { return []; }
  }

  const db = {
    collection: () => new CollectionReference(),
    batch: () => new WriteBatch(),
  };
  const admin = {
    firestore: { DocumentReference, CollectionReference, Query, WriteBatch },
  };
  return { db, admin, DocumentReference, Query };
}

test("both bandwidth meters run at once", async (t) => {
  const { db, admin, DocumentReference, Query } = makeFirestore();

  // The order server.js uses: legacy first, then the tracker.
  legacy.instrumentFirestore(admin, db);
  tracker.instrumentFirestore(admin, db);

  const app = express();
  app.use(tracker.middleware);      // wire-byte meter, mounted early
  app.use(legacy.bandwidthMiddleware); // document meter, in its original slot

  app.get("/cowork/probe", async (_req, res) => {
    await new DocumentReference().get();   // 1 read, 1 doc
    await new Query().get();               // 1 read, 7 docs
    await new DocumentReference().set({}); // 1 write
    res.json({ ok: true, padding: "x".repeat(2000) });
  });

  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  await fetch(`${base}/cowork/probe`).then((r) => r.json());
  await new Promise((r) => setTimeout(r, 100));

  // What the legacy meter reports, read through its own public handler.
  const legacyStats = await new Promise((resolve) => {
    legacy.bandwidthStatsHandler({}, { json: resolve });
  });
  const legacyRow = legacyStats.routes.find((r) => r.route.includes("/cowork/probe"));

  // What the new meter reports.
  const trackerRow = tracker
    .snapshot()
    .scopes.route.find((r) => r.key.includes("/cowork/probe"));

  await t.test("the legacy document meter still counts", () => {
    assert.ok(legacyRow, "legacy meter recorded nothing - it was disabled");
    assert.strictEqual(legacyRow.docsReadTotal, 8, "1 doc + 7 from the query");
    assert.strictEqual(legacyRow.writesTotal, 1);
  });

  await t.test("the new wire meter counts the same request independently", () => {
    assert.ok(trackerRow, "tracker recorded nothing");
    assert.strictEqual(trackerRow.fsDocsRead, 8);
    assert.strictEqual(trackerRow.fsWrites, 1);
    assert.ok(trackerRow.bytesOut > 2000, `bytesOut ${trackerRow.bytesOut}`);
  });

  await t.test("neither meter swallowed the response", async () => {
    const body = await fetch(`${base}/cowork/probe`).then((r) => r.json());
    assert.strictEqual(body.ok, true);
  });

  await t.test("the legacy stats endpoint still answers", () => {
    assert.ok(Array.isArray(legacyStats.routes));
    assert.ok(legacyStats.generatedAt);
  });

  server.close();
});
