// services/plannerAttention.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTree } = require("./plannerRollup");
const { plannerAttention, STALE_DAYS, PAUSED_REVIEW_DAYS } = require("./plannerAttention");

const NOW = new Date("2026-08-22T10:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000);
const daysAhead = (n) => new Date(NOW.getTime() + n * 86400000);

const goal = (id, level, parentId, extra = {}) => ({
  _id: id,
  level,
  parentId: parentId || null,
  title: id,
  status: "active",
  updatedAt: NOW,
  ...extra,
});
const task = (id, goalId, extra = {}) => ({
  _id: id,
  goalId,
  title: id,
  status: "todo",
  updatedAt: NOW,
  ...extra,
});

/** A vision→mission→project spine plus whatever else is passed. */
const scan = (goals, tasks = []) => plannerAttention(buildTree(goals, tasks), NOW);
const reasonFor = (result, id) => result.items.find((i) => i.goalId === id)?.reason;

const SPINE = [goal("v", "vision"), goal("m", "mission", "v"), goal("p", "project", "m")];

/* ── overdue: the one the owner asked for ─────────────────────────────────── */

test("an active goal whose target date has passed asks for a decision", () => {
  const r = scan([...SPINE.slice(0, 2), goal("p", "project", "m", { targetDate: daysAgo(5) })], [task("t", "p")]);
  assert.equal(reasonFor(r, "p"), "overdue");
});

test("a target date still ahead is silent — that is the system working", () => {
  const r = scan([...SPINE.slice(0, 2), goal("p", "project", "m", { targetDate: daysAhead(30) })], [task("t", "p")]);
  assert.equal(reasonFor(r, "p"), undefined);
});

test("overdue outranks stale — one problem is not reported as two", () => {
  const r = scan(
    [...SPINE.slice(0, 2), goal("p", "project", "m", { targetDate: daysAgo(5), updatedAt: daysAgo(200) })],
    [task("t", "p", { updatedAt: daysAgo(200) })],
  );
  assert.equal(r.items.filter((i) => i.goalId === "p").length, 1);
  assert.equal(reasonFor(r, "p"), "overdue");
});

/* ── empty and barren: an intention with no plan under it ─────────────────── */

test("a project with no tasks is empty, not stale", () => {
  assert.equal(reasonFor(scan(SPINE), "p"), "empty");
});

test("a mission with no projects is barren", () => {
  const r = scan([goal("v", "vision"), goal("m", "mission", "v")]);
  assert.equal(reasonFor(r, "m"), "barren");
});

test("a vision with no missions is barren too", () => {
  assert.equal(reasonFor(scan([goal("v", "vision")]), "v"), "barren");
});

test("a mission whose only project was dropped counts as barren — dropped is not cover", () => {
  const r = scan([
    goal("v", "vision"),
    goal("m", "mission", "v"),
    goal("p", "project", "m", { status: "dropped" }),
  ]);
  assert.equal(reasonFor(r, "m"), "barren");
});

/* ── stale: the classic drifting project ──────────────────────────────────── */

test("a project nothing has moved in for three weeks goes stale", () => {
  const old = daysAgo(STALE_DAYS + 3);
  const r = scan(
    [...SPINE.slice(0, 2), goal("p", "project", "m", { updatedAt: old })],
    [task("t", "p", { updatedAt: old })],
  );
  assert.equal(reasonFor(r, "p"), "stale");
});

test("one recently touched task keeps the whole project alive", () => {
  const old = daysAgo(STALE_DAYS + 3);
  const r = scan(
    [...SPINE.slice(0, 2), goal("p", "project", "m", { updatedAt: old })],
    [task("a", "p", { updatedAt: old }), task("b", "p", { updatedAt: daysAgo(1) })],
  );
  assert.equal(reasonFor(r, "p"), undefined);
});

test("a project just inside the threshold is left alone", () => {
  const recent = daysAgo(STALE_DAYS - 1);
  const r = scan(
    [...SPINE.slice(0, 2), goal("p", "project", "m", { updatedAt: recent })],
    [task("t", "p", { updatedAt: recent })],
  );
  assert.equal(reasonFor(r, "p"), undefined);
});

/* ── paused: "not now" has an expiry ──────────────────────────────────────── */

test("a recent pause is respected and says nothing", () => {
  const r = scan([
    ...SPINE.slice(0, 2),
    goal("p", "project", "m", { status: "paused", statusAt: daysAgo(10) }),
  ]);
  assert.equal(reasonFor(r, "p"), undefined);
});

test("a pause left past the review window comes back", () => {
  const r = scan([
    ...SPINE.slice(0, 2),
    goal("p", "project", "m", { status: "paused", statusAt: daysAgo(PAUSED_REVIEW_DAYS + 5) }),
  ]);
  assert.equal(reasonFor(r, "p"), "pausedLong");
});

test("a paused goal is never also reported as empty — pausing is a real answer", () => {
  const r = scan([
    ...SPINE.slice(0, 2),
    goal("p", "project", "m", { status: "paused", statusAt: daysAgo(2) }),
  ]);
  assert.equal(r.items.filter((i) => i.goalId === "p").length, 0);
});

/* ── the settled states say nothing at all ────────────────────────────────── */

test("dropped and achieved goals never appear", () => {
  const r = scan([
    goal("v", "vision"),
    goal("m", "mission", "v"),
    goal("dead", "project", "m", { status: "dropped", targetDate: daysAgo(400) }),
    goal("won", "project", "m", { status: "achieved", targetDate: daysAgo(400) }),
  ]);
  assert.equal(r.items.filter((i) => ["dead", "won"].includes(i.goalId)).length, 0);
});

/* ── the one positive item ────────────────────────────────────────────────── */

test("a project in its last stretch is surfaced as an opportunity, not a fault", () => {
  const tasks = [
    ...Array.from({ length: 9 }, (_, i) => task(`d${i}`, "p", { status: "done", doneAt: daysAgo(1) })),
    task("left", "p"),
  ];
  const r = scan(SPINE, tasks);
  assert.equal(reasonFor(r, "p"), "nearlyDone");
  assert.equal(r.items.find((i) => i.goalId === "p").positive, true);
});

test("an opportunity does not count toward needsDecision", () => {
  const tasks = [
    ...Array.from({ length: 9 }, (_, i) => task(`d${i}`, "p", { status: "done", doneAt: daysAgo(1) })),
    task("left", "p"),
  ];
  const r = scan(SPINE, tasks);
  assert.equal(r.needsDecision, 0);
});

/* ── ordering, path, and the inbox ────────────────────────────────────────── */

test("overdue sorts above stale, which sorts above empty", () => {
  const old = daysAgo(200);
  const r = scan(
    [
      goal("v", "vision"),
      goal("m", "mission", "v"),
      goal("empty", "project", "m"),
      goal("stale", "project", "m", { updatedAt: old }),
      goal("late", "project", "m", { targetDate: daysAgo(1) }),
    ],
    [task("s", "stale", { updatedAt: old }), task("l", "late")],
  );
  const order = r.items.filter((i) => i.level === "project").map((i) => i.goalId);
  assert.deepEqual(order, ["late", "stale", "empty"]);
});

test("each item carries the ladder above it, so Review can say where it sits", () => {
  const r = scan(SPINE);
  assert.deepEqual(r.items.find((i) => i.goalId === "p").path, ["v", "m"]);
});

test("unfiled tasks are counted, never listed as faults", () => {
  const r = scan(SPINE, [task("loose", null), task("done", null, { status: "done" })]);
  assert.equal(r.unfiled, 1);
  assert.equal(r.items.some((i) => i.goalId === undefined), false);
});

test("a healthy ladder asks for nothing", () => {
  const r = scan(SPINE, [task("t", "p", { updatedAt: daysAgo(1) })]);
  assert.equal(r.needsDecision, 0);
  assert.equal(r.items.length, 0);
});
