// constants/planner.js
//
// Vocabulary for the personal Planner: one person's Vision → Mission → Project
// → Task ladder.
//
// Same rule as constants/crm.js — records store stable CODES, labels live here
// once, and the Mongoose schemas take their `enum` from the `*_CODES` arrays at
// the bottom. The frontend mirrors these in lib/planner/vocabulary.js the way
// lib/salesJourney/stageConfig.js mirrors the journey stages: the server
// validates, the client labels, and the two move together.
//
// WHY THIS IS SEPARATE FROM THE CRM'S VOCABULARY. Nothing here is a business
// record. A Planner row is one employee's own intent, visible to nobody else,
// and it must never be filterable alongside accounts and journeys — sharing a
// constants file is how that boundary quietly stops being true.

"use strict";

const pair = (code, label, meta = {}) => ({ code, label, ...meta });

/**
 * The three goal levels, outermost first.
 *
 * ONE MODEL HOLDS ALL THREE (see models/Planner/PlannerGoal.js) because they
 * are the same kind of thing at three distances: something you are aiming at,
 * with a reason and a horizon. Tasks are NOT on this list — a task is a
 * different shape (it gets done, on a day, and then it is over) and lives in
 * its own collection.
 *
 * `childLevel` is the ladder itself, in data rather than in an if-chain: it is
 * what the create routes validate against and what the UI reads to label its
 * "add" control. `null` means the bottom of the goal ladder — a project's
 * children are tasks.
 */
const PLANNER_LEVELS = [
  pair("vision", "Vision", {
    childLevel: "mission",
    // The long horizon. Deliberately has no target date in the UI: a vision
    // with a deadline is a mission, and collapsing the two is how the top of
    // the ladder turns into another to-do list.
    blurb: "The long-horizon why. Rarely changes.",
  }),
  pair("mission", "Mission", {
    childLevel: "project",
    blurb: "A multi-month push toward the vision.",
  }),
  pair("project", "Project", {
    // Bottom of the GOAL ladder — a project's children are tasks, which are a
    // different collection, so this is null rather than "task".
    childLevel: null,
    blurb: "A concrete deliverable, made of tasks.",
  }),
];

/**
 * Where a goal stands. Four states, and the two ways of stopping are kept
 * apart on purpose.
 *
 * `paused` and `dropped` both take a goal off the active board, but they mean
 * opposite things a year later: one is "not now", the other is "not ever, and
 * here is what I learned". A planner that offers only one of them gets a
 * graveyard of things nobody will admit are dead — the same failure the sales
 * side just fixed with its outcome axis.
 *
 * `achieved` is set by finishing, not by picking it from a dropdown.
 */
const PLANNER_GOAL_STATUSES = [
  pair("active", "Active"),
  pair("paused", "Paused"),
  pair("achieved", "Achieved"),
  pair("dropped", "Dropped"),
];

/**
 * A task's state. Three, and no more.
 *
 * `doing` earns its place — it is the only way to answer "what did I actually
 * pick up today" — but there is deliberately no `blocked`, no priority ladder
 * and no percentage. This is one person's list; anything they would have to
 * maintain rather than act on is overhead they will stop paying by week three.
 */
const PLANNER_TASK_STATUSES = [
  pair("todo", "To do"),
  pair("doing", "Doing"),
  pair("done", "Done"),
];

const codes = (list) => list.map((x) => x.code);

const PLANNER_LEVEL_CODES = codes(PLANNER_LEVELS);
const PLANNER_GOAL_STATUS_CODES = codes(PLANNER_GOAL_STATUSES);
const PLANNER_TASK_STATUS_CODES = codes(PLANNER_TASK_STATUSES);

/** The ladder as a lookup: "vision" → "mission", "project" → null. */
const PLANNER_CHILD_LEVEL = Object.fromEntries(
  PLANNER_LEVELS.map((l) => [l.code, l.childLevel]),
);

/** The inverse, for validating a parent: "mission" → "vision". */
const PLANNER_PARENT_LEVEL = Object.fromEntries(
  PLANNER_LEVELS.filter((l) => l.childLevel).map((l) => [l.childLevel, l.code]),
);

/** A goal that is neither achieved nor dropped is still being worked. */
const PLANNER_OPEN_GOAL_STATUSES = ["active", "paused"];

module.exports = {
  PLANNER_LEVELS,
  PLANNER_GOAL_STATUSES,
  PLANNER_TASK_STATUSES,
  PLANNER_LEVEL_CODES,
  PLANNER_GOAL_STATUS_CODES,
  PLANNER_TASK_STATUS_CODES,
  PLANNER_CHILD_LEVEL,
  PLANNER_PARENT_LEVEL,
  PLANNER_OPEN_GOAL_STATUSES,
  PLANNER_LOOKUPS: {
    planner_level: PLANNER_LEVELS,
    planner_goal_status: PLANNER_GOAL_STATUSES,
    planner_task_status: PLANNER_TASK_STATUSES,
  },
};
