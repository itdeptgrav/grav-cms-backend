const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  convertValue,
  illegalKeys,
  isTimestamp,
  timestampToDate,
  toMongoDocument,
} = require("./convert");

/**
 * The half of the migration that cannot be fixed afterwards.
 *
 * The facade makes CODE work against MongoDB. This makes the DATA work, and a
 * value written wrongly here has nothing left saying what it was meant to be.
 */

/* A Firestore Timestamp as the admin SDK hands it over. */
const liveTimestamp = (seconds, nanos = 0) => ({
  seconds,
  nanoseconds: nanos,
  toDate: () => new Date(seconds * 1000 + Math.floor(nanos / 1e6)),
});

/* The same thing after a JSON round trip, which is how it arrives from an
   export rather than from a live read. */
const plainTimestamp = (seconds, nanos = 0) => ({
  _seconds: seconds,
  _nanoseconds: nanos,
});

/* ── Timestamps ───────────────────────────────────────────────────────────── */

test("a live Timestamp becomes a Date", () => {
  const d = convertValue(liveTimestamp(1_760_000_000));
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1_760_000_000_000);
});

test("an exported Timestamp becomes the same Date", () => {
  /* Both shapes reach this code — a live migration reads objects with
     `.toDate()`, an export reads `{_seconds,_nanoseconds}`. They must not
     disagree. */
  assert.equal(
    convertValue(plainTimestamp(1_760_000_000)).getTime(),
    convertValue(liveTimestamp(1_760_000_000)).getTime(),
  );
});

test("nanoseconds round down to milliseconds, and that is the loss taken", () => {
  /* BSON dates are millisecond-precision. Nothing in this product measures
     finer, but the loss is real and is written down rather than hidden. */
  const d = timestampToDate(plainTimestamp(1_000, 999_999));
  assert.equal(d.getTime(), 1_000_000);
});

test("an existing Date is left alone", () => {
  const d = new Date("2026-09-19T10:00:00Z");
  assert.equal(convertValue(d), d);
});

test("something that merely looks date-ish is not mistaken for a Timestamp", () => {
  /* `{seconds: 5}` is somebody's duration field, not a timestamp. Converting it
     would silently turn a number into a date. */
  assert.equal(isTimestamp({ seconds: 5 }), false);
  assert.equal(isTimestamp({ _seconds: 5 }), false);
  assert.deepEqual(convertValue({ seconds: 5 }), { seconds: 5 });
});

/* ── The other Firestore types ────────────────────────────────────────────── */

test("a DocumentReference keeps its path, which is all there is to keep", () => {
  const ref = { path: "cowork_tasks/T1", id: "T1", collection: () => {} };
  assert.equal(convertValue(ref), "cowork_tasks/T1");
});

test("a GeoPoint becomes the two numbers it already was", () => {
  assert.deepEqual(convertValue({ latitude: 12.9, longitude: 77.5 }), {
    latitude: 12.9,
    longitude: 77.5,
  });
});

test("a Buffer passes through for the driver to store as Binary", () => {
  const b = Buffer.from("hello");
  assert.equal(convertValue(b), b);
});

/* ── Absence ──────────────────────────────────────────────────────────────── */

test("undefined fields are dropped, because Firestore never stored them", () => {
  assert.deepEqual(convertValue({ a: 1, b: undefined }), { a: 1 });
});

test("undefined INSIDE an array becomes null, so indices do not shift", () => {
  /* Dropping it would move every element after it — a silent reordering of
     somebody's list. */
  assert.deepEqual(convertValue([1, undefined, 3]), [1, null, 3]);
});

test("null is a value and stays one", () => {
  assert.deepEqual(convertValue({ a: null }), { a: null });
});

/* ── Nesting ──────────────────────────────────────────────────────────────── */

test("timestamps are converted however deep they are", () => {
  const out = convertValue({
    a: { b: [{ at: liveTimestamp(1_000) }] },
  });
  assert.ok(out.a.b[0].at instanceof Date);
  assert.equal(out.a.b[0].at.getTime(), 1_000_000);
});

test("a cycle is refused rather than overflowing the stack", () => {
  /* Firestore cannot store one, but a document assembled in memory can carry
     one, and the unguarded recursion is a stack overflow nobody can read. */
  const a = { name: "a" };
  a.self = a;
  assert.throws(() => convertValue(a), /Cyclic/);
});

/* ── Field names ──────────────────────────────────────────────────────────── */

test("illegal field names are reported, never rewritten", () => {
  /* Renaming somebody's field to make an import succeed is a silent data
     change, and the import succeeding is worth less than knowing. */
  const found = illegalKeys({
    ok: 1,
    $bad: 2,
    "also.bad": 3,
    nested: { $deep: 4 },
    list: [{ "x.y": 5 }],
  });
  assert.ok(found.includes("$bad"));
  assert.ok(found.includes("also.bad"));
  assert.ok(found.includes("nested.$deep"));
  assert.ok(found.includes("list[0].x.y"));
  assert.equal(found.includes("ok"), false);
});

test("a clean document reports nothing", () => {
  assert.deepEqual(illegalKeys({ a: 1, b: { c: [1, 2] }, d: new Date() }), []);
});

/* ── Whole documents ──────────────────────────────────────────────────────── */

test("the id becomes _id, as a string", () => {
  /* Not an ObjectId. Every id already written into another document, a URL or
     a notification has to keep resolving. */
  const doc = toMongoDocument("T-634", { title: "x" });
  assert.equal(doc._id, "T-634");
  assert.equal(typeof doc._id, "string");
  assert.equal(doc.title, "x");
});

test("a numeric id is still stored as a string", () => {
  assert.strictEqual(toMongoDocument(12345, {})._id, "12345");
});

test("a subcollection document records its parent", () => {
  /* This is how the flattening in firestoreCompat finds it again. */
  const doc = toMongoDocument("m1", { text: "hi" }, { parentId: "T1" });
  assert.equal(doc._parentId, "T1");
});

test("a top-level document carries no parent field at all", () => {
  assert.equal("_parentId" in toMongoDocument("T1", {}), false);
});

test("an empty document is still a document", () => {
  assert.deepEqual(toMongoDocument("T1", {}), { _id: "T1" });
  assert.deepEqual(toMongoDocument("T1", null), { _id: "T1" });
});
