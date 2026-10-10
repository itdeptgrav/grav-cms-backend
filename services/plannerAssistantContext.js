"use strict";

const PlannerGoal = require("../models/Planner/PlannerGoal");
const PlannerTask = require("../models/Planner/PlannerTask");
const { buildTree } = require("./plannerRollup");
const { plannerAttention } = require("./plannerAttention");
const { includesTerm } = require("./ai/semanticCatalogue");

function istToday(now = Date.now()) {
  const ist = new Date(now + 5.5 * 60 * 60 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

const idOf = (value) => String(value?._id || value || "");

function safeGoal(goal, progress = null) {
  return {
    kind: "goal",
    level: goal.level || null,
    title: goal.title || "",
    why: goal.why || null,
    targetDate: goal.targetDate || null,
    status: goal.status || null,
    statusNote: goal.statusNote || null,
    statusAt: goal.statusAt || null,
    order: Number(goal.order || 0),
    createdAt: goal.createdAt || null,
    updatedAt: goal.updatedAt || null,
    progress: progress?.percent ?? null,
    progressHasBasis: progress?.hasBasis ?? null,
  };
}

function safeTask(task, goalTitle = null) {
  return {
    kind: "task",
    title: task.title || "",
    notes: task.notes || null,
    status: task.status || null,
    dueOn: task.dueOn || null,
    doneAt: task.doneAt || null,
    order: Number(task.order || 0),
    createdAt: task.createdAt || null,
    updatedAt: task.updatedAt || null,
    goalTitle,
  };
}

async function loadPlanner(user) {
  if (!user?.id) return { available: false, goals: [], tasks: [], tree: null, attention: null };
  const scope = { ownerId: user.id };
  const [goals, tasks] = await Promise.all([
    PlannerGoal.find(scope).sort({ order: 1, createdAt: 1 }).lean(),
    PlannerTask.find(scope).sort({ dueOn: 1, order: 1, createdAt: 1 }).lean(),
  ]);
  const tree = buildTree(goals, tasks);
  return { available: true, goals, tasks, tree, attention: plannerAttention(tree) };
}

function progressByGoal(tree) {
  const map = new Map();
  const visit = (goal) => {
    map.set(idOf(goal), goal.progress || null);
    for (const child of goal.children || []) visit(child);
  };
  for (const root of [...(tree?.visions || []), ...(tree?.orphans || [])]) visit(root);
  return map;
}

function summarizePlanner(loaded, query) {
  const today = istToday();
  const tomorrow = new Date(today.getTime() + 86400000);
  const goalTitle = new Map(loaded.goals.map((goal) => [idOf(goal), goal.title]));
  const progress = progressByGoal(loaded.tree);
  const goals = loaded.goals.map((goal) => safeGoal(goal, progress.get(idOf(goal))));
  const tasks = loaded.tasks.map((task) => safeTask(task, task.goalId ? goalTitle.get(idOf(task.goalId)) || null : null));
  const open = tasks.filter((task) => task.status !== "done");
  const dueValue = (task) => task.dueOn ? new Date(task.dueOn).getTime() : null;
  if (query === "overview") {
    return {
      goalCount: goals.length,
      activeGoalCount: goals.filter((goal) => goal.status === "active").length,
      taskCount: tasks.length,
      openTaskCount: open.length,
      doingTaskCount: tasks.filter((task) => task.status === "doing").length,
      completedTaskCount: tasks.filter((task) => task.status === "done").length,
      overdueTaskCount: open.filter((task) => dueValue(task) !== null && dueValue(task) < today.getTime()).length,
      inboxTaskCount: open.filter((task) => !task.goalTitle).length,
      attentionCount: loaded.attention?.needsDecision || 0,
    };
  }
  if (query === "goals") return goals;
  if (query === "open_tasks") return open;
  if (query === "today_tasks") {
    return open.filter((task) => (dueValue(task) !== null && dueValue(task) <= today.getTime()) || task.status === "doing");
  }
  if (query === "due_today_tasks") {
    return open.filter((task) => dueValue(task) !== null && dueValue(task) >= today.getTime() && dueValue(task) < tomorrow.getTime());
  }
  if (query === "overdue_tasks") {
    return open.filter((task) => dueValue(task) !== null && dueValue(task) < today.getTime());
  }
  if (query === "inbox_tasks") return open.filter((task) => !task.goalTitle);
  if (query === "completed_tasks") return tasks.filter((task) => task.status === "done");
  if (query === "attention") return loaded.attention;
  return null;
}

function resolvePlannerItem(loaded, message) {
  const progress = progressByGoal(loaded.tree);
  const goalTitle = new Map(loaded.goals.map((goal) => [idOf(goal), goal.title]));
  const wantsTask = /\btask\b/i.test(String(message || ""));
  const wantsGoal = /\b(goal|vision|mission|project)\b/i.test(String(message || ""));
  const candidates = [
    ...loaded.goals.map((record) => ({ kind: "goal", title: record.title, record })),
    ...loaded.tasks.map((record) => ({ kind: "task", title: record.title, record })),
  ].filter((candidate) => !(wantsTask && !wantsGoal && candidate.kind !== "task"))
    .filter((candidate) => !(wantsGoal && !wantsTask && candidate.kind !== "goal"));
  const matches = candidates.filter((candidate) => includesTerm(message, candidate.title));
  if (!matches.length) return { found: false, ambiguous: false, matches: [] };
  const longest = Math.max(...matches.map((candidate) => String(candidate.title).length));
  const winners = matches.filter((candidate) => String(candidate.title).length === longest);
  if (winners.length !== 1) {
    return {
      found: false,
      ambiguous: true,
      matches: winners.slice(0, 5).map((candidate) => ({ title: candidate.title, kind: candidate.kind })),
    };
  }
  const winner = winners[0];
  const record = winner.kind === "goal"
    ? safeGoal(winner.record, progress.get(idOf(winner.record)))
    : safeTask(winner.record, winner.record.goalId ? goalTitle.get(idOf(winner.record.goalId)) || null : null);
  return { found: true, ambiguous: false, record };
}

module.exports = { loadPlanner, summarizePlanner, resolvePlannerItem, istToday };
