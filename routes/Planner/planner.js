// routes/Planner/planner.js
//
// The personal Planner API. Mounted at /api/planner.
//
// ONE RULE GOVERNS EVERY HANDLER IN THIS FILE: `ownerId` comes from the verified
// JWT and never from the request body. Every read filters on it, every write
// stamps it, and every id the client names is re-checked against it before it is
// touched. There is no team view, no manager scope and no admin override — not
// as an unbuilt phase, but because this collection holds people's private
// intentions and a route that can read across owners is the only thing standing
// between that and an accident.
//
// WHY EmployeeAuthMiddleware AND NOT A DEPARTMENT GUARD. The Planner is not a
// department. Anyone who can sign in has one, whichever dashboard they came in
// through, and it follows them when they switch. Gating it on a role would mean
// your own goals disappearing because you moved from Sales to HR for an hour.
//
// DELETE IS NARROW ON PURPOSE — see the two handlers at the bottom. A goal with
// anything under it cannot be deleted, only dropped; and deleting a project
// unfiles its tasks rather than destroying them.

"use strict";

const express = require("express");
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const PlannerGoal = require("../../models/Planner/PlannerGoal");
const PlannerTask = require("../../models/Planner/PlannerTask");
const { buildTree } = require("../../services/plannerRollup");
const { plannerAttention } = require("../../services/plannerAttention");
const {
  PLANNER_LOOKUPS,
  PLANNER_LEVEL_CODES,
  PLANNER_GOAL_STATUS_CODES,
  PLANNER_TASK_STATUS_CODES,
  PLANNER_PARENT_LEVEL,
} = require("../../constants/planner");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/* ── helpers ──────────────────────────────────────────────────────────────── */

const owner = (req) => ({
  ownerId: req.user.id,
  ownerEmployeeId: req.user.employeeId || "",
});

const isId = (v) => mongoose.Types.ObjectId.isValid(v);
const fail = (res, code, message) => res.status(code).json({ success: false, message });

/**
 * The IST calendar day, as midnight UTC.
 *
 * Follows the convention the rest of this backend already uses for SOP and
 * attendance (`Date.now() + 5.5h`, then read with `getUTC*`) rather than
 * introducing a timezone library for one field. "Due today" has to mean the
 * same thing at 9am and at 11pm, and in Bhubaneswar those are different UTC
 * days for half the evening.
 */
function istToday(now = Date.now()) {
  const ist = new Date(now + 5.5 * 60 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

/**
 * A due date arrives as "YYYY-MM-DD" — a day the owner picked, not an instant.
 * Anchoring it to midnight UTC keeps it the day they meant; parsing it as a
 * local Date would shift it by one for anyone east of Greenwich.
 */
function parseDay(value) {
  if (value === null || value === "") return null;
  if (!value) return undefined;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return undefined;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** The subset of a body a caller is allowed to set, with everything else dropped. */
function pick(body, fields) {
  const out = {};
  for (const f of fields) if (body[f] !== undefined) out[f] = body[f];
  return out;
}

/* ── vocabulary ───────────────────────────────────────────────────────────── */

// The frontend labels from its own mirror (lib/planner/vocabulary.js); this
// exists so the two can be checked against each other rather than drifting in
// silence, and so a script has somewhere to read the codes from.
router.get("/lookups", (req, res) => {
  res.json({ success: true, data: PLANNER_LOOKUPS });
});

/* ── the whole ladder, in one read ────────────────────────────────────────── */

/**
 * GET /api/planner/tree
 *
 * Two queries and an in-memory assembly, deliberately. One person's planner is
 * a few hundred rows at the very most, so an aggregation pipeline here would be
 * harder to read and change for no measurable gain — and buildTree stays pure
 * and unit-testable as a result.
 */
router.get("/tree", async (req, res) => {
  try {
    const scope = { ownerId: req.user.id };
    const [goals, tasks] = await Promise.all([
      PlannerGoal.find(scope).sort({ order: 1, createdAt: 1 }).lean(),
      PlannerTask.find(scope).sort({ order: 1, createdAt: 1 }).lean(),
    ]);
    res.json({ success: true, data: buildTree(goals, tasks) });
  } catch (err) {
    console.error("planner/tree:", err);
    fail(res, 500, "Could not load your planner.");
  }
});

/**
 * GET /api/planner/review
 *
 * Everything asking for a decision. Same two reads as /tree, then a pure pass
 * over the assembled tree — the Review screen and the Ladder can never disagree
 * about what is stalled, because they are looking at one answer.
 */
router.get("/review", async (req, res) => {
  try {
    const scope = { ownerId: req.user.id };
    const [goals, tasks] = await Promise.all([
      PlannerGoal.find(scope).sort({ order: 1, createdAt: 1 }).lean(),
      PlannerTask.find(scope).sort({ order: 1, createdAt: 1 }).lean(),
    ]);
    res.json({ success: true, data: plannerAttention(buildTree(goals, tasks)) });
  } catch (err) {
    console.error("planner/review:", err);
    fail(res, 500, "Could not work out what needs your attention.");
  }
});

/* ── goals ────────────────────────────────────────────────────────────────── */

const GOAL_FIELDS = ["title", "why", "status", "statusNote", "order"];

/**
 * Confirm a proposed parent exists, belongs to this owner, and sits exactly one
 * rung above the child's level.
 *
 * The ownership half is the one that matters: without it, anyone could hang a
 * mission off a vision id they guessed, and it would then appear in someone
 * else's tree. Returns an error STRING or null, so both create and reparent can
 * use it without either duplicating the rules.
 */
async function validateParent(level, parentId, ownerId) {
  const expected = PLANNER_PARENT_LEVEL[level] || null;

  if (!expected) {
    return parentId ? `A ${level} sits at the top — it cannot have a parent.` : null;
  }
  if (!parentId) return `A ${level} must belong to a ${expected}.`;
  if (!isId(parentId)) return "That parent id is not valid.";

  const parent = await PlannerGoal.findOne({ _id: parentId, ownerId }).lean();
  if (!parent) return "That parent does not exist in your planner.";
  if (parent.level !== expected) {
    return `A ${level} must belong to a ${expected}, not a ${parent.level}.`;
  }
  return null;
}

router.post("/goals", async (req, res) => {
  try {
    const { level, parentId = null } = req.body || {};
    if (!PLANNER_LEVEL_CODES.includes(level)) {
      return fail(res, 400, `Level must be one of: ${PLANNER_LEVEL_CODES.join(", ")}.`);
    }
    if (!String(req.body?.title || "").trim()) {
      return fail(res, 400, "Give it a title.");
    }

    const parentError = await validateParent(level, parentId, req.user.id);
    if (parentError) return fail(res, 400, parentError);

    const goal = await PlannerGoal.create({
      ...owner(req),
      ...pick(req.body, GOAL_FIELDS),
      level,
      parentId: parentId || null,
      targetDate: parseDay(req.body?.targetDate) ?? undefined,
    });

    res.status(201).json({ success: true, data: goal });
  } catch (err) {
    console.error("planner/goals create:", err);
    fail(res, 400, err.message || "Could not create that.");
  }
});

router.patch("/goals/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 400, "Not a valid id.");

    const goal = await PlannerGoal.findOne({ _id: req.params.id, ownerId: req.user.id });
    if (!goal) return fail(res, 404, "Not found in your planner.");

    const patch = pick(req.body, GOAL_FIELDS);
    if (patch.status !== undefined) {
      if (!PLANNER_GOAL_STATUS_CODES.includes(patch.status)) {
        return fail(res, 400, "That is not a status a goal can be in.");
      }
      // Only stamp when it actually moves, so re-saving a paused goal does not
      // keep resetting the date it was paused on.
      if (patch.status !== goal.status) goal.statusAt = new Date();
    }

    // Reparenting — moving a mission to a different vision. Same rules as
    // creation, so a move can never produce a tree that a create could not.
    if (req.body?.parentId !== undefined) {
      const nextParent = req.body.parentId || null;
      const parentError = await validateParent(goal.level, nextParent, req.user.id);
      if (parentError) return fail(res, 400, parentError);
      goal.parentId = nextParent;
    }

    const targetDate = parseDay(req.body?.targetDate);
    if (targetDate !== undefined) goal.targetDate = targetDate;

    Object.assign(goal, patch);
    await goal.save();

    res.json({ success: true, data: goal });
  } catch (err) {
    console.error("planner/goals patch:", err);
    fail(res, 400, err.message || "Could not save that.");
  }
});

/**
 * DELETE /api/planner/goals/:id
 *
 * Refuses while anything hangs off it, and names what. Deleting a vision should
 * not be able to silently take three missions and thirty projects with it — and
 * the honest way to retire a goal you no longer want is `status: "dropped"`,
 * which keeps the record and the reason. Delete is for mistakes: the goal you
 * created twice, or typed into the wrong level.
 *
 * A project's TASKS are the exception. They are unfiled to the Inbox rather
 * than blocking the delete or being destroyed with it, because a task is a real
 * piece of work that outlives the container someone put it in.
 */
router.delete("/goals/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 400, "Not a valid id.");

    const goal = await PlannerGoal.findOne({ _id: req.params.id, ownerId: req.user.id });
    if (!goal) return fail(res, 404, "Not found in your planner.");

    const childCount = await PlannerGoal.countDocuments({
      ownerId: req.user.id,
      parentId: goal._id,
    });
    if (childCount) {
      return fail(
        res,
        409,
        `This still holds ${childCount} thing${childCount > 1 ? "s" : ""}. ` +
          "Move or delete those first, or drop this instead of deleting it.",
      );
    }

    const unfiled = await PlannerTask.updateMany(
      { ownerId: req.user.id, goalId: goal._id },
      { $set: { goalId: null } },
    );
    await goal.deleteOne();

    res.json({
      success: true,
      data: { deleted: String(goal._id), tasksUnfiled: unfiled.modifiedCount || 0 },
    });
  } catch (err) {
    console.error("planner/goals delete:", err);
    fail(res, 500, "Could not delete that.");
  }
});

/* ── tasks ────────────────────────────────────────────────────────────────── */

const TASK_FIELDS = ["title", "notes", "status", "order"];

/**
 * GET /api/planner/tasks?scope=today|open|all&goalId=
 *
 * `today` is everything due on or before the current IST day plus anything
 * already picked up — overdue work belongs on today's list, not on the day it
 * was originally due, where nobody will look for it again.
 */
router.get("/tasks", async (req, res) => {
  try {
    const query = { ownerId: req.user.id };

    if (req.query.goalId) {
      if (!isId(req.query.goalId)) return fail(res, 400, "Not a valid goal id.");
      query.goalId = req.query.goalId;
    } else if (req.query.goalId === "") {
      query.goalId = null; // the Inbox, asked for explicitly
    }

    const scope = req.query.scope || "all";
    if (scope === "open") {
      query.status = { $ne: "done" };
    } else if (scope === "today") {
      query.$and = [
        { status: { $ne: "done" } },
        { $or: [{ dueOn: { $lte: istToday() } }, { status: "doing" }] },
      ];
    }

    const tasks = await PlannerTask.find(query)
      .sort({ dueOn: 1, order: 1, createdAt: 1 })
      .lean();

    res.json({ success: true, data: tasks });
  } catch (err) {
    console.error("planner/tasks list:", err);
    fail(res, 500, "Could not load those tasks.");
  }
});

router.post("/tasks", async (req, res) => {
  try {
    if (!String(req.body?.title || "").trim()) return fail(res, 400, "Give it a title.");

    // Filing is optional (a task with no goal is the Inbox), but a goal that IS
    // named must be one of this owner's.
    const goalId = req.body?.goalId || null;
    if (goalId) {
      if (!isId(goalId)) return fail(res, 400, "Not a valid goal id.");
      const exists = await PlannerGoal.exists({ _id: goalId, ownerId: req.user.id });
      if (!exists) return fail(res, 400, "That goal does not exist in your planner.");
    }

    const task = await PlannerTask.create({
      ...owner(req),
      ...pick(req.body, TASK_FIELDS),
      goalId,
      dueOn: parseDay(req.body?.dueOn) ?? undefined,
    });

    res.status(201).json({ success: true, data: task });
  } catch (err) {
    console.error("planner/tasks create:", err);
    fail(res, 400, err.message || "Could not add that.");
  }
});

router.patch("/tasks/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 400, "Not a valid id.");

    const task = await PlannerTask.findOne({ _id: req.params.id, ownerId: req.user.id });
    if (!task) return fail(res, 404, "Not found in your planner.");

    const patch = pick(req.body, TASK_FIELDS);
    if (patch.status !== undefined && !PLANNER_TASK_STATUS_CODES.includes(patch.status)) {
      return fail(res, 400, "That is not a state a task can be in.");
    }

    if (req.body?.goalId !== undefined) {
      const goalId = req.body.goalId || null;
      if (goalId) {
        if (!isId(goalId)) return fail(res, 400, "Not a valid goal id.");
        const exists = await PlannerGoal.exists({ _id: goalId, ownerId: req.user.id });
        if (!exists) return fail(res, 400, "That goal does not exist in your planner.");
      }
      task.goalId = goalId;
    }

    const dueOn = parseDay(req.body?.dueOn);
    if (dueOn !== undefined) task.dueOn = dueOn;

    // Assigned rather than passed to findOneAndUpdate so the model's pre-save
    // hook runs — it is what keeps `doneAt` honest with `status`.
    Object.assign(task, patch);
    await task.save();

    res.json({ success: true, data: task });
  } catch (err) {
    console.error("planner/tasks patch:", err);
    fail(res, 400, err.message || "Could not save that.");
  }
});

router.delete("/tasks/:id", async (req, res) => {
  try {
    if (!isId(req.params.id)) return fail(res, 400, "Not a valid id.");
    const result = await PlannerTask.deleteOne({
      _id: req.params.id,
      ownerId: req.user.id,
    });
    if (!result.deletedCount) return fail(res, 404, "Not found in your planner.");
    res.json({ success: true, data: { deleted: req.params.id } });
  } catch (err) {
    console.error("planner/tasks delete:", err);
    fail(res, 500, "Could not delete that.");
  }
});

module.exports = router;
