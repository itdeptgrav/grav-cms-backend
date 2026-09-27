// test/accountant/reporting-semantics.test.js
//
// SLICES B1 AND B2: WHAT EVERY FIELD MEANS, AND WHERE THAT MEANING TRAVELS.
//
// The audit found the browser inferring "this is a month" from the English
// word "Month", and a month cell carrying nothing but an engine timestamp. The
// contract now says both things outright. These tests are the contract:
//
//   · every field has a semantic type, a display format and a sort mode, all
//     from closed vocabularies, and the vocabularies are checked when the
//     catalogue is BUILT so a typo cannot reach a user;
//   · the invariants hold — a measure is not grouped by, an identifier is
//     high-cardinality, a period sorts chronologically, `text_exact` is never
//     calculable;
//   · a period cell carries a raw value, a timezone-free key and the sentence
//     to show, and a summary row carries keys beside its labels;
//   · a calculated column knows what it is WITHOUT anybody reading its
//     heading;
//   · nothing private travels with any of it.
//
// The last block mutates the real modules and asserts the tests above die —
// because a metadata test that would pass with the metadata removed is
// decoration.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const catalogue = require("../../services/reporting/fieldCatalogue");
const semantics = require("../../services/reporting/semantics");
const matrix = require("../../services/reporting/matrix");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");

const CO = "6a08040a1fecacc9bb7149c2";
const layout = (raw) => validateLayout({ name: "t", companyIds: [CO], ...raw },
  { approvedCompanyIds: [CO] });
const publicFields = () => catalogue.publicCatalogue().fields;

/* ═══════════════════════════════════════════════════════════════════════════
 * The catalogue
 * ══════════════════════════════════════════════════════════════════════════ */

describe("every field declares what it means", () => {
  test("semantic type, display format and sort are present and on the list", () => {
    for (const f of publicFields()) {
      expect([f.id, semantics.SEMANTIC_TYPES.includes(f.semanticType)]).toEqual([f.id, true]);
      expect([f.id, semantics.DISPLAY_FORMATS.includes(f.display.format)]).toEqual([f.id, true]);
      expect([f.id, semantics.SORT_MODES.includes(f.display.sort)]).toEqual([f.id, true]);
      expect([f.id, semantics.CHART_ROLES.includes(f.chart.role)]).toEqual([f.id, true]);
    }
  });

  test("THE AUDIT'S MAPPING, FIELD BY FIELD", () => {
    const expected = {
      "company.name": ["company", "text", "alphabetical", "category", 20, false],
      "date.voucher": ["date", "day_month_year", "chronological", "temporal", 40, false],
      "date.month": ["month", "month_year", "chronological", "temporal", 30, false],
      "date.financial_year": ["financial_year", "financial_year", "chronological", "temporal", 25, false],
      "voucher.number": ["identifier", "text_exact", "natural", "identifier", 95, true],
      "voucher.type": ["enum", "choice_label", "alphabetical", "category", 35, false],
      "voucher.narration": ["free_text", "text", "alphabetical", "text", 99, true],
      "ledger.name": ["ledger", "text", "alphabetical", "category", 50, true],
      "ledger.group": ["ledger_group", "text", "alphabetical", "category", 10, false],
      "party.name": ["party", "text", "alphabetical", "category", 45, true],
      "amount.debit": ["currency", "currency_inr", "numeric", "measure", undefined, undefined],
      "amount.credit": ["currency", "currency_inr", "numeric", "measure", undefined, undefined],
      "amount.signed": ["currency_signed", "currency_inr", "numeric", "measure", undefined, undefined],
      "tax.classification": ["enum", "text", "alphabetical", "category", 60, false],
    };
    for (const f of publicFields()) {
      expect([f.id, f.semanticType, f.display.format, f.display.sort, f.chart.role,
              f.chart.defaultGroupingPriority, f.chart.highCardinality])
        .toEqual([f.id, ...expected[f.id]]);
    }
    expect(publicFields()).toHaveLength(Object.keys(expected).length);
  });

  test("A MEASURE IS NEVER GIVEN A GROUPING PRIORITY", () => {
    /* A measure is what a chart measures. A priority on one is an instruction
       nobody can follow, and a client that sorted its axes by it would put
       "Debit" on the x-axis. */
    for (const f of publicFields()) {
      if (f.chart.role !== "measure") continue;
      expect([f.id, f.chart.defaultGroupingPriority]).toEqual([f.id, undefined]);
      expect([f.id, f.chart.highCardinality]).toEqual([f.id, undefined]);
    }
  });

  test("AN IDENTIFIER OR A LINE OF FREE TEXT SAYS IT IS HIGH-CARDINALITY", () => {
    for (const f of publicFields()) {
      if (!["identifier", "text"].includes(f.chart.role)) continue;
      expect([f.id, f.chart.highCardinality]).toEqual([f.id, true]);
    }
  });

  test("a period is always sorted chronologically", () => {
    for (const f of publicFields()) {
      if (!semantics.PERIOD_TYPES.includes(f.semanticType)) continue;
      expect([f.id, f.display.sort]).toEqual([f.id, "chronological"]);
    }
    for (const f of publicFields()) {
      if (!semantics.CHRONOLOGICAL_FORMATS.includes(f.display.format)) continue;
      expect([f.id, f.display.sort]).toEqual([f.id, "chronological"]);
    }
  });

  test("`text_exact` is text and cannot be turned into a number", () => {
    for (const f of publicFields()) {
      if (f.display.format !== "text_exact") continue;
      expect([f.id, f.type]).toEqual([f.id, "text"]);
      expect([f.id, f.calculations]).toEqual([f.id, []]);
      expect([f.id, f.placements.includes("values")]).toEqual([f.id, false]);
    }
  });

  test("every grouping priority is a distinct, sane integer", () => {
    const priorities = publicFields()
      .filter((f) => f.chart.role !== "measure")
      .map((f) => f.chart.defaultGroupingPriority);
    for (const p of priorities) expect(Number.isInteger(p) && p >= 0 && p <= 100).toBe(true);
    // Distinct, so "which should a chart reach for first" always has one answer.
    expect(new Set(priorities).size).toBe(priorities.length);
    // The group a report is usually built on comes first.
    const lowest = publicFields().filter((f) => f.chart.role !== "measure")
      .sort((a, b) => a.chart.defaultGroupingPriority - b.chart.defaultGroupingPriority)[0];
    expect(lowest.id).toBe("ledger.group");
  });

  test("a bad vocabulary word is refused when the catalogue is BUILT", () => {
    const base = {
      id: "x.y", type: "text", calculations: [], placements: ["rows"],
      display: { format: "text", sort: "alphabetical" },
      chart: { role: "category", defaultGroupingPriority: 1, highCardinality: false },
      semanticType: "ledger",
    };
    const bad = [
      ["semantic type", { semanticType: "moonphase" }],
      ["display format", { display: { format: "hieroglyph", sort: "alphabetical" } }],
      ["sort mode", { display: { format: "text", sort: "vibes" } }],
      ["chart role", { chart: { role: "decoration", defaultGroupingPriority: 1, highCardinality: false } }],
      ["a measure with a priority", { semanticType: "currency", type: "money",
        display: { format: "currency_inr", sort: "numeric" },
        chart: { role: "measure", defaultGroupingPriority: 5 } }],
      ["an identifier that hides its cardinality", { semanticType: "identifier",
        display: { format: "text_exact", sort: "natural" },
        chart: { role: "identifier", defaultGroupingPriority: 90, highCardinality: false } }],
      ["a month sorted alphabetically", { semanticType: "month",
        display: { format: "month_year", sort: "alphabetical" },
        chart: { role: "temporal", defaultGroupingPriority: 1, highCardinality: false } }],
      ["a calculable text_exact", { semanticType: "identifier", calculations: ["count"],
        display: { format: "text_exact", sort: "natural" },
        chart: { role: "identifier", defaultGroupingPriority: 1, highCardinality: true } }],
    ];
    for (const [what, patch] of bad) {
      expect(() => semantics.assertSemantics({ ...base, ...patch }))
        .toThrow(semantics.SemanticsError);
    }
  });

  test("the reserved vocabulary is there for the fields that do not exist yet", () => {
    for (const word of ["quarter", "percentage", "quantity", "count", "gst_rate", "boolean", "status"]) {
      expect(semantics.SEMANTIC_TYPES).toContain(word);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The grain
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the catalogue says what one row is", () => {
  test("IT IS THERE, IT IS READABLE, AND IT EXPLAINS THE REPETITION", () => {
    const { grain } = catalogue.publicCatalogue();
    expect(grain.id).toBe("voucher_line");
    expect(grain.label).toBe("Voucher line");
    expect(grain.description).toMatch(/one ledger entry within a voucher/i);
    expect(grain.description).toMatch(/repeat/i);
    // An accountant's words: no grain, no fact, no view, no join, no row-level
    // security vocabulary.
    expect(grain.description.toLowerCase()).not.toMatch(
      /\b(grain|fact|dimension|view|join|table|mart|schema|sql)\b/,
    );
  });

  test("it names no source object", () => {
    const text = JSON.stringify(catalogue.publicCatalogue().grain);
    expect(text).not.toContain(catalogue.SOURCE_VIEW);
    expect(text).not.toMatch(/v_general_ledger|ledgerEntries|fact_voucher/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The matrix
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a detail matrix carries the meaning", () => {
  const shaped = () => {
    const l = layout({
      rows: [{ field: "date.month" }, { field: "date.voucher" }, { field: "date.financial_year" },
             { field: "voucher.type" }, { field: "amount.debit" }],
    });
    return matrix.shapeDetail({
      layout: l,
      rows: [["2025-07-01T00:00:00+05:30", "2025-07-17T00:00:00+05:30", "2025-26", "credit_note", 1200.5]],
      totalRowCount: 1,
      dataAsOf: null,
    });
  };

  test("every leaf column says what it is and how to show it", () => {
    for (const c of shaped().leafColumns) {
      expect(semantics.SEMANTIC_TYPES).toContain(c.semanticType);
      expect(semantics.DISPLAY_FORMATS).toContain(c.display.format);
      expect(semantics.SORT_MODES).toContain(c.display.sort);
      expect(c.type).toBeDefined();          // the old key, unchanged
    }
    expect(shaped().leafColumns.map((c) => c.semanticType))
      .toEqual(["month", "date", "financial_year", "enum", "currency"]);
  });

  test("EVERY PERIOD CELL HAS A VALUE, A KEY AND A SENTENCE", () => {
    const [month, date, fy, type, money] = shaped().rows[0].cells;

    expect(month).toEqual({ value: "2025-07-01T00:00:00+05:30", display: "date",
                            semanticType: "month", key: "2025-07", text: "July 2025" });
    expect(date).toEqual({ value: "2025-07-17T00:00:00+05:30", display: "date",
                           semanticType: "date", key: "2025-07-17", text: "17 July 2025" });
    expect(fy).toEqual({ value: "2025-26", display: "text",
                         semanticType: "financial_year", key: "2025-26", text: "2025–26" });
    expect(type).toEqual({ value: "credit_note", display: "choice",
                           semanticType: "enum", key: "credit_note", text: "Credit Note" });
    // A figure is a figure: no key, no text, nothing to misread.
    expect(money).toEqual({ value: 1200.5, display: "money", semanticType: "currency" });
  });

  test("A NULL PERIOD STAYS NULL — no period is invented", () => {
    const l = layout({ rows: [{ field: "date.financial_year" }, { field: "amount.debit" }] });
    const shapedNull = matrix.shapeDetail({
      layout: l, rows: [[null, 0]], totalRowCount: 1, dataAsOf: null });
    expect(shapedNull.rows[0].cells[0]).toEqual({
      value: null, display: "text", semanticType: "financial_year", key: null, text: null,
    });
  });

  test("an unknown coded value is shown as it is stored, not hidden", () => {
    const l = layout({ rows: [{ field: "voucher.type" }, { field: "amount.debit" }] });
    const m = matrix.shapeDetail({
      layout: l, rows: [["a_type_nobody_declared", 1]], totalRowCount: 1, dataAsOf: null });
    expect(m.rows[0].cells[0].value).toBe("a_type_nobody_declared");
    expect(m.rows[0].cells[0].text).toBe("a_type_nobody_declared");
  });
});

describe("a summary matrix carries the meaning", () => {
  const monthly = (rows) => {
    const l = layout({
      rows: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    return matrix.shapeSummary({ layout: l, results: { main: rows }, comparisonResults: [],
      dataAsOf: null, limit: 100 });
  };

  test("row levels say what they are", () => {
    const m = monthly([["2025-07-01T00:00:00+05:30", 1]]);
    expect(m.rowLevels[0]).toEqual({
      heading: "Month", semanticType: "month",
      display: { format: "month_year", sort: "chronological" },
      chart: { role: "temporal", defaultGroupingPriority: 30, highCardinality: false },
    });
  });

  test("SUMMARY ROWS CARRY KEYS BESIDE THEIR LABELS", () => {
    const m = monthly([
      ["2025-12-01T00:00:00+05:30", 1],
      ["2026-01-01T00:00:00+05:30", 2],
      ["2026-02-01T00:00:00+05:30", 3],
    ]);
    const data = m.rows.filter((r) => r.kind === "data");
    expect(data.map((r) => r.labels[0])).toEqual(["December 2025", "January 2026", "February 2026"]);
    expect(data.map((r) => r.keys[0])).toEqual(["2025-12", "2026-01", "2026-02"]);
    // Sorted by key, the order is the order on screen: chronological.
    expect([...data.map((r) => r.keys[0])].sort()).toEqual(data.map((r) => r.keys[0]));
  });

  test("keys line up with rowLevels, one for one, at every kind of row", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const m = matrix.shapeSummary({
      layout: l,
      results: {
        main: [["Bank Accounts", "HDFC", 1], ["Bank Accounts", "ICICI", 2]],
        subtotals: [{ depth: 0, prefix: [l.rows[0].field],
                      cells: [["Bank Accounts", 3]], total: null }],
        grand: [[3]],
      },
      comparisonResults: [], dataAsOf: null, limit: 100,
    });

    for (const row of m.rows) {
      expect(row.keys).toHaveLength(m.rowLevels.length);
      expect(row.labels).toHaveLength(m.rowLevels.length);
    }
    const subtotal = m.rows.find((r) => r.kind === "subtotal");
    // The label reads "… total"; the key is the group's own, so it still matches.
    expect(subtotal.labels[0]).toBe("Bank Accounts total");
    expect(subtotal.keys).toEqual(["Bank Accounts", null]);
    const total = m.rows.find((r) => r.kind === "total");
    if (total) expect(total.keys).toEqual([null, null]);
  });

  test("a coded group reads as its label and keys as its code", () => {
    const l = layout({
      rows: [{ field: "voucher.type" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const m = matrix.shapeSummary({
      layout: l, results: { main: [["credit_note", 5], ["sales", 7]] },
      comparisonResults: [], dataAsOf: null, limit: 100 });
    const data = m.rows.filter((r) => r.kind === "data");
    expect(data.map((r) => r.labels[0])).toEqual(["Credit Note", "Sales"]);
    expect(data.map((r) => r.keys[0])).toEqual(["credit_note", "sales"]);
  });

  test("a month column heading is the month's own sentence", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const m = matrix.shapeSummary({
      layout: l,
      results: { main: [["Bank Accounts", "2025-12-01T00:00:00+05:30", 1],
                        ["Bank Accounts", "2026-01-01T00:00:00+05:30", 2]] },
      comparisonResults: [], dataAsOf: null, limit: 100,
    });
    const level = m.columnLevels.find((x) => x.heading === "Month");
    // …plus the row-total column, which is not a month and is not labelled as one.
    expect(level.headers.map((h) => h.label)).toEqual(["December 2025", "January 2026", "Total"]);
  });
});

describe("a calculated column knows what it is without reading its heading", () => {
  const withValue = (field, calculation) => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field, calculation }],
    });
    return matrix.shapeSummary({ layout: l, results: { main: [["A", 1]] },
      comparisonResults: [], dataAsOf: null, limit: 100 }).leafColumns[0];
  };

  test("a total, average, minimum or maximum of money is money", () => {
    for (const calculation of ["total", "average", "minimum", "maximum"]) {
      expect([calculation, withValue("amount.debit", calculation).semanticType])
        .toEqual([calculation, "currency"]);
      expect([calculation, withValue("amount.signed", calculation).semanticType])
        .toEqual([calculation, "currency_signed"]);
    }
  });

  test("A COUNT IS A COUNT, however its column happens to be headed", () => {
    const leaf = withValue("amount.debit", "count");
    expect(leaf.semanticType).toBe("count");
    expect(leaf.display).toEqual({ format: "integer", sort: "numeric" });
    // The heading still says "Debit" — which is exactly why the semantics may
    // not be read off it.
    expect(leaf.heading).toMatch(/Debit/);
  });

  test("A PERCENTAGE COMPARISON SAYS IT IS A PERCENTAGE", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period",
                      display: "percentage_difference" }],
      filters: [{ field: "date.voucher", operation: "between",
                  value: ["2025-08-01", "2025-10-31"] }],
    });
    const m = matrix.shapeSummary({ layout: l, results: { main: [["A", 1]] },
      comparisonResults: [{ main: [["A", 2]] }], dataAsOf: null, limit: 100 });
    const comparison = m.leafColumns.find((c) => c.isComparison);
    expect(comparison.semanticType).toBe("percentage");
    expect(comparison.display).toEqual({ format: "percent", sort: "numeric" });
  });

  test("a difference and a side-by-side figure are in the unit they compare", () => {
    for (const [display, expected] of [["difference", "currency"], ["side_by_side", "currency"]]) {
      const l = layout({
        rows: [{ field: "ledger.group" }],
        values: [{ field: "amount.debit", calculation: "total" }],
        comparisons: [{ field: "amount.debit", mode: "previous_period", display }],
        filters: [{ field: "date.voucher", operation: "between",
                    value: ["2025-08-01", "2025-10-31"] }],
      });
      const m = matrix.shapeSummary({ layout: l, results: { main: [["A", 1]] },
        comparisonResults: [{ main: [["A", 2]] }], dataAsOf: null, limit: 100 });
      expect([display, m.leafColumns.find((c) => c.isComparison).semanticType])
        .toEqual([display, expected]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The boundary, and the old contract
 * ══════════════════════════════════════════════════════════════════════════ */

describe("nothing private travels with the meaning", () => {
  test("no source column, view or engine detail in the catalogue", () => {
    const text = JSON.stringify(catalogue.publicCatalogue());
    expect(text).not.toContain(catalogue.SOURCE_VIEW);
    for (const column of catalogue.allColumns()) {
      // `financial_year` is the concept's English name as well as a column's;
      // everything else must be absent.
      if (column === "financial_year") continue;
      expect(text).not.toContain(`"${column}"`);
    }
    for (const f of catalogue.publicCatalogue().fields) {
      expect(f).not.toHaveProperty("column");
      expect(f).not.toHaveProperty("temporalUnit");
    }
  });

  test("no source column or private key in a matrix", () => {
    const l = layout({
      rows: [{ field: "date.month" }],
      columns: [{ field: "voucher.type" }],
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const m = matrix.shapeSummary({
      layout: l, results: { main: [["2025-07-01", "sales", 1]] },
      comparisonResults: [], dataAsOf: null, limit: 100 });
    const text = JSON.stringify(m);
    for (const column of ["period_month", "voucher_type", "debit", "group_name", "v_general_ledger"]) {
      expect(text).not.toContain(`"${column}"`);
    }
    for (const c of m.leafColumns) {
      expect(Object.keys(c).some((k) => k.startsWith("_"))).toBe(false);
    }
  });

  test("THE OLD CONTRACT IS UNTOUCHED — type, value and headings all still there", () => {
    const pub = catalogue.publicCatalogue().fields;
    for (const f of pub) {
      for (const key of ["id", "label", "category", "type", "description", "placements",
                         "calculations", "filterOperations", "comparisons", "compatibleWith",
                         "choices", "defaultWidth"]) {
        expect([f.id, key, Object.hasOwn(f, key)]).toEqual([f.id, key, true]);
      }
    }
    const l = layout({ rows: [{ field: "date.month" }, { field: "amount.debit" }] });
    const m = matrix.shapeDetail({ layout: l, rows: [["2025-07-01T00:00:00+05:30", 5]],
      totalRowCount: 1, dataAsOf: null });
    // An existing client reads `value` and `display` and is unaffected.
    expect(m.rows[0].cells[0].value).toBe("2025-07-01T00:00:00+05:30");
    expect(m.rows[0].cells[0].display).toBe("date");
    expect(m.leafColumns[0].type).toBe("date");
    expect(m.leafColumns[0].heading).toBe("Month");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Mutation: would these tests notice if the meaning were removed?
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the semantic contract is load-bearing", () => {
  const SERVICES = path.join(__dirname, "..", "..", "services", "reporting");
  const written = [];

  const mutate = (file, edits) => {
    const source = fs.readFileSync(path.join(SERVICES, file), "utf8");
    let mutated = source;
    for (const [find, replace] of edits) {
      if (!mutated.includes(find)) {
        throw new Error(`Mutation target not found in ${file}:\n${find}\nThe code moved — re-point the mutation.`);
      }
      mutated = mutated.replace(find, replace);
    }
    expect(mutated).not.toBe(source);
    const target = path.join(SERVICES, `__mutant_${Date.now()}_${written.length}__.js`);
    fs.writeFileSync(target, mutated);
    written.push(target);
    return require(target);
  };

  afterAll(() => {
    for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  });

  const survives = (fn) => expect(fn).not.toThrow();
  const kills = (fn) => expect(fn).toThrow();

  test("REMOVING MONTH'S SEMANTIC TYPE FAILS", () => {
    const assertMonthIsAMonth = (cat) => {
      const month = cat.publicCatalogue().fields.find((f) => f.id === "date.month");
      expect(month.semanticType).toBe("month");
      expect(month.display.format).toBe("month_year");
    };
    survives(() => assertMonthIsAMonth(catalogue));
    kills(() => assertMonthIsAMonth(mutate("fieldCatalogue.js", [[
      `      semanticType: "month", display: PERIOD_DISPLAY.month,`,
      `      semanticType: "date", display: PERIOD_DISPLAY.date,`,
    ]])));
  });

  test("USING THE FORMATTED LABEL AS THE MONTH KEY FAILS", () => {
    /* The bug this catches: a key of "July 2025" sorts July before June and
       December before January, which is the defect the whole slice exists to
       remove — and it looks perfectly reasonable in a diff. */
    const assertKeysSortChronologically = (s) => {
      const keys = ["2025-12-01", "2026-01-01", "2026-02-01"].map((v) => s.periodKey("month", v));
      expect(keys).toEqual(["2025-12", "2026-01", "2026-02"]);
      expect([...keys].sort()).toEqual(keys);
    };
    survives(() => assertKeysSortChronologically(semantics));
    kills(() => assertKeysSortChronologically(mutate("semantics.js", [[
      `  if (semanticType === "month") return date.slice(0, 7);          // 2025-07`,
      `  if (semanticType === "month") return periodText("month", value);`,
    ]])));
  });

  test("TURNING A VOUCHER NUMBER INTO A NUMBER FAILS", () => {
    const assertVoucherNumberIsText = (m, cat) => {
      const field = cat.fieldOf("voucher.number");
      const l = validateLayout(
        { name: "t", companyIds: [CO], rows: [{ field: "voucher.number" }, { field: "amount.debit" }] },
        { approvedCompanyIds: [CO] },
      );
      const shaped = m.shapeDetail({ layout: l, rows: [["00531", 1]], totalRowCount: 1, dataAsOf: null });
      expect(field.type).toBe("text");
      expect(typeof shaped.rows[0].cells[0].value).toBe("string");
      expect(shaped.rows[0].cells[0].value).toBe("00531");
    };
    survives(() => assertVoucherNumberIsText(matrix, catalogue));

    const numericCell = mutate("matrix.js", [[
      `const cell = (value, display) => ({ value: value === undefined ? null : value, display });`,
      `const cell = (value, display) => ({ value: value === undefined ? null : (/^[0-9]+$/.test(String(value)) ? Number(value) : value), display });`,
    ]]);
    kills(() => assertVoucherNumberIsText(numericCell, catalogue));
  });

  test("LEAKING A SOURCE COLUMN THROUGH publicCatalogue FAILS", () => {
    const assertNoColumn = (cat) => {
      const text = JSON.stringify(cat.publicCatalogue());
      for (const column of cat.allColumns()) {
        if (column === "financial_year") continue;
        expect(text).not.toContain(`"${column}"`);
      }
    };
    survives(() => assertNoColumn(catalogue));
    kills(() => assertNoColumn(mutate("fieldCatalogue.js", [[
      `      ...semantics.publicSemantics(f),`,
      `      ...semantics.publicSemantics(f),\n      source: f.column,`,
    ]])));
  });

  test("REMOVING SUMMARY ROW KEYS FAILS", () => {
    const assertRowsHaveKeys = (m) => {
      const l = validateLayout({
        name: "t", companyIds: [CO],
        rows: [{ field: "date.month" }],
        values: [{ field: "amount.debit", calculation: "total" }],
      }, { approvedCompanyIds: [CO] });
      const shaped = m.shapeSummary({ layout: l, results: { main: [["2025-07-01", 1]] },
        comparisonResults: [], dataAsOf: null, limit: 100 });
      const row = shaped.rows.find((r) => r.kind === "data");
      expect(row.keys).toEqual(["2025-07"]);
    };
    survives(() => assertRowsHaveKeys(matrix));
    kills(() => assertRowsHaveKeys(mutate("matrix.js", [[
      `      keys: tuple.map((v, i) => semanticKey(v, rowFields[i])),`, ``,
    ]])));
  });
});
