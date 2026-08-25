// services/plannerRollup.js
//
// Progress, derived — never stored.
//
// A project's progress is its tasks. A mission's is its projects. A vision's is
// its missions. Nothing in the Planner holds a percentage, so nothing can hold
// a WRONG one: tick a task from any screen and every rung above it is correct
// on the next read, with no write to keep in step and no backfill to run when
// the formula changes.
//
// THE RULES, AND WHY EACH ONE IS THE WAY IT IS
// --------------------------------------------
//
//   ACHIEVED IS 100%, WHATEVER THE TASKS SAY. Finishing is a judgement the
//   owner makes, not an arithmetic result. A project can be genuinely done with
//   two tasks left in it that turned out not to matter, and a planner that
//   argues about it is a planner people start lying to.
//
//   DROPPED IS EXCLUDED FROM ITS PARENT, not counted as zero. A mission with
//   four projects where one was abandoned is 3-project mission now. Counting
//   the dropped one as 0% would mean the honest act of dropping something
//   visibly damages the number above it — which teaches you to leave dead
//   projects lying around, the exact behaviour this is supposed to discourage.
//
//   PAUSED STILL COUNTS. It is part of the plan; it is just not this week.
//
//   AN AVERAGE OF CHILDREN, NOT OF LEAF TASKS. A mission with a 2-task project
//   and a 200-task project is half done when one of them is. Weighting by task
//   count would let a single admin-heavy project drown out everything else, and
//   the count of tasks under a project is an artefact of how finely it happened
//   to be broken down, not a measure of its size.
//
//   `hasBasis` IS AS IMPORTANT AS `percent`. A project with no tasks yet and a
//   project whose tasks are all untouched are both 0%, and they are not the
//   same situation. The UI says "not started" for one and "nothing in it yet"
//   for the other, and it can only do that because this flag exists.
//
// Pure and dependency-free: handed goals and tasks, it returns a tree. Nothing
// is fetched here and nothing is written.

"use strict";

const { PLANNER_CHILD_LEVEL } = require("../constants/planner");

const idOf = (v) => (v == null ? null : String(v._id || v));

/**
 * Progress for one project, from its own tasks.
 *
 * Done over total. `doing` is deliberately worth nothing — a half-finished task
 * is a finished task's worth of optimism and none of its result, and counting
 * it at 50% makes a list of things you started look like progress.
 */
function projectProgress(goal, tasks) {
  if (goal.status === "achieved") {
    return { percent: 100, hasBasis: true, done: tasks.length, total: tasks.length };
  }
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  return {
    percent: total ? Math.round((done / total) * 100) : 0,
    hasBasis: total > 0,
    done,
    total,
  };
}

/**
 * Progress for a mission or a vision, from the rungs below it.
 *
 * Children that were dropped are not in the denominator (see the header). If
 * every child was dropped, or there are none, there is no basis for a number —
 * which the caller must be able to tell apart from a genuine 0%.
 */
function rollUp(goal, children) {
  if (goal.status === "achieved") {
    return { percent: 100, hasBasis: true, done: children.length, total: children.length };
  }
  const counted = children.filter((c) => c.status !== "dropped");
  if (!counted.length) {
    return { percent: 0, hasBasis: false, done: 0, total: 0 };
  }
  const sum = counted.reduce((acc, c) => acc + c.progress.percent, 0);
  return {
    percent: Math.round(sum / counted.length),
    hasBasis: counted.some((c) => c.progress.hasBasis) || counted.some((c) => c.status === "achieved"),
    done: counted.filter((c) => c.progress.percent === 100).length,
    total: counted.length,
  };
}

/**
 * Build the whole ladder for one person, progress included.
 *
 * @param goals  every PlannerGoal row for the owner (any level, any status)
 * @param tasks  every PlannerTask row for the owner
 * @returns { visions, inbox, orphans }
 *
 * `orphans` is not an error path — it is a goal whose parent was deleted or
 * filtered out. Returning them separately rather than dropping them is the
 * difference between the owner seeing "these three missions lost their vision"
 * and their work silently vanishing from the screen.
 */
function buildTree(goals = [], tasks = []) {
  const plain = (d) => (typeof d.toObject === "function" ? d.toObject() : d);

  const nodes = new Map();
  for (const raw of goals) {
    const g = plain(raw);
    nodes.set(idOf(g), { ...g, id: idOf(g), children: [], tasks: [], progress: null });
  }

  // Tasks land on their goal; anything unfiled is the Inbox.
  const inbox = [];
  for (const raw of tasks) {
    const t = { ...plain(raw), id: idOf(raw) };
    const holder = t.goalId ? nodes.get(idOf(t.goalId)) : null;
    if (holder) holder.tasks.push(t);
    else inbox.push(t);
  }

  // Wire parents. A child whose parent is missing is kept aside, not dropped.
  const roots = [];
  const orphans = [];
  for (const node of nodes.values()) {
    if (!node.parentId) {
      roots.push(node);
      continue;
    }
    const parent = nodes.get(idOf(node.parentId));
    if (parent) parent.children.push(node);
    else orphans.push(node);
  }

  // Depth-first, so a parent always rolls up children that are already scored.
  // The ladder is three deep by construction (see PlannerGoal's pre-validate),
  // so this cannot run away.
  const score = (node) => {
    node.children.sort((a, b) => (a.order || 0) - (b.order || 0));
    node.children.forEach(score);
    node.progress = PLANNER_CHILD_LEVEL[node.level]
      ? rollUp(node, node.children)
      : projectProgress(node, node.tasks);
    return node;
  };
  roots.forEach(score);
  orphans.forEach(score);

  roots.sort((a, b) => (a.order || 0) - (b.order || 0));

  return { visions: roots, inbox, orphans };
}

module.exports = { buildTree, projectProgress, rollUp };
