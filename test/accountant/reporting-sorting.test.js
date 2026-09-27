// test/accountant/reporting-sorting.test.js
//
// SLICE B3: A REPORT COMES BACK IN THE ORDER IT ASKED FOR.
//
// The audit found `sort` accepted, stored, compiled into MBQL — and then undone
// by the matrix, which rebuilt the groups ascending whatever the report said.
// Ascending and descending returned the same rows in the same order, and "top
// ledgers by debit" came back alphabetically.
//
// What is pinned here is the whole rule set, because sorting is the kind of
// behaviour where one case works and the others quietly do not:
//
//   · a dimension sorts in the direction asked for, by its SEMANTIC KEY;
//   · a measure sorts by the calculated figure, not by the field's name;
//   · nesting stays whole — groups do not interleave and subtotals stay with
//     the rows they describe;
//   · ties break the same way twice;
//   · blanks stay last in both directions;
//   · and the query carries the same order, so the sheet, the workbook and the
//     chart agree.
//
// The last block mutates the real modules and requires these tests to die.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const catalogue = require("../../services/reporting/fieldCatalogue");
const matrix = require("../../services/reporting/matrix");
const { compilePlan, compileChartQuery } = require("../../services/reporting/mbqlCompiler");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");

const ORG = "6a073de21fecacc9bb714481";
const CO = "6a08040a1fecacc9bb7149c2";
const RESOLVED = {
  databaseId: 2,
  tableId: 200,
  fieldIds: Object.fromEntries(
    [...catalogue.FIELDS.map((f) => f.column), "organization_id", "company_id"]
      .map((column, i) => [column, 8000 + i]),
  ),
};

const layout = (raw) => validateLayout({ name: "t", companyIds: [CO], ...raw },
  { approvedCompanyIds: [CO] });

const shape = (l, results, over = {}) => matrix.shapeSummary({
  layout: l, results, comparisonResults: [], dataAsOf: null, limit: 100, ...over,
});

const dataLabels = (m) => m.rows.filter((r) => r.kind === "data").map((r) => r.labels[0]);
const dataKeys = (m) => m.rows.filter((r) => r.kind === "data").map((r) => r.keys[0]);
const dataValues = (m) => m.rows.filter((r) => r.kind === "data").map((r) => r.cells[0].value);
const orderOf = (l) => compilePlan({
  layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 100,
}).main.query["order-by"];

/* ═══════════════════════════════════════════════════════════════════════════
 * Dimensions
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a dimension sorts in the direction it was asked for", () => {
  const GROUPS = { main: [["Bank Accounts", 2], ["Administrative Expenses", 1], ["Sundry Debtors", 3]] };
  const byGroup = (direction) => layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    ...(direction ? { sort: [{ field: "ledger.group", direction }] } : {}),
  });

  test("LEDGER GROUP ASCENDING AND DESCENDING ARE REVERSES OF ONE ANOTHER", () => {
    const asc = dataLabels(shape(byGroup("asc"), GROUPS));
    const desc = dataLabels(shape(byGroup("desc"), GROUPS));
    expect(asc).toEqual(["Administrative Expenses", "Bank Accounts", "Sundry Debtors"]);
    expect(desc).toEqual([...asc].reverse());
  });

  test("no sort at all still means ascending", () => {
    expect(dataLabels(shape(byGroup(null), GROUPS)))
      .toEqual(["Administrative Expenses", "Bank Accounts", "Sundry Debtors"]);
  });

  test("and the query says the same thing", () => {
    expect(orderOf(byGroup("desc"))).toEqual([["desc", ["field", RESOLVED.fieldIds.group_name, null]]]);
    expect(orderOf(byGroup("asc"))).toEqual([["asc", ["field", RESOLVED.fieldIds.group_name, null]]]);
  });
});

describe("periods sort by their key, across a year boundary", () => {
  const MONTHS = { main: [
    ["2026-01-01T00:00:00+05:30", 10],
    ["2025-12-01T00:00:00+05:30", 20],
    ["2026-02-01T00:00:00+05:30", 30],
  ] };
  const byMonth = (direction) => layout({
    rows: [{ field: "date.month" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    ...(direction ? { sort: [{ field: "date.month", direction }] } : {}),
  });

  test("DECEMBER → JANUARY ASCENDING", () => {
    const m = shape(byMonth("asc"), MONTHS);
    expect(dataKeys(m)).toEqual(["2025-12", "2026-01", "2026-02"]);
    expect(dataLabels(m)).toEqual(["December 2025", "January 2026", "February 2026"]);
  });

  test("AND THE SAME MONTHS DESCENDING", () => {
    const m = shape(byMonth("desc"), MONTHS);
    expect(dataKeys(m)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(dataLabels(m)).toEqual(["February 2026", "January 2026", "December 2025"]);
  });

  test("THE ORDER COMES FROM THE KEY, NOT FROM THE LABEL", () => {
    /* Alphabetically the labels are April, August, December, February… — the
       giveaway that a formatted string became the sort key. */
    const m = shape(byMonth("asc"), { main: [
      ["2026-04-01", 1], ["2026-08-01", 2], ["2026-12-01", 3], ["2026-02-01", 4],
    ] });
    expect(dataKeys(m)).toEqual(["2026-02", "2026-04", "2026-08", "2026-12"]);
    expect(dataLabels(m)[0]).toBe("February 2026");
  });

  test("a financial year sorts by its key", () => {
    const l = layout({
      rows: [{ field: "date.financial_year" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "date.financial_year", direction: "desc" }],
    });
    const m = shape(l, { main: [["2025-26", 1], ["2026-27", 2], ["2024-25", 3]] });
    expect(dataKeys(m)).toEqual(["2026-27", "2025-26", "2024-25"]);
    expect(dataLabels(m)).toEqual(["2026–27", "2025–26", "2024–25"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Measures
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a measure sorts by the figure", () => {
  const FIGURES = { main: [["Administrative Expenses", 1], ["Sundry Debtors", 3], ["Bank Accounts", 2]] };
  const byDebit = (direction) => layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    sort: [{ field: "amount.debit", direction }],
  });

  test("TOTAL DEBIT DESCENDING IS THE TOP LEDGERS, NOT THE ALPHABET", () => {
    const m = shape(byDebit("desc"), FIGURES);
    expect(dataValues(m)).toEqual([3, 2, 1]);
    expect(dataLabels(m)).toEqual(["Sundry Debtors", "Bank Accounts", "Administrative Expenses"]);
  });

  test("and ascending is its reverse", () => {
    expect(dataValues(shape(byDebit("asc"), FIGURES))).toEqual([1, 2, 3]);
  });

  test("A COUNT SORTS BY THE COUNT", () => {
    const l = layout({
      rows: [{ field: "voucher.type" }],
      values: [{ field: "amount.debit", calculation: "count" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const m = shape(l, { main: [["sales", 7], ["contra", 28], ["journal", 2]] });
    expect(dataValues(m)).toEqual([28, 7, 2]);
    expect(dataLabels(m)).toEqual(["Contra", "Sales", "Journal"]);
    expect(dataValues(shape({ ...l, sort: [{ field: l.sort[0].field, direction: "asc" }] },
      { main: [["sales", 7], ["contra", 28], ["journal", 2]] }))).toEqual([2, 7, 28]);
  });

  test("the measure reaches the query, ahead of the level it orders", () => {
    expect(orderOf(byDebit("desc"))).toEqual([
      ["desc", ["aggregation", 0]],
      ["asc", ["field", RESOLVED.fieldIds.group_name, null]],
    ]);
  });

  test("THE SECOND VALUE OF THE SAME FIELD IS DOCUMENTED, NOT GUESSED", () => {
    /* Values may hold `Total of Debit` beside `Average of Debit`, and a sort
       names only a field. The FIRST entry for that field is the one meant —
       the same rule in the matrix and in the compiler, so they cannot drift. */
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [
        { field: "amount.debit", calculation: "total" },
        { field: "amount.debit", calculation: "average" },
      ],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    expect(orderOf(l)[0]).toEqual(["desc", ["aggregation", 0]]);
    const m = shape(l, { main: [["A", 1, 900], ["B", 5, 1], ["C", 3, 500]] });
    // Ordered by the TOTAL (the first value), not by the average.
    expect(dataLabels(m)).toEqual(["B", "C", "A"]);
  });

  test("a measure with no row total to read leaves the dimension order alone", () => {
    /* A pivot with row totals switched off has no per-row figure, and this
       file does not add the cells up to invent one. */
    const l = layout({
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
      showRowTotals: false,
    });
    const m = shape(l, { main: [["B", "2026-01-01", 5], ["A", "2026-01-01", 1]] });
    expect(dataLabels(m)).toEqual(["A", "B"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Ties, blanks, nesting, columns
 * ══════════════════════════════════════════════════════════════════════════ */

describe("ties, blanks and structure", () => {
  test("EQUAL FIGURES BREAK ON THE LEVEL'S OWN KEY, AND DO SO TWICE", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const results = { main: [["Zeta", 100], ["Alpha", 100], ["Mid", 100]] };
    const once = dataLabels(shape(l, results));
    const again = dataLabels(shape(l, { main: [...results.main].reverse() }));
    expect(once).toEqual(["Alpha", "Mid", "Zeta"]);
    expect(again).toEqual(once);
  });

  test("A BLANK GROUP STAYS LAST IN BOTH DIRECTIONS", () => {
    const l = (direction) => layout({
      rows: [{ field: "party.name" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "party.name", direction }],
    });
    const results = { main: [["Zeta", 1], [null, 99], ["Acme", 2]] };
    expect(dataLabels(shape(l("asc"), results))).toEqual(["Acme", "Zeta", "(none)"]);
    expect(dataLabels(shape(l("desc"), results))).toEqual(["Zeta", "Acme", "(none)"]);
    expect(dataKeys(shape(l("desc"), results)).at(-1)).toBeNull();
  });

  test("A BLANK TAKES ITS FIGURE'S PLACE WHEN A MEASURE DECIDES THE ORDER", () => {
    /* The other half of the rule, and deliberately not the same: an absence
       has no alphabetical position, but it does have a total. The 1,781 lines
       with no party are a real ₹ figure, and a report asked to rank by debit
       that moved the biggest number to the bottom would hide the most
       interesting fact on the screen. */
    const l = layout({
      rows: [{ field: "party.name" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const m = shape(l, { main: [["Acme", 1], [null, 99], ["Zeta", 5]] });
    expect(dataLabels(m)).toEqual(["(none)", "Zeta", "Acme"]);
    expect(dataKeys(m)[0]).toBeNull();
    expect(dataValues(m)).toEqual([99, 5, 1]);
  });

  test("NESTED GROUPS STAY WHOLE, AND SUBTOTALS STAY WITH THEM", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const m = shape(l, {
      main: [
        ["Bank Accounts", "HDFC", 10], ["Bank Accounts", "ICICI", 30],
        ["Assets", "Land", 20], ["Assets", "Buildings", 5],
      ],
      subtotals: [{ depth: 0, prefix: [l.rows[0].field],
                    cells: [["Bank Accounts", 40], ["Assets", 25]], total: null }],
    });

    /* The outer level keeps its own (ascending) order, the measure orders the
       ledgers INSIDE each group, and each subtotal closes the group above it. */
    expect(m.rows.map((r) => [r.kind, r.labels[1] || r.labels[0]])).toEqual([
      ["data", "Land"], ["data", "Buildings"], ["subtotal", "Assets total"],
      ["data", "ICICI"], ["data", "HDFC"], ["subtotal", "Bank Accounts total"],
    ]);
    // Every data row sits under its own group.
    for (const row of m.rows.filter((r) => r.kind === "data")) {
      expect(["Assets", "Bank Accounts"]).toContain(row.labels[0]);
    }
  });

  test("an outer level can be sorted while the inner one is not", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "ledger.group", direction: "desc" }],
    });
    const m = shape(l, { main: [
      ["Assets", "Land", 1], ["Bank Accounts", "ICICI", 2], ["Bank Accounts", "HDFC", 3],
    ] });
    expect(m.rows.filter((r) => r.kind === "data").map((r) => r.labels))
      .toEqual([["Bank Accounts", "HDFC"], ["Bank Accounts", "ICICI"], ["Assets", "Land"]]);
  });

  test("A COLUMN AXIS IS ALWAYS CHRONOLOGICAL, whatever the rows do", () => {
    /* The contract lets a report sort its rows and its values, never its
       columns — so months across the top are in order in every report. */
    const l = layout({
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const m = shape(l, {
      main: [
        ["A", "2026-01-01", 1], ["A", "2025-12-01", 2],
        ["B", "2026-01-01", 9], ["B", "2025-12-01", 1],
      ],
      rowTotals: [["A", 3], ["B", 10]],
    });
    const level = m.columnLevels.find((x) => x.heading === "Month");
    expect(level.headers.map((h) => h.label).slice(0, 2)).toEqual(["December 2025", "January 2026"]);
    // …while the rows follow the figure.
    expect(dataLabels(m)).toEqual(["B", "A"]);
  });

  test("the total row and the grand total are not sorted into the report", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const m = shape(l, {
      main: [["A", 1], ["B", 9]],
      colTotals: [[10]], grand: [[10]],
    });
    expect(m.rows.map((r) => r.kind)).toEqual(["data", "data", "total"]);
    expect(m.rows.at(-1).labels[0]).toBe("Total");
    expect(m.grandTotal.labels[0]).toBe("Grand total");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Everything that renders the same report agrees
 * ══════════════════════════════════════════════════════════════════════════ */

describe("preview, export and chart agree", () => {
  const sorted = layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    sort: [{ field: "amount.debit", direction: "desc" }],
  });

  test("THE EXPORT RUNS THE PREVIEW'S OWN QUERY, ORDER INCLUDED", () => {
    const plan = compilePlan({ layout: sorted, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 100 });
    // The workbook is built from `plan.main` — the same object, so the same order.
    expect(plan.main.query["order-by"]).toEqual([
      ["desc", ["aggregation", 0]],
      ["asc", ["field", RESOLVED.fieldIds.group_name, null]],
    ]);
  });

  test("and the chart's single question carries it too", () => {
    const chart = compileChartQuery({
      layout: sorted, resolved: RESOLVED, organizationId: ORG, companyIds: [CO],
    });
    expect(chart.query["order-by"]).toEqual([
      ["desc", ["aggregation", 0]],
      ["asc", ["field", RESOLVED.fieldIds.group_name, null]],
    ]);
  });

  test("a comparison chart falls back to the dimension order, and says so", () => {
    /* A comparison query rebuilds its aggregations as conditional ones, so
       `["aggregation", n]` would name a different figure. */
    const withComparison = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
      filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const chart = compileChartQuery({
      layout: withComparison, resolved: RESOLVED, organizationId: ORG, companyIds: [CO],
    });
    expect(JSON.stringify(chart.query["order-by"])).not.toContain("aggregation");
    expect(chart.query["order-by"]).toEqual([["asc", ["field", RESOLVED.fieldIds.group_name, null]]]);
  });

  test("A SAVED LAYOUT KEEPS ITS SORT THROUGH A ROUND TRIP", () => {
    const { toStoredLayout } = require("../../services/reporting/reportLayout.validate");
    const stored = toStoredLayout(sorted);
    expect(stored.sort).toEqual([{ field: "amount.debit", direction: "desc" }]);

    const reopened = validateLayout(
      { ...stored, name: "t", companyIds: [CO] }, { approvedCompanyIds: [CO] },
    );
    expect(reopened.sort).toHaveLength(1);
    expect(reopened.sort[0].field.id).toBe("amount.debit");
    expect(reopened.sort[0].direction).toBe("desc");
    // And it still orders the same way after being reopened.
    expect(dataValues(shape(reopened, { main: [["A", 1], ["B", 9]] }))).toEqual([9, 1]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Mutation: would any of this notice?
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the ordering is load-bearing", () => {
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

  const GROUPS = { main: [["Bank Accounts", 2], ["Administrative Expenses", 1], ["Sundry Debtors", 3]] };
  const byGroupDesc = layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    sort: [{ field: "ledger.group", direction: "desc" }],
  });
  const byDebitDesc = layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    sort: [{ field: "amount.debit", direction: "desc" }],
  });

  test("IGNORING THE DIRECTION FAILS", () => {
    const assertDescending = (m) => {
      const shaped = m.shapeSummary({ layout: byGroupDesc, results: GROUPS,
        comparisonResults: [], dataAsOf: null, limit: 100 });
      expect(shaped.rows.filter((r) => r.kind === "data").map((r) => r.labels[0]))
        .toEqual(["Sundry Debtors", "Bank Accounts", "Administrative Expenses"]);
    };
    survives(() => assertDescending(matrix));
    kills(() => assertDescending(mutate("matrix.js", [[
      `        return directionFor(rowFields[i]) === "desc" ? -c : c;`,
      `        return c;`,
    ]])));
  });

  test("REPLACING THE FIGURE WITH THE ALPHABET FAILS", () => {
    const assertByFigure = (m) => {
      const shaped = m.shapeSummary({ layout: byDebitDesc, results: GROUPS,
        comparisonResults: [], dataAsOf: null, limit: 100 });
      expect(shaped.rows.filter((r) => r.kind === "data").map((r) => r.cells[0].value))
        .toEqual([3, 2, 1]);
    };
    survives(() => assertByFigure(matrix));
    kills(() => assertByFigure(mutate("matrix.js", [[
      `      if (isDeepest && measureSort && measureValueOf) {`,
      `      if (false && isDeepest && measureSort && measureValueOf) {`,
    ]])));
  });

  test("SORTING PERIODS BY THEIR DISPLAY TEXT FAILS", () => {
    const assertChronological = (m) => {
      const l = layout({
        rows: [{ field: "date.month" }],
        values: [{ field: "amount.debit", calculation: "total" }],
      });
      const shaped = m.shapeSummary({
        layout: l,
        results: { main: [["2026-04-01", 1], ["2026-02-01", 2], ["2026-12-01", 3]] },
        comparisonResults: [], dataAsOf: null, limit: 100,
      });
      expect(shaped.rows.filter((r) => r.kind === "data").map((r) => r.keys[0]))
        .toEqual(["2026-02", "2026-04", "2026-12"]);
    };
    survives(() => assertChronological(matrix));
    kills(() => assertChronological(mutate("matrix.js", [[
      `    const ka = semantics.periodKey(field.semanticType, a);
    const kb = semantics.periodKey(field.semanticType, b);`,
      `    const ka = semantics.periodText(field.semanticType, a);
    const kb = semantics.periodText(field.semanticType, b);`,
    ]])));
  });

  test("REMOVING THE TIE-BREAK FAILS", () => {
    const assertStableTies = (m) => {
      const l = layout({
        rows: [{ field: "ledger.group" }],
        values: [{ field: "amount.debit", calculation: "total" }],
        sort: [{ field: "amount.debit", direction: "desc" }],
      });
      const forward = m.shapeSummary({ layout: l, results: { main: [["Zeta", 100], ["Alpha", 100]] },
        comparisonResults: [], dataAsOf: null, limit: 100 });
      const reversed = m.shapeSummary({ layout: l, results: { main: [["Alpha", 100], ["Zeta", 100]] },
        comparisonResults: [], dataAsOf: null, limit: 100 });
      const labels = (x) => x.rows.filter((r) => r.kind === "data").map((r) => r.labels[0]);
      expect(labels(forward)).toEqual(["Alpha", "Zeta"]);
      expect(labels(reversed)).toEqual(labels(forward));
    };
    survives(() => assertStableTies(matrix));
    /* With the tie-break gone, equal figures keep whatever order the engine
       happened to return — so the same report renders two different ways. */
    kills(() => assertStableTies(mutate("matrix.js", [[
      `          if (c !== 0) return measureSort.direction === "desc" ? -c : c;
          // Equal figures: fall through to the level's own key, then onwards.`,
      `          return measureSort.direction === "desc" ? -c : c;`,
    ]])));
  });

  test("DROPPING THE MEASURE FROM THE QUERY FAILS", () => {
    const assertQueryOrdered = (compiler) => {
      const plan = compiler.compilePlan({ layout: byDebitDesc, resolved: RESOLVED,
        organizationId: ORG, companyIds: [CO], limit: 100 });
      expect(plan.main.query["order-by"][0]).toEqual(["desc", ["aggregation", 0]]);
    };
    survives(() => assertQueryOrdered(require("../../services/reporting/mbqlCompiler")));
    kills(() => assertQueryOrdered(mutate("mbqlCompiler.js", [[
      `  const out = measure && aggregationIndex !== -1`,
      `  const out = false && measure && aggregationIndex !== -1`,
    ]])));
  });
});
