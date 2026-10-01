// services/reporting/vizSettings.validate.js
//
// WHAT THE BROWSER MAY SAY ABOUT HOW A CHART LOOKS.
//
// Metabase's `visualization_settings` is an open object: it carries column
// formatting, click behaviours that can name a URL, custom series settings,
// and on some versions raw display strings. Passing a browser's object into it
// would hand the page a way to write arbitrary settings onto a question that
// runs against the accounts — so nothing is passed through. A small allowlist
// is read, each field is checked, and a NEW settings object is built here from
// the report's own shape.
//
// ── WHY THE MAPPING IS SERVER-SIDE ──────────────────────────────────────────
// Metabase addresses a chart's axes by RESULT COLUMN NAME — `group_name`,
// `sum`, `debit_previous_period`. Those are the mart's own column names and
// the browser has never been told them and must not be. So the browser names a
// field by the catalogue's opaque id ("ledger.group"), and the mapping from
// that to a column name happens here, where the layout and the compiler's
// naming rules are both in scope.
//
// Anything unrecognised is REFUSED rather than dropped: a setting silently
// ignored is a setting the user thinks they chose.

"use strict";

const { comparisonLabel } = require("./mbqlCompiler");

class VizError extends Error {
  constructor(problems) {
    super("This chart's settings could not be used.");
    this.problems = Array.isArray(problems) ? problems : [problems];
  }
}

/** Every key a caller may send. */
const ALLOWED_KEYS = Object.freeze([
  "type", "title", "showLegend", "showDataLabels", "stacked",
  "xAxisLabel", "yAxisLabel", "dimensions", "metrics", "palette", "goal",
]);

/** How the bars of a grouped chart sit together. */
const STACK_MODES = Object.freeze(["grouped", "stacked", "normalized"]);

/**
 * The palettes on offer.
 *
 * Named rather than free-form: a hex string from the browser is a string that
 * ends up in a rendered document, and "choose from these four" is a feature
 * nobody has ever needed more than.
 */
const PALETTES = Object.freeze({
  grav: ["#0f172a", "#0d9488", "#b45309", "#7c3aed", "#be123c", "#0369a1"],
  neutral: ["#334155", "#64748b", "#94a3b8", "#cbd5e1", "#475569", "#1e293b"],
  ledger: ["#166534", "#b91c1c", "#1d4ed8", "#a16207", "#6d28d9", "#0f766e"],
  daylight: ["#2563eb", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#14b8a6"],
});

const LIMITS = Object.freeze({ title: 120, axisLabel: 60 });

const text = (value, max) => String(value).replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

/**
 * Check what the caller asked for, and build what Metabase will be told.
 *
 * @param {object} raw         the browser's `visualization` object
 * @param {object} shape       from chartCapability.resultShape
 * @param {string[]} types     the displays this shape supports
 * @param {object} layout      the validated layout, for column naming
 * @returns {{type, settings, requested}}
 */
function validateVisualization(raw, { shape, types, layout }) {
  const problems = [];
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};

  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.includes(key)) {
      problems.push(`"${String(key).slice(0, 40)}" is not a chart setting.`);
    }
  }

  const type = input.type === undefined || input.type === null ? types[0] : String(input.type);
  if (!types.includes(type)) {
    /* Named, because "that chart does not suit this report" is actionable and
       "invalid" is not. */
    problems.push(
      types.length
        ? `This report cannot be drawn as a ${type}. It can be drawn as: ${types.join(", ")}.`
        : "This report cannot be drawn as a chart.",
    );
  }

  const bool = (key) => {
    if (input[key] === undefined || input[key] === null) return undefined;
    if (typeof input[key] !== "boolean") {
      problems.push(`"${key}" must be true or false.`);
      return undefined;
    }
    return input[key];
  };

  const showLegend = bool("showLegend");
  const showDataLabels = bool("showDataLabels");

  let stacked;
  if (input.stacked !== undefined && input.stacked !== null) {
    stacked = String(input.stacked);
    if (!STACK_MODES.includes(stacked)) {
      problems.push(`"stacked" must be one of: ${STACK_MODES.join(", ")}.`);
      stacked = undefined;
    }
  }

  let palette;
  if (input.palette !== undefined && input.palette !== null) {
    palette = String(input.palette);
    if (!Object.hasOwn(PALETTES, palette)) {
      problems.push(`"${palette.slice(0, 30)}" is not one of the colour sets on offer.`);
      palette = undefined;
    }
  }

  /* Axis mapping. The browser names fields by the catalogue's ids; anything it
     names must be IN THIS REPORT, which is the only way an axis can address a
     column that exists. */
  const dimensionIds = shape.dimensions.map((d) => d.id);
  const pick = (key, available) => {
    if (input[key] === undefined || input[key] === null) return undefined;
    if (!Array.isArray(input[key])) {
      problems.push(`"${key}" must be a list of fields from this report.`);
      return undefined;
    }
    const chosen = input[key].map((v) => String(v));
    for (const id of chosen) {
      if (!available.includes(id)) {
        problems.push(`"${id.slice(0, 40)}" is not in this report, so it cannot be put on an axis.`);
      }
    }
    return chosen;
  };

  const metricIds = [...new Set(shape.metrics.map((m) => m.id))];
  const dimensions = pick("dimensions", dimensionIds);
  const metrics = pick("metrics", metricIds);

  if (dimensions && dimensions.length > 2) {
    problems.push("A chart can be grouped by at most two things.");
  }

  let title;
  if (input.title !== undefined && input.title !== null) {
    title = text(input.title, LIMITS.title);
    if (!title) problems.push("A chart title cannot be blank.");
  }
  const xAxisLabel = input.xAxisLabel === undefined || input.xAxisLabel === null
    ? undefined : text(input.xAxisLabel, LIMITS.axisLabel);
  const yAxisLabel = input.yAxisLabel === undefined || input.yAxisLabel === null
    ? undefined : text(input.yAxisLabel, LIMITS.axisLabel);

  let goal;
  if (input.goal !== undefined && input.goal !== null) {
    goal = Number(input.goal);
    if (!Number.isFinite(goal)) {
      problems.push("A goal must be a number.");
      goal = undefined;
    }
  }

  if (problems.length) throw new VizError(problems);

  return {
    type,
    requested: { type, title, showLegend, showDataLabels, stacked, xAxisLabel, yAxisLabel,
                 dimensions, metrics, palette, goal },
    settings: buildSettings({
      type, shape, layout,
      title, showLegend, showDataLabels, stacked, xAxisLabel, yAxisLabel, dimensions, metrics,
      palette, goal,
    }),
  };
}

/**
 * The Metabase settings object, built here and never accepted from anywhere.
 *
 * Column names are the mart's, which is why this is the last place they appear
 * before the card: everything above it speaks in catalogue ids.
 */
function buildSettings({
  type, shape, layout, title, showLegend, showDataLabels, stacked,
  xAxisLabel, yAxisLabel, dimensions, metrics, palette, goal,
}) {
  const settings = {};
  if (title) settings["card.title"] = title;

  const dimensionColumns = shape.dimensions.map((d) => columnNameFor(d, layout));
  const metricColumns = shape.metrics.map((m, i) => metricColumnName(m, i, layout));

  const chosenDimensions = dimensions
    ? dimensions.map((id) => columnNameFor(shape.dimensions.find((d) => d.id === id), layout))
    : dimensionColumns.slice(0, 2);
  const chosenMetrics = metrics
    ? shape.metrics.map((m, i) => (metrics.includes(m.id) ? metricColumnName(m, i, layout) : null)).filter(Boolean)
    : metricColumns;

  if (["bar", "row", "line", "area", "combo", "scatter", "waterfall"].includes(type)) {
    settings["graph.dimensions"] = chosenDimensions;
    settings["graph.metrics"] = chosenMetrics;
    if (showDataLabels !== undefined) settings["graph.show_values"] = showDataLabels;
    if (showLegend !== undefined) settings["legend.is_hidden"] = !showLegend;
    if (stacked) {
      settings["stackable.stack_type"] =
        stacked === "grouped" ? null : (stacked === "normalized" ? "normalized" : "stacked");
    }
    if (xAxisLabel) settings["graph.x_axis.title_text"] = xAxisLabel;
    if (yAxisLabel) settings["graph.y_axis.title_text"] = yAxisLabel;
    if (goal !== undefined) { settings["graph.goal_value"] = goal; settings["graph.show_goal"] = true; }
  }

  if (type === "pie" || type === "treemap" || type === "funnel") {
    settings["pie.dimension"] = chosenDimensions[0];
    settings["pie.metric"] = chosenMetrics[0];
    if (showLegend !== undefined) settings["pie.show_legend"] = showLegend;
  }

  if (type === "scalar" || type === "gauge" || type === "progress") {
    settings["scalar.field"] = chosenMetrics[0];
    if (goal !== undefined) settings["progress.goal"] = goal;
  }

  if (palette) {
    settings["series_settings"] = Object.fromEntries(
      chosenMetrics.map((column, i) => [column, { color: PALETTES[palette][i % PALETTES[palette].length] }]),
    );
  }

  return settings;
}

/**
 * The result column a breakout produces.
 *
 * Metabase names a breakout column after the field, which for this mart is the
 * view's own column name — the one thing in this file that is not a catalogue
 * id, and the reason nothing here is ever returned to a caller.
 */
function columnNameFor(dimension, layout) {
  const entry = [...layout.rows, ...layout.columns].find((e) => e.field.id === dimension.id);
  return entry ? entry.field.column : dimension.id;
}

/**
 * The result column an aggregation produces.
 *
 * Named aggregations (every comparison, and every value in a comparison query)
 * carry the `name` the compiler gave them. A plain aggregation is Metabase's
 * own positional name: `sum`, `count`, `avg`, or `sum_2` for the second of the
 * same kind — which is why the index matters.
 */
function metricColumnName(metric, index, layout) {
  if (layout.comparisons.length) {
    const value = layout.values.find((v) => v.field.id === metric.id);
    const label = metric.comparison
      ? comparisonLabel(value, metric.comparison)
      : value.heading;
    return slug(label);
  }
  const base = { total: "sum", count: "count", average: "avg", minimum: "min", maximum: "max" }[
    metric.calculation
  ] || "sum";
  const sameBefore = layout.values.slice(0, index).filter((v) => v.calculation === metric.calculation).length;
  return sameBefore === 0 ? base : `${base}_${sameBefore + 1}`;
}

function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60)
    || "value";
}

module.exports = {
  ALLOWED_KEYS,
  LIMITS,
  PALETTES,
  STACK_MODES,
  VizError,
  validateVisualization,
};
