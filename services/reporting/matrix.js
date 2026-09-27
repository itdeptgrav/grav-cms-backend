// services/reporting/matrix.js
//
// FLAT AGGREGATE ROWS → THE MATRIX THE BROWSER RENDERS WITHOUT THINKING.
//
// Metabase answers a pivot as a flat list: one row per (row combination ×
// column combination), with the aggregations on the end. Turning that into a
// PivotTable is GRAV's job, and it is done here, purely, so it can be tested
// without a database or a network.
//
// ── THE ONE RULE THE BROWSER DEPENDS ON ─────────────────────────────────────
// `leafColumns` is the flattened bottom row of headings, and EVERY row's
// `cells` — data rows, subtotals, column totals and the grand total alike — is
// aligned to it, index for index. The browser matches nothing up. If a cell is
// missing it is emitted as `{ value: null }` rather than skipped, because a
// short array silently shifts every figure after it one column to the left.
//
// ── COLUMN ORDER IS THE FIELD'S OWN ─────────────────────────────────────────
// Months are sorted as dates, not as strings. "Apr, Aug, Dec, Feb" is the first
// thing anybody notices and the fastest way to lose their trust in the rest of
// the numbers. Text columns sort with `localeCompare` so "Zeta" follows "acme",
// which a raw `<` does not do.
//
// ── NOTHING HERE ADDS ANYTHING UP ───────────────────────────────────────────
// Every subtotal, total and grand total is a figure Metabase computed at that
// grain and handed back — see the plan in `mbqlCompiler.js`. This file places
// them. It does not sum displayed values and it does not round: an average of
// averages is not an average, and the moment this file starts doing arithmetic
// is the moment the workbook and the screen can disagree.
//
// ONE EXCEPTION, deliberately narrow: `omitted.values` adds up the rows the
// preview limit CUT OFF. Those rows are on no screen and in no workbook, so
// there is nothing for the arithmetic to disagree with, and the only other way
// to learn the figure — subtracting the visible rows from the grand total —
// would hide a disagreement instead of exposing it. It sums additive columns
// only; see `omittedValues`.
//
// ── COUNTS SAY WHAT THEY COUNT ──────────────────────────────────────────────
// `previewRowCount` is the number of `kind: "data"` rows in `rows`.
// `groupCount` is every distinct data group the filters match, before the
// limit (null in a detail list, which has records rather than groups).
// `totalRowCount` is the COMPLETE count, kept for compatibility: the group
// count in a summary, the record count in a list. Subtotals, column totals and
// the grand total are counted in none of them. When `truncated`, `omitted`
// says how many groups were dropped and exactly what they were worth.

"use strict";

const semantics = require("./semantics");

/** A cell, always present, always aligned. */
const cell = (value, display) => ({ value: value === undefined ? null : value, display });

/**
 * A cell that knows what it is.
 *
 * `value` and `display` are EXACTLY what they were before this slice — the
 * raw engine value and the primitive hint an existing client switches on — so
 * nothing that reads them changes behaviour. What is added is authoritative:
 *
 *   key   a stable, timezone-free token to sort, group and compare by
 *   text  the sentence to show, decided here rather than guessed downstream
 *   semanticType  what the value IS
 *
 * ── WHY `display` STILL SAYS "date" FOR A MONTH ─────────────────────────────
 * The frontend formats a cell by switching on `display`, and its switch has no
 * `month` branch: it would fall through to `String(value)` and print
 * `2025-07-01T00:00:00+05:30`, which is worse than today's "01 Jul 2025". So
 * the primitive hint is left alone and the meaning travels beside it. Lane A
 * reads `text` when it is ready, and the hint can be narrowed afterwards. The
 * audit records this as the transition shape.
 */
function semanticCell(value, display, field) {
  const base = cell(value, display);
  if (!field || !field.semanticType) return base;

  if (semantics.isPeriod(field.semanticType)) {
    return {
      ...base,
      key: semantics.periodKey(field.semanticType, base.value),
      text: semantics.periodText(field.semanticType, base.value),
      semanticType: field.semanticType,
    };
  }
  if (semantics.isEnum(field.semanticType)) {
    return {
      ...base,
      key: base.value === null || base.value === undefined ? null : String(base.value),
      text: semantics.enumText(field.choices, base.value),
      semanticType: field.semanticType,
    };
  }
  return { ...base, semanticType: field.semanticType };
}

/**
 * How a group VALUE reads on screen.
 *
 * The same words as the cell's `text`, so a heading and the cells under it
 * cannot disagree: "July 2025" in both, "Credit Note" in both.
 */
function semanticLabel(value, field) {
  if (value === null || value === undefined || value === "") return "(none)";
  if (!field || !field.semanticType) return labelOf(value, field && field.type);
  if (semantics.isPeriod(field.semanticType)) {
    return semantics.periodText(field.semanticType, value) ?? labelOf(value, field.type);
  }
  if (semantics.isEnum(field.semanticType)) {
    return semantics.enumText(field.choices, value) ?? String(value);
  }
  return labelOf(value, field.type);
}

/** The stable key behind a group label. Categories keep their raw value. */
function semanticKey(value, field) {
  if (value === null || value === undefined || value === "") return null;
  if (field && semantics.isPeriod(field.semanticType)) {
    return semantics.periodKey(field.semanticType, value);
  }
  return String(value);
}

/** The key for a tuple of group values. Null-safe and collision-free. */
const keyOf = (parts) => JSON.stringify(parts.map((p) => (p === undefined ? null : p)));

/** How a label reads when the group value is empty. */
const labelOf = (value, type) => {
  if (value === null || value === undefined || value === "") return "(none)";
  if (type === "date" || type === "datetime") return formatPeriodLabel(value);
  return String(value);
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A date group's heading.
 *
 * `period_month` is the first of the month, so "Apr 2026" is what it means and
 * what an accountant reading a column heading expects. A full date stays a full
 * date. The VALUE is untouched — this is the label only, and sorting is done on
 * the value.
 */
function formatPeriodLabel(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const iso = typeof value === "string" ? value : d.toISOString();
  const [y, m, rest] = iso.split("T")[0].split("-");
  const dayPart = rest ? Number(rest) : null;
  if (dayPart === 1) return `${MONTHS[Number(m) - 1]} ${y}`;
  return `${String(dayPart).padStart(2, "0")} ${MONTHS[Number(m) - 1]} ${y}`;
}

/**
 * Sort distinct group values the way the field itself orders.
 *
 * Ordered by the SEMANTIC KEY, not by the label: `2025-07` sorts before
 * `2025-12` and `2026-01` follows both, while "July 2025" and "January 2026"
 * ordered as text give December before January and Apr before Feb. For a
 * period the key IS the ordering, which is the whole reason it exists.
 *
 * Nulls sort LAST, in both directions. An empty group is not the smallest
 * value of anything — it is an absence — and a descending report that opens on
 * "(none)" buries the answer the user asked for under the rows that have none.
 */
function compareValues(a, b, field) {
  const type = field && field.type ? field.type : field;   // a field, or a bare type
  if (a === null || a === undefined || a === "") {
    return b === null || b === undefined || b === "" ? 0 : 1;
  }
  if (b === null || b === undefined || b === "") return -1;

  if (field && field.semanticType && semantics.isPeriod(field.semanticType)) {
    const ka = semantics.periodKey(field.semanticType, a);
    const kb = semantics.periodKey(field.semanticType, b);
    if (ka !== null && kb !== null) return ka < kb ? -1 : (ka > kb ? 1 : 0);
  }
  if (type === "date" || type === "datetime") {
    // As dates. A string sort gives "Apr, Aug, Dec" — chronology is the point.
    return new Date(a) - new Date(b);
  }
  if (["money", "number", "integer"].includes(type)) return Number(a) - Number(b);
  return String(a).localeCompare(String(b), "en", { numeric: true, sensitivity: "base" });
}

/**
 * HOW A SUMMARY'S ROWS ARE ORDERED.
 *
 * The audit found `sort` accepted, stored, compiled into MBQL — and then
 * undone here, because the groups were rebuilt in ascending order whatever the
 * report asked for. Ascending and descending returned the same rows in the
 * same order, and "top ledgers by debit" came back alphabetically.
 *
 * The rules, in order, and all four are testable:
 *
 *  1. A row level named by the layout's `sort` is ordered in the direction it
 *     asked for, by the field's SEMANTIC KEY.
 *  2. A sort naming a VALUE orders the DEEPEST row level — the data rows —
 *     by that value's row total, in the direction asked for. Outer levels keep
 *     their own order, so groups stay whole: sorting ledgers by debit inside
 *     their groups is a sorted report; sorting every ledger across all groups
 *     is a list with the group headings scattered through it.
 *  3. A level nobody named goes ascending by its semantic key, as before.
 *  4. TIES break on the next row level ascending, and if every level ties, on
 *     the order the engine returned — the sort is stable, so equal rows never
 *     swap between two runs of the same report.
 *
 * A measure sort is skipped, with the level keeping its dimension order, only
 * when the measure's row total is genuinely unavailable: a pivot whose row
 * totals are switched off has no per-row figure to sort by, and this file does
 * not add one up (an average of averages is not an average).
 *
 * ── WHERE A BLANK GROUP GOES ────────────────────────────────────────────────
 * Last, when the order comes from a KEY: an absence has no alphabetical or
 * chronological position, and a descending report that opens on "(none)"
 * buries the answer under the rows that have none.
 *
 * In its figure's place, when the order comes from a MEASURE: the blank bucket
 * has a real total — often a large one, as it does for the 1,781 lines with no
 * party — and a report asked to rank by debit that quietly moved the biggest
 * number to the bottom would be hiding the most interesting fact on the screen.
 */
function rowComparator({ rowFields, sort = [], measureValueOf = null }) {
  /** Which sort, if any, names this level. */
  const directionFor = (field) => {
    const entry = sort.find((s) => s.field && s.field.id === field.id && !s.isMeasure);
    return entry ? entry.direction : "asc";
  };
  const measureSort = sort.find((s) => s.isMeasure) || null;
  const deepest = rowFields.length - 1;

  return (a, b) => {
    for (let i = 0; i < rowFields.length; i += 1) {
      const isDeepest = i === deepest;

      /* The measure decides the deepest level when one was asked for and a
         figure for it exists. */
      if (isDeepest && measureSort && measureValueOf) {
        const va = measureValueOf(a);
        const vb = measureValueOf(b);
        if (va !== null && vb !== null) {
          const c = compareValues(va, vb, "money");
          if (c !== 0) return measureSort.direction === "desc" ? -c : c;
          // Equal figures: fall through to the level's own key, then onwards.
        }
      }

      const c = compareValues(a[i], b[i], rowFields[i]);
      if (c !== 0) {
        const nulled = a[i] === null || a[i] === undefined || a[i] === ""
          || b[i] === null || b[i] === undefined || b[i] === "";
        /* Nulls stay last whichever way the rest is going: `compareValues`
           already put them last, and flipping that with the direction would
           make a descending report open on "(none)". */
        if (nulled) return c;
        return directionFor(rowFields[i]) === "desc" ? -c : c;
      }
    }
    return 0;   // every level equal: Array.prototype.sort keeps the engine's order
  };
}

/**
 * Distinct tuples over a set of breakout positions, in the fields' own order.
 *
 * `comparator` is the row ordering when one is given. Without it the tuples
 * come back ascending by semantic key, which is what the COLUMN axis wants:
 * the contract lets a report sort its rows and its values, never its columns,
 * so months across the top are chronological in every report.
 */
function distinctTuples(rows, positions, fields, comparator = null) {
  const seen = new Map();
  for (const row of rows) {
    const tuple = positions.map((p) => row[p]);
    const k = keyOf(tuple);
    if (!seen.has(k)) seen.set(k, tuple);
  }
  const ordered = [...seen.values()];
  if (comparator) return ordered.sort(comparator);
  return ordered.sort((a, b) => {
    for (let i = 0; i < fields.length; i += 1) {
      const c = compareValues(a[i], b[i], fields[i]);
      if (c !== 0) return c;
    }
    return 0;
  });
}

/**
 * Nested column headings, level by level.
 *
 * One `columnLevels` entry per column field, plus a final level naming the
 * values when there is more than one — a "Apr 2026" heading spanning
 * "Total of Debit" and "Total of Credit" is what makes a two-value pivot
 * readable. `span` is how many leaf columns each heading covers.
 */
function buildColumnLevels({ layout, columnTuples, leafColumns }) {
  const levels = [];
  const valueCount = layout.values.length + comparisonLeavesPerCell(layout);

  layout.columns.forEach((col, depth) => {
    const headers = [];
    let previous = null;
    let run = 0;
    for (const tuple of columnTuples) {
      // A heading at this depth covers every leaf under it, so its span counts
      // the deeper columns and the values beneath them.
      const label = semanticLabel(tuple[depth], col.field);
      const parentKey = keyOf(tuple.slice(0, depth + 1));
      if (previous !== null && previous.key === parentKey) {
        run += valueCount;
        headers[headers.length - 1].span = run;
      } else {
        run = valueCount;
        headers.push({ label, span: run });
        previous = { key: parentKey };
      }
    }
    // The row-total column sits outside the column axis and is its own heading.
    if (leafColumns.some((l) => l.isTotal)) headers.push({ label: "Total", span: valueCount });
    levels.push({ heading: col.heading, headers });
  });

  /* The values level. Present when there is more than one value or any
     comparison, because otherwise the heading above already says what the
     number is and a second row of identical text is noise. */
  if (valueCount > 1 || layout.columns.length === 0) {
    levels.push({
      heading: "",
      headers: leafColumns.map((l) => ({ label: l.heading, span: 1 })),
    });
  }

  return levels;
}

/** How many leaf columns each (column tuple) produces, comparisons included. */
function comparisonLeavesPerCell(layout) {
  let extra = 0;
  for (const c of layout.comparisons) {
    // Side by side adds a column per comparison; difference and percentage
    // difference each add one derived column beside the original.
    extra += 1;
  }
  return extra;
}

/** The comparison's own heading. */
function comparisonHeading(valueHeading, comparison) {
  const what = {
    previous_period: "vs previous period",
    previous_year: "vs last year",
    other_company: "vs other company",
    other_field: "vs other value",
  }[comparison.mode] || "comparison";

  if (comparison.display === "difference") return `${valueHeading} — change ${what}`;
  if (comparison.display === "percentage_difference") return `${valueHeading} — % change ${what}`;
  return `${valueHeading} ${what}`;
}

/**
 * A comparison cell.
 *
 * DIVISION BY ZERO IS `null`, NEVER `Infinity`. A percentage change from zero
 * is not "infinitely better", it is undefined — and `Infinity` does not
 * survive JSON, so it would arrive at the browser as `null` anyway, but only
 * after having been the wrong thing in the log and in the workbook.
 */
function comparisonValue(current, prior, display) {
  const c = current === null || current === undefined ? null : Number(current);
  const p = prior === null || prior === undefined ? null : Number(prior);
  if (display === "side_by_side") return p;
  if (c === null && p === null) return null;
  const cv = c ?? 0;
  const pv = p ?? 0;
  if (display === "difference") return cv - pv;
  if (display === "percentage_difference") {
    if (pv === 0) return null;
    return ((cv - pv) / Math.abs(pv)) * 100;
  }
  return null;
}

/** The display hint for a leaf column's cells. */
const displayFor = (leaf) =>
  leaf.isComparison && leaf.comparisonDisplay === "percentage_difference" ? "percent" : leaf.type;

/* ─────────────────────────────────────────────────────────────────────────── */
/* Detail mode                                                                */
/* ─────────────────────────────────────────────────────────────────────────── */

function shapeDetail({ layout, rows, totalRowCount, dataAsOf }) {
  const complete = totalRowCount ?? rows.length;
  const truncated = Number.isFinite(totalRowCount) && totalRowCount > rows.length;

  const leafColumns = layout.rows.map((r) => ({
    id: r.field.id,
    heading: r.heading,
    type: r.field.type,
    isTotal: false,
    isComparison: false,
    /* What the column IS, and how to render it. Deliberately NOT `chart`: a
       leaf column in a summary is a calculated figure rather than a field, so
       a chart block would be present in one mode and absent in the other and
       a client would have to branch on the mode to read it. Charting advice
       lives in the catalogue, where fields are chosen. */
    semanticType: r.field.semanticType,
    display: { format: r.field.display.format, sort: r.field.display.sort },
  }));

  return {
    mode: "detail",
    columnLevels: [{ heading: "", headers: leafColumns.map((l) => ({ label: l.heading, span: 1 })) }],
    leafColumns,
    rowLevels: [],
    rows: rows.map((row) => ({
      kind: "data",
      depth: 0,
      labels: [],
      cells: layout.rows.map((r, i) => semanticCell(row[i], r.field.type, r.field)),
    })),
    grandTotal: null,
    previewRowCount: rows.length,
    /* A list has records, not groups. Saying `groupCount: rows.length` here
       would invent a grouping the user did not ask for, so the field is
       present — a client reads one shape in both modes — and null. */
    groupCount: null,
    totalRowCount: complete,
    truncated,
    /* `values: null`, not zeroes: a list is not aggregated, so the omitted
       records' figures are genuinely unknown without fetching them. Their
       COUNT is known exactly, from the plan's own count query. */
    omitted: truncated ? { rows: complete - rows.length, values: null } : null,
    dataAsOf,
  };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Summary mode                                                               */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {object} o.layout      the validated layout
 * @param {object} o.results     `{main, rowTotals, colTotals, grand, subtotals[]}`
 *                               each a flat `rows` array from Metabase
 * @param {object[]} [o.comparisonResults] one per comparison, same shape
 */
function shapeSummary({ layout, results, comparisonResults = [], dataAsOf, limit }) {
  const rowFields = layout.rows.map((r) => r.field);
  const colFields = layout.columns.map((c) => c.field);
  const valueCount = layout.values.length;

  const rowPos = rowFields.map((_, i) => i);
  const colPos = colFields.map((_, i) => rowFields.length + i);
  const aggStart = rowFields.length + colFields.length;

  const mainRows = results.main || [];
  const columnTuples = colFields.length ? distinctTuples(mainRows, colPos, colFields) : [[]];

  /* ── Leaf columns ──────────────────────────────────────────────────────── */
  const leafColumns = [];
  const addLeavesFor = (columnTuple, isTotal) => {
    layout.values.forEach((v, vi) => {
      leafColumns.push({
        id: `${keyOf(columnTuple)}::${v.field.id}:${v.calculation}${isTotal ? ":total" : ""}`,
        heading: v.heading,
        type: v.field.type,
        isTotal,
        isComparison: false,
        /* Read from the field and the calculation, never from the heading: a
           count is a count even when its column is called "Debit". */
        ...semantics.calculationSemantics(v.field, v.calculation),
        _columnKey: keyOf(columnTuple),
        _valueIndex: vi,
      });
    });
    layout.comparisons.forEach((c, ci) => {
      const vi = layout.values.findIndex((v) => v.field.id === c.field.id);
      leafColumns.push({
        id: `${keyOf(columnTuple)}::cmp${ci}${isTotal ? ":total" : ""}`,
        heading: comparisonHeading(layout.values[vi]?.heading ?? c.field.label, c),
        type: c.display === "percentage_difference" ? "number" : c.field.type,
        isTotal,
        isComparison: true,
        ...semantics.comparisonSemantics(
          c.field, c, layout.values[vi]?.calculation ?? "total",
        ),
        comparisonDisplay: c.display,
        _columnKey: keyOf(columnTuple),
        _valueIndex: vi,
        _comparisonIndex: ci,
      });
    });
  };

  for (const tuple of columnTuples) addLeavesFor(tuple, false);
  if (layout.showRowTotals && colFields.length) addLeavesFor([], true);

  /* ── Index the flat results ────────────────────────────────────────────── */
  /** `rowKey → columnKey → [aggregate values]` */
  const index = (flat, rPos, cPos, aStart) => {
    const map = new Map();
    for (const row of flat || []) {
      const rk = keyOf(rPos.map((p) => row[p]));
      const ck = keyOf(cPos.map((p) => row[p]));
      if (!map.has(rk)) map.set(rk, new Map());
      map.get(rk).set(ck, row.slice(aStart));
    }
    return map;
  };

  const mainIndex = index(mainRows, rowPos, colPos, aggStart);
  /* Each supporting query has its OWN breakout, so its own column positions.
     `colPos` above is offset past the row fields because the MAIN query groups
     by rows then columns; the column-totals query groups by columns ALONE, so
     its column values start at position 0. Reusing `colPos` there looked right
     and produced a grand-total row of nulls. */
  const colOnlyPos = colFields.map((_, i) => i);
  const rowTotalIndex = index(results.rowTotals, rowPos, [], rowFields.length);
  const colTotalIndex = index(results.colTotals, [], colOnlyPos, colFields.length);
  const grandValues = (results.grand || [])[0]?.slice(0) ?? null;

  /* ── The row order ─────────────────────────────────────────────────────
   *
   * Built HERE rather than beside the column tuples, because a sort by a value
   * needs the indexes above: the figure a measure sort orders by is the row's
   * own total, read from the query that produced it. */
  const dimensionSorts = layout.sort
    .filter((s) => rowFields.some((f) => f.id === s.field.id))
    .map((s) => ({ ...s, isMeasure: false }));

  /* A value sort names a FIELD, and Values may hold the same field twice —
     Total of Debit beside Average of Debit. The first entry for that field is
     the one meant, which is documented in the audit's B3 contract; the request
     shape is unchanged. */
  const measureSortEntry = layout.sort.find(
    (s) => !rowFields.some((f) => f.id === s.field.id)
      && layout.values.some((v) => v.field.id === s.field.id),
  );
  const measureValueIndex = measureSortEntry
    ? layout.values.findIndex((v) => v.field.id === measureSortEntry.field.id)
    : -1;
  const measureSorts = measureSortEntry
    ? [{ ...measureSortEntry, isMeasure: true }]
    : [];

  /**
   * The figure a measure sort orders a row by: that row's TOTAL for the
   * measure, across whatever the columns are.
   *
   * Without columns the main query already is that total. With columns it is
   * the row-totals query — and when row totals are switched off there is no
   * such figure, so this answers null and the level keeps its dimension order
   * rather than having one invented by adding the cells up.
   */
  const measureValueOf = measureValueIndex === -1 ? null : (tuple) => {
    const rowKey = keyOf(tuple);
    const source = colFields.length ? rowTotalIndex : mainIndex;
    const values = source?.get(rowKey)?.get(keyOf([]));
    const value = values ? values[measureValueIndex] : null;
    return value === undefined || value === null ? null : Number(value);
  };

  const rowTuples = rowFields.length
    ? distinctTuples(mainRows, rowPos, rowFields, rowComparator({
        rowFields, sort: [...dimensionSorts, ...measureSorts], measureValueOf,
      }))
    : [[]];

  const comparisonIndexes = comparisonResults.map((cr) => ({
    main: index(cr.main, rowPos, colPos, aggStart),
    rowTotals: index(cr.rowTotals, rowPos, [], rowFields.length),
    colTotals: index(cr.colTotals, [], colFields.map((_, i) => i), colFields.length),
    grand: (cr.grand || [])[0]?.slice(0) ?? null,
    subtotals: (cr.subtotals || []).map((s, i) => ({
      cells: index(s.cells, s.prefix.map((_, j) => j), colFields.map((_, j) => s.prefix.length + j), s.prefix.length + colFields.length),
      total: index(s.total, s.prefix.map((_, j) => j), [], s.prefix.length),
    })),
  }));

  /** Build the aligned cell array for one (rowKey) against a set of indexes. */
  const cellsFor = (rowKey, main, rowTotals, comparisons) =>
    leafColumns.map((leaf) => {
      const source = leaf.isTotal ? rowTotals : main;
      const values = leaf.isTotal
        ? source?.get(rowKey)?.get(keyOf([]))
        : source?.get(rowKey)?.get(leaf._columnKey);
      const current = values ? values[leaf._valueIndex] : null;

      if (!leaf.isComparison) return cell(current, displayFor(leaf));

      const ci = leaf._comparisonIndex;
      const cmp = comparisons?.[ci];
      const priorSource = leaf.isTotal ? cmp?.rowTotals : cmp?.main;
      const priorValues = leaf.isTotal
        ? priorSource?.get(rowKey)?.get(keyOf([]))
        : priorSource?.get(rowKey)?.get(leaf._columnKey);
      const prior = priorValues ? priorValues[leaf._valueIndex] : null;
      return cell(
        comparisonValue(current, prior, layout.comparisons[ci].display),
        displayFor(leaf),
      );
    });

  /* ── Data rows, with subtotals interleaved ─────────────────────────────── */
  const outRows = [];
  const subtotalPlans = results.subtotals || [];

  /** The subtotal indexes at a given nesting depth. */
  const subtotalIndexAt = (depth) => {
    const plan = subtotalPlans[depth];
    if (!plan) return null;
    const prefixLen = depth + 1;
    return {
      cells: index(plan.cells, plan.prefix.map((_, j) => j),
        colFields.map((_, j) => prefixLen + j), prefixLen + colFields.length),
      total: index(plan.total, plan.prefix.map((_, j) => j), [], prefixLen),
    };
  };
  const subtotalIndexes = subtotalPlans.map((_, d) => subtotalIndexAt(d));

  /**
   * One subtotal row for the group `tuple[0..depth]`.
   *
   * Its cells come from the subtotal query at that grain — never from adding
   * up the data rows above it, because an average of averages is not an
   * average and a maximum of maxima is only accidentally a maximum.
   */
  const emitSubtotal = (tuple, depth) => {
    const idx = subtotalIndexes[depth];
    if (!idx) return;
    const prefix = tuple.slice(0, depth + 1);
    const labels = rowFields.map((_, i) =>
      i < depth + 1 ? semanticLabel(tuple[i], rowFields[i]) : "",
    );
    /* The keys are the group's OWN keys, with no " total" on them: a label is
       for reading and a key is for matching, and a subtotal belongs to the
       group whose key this is. */
    const keys = rowFields.map((_, i) =>
      i < depth + 1 ? semanticKey(tuple[i], rowFields[i]) : null,
    );
    labels[depth] = `${labels[depth]} total`;
    outRows.push({
      kind: "subtotal",
      depth,
      labels,
      keys,
      cells: cellsFor(keyOf(prefix), idx.cells, idx.total,
        comparisonIndexes.map((c) => ({
          main: c.subtotals[depth]?.cells,
          rowTotals: c.subtotals[depth]?.total,
        }))),
    });
  };

  /* Groups close deepest-first as the rows walk past them, so a report reads
     the way a person writes one: the detail, then its subtotal, then the next
     group. `deepestSubtotal` is the last level that HAS a subtotal — the leaf
     level does not, because a subtotal of one row is that row again. */
  const deepestSubtotal = rowFields.length - 2;
  let previousTuple = null;

  for (const tuple of rowTuples) {
    if (previousTuple) {
      let diffAt = 0;
      while (
        diffAt < rowFields.length &&
        keyOf([tuple[diffAt]]) === keyOf([previousTuple[diffAt]])
      ) {
        diffAt += 1;
      }
      for (let depth = deepestSubtotal; depth >= diffAt; depth -= 1) {
        emitSubtotal(previousTuple, depth);
      }
    }

    outRows.push({
      kind: "data",
      depth: Math.max(rowFields.length - 1, 0),
      labels: tuple.map((v, i) => semanticLabel(v, rowFields[i])),
      keys: tuple.map((v, i) => semanticKey(v, rowFields[i])),
      cells: cellsFor(keyOf(tuple), mainIndex, rowTotalIndex,
        comparisonIndexes.map((c) => ({ main: c.main, rowTotals: c.rowTotals }))),
    });
    previousTuple = tuple;
  }

  // Close every group still open at the end of the report.
  if (previousTuple) {
    for (let depth = deepestSubtotal; depth >= 0; depth -= 1) emitSubtotal(previousTuple, depth);
  }

  /* ── Column totals: one row across the bottom ──────────────────────────── */
  if (layout.showColumnTotals && (results.colTotals || results.grand)) {
    outRows.push({
      kind: "total",
      depth: 0,
      labels: ["Total", ...rowFields.slice(1).map(() => "")],
      /* A total is not a group, so it has no group key. Aligned all the same,
         so `keys[i]` always answers for `rowLevels[i]`. */
      keys: rowFields.map(() => null),
      cells: leafColumns.map((leaf) => {
        const values = leaf.isTotal
          ? grandValues
          : colTotalIndex.get(keyOf([]))?.get(leaf._columnKey);
        const current = values ? values[leaf._valueIndex] : null;
        if (!leaf.isComparison) return cell(current, displayFor(leaf));
        const cmp = comparisonIndexes[leaf._comparisonIndex];
        const priorValues = leaf.isTotal
          ? cmp?.grand
          : cmp?.colTotals.get(keyOf([]))?.get(leaf._columnKey);
        const prior = priorValues ? priorValues[leaf._valueIndex] : null;
        return cell(
          comparisonValue(current, prior, layout.comparisons[leaf._comparisonIndex].display),
          displayFor(leaf),
        );
      }),
    });
  }

  /* ── The grand total ───────────────────────────────────────────────────── */
  let grandTotal = null;
  if (layout.showGrandTotal && grandValues) {
    grandTotal = {
      labels: ["Grand total", ...rowFields.slice(1).map(() => "")],
      keys: rowFields.map(() => null),
      cells: leafColumns.map((leaf) => {
        const values = leaf.isTotal
          ? grandValues
          : colTotalIndex.get(keyOf([]))?.get(leaf._columnKey);
        const current = values ? values[leaf._valueIndex] : null;
        if (!leaf.isComparison) return cell(current, displayFor(leaf));
        const cmp = comparisonIndexes[leaf._comparisonIndex];
        const priorValues = leaf.isTotal
          ? cmp?.grand
          : cmp?.colTotals.get(keyOf([]))?.get(leaf._columnKey);
        const prior = priorValues ? priorValues[leaf._valueIndex] : null;
        return cell(
          comparisonValue(current, prior, layout.comparisons[leaf._comparisonIndex].display),
          displayFor(leaf),
        );
      }),
    };
  }

  const columnLevels = buildColumnLevels({ layout, columnTuples, leafColumns });

  /* The private `_` keys are the shaper's own bookkeeping and are stripped:
     `_columnKey` is a JSON encoding of a group VALUE, which is data, and
     `_valueIndex` is an offset into a Metabase result. Neither is the
     browser's business. */
  const publicLeaves = leafColumns.map(({ _columnKey, _valueIndex, _comparisonIndex, comparisonDisplay, ...rest }) => rest);

  /* ── What was shown, and what was left out ─────────────────────────────
     `outRows` is the WHOLE report in the B3 order. The cut is taken here, so
     everything after it is, by construction, the tail of the sorted result —
     the omitted set is never recomputed from a differently ordered query. */
  const cut = limit ? limitRowsKeepingTotals(outRows, limit) : outRows.length;
  const shownRows = limit ? outRows.slice(0, cut) : outRows;
  const omittedData = outRows.slice(cut).filter((r) => r.kind === "data");

  /* Only data rows are counted, in all three numbers. A subtotal is a
     restatement of rows that are already counted, so counting it would make a
     two-level report claim more groups than it has — and could put the
     physical row count above the limit while the count said otherwise. */
  const previewRowCount = shownRows.reduce((n, r) => (r.kind === "data" ? n + 1 : n), 0);
  const groupCount = rowTuples.length;
  const truncated = groupCount > previewRowCount;

  return {
    mode: "summary",
    columnLevels,
    leafColumns: publicLeaves,
    rowLevels: layout.rows.map((r) => ({
      heading: r.heading,
      ...semantics.publicSemantics(r.field),
    })),
    rows: shownRows,
    grandTotal,
    /** Data rows actually in `rows`. Never the group count. */
    previewRowCount,
    /** Every distinct data group the filters match, before the limit. */
    groupCount,
    /** Kept for compatibility: the COMPLETE count — groups here, records in a
        detail list. Identical to `groupCount` in a summary. */
    totalRowCount: groupCount,
    truncated,
    omitted: truncated
      ? { rows: groupCount - previewRowCount, values: omittedValues(omittedData, leafColumns, layout) }
      : null,
    dataAsOf,
  };
}

/**
 * The exact figure each leaf column loses to the limit.
 *
 * Summed from the OMITTED rows themselves, cell by cell, not inferred by
 * subtracting the visible rows from a grand total: a subtraction would quietly
 * absorb any disagreement between the two into a number that looks right.
 *
 * A sum is only honest for an ADDITIVE column. `total` and `count` add across
 * disjoint groups; an average of averages is not an average, a maximum of
 * maxima is only accidentally a maximum, and a percentage of a percentage is
 * nothing at all. Those columns are reported as `null` — present, so a client
 * knows the column lost something, and null, because no honest number exists.
 *
 * Signs are whatever the cells hold. Debit, credit, a signed amount, a count
 * and a difference each keep their own arithmetic; nothing is made positive.
 */
function omittedValues(omittedData, leafColumns, layout) {
  const out = {};
  leafColumns.forEach((leaf, i) => {
    const calculation = leaf.isComparison
      ? layout.values[leaf._valueIndex]?.calculation ?? "total"
      : layout.values[leaf._valueIndex]?.calculation;
    const additive =
      (calculation === "total" || calculation === "count")
      && leaf.comparisonDisplay !== "percentage_difference";

    if (!additive) { out[leaf.id] = null; return; }

    let sum = 0;
    for (const row of omittedData) {
      const value = row.cells[i]?.value;
      if (value === null || value === undefined) continue;
      sum += Number(value);
    }
    /* Six decimals kills the binary noise of adding three hundred floats
       without touching any figure a ledger can hold. */
    out[leaf.id] = Math.round(sum * 1e6) / 1e6;
  });
  return out;
}

/**
 * Where to cut a truncated preview.
 *
 * Counted in DATA rows, so a cut never lands between a group and its subtotal
 * and leaves a subtotal describing rows that are not on screen.
 */
function limitRowsKeepingTotals(rows, limit) {
  let data = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i].kind === "data") data += 1;
    if (data > limit) return i;
  }
  return rows.length;
}

module.exports = {
  semanticCell,
  semanticKey,
  semanticLabel,
  shapeDetail,
  shapeSummary,
  comparisonValue,
  comparisonHeading,
  formatPeriodLabel,
  compareValues,
  distinctTuples,
  labelOf,
  keyOf,
};
