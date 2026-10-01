// services/reporting/chartCapability.js
//
// CAN THIS REPORT BE DRAWN, AND AS WHAT?
//
// Two questions, both answered here and both answered on the SERVER, because
// the browser must not be able to ask for a chart the result cannot support —
// Metabase accepts any `display` you send it without checking that the shape
// makes sense, so "bar" over a hundred-column detail listing is a request it
// will happily honour and nobody can read.
//
// ── WHAT DECIDES ────────────────────────────────────────────────────────────
// The SHAPE of the result, which the validated layout already describes: how
// many things it groups by, whether the first of them is a date, and how many
// figures it calculates. That is the same information Metabase's own
// visualiser uses to decide which buttons to light up, reproduced here rather
// than asked for, because there is no endpoint that answers "which displays
// suit this query" without first saving the card and running it.
//
// ── WHAT CANNOT BE DRAWN ────────────────────────────────────────────────────
// A comparison of an average, a minimum or a maximum. A chart is one Metabase
// question; a comparison inside one question needs a conditional aggregation;
// Metabase 1.63.1 has `sum-where` and `count-where` and has no `avg-where`,
// `min-where` or `max-where` (each answers HTTP 500), and its `offset()` is
// unsupported here. So those layouts are refused for charting, in one plain
// sentence, and the spreadsheet still shows them. Nothing is approximated: a
// chart whose numbers are nearly the sheet's is worse than no chart.

"use strict";

/** Every display Metabase accepts. Accepting is not the same as suiting. */
const ALL_DISPLAYS = Object.freeze([
  "table", "bar", "row", "line", "area", "combo", "pie", "scalar", "gauge",
  "progress", "funnel", "scatter", "waterfall", "sankey", "treemap", "map", "pivot",
]);

/** The calculations a comparison can be expressed with in a single question. */
const COMPARABLE_IN_ONE_QUERY = new Set(["total", "count"]);

const DATEISH = new Set(["date", "datetime"]);
const NUMERIC = new Set(["money", "number", "integer"]);

/**
 * The shape of the result the chart query will return.
 *
 * Columns come out in exactly this order — breakouts first in layout order,
 * then one column per aggregation — which is what lets the visualisation
 * settings name them without the browser ever seeing a column name.
 */
function resultShape(layout) {
  if (layout.mode === "detail") {
    return {
      mode: "detail",
      dimensions: layout.rows.map((r) => ({ id: r.field.id, label: r.heading, type: r.field.type })),
      metrics: [],
      columnCount: layout.rows.length,
    };
  }

  const dimensions = [
    ...layout.rows.map((r) => ({ id: r.field.id, label: r.heading, type: r.field.type })),
    ...layout.columns.map((c) => ({ id: c.field.id, label: c.heading, type: c.field.type })),
  ];

  /* One metric per value, plus one per comparison — except a difference or a
     percentage, which REPLACES nothing and adds one column of its own. The
     count has to match the compiler exactly, because the visualisation
     settings address columns by position. */
  const metrics = [];
  for (const value of layout.values) {
    metrics.push({
      id: value.field.id,
      label: value.heading,
      type: value.field.type,
      calculation: value.calculation,
      comparison: null,
    });
    for (const c of layout.comparisons.filter((x) => x.field.id === value.field.id)) {
      metrics.push({
        id: value.field.id,
        label: null,            // the compiler names it; see comparisonLabel
        type: c.display === "percentage_difference" ? "percent" : value.field.type,
        calculation: value.calculation,
        comparison: c,
      });
    }
  }

  return {
    mode: "summary",
    dimensions,
    metrics,
    columnCount: dimensions.length + metrics.length,
  };
}

/**
 * Can this layout be one faithful chart?
 *
 * The refusal is a sentence for a person, never a reason about the engine.
 */
function chartSupport(layout) {
  const shape = resultShape(layout);

  if (layout.mode === "detail") {
    return {
      supported: true,
      reason: null,
      shape,
      /* A list of records is a table. Drawing thirty ledger names along an
         axis is not a chart anybody reads. */
      types: ["table"],
    };
  }

  if (!layout.values.length) {
    return {
      supported: false,
      reason: "Add a number to Values before this report can be drawn as a chart.",
      shape,
      types: [],
    };
  }

  const awkward = layout.comparisons.find((c) => {
    const value = layout.values.find((v) => v.field.id === c.field.id);
    return value && !COMPARABLE_IN_ONE_QUERY.has(value.calculation);
  });
  if (awkward) {
    const value = layout.values.find((v) => v.field.id === awkward.field.id);
    return {
      supported: false,
      reason:
        `A comparison of ${CALCULATION_WORDS[value.calculation] || `a ${value.calculation}`} cannot be ` +
        "drawn as one chart. The figures are in the sheet, and a total or a count can be charted.",
      shape,
      types: [],
    };
  }

  return { supported: true, reason: null, shape, types: supportedVisualizations(shape) };
}

const CALCULATION_WORDS = {
  average: "an average",
  minimum: "a minimum",
  maximum: "a maximum",
  total: "a total",
  count: "a count",
};

/**
 * Which displays suit this shape, best first.
 *
 * The first entry is what the chart opens on when the caller asks for nothing
 * in particular. `table` is always last and always present: whatever the
 * shape, a table of it is readable.
 */
function supportedVisualizations(shape) {
  if (shape.mode === "detail") return ["table"];

  const dims = shape.dimensions;
  const metrics = shape.metrics.length;
  const firstIsDate = dims.length > 0 && DATEISH.has(dims[0].type);
  const out = [];

  if (dims.length === 0) {
    // One figure and nothing to group it by: a headline number.
    if (metrics === 1) out.push("scalar", "gauge", "progress");
    return [...out, "table"];
  }

  if (dims.length === 1) {
    if (firstIsDate) {
      // Time goes along an axis. A pie of months is a well-known mistake.
      out.push("line", "area", "bar");
      if (metrics >= 2) out.push("combo");
      if (metrics === 1) out.push("waterfall");
    } else {
      out.push("bar", "row");
      if (metrics === 1) out.push("pie", "treemap", "funnel");
      if (metrics >= 2) out.push("combo");
      if (metrics === 2) out.push("scatter");
    }
    return [...out, "table"];
  }

  if (dims.length === 2) {
    /* Two things to group by is one series per value of the second. Metabase
       draws that for ONE figure; with several it has nothing left to vary, so
       the honest answer is a table. */
    if (metrics === 1) {
      out.push(firstIsDate ? "line" : "bar", firstIsDate ? "area" : "row");
      if (firstIsDate) out.push("bar");
    }
    return [...out, "table", "pivot"];
  }

  // Three or more breakouts: no axis left. A pivot table is the readable form.
  return ["table", "pivot"];
}

/** The display a report opens on when the caller does not choose. */
function defaultVisualization(types) {
  return types[0] || "table";
}

module.exports = {
  ALL_DISPLAYS,
  COMPARABLE_IN_ONE_QUERY,
  chartSupport,
  defaultVisualization,
  resultShape,
  supportedVisualizations,
};
