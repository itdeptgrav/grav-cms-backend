// services/approvalChain.test.js
//
// The department-bound approval chain, without a database.
//
// The walk takes an injected `load`, so every stop condition is testable as
// what it is — a rule about a reporting line — rather than through HTTP with
// fixtures behind it. The route tests cover the parts that genuinely need
// documents.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("./approvalChain.service");

/** A person, with the two fields the walk actually reads. */
const P = (id, over = {}) => ({
  _id: id,
  firstName: id,
  isActive: true,
  biometricId: `BIO-${id}`,
  department: "IT",
  ...over,
});

/**
 * The example from the brief:
 *   Soumya (IT) → Pramod (IT) → Rakesh (IT) → CEO (Executive)
 */
const PEOPLE = {
  soumya: P("soumya", { primaryManager: { managerId: "pramod" } }),
  pramod: P("pramod", { primaryManager: { managerId: "rakesh" } }),
  rakesh: P("rakesh", { primaryManager: { managerId: "ceo" } }),
  ceo: P("ceo", { department: "Executive" }),
};

const loader = (people) => async (id) => people[String(id)] || null;
const build = (who, people = PEOPLE) => c.buildChain({ requester: people[who], load: loader(people) });

/* ── THE WALK ────────────────────────────────────────────────────────────── */

test("a request walks up its own department and stops at the edge", async () => {
  const r = await build("soumya");
  assert.deepEqual(r.chain.map((s) => s.name), ["pramod", "rakesh"]);
  /* The CEO is Rakesh's manager and is not in IT, so the chain ends with
     Rakesh — who IS the most senior person in the department. */
  assert.equal(r.stop, c.STOP.TOP_OF_DEPARTMENT);
});

test("the chain is ordered immediate senior first", async () => {
  const r = await build("soumya");
  assert.deepEqual(r.chain.map((s) => s.order), [0, 1]);
  assert.equal(r.chain[0].name, "pramod");
});

test("the most senior person in a department has no chain at all", async () => {
  /* Rakesh reports to a CEO outside IT. There is nobody above him INSIDE IT,
     so his own request skips department approval entirely. An empty chain is
     an answer, not a failure. */
  const r = await build("rakesh");
  assert.deepEqual(r.chain, []);
  assert.equal(r.stop, c.STOP.OUTSIDE_DEPARTMENT);
});

test("a manager one level up is enough", async () => {
  const r = await build("pramod");
  assert.deepEqual(r.chain.map((s) => s.name), ["rakesh"]);
});

test("a cross-department manager is never in the chain", async () => {
  const r = await build("soumya");
  assert.ok(!r.chain.some((s) => s.name === "ceo"));
});

/* ── THE DEPARTMENT COMPARISON ───────────────────────────────────────────── */

test("departmentId wins over the free-text name when both carry one", async () => {
  /* Two people whose typed department reads the same but whose ids differ are
     NOT the same department — the reference is the fact, the string is a
     label somebody types. */
  const people = {
    a: P("a", { departmentId: "dept-1", primaryManager: { managerId: "b" } }),
    b: P("b", { departmentId: "dept-2" }),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain, []);
});

test("spelling variants of one department are one department", async () => {
  const people = {
    a: P("a", { department: "R&D", primaryManager: { managerId: "b" } }),
    b: P("b", { department: "R and D" }),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain.map((s) => s.name), ["b"]);
});

test("two blank departments are not a match", async () => {
  /* An unset field is missing data. Treating two blanks as the same
     department would walk a chain through everyone HR has not filled in. */
  const people = {
    a: P("a", { department: "", primaryManager: { managerId: "b" } }),
    b: P("b", { department: "" }),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain, []);
});

/* ── WHERE IT STOPS SAFELY ───────────────────────────────────────────────── */

test("no manager at all is recorded as such", async () => {
  const people = { a: P("a") };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain, []);
  assert.equal(r.stop, c.STOP.NO_MANAGER);
});

test("a loop in the reporting line fails safely", async () => {
  const people = {
    a: P("a", { primaryManager: { managerId: "b" } }),
    b: P("b", { primaryManager: { managerId: "a" } }),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  /* B is a real, same-department manager and is asked. Walking back to A is
     where it stops — the chain is short, not infinite, and it says why. */
  assert.deepEqual(r.chain.map((s) => s.name), ["b"]);
  assert.equal(r.stop, c.STOP.LOOP);
});

test("somebody listed as their own manager is a loop of one", async () => {
  const people = { a: P("a", { primaryManager: { managerId: "a" } }) };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain, []);
  assert.equal(r.stop, c.STOP.LOOP);
});

test("a manager whose record is missing stops the chain", async () => {
  const people = { a: P("a", { primaryManager: { managerId: "ghost" } }) };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.equal(r.stop, c.STOP.MANAGER_NOT_FOUND);
});

test("an inactive manager stops the chain rather than being skipped", async () => {
  /* Skipping would hand their approval to somebody more senior without anyone
     deciding that — a control quietly weakening itself. */
  const people = {
    a: P("a", { primaryManager: { managerId: "b" } }),
    b: P("b", { isActive: false, primaryManager: { managerId: "c" } }),
    c: P("c"),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain, []);
  assert.equal(r.stop, c.STOP.MANAGER_INACTIVE);
});

test("a manager with no login id cannot be routed to", async () => {
  const people = {
    a: P("a", { primaryManager: { managerId: "b" } }),
    b: P("b", { biometricId: undefined, identityId: undefined }),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.equal(r.stop, c.STOP.MANAGER_NO_LOGIN);
});

test("both login ids are stored, because only the session knows which it uses", async () => {
  const people = {
    a: P("a", { primaryManager: { managerId: "b" } }),
    b: P("b", { biometricId: "BIO-9", identityId: "ID-9" }),
  };
  const r = await c.buildChain({ requester: people.a, load: loader(people) });
  assert.deepEqual(r.chain[0].altIds, ["BIO-9", "ID-9"]);
});

test("a very deep line is bounded rather than walked forever", async () => {
  const people = {};
  for (let i = 0; i < 30; i += 1) {
    people[`p${i}`] = P(`p${i}`, { primaryManager: { managerId: `p${i + 1}` } });
  }
  const r = await c.buildChain({ requester: people.p0, load: loader(people) });
  assert.ok(r.chain.length <= c.MAX_DEPTH);
});

/* ── WHOSE TURN IT IS ────────────────────────────────────────────────────── */

const REQ = (over = {}) => ({
  requestedById: "BIO-soumya",
  currentApproverIndex: 0,
  approvalChain: [
    { order: 0, name: "Pramod", loginId: "BIO-pramod", altIds: ["BIO-pramod"], status: "pending" },
    { order: 1, name: "Rakesh", loginId: "BIO-rakesh", altIds: ["BIO-rakesh"], status: "pending" },
  ],
  ...over,
});

test("only the approver whose turn it is may answer", async () => {
  assert.equal(c.chainEntitlement({ request: REQ(), viewer: { employeeId: "BIO-pramod" } }).can, true);
});

test("somebody later in the chain may not jump the queue", () => {
  /* Rakesh approving before Pramod has looked would skip a step the
     department decided to have, and the record would say Pramod approved
     nothing while the request sailed past him. */
  const v = c.chainEntitlement({ request: REQ(), viewer: { employeeId: "BIO-rakesh" } });
  assert.equal(v.can, false);
  assert.match(v.reason, /waiting for Pramod/);
});

test("somebody outside the chain may not answer", () => {
  assert.equal(c.chainEntitlement({ request: REQ(), viewer: { employeeId: "BIO-other" } }).can, false);
});

test("the requester may not answer their own, even inside the chain", () => {
  const req = REQ({ requestedById: "BIO-pramod" });
  const v = c.chainEntitlement({ request: req, viewer: { employeeId: "BIO-pramod" } });
  assert.equal(v.can, false);
  assert.match(v.reason, /your own request/i);
});

test("a request with no chain has no step to answer", () => {
  const v = c.chainEntitlement({ request: REQ({ approvalChain: [] }), viewer: { employeeId: "BIO-x" } });
  assert.equal(v.can, false);
});

/* ── MOVING ALONG ────────────────────────────────────────────────────────── */

test("approving the first step moves to the second", () => {
  const a = c.advance(REQ());
  assert.deepEqual([a.done, a.nextIndex, a.next.name], [false, 1, "Rakesh"]);
});

test("approving the last step finishes the chain", () => {
  const a = c.advance(REQ({ currentApproverIndex: 1 }));
  assert.equal(a.done, true);
  assert.equal(a.next, null);
});

/* ── WHAT IT IS CALLED ───────────────────────────────────────────────────── */

test("the last step is named as the last one", () => {
  /* An approver should know they are the gate that releases it, rather than
     assuming somebody more senior will look again. */
  assert.equal(c.stepLabel(REQ()), "Pramod — approval");
  assert.equal(c.stepLabel(REQ({ currentApproverIndex: 1 })), "Rakesh — final approval");
});

test("a one-person chain is not called final", () => {
  const req = REQ({ approvalChain: [REQ().approvalChain[0]] });
  assert.equal(c.stepLabel(req), "Pramod — approval");
});

test("the progress rail marks exactly one step as current", () => {
  const rail = c.progressOf(REQ());
  assert.deepEqual(rail.map((s) => s.current), [true, false]);
  assert.deepEqual(rail.map((s) => s.status), ["pending", "pending"]);
});
