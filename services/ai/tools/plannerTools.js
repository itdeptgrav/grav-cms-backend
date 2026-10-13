"use strict";

const { registerTool } = require("../toolRegistry");
const {
  PLANNER_CATALOGUE_ID,
  CATALOGUE,
  metricFromText,
  metric,
} = require("../../plannerSemanticContract");
const { loadPlanner, summarizePlanner, resolvePlannerItem } = require("../../plannerAssistantContext");

const mayReadPlanner = (user) => Boolean(user?.id);

async function claimPlannerMetric({ user, message } = {}) {
  const definition = metricFromText(message);
  if (!definition) return null;
  if (definition.query !== "item") return { metric: definition.id };
  const loaded = await loadPlanner(user);
  const resolution = resolvePlannerItem(loaded, message);
  return resolution.found || resolution.ambiguous ? { metric: definition.id } : null;
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

function renderTasks(rows, label) {
  if (!rows?.length) return `You have no ${label.toLowerCase()}.`;
  const shown = rows.slice(0, 20).map((row) => {
    const parts = [row.title, row.status];
    if (row.dueOn) parts.push(`due ${dateOnly(row.dueOn)}`);
    if (row.goalTitle) parts.push(`under ${row.goalTitle}`);
    return parts.filter(Boolean).join(" — ");
  });
  const remainder = rows.length - shown.length;
  return `${label} (${rows.length}): ${shown.join("; ")}${remainder ? `; and ${remainder} more` : ""}.`;
}

function renderGoals(rows) {
  if (!rows?.length) return "You have no planner goals.";
  const shown = rows.slice(0, 20).map((row) => {
    const parts = [row.title, row.level, row.status];
    if (row.targetDate) parts.push(`target ${dateOnly(row.targetDate)}`);
    if (row.progressHasBasis) parts.push(`${row.progress}%`);
    return parts.filter(Boolean).join(" — ");
  });
  const remainder = rows.length - shown.length;
  return `Planner goals (${rows.length}): ${shown.join("; ")}${remainder ? `; and ${remainder} more` : ""}.`;
}

function renderAttention(value) {
  const rows = value?.items || [];
  if (!rows.length && !value?.unfiled) return "Your planner has no current attention items.";
  const parts = rows.slice(0, 20).map((row) => `${row.title} — ${row.detail}`);
  if (value?.unfiled) parts.push(`${value.unfiled} open task${value.unfiled === 1 ? " is" : "s are"} unfiled`);
  return `Planner attention: ${parts.join("; ")}.`;
}

function renderOverview(value) {
  if (!value) return "I couldn't verify your planner summary.";
  return `Planner overview: ${value.goalCount} goals (${value.activeGoalCount} active); ` +
    `${value.openTaskCount} open tasks (${value.doingTaskCount} doing, ${value.overdueTaskCount} overdue, ` +
    `${value.inboxTaskCount} unfiled); ${value.completedTaskCount} completed tasks; ` +
    `${value.attentionCount} goal${value.attentionCount === 1 ? "" : "s"} need a decision.`;
}

function renderItem(definition, resolution) {
  if (!resolution?.found) {
    if (resolution?.ambiguous) {
      const choices = (resolution.matches || []).map((row) => `${row.title} (${row.kind})`).join(", ");
      return choices
        ? `That matches more than one planner item: ${choices}. Please say whether you mean the task or goal.`
        : "That matches more than one planner item. Please identify the task or goal.";
    }
    return "I couldn't match one planner task or goal exactly. Please use its recorded title.";
  }
  const row = resolution.record;
  let value = definition.id === "planner.item_progress" ? row.progress : row[definition.path];
  if (definition.valueType === "date") value = dateOnly(value);
  if (definition.valueType === "date_time") value = dateTime(value);
  if (definition.valueType === "percent" && value !== null && value !== undefined) value = `${value}%`;
  return value === null || value === undefined || value === ""
    ? `${row.title}'s ${definition.label.toLowerCase()} is not recorded.`
    : `${row.title}'s ${definition.label.toLowerCase()} is ${value}.`;
}

function renderPlannerMetric({ data } = {}) {
  const definition = data?.definition;
  if (!definition) return "I couldn't verify which planner information was requested.";
  if (definition.query === "item") return renderItem(definition, data.item);
  if (definition.query === "overview") return renderOverview(data.value);
  if (definition.query === "goals") return renderGoals(data.value);
  if (definition.query === "attention") return renderAttention(data.value);
  return renderTasks(data.value, definition.label);
}

registerTool({
  name: "planner_metric",
  modelSelectable: false,
  semantic: { catalogue: PLANNER_CATALOGUE_ID, domains: ["planner_summary", "planner_item"], subjects: ["planner", "planner_item"] },
  description: "One exact, owner-scoped personal Planner query. Catalogue-only and read-only.",
  permission: mayReadPlanner,
  parameters: {
    type: "object",
    properties: { metric: { type: "string", enum: Object.keys(CATALOGUE.metrics) } },
    required: ["metric"],
    additionalProperties: false,
  },
  matches: (message) => Boolean(metricFromText(message)),
  claim: claimPlannerMetric,
  provideContext: async ({ user, message, args }) => {
    const definition = metric(args?.metric);
    const loaded = await loadPlanner(user);
    return definition?.query === "item"
      ? { definition, item: resolvePlannerItem(loaded, message) }
      : { definition, value: summarizePlanner(loaded, definition?.query) };
  },
  renderAnswer: renderPlannerMetric,
});

module.exports = { claimPlannerMetric, renderPlannerMetric };
