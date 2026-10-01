// services/reporting/fieldCatalogue.js
//
// THE FLAT FIELD CATALOGUE — one list, no templates, no report types.
//
// The user opens a blank layout and builds whatever they want out of these.
// This file is the only mapping from a field id the browser may say to a column
// the database actually has, and the only place a field's permissions live.
//
// ── A FIELD ID IS NOT A COLUMN NAME ─────────────────────────────────────────
// `date.voucher`, not `voucher_date`. `amount.debit`, not `debit`. If ids were
// columns, a caller guessing `gstin` or `company_id` would be guessing a real
// identifier and only a lookup miss would stop them; with a semantic id there
// is nothing to guess, because `gstin` is not a key in any map here.
//
// (The contract document's illustrative JSON still shows `"id": "voucher_date"`
// while its own table says an id must NOT be a column name. The rule is
// followed. The ids are also the ones the task specified — `date.voucher`,
// `ledger.name`, `ledger.group`, `amount.debit`, `amount.credit`.)
//
// ── PERMISSION TRAVELS WITH THE DESCRIPTOR ──────────────────────────────────
// `placements`, `calculations`, `filterOperations` and `comparisons` are read
// off the descriptor the server owns. A layout claiming a field may go on Values
// does not make it so.
//
// ── ONE GRAIN, AND WHY SOME REAL FIELDS ARE MISSING ─────────────────────────
// The mart holds three grains: voucher header, voucher LINE, and ledger/period
// movement. Mixing them duplicates money, silently and plausibly:
//
//   • `fact_voucher.grand_total` is per VOUCHER. Grouped by ledger it repeats
//     once per line, so a two-line voucher counts twice and a ten-line voucher
//     ten times. A "total sales by ledger" built that way is simply wrong, and
//     looks right.
//   • `dim_ledger.opening_balance` is per LEDGER. Grouped by voucher it repeats
//     once per voucher that touched the ledger.
//
// So this first version offers ONE universe — the voucher LINE, from
// `reporting.v_general_ledger` — where every field below is an attribute of the
// same row and any combination of them is arithmetically safe. Voucher grand
// total and ledger opening balance are DELIBERATELY ABSENT rather than offered
// with a warning: a figure a user can reach is a figure that ends up in a board
// pack, and "we told them not to" is not a control.
//
// The compatibility MECHANISM is implemented in full (`compatibleWith`, checked
// symmetrically by `mutuallyCompatible`) and is what a second universe will be
// declared through. Today every field is compatible with every other, because
// every field is on the same row — which is the point of choosing one universe.

"use strict";

const semantics = require("./semantics");

/** The mart view this universe reads. Never leaves the server. */
const SOURCE_VIEW = "v_general_ledger";

/** Column types, as the contract defines them. */
const TYPES = {
  TEXT: "text",
  DATE: "date",
  DATETIME: "datetime",
  MONEY: "money",
  NUMBER: "number",
  INTEGER: "integer",
  BOOLEAN: "boolean",
  CHOICE: "choice",
};

/** The five shelves. */
const SHELVES = ["rows", "columns", "values", "filters", "comparisons"];

/** Calculations the contract defines. */
const CALCULATIONS = ["total", "count", "average", "minimum", "maximum"];

/** Comparison modes and displays the contract defines. */
const COMPARISON_MODES = ["previous_period", "previous_year", "other_company", "other_field"];
const COMPARISON_DISPLAYS = ["side_by_side", "difference", "percentage_difference"];

/**
 * The modes this server ACTUALLY implements.
 *
 * The contract lists four. A catalogue that advertised one the compiler cannot
 * build would let a user construct a report that fails when they refresh it,
 * which reads as our bug rather than as an unavailable feature — so the
 * catalogue only ever offers what `metabaseEngine.js` can compile today.
 */
const SUPPORTED_COMPARISON_MODES = ["previous_period", "previous_year", "other_company"];
const SUPPORTED_COMPARISON_DISPLAYS = ["side_by_side", "difference", "percentage_difference"];

/** Filter operations by type. */
const OPERATIONS_BY_TYPE = {
  [TYPES.DATE]: ["between", "on", "before", "after"],
  [TYPES.DATETIME]: ["between", "on", "before", "after"],
  [TYPES.MONEY]: ["equals", "greater_than", "less_than", "between"],
  [TYPES.NUMBER]: ["equals", "greater_than", "less_than", "between"],
  [TYPES.INTEGER]: ["equals", "greater_than", "less_than", "between"],
  [TYPES.TEXT]: ["is", "contains", "starts_with"],
  [TYPES.CHOICE]: ["is", "in"],
  [TYPES.BOOLEAN]: ["is"],
};

/** Calculations by type, most useful first — the first is the default. */
const CALCULATIONS_BY_TYPE = {
  [TYPES.MONEY]: ["total", "average", "maximum", "minimum", "count"],
  [TYPES.NUMBER]: ["total", "average", "maximum", "minimum", "count"],
  [TYPES.INTEGER]: ["total", "average", "maximum", "minimum", "count"],
  [TYPES.DATE]: ["count", "minimum", "maximum"],
  [TYPES.DATETIME]: ["count", "minimum", "maximum"],
  [TYPES.TEXT]: ["count"],
  [TYPES.CHOICE]: ["count"],
  [TYPES.BOOLEAN]: ["count"],
};

/** Voucher types, from `Acc_VoucherModels.js:165-184`. Constants, not data. */
const VOUCHER_TYPE_CHOICES = [
  ["sales", "Sales"], ["purchase", "Purchase"], ["receipt", "Receipt"],
  ["payment", "Payment"], ["contra", "Contra"], ["journal", "Journal"],
  ["credit_note", "Credit Note"], ["debit_note", "Debit Note"],
  ["stock_journal", "Stock Journal"], ["delivery_note", "Delivery Note"],
  ["receipt_note", "Receipt Note"], ["rejection_in", "Rejection In"],
  ["rejection_out", "Rejection Out"], ["physical_stock", "Physical Stock"],
].map(([value, label]) => ({ value, label }));

const C = {
  COMPANY: "Company",
  DATES: "Dates",
  VOUCHER: "Voucher",
  LEDGER: "Ledger",
  PARTY: "Party",
  AMOUNTS: "Amounts",
  TAX: "Tax",
};

/**
 * One field.
 *
 * `column` and `temporalUnit` are private and stripped before the catalogue is
 * served. Everything else is what the browser is allowed to know.
 *
 * ── SEMANTICS ARE MANDATORY AND CHECKED HERE ────────────────────────────────
 * `semanticType`, `display` and `chart` say what the field MEANS — that
 * `date.month` is a month and not merely a date, that `voucher.number` is an
 * identifier and not merely text. Without them a client has to read the
 * English label, which is how a month came to be rendered as "01 Jul 2025".
 *
 * `assertSemantics` runs as this array is built, so a typo is a `require` that
 * throws: every test fails and the server does not start. A field that renders
 * as something it is not would otherwise be discovered in a board pack.
 */
function field(id, column, label, category, type, description, options = {}) {
  const built = {
    id,
    column,
    label,
    category,
    type,
    description,
    placements: options.placements,
    calculations: options.calculations ?? (
      options.placements.includes("values") ? CALCULATIONS_BY_TYPE[type] || [] : []
    ),
    filterOperations: options.placements.includes("filters")
      ? options.filterOperations ?? OPERATIONS_BY_TYPE[type] ?? []
      : [],
    comparisons: options.comparisons ?? null,
    /* null means "compatible with anything". Every field in this universe is
       an attribute of the same row, so every one of them is null today — the
       mechanism exists for the second universe, not for decoration. */
    compatibleWith: options.compatibleWith ?? null,
    choices: options.choices ?? null,
    defaultWidth: options.defaultWidth ?? 140,

    /* What it means, how to show it, and what a chart should do with it. */
    semanticType: options.semanticType,
    display: options.display,
    chart: options.chart,
  };
  return semantics.assertSemantics(built);
}

/** A period field's display block. Written once so the three cannot drift. */
const PERIOD_DISPLAY = {
  date: { format: "day_month_year", sort: "chronological" },
  month: { format: "month_year", sort: "chronological" },
  financial_year: { format: "financial_year", sort: "chronological" },
};

/** Money: the same everywhere, measured rather than grouped by. */
const MONEY_DISPLAY = { format: "currency_inr", sort: "numeric" };
const MONEY_CHART = { role: "measure" };

/** A name a person recognises, and a chart can put on an axis. */
const nameChart = (defaultGroupingPriority, highCardinality = false) =>
  ({ role: "category", defaultGroupingPriority, highCardinality });

/** A money field's comparison offer — the only fields worth comparing. */
const MONEY_COMPARISONS = {
  modes: SUPPORTED_COMPARISON_MODES,
  displays: SUPPORTED_COMPARISON_DISPLAYS,
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* The fields                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

const FIELDS = [
  /* ── Company ── */
  field("company.name", "company_name", "Company", C.COMPANY, TYPES.TEXT,
    "The company the line belongs to. Put it in Rows or Columns to compare companies side by side.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 200,
      semanticType: "company", display: { format: "text", sort: "alphabetical" },
      chart: nameChart(20) }),

  /* ── Dates ── */
  field("date.voucher", "voucher_date", "Voucher Date", C.DATES, TYPES.DATE,
    "The accounting date of the voucher.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 130,
      semanticType: "date", display: PERIOD_DISPLAY.date,
      chart: { role: "temporal", defaultGroupingPriority: 40, highCardinality: false } }),
  field("date.month", "period_month", "Month", C.DATES, TYPES.DATE,
    "The month the voucher falls in. The usual thing to put across the top.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 120,
      semanticType: "month", display: PERIOD_DISPLAY.month,
      chart: { role: "temporal", defaultGroupingPriority: 30, highCardinality: false } }),
  field("date.financial_year", "financial_year", "Financial Year", C.DATES, TYPES.TEXT,
    "The Indian financial year, April to March.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 130,
      semanticType: "financial_year", display: PERIOD_DISPLAY.financial_year,
      chart: { role: "temporal", defaultGroupingPriority: 25, highCardinality: false } }),

  /* ── Voucher ── */
  field("voucher.number", "voucher_number", "Voucher Number", C.VOUCHER, TYPES.TEXT,
    "The voucher number as entered.",
    { placements: ["rows", "filters"], defaultWidth: 150,
      /* `text_exact` is what protects `00531`: the format says "these
         characters", and `assertSemantics` refuses to let a field carrying it
         be calculated or placed in Values. */
      semanticType: "identifier", display: { format: "text_exact", sort: "natural" },
      chart: { role: "identifier", defaultGroupingPriority: 95, highCardinality: true } }),
  field("voucher.type", "voucher_type", "Voucher Type", C.VOUCHER, TYPES.CHOICE,
    "Sales, purchase, receipt, payment, journal and so on.",
    { placements: ["rows", "columns", "filters"], choices: VOUCHER_TYPE_CHOICES, defaultWidth: 130,
      semanticType: "enum", display: { format: "choice_label", sort: "alphabetical" },
      chart: nameChart(35) }),
  field("voucher.narration", "narration", "Narration", C.VOUCHER, TYPES.TEXT,
    "The note written on the line, or on the voucher. Useful in a detail list; " +
    "too varied to group by.",
    { placements: ["rows", "filters"], defaultWidth: 280,
      semanticType: "free_text", display: { format: "text", sort: "alphabetical" },
      chart: { role: "text", defaultGroupingPriority: 99, highCardinality: true } }),

  /* ── Ledger ── */
  field("ledger.name", "ledger_name", "Ledger Name", C.LEDGER, TYPES.TEXT,
    "The account the line was posted to.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 240,
      semanticType: "ledger", display: { format: "text", sort: "alphabetical" },
      chart: nameChart(50, true) }),
  field("ledger.group", "group_name", "Ledger Group", C.LEDGER, TYPES.TEXT,
    "The chart-of-accounts group the ledger sits under.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 200,
      semanticType: "ledger_group", display: { format: "text", sort: "alphabetical" },
      chart: nameChart(10) }),

  /* ── Party ── */
  field("party.name", "party_ledger_name", "Party", C.PARTY, TYPES.TEXT,
    "The customer or supplier named on the voucher.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 220,
      semanticType: "party", display: { format: "text", sort: "alphabetical" },
      chart: nameChart(45, true) }),

  /* ── Amounts ── */
  /* ── Amounts ──
   * `rows` IS offered, and it means one thing only: a DETAIL list, where Rows
   * are the record's displayed columns and "Voucher Date, Number, Party,
   * Debit, Credit" is the report. It does NOT mean an amount may be a grouping
   * key in a pivot — grouping by Debit would make one row per distinct amount,
   * which is not a report. `reportLayout.validate.js` refuses that the moment
   * the layout becomes a summary, which is the only point at which "row" means
   * "group by" rather than "column". */
  field("amount.debit", "debit", "Debit", C.AMOUNTS, TYPES.MONEY,
    "The debit amount of the line; zero on a credit line.",
    { placements: ["rows", "values", "filters", "comparisons"], comparisons: MONEY_COMPARISONS, defaultWidth: 150,
      semanticType: "currency", display: MONEY_DISPLAY, chart: MONEY_CHART }),
  field("amount.credit", "credit", "Credit", C.AMOUNTS, TYPES.MONEY,
    "The credit amount of the line; zero on a debit line.",
    { placements: ["rows", "values", "filters", "comparisons"], comparisons: MONEY_COMPARISONS, defaultWidth: 150,
      semanticType: "currency", display: MONEY_DISPLAY, chart: MONEY_CHART }),
  field("amount.signed", "signed_amount", "Signed Amount", C.AMOUNTS, TYPES.MONEY,
    "Positive for a debit, negative for a credit. Totals to zero when the books balance.",
    { placements: ["rows", "values", "filters", "comparisons"], comparisons: MONEY_COMPARISONS, defaultWidth: 160,
      semanticType: "currency_signed", display: MONEY_DISPLAY, chart: MONEY_CHART }),

  /* ── Tax ── */
  field("tax.classification", "gst_classification", "GST Classification", C.TAX, TYPES.TEXT,
    "Taxable, exempt, nil-rated or non-GST, as classified on the line.",
    { placements: ["rows", "columns", "filters"], defaultWidth: 170,
      semanticType: "enum", display: { format: "text", sort: "alphabetical" },
      chart: nameChart(60) }),
];

/**
 * Fields that exist in the mart and are DELIBERATELY not offered.
 *
 * Kept as data rather than as a comment so the tests can assert that none of
 * them ever appears in the catalogue — an omission nobody checks is an omission
 * that gets undone.
 */
const WITHHELD = Object.freeze([
  { column: "grand_total", grain: "voucher header",
    reason: "Repeats once per ledger line. Summed by ledger it would count a two-line voucher twice." },
  { column: "opening_balance", grain: "ledger",
    reason: "Repeats once per voucher that touched the ledger, and again per month in the trial balance." },
  { column: "gstin", grain: "restricted",
    reason: "Restricted identifier; not needed for the first usable version." },
  { column: "organization_id", grain: "tenant",
    reason: "The immutable filter the compiler injects. Offering it would be a way to try to widen a query." },
  { column: "company_id", grain: "tenant",
    reason: "As above." },
]);

/* ─────────────────────────────────────────────────────────────────────────── */
/* Lookups                                                                    */
/* ─────────────────────────────────────────────────────────────────────────── */

const BY_ID = new Map(FIELDS.map((f) => [f.id, f]));

/** The columns the compiler injects as immutable filters. Never selectable. */
const TENANT_COLUMNS = Object.freeze({
  organization: "organization_id",
  company: "company_id",
});

/**
 * A field descriptor, or null.
 *
 * The only way a field id becomes a column. A miss is a miss: there is no
 * fallback that treats the id as a column name, which is what would turn a
 * guessed identifier into a query.
 */
function fieldOf(id) {
  if (typeof id !== "string") return null;
  return BY_ID.get(id) || null;
}

/**
 * Compatibility, checked in BOTH directions.
 *
 * A catalogue that listed a pairing on one field and forgot it on the other
 * would let the two in or out depending on which was added first — a bug that
 * shows up for one user in one order and is never reproducible. The frontend's
 * `lib/reporting/compatibility.js` checks it symmetrically for the same reason;
 * this is the server's own copy, because the browser's is a convenience.
 */
function mutuallyCompatible(a, b) {
  if (!a || !b) return true;
  if (a.id === b.id) return true;
  if (Array.isArray(a.compatibleWith) && !a.compatibleWith.includes(b.id)) return false;
  if (Array.isArray(b.compatibleWith) && !b.compatibleWith.includes(a.id)) return false;
  return true;
}

/** The catalogue as the browser receives it: `column` stripped. */
/**
 * WHAT ONE ROW OF A LIST IS.
 *
 * Served with the catalogue because the frontend has to be able to answer
 * "why does this voucher number appear three times?" without anybody guessing.
 * It does: a voucher with three ledger entries is three rows.
 *
 * The words are an accountant's. The mart view, the table and the word
 * "grain" as a database uses it stay on the server — `id` is a stable token
 * for a client to switch on, not a schema name.
 */
const GRAIN = Object.freeze({
  id: "voucher_line",
  label: "Voucher line",
  description:
    "Each row is one ledger entry within a voucher. A voucher with several " +
    "entries appears once for each of them, so its date, number and party " +
    "repeat down the list.",
});

function publicCatalogue(fields = FIELDS) {
  return {
    grain: { ...GRAIN },
    fields: fields.map((f) => ({
      id: f.id,
      label: f.label,
      category: f.category,
      type: f.type,
      description: f.description,
      placements: [...f.placements],
      calculations: [...f.calculations],
      filterOperations: [...f.filterOperations],
      comparisons: f.comparisons
        ? { modes: [...f.comparisons.modes], displays: [...f.comparisons.displays] }
        : null,
      compatibleWith: f.compatibleWith ? [...f.compatibleWith] : null,
      choices: f.choices ? f.choices.map((c) => ({ ...c })) : null,
      defaultWidth: f.defaultWidth,
      /* What the field MEANS, how to render it, and what a chart should do
         with it. Additive: `type` above keeps its meaning, so a client that
         reads only the older keys behaves exactly as it did. */
      ...semantics.publicSemantics(f),
    })),
  };
}

/** Every mart column this catalogue reads, for the "no raw names leak" tests. */
function allColumns() {
  const out = new Set(Object.values(TENANT_COLUMNS));
  for (const f of FIELDS) out.add(f.column);
  return [...out];
}

module.exports = {
  GRAIN,
  SOURCE_VIEW,
  TYPES,
  SHELVES,
  CALCULATIONS,
  COMPARISON_MODES,
  COMPARISON_DISPLAYS,
  SUPPORTED_COMPARISON_MODES,
  SUPPORTED_COMPARISON_DISPLAYS,
  OPERATIONS_BY_TYPE,
  CALCULATIONS_BY_TYPE,
  VOUCHER_TYPE_CHOICES,
  TENANT_COLUMNS,
  FIELDS,
  WITHHELD,
  fieldOf,
  mutuallyCompatible,
  publicCatalogue,
  allColumns,
  fieldIds: () => FIELDS.map((f) => f.id),
};
