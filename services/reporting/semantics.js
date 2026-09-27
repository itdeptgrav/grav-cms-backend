// services/reporting/semantics.js
//
// WHAT A FIELD MEANS, AS DATA RATHER THAN AS A LABEL.
//
// A primitive type says how to align a value. It does not say that
// `2025-07-01T00:00:00+05:30` is a MONTH — and the audit found the browser
// inferring exactly that from the English word "Month", then rendering the
// month as "01 Jul 2025" because it had been told `date`. This file is the
// vocabulary that replaces the guess, and the arithmetic that turns an engine
// value into the three things a client needs: a raw value, a stable key and a
// sentence to show.
//
// ── EVERY WORD IS ON A LIST ─────────────────────────────────────────────────
// `semanticType`, `display.format`, `display.sort` and `chart.role` are closed
// vocabularies, checked when the catalogue is built. A typo is a crash at
// require time, which is a failing test suite and a server that will not boot
// — not a field that quietly renders wrong for one customer.
//
// The lists carry words for fields that do NOT exist yet (`quarter`,
// `percentage`, `quantity`, `count`, `gst_rate`, `boolean`, `status`) so that
// adding one of those later is a catalogue entry rather than a contract
// change.
//
// ── KEYS ARE MADE BY SLICING, NEVER BY PARSING ──────────────────────────────
// Metabase returns a PostgreSQL `date` as `2025-07-01T00:00:00+05:30` — the
// instance's timezone, which is unset and therefore the JVM's. `new
// Date(that).getMonth()` in a UTC process is JUNE. So every key here is taken
// from the CHARACTERS of the ISO string. Nothing in this file constructs a
// `Date` from an engine value, and a test asserts the same string produces the
// same key whatever `TZ` the process runs under.

"use strict";

/* ─────────────────────────────────────────────────────────────────────────── */
/* The vocabularies                                                           */
/* ─────────────────────────────────────────────────────────────────────────── */

/** What a field IS. Reserved words are listed and simply unused today. */
const SEMANTIC_TYPES = Object.freeze([
  // periods
  "date", "month", "quarter", "financial_year",
  // money and numbers
  "currency", "currency_signed", "percentage", "quantity", "count", "gst_rate",
  // things with names
  "company", "ledger", "ledger_group", "party", "enum", "status", "boolean",
  // text
  "identifier", "free_text", "text",
]);

/** How a value should be rendered. */
const DISPLAY_FORMATS = Object.freeze([
  "text", "text_exact", "choice_label",
  "day_month_year", "month_year", "quarter_year", "financial_year",
  "currency_inr", "number", "integer", "percent", "boolean",
]);

/** How a set of values should be ordered. */
const SORT_MODES = Object.freeze(["chronological", "alphabetical", "numeric", "natural"]);

/** What a field is FOR, when something has to choose an axis. */
const CHART_ROLES = Object.freeze(["temporal", "category", "measure", "identifier", "text"]);

/** Formats that describe a period. These must be ordered chronologically. */
const CHRONOLOGICAL_FORMATS = Object.freeze(["day_month_year", "month_year", "quarter_year", "financial_year"]);

/** Semantic types that are a period, and therefore carry a key and a label. */
const PERIOD_TYPES = Object.freeze(["date", "month", "quarter", "financial_year"]);

/** Semantic types whose value is a code with a friendlier label beside it. */
const ENUM_TYPES = Object.freeze(["enum", "status", "boolean"]);

/** Roles that must declare themselves high-cardinality. */
const ALWAYS_HIGH_CARDINALITY = Object.freeze(["identifier", "text"]);

const isPeriod = (semanticType) => PERIOD_TYPES.includes(semanticType);
const isEnum = (semanticType) => ENUM_TYPES.includes(semanticType);

/* ─────────────────────────────────────────────────────────────────────────── */
/* Validation                                                                 */
/* ─────────────────────────────────────────────────────────────────────────── */

class SemanticsError extends Error {
  constructor(fieldId, problem) {
    super(`Field "${fieldId}": ${problem}`);
    this.fieldId = fieldId;
    this.problem = problem;
  }
}

/**
 * Check one field's semantic block, or refuse to start.
 *
 * Called while the catalogue module is being built, so a mistake here is a
 * `require` that throws: every test file fails and the server does not boot.
 * That is the intended blast radius — the alternative is a field that renders
 * as something it is not, in one report, for one customer, months later.
 */
function assertSemantics(field) {
  const { id, type, semanticType, display, chart, calculations, placements } = field;

  if (!SEMANTIC_TYPES.includes(semanticType)) {
    throw new SemanticsError(id, `"${semanticType}" is not a semantic type.`);
  }
  if (!display || typeof display !== "object") {
    throw new SemanticsError(id, "display metadata is missing.");
  }
  if (!DISPLAY_FORMATS.includes(display.format)) {
    throw new SemanticsError(id, `"${display.format}" is not a display format.`);
  }
  if (!SORT_MODES.includes(display.sort)) {
    throw new SemanticsError(id, `"${display.sort}" is not a sort mode.`);
  }
  if (!chart || !CHART_ROLES.includes(chart.role)) {
    throw new SemanticsError(id, `"${chart && chart.role}" is not a chart role.`);
  }

  /* A measure is what a chart MEASURES; it is never what the chart groups by,
     so a grouping priority on one is a statement nobody can act on. */
  if (chart.role === "measure" && chart.defaultGroupingPriority !== undefined) {
    throw new SemanticsError(id, "a measure cannot have a grouping priority.");
  }
  if (chart.role !== "measure") {
    if (!Number.isInteger(chart.defaultGroupingPriority)
        || chart.defaultGroupingPriority < 0 || chart.defaultGroupingPriority > 100) {
      throw new SemanticsError(id, "a grouping priority must be an integer from 0 to 100.");
    }
    if (typeof chart.highCardinality !== "boolean") {
      throw new SemanticsError(id, "highCardinality must be declared true or false.");
    }
  }

  /* An identifier or a line of free text has as many distinct values as there
     are rows. Charting one produces a thousand bars, so the catalogue must say
     so rather than leave a client to find out. */
  if (ALWAYS_HIGH_CARDINALITY.includes(chart.role) && chart.highCardinality !== true) {
    throw new SemanticsError(id, `a ${chart.role} must be marked high-cardinality.`);
  }

  /* "Apr, Aug, Dec" is what an alphabetical sort does to months. A format that
     prints a period must be ordered as a period. */
  if (CHRONOLOGICAL_FORMATS.includes(display.format) && display.sort !== "chronological") {
    throw new SemanticsError(id, `${display.format} must be sorted chronologically.`);
  }

  /* `text_exact` exists to protect `00531`. A field formatted that way must be
     text and must not be summable, or something downstream will turn it into
     531 and it will stop naming the voucher it names. */
  if (display.format === "text_exact") {
    if (type !== "text") throw new SemanticsError(id, "text_exact belongs to a text field.");
    if ((calculations || []).length) {
      throw new SemanticsError(id, "text_exact must not be calculable.");
    }
    if ((placements || []).includes("values")) {
      throw new SemanticsError(id, "text_exact must not be a value.");
    }
  }

  if (isPeriod(semanticType) && display.sort !== "chronological") {
    throw new SemanticsError(id, "a period must be sorted chronologically.");
  }
  if (semanticType === "currency" || semanticType === "currency_signed") {
    if (display.format !== "currency_inr") {
      throw new SemanticsError(id, "money is formatted as currency.");
    }
    if (chart.role !== "measure") throw new SemanticsError(id, "money is a measure.");
  }
  return field;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Keys and labels                                                            */
/* ─────────────────────────────────────────────────────────────────────────── */

const MONTH_NAMES = Object.freeze([
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]);

/**
 * The calendar date inside an engine value, as characters.
 *
 * `2025-07-01T00:00:00+05:30` → `"2025-07-01"`. No `Date`, no timezone, no
 * chance of the first of the month becoming the last of the one before.
 * A `Date` instance is accepted defensively and read in UTC, which is what the
 * driver produced it from; the engine sends strings.
 */
function isoDatePart(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? match[0] : null;
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  return null;
}

/** The stable, sortable key for a period value. Null stays null. */
function periodKey(semanticType, value) {
  if (value === null || value === undefined || value === "") return null;

  if (semanticType === "financial_year") {
    /* The stored label IS the key: `2025-26`. It is already sortable as text
       because the century is in it. */
    return String(value);
  }

  const date = isoDatePart(value);
  if (!date) return null;
  if (semanticType === "month") return date.slice(0, 7);          // 2025-07
  if (semanticType === "quarter") {
    const month = Number(date.slice(5, 7));
    return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`;
  }
  return date;                                                     // 2025-07-01
}

/**
 * What a period says on screen.
 *
 * A month is "July 2025" — never "01 Jul 2025", which is the defect this slice
 * exists to remove. A financial year keeps a plain key and gains an en dash
 * for reading. A date is written the long way, because a report column is not
 * a form field.
 */
function periodText(semanticType, value) {
  if (value === null || value === undefined || value === "") return null;

  if (semanticType === "financial_year") {
    const key = String(value);
    return key.replace(/^(\d{4})\s*-\s*(\d{2,4})$/, "$1–$2");
  }

  const date = isoDatePart(value);
  if (!date) return String(value);
  const [y, m, d] = date.split("-");
  const month = MONTH_NAMES[Number(m) - 1];
  if (semanticType === "month") return `${month} ${y}`;
  if (semanticType === "quarter") return `Q${Math.floor((Number(m) - 1) / 3) + 1} ${y}`;
  return `${Number(d)} ${month} ${y}`;
}

/**
 * The friendly label for a coded value, from the catalogue's own choices.
 *
 * A value nobody has declared is shown AS IT IS STORED rather than hidden or
 * invented: a voucher type the product added last week must still be readable
 * in a report built today, and a made-up label would be a lie about the books.
 */
function enumText(choices, value) {
  if (value === null || value === undefined || value === "") return null;
  const found = (choices || []).find((c) => String(c.value) === String(value));
  return found ? found.label : String(value);
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Derived semantics: what a CALCULATED column means                          */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The semantics of a value column.
 *
 * Read from the FIELD and the CALCULATION, never from the generated heading —
 * "Count of Debit" is a sentence, and deciding what a column means by reading
 * a sentence is how a count ends up formatted as rupees.
 */
function calculationSemantics(field, calculation) {
  if (calculation === "count") {
    return { semanticType: "count", display: { format: "integer", sort: "numeric" } };
  }
  /* Every other calculation — total, average, minimum, maximum — returns a
     value in the same unit as the field it was calculated from. A minimum
     debit is a debit. */
  return {
    semanticType: field.semanticType,
    display: { format: field.display.format, sort: field.display.sort },
  };
}

/**
 * The semantics of a comparison column.
 *
 * A percentage difference is a PERCENTAGE — a number out of a hundred, not
 * rupees — and says so, so nothing has to notice the "%" in its heading. A
 * difference and a side-by-side figure are in the unit they compare.
 */
function comparisonSemantics(field, comparison, calculation) {
  if (comparison.display === "percentage_difference") {
    return { semanticType: "percentage", display: { format: "percent", sort: "numeric" } };
  }
  return calculationSemantics(field, calculation);
}

/** The public semantic block for a field: exactly what a client may read. */
function publicSemantics(field) {
  const out = {
    semanticType: field.semanticType,
    display: { format: field.display.format, sort: field.display.sort },
  };
  if (field.chart) {
    out.chart = {
      role: field.chart.role,
      ...(field.chart.defaultGroupingPriority === undefined
        ? {}
        : { defaultGroupingPriority: field.chart.defaultGroupingPriority }),
      ...(field.chart.highCardinality === undefined
        ? {}
        : { highCardinality: field.chart.highCardinality }),
    };
  }
  return out;
}

module.exports = {
  ALWAYS_HIGH_CARDINALITY,
  CHART_ROLES,
  CHRONOLOGICAL_FORMATS,
  DISPLAY_FORMATS,
  ENUM_TYPES,
  MONTH_NAMES,
  PERIOD_TYPES,
  SEMANTIC_TYPES,
  SORT_MODES,
  SemanticsError,
  assertSemantics,
  calculationSemantics,
  comparisonSemantics,
  enumText,
  isEnum,
  isPeriod,
  isoDatePart,
  periodKey,
  periodText,
  publicSemantics,
};
