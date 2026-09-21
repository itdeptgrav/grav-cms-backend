const assert = require("node:assert/strict");
const { test } = require("node:test");

const { memoryStore } = require("./mongoStore");
const { createFirestoreCompat } = require("./firestoreCompat");
const { CompatTimestamp } = require("./timestamp");
const { ACCESS, AccessError, decodeValue, execute } = require("./dataAccess");

/**
 * The policy that stands where Firestore's security rules stood.
 *
 * The rules were never in this repository — only in the Firebase console — so
 * this file is the only written statement of who may read and write what once
 * the browser's reads come through the server. Every test here is a sentence
 * of that policy, and the ones that matter most are the refusals.
 */

const EMP = { employeeId: "E1", role: "employee" };
const OTHER = { employeeId: "E9", role: "employee" };
const CEO = { employeeId: "E0", role: "ceo" };

const fresh = (seed = {}) => createFirestoreCompat(memoryStore(seed));

const refused = (p, status = 403) =>
  assert.rejects(p, (e) => e instanceof AccessError && e.status === status);

/* ── Deny by default ──────────────────────────────────────────────────────── */

test("a collection with no policy is refused, and the refusal names it", async () => {
  /* The first person to hit it finds out in one request, rather than by a
     screen going quietly blank. */
  const db = fresh({ cowork_secret_thing: [{ _id: "a" }] });
  await assert.rejects(
    execute(db, CEO, { op: "get", path: ["cowork_secret_thing", "a"] }),
    /No access policy for "cowork_secret_thing"/,
  );
});

test("only Cowork collections are addressable at all", async () => {
  const db = fresh({ employees: [{ _id: "a", salary: 1 }] });
  await refused(execute(db, CEO, { op: "get", path: ["employees", "a"] }));
  await refused(execute(db, CEO, { op: "query", path: ["acc_vouchers"] }));
});

test("a flattened name cannot be addressed directly", async () => {
  /* Naming `cowork_tasks__chat` would reach around the parent-scoped read. */
  const db = fresh({});
  await refused(execute(db, CEO, { op: "query", path: ["cowork_tasks__chat"] }), 400);
});

test("every policy level is a known word", () => {
  for (const [c, p] of Object.entries(ACCESS)) {
    assert.ok(["employee", "audience", "owner", "deny"].includes(p.read), `${c}.read`);
    assert.ok(["employee", "audience", "owner", "deny"].includes(p.write), `${c}.write`);
  }
});

/* ── Audience reads: the same people realtime would tell ──────────────────── */

test("a task is readable by the people it names, and nobody else", async () => {
  const db = fresh({ cowork_tasks: [{ _id: "T1", assigneeIds: ["E1"], title: "x" }] });
  const mine = await execute(db, EMP, { op: "get", path: ["cowork_tasks", "T1"] });
  assert.equal(mine.doc.data.title, "x");
  await refused(execute(db, OTHER, { op: "get", path: ["cowork_tasks", "T1"] }));
});

test("a CEO reads what mayViewTask lets them read: everything", async () => {
  const db = fresh({ cowork_tasks: [{ _id: "T1", assigneeIds: ["E1"] }] });
  const r = await execute(db, CEO, { op: "get", path: ["cowork_tasks", "T1"] });
  assert.equal(r.doc.exists, true);
});

test("a query is filtered server-side to what the caller may read", async () => {
  /* A query can never return a row the caller could not fetch by id. */
  const db = fresh({
    cowork_tasks: [
      { _id: "T1", assigneeIds: ["E1"], status: "open" },
      { _id: "T2", assigneeIds: ["E9"], status: "open" },
    ],
  });
  const r = await execute(db, EMP, {
    op: "query",
    path: ["cowork_tasks"],
    where: [{ field: "status", op: "==", value: "open" }],
  });
  assert.deepEqual(r.docs.map((d) => d.id), ["T1"]);
});

test("a missing document reveals nothing, so it is not refused", async () => {
  const db = fresh({});
  const r = await execute(db, OTHER, { op: "get", path: ["cowork_tasks", "nope"] });
  assert.equal(r.doc.exists, false);
  assert.equal(r.doc.data, null);
});

/* ── Subcollections take the parent's policy ──────────────────────────────── */

test("a chat message is readable by whoever may read its task", async () => {
  const db = fresh({
    cowork_tasks: [{ _id: "T1", assigneeIds: ["E1"] }],
    cowork_tasks__chat: [{ _id: "m1", _parentId: "T1", text: "hi" }],
  });
  const r = await execute(db, EMP, { op: "query", path: ["cowork_tasks", "T1", "chat"] });
  assert.equal(r.docs.length, 1);
  assert.equal(r.docs[0].data.text, "hi");
  const none = await execute(db, OTHER, { op: "query", path: ["cowork_tasks", "T1", "chat"] });
  assert.equal(none.docs.length, 0);
});

test("writing into a subcollection is judged by the parent", async () => {
  const db = fresh({ cowork_tasks: [{ _id: "T1", assigneeIds: ["E1"] }] });
  const ok = await execute(db, EMP, {
    op: "add",
    path: ["cowork_tasks", "T1", "chat"],
    data: { text: "hello" },
  });
  assert.ok(ok.id);
  await refused(
    execute(db, OTHER, { op: "add", path: ["cowork_tasks", "T1", "chat"], data: { text: "no" } }),
  );
});

/* ── Owner writes ─────────────────────────────────────────────────────────── */

test("a timer can be written only by the person it belongs to", async () => {
  const db = fresh({ cowork_task_timers: [{ _id: "E1", running: false }] });
  await execute(db, EMP, { op: "update", path: ["cowork_task_timers", "E1"], data: { running: true } });
  await refused(
    execute(db, OTHER, { op: "update", path: ["cowork_task_timers", "E1"], data: { running: true } }),
  );
});

test("settings are readable by everyone and writable by nobody here", async () => {
  /* Administrators change settings through routes that check the role. */
  const db = fresh({ cowork_settings: [{ _id: "office", open: "09:30" }] });
  const r = await execute(db, EMP, { op: "get", path: ["cowork_settings", "office"] });
  assert.equal(r.doc.data.open, "09:30");
  await refused(execute(db, CEO, { op: "set", path: ["cowork_settings", "office"], data: {} }));
});

/* ── Wire values ──────────────────────────────────────────────────────────── */

test("field sentinels arrive as tagged objects and become the real thing", async () => {
  const db = fresh({ cowork_task_timers: [{ _id: "E1", n: 1, tags: ["a"] }] });
  await execute(db, EMP, {
    op: "update",
    path: ["cowork_task_timers", "E1"],
    data: {
      at: { __fv: "serverTimestamp" },
      n: { __fv: "increment", by: 2 },
      tags: { __fv: "arrayUnion", values: ["b"] },
      gone: { __fv: "delete" },
    },
  });
  const r = await execute(db, EMP, { op: "get", path: ["cowork_task_timers", "E1"] });
  assert.equal(r.doc.data.n, 3);
  assert.deepEqual(r.doc.data.tags, ["a", "b"]);
  assert.ok(r.doc.data.at instanceof CompatTimestamp);
});

test("a timestamp from the browser becomes a real date", () => {
  const d = decodeValue({ __ts: { seconds: 1_700_000_000, nanoseconds: 500_000_000 } });
  assert.ok(d instanceof Date);
  assert.equal(d.getTime(), 1_700_000_000_500);
});

test("a $-prefixed field name from the browser is refused", () => {
  /* An operator injected through a document field would be an update the
     caller never wrote. */
  assert.throws(() => decodeValue({ $set: { role: "ceo" } }), AccessError);
});

test("an unknown sentinel is refused rather than stored as an object", () => {
  assert.throws(() => decodeValue({ x: { __fv: "makeMeAdmin" } }), AccessError);
});

test("a document's timestamps go back to the browser as _seconds/_nanoseconds", async () => {
  /* The shape a Firestore Timestamp has always had on the wire, and what the
     frontend already parses. */
  const db = fresh({ cowork_settings: [{ _id: "s", at: new Date(1_700_000_000_000) }] });
  const r = await execute(db, EMP, { op: "get", path: ["cowork_settings", "s"] });
  const wire = JSON.parse(JSON.stringify(r.doc.data.at));
  assert.deepEqual(wire, { _seconds: 1_700_000_000, _nanoseconds: 0 });
});

/* ── Queries ──────────────────────────────────────────────────────────────── */

test("__name__ means the document id, as it does in the client SDK", async () => {
  const db = fresh({
    cowork_settings: [{ _id: "a" }, { _id: "b" }, { _id: "c" }],
  });
  const r = await execute(db, EMP, {
    op: "query",
    path: ["cowork_settings"],
    where: [{ field: "__name__", op: "in", value: ["a", "c"] }],
    orderBy: [{ field: "__name__" }],
  });
  assert.deepEqual(r.docs.map((d) => d.id), ["a", "c"]);
});

test("a limit is capped so a query cannot pull a whole collection by mistake", async () => {
  const many = Array.from({ length: 1200 }, (_, i) => ({ _id: `s${i}` }));
  const db = fresh({ cowork_settings: many });
  const r = await execute(db, EMP, { op: "query", path: ["cowork_settings"], limit: 5000 });
  assert.equal(r.docs.length, 1000);
});

test("an unsupported operator is refused with a 400", async () => {
  const db = fresh({});
  await refused(
    execute(db, EMP, {
      op: "query",
      path: ["cowork_settings"],
      where: [{ field: "x", op: "array-contains-all", value: [] }],
    }),
    400,
  );
});

/* ── Batches ──────────────────────────────────────────────────────────────── */

test("a batch is refused whole if any write is not allowed", async () => {
  /* Checked BEFORE anything is written, so it is never half-applied. */
  const db = fresh({
    cowork_task_timers: [{ _id: "E1", n: 0 }, { _id: "E9", n: 0 }],
  });
  await refused(
    execute(db, EMP, {
      op: "batch",
      ops: [
        { kind: "update", path: ["cowork_task_timers", "E1"], data: { n: 1 } },
        { kind: "update", path: ["cowork_task_timers", "E9"], data: { n: 1 } },
      ],
    }),
  );
  const mine = await execute(db, EMP, { op: "get", path: ["cowork_task_timers", "E1"] });
  assert.equal(mine.doc.data.n, 0, "the allowed half was applied anyway");
});

test("a batch that is allowed applies every write", async () => {
  const db = fresh({ cowork_task_timers: [{ _id: "E1", n: 0 }] });
  const r = await execute(db, EMP, {
    op: "batch",
    ops: [
      { kind: "update", path: ["cowork_task_timers", "E1"], data: { n: 1 } },
      { kind: "set", path: ["cowork_duty_status", "E1"], data: { mode: "online" } },
    ],
  });
  assert.equal(r.count, 2);
});

test("an unknown operation is a 400, not a 500", async () => {
  await refused(execute(fresh({}), EMP, { op: "drop", path: ["cowork_tasks"] }), 400);
});
