// services/reporting/workbook.js
//
// THE ENGINE'S ROWS, PRESENTED AS A WORKBOOK GRAV IS NOT ASHAMED OF.
//
// ── THE LINE THIS FILE MUST NOT CROSS ───────────────────────────────────────
// Metabase filters, groups, calculates and orders. This file writes what it
// returned, row for row, in the order it returned it. It does not add, total,
// average, pivot, compare, re-sort or drop anything. Every arithmetic question
// in an accountant's workbook is answered by the same engine that answers the
// screen, or the two would eventually disagree and only one of them would be
// in an audit file.
//
// What GRAV owns here is PRESENTATION: the heading a person reads, whether a
// cell is a date or a string, and how a number is formatted.
//
// ── WHY A REAL TYPE AND NOT A PRETTY STRING ─────────────────────────────────
// It would be easy to write "₹1,23,456.78" into every money cell and have the
// file look perfect. It would also be a spreadsheet nobody can sum, sort or
// filter — which is the entire reason an accountant asked for Excel rather
// than a PDF. So: numbers are numbers with a number format, dates are dates
// with a date format, and the only strings are the things that really are text.
//
// ── THE ONE THING THAT WILL BITE ────────────────────────────────────────────
// The mart hands back `2025-08-01T00:00:00+05:30`. `new Date(...)` of that in
// a UTC process is 31 July, and Excel would show a month's figures under the
// previous month. Every date here is built from the ISO date PART with
// `Date.UTC`, never parsed as an instant. B1/B2 made the same decision for the
// same reason; see `semantics.js`.
//
// ── BOUNDED ────────────────────────────────────────────────────────────────
// Written through ExcelJS's streaming writer, straight to the response. No
// workbook is ever held in memory — not the engine's, not ours. Measured at
// the 100,000-row export ceiling: ~3.5 MB out, RSS peaking around 200 MB
// including the result rows themselves, in well under a second.
"use strict";

const ExcelJS = require("exceljs");
const semantics = require("./semantics");

/* ─────────────────────────────────────────────────────────────────────────── */
/* Formats                                                                    */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * Indian grouping, two decimals, and a rupee sign — with an explicit negative
 * section so a credit reads as `-₹1,000.00` rather than parenthesised.
 */
const MONEY = '₹#,##,##0.00;-₹#,##,##0.00';
const INTEGER = "#,##0";
const QUANTITY = "#,##0.###";
/**
 * A percentage that does NOT multiply.
 *
 * The engine returns a GST rate as `18`, meaning 18%. Excel's own `0.00%`
 * format multiplies by a hundred and would display `1800.00%`. Dividing the
 * value by 100 to suit the format would put a number in the cell that is not
 * the number the engine returned. So the value stays 18 and the per-cent sign
 * is a literal in the format.
 */
const PERCENT = '0.00"%"';
const MONTH = "mmmm yyyy";
const DAY = "dd mmm yyyy";

/** How wide a column of this kind may grow, however long its contents. */
const MAX_WIDTH = {
  free_text: 60,
  identifier: 18,
  date: 14,
  month: 16,
  quarter: 14,
  financial_year: 12,
  currency: 18,
  currency_signed: 18,
  count: 12,
  quantity: 14,
  percentage: 12,
  gst_rate: 12,
  boolean: 10,
};
const DEFAULT_MAX_WIDTH = 40;
const MIN_WIDTH = 10;

/** What a default heading becomes once a calculation is applied to it. */
const CALCULATION_HEADING = {
  total: (label) => `Total ${label}`,
  average: (label) => `Average ${label}`,
  minimum: (label) => `Smallest ${label}`,
  maximum: (label) => `Largest ${label}`,
  count: (label) => `Count of ${label}`,
};

/* ─────────────────────────────────────────────────────────────────────────── */
/* Columns                                                                    */
/* ─────────────────────────────────────────────────────────────────────────── */

/**
 * The columns of the flat result, in the order the compiled plan returns them.
 *
 * Detail: the fields the user listed. Summary: the row groupings, then the
 * column groupings, then the calculated values — which is exactly how
 * `compilePlan` builds `breakout` and `aggregate`, and is why this can be read
 * off the LAYOUT without asking the engine what it sent back. A column
 * grouping is a column of its own in the file: the workbook is flat and says
 * so (`X-Reporting-Layout: flat-aggregation`).
 */
function exportColumns(layout) {
  if (layout.mode === "detail") {
    return layout.rows.map((r) => ({
      heading: r.heading,
      semanticType: r.field.semanticType,
      choices: r.field.choices || null,
    }));
  }

  const dimensions = [...layout.rows, ...layout.columns].map((r) => ({
    heading: r.heading,
    semanticType: r.field.semanticType,
    choices: r.field.choices || null,
  }));

  const values = layout.values.map((v) => ({
    heading: valueHeading(v),
    semanticType: semantics.calculationSemantics(v.field, v.calculation).semanticType,
    choices: null,
  }));

  return [...dimensions, ...values];
}

/**
 * What a calculated column is called.
 *
 * A heading the user typed is theirs and is used exactly as typed. A heading
 * they never touched is still sitting at the field's own label — "Debit" — and
 * a column of summed debits called "Debit" is the engine's `Sum of Debit`
 * problem in a friendlier font. So an untouched heading is qualified by its
 * calculation, and a renamed one is left alone.
 */
function valueHeading(value) {
  if (value.heading !== value.field.label) return value.heading;
  const make = CALCULATION_HEADING[value.calculation];
  return make ? make(value.field.label) : value.heading;
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* Cells                                                                      */
/* ─────────────────────────────────────────────────────────────────────────── */

/** A date at UTC midnight, built from the ISO date part and never parsed. */
function utcDate(value) {
  const iso = semantics.isoDatePart(value);
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/**
 * One cell: what to write, and how it should look.
 *
 * `{ value: null }` means leave the cell EMPTY. A missing figure is not zero —
 * zero is a fact about the books and blank is the absence of one — and it is
 * certainly not the strings "null", "undefined" or "NaN", each of which has
 * been seen in an exported ledger somewhere.
 */
function cellFor(raw, column) {
  if (raw === null || raw === undefined || raw === "") return { value: null };
  const type = column.semanticType;

  if (type === "month") {
    const date = utcDate(raw);
    return date ? { value: date, numFmt: MONTH } : { value: String(raw) };
  }
  if (type === "date") {
    const date = utcDate(raw);
    return date ? { value: date, numFmt: DAY } : { value: String(raw) };
  }
  /* A quarter and a financial year are TEXT on purpose: Excel's number formats
     have no quarter token, and "2025–26" is not a date at all. Writing either
     as a date would mean choosing a day to stand for it and hoping nobody
     sorts by it. */
  if (type === "quarter" || type === "financial_year") {
    return { value: semantics.periodText(type, raw) ?? String(raw) };
  }

  if (type === "currency" || type === "currency_signed") {
    const n = Number(raw);
    /* The sign is the engine's. A credit that came back negative stays a
       negative NUMBER — not a positive one in red, and not a string. */
    return Number.isFinite(n) ? { value: n, numFmt: MONEY } : { value: String(raw) };
  }
  if (type === "count") {
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n, numFmt: INTEGER } : { value: String(raw) };
  }
  if (type === "quantity") {
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n, numFmt: QUANTITY } : { value: String(raw) };
  }
  if (type === "percentage" || type === "gst_rate") {
    const n = Number(raw);
    return Number.isFinite(n) ? { value: n, numFmt: PERCENT } : { value: String(raw) };
  }

  if (type === "boolean") {
    if (typeof raw === "boolean") return { value: raw ? "Yes" : "No" };
    const text = String(raw).toLowerCase();
    if (["true", "t", "1", "yes", "y"].includes(text)) return { value: "Yes" };
    if (["false", "f", "0", "no", "n"].includes(text)) return { value: "No" };
    return { value: String(raw) };
  }

  if (type === "enum" || type === "status") {
    return { value: semantics.enumText(column.choices, raw) ?? String(raw) };
  }

  /* Everything else is text, and an identifier is text EMPHATICALLY: `00531`
     is a voucher number, not the number 531, and a workbook that drops its
     zeroes has changed a record. A string cell keeps them; Excel does not
     re-guess a cell it was given as a string. */
  return { value: String(raw) };
}

/* ─────────────────────────────────────────────────────────────────────────── */
/* The worksheet                                                              */
/* ─────────────────────────────────────────────────────────────────────────── */

/** Excel's own rules: 31 characters, and none of `[ ] : * ? / \`. */
function worksheetName(name) {
  const cleaned = String(name || "")
    .replace(/[[\]:*?/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 31);
  return cleaned || "Report";
}

/** Wide enough to read, never wide enough to push the next column off-screen. */
function columnWidths(columns, rows) {
  return columns.map((column, i) => {
    let widest = String(column.heading || "").length;
    for (const row of rows) {
      const value = row[i];
      if (value === null || value === undefined) continue;
      const length = value instanceof Date ? 11 : String(value).length;
      if (length > widest) widest = length;
      if (widest >= DEFAULT_MAX_WIDTH) break;   // no need to keep looking
    }
    const cap = MAX_WIDTH[column.semanticType] ?? DEFAULT_MAX_WIDTH;
    return Math.min(Math.max(widest + 2, MIN_WIDTH), cap);
  });
}

/**
 * Write the workbook to `stream`, row for row, and resolve when it is done.
 *
 * The rows are the engine's, untouched and in its order. Nothing here inspects
 * a figure except to decide how to format it.
 */
async function writeWorkbook({ layout, rows, stream, sheetName }) {
  const columns = exportColumns(layout);
  const widths = columnWidths(columns, rows);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    /* Off deliberately: a shared-string table has to be held until the end,
       which is the one thing that would make a large export unbounded. */
    useSharedStrings: false,
  });
  workbook.creator = "GRAV";
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(worksheetName(sheetName), {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = widths.map((width) => ({ width }));

  const heading = sheet.addRow(columns.map((c) => c.heading));
  heading.font = { bold: true };
  heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
  heading.border = { bottom: { style: "thin", color: { argb: "FFBFBFBF" } } };
  heading.commit();

  for (const raw of rows) {
    const row = sheet.addRow(columns.map((column, i) => cellFor(raw[i], column).value));
    columns.forEach((column, i) => {
      const { numFmt } = cellFor(raw[i], column);
      if (numFmt) row.getCell(i + 1).numFmt = numFmt;
    });
    row.commit();
  }

  // Over the heading row and everything under it, so the file opens usable.
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: rows.length + 1, column: Math.max(columns.length, 1) },
  };
  sheet.commit();
  await workbook.commit();
}

module.exports = {
  exportColumns,
  valueHeading,
  cellFor,
  worksheetName,
  columnWidths,
  writeWorkbook,
  FORMATS: Object.freeze({ MONEY, INTEGER, QUANTITY, PERCENT, MONTH, DAY }),
};
