// services/plannerRollup.test.js
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildTree } = require("./plannerRollup");

// Ids are plain strings — buildTree stringifies whatever it is handed, so the
// fixtures do not need real ObjectIds to exercise the wiring.
const goal = (id, level, parentId, extra = {}) => ({
  _id: id,
  level,
  parentId: parentId || null,
  title: id,
  status: "active",
  order: 0,
  ...extra,
});
const task = (id, goalId, status = "todo") => ({ _id: id, goalId, title: id, status });

const findGoal = (tree, id) => {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.id === id) return n;
      const hit = walk(n.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(tree.visions) || walk(tree.orphans);
};

/* ── the shape of the ladder ──────────────────────────────────────────────── */

test("a vision holds its missions, which hold their projects", () => {
  const tree = buildTree(
    [goal("v", "vision"), goal("m", "mission", "v"), goal("p", "project", "m")],
    [],
  );
  assert.equal(tree.visions.length, 1);
  assert.equal(tree.visions[0].children[0].id, "m");
  assert.equal(tree.visions[0].children[0].children[0].id, "p");
});

test("children come back in the owner's manual order, not insertion order", () => {
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("b", "mission", "v", { order: 2 }),
      goal("a", "mission", "v", { order: 1 }),
    ],
    [],
  );
  assert.deepEqual(tree.visions[0].children.map((c) => c.id), ["a", "b"]);
});

/* ── a project scores from its own tasks ──────────────────────────────────── */

test("a project is done tasks over total tasks", () => {
  const tree = buildTree(
    [goal("v", "vision"), goal("m", "mission", "v"), goal("p", "project", "m")],
    [task("t1", "p", "done"), task("t2", "p", "done"), task("t3", "p"), task("t4", "p")],
  );
  assert.equal(findGoal(tree, "p").progress.percent, 50);
});

test("a task in progress is worth nothing — started is not finished", () => {
  const tree = buildTree(
    [goal("v", "vision"), goal("m", "mission", "v"), goal("p", "project", "m")],
    [task("t1", "p", "doing"), task("t2", "p", "doing")],
  );
  assert.equal(findGoal(tree, "p").progress.percent, 0);
});

test("an empty project reads 0% but says it has no basis for the number", () => {
  const tree = buildTree(
    [goal("v", "vision"), goal("m", "mission", "v"), goal("p", "project", "m")],
    [],
  );
  const p = findGoal(tree, "p").progress;
  assert.equal(p.percent, 0);
  assert.equal(p.hasBasis, false);
});

test("a project with untouched tasks is also 0%, but it DOES have a basis", () => {
  const tree = buildTree(
    [goal("v", "vision"), goal("m", "mission", "v"), goal("p", "project", "m")],
    [task("t1", "p")],
  );
  assert.equal(findGoal(tree, "p").progress.hasBasis, true);
});

/* ── judgement beats arithmetic ───────────────────────────────────────────── */

test("an achieved project is 100% even with tasks still open", () => {
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("m", "mission", "v"),
      goal("p", "project", "m", { status: "achieved" }),
    ],
    [task("t1", "p"), task("t2", "p")],
  );
  assert.equal(findGoal(tree, "p").progress.percent, 100);
});

/* ── rolling up ───────────────────────────────────────────────────────────── */

test("a mission averages its projects, not their task counts", () => {
  // One tiny finished project, one large untouched one. Weighting by tasks
  // would say 20%; averaging the projects says 50%, which is the honest read.
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("m", "mission", "v"),
      goal("small", "project", "m"),
      goal("big", "project", "m"),
    ],
    [
      task("s1", "small", "done"),
      ...Array.from({ length: 8 }, (_, i) => task(`b${i}`, "big")),
    ],
  );
  assert.equal(findGoal(tree, "m").progress.percent, 50);
});

test("a dropped project leaves the denominator instead of scoring zero", () => {
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("m", "mission", "v"),
      goal("kept", "project", "m"),
      goal("gone", "project", "m", { status: "dropped" }),
    ],
    [task("k1", "kept", "done")],
  );
  // Honest abandonment must not damage the number above it: 100%, not 50%.
  assert.equal(findGoal(tree, "m").progress.percent, 100);
});

test("a paused project stays in the denominator — it is still part of the plan", () => {
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("m", "mission", "v"),
      goal("kept", "project", "m"),
      goal("later", "project", "m", { status: "paused" }),
    ],
    [task("k1", "kept", "done")],
  );
  assert.equal(findGoal(tree, "m").progress.percent, 50);
});

test("a mission whose every project was dropped has no basis for a number", () => {
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("m", "mission", "v"),
      goal("gone", "project", "m", { status: "dropped" }),
    ],
    [],
  );
  assert.equal(findGoal(tree, "m").progress.hasBasis, false);
});

test("a vision rolls up through two levels", () => {
  const tree = buildTree(
    [
      goal("v", "vision"),
      goal("m1", "mission", "v"),
      goal("m2", "mission", "v"),
      goal("p1", "project", "m1"),
      goal("p2", "project", "m2"),
    ],
    [task("a", "p1", "done"), task("b", "p2")],
  );
  // m1 = 100, m2 = 0 → vision = 50
  assert.equal(findGoal(tree, "v").progress.percent, 50);
});

/* ── the inbox, and what happens when a parent disappears ─────────────────── */

test("a task with no goal is the inbox, not an error", () => {
  const tree = buildTree([], [task("loose", null)]);
  assert.equal(tree.inbox.length, 1);
  assert.equal(tree.inbox[0].id, "loose");
});

test("a task filed under a mission is allowed — no project-of-one required", () => {
  const tree = buildTree(
    [goal("v", "vision"), goal("m", "mission", "v")],
    [task("t", "m")],
  );
  assert.equal(findGoal(tree, "m").tasks.length, 1);
  assert.equal(tree.inbox.length, 0);
});

test("a goal whose parent is gone surfaces as an orphan rather than vanishing", () => {
  const tree = buildTree([goal("m", "mission", "missing-vision")], []);
  assert.equal(tree.visions.length, 0);
  assert.equal(tree.orphans.length, 1);
  assert.equal(tree.orphans[0].id, "m");
});
