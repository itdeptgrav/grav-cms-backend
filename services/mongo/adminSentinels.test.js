const assert = require("node:assert/strict");
const { test } = require("node:test");

const admin = require("firebase-admin");
const { memoryStore } = require("./mongoStore");
const {
  adminSentinel,
  createFirestoreCompat,
  toDocument,
  toUpdate,
} = require("./firestoreCompat");
const { CompatTimestamp } = require("./timestamp");

/**
 * The facade against the SDK it is replacing, not against a description of it.
 *
 * `firestoreCompat.js` recognises the admin SDK's sentinels by constructor name
 * so that it does not have to import firebase-admin — a facade that depended on
 * the thing it replaces would keep that dependency alive for ever. The cost of
 * that choice is exactly this file: names are not a contract, so they get
 * checked against the SDK actually installed.
 *
 * **Why it matters more than it looks.** 239 write sites in this backend call
 * `admin.firestore.FieldValue.serverTimestamp()` rather than the facade's own
 * `FieldValue`. If one of these names drifts, those objects stop being
 * recognised as sentinels and are stored verbatim — `serverTimestamp()` becomes
 * `{}` and `increment(3)` becomes `{operand: 3}`. Every write still reports
 * success. Nothing throws. The dates simply stop existing.
 *
 * If this file fails after a firebase-admin upgrade, the fix is to add the new
 * constructor name to `adminSentinel`, not to weaken the test.
 */

const FV = admin.firestore.FieldValue;

test("every admin sentinel is still recognised by the installed SDK", () => {
  assert.deepEqual(adminSentinel(FV.serverTimestamp()), { kind: "serverTimestamp" });
  assert.deepEqual(adminSentinel(FV.delete()), { kind: "delete" });
  assert.deepEqual(adminSentinel(FV.increment(3)), { kind: "increment", by: 3 });
  assert.deepEqual(adminSentinel(FV.arrayUnion("a", "b")), {
    kind: "arrayUnion",
    values: ["a", "b"],
  });
  assert.deepEqual(adminSentinel(FV.arrayRemove("c")), {
    kind: "arrayRemove",
    values: ["c"],
  });
});

test("an ordinary object is not mistaken for a sentinel", () => {
  for (const v of [null, undefined, 1, "s", {}, { operand: 3 }, new Date(), []])
    assert.equal(adminSentinel(v), null);
});

test("an admin patch becomes the right Mongo operators", () => {
  const now = new Date("2026-09-19T10:00:00Z");
  const u = toUpdate(
    {
      at: FV.serverTimestamp(),
      gone: FV.delete(),
      hits: FV.increment(5),
      tags: FV.arrayUnion("x"),
      old: FV.arrayRemove("y"),
      plain: 1,
    },
    { now },
  );
  assert.deepEqual(u.$set, { at: now, plain: 1 });
  assert.deepEqual(u.$unset, { gone: "" });
  assert.deepEqual(u.$inc, { hits: 5 });
  assert.deepEqual(u.$addToSet, { tags: { $each: ["x"] } });
  assert.deepEqual(u.$pull, { old: { $in: ["y"] } });
});

test("an admin sentinel on a replacing write resolves the same way", () => {
  const now = new Date("2026-09-19T10:00:00Z");
  const d = toDocument({ at: FV.serverTimestamp(), hits: FV.increment(2) }, { now });
  assert.deepEqual(d, { at: now, hits: 2 });
});

test("serverTimestamp through the facade stores a real date, not an empty object", async () => {
  /* The failure this whole file exists to prevent: a write that succeeds and
     stores `{}`. */
  const db = createFirestoreCompat(memoryStore({}));
  await db.collection("t").doc("a").set({ at: FV.serverTimestamp(), n: 1 });
  const stored = await db.collection("t").doc("a").get();
  const value = stored.data().at;
  assert.ok(
    value instanceof CompatTimestamp,
    `stored ${JSON.stringify(value)} instead of a timestamp`,
  );
  assert.ok(Math.abs(value.toMillis() - Date.now()) < 5000);
});

test("increment through the facade actually increments", async () => {
  const db = createFirestoreCompat(memoryStore({ t: [{ _id: "a", hits: 1 }] }));
  await db.collection("t").doc("a").update({ hits: FV.increment(4) });
  assert.equal((await db.collection("t").doc("a").get()).data().hits, 5);
});

test("an admin Timestamp written back is stored as a date", async () => {
  /* Code reads a Timestamp from one document and writes it to another. The
     admin SDK's Timestamp carries `_seconds`/`_nanoseconds`, and storing that
     object literally would make the field unqueryable and unsortable. */
  const db = createFirestoreCompat(memoryStore({}));
  const ts = admin.firestore.Timestamp.fromMillis(Date.UTC(2026, 0, 1));
  await db.collection("t").doc("a").set({ at: ts });
  const snap = await db.collection("t").doc("a").get();
  assert.ok(snap.data().at instanceof CompatTimestamp);
  assert.equal(snap.data().at.toMillis(), Date.UTC(2026, 0, 1));
});

test("the facade does not import firebase-admin", () => {
  /* The dependency must not survive the migration. This test may import the
     SDK — it is checking compatibility — but the facade may not. */
  const src = require("node:fs")
    .readFileSync(require.resolve("./firestoreCompat.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(
    /require\(["']firebase-admin["']\)/.test(src),
    false,
    "firestoreCompat.js now depends on the SDK it replaces",
  );
});
