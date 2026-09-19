const assert = require("node:assert/strict");
const { test } = require("node:test");

const { memoryStore } = require("./mongoStore");
const { createFirestoreCompat, FieldValue } = require("./firestoreCompat");
const { CompatTimestamp, reviveTimestamps } = require("./timestamp");

/**
 * The single largest source of silent breakage in this migration.
 *
 * MongoDB stores a BSON `Date`; Firestore returns a `Timestamp`. Twelve call
 * sites in this backend call `.toDate()`, which a `Date` does not have, and the
 * Cowork frontend parses `{_seconds, _nanoseconds}`, which a `Date` does not
 * serialise to. Getting either wrong breaks every deadline, timer and
 * "started at" on every screen — and does it quietly.
 */

const fresh = (seed) => createFirestoreCompat(memoryStore(seed));
const AT = Date.UTC(2026, 8, 19, 10, 30, 0); // 2026-09-19T10:30:00Z

/* ── Parity with Firestore's Timestamp ────────────────────────────────────── */

test("it answers toDate(), which is what 12 call sites use", () => {
  const ts = CompatTimestamp.fromMillis(AT);
  assert.ok(ts.toDate() instanceof Date);
  assert.equal(ts.toDate().getTime(), AT);
});

test("it serialises to the shape the browser already parses", () => {
  /* `lib/legacy/tasks.ts`, `legacy/index.ts`, `workMap.ts` and
     `priorityDeadline.ts` all read `_seconds`. An ISO string here makes every
     one of them return null. */
  const json = JSON.parse(JSON.stringify({ at: CompatTimestamp.fromMillis(AT) }));
  assert.deepEqual(Object.keys(json.at).sort(), ["_nanoseconds", "_seconds"]);
  assert.equal(json.at._seconds, Math.floor(AT / 1000));
  assert.equal(json.at._nanoseconds, 0);
});

test("toMillis round-trips exactly", () => {
  assert.equal(CompatTimestamp.fromMillis(AT).toMillis(), AT);
  assert.equal(CompatTimestamp.fromMillis(AT + 123).toMillis(), AT + 123);
});

test("it behaves in arithmetic and comparison", () => {
  /* `valueOf` is what makes `new Date(ts)` and `a > b` work — both appear in
     code that handles deadlines. */
  const a = CompatTimestamp.fromMillis(AT);
  const b = CompatTimestamp.fromMillis(AT + 5000);
  assert.ok(b > a);
  assert.equal(new Date(a).getTime(), AT);
  assert.equal(b - a, 5000);
});

test("a pre-epoch instant does not read as the wrong second", () => {
  /* `ms % 1000` would give a negative remainder here. */
  const before = -1500;
  const ts = CompatTimestamp.fromMillis(before);
  assert.equal(ts.toMillis(), before);
  assert.equal(ts.toDate().getTime(), before);
});

test("isEqual compares value, not identity", () => {
  assert.ok(
    CompatTimestamp.fromMillis(AT).isEqual(CompatTimestamp.fromMillis(AT)),
  );
  assert.equal(
    CompatTimestamp.fromMillis(AT).isEqual(CompatTimestamp.fromMillis(AT + 1)),
    false,
  );
});

test("it is immutable, as Firestore's is", () => {
  const ts = CompatTimestamp.fromMillis(AT);
  assert.throws(() => {
    "use strict";
    ts.seconds = 0;
  });
});

test("it deliberately does NOT pretend to be a Date", () => {
  /* Firestore's Timestamp has no getTime() either, so code calling one was
     already broken. Adding it here would hide that rather than fix it. */
  const ts = CompatTimestamp.fromMillis(AT);
  assert.equal(typeof ts.getTime, "undefined");
});

/* ── Reviving ─────────────────────────────────────────────────────────────── */

test("dates are revived however deeply they are nested", () => {
  const out = reviveTimestamps({
    at: new Date(AT),
    nested: { list: [{ when: new Date(AT) }] },
  });
  assert.ok(out.at instanceof CompatTimestamp);
  assert.ok(out.nested.list[0].when instanceof CompatTimestamp);
});

test("reviving leaves everything that is not a date alone", () => {
  const buf = Buffer.from("x");
  const out = reviveTimestamps({ n: 1, s: "a", b: true, z: null, buf });
  assert.deepEqual({ ...out, buf: undefined }, { n: 1, s: "a", b: true, z: null, buf: undefined });
  assert.equal(out.buf, buf);
});

test("a cycle does not hang the revive", () => {
  const a = { name: "a" };
  a.self = a;
  assert.doesNotThrow(() => reviveTimestamps(a));
});

/* ── Through the facade, both directions ──────────────────────────────────── */

test("a date written comes back as a Timestamp", async () => {
  const db = fresh({});
  await db.collection("t").doc("a").set({ at: new Date(AT) });
  const snap = await db.collection("t").doc("a").get();
  assert.ok(snap.data().at instanceof CompatTimestamp);
  assert.equal(snap.data().at.toDate().getTime(), AT);
});

test("serverTimestamp comes back as a Timestamp too", async () => {
  /* 239 write sites use it. */
  const db = fresh({});
  await db.collection("t").doc("a").set({ at: FieldValue.serverTimestamp() });
  const at = (await db.collection("t").doc("a").get()).data().at;
  assert.ok(at instanceof CompatTimestamp);
  assert.ok(Math.abs(at.toMillis() - Date.now()) < 5000);
});

test("a Timestamp read back and written again stays a real date", async () => {
  /* The round trip that would otherwise rot the data: reading gives an object,
     and storing that object literally would put `{seconds, nanoseconds}` in the
     database where a date belongs — unqueryable and unsortable, and it would
     look fine until somebody sorted by it. */
  const db = fresh({});
  await db.collection("t").doc("a").set({ at: new Date(AT) });
  const read = (await db.collection("t").doc("a").get()).data();
  await db.collection("t").doc("b").set({ at: read.at });

  const stored = await memoryFor(db, "t", "b");
  assert.ok(stored.at instanceof Date, `stored ${JSON.stringify(stored.at)}`);
  assert.equal(stored.at.getTime(), AT);
  assert.ok((await db.collection("t").doc("b").get()).data().at instanceof CompatTimestamp);
});

test("the same holds through update(), not just set()", async () => {
  const db = fresh({ t: [{ _id: "a", at: new Date(0) }] });
  const read = (await db.collection("t").doc("a").get()).data();
  await db.collection("t").doc("a").update({ copied: read.at });
  const stored = await memoryFor(db, "t", "a");
  assert.ok(stored.copied instanceof Date);
  assert.equal(stored.copied.getTime(), 0);
});

test("dates stay sortable in the database", async () => {
  /* The whole reason storage keeps a BSON Date rather than the Timestamp
     object: a query has to be able to order by it. */
  const db = fresh({
    t: [
      { _id: "1", at: new Date(AT + 2000) },
      { _id: "2", at: new Date(AT) },
      { _id: "3", at: new Date(AT + 1000) },
    ],
  });
  const snap = await db.collection("t").orderBy("at").get();
  assert.deepEqual(snap.docs.map((d) => d.id), ["2", "3", "1"]);
});

/* Reach into the store to see what was actually persisted, not what the facade
   chooses to show. */
async function memoryFor(db, collection, id) {
  const snap = await db.collection(collection).doc(id).get();
  /* `snap.ref._store` is the injected store; going through it skips `strip`. */
  return snap.ref._store.findOne(collection, { _id: id });
}
