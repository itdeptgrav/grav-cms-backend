const assert = require("node:assert/strict");
const { test } = require("node:test");

const { memoryStore } = require("./mongoStore");
const {
  FieldValue,
  autoId,
  createFirestoreCompat,
  toDocument,
  toUpdate,
} = require("./firestoreCompat");

/**
 * The facade 504 call sites will be running on.
 *
 * Every one of those sites was written against Firestore's semantics, so what
 * is being protected here is not "MongoDB works" — it is that the differences
 * between the two are absorbed rather than passed through. A difference that
 * leaks is a behaviour change in code that decides who approves work.
 */

const fresh = (seed) => createFirestoreCompat(memoryStore(seed));

/* ── The semantics that are easy to get wrong ─────────────────────────────── */

test("exists is a property, not a method", async () => {
  /* This codebase has been bitten before: `snap.exists()` reads perfectly and
     throws at runtime. */
  const db = fresh({ t: [{ _id: "a", n: 1 }] });
  const snap = await db.collection("t").doc("a").get();
  assert.equal(snap.exists, true);
  assert.equal(typeof snap.exists, "boolean", "exists became callable");
  const missing = await db.collection("t").doc("nope").get();
  assert.equal(missing.exists, false);
  assert.equal(missing.data(), undefined);
});

test("update on a missing document fails, as Firestore does", async () => {
  /* Mongo's updateOne matches nothing and reports success. 218 call sites were
     written expecting the throw; swallowing it would make deleted records
     silently un-noticed. */
  const db = fresh({});
  await assert.rejects(
    () => db.collection("t").doc("ghost").update({ n: 1 }),
    /No document to update/,
  );
});

test("set with merge creates, and merges without clearing", async () => {
  const db = fresh({});
  const ref = db.collection("t").doc("a");
  await ref.set({ a: 1 }, { merge: true });
  await ref.set({ b: 2 }, { merge: true });
  assert.deepEqual((await ref.get()).data(), { a: 1, b: 2 });
});

test("set without merge replaces the whole document", async () => {
  /* The other half of the same rule. Conflating them either loses fields or
     fails to clear them, and both are silent. */
  const db = fresh({ t: [{ _id: "a", keep: 1, drop: 2 }] });
  await db.collection("t").doc("a").set({ keep: 9 });
  assert.deepEqual((await db.collection("t").doc("a").get()).data(), { keep: 9 });
});

test("ids stay the strings they already are", async () => {
  /* Not ObjectIds. Every id already stored in another document, a URL, or the
     Mongo side of the product has to keep resolving. */
  const db = fresh({});
  await db.collection("t").doc("T-634").set({ n: 1 });
  const snap = await db.collection("t").doc("T-634").get();
  assert.equal(snap.id, "T-634");
  assert.equal(snap.exists, true);
});

test("an auto id looks like the ones already in the database", async () => {
  const id = autoId();
  assert.equal(id.length, 20);
  assert.match(id, /^[A-Za-z0-9]{20}$/);
});

/* ── Field sentinels ──────────────────────────────────────────────────────── */

test("a patch splits into the operators Mongo needs", () => {
  const now = new Date("2026-09-19T10:00:00Z");
  const u = toUpdate(
    {
      plain: 1,
      "nested.field": 2,
      at: FieldValue.serverTimestamp(),
      gone: FieldValue.delete(),
      hits: FieldValue.increment(3),
      tags: FieldValue.arrayUnion("x", "y"),
      old: FieldValue.arrayRemove("z"),
    },
    { now },
  );
  assert.deepEqual(u.$set, { plain: 1, "nested.field": 2, at: now });
  assert.deepEqual(u.$unset, { gone: "" });
  assert.deepEqual(u.$inc, { hits: 3 });
  assert.deepEqual(u.$addToSet, { tags: { $each: ["x", "y"] } });
  assert.deepEqual(u.$pull, { old: { $in: ["z"] } });
});

test("an empty patch emits no operators at all", () => {
  /* Mongo rejects an update document with no operators; Firestore accepts an
     empty patch as a no-op. */
  assert.deepEqual(toUpdate({}), {});
});

test("sentinels resolve to values on a replacing write", () => {
  /* There is nothing to union WITH on a fresh document — Firestore resolves
     them the same way. */
  const now = new Date("2026-09-19T10:00:00Z");
  const d = toDocument(
    {
      at: FieldValue.serverTimestamp(),
      tags: FieldValue.arrayUnion("x"),
      hits: FieldValue.increment(2),
      gone: FieldValue.delete(),
    },
    { now },
  );
  assert.deepEqual(d, { at: now, tags: ["x"], hits: 2 });
  assert.ok(!("gone" in d), "a deleted field was written anyway");
});

test("an unknown sentinel throws instead of being written as an object", () => {
  const bogus = { [Object.getOwnPropertySymbols(FieldValue.increment(1))[0]]: "nope" };
  assert.throws(() => toUpdate({ x: bogus }), /Unknown field sentinel/);
});

test("increment and arrayUnion actually apply", async () => {
  const db = fresh({ t: [{ _id: "a", hits: 1, tags: ["x"] }] });
  await db
    .collection("t")
    .doc("a")
    .update({ hits: FieldValue.increment(2), tags: FieldValue.arrayUnion("y", "x") });
  const d = (await db.collection("t").doc("a").get()).data();
  assert.equal(d.hits, 3);
  assert.deepEqual(d.tags, ["x", "y"], "arrayUnion duplicated an existing value");
});

/* ── Queries ──────────────────────────────────────────────────────────────── */

test("every operator the backend uses is supported", async () => {
  /* The eight measured in the codebase: ==, array-contains, in, not-in, >=,
     <=, <, !=. */
  const db = fresh({
    t: [
      { _id: "1", n: 1, who: ["E1"], s: "a" },
      { _id: "2", n: 5, who: ["E2"], s: "b" },
      { _id: "3", n: 9, who: ["E1", "E3"], s: "c" },
    ],
  });
  const ids = async (q) => (await q.get()).docs.map((d) => d.id);

  assert.deepEqual(await ids(db.collection("t").where("n", "==", 5)), ["2"]);
  assert.deepEqual(await ids(db.collection("t").where("n", "!=", 5)), ["1", "3"]);
  assert.deepEqual(await ids(db.collection("t").where("n", ">=", 5)), ["2", "3"]);
  assert.deepEqual(await ids(db.collection("t").where("n", "<", 5)), ["1"]);
  assert.deepEqual(await ids(db.collection("t").where("s", "in", ["a", "c"])), ["1", "3"]);
  assert.deepEqual(await ids(db.collection("t").where("s", "not-in", ["a"])), ["2", "3"]);
  assert.deepEqual(
    await ids(db.collection("t").where("who", "array-contains", "E1")),
    ["1", "3"],
  );
});

test("two wheres on one field are a range, not an overwrite", async () => {
  const db = fresh({ t: [{ _id: "1", n: 1 }, { _id: "2", n: 5 }, { _id: "3", n: 9 }] });
  const snap = await db.collection("t").where("n", ">=", 2).where("n", "<=", 6).get();
  assert.deepEqual(snap.docs.map((d) => d.id), ["2"]);
});

test("an unsupported operator is refused loudly", () => {
  const db = fresh({});
  assert.throws(
    () => db.collection("t").where("x", "array-contains-all", [1]),
    /Unsupported query operator/,
  );
});

test("a snapshot reports empty and size like Firestore's", async () => {
  const db = fresh({ t: [{ _id: "1", n: 1 }] });
  const some = await db.collection("t").get();
  assert.equal(some.empty, false);
  assert.equal(some.size, 1);
  const none = await db.collection("t").where("n", "==", 99).get();
  assert.equal(none.empty, true);
  assert.equal(none.size, 0);
  assert.deepEqual(none.docs, []);
});

test("orderBy and limit hold", async () => {
  const db = fresh({ t: [{ _id: "1", n: 3 }, { _id: "2", n: 1 }, { _id: "3", n: 2 }] });
  const snap = await db.collection("t").orderBy("n", "desc").limit(2).get();
  assert.deepEqual(snap.docs.map((d) => d.id), ["1", "3"]);
});

test("startAfter pages, and refuses the shape it cannot page", async () => {
  const db = fresh({ t: [{ _id: "1", n: 1 }, { _id: "2", n: 2 }, { _id: "3", n: 3 }] });
  const first = await db.collection("t").orderBy("n").limit(1).get();
  const next = await db
    .collection("t")
    .orderBy("n")
    .startAfter(first.docs[0])
    .limit(2)
    .get();
  assert.deepEqual(next.docs.map((d) => d.id), ["2", "3"]);
  /* A compound sort would need a composite comparison; approximating it would
     page wrongly and silently. */
  assert.throws(
    () => db.collection("t").orderBy("a").orderBy("b").startAfter(first.docs[0]),
    /exactly one orderBy/,
  );
});

test("storage fields never reach the caller", async () => {
  /* `_id` and `_parentId` are how this is stored, not what anybody wrote. */
  const db = fresh({ t: [{ _id: "a", _parentId: "p", real: 1 }] });
  assert.deepEqual((await db.collection("t").doc("a").get()).data(), { real: 1 });
});

/* ── Subcollections ───────────────────────────────────────────────────────── */

test("a subcollection is flattened but reads as nested", async () => {
  const db = fresh({});
  const chat = db.collection("cowork_tasks").doc("T1").collection("chat");
  await chat.doc("m1").set({ text: "hello" });
  await chat.add({ text: "world" });

  const mine = await chat.get();
  assert.equal(mine.size, 2);
  assert.deepEqual(mine.docs[0].data(), { text: "hello" });
});

test("one task's subcollection never sees another's", async () => {
  /* The flattening puts both in one physical collection, so the scoping is the
     whole safety of it. */
  const db = fresh({});
  await db.collection("cowork_tasks").doc("T1").collection("chat").add({ t: "a" });
  await db.collection("cowork_tasks").doc("T2").collection("chat").add({ t: "b" });

  const t1 = await db.collection("cowork_tasks").doc("T1").collection("chat").get();
  assert.equal(t1.size, 1);
  assert.deepEqual(t1.docs[0].data(), { t: "a" });
});

test("collectionGroup is refused rather than approximated", () => {
  assert.throws(() => fresh({}).collectionGroup("chat"), /not supported/);
});

/* ── Batches and transactions ─────────────────────────────────────────────── */

test("a batch applies every operation", async () => {
  const db = fresh({ t: [{ _id: "b", n: 1 }, { _id: "c", n: 1 }] });
  const batch = db.batch();
  batch.set(db.collection("t").doc("a"), { n: 1 });
  batch.update(db.collection("t").doc("b"), { n: 2 });
  batch.delete(db.collection("t").doc("c"));
  await batch.commit();

  assert.equal((await db.collection("t").doc("a").get()).exists, true);
  assert.equal((await db.collection("t").doc("b").get()).data().n, 2);
  assert.equal((await db.collection("t").doc("c").get()).exists, false);
});

test("a batch resolves to one WriteResult per operation, as Firestore does", async () => {
  /* Not a count, and not a `{atomic, value}` wrapper. Callers were written
     against Firestore's shape. */
  const db = fresh({ t: [{ _id: "b", n: 1 }] });
  const batch = db.batch();
  batch.set(db.collection("t").doc("a"), { n: 1 });
  batch.update(db.collection("t").doc("b"), { n: 2 });
  const results = await batch.commit();
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 2);
  assert.ok(results[0].writeTime instanceof Date);
});

test("runTransaction resolves to what the callback returned", async () => {
  /**
   * The bug this pins. Ten call sites do `const x = await db.runTransaction(...)`
   * and use `x` directly — as a document id, an HTTP status, the claimed /
   * not-claimed answer to a race. Returning `{atomic, value}` broke every one
   * of them SILENTLY, because an object is truthy: `if (claimed)` stayed true
   * whatever the transaction decided.
   */
  const db = fresh({});
  const out = await db.runTransaction(async () => "T-1234");
  assert.equal(out, "T-1234", "the callback's value was wrapped");

  assert.equal(await db.runTransaction(async () => null), null);
  assert.equal(await db.runTransaction(async () => false), false);
});

test("a transaction reads several documents at once", async () => {
  /* `taskForward.js:557` verifies a whole queue belongs to one person before
     renumbering it, and does it with `tx.getAll(...refs)` — which did not exist
     on the facade at all. */
  const db = fresh({ t: [{ _id: "1", n: 1 }, { _id: "2", n: 2 }] });
  const got = await db.runTransaction(async (tx) => {
    const refs = ["1", "2", "missing"].map((id) => db.collection("t").doc(id));
    const snaps = await tx.getAll(...refs);
    return snaps.map((s) => (s.exists ? s.data().n : null));
  });
  assert.deepEqual(got, [1, 2, null]);
});

test("every operation inside a transaction is enrolled in it", async () => {
  /**
   * The silent one. The driver only counts an operation as part of a
   * transaction if it is handed the session — otherwise the reads and writes
   * succeed OUTSIDE it and `withTransaction` commits an empty transaction. No
   * rollback, no read-conflict detection, and every compare-and-set in Cowork
   * quietly becomes a plain race. It is correct-looking under test and wrong
   * only under concurrency, which is the worst shape a bug can have.
   */
  const seen = [];
  const store = {
    async findOne(_c, _f, o) {
      seen.push(["findOne", o?.session]);
      return { _id: "a", n: 1 };
    },
    async find() {
      return [];
    },
    async replace(_c, _i, _d, o) {
      seen.push(["replace", o?.session]);
    },
    async update(_c, _i, _u, o) {
      seen.push(["update", o?.session]);
      return { matched: true };
    },
    async delete(_c, _i, o) {
      seen.push(["delete", o?.session]);
    },
    async transaction(fn) {
      return fn("SESSION");
    },
  };
  const db = createFirestoreCompat(store);
  await db.runTransaction(async (tx) => {
    const ref = db.collection("t").doc("a");
    await tx.get(ref);
    await tx.set(ref, { n: 2 });
    await tx.update(ref, { n: 3 });
    await tx.delete(ref);
  });
  assert.ok(seen.length >= 4, `only ${seen.length} operations reached the store`);
  for (const [op, session] of seen)
    assert.equal(session, "SESSION", `${op} ran outside the transaction`);
});

test("a batch is enrolled in its transaction too", async () => {
  const seen = [];
  const store = {
    async findOne() {
      return null;
    },
    async find() {
      return [];
    },
    async replace(_c, _i, _d, o) {
      seen.push(o?.session);
    },
    async update(_c, _i, _u, o) {
      seen.push(o?.session);
      return { matched: true };
    },
    async delete(_c, _i, o) {
      seen.push(o?.session);
    },
    async transaction(fn) {
      return fn("SESSION");
    },
  };
  const db = createFirestoreCompat(store);
  const batch = db.batch();
  batch.set(db.collection("t").doc("a"), { n: 1 });
  batch.delete(db.collection("t").doc("b"));
  await batch.commit();
  assert.deepEqual(seen, ["SESSION", "SESSION"]);
});

test("a transaction reads and writes through the same references", async () => {
  const db = fresh({ t: [{ _id: "a", n: 1 }] });
  await db.runTransaction(async (tx) => {
    const ref = db.collection("t").doc("a");
    const snap = await tx.get(ref);
    await tx.update(ref, { n: snap.data().n + 1 });
  });
  assert.equal((await db.collection("t").doc("a").get()).data().n, 2);
});

/* ── One command instead of one round trip per write ──────────────────────── */

/**
 * Marking a conversation read is one write per unread message. Sent one at a
 * time over a network that cost about 96ms each — forty unread messages took
 * almost four seconds before a tick turned blue. These pin the batch that goes
 * as a single command, and, more importantly, pin that it still behaves like
 * the one that did not.
 */

test("a same-collection batch of updates is sent as one command", async () => {
  const store = memoryStore({ t: [{ _id: "a", n: 1 }, { _id: "b", n: 1 }, { _id: "c", n: 1 }] });
  const sent = [];
  const bulk = store.bulk.bind(store);
  store.bulk = (collection, operations, options) => {
    sent.push({ collection, count: operations.length });
    return bulk(collection, operations, options);
  };
  const db = createFirestoreCompat(store);
  const batch = db.batch();
  for (const id of ["a", "b", "c"])
    batch.update(db.collection("t").doc(id), { n: FieldValue.increment(1) });
  const results = await batch.commit();

  assert.deepEqual(sent, [{ collection: "t", count: 3 }], "not sent as one command");
  assert.equal(results.length, 3, "still one WriteResult per operation");
  for (const id of ["a", "b", "c"])
    assert.equal((await db.collection("t").doc(id).get()).data().n, 2, `${id} was not written`);
});

test("the one-command batch still fails on a document that is not there", async () => {
  /* The whole reason the fast path is restricted to a single kind: bulkWrite
     reports one matched count for the command, so a batch of updates is the
     only shape where "all of them had to match" is unambiguous. */
  const db = createFirestoreCompat(memoryStore({ t: [{ _id: "a", n: 1 }] }));
  const batch = db.batch();
  batch.update(db.collection("t").doc("a"), { n: 2 });
  batch.update(db.collection("t").doc("gone"), { n: 2 });
  await assert.rejects(
    () => batch.commit(),
    (e) => e.code === 5 && /t\/gone/.test(e.message),
    "a missing document in a batched update no longer raises NOT_FOUND",
  );
});

test("a mixed or multi-collection batch takes the original path", async () => {
  const store = memoryStore({ t: [{ _id: "a", n: 1 }], u: [{ _id: "b", n: 1 }] });
  let used = 0;
  const bulk = store.bulk.bind(store);
  store.bulk = (...args) => { used += 1; return bulk(...args); };
  const db = createFirestoreCompat(store);

  /* Two collections. */
  const across = db.batch();
  across.update(db.collection("t").doc("a"), { n: 2 });
  across.update(db.collection("u").doc("b"), { n: 2 });
  await across.commit();

  /* One collection, but an upserting set beside an update. */
  const mixed = db.batch();
  mixed.set(db.collection("t").doc("new"), { n: 9 }, { merge: true });
  mixed.update(db.collection("t").doc("a"), { n: 3 });
  await mixed.commit();

  assert.equal(used, 0, "a batch that cannot be expressed as one command was sent as one anyway");
  assert.equal((await db.collection("t").doc("a").get()).data().n, 3);
  assert.equal((await db.collection("u").doc("b").get()).data().n, 2);
  assert.equal((await db.collection("t").doc("new").get()).data().n, 9);
});

test("a batched set carries the subcollection parent, as a single set does", async () => {
  /* `_parentId` is what scopes a flattened subcollection. A fast path that
     dropped it would file every batched chat message under no conversation. */
  const db = createFirestoreCompat(memoryStore());
  const chat = db.collection("cowork_tasks").doc("T1").collection("chat");
  const batch = db.batch();
  batch.set(chat.doc("m1"), { text: "one" });
  batch.set(chat.doc("m2"), { text: "two" });
  await batch.commit();
  const snap = await chat.get();
  assert.equal(snap.size, 2, "the batched messages are not under their task");
});
