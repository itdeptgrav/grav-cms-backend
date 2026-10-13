"use strict";

const PlannerGoal = require("../models/Planner/PlannerGoal");
const PlannerTask = require("../models/Planner/PlannerTask");
const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");
const { compileFieldCoverageContract, mongooseSchemaPaths } = require("./ai/fieldCoverageContract");

const PLANNER_CATALOGUE_ID = "planner";

const DEFINITIONS = Object.freeze([
  ["planner.overview", "Planner overview", ["planner summary", "my planner", "planner overview"], "summary", null, "overview"],
  ["planner.goals", "Planner goals", ["my goals", "planner goals", "goals"], "goal_list", null, "goals"],
  ["planner.open_tasks", "Open planner tasks", ["open tasks", "my tasks", "to do list", "todo list", "tasks"], "task_list", null, "open_tasks"],
  ["planner.today_tasks", "Today's planner tasks", ["today's tasks", "tasks for today", "today tasks", "my tasks today"], "task_list", null, "today_tasks"],
  ["planner.due_today_tasks", "Tasks due today", ["tasks due today", "due today"], "task_list", null, "due_today_tasks"],
  ["planner.overdue_tasks", "Overdue planner tasks", ["overdue tasks", "late tasks"], "task_list", null, "overdue_tasks"],
  ["planner.inbox_tasks", "Unfiled planner tasks", ["unfiled tasks", "inbox tasks", "planner inbox"], "task_list", null, "inbox_tasks"],
  ["planner.completed_tasks", "Completed planner tasks", ["completed tasks", "done tasks", "finished tasks"], "task_list", null, "completed_tasks"],
  ["planner.attention", "Planner attention items", ["planner review", "what needs attention", "stalled goals", "planner attention"], "attention_list", null, "attention"],
  ["planner.item_title", "Planner item title", ["task title", "goal title", "planner item title"], "text", "title", "item"],
  ["planner.item_status", "Planner item status", ["task status", "goal status", "planner status", "status"], "text", "status", "item"],
  ["planner.item_notes", "Planner item notes", ["task notes", "planner notes", "notes"], "text", "notes", "item"],
  ["planner.item_due_date", "Task due date", ["task due date", "due date", "due on"], "date", "dueOn", "item"],
  ["planner.item_completion_date", "Task completion date", ["task completion date", "completed on", "done date"], "date_time", "doneAt", "item"],
  ["planner.item_target_date", "Goal target date", ["goal target date", "target date", "deadline"], "date", "targetDate", "item"],
  ["planner.item_why", "Goal reason", ["goal reason", "why does this goal exist", "goal why"], "text", "why", "item"],
  ["planner.item_level", "Goal level", ["goal level", "vision mission or project", "planner level"], "text", "level", "item"],
  ["planner.item_status_note", "Goal status reason", ["status reason", "pause reason", "drop reason", "status note"], "text", "statusNote", "item"],
  ["planner.item_status_changed_at", "Goal status changed at", ["status changed at", "goal status date", "goal status updated at"], "date_time", "statusAt", "item"],
  ["planner.item_progress", "Goal progress", ["goal progress", "project progress", "progress"], "percent", null, "item"],
].map(([id, label, aliases, valueType, path, query]) => Object.freeze({
  id, label, aliases: Object.freeze(aliases), valueType, path, query,
  temporal: "current",
  source: "personal_planner",
  domain: query === "item" ? "planner_item" : "planner_summary",
  entity: query === "item" ? "planner_item" : "planner",
})));

const GOAL_EXCLUDED = Object.freeze({
  _id: "Internal record identifier; exact title is the conversational identity.",
  __v: "Database concurrency metadata.",
  ownerId: "Server-owned privacy boundary; never conversational data.",
  ownerEmployeeId: "Server-owned privacy boundary; never conversational data.",
  parentId: "Internal relationship identifier; the tree adapter resolves relationships.",
});
const TASK_EXCLUDED = Object.freeze({
  _id: "Internal record identifier; exact title is the conversational identity.",
  __v: "Database concurrency metadata.",
  ownerId: "Server-owned privacy boundary; never conversational data.",
  ownerEmployeeId: "Server-owned privacy boundary; never conversational data.",
  goalId: "Internal relationship identifier; the tree adapter resolves relationships.",
});

const exposed = (entries) => entries.map(([id, label, valueType, path]) => ({ id, label, valueType, path }));

const GOAL_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "planner.goal",
  sourceModels: ["models/Planner/PlannerGoal.js"],
  schemaPaths: mongooseSchemaPaths(PlannerGoal.schema),
  exposed: exposed([
    ["planner.item_level", "Goal level", "text", "level"],
    ["planner.item_title", "Planner item title", "text", "title"],
    ["planner.item_why", "Goal reason", "text", "why"],
    ["planner.item_target_date", "Goal target date", "date", "targetDate"],
    ["planner.item_status", "Planner item status", "text", "status"],
    ["planner.item_status_note", "Goal status reason", "text", "statusNote"],
    ["planner.item_status_changed_at", "Goal status changed at", "date_time", "statusAt"],
    ["planner.goals", "Goal order", "number", "order"],
    ["planner.goals", "Goal created at", "date_time", "createdAt"],
    ["planner.goals", "Goal updated at", "date_time", "updatedAt"],
  ]),
  excluded: GOAL_EXCLUDED,
});

const TASK_FIELD_CONTRACT = compileFieldCoverageContract({
  id: "planner.task",
  sourceModels: ["models/Planner/PlannerTask.js"],
  schemaPaths: mongooseSchemaPaths(PlannerTask.schema),
  exposed: exposed([
    ["planner.item_title", "Planner item title", "text", "title"],
    ["planner.item_notes", "Planner item notes", "text", "notes"],
    ["planner.item_status", "Planner item status", "text", "status"],
    ["planner.item_due_date", "Task due date", "date", "dueOn"],
    ["planner.item_completion_date", "Task completion date", "date_time", "doneAt"],
    ["planner.open_tasks", "Task order", "number", "order"],
    ["planner.open_tasks", "Task created at", "date_time", "createdAt"],
    ["planner.open_tasks", "Task updated at", "date_time", "updatedAt"],
  ]),
  excluded: TASK_EXCLUDED,
});

const CATALOGUE = compileSemanticCatalogue({
  id: PLANNER_CATALOGUE_ID,
  domains: [
    { id: "planner_summary", label: "personal planner", aliases: ["planner", "my plan", "to do list"] },
    { id: "planner_item", label: "planner item", aliases: ["planner task", "planner goal"] },
  ],
  entities: [
    { id: "planner", label: "planner", aliases: ["personal planner"] },
    { id: "planner_item", label: "planner item", aliases: ["goal", "task"] },
  ],
  metrics: DEFINITIONS,
});

module.exports = {
  PLANNER_CATALOGUE_ID,
  CATALOGUE,
  GOAL_FIELD_CONTRACT,
  TASK_FIELD_CONTRACT,
  DEFINITIONS,
  metric: (id) => CATALOGUE.metrics[id] || null,
  metricFromText: (value) => CATALOGUE.resolveMetric(value),
};
