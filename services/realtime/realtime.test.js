const assert = require("node:assert/strict");
const { test } = require("node:test");

const { audienceFor, isWatched, taskAudience } = require("./rooms");
const { isAuthenticatedRoom, userRoom } = require("./socketIdentity");

/** Every room the broker addresses is one the SERVER granted, not one claimed. */
const u = (...ids) => ids.map(userRoom);
const { ChangeStreamBroker, STATE_ID, toEvent } = require("./changeStreamBroker");

/**
 * The realtime layer that replaces Firestore listeners.
 *
 * Two things are being protected here and they are not the same thing:
 *
 *  1. **Who receives a change.** Firestore's rules were enforced by Google.
 *     They are gone, and `rooms.js` is what stands in their place — so a
 *     mistake here is a data leak, not a bug.
 *  2. **That nothing is silently missed.** A listener that stops delivering
 *     without saying so is worse than one that visibly fails, because the
 *     screen stays plausible.
 *
 * No database and no sockets: the broker takes its `db` and `io` as
 * dependencies, so both can be fakes and every branch is reachable — including
 * the oplog-history-lost path, which is almost impossible to produce on demand
 * against a real server.
 */

/* ── Fakes ────────────────────────────────────────────────────────────────── */

function fakeIo() {
  const sent = [];
  const broadcast = [];
  return {
    sent,
    broadcast,
    to(rooms) {
      return {
        emit: (event, payload) => sent.push({ rooms, event, payload }),
      };
    },
    emit: (event, payload) => broadcast.push({ event, payload }),
  };
}

function fakeDb({ token = null } = {}) {
  const state = { token, writes: [], deletes: [] };
  return {
    state,
    collection() {
      return {
        findOne: async () => (state.token ? { _id: STATE_ID, token: state.token } : null),
        updateOne: async (_f, update) => {
          state.writes.push(update.$set.token);
          state.token = update.$set.token;
        },
        deleteOne: async () => {
          state.deletes.push(STATE_ID);
          state.token = null;
        },
      };
    },
    watch() {
      const handlers = {};
      return {
        on(name, fn) {
          handlers[name] = fn;
          return this;
        },
        close: async () => {},
        handlers,
      };
    },
  };
}

const quiet = () => {};

/* ── Who receives a change ────────────────────────────────────────────────── */

test("a task reaches everyone the document names, and nobody else", () => {
  /* The same set `mayViewTask` uses for attachments. One rule, not two. */
  const rooms = taskAudience({
    assigneeIds: ["E1", "E2"],
    pendingAssigneeId: "E3",
    assignedBy: "E4",
    originalAssignedBy: "E5",
    approverId: "E6",
    departmentApprovals: [{ approverId: "E7" }],
    visibleTo: ["E8"],
  });
  assert.deepEqual(rooms.sort(), u("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8").sort());
});

test("a stranger is not on the list however they joined", () => {
  /* The point of the whole design: the audience comes from the document, so a
     socket that guessed `socket.join("E999")` is simply never addressed. */
  const rooms = taskAudience({ assigneeIds: ["E1"], assignedBy: "E2" });
  assert.ok(!rooms.includes(userRoom("E999")));
  assert.ok(!rooms.includes("E999"));
});

test("a notification is for its owner alone", () => {
  /* Not their manager, not a CEO. */
  assert.deepEqual(audienceFor("cowork_notifications", { employeeId: "E1" }), u("E1"));
});

test("a DM is addressed to the two people its id is made of", () => {
  /* `chatId` is `[a,b].sort().join("_")`, so the participants are derivable
     without trusting a client to say who it is. */
  assert.deepEqual(audienceFor("cowork_direct_messages", { chatId: "E1_E2" }), u("E1", "E2"));
});

test("a malformed chat id addresses nobody rather than everybody", () => {
  for (const chatId of ["", "E1", "E1_E2_E3", undefined])
    assert.deepEqual(audienceFor("cowork_direct_messages", { chatId }), []);
});

test("a collection nobody has written a rule for is silent", () => {
  /* The default that matters. A new collection must not reach everyone because
     nobody got round to deciding who should see it. */
  assert.equal(isWatched("cowork_payroll_secrets"), false);
  assert.deepEqual(audienceFor("cowork_payroll_secrets", { anything: true }), []);
});

test("a document that names nobody is told to nobody", () => {
  for (const doc of [null, undefined, {}, { assigneeIds: [] }])
    assert.deepEqual(audienceFor("cowork_tasks", doc), []);
});

test("a rule that throws answers 'nobody', never 'everybody'", () => {
  const hostile = {
    get assigneeIds() {
      throw new Error("malformed");
    },
  };
  assert.deepEqual(audienceFor("cowork_tasks", hostile), []);
});

/* ── Delivery ─────────────────────────────────────────────────────────────── */

const change = (over = {}) => ({
  _id: { _data: "TOKEN-1" },
  operationType: "update",
  ns: { db: "cowork", coll: "cowork_tasks" },
  documentKey: { _id: "T1" },
  fullDocument: { _id: "T1", assigneeIds: ["E1"], assignedBy: "E2" },
  ...over,
});

test("a change is emitted to the document's audience", async () => {
  const io = fakeIo();
  const broker = new ChangeStreamBroker({ db: fakeDb(), io, log: quiet });
  await broker.deliver(change());
  assert.equal(io.sent.length, 1);
  assert.deepEqual(io.sent[0].rooms.sort(), u("E1", "E2").sort());
  assert.equal(io.sent[0].event, "realtime:change");
  assert.deepEqual(io.sent[0].payload.collection, "cowork_tasks");
  assert.equal(io.sent[0].payload.id, "T1");
  assert.equal(io.sent[0].payload.operation, "update");
});

test("the event says what happened, not what changed", () => {
  /* The client invalidates and refetches. Shipping a diff would put a second
     copy of the truth in the browser, free to disagree with the first. */
  const e = toEvent(change());
  assert.deepEqual(Object.keys(e).sort(), ["at", "collection", "id", "operation"]);
});

test("a delete goes to the per-document room, since the document is gone", async () => {
  /* Nothing left to compute an audience from — so it is addressed to a room
     joined only by somebody who was already entitled to read that record. */
  const io = fakeIo();
  const broker = new ChangeStreamBroker({ db: fakeDb(), io, log: quiet });
  await broker.deliver(
    change({ operationType: "delete", fullDocument: undefined }),
  );
  assert.deepEqual(io.sent[0].rooms, "doc:cowork_tasks:T1");
});

test("an unwatched collection is not delivered at all", async () => {
  const io = fakeIo();
  const broker = new ChangeStreamBroker({ db: fakeDb(), io, log: quiet });
  await broker.deliver(change({ ns: { coll: "cowork_payroll_secrets" } }));
  assert.equal(io.sent.length, 0);
});

test("a change nobody can see is counted, not broadcast", async () => {
  const io = fakeIo();
  const broker = new ChangeStreamBroker({ db: fakeDb(), io, log: quiet });
  await broker.deliver(change({ fullDocument: { _id: "T1" } }));
  assert.equal(io.sent.length, 0);
  assert.equal(io.broadcast.length, 0);
  assert.equal(broker.stats.dropped, 1);
});

/* ── Not missing anything ─────────────────────────────────────────────────── */

test("the position is written after every delivered change", async () => {
  /* A restart resumes where it stopped instead of skipping whatever happened
     while the process was down. */
  const db = fakeDb();
  const broker = new ChangeStreamBroker({ db, io: fakeIo(), log: quiet });
  await broker.deliver(change());
  assert.deepEqual(db.state.writes, [{ _data: "TOKEN-1" }]);
});

test("the stored position is used when the stream reopens", async () => {
  const db = fakeDb({ token: { _data: "OLD" } });
  let options = null;
  db.watch = (_p, o) => {
    options = o;
    return { on() { return this; }, close: async () => {} };
  };
  const broker = new ChangeStreamBroker({ db, io: fakeIo(), log: quiet });
  await broker.open();
  assert.deepEqual(options.resumeAfter, { _data: "OLD" });
  assert.equal(options.fullDocument, "updateLookup");
});

test("the broker's own bookkeeping cannot feed itself", async () => {
  /* It writes the resume token on every change. Without excluding that
     collection, each write would produce another change, for ever. */
  const broker = new ChangeStreamBroker({ db: fakeDb(), io: fakeIo(), log: quiet });
  const [stage] = broker.pipeline();
  assert.equal(stage.$match["ns.coll"].$ne, "cowork_realtime_state");
});

test("the filter also catches flattened subcollections", () => {
  /**
   * The busiest realtime traffic in the product lives in subcollections —
   * `cowork_tasks__chat`, `cowork_conversations__messages`,
   * `cowork_task_timers__sessions`. None of those names is in the audience
   * table, so matching only the watched collections dropped every chat message,
   * every daily report and every timer session. Silently: the stream was
   * healthy, it just never mentioned them.
   */
  const broker = new ChangeStreamBroker({ db: fakeDb(), io: fakeIo(), log: quiet });
  const [stage] = broker.pipeline();
  const clauses = stage.$match.$or;
  assert.ok(Array.isArray(clauses) && clauses.length === 2);

  const exact = clauses[0]["ns.coll"].$in;
  assert.ok(exact.includes("cowork_tasks"));

  const patterns = clauses[1]["ns.coll"].$in;
  assert.ok(patterns.every((p) => p instanceof RegExp));
  assert.ok(
    patterns.some((p) => p.test("cowork_tasks__chat")),
    "a chat message would not match the filter",
  );
  assert.ok(
    !patterns.some((p) => p.test("cowork_payroll__secrets")),
    "an unwatched parent's subcollection matched",
  );
});

test("a subcollection change is addressed to its PARENT's audience", async () => {
  /* A chat message names nobody. Who may read it is whoever may read the task
     it hangs off, which needs a second read — so this is the one place the
     audience is not computed purely. */
  const io = fakeIo();
  const db = fakeDb();
  db.collection = (name) => ({
    findOne: async ({ _id }) =>
      name === "cowork_tasks" && _id === "T1"
        ? { _id: "T1", assigneeIds: ["E1"], assignedBy: "E2" }
        : null,
    updateOne: async () => {},
    deleteOne: async () => {},
  });
  const broker = new ChangeStreamBroker({ db, io, log: quiet });
  await broker.deliver({
    _id: { _data: "T" },
    operationType: "insert",
    ns: { coll: "cowork_tasks__chat" },
    documentKey: { _id: "m1" },
    fullDocument: { _id: "m1", _parentId: "T1", text: "hello" },
  });
  assert.equal(io.sent.length, 1, "the message reached nobody");
  assert.deepEqual(io.sent[0].rooms.sort(), u("E1", "E2").sort());
});

test("a subcollection whose parent cannot be read tells nobody", async () => {
  const io = fakeIo();
  const db = fakeDb();
  db.collection = (name) => ({
    findOne: async () => {
      if (name === "cowork_tasks") throw new Error("gone");
      return null;
    },
    updateOne: async () => {},
    deleteOne: async () => {},
  });
  const broker = new ChangeStreamBroker({ db, io, log: quiet });
  await broker.deliver({
    _id: { _data: "T" },
    operationType: "insert",
    ns: { coll: "cowork_tasks__chat" },
    documentKey: { _id: "m1" },
    fullDocument: { _id: "m1", _parentId: "T1" },
  });
  assert.equal(io.sent.length, 0);
});

/* ── The field names, checked against the writers ─────────────────────────── */

test("a notification is addressed by recipientEmployeeId", () => {
  /**
   * `services/cowork.service.js:1346` writes `recipientEmployeeId`. Reading
   * `employeeId` instead yields undefined, which yields an empty audience,
   * which is a LEGAL answer — so the bell would simply have stopped, with no
   * error anywhere.
   */
  assert.deepEqual(
    audienceFor("cowork_notifications", { recipientEmployeeId: "E1" }),
    u("E1"),
  );
  /* Older rows and other writers use the shorter name. */
  assert.deepEqual(audienceFor("cowork_notifications", { employeeId: "E2" }), u("E2"));
});

test("duty status and timers are addressed by DOCUMENT ID", () => {
  /* Both are written `.doc(String(employeeId))`. Duty carries an `employeeId`
     field on some write paths and not others, which is exactly what makes a
     field-only rule look correct in testing and fail in production. */
  assert.deepEqual(audienceFor("cowork_duty_status", {}, "E1"), u("E1"));
  assert.deepEqual(audienceFor("cowork_task_timers", {}, "E1"), u("E1"));
  assert.deepEqual(
    audienceFor("cowork_duty_status", { employeeId: "E1" }, "E1"),
    u("E1"),
    "the id and the field disagreed",
  );
});

test("a conversation falls back to the ids in its own name", () => {
  assert.deepEqual(
    audienceFor("cowork_conversations", { participantIds: ["E1", "E2"] }),
    u("E1", "E2"),
  );
  assert.deepEqual(audienceFor("cowork_conversations", {}, "E1_E2"), u("E1", "E2"));
});

test("a lost oplog resyncs everyone rather than pretending", async () => {
  /* Those events cannot be recovered by any retry. A visible refetch beats a
     screen that is quietly out of date. */
  const db = fakeDb({ token: { _data: "TOO-OLD" } });
  const io = fakeIo();
  const broker = new ChangeStreamBroker({ db, io, log: quiet });
  broker.open = async () => {};
  await broker.recover(Object.assign(new Error("resume token not found"), {
    codeName: "ChangeStreamHistoryLost",
  }));
  assert.deepEqual(io.broadcast[0].event, "realtime:resync");
  assert.deepEqual(db.state.deletes, [STATE_ID], "the dead position was kept");
  assert.equal(broker.stats.resyncs, 1);
});

test("an ordinary failure retries with a ceiling, and does not resync", async () => {
  /* A dropped connection is not lost history. Telling every client to refetch
     over a blip would be a self-inflicted thundering herd. */
  const io = fakeIo();
  const broker = new ChangeStreamBroker({ db: fakeDb(), io, log: quiet });
  broker.open = async () => {};
  await broker.recover(new Error("connection reset"));
  assert.equal(io.broadcast.length, 0);
  assert.equal(broker.retryMs, 2000);
  for (let i = 0; i < 10; i++) await broker.recover(new Error("again"));
  assert.ok(broker.retryMs <= 30000, "backoff has no ceiling");
});

test("stopping keeps it stopped", async () => {
  /* Otherwise a close during shutdown reopens the stream it just closed. */
  const broker = new ChangeStreamBroker({ db: fakeDb(), io: fakeIo(), log: quiet });
  let opened = 0;
  broker.open = async () => {
    opened += 1;
  };
  await broker.stop();
  await broker.recover(new Error("closed"));
  assert.equal(opened, 0);
});

/* ── The room namespace itself ────────────────────────────────────────────── */

test("nothing is ever addressed to a room a client can simply claim", () => {
  /* `join_cowork` in server.js joins whatever employeeId the client sends, with
     no check. While Firestore enforced reads that was survivable; it is not once
     documents travel through rooms. Every room the broker addresses must be one
     `socketIdentity` granted after verifying a token — the `user:` namespace —
     and NEVER the bare id. The two are one character apart in the source. */
  const docs = [
    ["cowork_tasks", { assigneeIds: ["E1"], assignedBy: "E2", visibleTo: ["E3"] }],
    ["cowork_notifications", { employeeId: "E1" }],
    ["cowork_direct_messages", { chatId: "E1_E2" }],
    ["cowork_groups", { memberIds: ["E1", "E2"] }],
    ["cowork_duty_status", { employeeId: "E1" }],
    ["cowork_task_timers", { employeeId: "E1" }],
  ];
  for (const [collection, doc] of docs) {
    const rooms = audienceFor(collection, doc);
    assert.ok(rooms.length > 0, `${collection} addressed nobody`);
    for (const room of rooms)
      assert.ok(
        isAuthenticatedRoom(room),
        `${collection} addressed "${room}", which any client could join`,
      );
  }
});

test("an unauthenticated socket is not refused, it is just not addressed", async () => {
  /* Refusing would disconnect every client that has not been updated — presence,
     typing, meetings and MRF chat all ride this socket and none of them are
     changing. No token means no `user:` room, which means none of the migrated
     data. Degraded, not broken. */
  const { socketIdentity } = require("./socketIdentity");
  const identify = socketIdentity({
    verifyIdToken: async () => {
      throw new Error("should not be called");
    },
    resolveEmployee: async () => null,
  });
  const joined = [];
  const socket = { handshake: { auth: {}, query: {} }, data: {}, join: (r) => joined.push(r) };
  let called = false;
  await identify(socket, () => {
    called = true;
  });
  assert.equal(called, true, "the connection was refused");
  assert.equal(socket.data.employeeId, null);
  assert.deepEqual(joined, [], "an anonymous socket was given a room");
});

test("a verified token joins exactly one room, its own", async () => {
  const { socketIdentity } = require("./socketIdentity");
  const identify = socketIdentity({
    verifyIdToken: async (t) => {
      assert.equal(t, "good-token");
      return { uid: "uid-1" };
    },
    resolveEmployee: async (uid) => (uid === "uid-1" ? { employeeId: "E1" } : null),
  });
  const joined = [];
  const socket = {
    handshake: { auth: { token: "good-token" }, query: {} },
    data: {},
    join: (r) => joined.push(r),
  };
  await identify(socket, () => {});
  assert.deepEqual(joined, [userRoom("E1")]);
  assert.equal(socket.data.employeeId, "E1");
});

test("an expired token costs the room, not the connection", async () => {
  /* Tokens expire on the SDK's schedule and a tab waking from sleep reconnects
     with a stale one. Dropping the socket would take the meeting with it. */
  const { socketIdentity } = require("./socketIdentity");
  const identify = socketIdentity({
    verifyIdToken: async () => {
      throw Object.assign(new Error("expired"), { code: "auth/id-token-expired" });
    },
    resolveEmployee: async () => null,
  });
  const joined = [];
  const socket = {
    handshake: { auth: { token: "stale" }, query: {} },
    data: {},
    join: (r) => joined.push(r),
  };
  let called = false;
  await identify(socket, () => {
    called = true;
  });
  assert.equal(called, true, "an expired token disconnected the socket");
  assert.deepEqual(joined, []);
  assert.equal(socket.data.employeeId, null);
});

test("a Firebase user with no workspace record gets no room", async () => {
  const { socketIdentity } = require("./socketIdentity");
  const identify = socketIdentity({
    verifyIdToken: async () => ({ uid: "uid-x" }),
    resolveEmployee: async () => null,
  });
  const joined = [];
  const socket = { handshake: { auth: { token: "t" }, query: {} }, data: {}, join: (r) => joined.push(r) };
  await identify(socket, () => {});
  assert.deepEqual(joined, []);
  assert.equal(socket.data.employeeId, null);
});
