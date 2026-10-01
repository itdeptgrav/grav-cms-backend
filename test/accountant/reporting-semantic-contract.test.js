// test/accountant/reporting-semantic-contract.test.js
//
// CHARACTERIZATION TESTS FOR THE SEMANTIC CONTRACT.
//
// Written during the audit in `docs/audits/accounting-custom-report-semantic-
// contract-audit.md`, and updated by slices B1 and B2, which fixed the first
// two gaps it recorded. Each test pins something the audit measured.
//
// Two kinds live here and they are labelled:
//
//   PROPERTY  — must stay true forever. A chronological order, a text voucher
//               number, a catalogue that only advertises what works.
//   GAP       — today's behaviour where the audit found it WRONG. The test
//               passes now and must be UPDATED by the slice that fixes it;
//               its comment says what the fixed assertion should be. A gap
//               left untested is a gap that gets re-shipped.
//
// The gaps B1, B2, B3 and B4 closed — no semantic type; a period cell carrying
// only an engine timestamp; a sort the summary ignored; a `previewRowCount`
// that reported the group count — are now PROPERTY tests below. The five-column
// detail cap is the one still open.
//
// Everything here runs the real functions. Nothing greps source.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const catalogue = require("../../services/reporting/fieldCatalogue");
const { validateLayout, LayoutError, LIMITS } = require("../../services/reporting/reportLayout.validate");
const { compilePlan, compileChartQuery } = require("../../services/reporting/mbqlCompiler");
const matrix = require("../../services/reporting/matrix");
const semantics = require("../../services/reporting/semantics");

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

/* ═══════════════════════════════════════════════════════════════════════════
 * Month
 * ══════════════════════════════════════════════════════════════════════════ */

describe("Month", () => {
  test("PROPERTY: a month reads as a month, whatever timezone the engine stamps on it", () => {
    /* The engine returns `2025-07-01T00:00:00+05:30` for a Postgres DATE. The
       label is built by slicing the ISO string rather than by constructing a
       Date, which is what stops a +05:30 month becoming the previous one in a
       UTC process. Parsing it instead would print "Jun 2025" here. */
    expect(matrix.labelOf("2025-07-01T00:00:00+05:30", "date")).toBe("Jul 2025");
    expect(matrix.labelOf("2025-01-01T00:00:00+05:30", "date")).toBe("Jan 2025");
    expect(matrix.labelOf("2025-07-17T00:00:00+05:30", "date")).toBe("17 Jul 2025");
    expect(matrix.labelOf(null, "date")).toBe("(none)");
  });

  test("PROPERTY: months order chronologically ACROSS A YEAR BOUNDARY", () => {
    const field = catalogue.fieldOf("date.month");
    const rows = [
      ["2026-02-01T00:00:00+05:30", 1],
      ["2025-12-01T00:00:00+05:30", 2],
      ["2026-01-01T00:00:00+05:30", 3],
    ];
    const ordered = matrix.distinctTuples(rows, [0], [field]).map(([v]) => matrix.labelOf(v, "date"));
    expect(ordered).toEqual(["Dec 2025", "Jan 2026", "Feb 2026"]);
  });

  test("PROPERTY: the order comes from the VALUE, never from the label", () => {
    /* "Apr, Aug, Dec" is what a string sort gives, and it is the first thing
       anyone notices. If the sort key ever becomes the formatted label this
       fails. */
    const field = catalogue.fieldOf("date.month");
    const rows = ["2026-04-01", "2026-08-01", "2026-12-01", "2026-01-01"].map((d) => [d]);
    const ordered = matrix.distinctTuples(rows, [0], [field]).map(([v]) => v);
    expect(ordered).toEqual(["2026-01-01", "2026-04-01", "2026-08-01", "2026-12-01"]);
    expect(ordered.map((v) => matrix.labelOf(v, "date")))
      .toEqual(["Jan 2026", "Apr 2026", "Aug 2026", "Dec 2026"]);
  });

  test("PROPERTY: the catalogue tells Month from Voucher Date without reading English", () => {
    /* The gap this replaces: both were `type: "date"` and nothing else, so a
       client had to infer a month from the label "Month" — which is how a
       month came to be rendered as "01 Jul 2025". */
    const pub = catalogue.publicCatalogue().fields;
    const month = pub.find((f) => f.id === "date.month");
    const voucherDate = pub.find((f) => f.id === "date.voucher");

    expect(month.semanticType).toBe("month");
    expect(voucherDate.semanticType).toBe("date");
    expect(month.display).toEqual({ format: "month_year", sort: "chronological" });
    expect(voucherDate.display).toEqual({ format: "day_month_year", sort: "chronological" });

    // `type` is untouched, so a client that only knows the old contract is
    // exactly as well off as it was.
    expect(month.type).toBe("date");
    expect(voucherDate.type).toBe("date");
  });

  test("PROPERTY: a month knows what a chart should do with it", () => {
    const month = catalogue.publicCatalogue().fields.find((f) => f.id === "date.month");
    expect(month.chart).toEqual({
      role: "temporal", defaultGroupingPriority: 30, highCardinality: false,
    });
  });

  test("PROPERTY: a month cell carries the value, a key and the sentence to show", () => {
    /* The gap this replaces: the cell was the engine's timestamp and a display
       hint that said `date`, so every client formatted a month as a day — and
       a client outside IST formatted it as the wrong day. */
    const l = layout({ rows: [{ field: "date.month" }, { field: "voucher.number" }] });
    const shaped = matrix.shapeDetail({
      layout: l,
      rows: [["2025-07-01T00:00:00+05:30", "00531"]],
      totalRowCount: 1,
      dataAsOf: null,
    });

    expect(shaped.rows[0].cells[0]).toEqual({
      value: "2025-07-01T00:00:00+05:30",   // unchanged, still authoritative
      display: "date",                       // unchanged: the transition hint
      semanticType: "month",
      key: "2025-07",
      text: "July 2025",
    });
    expect(shaped.rows[0].cells[0].text).not.toMatch(/^\d{2} /);   // never "01 Jul 2025"
  });

  test("PROPERTY: the month key is built from characters, not from a Date", () => {
    /* `new Date("2025-07-01T00:00:00+05:30").getUTCMonth()` is JUNE. The key
       is sliced out of the string, so the same input gives the same key in
       every timezone a server might run in. */
    for (const value of [
      "2025-07-01T00:00:00+05:30",
      "2025-07-01T00:00:00Z",
      "2025-07-01T00:00:00-08:00",
      "2025-07-01",
    ]) {
      expect(semantics.periodKey("month", value)).toBe("2025-07");
      expect(semantics.periodText("month", value)).toBe("July 2025");
    }
  });

  test("PROPERTY: a voucher date cannot slip to the day before", () => {
    expect(semantics.periodKey("date", "2026-09-24T00:00:00+05:30")).toBe("2026-09-24");
    expect(semantics.periodText("date", "2026-09-24T00:00:00+05:30")).toBe("24 September 2026");
    // Midnight IST is the previous evening in UTC; the key must not follow it.
    expect(new Date("2026-09-24T00:00:00+05:30").toISOString().slice(0, 10)).toBe("2026-09-23");
    expect(semantics.periodKey("date", "2026-09-24T00:00:00+05:30")).not.toBe("2026-09-23");
  });

  test("PROPERTY: a financial year keeps a stable key and reads with an en dash", () => {
    expect(semantics.periodKey("financial_year", "2025-26")).toBe("2025-26");
    expect(semantics.periodText("financial_year", "2025-26")).toBe("2025\u201326");
    // A period nobody recorded stays absent. Inventing one would be a lie
    // about which year ₹3.63 crore of debit belongs to.
    expect(semantics.periodKey("financial_year", null)).toBeNull();
    expect(semantics.periodText("financial_year", null)).toBeNull();
  });

  test("PROPERTY: keys order chronologically across a year boundary", () => {
    const keys = ["2025-12-01", "2026-02-01", "2026-01-01"]
      .map((v) => semantics.periodKey("month", v))
      .sort();
    expect(keys).toEqual(["2025-12", "2026-01", "2026-02"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Identifiers
 * ══════════════════════════════════════════════════════════════════════════ */

describe("identifiers", () => {
  test("PROPERTY: a voucher number is text, and 00531 survives as text", () => {
    /* `00531` losing its zeroes is the canonical spreadsheet defect: it stops
       matching the voucher it names. Nothing in the backend may type it as a
       number — not the catalogue, not the calculations, not the cell. */
    const field = catalogue.fieldOf("voucher.number");
    expect(field.type).toBe("text");
    expect(field.calculations).toEqual([]);
    expect(field.placements).not.toContain("values");

    const l = layout({ rows: [{ field: "voucher.number" }, { field: "amount.debit" }] });
    const shaped = matrix.shapeDetail({ layout: l, rows: [["00531", 1200.5]], totalRowCount: 1, dataAsOf: null });
    expect(shaped.rows[0].cells[0]).toEqual({
      value: "00531", display: "text", semanticType: "identifier",
    });
    expect(typeof shaped.rows[0].cells[0].value).toBe("string");

    // And the catalogue says, in the contract rather than in a comment, that
    // these characters are the value: `text_exact` is what `assertSemantics`
    // refuses to let anything calculate.
    const pub = catalogue.publicCatalogue().fields.find((f) => f.id === "voucher.number");
    expect(pub.semanticType).toBe("identifier");
    expect(pub.display.format).toBe("text_exact");
    expect(pub.chart).toEqual({
      role: "identifier", defaultGroupingPriority: 95, highCardinality: true,
    });
  });

  test("PROPERTY: no identifier-ish column is offered for arithmetic", () => {
    for (const id of ["voucher.number", "ledger.name", "party.name", "company.name",
                      "date.financial_year", "voucher.narration", "tax.classification"]) {
      const f = catalogue.fieldOf(id);
      expect([id, f.placements.includes("values")]).toEqual([id, false]);
      expect([id, f.calculations]).toEqual([id, []]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * What the catalogue promises
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the catalogue promises only what the validator accepts", () => {
  test("PROPERTY: every advertised calculation is accepted", () => {
    for (const f of catalogue.publicCatalogue().fields) {
      for (const calculation of f.calculations) {
        expect(() => layout({
          rows: [{ field: "ledger.group" }],
          values: [{ field: f.id, calculation }],
        })).not.toThrow();
      }
    }
  });

  test("PROPERTY: a calculation NOT advertised is refused", () => {
    const refused = [];
    for (const f of catalogue.publicCatalogue().fields) {
      for (const calculation of catalogue.CALCULATIONS) {
        if (f.calculations.includes(calculation)) continue;
        try {
          layout({ rows: [{ field: "ledger.group" }], values: [{ field: f.id, calculation }] });
          refused.push(`${f.id}:${calculation} was accepted but not advertised`);
        } catch (err) {
          expect(err).toBeInstanceOf(LayoutError);
        }
      }
    }
    expect(refused).toEqual([]);
  });

  test("PROPERTY: every advertised filter operation is accepted", () => {
    const value = {
      between: ["2025-08-01", "2025-08-31"], on: "2025-08-04", before: "2025-08-04",
      after: "2025-08-04", is: "x", contains: "x", starts_with: "x", in: ["x"],
      equals: 1, greater_than: 1, less_than: 1,
    };
    for (const f of catalogue.publicCatalogue().fields) {
      for (const operation of f.filterOperations) {
        let v = value[operation];
        if (f.type === "money" || f.type === "number" || f.type === "integer") {
          v = operation === "between" ? [1, 2] : 1;
        } else if (f.type === "date" && operation === "between") v = ["2025-08-01", "2025-08-31"];
        else if (f.type === "choice") v = operation === "in" ? ["sales"] : "sales";
        expect(() => layout({
          rows: [{ field: "ledger.group" }],
          values: [{ field: "amount.debit", calculation: "total" }],
          filters: [{ field: f.id, operation, value: v }],
        })).not.toThrow(`${f.id} ${operation}`);
      }
    }
  });

  test("PROPERTY: a withheld column is not reachable by any name", () => {
    const ids = new Set(catalogue.publicCatalogue().fields.map((f) => f.id));
    for (const { column } of catalogue.WITHHELD) {
      expect(ids.has(column)).toBe(false);
      expect(catalogue.fieldOf(column)).toBeNull();
      // Nor under a plausible semantic id somebody might add later by accident.
      expect(catalogue.fieldOf(`amount.${column}`)).toBeNull();
      expect(catalogue.fieldOf(`ledger.${column}`)).toBeNull();
    }
    expect(catalogue.WITHHELD.map((w) => w.column).sort()).toEqual(
      ["company_id", "grand_total", "gstin", "opening_balance", "organization_id"],
    );
  });

  test("PROPERTY: nothing private reaches the browser", () => {
    for (const f of catalogue.publicCatalogue().fields) {
      expect(f).not.toHaveProperty("column");
      expect(f).not.toHaveProperty("temporalUnit");
      expect(JSON.stringify(f)).not.toMatch(
        /\b(v_general_ledger|voucher_date|period_month|group_name|ledger_name|party_ledger_name|signed_amount|gst_classification)\b/,
      );
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Grain
 * ══════════════════════════════════════════════════════════════════════════ */

describe("list grain", () => {
  test("PROPERTY: a list is the voucher LINE, selected and never joined or grouped", () => {
    /* One row per `ledgerEntries[]` element. The audit verified against the
       mart that every field combination returns exactly the line count — no
       duplication, and no de-duplication either. What makes that true is this:
       a detail query SELECTS and never aggregates or breaks out, and it reads
       one view. A join or a breakout appearing here would change the grain
       without anything else in the product noticing. */
    const l = layout({
      rows: [{ field: "voucher.number" }, { field: "ledger.name" }, { field: "amount.debit" }],
    });
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 100 });

    expect(plan.mode).toBe("detail");
    expect(plan.main.query.aggregation).toBeUndefined();
    expect(plan.main.query.breakout).toBeUndefined();
    expect(plan.main.query.joins).toBeUndefined();
    expect(plan.main.query["source-query"]).toBeUndefined();
    expect(plan.main.query.fields).toHaveLength(3);
    expect(plan.main.query["source-table"]).toBe(RESOLVED.tableId);

    // And the count beside it counts the same rows, with no DISTINCT.
    expect(plan.count.query.aggregation).toEqual([["count"]]);
    expect(plan.count.query.breakout).toBeUndefined();
  });

  test("PROPERTY: the tenant clauses are on the detail query, its count, and the chart", () => {
    const l = layout({ rows: [{ field: "voucher.number" }] });
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 10 });
    const chart = compileChartQuery({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO] });

    for (const query of [plan.main, plan.count, chart]) {
      const [and, org, company] = query.query.filter;
      expect(and).toBe("and");
      expect(org).toEqual(["=", ["field", RESOLVED.fieldIds.organization_id, null], ORG]);
      expect(company).toEqual(["=", ["field", RESOLVED.fieldIds.company_id, null], CO]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Sorting
 * ══════════════════════════════════════════════════════════════════════════ */

describe("sorting", () => {
  test("PROPERTY: a detail report's sort reaches the query", () => {
    const l = layout({
      rows: [{ field: "date.voucher" }, { field: "amount.debit" }],
      sort: [{ field: "date.voucher", direction: "desc" }],
    });
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 10 });
    expect(plan.main.query["order-by"]).toEqual([
      ["desc", ["field", RESOLVED.fieldIds.voucher_date, null]],
    ]);
  });

  test("PROPERTY: a summary honours the direction it was asked for", () => {
    /* The gap this replaces: `sort` validated, was stored, reached MBQL — and
       was then undone by the matrix, which rebuilt the groups ascending
       whatever the report said. Ascending and descending returned the same
       rows in the same order. */
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "ledger.group", direction: "desc" }],
    });
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 100 });
    expect(plan.main.query["order-by"]).toEqual([
      ["desc", ["field", RESOLVED.fieldIds.group_name, null]],
    ]);

    const shaped = matrix.shapeSummary({
      layout: l,
      results: { main: [["Sundry Debtors", 3], ["Administrative Expenses", 1], ["Bank Accounts", 2]] },
      comparisonResults: [],
      dataAsOf: null,
      limit: 100,
    });
    expect(shaped.rows.filter((r) => r.kind === "data").map((r) => r.labels[0]))
      .toEqual(["Sundry Debtors", "Bank Accounts", "Administrative Expenses"]);
  });

  test("PROPERTY: sorting a summary by a calculated value orders by the figure", () => {
    /* "Top ledgers by debit" — the most ordinary request a report builder
       gets, and the one that used to come back alphabetically. */
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      sort: [{ field: "amount.debit", direction: "desc" }],
    });
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO], limit: 100 });
    expect(plan.main.query["order-by"][0]).toEqual(["desc", ["aggregation", 0]]);

    const shaped = matrix.shapeSummary({
      layout: l,
      results: { main: [["Administrative Expenses", 1], ["Sundry Debtors", 3], ["Bank Accounts", 2]] },
      comparisonResults: [],
      dataAsOf: null,
      limit: 100,
    });
    expect(shaped.rows.filter((r) => r.kind === "data").map((r) => [r.labels[0], r.cells[0].value]))
      .toEqual([["Sundry Debtors", 3], ["Bank Accounts", 2], ["Administrative Expenses", 1]]);
  });

  test("PROPERTY: an empty group sorts last and is labelled, not dropped", () => {
    const field = catalogue.fieldOf("party.name");
    const ordered = matrix.distinctTuples([["Zeta"], [null], ["acme"]], [0], [field]);
    expect(ordered.map(([v]) => matrix.labelOf(v, "text"))).toEqual(["acme", "Zeta", "(none)"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Counts and limits
 * ══════════════════════════════════════════════════════════════════════════ */

describe("counts the response reports", () => {
  test("PROPERTY: previewRowCount is the number of DATA ROWS RETURNED", () => {
    /* The audit found 333 ledgers capped at a hundred rows answering
       `previewRowCount: 333, totalRowCount: 333` — "showing 333 of 333" — with
       233 groups and most of the money missing and unmentioned. B4 split the
       two numbers and added what was left out. */
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      limit: 2,
    });
    const shaped = matrix.shapeSummary({
      layout: l,
      results: { main: [["A", 1], ["B", 2], ["C", 3]] },
      comparisonResults: [],
      dataAsOf: null,
      limit: 2,
    });
    expect(shaped.rows.filter((r) => r.kind === "data")).toHaveLength(2);
    expect(shaped.previewRowCount).toBe(2);
    expect(shaped.groupCount).toBe(3);
    expect(shaped.totalRowCount).toBe(3);   // unchanged: the COMPLETE count
    expect(shaped.truncated).toBe(true);
    expect(shaped.omitted.rows).toBe(1);
    expect(shaped.omitted.values[shaped.leafColumns[0].id]).toBe(3);
  });

  test("PROPERTY: a detail list may hold at most five columns today", () => {
    /* Characterized because the frontend's list-first model runs into it
       immediately: MAX_ROWS is five, while MAX_DETAIL_COLUMNS is twenty and
       therefore unreachable. Raising it is a product decision; discovering it
       from a 422 in a browser is not. */
    expect(LIMITS.MAX_ROWS).toBe(5);
    expect(LIMITS.MAX_DETAIL_COLUMNS).toBe(20);
    const six = ["date.voucher", "date.month", "voucher.number", "ledger.name", "party.name", "amount.debit"];
    expect(() => layout({ rows: six.map((f) => ({ field: f })) }))
      .toThrow(/at most 5 field\(s\) in Rows/);
  });
});
