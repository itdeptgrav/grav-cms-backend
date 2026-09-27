// services/reporting/mbqlCompiler.js
//
// A VALIDATED LAYOUT → THE MBQL QUERIES THAT ANSWER IT.
//
// Pure. It takes a layout and the resolved Metabase ids and returns payloads;
// it sends nothing and knows nothing about HTTP. That is what lets
// `test/accountant/reporting-mbql.test.js` read exactly what would be sent.
//
// ── THE TWO FILTERS ARE NOT NEGOTIABLE ──────────────────────────────────────
// Every query carries `organization_id = <session>` and
// `company_id IN (<companies the scope guard approved>)`, built FIRST, with the
// user's filters appended after. They come from arguments the route derives
// from the session; the catalogue has no field id that names either column, so
// a layout cannot express one, let alone replace one.
//
// ── NATIVE SQL IS NEVER EMITTED ─────────────────────────────────────────────
// `{"type":"query"}`, always. There is no branch in this file that produces
// `native`, and the API key belongs to a query-builder-only Metabase group, so
// two independent layers would both have to fail.
//
// ── WHY A PLAN, NOT A QUERY ─────────────────────────────────────────────────
// A pivot needs more than one answer. Subtotals and totals must be exact, and
// summing the visible cells is only exact for `total` and `count` — an average
// of averages is not an average, and a max of maxes is only accidentally a max.
// So every total is its OWN aggregate query at its own grain:
//
//   main        breakout rows + columns   the body of the matrix
//   rowTotals   breakout rows             the "Total" column down the side
//   colTotals   breakout columns          the "Total" row across the bottom
//   grand       no breakout               the single corner figure
//   subtotal[]  breakout rowPrefix (+cols) one per nesting level above the leaf
//
// Six small queries for a two-level pivot, each of which the database answers
// from the same indexes. The alternative — arithmetic on displayed values — is
// wrong for three of the five calculations the catalogue offers.

"use strict";

const catalogue = require("./fieldCatalogue");

/** An MBQL field reference. */
const ref = (id) => ["field", id, null];

class CompileError extends Error {
  constructor(message, code = "REPORTING_INVALID_SPEC") {
    super(message);
    this.code = code;
  }
}

/**
 * The tenant clauses, built before anything the user asked for.
 *
 * The company clause is an `IN` over EVERY approved company, so a multi-company
 * report is one query rather than one per company — and so a company that was
 * not approved cannot appear even if the layout named it, because this list is
 * the guard's and not the layout's.
 */
function tenantFilters(fieldIds, { organizationId, companyIds }) {
  if (!organizationId) throw new CompileError("No organisation context.", "REPORTING_FORBIDDEN");
  if (!Array.isArray(companyIds) || companyIds.length === 0) {
    throw new CompileError("No company context.", "REPORTING_FORBIDDEN");
  }
  const orgId = fieldIds[catalogue.TENANT_COLUMNS.organization];
  const coId = fieldIds[catalogue.TENANT_COLUMNS.company];
  if (orgId === undefined || coId === undefined) {
    throw new CompileError("The reporting engine cannot scope this view.", "REPORTING_UNAVAILABLE");
  }
  return [
    ["=", ref(orgId), String(organizationId)],
    ["=", ref(coId), ...companyIds.map(String)],
  ];
}

/** One user filter as MBQL. The operation was already permitted by the catalogue. */
function userFilter(fieldId, operation, value) {
  const f = ref(fieldId);
  switch (operation) {
    case "between": return ["between", f, value[0], value[1]];
    case "on":
    case "equals":
    case "is": return ["=", f, value];
    case "before": return ["<", f, value];
    case "after": return [">", f, value];
    case "greater_than": return [">", f, value];
    case "less_than": return ["<", f, value];
    case "contains": return ["contains", f, value, { "case-sensitive": false }];
    case "starts_with": return ["starts-with", f, value, { "case-sensitive": false }];
    case "in": return ["=", f, ...value];
    default:
      /* Unreachable: the validator admits only what the catalogue lists. It
         throws rather than dropping the filter, because a dropped filter
         returns MORE rows than were asked for. */
      throw new CompileError(`Unsupported filter operation "${String(operation).slice(0, 30)}".`);
  }
}

/** The Metabase aggregation for one calculation. */
function aggregation(calculation, fieldId) {
  switch (calculation) {
    case "total": return ["sum", ref(fieldId)];
    case "count": return ["count"];
    case "average": return ["avg", ref(fieldId)];
    case "minimum": return ["min", ref(fieldId)];
    case "maximum": return ["max", ref(fieldId)];
    default:
      throw new CompileError(`Unsupported calculation "${String(calculation).slice(0, 30)}".`);
  }
}

/** Is a calculation safe to add up across groups? Only these two are. */
const ADDITIVE = new Set(["total", "count"]);

/* ─────────────────────────────────────────────────────────────────────────── */
/* Date shifting, for period comparisons                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

const day = (s) => new Date(`${s}T00:00:00Z`);
const iso = (d) => d.toISOString().slice(0, 10);

/**
 * The period immediately before this one, of the SAME NUMBER OF DAYS.
 *
 * ── THE SEMANTIC, STATED, BECAUSE TWO REASONABLE ONES EXIST ─────────────────
 * This is EQUAL-LENGTH, not calendar-aligned. A 1–31 August range is 31 days,
 * so the period before it is 1–31 July. A 1 April–30 June range is 91 days, so
 * the period before it starts on 31 DECEMBER — not 1 January.
 *
 * Equal length is the right default for a tool where the user picks the range:
 * an arbitrary window like 12–26 August has no "previous calendar period" at
 * all, and a calendar shift would compare Q2's 91 days against Q1's 90 and call
 * the 1% difference a trend. A user who wants calendar quarters compares
 * quarter to quarter by putting the period in Columns.
 *
 * Computed in whole days on UTC instants so it cannot drift across a
 * daylight-saving boundary: these are calendar dates, not instants, and
 * treating them as instants is how a comparison ends up a day out for half the
 * year.
 */
function previousPeriod([from, to]) {
  const a = day(from);
  const b = day(to);
  const spanDays = Math.round((b - a) / 86_400_000) + 1;
  const newTo = new Date(a.getTime() - 86_400_000);
  const newFrom = new Date(newTo.getTime() - (spanDays - 1) * 86_400_000);
  return [iso(newFrom), iso(newTo)];
}

/**
 * The same period one year earlier.
 *
 * CALENDAR year, on the same calendar dates — 1 Aug 2026 compares with
 * 1 Aug 2025, which is what "the same period last year" means to an accountant
 * regardless of where the financial year starts. 29 February lands on 28
 * February in a non-leap year rather than silently becoming 1 March.
 */
function previousYear([from, to]) {
  const back = (s) => {
    const d = day(s);
    const y = d.getUTCFullYear() - 1;
    const m = d.getUTCMonth();
    const dd = d.getUTCDate();
    const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return iso(new Date(Date.UTC(y, m, Math.min(dd, lastDay))));
  };
  return [back(from), back(to)];
}

/** The layout's date range filter, which a period comparison shifts. */
function dateRangeFilter(layout) {
  return layout.filters.find(
    (f) => ["date", "datetime"].includes(f.field.type) && f.operation === "between",
  );
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Compilation                                                                */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Build one query.
 *
 * @param {object} o
 * @param {object[]} o.breakout   field descriptors to group by, in order
 * @param {object[]} o.aggregate  `{field, calculation}` entries
 * @param {object[]} [o.select]   field descriptors to SELECT (detail mode)
 */
function buildQuery({
  resolved, organizationId, companyIds, filters, breakout = [], aggregate = [],
  select = null, orderBy = [], limit = null, dateOverride = null,
}) {
  const { databaseId, tableId, fieldIds } = resolved;
  const idOf = (column) => {
    const id = fieldIds[column];
    if (id === undefined) {
      throw new CompileError(
        "The reporting engine has not discovered this field yet.",
        "REPORTING_UNAVAILABLE",
      );
    }
    return id;
  };

  const clauses = [...tenantFilters(fieldIds, { organizationId, companyIds })];
  for (const f of filters) {
    const isDateRange =
      dateOverride && ["date", "datetime"].includes(f.field.type) && f.operation === "between";
    clauses.push(
      isDateRange
        ? userFilter(idOf(f.field.column), "between", dateOverride)
        : userFilter(idOf(f.field.column), f.operation, f.value),
    );
  }

  const query = { "source-table": tableId, filter: ["and", ...clauses] };

  if (select) query.fields = select.map((f) => ref(idOf(f.column)));
  if (breakout.length) query.breakout = breakout.map((f) => ref(idOf(f.column)));
  if (aggregate.length) {
    /* `count` takes no field — it counts rows — so the column is resolved only
       for the calculations that need one. Resolving it unconditionally meant a
       detail report's row-count query dereferenced a null field. */
    query.aggregation = aggregate.map((a) =>
      a.calculation === "count"
        ? aggregation("count", null)
        : aggregation(a.calculation, idOf(a.field.column)),
    );
  }
  if (orderBy.length) {
    query["order-by"] = orderBy.map(({ field, direction, aggregationIndex }) =>
      aggregationIndex !== undefined
        ? [direction, ["aggregation", aggregationIndex]]
        : [direction, ref(idOf(field.column))],
    );
  }
  if (Number.isInteger(limit) && limit > 0) query.limit = limit;

  return { database: databaseId, type: "query", query };
}

/**
 * THE ORDER A SUMMARY IS RETURNED IN.
 *
 * The same rules the matrix applies, expressed as MBQL — which is what makes
 * the sheet, the workbook and the chart agree about "top ledgers by debit"
 * instead of each having its own opinion:
 *
 *  · every row level in NESTING order, in the direction the layout asked for,
 *    ascending when it asked for nothing. Nesting order rather than the order
 *    the sorts happen to be written in, because level 0 has to lead or the
 *    groups interleave;
 *  · then, when a sort names a VALUE, that aggregation, in the direction asked
 *    for — after the row levels, so it orders the deepest one inside its
 *    parents exactly as `matrix.rowComparator` does;
 *  · then the column fields ascending. The column axis is GRAV's to order and
 *    the contract does not let a report sort it.
 */
function summaryOrderBy(layout, rowFields, colFields, { includeMeasure = true } = {}) {
  const directionFor = (field) => {
    const entry = layout.sort.find((s) => s.field.id === field.id);
    return entry ? entry.direction : "asc";
  };

  const levels = rowFields.map((f) => ({ field: f, direction: directionFor(f) }));

  /* A value sort names a field; Values may hold that field twice, and the
     FIRST entry is the one meant. Documented in the audit's B3 contract, and
     the same rule the matrix follows. */
  const measure = includeMeasure ? layout.sort.find(
    (s) => !rowFields.some((f) => f.id === s.field.id)
      && layout.values.some((v) => v.field.id === s.field.id),
  ) : null;
  const aggregationIndex = measure
    ? layout.values.findIndex((v) => v.field.id === measure.field.id)
    : -1;

  const out = measure && aggregationIndex !== -1
    /* The measure goes BEFORE the deepest level and after every level above
       it — which is where `matrix.rowComparator` applies it. Appending it
       after all the levels instead would leave it decorative: the deepest
       level is unique within its parent, so it would settle every comparison
       before the figure was ever looked at, and a report sorted by debit would
       come back alphabetically in the workbook while the sheet had it right. */
    ? [
      ...levels.slice(0, -1),
      { aggregationIndex, direction: measure.direction },
      ...levels.slice(-1),
    ]
    : levels;

  return [...out, ...colFields.map((f) => ({ field: f, direction: "asc" }))];
}

/**
 * The full set of queries one layout needs.
 *
 * @returns {{mode, main, rowTotals, colTotals, grand, subtotals, comparison}}
 */
function compilePlan({ layout, resolved, organizationId, companyIds, limit }) {
  const base = { resolved, organizationId, companyIds, filters: layout.filters };

  /* ── Detail: a plain list of records ───────────────────────────────────── */
  if (layout.mode === "detail") {
    const orderBy = layout.sort.length
      ? layout.sort.map((s) => ({ field: s.field, direction: s.direction }))
      /* DETERMINISM. Without an explicit order PostgreSQL may return rows in
         any order it likes, and two previews of the same report disagree —
         which reads as the data having changed. */
      : [{ field: layout.rows[0].field, direction: "asc" }];

    return {
      mode: "detail",
      main: buildQuery({ ...base, select: layout.rows.map((r) => r.field), orderBy, limit }),
      count: buildQuery({ ...base, aggregate: [{ field: null, calculation: "count" }] }),
    };
  }

  /* ── Summary: the pivot ────────────────────────────────────────────────── */
  const rowFields = layout.rows.map((r) => r.field);
  const colFields = layout.columns.map((c) => c.field);
  const aggregate = layout.values.map((v) => ({ field: v.field, calculation: v.calculation }));

  const orderBy = summaryOrderBy(layout, rowFields, colFields);

  const plan = {
    mode: "summary",
    main: buildQuery({ ...base, breakout: [...rowFields, ...colFields], aggregate, orderBy }),
    rowTotals: layout.showRowTotals && rowFields.length
      ? buildQuery({ ...base, breakout: rowFields, aggregate })
      : null,
    colTotals: layout.showColumnTotals && colFields.length
      ? buildQuery({ ...base, breakout: colFields, aggregate })
      : null,
    grand: layout.showGrandTotal ? buildQuery({ ...base, aggregate }) : null,
    subtotals: [],
  };

  /* Subtotals, one per nesting level above the leaf. `rows: [group, ledger]`
     gets a subtotal per group; `rows: [a, b, c]` gets one per a and one per
     (a, b). Each needs its cells (prefix + columns) and its own total column
     (prefix alone). */
  for (let depth = 1; depth < rowFields.length; depth += 1) {
    const prefix = rowFields.slice(0, depth);
    plan.subtotals.push({
      depth: depth - 1,
      prefix,
      cells: buildQuery({ ...base, breakout: [...prefix, ...colFields], aggregate }),
      total: layout.showRowTotals ? buildQuery({ ...base, breakout: prefix, aggregate }) : null,
    });
  }

  /* ── Comparisons: the same plan over a shifted period ──────────────────── */
  if (layout.comparisons.length) {
    const dated = dateRangeFilter(layout);
    plan.comparison = layout.comparisons.map((c) => {
      let dateOverride = null;
      let companyOverride = companyIds;
      if (c.mode === "previous_period") dateOverride = previousPeriod(dated.value);
      else if (c.mode === "previous_year") dateOverride = previousYear(dated.value);
      else if (c.mode === "other_company") companyOverride = [c.with];

      const cbase = { ...base, companyIds: companyOverride, dateOverride };
      return {
        comparison: c,
        period: dateOverride,
        company: companyOverride,
        main: buildQuery({ ...cbase, breakout: [...rowFields, ...colFields], aggregate, orderBy }),
        rowTotals: plan.rowTotals ? buildQuery({ ...cbase, breakout: rowFields, aggregate }) : null,
        colTotals: plan.colTotals ? buildQuery({ ...cbase, breakout: colFields, aggregate }) : null,
        grand: plan.grand ? buildQuery({ ...cbase, aggregate }) : null,
        subtotals: plan.subtotals.map((s) => ({
          depth: s.depth,
          prefix: s.prefix,
          cells: buildQuery({ ...cbase, breakout: [...s.prefix, ...colFields], aggregate }),
          total: s.total ? buildQuery({ ...cbase, breakout: s.prefix, aggregate }) : null,
        })),
      };
    });
  }

  return plan;
}


/* ═══════════════════════════════════════════════════════════════════════════
 * ONE QUESTION, FOR A CHART
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * The whole report as a SINGLE query, for Metabase to draw.
 *
 * A chart is one Metabase question and a question holds one query, while the
 * preview is a PLAN of up to a dozen — one per total, subtotal and comparison.
 * So this compiles the same layout into one query, and it lives in this file
 * rather than beside the chart service on purpose: there is exactly one place
 * in GRAV that emits MBQL, one `tenantFilters`, one `userFilter`, one field
 * resolver. A second, friendlier compiler somewhere else is how the query the
 * chart runs stops being the query the sheet ran.
 *
 * ── WITHOUT COMPARISONS IT IS LITERALLY THE PREVIEW'S MAIN QUERY ────────────
 * Same breakouts, same aggregations, same filters, same tenant clauses, built
 * by the same `buildQuery`. The chart and the sheet cannot disagree because
 * there is nothing for them to disagree about.
 *
 * ── WITH COMPARISONS IT IS A FILTERED AGGREGATION ───────────────────────────
 * The preview runs the comparison as a second query over a shifted window.
 * One query cannot have two date ranges — so the range widens to cover both
 * windows and EVERY aggregation becomes a conditional one (`sum-where`), each
 * carrying its own window. Verified against the live instance: the figures and
 * the nulls come out identical to the preview's, to the last decimal.
 *
 * That trick only exists for sums and counts. Metabase 1.63.1 has `sum-where`
 * and `count-where` and has no `avg-where`, `min-where` or `max-where` (each
 * answers HTTP 500), and its `offset()` is unsupported on this version. A
 * comparison of an average therefore cannot be drawn faithfully as one chart
 * — `chartCapability.js` refuses it rather than quietly charting something
 * else, and the sheet still shows it.
 */
function compileChartQuery({ layout, resolved, organizationId, companyIds, limit = null }) {
  const base = { resolved, organizationId, companyIds, filters: layout.filters };

  if (layout.mode === "detail") {
    const orderBy = layout.sort.length
      ? layout.sort.map((s) => ({ field: s.field, direction: s.direction }))
      : [{ field: layout.rows[0].field, direction: "asc" }];
    return buildQuery({ ...base, select: layout.rows.map((r) => r.field), orderBy, limit });
  }

  const rowFields = layout.rows.map((r) => r.field);
  const colFields = layout.columns.map((c) => c.field);
  const breakout = [...rowFields, ...colFields];

  if (!layout.comparisons.length) {
    const aggregate = layout.values.map((v) => ({ field: v.field, calculation: v.calculation }));
    /* The same order as the sheet and the workbook, so a chart of a report
       sorted by debit is drawn in that order rather than alphabetically. */
    const orderBy = summaryOrderBy(layout, rowFields, colFields);
    return buildQuery({ ...base, breakout, aggregate, orderBy, limit });
  }

  return buildComparisonQuery({ layout, resolved, organizationId, companyIds, breakout, limit });
}

/**
 * Every value and every comparison of it, as conditional aggregations.
 *
 * The aggregations are named with `aggregation-options` so the chart's legend
 * reads "Debit — previous period" rather than "Sum of Debit matching
 * condition", which is what Metabase calls it otherwise and is not a sentence
 * anybody wants under a chart.
 */
function buildComparisonQuery({ layout, resolved, organizationId, companyIds, breakout, limit }) {
  const { fieldIds } = resolved;
  const idOf = (column) => {
    const id = fieldIds[column];
    if (id === undefined) {
      throw new CompileError("The reporting engine has not discovered this field yet.",
        "REPORTING_UNAVAILABLE");
    }
    return id;
  };

  const dated = dateRangeFilter(layout);
  const periodComparisons = layout.comparisons.filter(
    (c) => c.mode === "previous_period" || c.mode === "previous_year",
  );

  /* Every window this query has to cover, so the outer date filter can span
     them all. Widening it is what makes one query able to answer two periods —
     and is exactly why the current figures must then be conditional too. */
  const windows = [];
  if (dated && periodComparisons.length) {
    windows.push(dated.value);
    for (const c of periodComparisons) {
      windows.push(c.mode === "previous_period" ? previousPeriod(dated.value) : previousYear(dated.value));
    }
  }

  const filters = layout.filters.map((f) => {
    if (!windows.length || f !== dated) return f;
    return { ...f, value: [
      windows.map((w) => w[0]).sort()[0],
      windows.map((w) => w[1]).sort().at(-1),
    ] };
  });

  const inWindow = (window_) =>
    ["between", ref(idOf(dated.field.column)), window_[0], window_[1]];

  const conditional = (calculation, field, condition) => {
    if (!condition) return aggregation(calculation, field ? idOf(field.column) : null);
    if (calculation === "total") return ["sum-where", ref(idOf(field.column)), condition];
    if (calculation === "count") return ["count-where", condition];
    /* Unreachable: chartCapability refuses these before anything is compiled.
       It throws rather than falling back to an unconditional aggregation,
       because that would draw the whole period and label it as one window. */
    throw new CompileError(`A ${calculation} cannot be compared in a single chart.`);
  };

  const named = (clause, label) =>
    ["aggregation-options", clause, { "display-name": label, name: slug(label) }];

  const aggregations = [];
  for (const value of layout.values) {
    const mine = layout.comparisons.filter((c) => c.field.id === value.field.id);
    const currentCondition = windows.length ? inWindow(dated.value) : null;
    const current = conditional(value.calculation, value.field, currentCondition);

    /* A difference or a percentage REPLACES the pair, exactly as the sheet's
       leaf columns do; side by side keeps both. */
    const replacing = mine.find((c) => c.display !== "side_by_side");
    if (!replacing) {
      aggregations.push(named(current, value.heading));
      for (const c of mine) {
        aggregations.push(named(priorClause(c, value, current), comparisonLabel(value, c)));
      }
      continue;
    }

    aggregations.push(named(current, value.heading));
    for (const c of mine) {
      const prior = priorClause(c, value, current);
      if (c.display === "side_by_side") {
        aggregations.push(named(prior, comparisonLabel(value, c)));
      } else if (c.display === "difference") {
        aggregations.push(named(["-", current, prior], comparisonLabel(value, c)));
      } else {
        /* The sheet's own arithmetic: ((current − prior) ÷ |prior|) × 100, and
           null when prior is zero — which Metabase's division already gives. */
        aggregations.push(named(
          ["*", ["/", ["-", current, prior], ["abs", prior]], 100],
          comparisonLabel(value, c),
        ));
      }
    }
  }

  function priorClause(c, value, current) {
    if (c.mode === "other_company") {
      const coId = fieldIds[catalogue.TENANT_COLUMNS.company];
      const sameCompany = ["=", ref(coId), String(c.with)];
      const condition = windows.length
        ? ["and", inWindow(dated.value), sameCompany]
        : sameCompany;
      return conditional(value.calculation, value.field, condition);
    }
    const window_ = c.mode === "previous_period" ? previousPeriod(dated.value) : previousYear(dated.value);
    return conditional(value.calculation, value.field, inWindow(window_));
  }

  /* Dimension sorts only. A comparison query REBUILDS its aggregations as
     conditional ones, so `["aggregation", n]` would point at a different
     figure than the one the report asked to be sorted by — and an order that
     is nearly right is worse than one that is plainly the default. */
  const orderBy = summaryOrderBy(layout, layout.rows.map((r) => r.field),
    layout.columns.map((c) => c.field), { includeMeasure: false });
  const query = buildQuery({
    resolved, organizationId, companyIds, filters, breakout, orderBy, limit,
    aggregate: [{ field: null, calculation: "count" }],   // replaced below
  });
  query.query.aggregation = aggregations;
  return query;
}

/** What a comparison column is called, in the words the sheet uses. */
function comparisonLabel(value, comparison) {
  const mode = {
    previous_period: "previous period",
    previous_year: "last year",
    other_company: "the other company",
  }[comparison.mode] || "comparison";
  if (comparison.display === "difference") return `${value.heading} — change vs ${mode}`;
  if (comparison.display === "percentage_difference") return `${value.heading} — % change vs ${mode}`;
  return `${value.heading} — ${mode}`;
}

/** A Metabase-safe internal name for a named aggregation. */
function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60)
    || "value";
}

module.exports = {
  ADDITIVE,
  CompileError,
  compilePlan,
  compileChartQuery,
  summaryOrderBy,
  comparisonLabel,
  buildQuery,
  tenantFilters,
  userFilter,
  aggregation,
  previousPeriod,
  previousYear,
  dateRangeFilter,
};
