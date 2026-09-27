// services/reporting/previewBudget.js
//
// WHAT A PREVIEW IS ALLOWED TO COST, DECIDED BEFORE IT COSTS IT.
//
// A summary is not one query. It is a PLAN of separate aggregate queries —
// the cells, the row totals, the column totals, the grand total, a pair per
// nesting level for the subtotals, and the whole lot again for every
// comparison. The audit measured legal layouts at 12 and 22 sequential
// queries; the second took 2.8 s and the first returned 1.76 MB of JSON.
// Nothing refused them, because every individual shelf limit was respected.
//
// So the judgement here is on the COMPLETE PLAN, not on the shelves. The
// existing per-shelf limits are untouched: this is an additional gate, and it
// runs before a single engine query does.
//
// ── THE COUNT IS THE COMPILER'S, NOT AN ESTIMATE ────────────────────────────
// `queryCount` is obtained by compiling the real plan with `compilePlan` and
// counting what it holds. A structural formula written out by hand here would
// be a second definition of the plan's shape, and it would drift the first
// time a total or a subtotal moved. The compile is done with PLACEHOLDER field
// ids — the shape of a plan does not depend on which table it points at — so
// this module makes no network call and needs no engine metadata. That is what
// lets a too-expensive report be refused with the engine never contacted.
//
// ── THE CONSTANTS, AND WHERE THEY COME FROM ─────────────────────────────────
// Measured on the pilot (audit §12), with the query count recomputed from the
// plan the compiler actually builds:
//
//   layout                         queries   time      response
//   detail list                          2   276 ms       —
//   1 row + 1 value                      3  1,137 ms     3 KB
//   Ledger Group × Month, 2 values       4      —          —
//   2 rows + 1 column                    6    767 ms    74 KB
//   5 rows (the shelf cap)              11  1,521 ms    38 KB
//   5 rows + 3 columns + 8 values       12  2,443 ms  1.76 MB   ← refuse
//   5 rows + 1 comparison               22  2,770 ms    46 KB   ← refuse
//
// `maxQueries` sits at 11: one above nothing, exactly at the heaviest shape
// that behaved well, and below the two that did not. `maxLayoutUnits` catches
// the other axis — the 12-query layout is only one query over the line but
// 120 units over it, because what made it 1.76 MB was 3 × 8 leaf columns
// against five levels of grouping, not the number of queries.
//
// `maxResponseBytes` is a backstop for a layout that passes both and is still
// enormous. It is set BELOW the measured 1.76 MB case deliberately: the same
// layout must get the same answer whichever gate catches it.
"use strict";

const { compilePlan } = require("./mbqlCompiler");
const catalogue = require("./fieldCatalogue");

/** The budget. Changing a number here changes what the product refuses. */
const BUDGET = Object.freeze({
  maxQueries: 11,
  maxLayoutUnits: 24,
  maxResponseBytes: 1_500_000,
});

/** What a caller is told, in words they can act on. */
const TOO_COMPLEX =
  "This report is too large to preview. Remove a grouping or calculated amount, " +
  "or add a filter.";
const TOO_LARGE =
  "This report produced too much data to preview. Narrow the report — remove a " +
  "grouping or calculated amount, or add a filter.";

/* Placeholder ids: a plan's SHAPE is independent of the table it points at,
   and resolving the real ones would mean asking the engine — which is the one
   thing a refusal must not have to do. */
const SHAPE_ONLY = Object.freeze({
  databaseId: 0,
  tableId: 0,
  fieldIds: Object.freeze(Object.fromEntries(
    [...catalogue.allColumns(), "organization_id", "company_id"].map((c) => [c, 0]),
  )),
});

/** Every query one plan (or one comparison's sub-plan) will run. */
function planQueryCount(plan) {
  if (!plan) return 0;
  if (plan.mode === "detail") return 2;            // the rows, and their count
  const own = 1
    + (plan.rowTotals ? 1 : 0)
    + (plan.colTotals ? 1 : 0)
    + (plan.grand ? 1 : 0)
    + (plan.subtotals || []).reduce((n, s) => n + 1 + (s.total ? 1 : 0), 0);
  /* A comparison carries its own sub-plan of the same shape — and a
     `comparison` key of its own holding the DESCRIPTOR, not another plan, so
     only an array is recursed into. */
  const nested = Array.isArray(plan.comparison) ? plan.comparison : [];
  return own + nested.reduce((n, c) => n + planQueryCount({ ...c, comparison: null, mode: "summary" }), 0);
}

/**
 * What this preview will cost, and whether it is allowed.
 *
 * @param {object} layout      a VALIDATED layout
 * @param {object} [options]
 * @param {object} [options.plan]  the compiled plan, when the caller already
 *                                 has one; otherwise it is compiled here with
 *                                 placeholder ids purely to be counted.
 */
function estimate(layout, { plan = null, organizationId = null } = {}) {
  const shaped = plan || compilePlan({
    layout,
    resolved: SHAPE_ONLY,
    organizationId: organizationId || "0".repeat(24),
    companyIds: layout.companyIds || [],
    limit: layout.limit,
  });

  const rowFields = layout.rows.length;
  const columnFields = layout.columns.length;
  const valueColumns = layout.values.length;
  const comparisons = layout.comparisons.length;

  /* One "unit" is one leaf-column family under one grouping combination: the
     structural size of the sheet, before any figure is known. Cardinality is
     unknowable here — this is the part of the cost the LAYOUT decides. */
  const layoutUnits = Math.max(rowFields, 1)
    * Math.max(columnFields, 1)
    * Math.max(valueColumns + comparisons, 1);

  const queryCount = planQueryCount(shaped);

  let exceeded = null;
  if (queryCount > BUDGET.maxQueries) exceeded = "queries";
  else if (layoutUnits > BUDGET.maxLayoutUnits) exceeded = "units";

  return {
    queryCount,
    rowFields,
    columnFields,
    valueColumns,
    comparisons,
    layoutUnits,
    allowed: exceeded === null,
    exceeded,
    budget: BUDGET,
  };
}

/**
 * The body of a refusal.
 *
 * It says what the report is made of — groupings, calculations, comparisons —
 * because that is what the person has to change. It names no table, no column,
 * no query and no engine: a refusal is not a place to start describing the
 * inside of the system.
 */
function refusalDetails(cost) {
  return {
    message: TOO_COMPLEX,
    report: {
      rowGroupings: cost.rowFields,
      columnGroupings: cost.columnFields,
      calculations: cost.valueColumns,
      comparisons: cost.comparisons,
    },
  };
}

/** Is a shaped response small enough to send whole? */
function withinByteCeiling(bytes) {
  return bytes <= BUDGET.maxResponseBytes;
}

module.exports = {
  BUDGET,
  TOO_COMPLEX,
  TOO_LARGE,
  estimate,
  planQueryCount,
  refusalDetails,
  withinByteCeiling,
};
