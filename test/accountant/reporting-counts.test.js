// test/accountant/reporting-counts.test.js
//
// SLICE B4: THE RESPONSE SAYS HOW MUCH OF THE REPORT IT IS SHOWING.
//
// The audit found a summary of 333 ledger groups returning 100 rows and
// answering `previewRowCount: 333` — "showing 333 of 333" — with no mention
// that 233 groups and 85% of the money were missing. A chart drawn from that
// response is not slightly wrong; it is a picture of a sixth of the business.
//
// What is pinned here:
//
//   · `previewRowCount` counts DATA rows that are actually in `rows`;
//   · `groupCount` counts every distinct group the filters match;
//   · `omitted.rows` is the difference, and `omitted.values` is what those
//     rows were worth, summed from the OMITTED rows themselves;
//   · the omitted set is the tail of the B3 order, so asc and desc drop
//     different groups and both still reconcile to the same complete total;
//   · subtotals are not rows, not groups and not omissions;
//   · signs survive, and a figure that cannot honestly be added — an average,
//     a percentage change — is `null` rather than a plausible number.
//
// The last block mutates the real module and requires these tests to die.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const matrix = require("../../services/reporting/matrix");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");

const CO = "6a08040a1fecacc9bb7149c2";

const layout = (raw) => validateLayout({ name: "t", companyIds: [CO], ...raw },
  { approvedCompanyIds: [CO] });

const shape = (l, results, over = {}) => matrix.shapeSummary({
  layout: l, results, comparisonResults: [], dataAsOf: null, limit: 100, ...over,
});

const dataRows = (m) => m.rows.filter((r) => r.kind === "data");
const visibleSum = (m, i) => dataRows(m).reduce((n, r) => n + Number(r.cells[i].value ?? 0), 0);

/** 333 ledger groups, each with a debit, a credit and a signed amount. */
const LEDGERS = Array.from({ length: 333 }, (_, i) => {
  const n = i + 1;
  return [`G${String(n).padStart(3, "0")}`, n * 1000, n * 10, n % 3 === 0 ? -n * 100 : n * 100];
});
const COMPLETE = {
  debit: LEDGERS.reduce((n, r) => n + r[1], 0),
  credit: LEDGERS.reduce((n, r) => n + r[2], 0),
  signed: LEDGERS.reduce((n, r) => n + r[3], 0),
};

const THREE_VALUES = [
  { field: "amount.debit", heading: "Debit", calculation: "total" },
  { field: "amount.credit", heading: "Credit", calculation: "total" },
  { field: "amount.signed", heading: "Signed", calculation: "total" },
];

/* ═══════════════════════════════════════════════════════════════════════════
 * The headline case, exactly as the audit found it
 * ══════════════════════════════════════════════════════════════════════════ */

describe("333 groups capped at 100", () => {
  const l = layout({ rows: [{ field: "ledger.group" }], values: THREE_VALUES, limit: 100 });
  const m = shape(l, { main: LEDGERS });

  test("PREVIEWROWCOUNT IS 100, GROUPCOUNT IS 333, OMITTED.ROWS IS 233", () => {
    expect(dataRows(m)).toHaveLength(100);
    expect(m.previewRowCount).toBe(100);
    expect(m.groupCount).toBe(333);
    expect(m.truncated).toBe(true);
    expect(m.omitted.rows).toBe(233);
  });

  test("RETURNED ROWS PLUS OMITTED ROWS IS THE COMPLETE GROUP COUNT", () => {
    expect(m.previewRowCount + m.omitted.rows).toBe(m.groupCount);
    expect(dataRows(m).length + m.omitted.rows).toBe(m.groupCount);
  });

  test("VISIBLE VALUE PLUS OMITTED VALUE IS THE COMPLETE VALUE, EVERY LEAF", () => {
    const complete = [COMPLETE.debit, COMPLETE.credit, COMPLETE.signed];
    m.leafColumns.forEach((leaf, i) => {
      expect(visibleSum(m, i) + m.omitted.values[leaf.id]).toBeCloseTo(complete[i], 6);
    });
  });

  test("DEBIT AND CREDIT RECONCILE INDEPENDENTLY", () => {
    const [debit, credit] = m.leafColumns;
    expect(m.omitted.values[debit.id]).not.toBeCloseTo(m.omitted.values[credit.id], 2);
    expect(visibleSum(m, 0) + m.omitted.values[debit.id]).toBeCloseTo(COMPLETE.debit, 6);
    expect(visibleSum(m, 1) + m.omitted.values[credit.id]).toBeCloseTo(COMPLETE.credit, 6);
  });

  test("A SIGNED AMOUNT STAYS SIGNED", () => {
    /* The fixture's omitted tail holds real negatives. An omitted sum that
       came back as the absolute value would still "reconcile" against an
       absolute complete total, so this checks the sign of the tail itself. */
    const signed = m.leafColumns[2];
    const omittedRows = LEDGERS.slice(100);
    const negatives = omittedRows.filter((r) => r[3] < 0);
    expect(negatives.length).toBeGreaterThan(50);
    expect(m.omitted.values[signed.id])
      .toBeCloseTo(omittedRows.reduce((n, r) => n + r[3], 0), 6);
    expect(m.omitted.values[signed.id]).toBeLessThan(
      omittedRows.reduce((n, r) => n + Math.abs(r[3]), 0),
    );
  });

  test("the omitted figure is a real share of the money, not a rounding crumb", () => {
    // The audit's point, arithmetically: the visible hundred is a minority.
    const share = visibleSum(m, 0) / COMPLETE.debit;
    expect(share).toBeLessThan(0.2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The omitted set is the tail of the B3 order
 * ══════════════════════════════════════════════════════════════════════════ */

describe("which groups are omitted follows the sort", () => {
  const sorted = (direction) => shape(
    layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction }],
      limit: 100,
    }),
    { main: LEDGERS },
  );

  test("ASCENDING AND DESCENDING DROP DIFFERENT TAILS", () => {
    const asc = sorted("asc");
    const desc = sorted("desc");
    const labelsOf = (m) => dataRows(m).map((r) => r.labels[0]);

    // Ascending keeps the smallest hundred; descending keeps the largest.
    expect(labelsOf(asc)[0]).toBe("G001");
    expect(labelsOf(desc)[0]).toBe("G333");
    expect(new Set(labelsOf(asc)).size).toBe(100);
    expect(labelsOf(asc).filter((x) => labelsOf(desc).includes(x))).toHaveLength(0);
  });

  test("AND BOTH RECONCILE TO THE SAME COMPLETE TOTAL", () => {
    for (const direction of ["asc", "desc"]) {
      const m = sorted(direction);
      const id = m.leafColumns[0].id;
      expect(m.omitted.rows).toBe(233);
      expect(visibleSum(m, 0) + m.omitted.values[id]).toBeCloseTo(COMPLETE.debit, 6);
    }
    // …by different routes: the descending report leaves out the small ones.
    expect(sorted("asc").omitted.values[sorted("asc").leafColumns[0].id])
      .toBeGreaterThan(sorted("desc").omitted.values[sorted("desc").leafColumns[0].id]);
  });

  test("the omitted figure is the tail's own sum, group for group", () => {
    const m = sorted("desc");
    const kept = new Set(dataRows(m).map((r) => r.labels[0]));
    const tail = LEDGERS.filter((r) => !kept.has(r[0])).reduce((n, r) => n + r[1], 0);
    expect(m.omitted.values[m.leafColumns[0].id]).toBeCloseTo(tail, 6);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Subtotals are not rows
 * ══════════════════════════════════════════════════════════════════════════ */

describe("nesting does not inflate any count", () => {
  /* Six leaf groups across three parents, capped at four. The physical
     response holds subtotals as well, which is exactly the trap: the row array
     is longer than the limit while four data rows are shown. */
  const l = layout({
    rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
    values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
    limit: 4,
  });
  const NESTED = {
    main: [
      ["Assets", "Bank", 10], ["Assets", "Cash", 20],
      ["Expenses", "Rent", 30], ["Expenses", "Salary", 40],
      ["Income", "Sales", 50], ["Income", "Other", 60],
    ],
    rowTotals: null, colTotals: null, grand: null,
    subtotals: [{
      depth: 0,
      prefix: [l.rows[0].field],
      cells: [["Assets", 30], ["Expenses", 70], ["Income", 110]],
      total: null,
    }],
  };
  const m = matrix.shapeSummary({ layout: l, results: NESTED, comparisonResults: [], dataAsOf: null, limit: 4 });

  test("ONLY LEAF DATA GROUPS ARE COUNTED", () => {
    expect(m.previewRowCount).toBe(4);
    expect(m.groupCount).toBe(6);
    expect(m.omitted.rows).toBe(2);
    expect(dataRows(m)).toHaveLength(4);
    expect(m.rows.filter((r) => r.kind === "subtotal").length).toBeGreaterThan(0);
  });

  test("the physical row array may exceed the limit; the count may not", () => {
    expect(m.rows.length).toBeGreaterThan(m.previewRowCount);
    expect(m.previewRowCount).toBeLessThanOrEqual(4);
  });

  test("the omitted value is the omitted LEAF rows, with no subtotal double-counted", () => {
    expect(m.omitted.values[m.leafColumns[0].id]).toBeCloseTo(50 + 60, 6);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Column groupings, comparisons and calculations
 * ══════════════════════════════════════════════════════════════════════════ */

describe("every leaf column answers for itself", () => {
  test("A COLUMN GROUPING REPORTS OMISSIONS UNDER ITS STABLE LEAF IDS", () => {
    /* group × month, two months, four groups, capped at two. */
    const main = [
      ["A", "2025-08-01T00:00:00+05:30", 10], ["A", "2025-09-01T00:00:00+05:30", 11],
      ["B", "2025-08-01T00:00:00+05:30", 20], ["B", "2025-09-01T00:00:00+05:30", 21],
      ["C", "2025-08-01T00:00:00+05:30", 30], ["C", "2025-09-01T00:00:00+05:30", 31],
      ["D", "2025-08-01T00:00:00+05:30", 40], ["D", "2025-09-01T00:00:00+05:30", 41],
    ];
    const l = layout({
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      showRowTotals: true,
      limit: 2,
    });
    const m = matrix.shapeSummary({
      layout: l,
      results: { main, rowTotals: [["A", 21], ["B", 41], ["C", 61], ["D", 81]], colTotals: null, grand: null, subtotals: [] },
      comparisonResults: [], dataAsOf: null, limit: 2,
    });

    expect(m.previewRowCount).toBe(2);
    expect(m.groupCount).toBe(4);
    expect(m.omitted.rows).toBe(2);

    // One entry per leaf, keyed by the ids the response already publishes.
    expect(Object.keys(m.omitted.values).sort()).toEqual(m.leafColumns.map((c) => c.id).sort());

    // C and D were dropped: August 30+40, September 31+41, row total 61+81.
    const byHeadingAndMonth = (monthIndex) => m.leafColumns
      .filter((c) => !c.isTotal)[monthIndex].id;
    expect(m.omitted.values[byHeadingAndMonth(0)]).toBeCloseTo(70, 6);
    expect(m.omitted.values[byHeadingAndMonth(1)]).toBeCloseTo(72, 6);
    expect(m.omitted.values[m.leafColumns.find((c) => c.isTotal).id]).toBeCloseTo(142, 6);

    // Nothing internal leaked into the keys.
    for (const id of Object.keys(m.omitted.values)) {
      expect(id).not.toMatch(/v_general_ledger|group_name|field|aggregation/);
    }
  });

  test("AN AVERAGE, A MINIMUM AND A MAXIMUM ARE NULL, NOT A PLAUSIBLE NUMBER", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [
        { field: "amount.debit", heading: "Total", calculation: "total" },
        { field: "amount.debit", heading: "Average", calculation: "average" },
        { field: "amount.debit", heading: "Largest", calculation: "maximum" },
      ],
      limit: 2,
    });
    const m = matrix.shapeSummary({
      layout: l,
      results: { main: [["A", 10, 5, 8], ["B", 20, 6, 9], ["C", 30, 7, 10], ["D", 40, 8, 11]] },
      comparisonResults: [], dataAsOf: null, limit: 2,
    });
    const [total, average, largest] = m.leafColumns;
    expect(m.omitted.values[total.id]).toBeCloseTo(70, 6);
    expect(m.omitted.values[average.id]).toBeNull();
    expect(m.omitted.values[largest.id]).toBeNull();
  });

  test("A DIFFERENCE ADDS UP; A PERCENTAGE CHANGE DOES NOT", () => {
    const build = (display) => {
      const l = layout({
        rows: [{ field: "ledger.group" }],
        values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
        comparisons: [{ field: "amount.debit", mode: "previous_period", display }],
        filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
        limit: 2,
      });
      return matrix.shapeSummary({
        layout: l,
        results: { main: [["A", 100], ["B", 200], ["C", 300], ["D", 400]], rowTotals: null, colTotals: null, grand: null, subtotals: [] },
        comparisonResults: [{ main: [["A", 50], ["B", 100], ["C", 200], ["D", 250]], rowTotals: null, colTotals: null, grand: null, subtotals: [] }],
        dataAsOf: null, limit: 2,
      });
    };

    const diff = build("difference");
    const cmpDiff = diff.leafColumns.find((c) => c.isComparison);
    // C and D: (300-200) + (400-250).
    expect(diff.omitted.values[cmpDiff.id]).toBeCloseTo(250, 6);
    expect(diff.omitted.values[diff.leafColumns[0].id]).toBeCloseTo(700, 6);

    const pct = build("percentage_difference");
    const cmpPct = pct.leafColumns.find((c) => c.isComparison);
    expect(pct.omitted.values[cmpPct.id]).toBeNull();
    // The measure beside it still reconciles — one bad column does not spoil it.
    expect(pct.omitted.values[pct.leafColumns[0].id]).toBeCloseTo(700, 6);
  });

  test("A COUNT IS OMITTED AS A COUNT, NOT AS MONEY", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", heading: "Lines", calculation: "count" }],
      limit: 1,
    });
    const m = matrix.shapeSummary({
      layout: l, results: { main: [["A", 3], ["B", 4], ["C", 5]] },
      comparisonResults: [], dataAsOf: null, limit: 1,
    });
    expect(m.leafColumns[0].semanticType).toBe("count");
    expect(m.omitted.values[m.leafColumns[0].id]).toBe(9);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A complete report says so
 * ══════════════════════════════════════════════════════════════════════════ */

describe("nothing omitted, nothing claimed", () => {
  test("AN UNTRUNCATED RESULT RETURNS truncated:false AND omitted:null", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      limit: 100,
    });
    const m = shape(l, { main: [["A", 1], ["B", 2], ["C", 3]] });
    expect(m.previewRowCount).toBe(3);
    expect(m.groupCount).toBe(3);
    expect(m.totalRowCount).toBe(3);
    expect(m.truncated).toBe(false);
    expect(m.omitted).toBeNull();
  });

  test("exactly at the limit is not truncation", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      limit: 3,
    });
    const m = matrix.shapeSummary({
      layout: l, results: { main: [["A", 1], ["B", 2], ["C", 3]] },
      comparisonResults: [], dataAsOf: null, limit: 3,
    });
    expect(m.truncated).toBe(false);
    expect(m.omitted).toBeNull();
  });

  test("totalRowCount still means the COMPLETE count, as it always did", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }], values: THREE_VALUES, limit: 100,
    });
    const m = shape(l, { main: LEDGERS });
    expect(m.totalRowCount).toBe(333);
    expect(m.totalRowCount).toBe(m.groupCount);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Detail mode
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a detail list counts records, not groups", () => {
  // No Values: that is what makes a layout a list.
  const l = layout({
    rows: [{ field: "date.voucher", heading: "Date" }, { field: "amount.debit", heading: "Debit" }],
  });

  test("DETAIL COUNT SEMANTICS", () => {
    const m = matrix.shapeDetail({
      layout: l, rows: [["2026-01-01", 100], ["2026-01-02", 200]],
      totalRowCount: 57, dataAsOf: null,
    });
    expect(m.previewRowCount).toBe(2);
    expect(m.groupCount).toBeNull();      // a list has no groups to count
    expect(m.totalRowCount).toBe(57);
    expect(m.truncated).toBe(true);
    expect(m.omitted).toEqual({ rows: 55, values: null });
  });

  test("a complete list omits nothing", () => {
    const m = matrix.shapeDetail({
      layout: l, rows: [["2026-01-01", 100]], totalRowCount: 1, dataAsOf: null,
    });
    expect(m.truncated).toBe(false);
    expect(m.omitted).toBeNull();
    expect(m.groupCount).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Serialization
 * ══════════════════════════════════════════════════════════════════════════ */

test("THE NEW FIELDS SURVIVE JSON, INCLUDING THE NULLS", () => {
  const l = layout({
    rows: [{ field: "ledger.group" }], values: THREE_VALUES, limit: 100,
  });
  const round = JSON.parse(JSON.stringify(shape(l, { main: LEDGERS })));
  expect(round.previewRowCount).toBe(100);
  expect(round.groupCount).toBe(333);
  expect(round.omitted.rows).toBe(233);
  expect(Object.keys(round.omitted.values)).toHaveLength(3);

  const complete = JSON.parse(JSON.stringify(shape(l, { main: LEDGERS.slice(0, 3) })));
  // `omitted: null` must SURVIVE as null, not vanish — a missing key and a null
  // read the same in JavaScript and do not read the same to a person.
  expect("omitted" in complete).toBe(true);
  expect(complete.omitted).toBeNull();
  expect("groupCount" in complete).toBe(true);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Mutation: would any of this notice?
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the counting is load-bearing", () => {
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

  const flat = layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
    sort: [{ field: "amount.debit", direction: "desc" }],
    limit: 100,
  });
  const nested = layout({
    rows: [{ field: "ledger.group" }, { field: "ledger.name" }],
    values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
    limit: 4,
  });
  const NESTED = {
    main: [
      ["Assets", "Bank", 10], ["Assets", "Cash", 20],
      ["Expenses", "Rent", 30], ["Expenses", "Salary", 40],
      ["Income", "Sales", 50], ["Income", "Other", 60],
    ],
    rowTotals: null, colTotals: null, grand: null,
    subtotals: [{
      depth: 0,
      prefix: [nested.rows[0].field],
      cells: [["Assets", 30], ["Expenses", 70], ["Income", 110]],
      total: null,
    }],
  };
  const SIGNED = layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.signed", heading: "Signed", calculation: "total" }],
    limit: 2,
  });

  test("REPORTING THE GROUP COUNT AS THE PREVIEW COUNT FAILS", () => {
    const assertHundred = (m) => {
      const shaped = m.shapeSummary({ layout: flat, results: LEDGERS.map ? { main: LEDGERS } : null,
        comparisonResults: [], dataAsOf: null, limit: 100 });
      expect(shaped.previewRowCount).toBe(100);
    };
    survives(() => assertHundred(matrix));
    kills(() => assertHundred(mutate("matrix.js", [[
      `  const previewRowCount = shownRows.reduce((n, r) => (r.kind === "data" ? n + 1 : n), 0);`,
      `  const previewRowCount = rowTuples.length;`,
    ]])));
  });

  test("COUNTING SUBTOTALS AS ROWS FAILS", () => {
    const assertLeafCount = (m) => {
      const shaped = m.shapeSummary({ layout: nested, results: NESTED,
        comparisonResults: [], dataAsOf: null, limit: 4 });
      expect(shaped.previewRowCount).toBe(4);
      expect(shaped.omitted.rows).toBe(2);
    };
    survives(() => assertLeafCount(matrix));
    kills(() => assertLeafCount(mutate("matrix.js", [[
      `  const previewRowCount = shownRows.reduce((n, r) => (r.kind === "data" ? n + 1 : n), 0);`,
      `  const previewRowCount = shownRows.length;`,
    ]])));
  });

  test("TAKING THE OMITTED TAIL BEFORE SORTING FAILS", () => {
    /* `rowTuples` is the sorted order; `mainRows` is whatever the engine
       happened to return. Cutting the tail off the unsorted result gives a
       plausible-looking number for the wrong groups. */
    const assertTail = (m) => {
      const shaped = m.shapeSummary({ layout: flat, results: { main: LEDGERS },
        comparisonResults: [], dataAsOf: null, limit: 100 });
      // Sorted descending, the tail is the 233 SMALLEST groups.
      const tail = LEDGERS.slice(0, 233).reduce((n, r) => n + r[1], 0);
      expect(shaped.omitted.values[shaped.leafColumns[0].id]).toBeCloseTo(tail, 6);
    };
    survives(() => assertTail(matrix));
    kills(() => assertTail(mutate("matrix.js", [[
      `  const omittedData = outRows.slice(cut).filter((r) => r.kind === "data");`,
      `  const omittedData = mainRows.slice(limit).map((r) => ({ kind: "data", cells: [{ value: r[1] }] }));`,
    ]])));
  });

  test("DROPPING THE OMITTED VALUES FAILS", () => {
    const assertValues = (m) => {
      const shaped = m.shapeSummary({ layout: flat, results: { main: LEDGERS },
        comparisonResults: [], dataAsOf: null, limit: 100 });
      expect(shaped.omitted.values[shaped.leafColumns[0].id]).toBeGreaterThan(0);
    };
    survives(() => assertValues(matrix));
    kills(() => assertValues(mutate("matrix.js", [[
      `      ? { rows: groupCount - previewRowCount, values: omittedValues(omittedData, leafColumns, layout) }`,
      `      ? { rows: groupCount - previewRowCount, values: null }`,
    ]])));
  });

  test("SUMMING THE VISIBLE ROWS INSTEAD OF THE OMITTED ONES FAILS", () => {
    const assertTail = (m) => {
      const shaped = m.shapeSummary({ layout: flat, results: { main: LEDGERS },
        comparisonResults: [], dataAsOf: null, limit: 100 });
      const visible = shaped.rows.filter((r) => r.kind === "data")
        .reduce((n, r) => n + Number(r.cells[0].value), 0);
      expect(visible + shaped.omitted.values[shaped.leafColumns[0].id])
        .toBeCloseTo(LEDGERS.reduce((n, r) => n + r[1], 0), 6);
    };
    survives(() => assertTail(matrix));
    kills(() => assertTail(mutate("matrix.js", [[
      `  const omittedData = outRows.slice(cut).filter((r) => r.kind === "data");`,
      `  const omittedData = outRows.slice(0, cut).filter((r) => r.kind === "data");`,
    ]])));
  });

  test("STRIPPING THE SIGN FAILS", () => {
    const assertSigned = (m) => {
      const shaped = m.shapeSummary({
        layout: SIGNED,
        results: { main: [["A", 10], ["B", 20], ["C", -30], ["D", -40]] },
        comparisonResults: [], dataAsOf: null, limit: 2,
      });
      expect(shaped.omitted.values[shaped.leafColumns[0].id]).toBeCloseTo(-70, 6);
    };
    survives(() => assertSigned(matrix));
    kills(() => assertSigned(mutate("matrix.js", [[
      `      sum += Number(value);`,
      `      sum += Math.abs(Number(value));`,
    ]])));
  });
});
