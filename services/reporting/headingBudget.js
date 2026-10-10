// services/reporting/headingBudget.js
//
// HOW WIDE THE SHEET WILL ACTUALLY BE, COUNTED BEFORE IT IS BUILT.
//
// ── WHY THE B6 BUDGET CANNOT ANSWER THIS ────────────────────────────────────
// `previewBudget.js` judges the COMPLETE PLAN and says so in its own words:
// "Cardinality is unknowable here — this is the part of the cost the LAYOUT
// decides." It counts fields, values and queries. One field across the top is
// one field whether it holds twelve months or nine thousand voucher numbers,
// so every static gate in the system passes both identically.
//
// That is exactly why `voucher.number` was forbidden across the top: a blunt
// catalogue rule was the only protection available. It is also why the rule
// was too blunt — a report filtered to one day's vouchers is a perfectly
// reasonable thing to want, and nothing about the layout distinguishes it from
// the one that would produce a sheet nine thousand columns wide.
//
// So the bound is applied where the answer lives: the data, after the
// company scope and the report's own filters.
//
// ── THE COUNT IS BOUNDED ────────────────────────────────────────────────────
// The probe is a grouped count over the column fields with `limit: MAX + 1`.
// It can therefore return at most MAX + 1 rows, whatever the books hold. It
// does NOT count the whole set and then compare — asking "how many are there"
// of a column with nine thousand distinct values is the very cost being
// avoided. When MAX + 1 rows come back the honest answer is "more than MAX",
// and that is what the refusal says.
//
// ── IT CARRIES THE SAME SECURITY FILTER AS THE REPORT ───────────────────────
// Built with `buildQuery`, which begins with `tenantFilters` — organisation
// and company, unconditionally, throwing if either is absent. The probe cannot
// see further than the report it is authorising, and it runs only AFTER the
// route's own company-scope guard has already refused an unowned company.
//
// ── WHAT IT NEVER SAYS ──────────────────────────────────────────────────────
// The refusal carries field LABELS, counts and advice. No Metabase id, no
// MBQL, no SQL, no mart column name, no credential.
"use strict";

const { buildQuery } = require("./mbqlCompiler");
const { CODES, ReportingError } = require("./metabaseEngine");

/**
 * The server's maximum, and the only place it is written down.
 *
 * ── WHERE 50 COMES FROM ─────────────────────────────────────────────────────
 * The sheet's width is `headings × values` leaf columns, and a preview returns
 * at most 100 rows, so the response grows as 100 × headings × values cells.
 * Measured against the existing `maxResponseBytes` backstop of 1,500,000:
 *
 *   headings   values   leaf columns   measured preview
 *         15        1             15      ~34 KB   (a year by month)
 *         50        1             50     ~110 KB   ← at the bound
 *         50        3            150     ~325 KB
 *        100        3            300     ~650 KB
 *
 * 50 is not where the bytes become dangerous — it is where the SHEET does. A
 * hundred-column-wide table is not a report anybody reads; it is an export.
 * The byte backstop stays as the thing that catches a layout which slips past
 * every structural gate, and this bound keeps the product honest well before
 * it. Raising it is a product decision, not a technical one, and it is a
 * one-line change here.
 */
const HEADING_BUDGET = Object.freeze({
  maxHeadings: 50,
});

/**
 * Count the distinct horizontal heading combinations this report would make.
 *
 * Combinations, not fields: Voucher Type × Month across the top is one axis
 * with (types × months) headings on it, and bounding the two fields separately
 * would let their product through.
 *
 * @returns {Promise<{headings: number, exact: boolean, allowed: boolean}>}
 *          `exact: false` means "more than `headings - 1`" — the probe stopped
 *          counting at the bound.
 */
async function countHeadings({
  layout, resolved, organizationId, companyIds, runQuery, deadline = null, timeoutMs = null,
}) {
  const colFields = (layout.columns || []).map((c) => c.field);
  if (colFields.length === 0) {
    return { headings: 0, exact: true, allowed: true };
  }

  const probe = buildQuery({
    resolved,
    organizationId,
    companyIds,
    filters: layout.filters || [],
    breakout: colFields,
    /* A breakout needs an aggregation, and `count` is the cheapest one that
       exists — the figures are irrelevant here; only how many groups there
       are. */
    aggregate: [{ field: null, calculation: "count" }],
    /* The bound itself. One more than the maximum, so a result AT the
       maximum is told apart from one above it. */
    limit: HEADING_BUDGET.maxHeadings + 1,
  });

  const rows = await runQuery(probe, { deadline, timeoutMs });
  const seen = Array.isArray(rows) ? rows.length : 0;

  return seen > HEADING_BUDGET.maxHeadings
    ? { headings: seen, exact: false, allowed: false }
    : { headings: seen, exact: true, allowed: true };
}

/**
 * What the caller is told. Labels and numbers only.
 *
 * @param {object} layout  the validated layout, for its column field labels
 * @param {object} count   the result of `countHeadings`
 */
function refusalDetails(layout, count) {
  const fields = (layout.columns || []).map((c) => c.field.label);
  const named = fields.length === 1 ? fields[0] : fields.join(" × ");

  return {
    /* The field the user should act on. With several across the top it is the
       combination that is too wide, so all of them are named. */
    field: named,
    fields,
    /* `exact: false` means the count stopped at the bound: the honest phrase
       is "more than", and the number is the bound, not a total nobody
       counted. */
    headings: count.exact ? count.headings : HEADING_BUDGET.maxHeadings,
    exact: count.exact,
    maximum: HEADING_BUDGET.maxHeadings,
    reason:
      `${named} would make more than ${HEADING_BUDGET.maxHeadings} headings across the top, ` +
      `and a report that wide cannot be read. Filter ${named} more narrowly, ` +
      "or put it down the left instead.",
  };
}

/** The sentence shown when nothing reads the details. */
function message(layout, count) {
  return refusalDetails(layout, count).reason;
}

/**
 * Count, and throw a `ReportingError` carrying the public code when over.
 *
 * Used by the paths that have no refusal plumbing of their own (export, chart);
 * `/preview` calls `countHeadings` directly so it can record its telemetry.
 */
async function assertWithinBudget(args) {
  const count = await countHeadings(args);
  if (count.allowed) return count;

  const err = new ReportingError(CODES.TOO_MANY_HEADINGS, message(args.layout, count), {
    status: 422,
  });
  err.details = refusalDetails(args.layout, count);
  throw err;
}

module.exports = {
  HEADING_BUDGET,
  countHeadings,
  refusalDetails,
  message,
  assertWithinBudget,
};
