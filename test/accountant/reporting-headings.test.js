// test/accountant/reporting-headings.test.js
//
// VOUCHER NUMBER ACROSS THE TOP, AND THE BOUND THAT MAKES IT SAFE.
//
// The catalogue used to forbid it outright — `placements: ["rows","filters"]` —
// because a voucher number is the highest-cardinality field in the books and
// no STATIC gate can tell "every voucher this year" from "the four I filtered
// to". `previewBudget.js` says so in its own words: it counts fields, and one
// field is one field whether it holds twelve months or nine thousand numbers.
//
// So the rule moved to where the answer is: `headingBudget.js` counts the
// headings the report would really produce, after company scope and the
// report's own filters, with the count itself limited to one more than the
// maximum. These are its properties.
//
// Nothing here talks to a database. The probe's runner is injected, which is
// what lets "what query would it send" be asserted exactly.
"use strict";

const headingBudget = require("../../services/reporting/headingBudget");
const { HEADING_BUDGET } = headingBudget;
const catalogue = require("../../services/reporting/fieldCatalogue");
const { CODES } = require("../../services/reporting/metabaseEngine");

const MAX = HEADING_BUDGET.maxHeadings;

const field = (id) => catalogue.FIELDS.find((f) => f.id === id);

/** A resolved view with every column mapped to a distinct fake id. */
const RESOLVED = {
  databaseId: 2,
  tableId: 200,
  fieldIds: Object.fromEntries(
    [...catalogue.allColumns(), "organization_id", "company_id"].map((c, i) => [c, 1000 + i]),
  ),
};

const ORG = "6a073de21fecacc9bb714481";
const CO = ["6a08040a1fecacc9bb7149c2"];

/** A runner that records the query and answers with `rows` distinct headings. */
function runnerFor(distinct) {
  const sent = [];
  return {
    sent,
    runQuery: async (payload) => {
      sent.push(payload);
      const limit = payload?.query?.limit ?? distinct;
      return Array.from({ length: Math.min(distinct, limit) }, (_, i) => [`V${i}`, 1]);
    },
  };
}

const layoutWith = (columns, over = {}) => ({
  mode: "summary",
  rows: [{ field: field("ledger.name"), heading: "Ledger Name" }],
  columns,
  values: [{ field: field("amount.debit"), heading: "Total Debit", calculation: "total" }],
  filters: [],
  comparisons: [],
  sort: [],
  ...over,
});

const voucherAcross = () => [{ field: field("voucher.number"), heading: "Voucher Number" }];

/* ── The catalogue ──────────────────────────────────────────────────────── */

describe("the catalogue permits it, and still protects the value", () => {
  test("VOUCHER NUMBER MAY GO ACROSS THE TOP", () => {
    expect(field("voucher.number").placements).toContain("columns");
    expect(field("voucher.number").placements).toEqual(
      expect.arrayContaining(["rows", "columns", "filters"]),
    );
  });

  test("and is still never a figure — `00531` cannot be summed", () => {
    /* `text_exact` is what keeps the leading zero. `assertSemantics` refuses to
       let a field carrying it be calculated or placed in Values, and that is
       unchanged by permitting it as a grouping. */
    expect(field("voucher.number").placements).not.toContain("values");
    expect(field("voucher.number").calculations).toEqual([]);
    expect(field("voucher.number").display).toEqual({ format: "text_exact", sort: "natural" });
    expect(field("voucher.number").type).toBe("text");
  });

  test("it is still not RECOMMENDED for a chart axis", () => {
    // Permitted and recommended are different questions.
    expect(field("voucher.number").chart.highCardinality).toBe(true);
  });
});

/* ── The probe ──────────────────────────────────────────────────────────── */

describe("counting the headings", () => {
  test("ONE VOUCHER NUMBER ACROSS THE TOP IS ALLOWED", async () => {
    const r = runnerFor(1);
    const count = await headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(count).toEqual({ headings: 1, exact: true, allowed: true });
  });

  test("SEVERAL FILTERED VOUCHER NUMBERS ARE ALLOWED", async () => {
    const r = runnerFor(4);
    const layout = layoutWith(voucherAcross(), {
      filters: [{ field: field("voucher.number"), operation: "starts_with", value: "00" }],
    });
    const count = await headingBudget.countHeadings({
      layout, resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(count.allowed).toBe(true);
    expect(count.headings).toBe(4);

    // The report's own filter is in the probe, so it counts the filtered set.
    const filter = JSON.stringify(r.sent[0].query.filter);
    expect(filter).toContain("starts-with");
    expect(filter).toContain("00");
  });

  test("EXACTLY AT THE LIMIT SUCCEEDS", async () => {
    const r = runnerFor(MAX);
    const count = await headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(count).toEqual({ headings: MAX, exact: true, allowed: true });
  });

  test("ONE OVER THE LIMIT IS REFUSED", async () => {
    const r = runnerFor(MAX + 1);
    const count = await headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(count.allowed).toBe(false);
    expect(count.exact).toBe(false);
  });

  test("a report with nothing across the top is not probed at all", async () => {
    const r = runnerFor(9999);
    const count = await headingBudget.countHeadings({
      layout: layoutWith([]),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(count).toEqual({ headings: 0, exact: true, allowed: true });
    expect(r.sent).toHaveLength(0);
  });

  test("MULTIPLE HORIZONTAL FIELDS ARE COUNTED AS ONE COMBINED AXIS", async () => {
    /* Voucher Type × Voucher Number across the top is ONE axis carrying
       (types × numbers) headings. Bounding the two fields separately would let
       their product through, which is the whole failure mode. */
    const r = runnerFor(MAX + 1);
    const layout = layoutWith([
      { field: field("voucher.type"), heading: "Voucher Type" },
      { field: field("voucher.number"), heading: "Voucher Number" },
    ]);
    const count = await headingBudget.countHeadings({
      layout, resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });

    expect(count.allowed).toBe(false);
    // One query, breaking out on BOTH fields — not one query per field.
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0].query.breakout).toHaveLength(2);
  });
});

/* ── The probe cannot itself be the expensive question ──────────────────── */

describe("the count is bounded and scoped", () => {
  test("IT NEVER ASKS FOR MORE THAN THE MAXIMUM PLUS ONE", async () => {
    const r = runnerFor(100_000);
    await headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(r.sent[0].query.limit).toBe(MAX + 1);
  });

  test("even against nine thousand vouchers it reads at most 51 rows", async () => {
    const r = runnerFor(9000);
    const count = await headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    // The runner honours the query's limit, exactly as the database would.
    expect(count.headings).toBe(MAX + 1);
    expect(count.allowed).toBe(false);
  });

  test("IT CARRIES THE ORGANISATION AND COMPANY FILTER", async () => {
    const r = runnerFor(2);
    await headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    const filter = JSON.stringify(r.sent[0].query.filter);
    expect(filter).toContain(ORG);
    expect(filter).toContain(CO[0]);
  });

  test("and refuses to compile without one", async () => {
    const r = runnerFor(2);
    await expect(headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: null, companyIds: CO, runQuery: r.runQuery,
    })).rejects.toThrow();

    await expect(headingBudget.countHeadings({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: [], runQuery: r.runQuery,
    })).rejects.toThrow();
  });
});

/* ── What the refusal says ──────────────────────────────────────────────── */

describe("the refusal contract", () => {
  test("IT CARRIES THE FIELD, THE COUNT, THE MAXIMUM AND THE WAY OUT", async () => {
    const r = runnerFor(MAX + 1);
    const layout = layoutWith(voucherAcross());
    const err = await headingBudget.assertWithinBudget({
      layout, resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    }).catch((e) => e);

    expect(err.code).toBe(CODES.TOO_MANY_HEADINGS);
    expect(err.code).toBe("REPORTING_TOO_MANY_HEADINGS");   // the stable string
    expect(err.status).toBe(422);
    expect(err.details).toEqual({
      field: "Voucher Number",
      fields: ["Voucher Number"],
      headings: MAX,
      exact: false,
      maximum: MAX,
      reason: expect.stringContaining("more than 50"),
    });
    expect(err.details.reason).toMatch(/Filter Voucher Number more narrowly/);
    expect(err.details.reason).toMatch(/down the left/);
  });

  test("several fields are all named", () => {
    const layout = layoutWith([
      { field: field("voucher.type"), heading: "Voucher Type" },
      { field: field("voucher.number"), heading: "Voucher Number" },
    ]);
    const d = headingBudget.refusalDetails(layout, { headings: MAX + 1, exact: false });
    expect(d.fields).toEqual(["Voucher Type", "Voucher Number"]);
    expect(d.field).toBe("Voucher Type × Voucher Number");
  });

  test("IT LEAKS NO ENGINE DETAIL", async () => {
    const r = runnerFor(MAX + 1);
    const layout = layoutWith(voucherAcross());
    const err = await headingBudget.assertWithinBudget({
      layout, resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    }).catch((e) => e);

    const wire = JSON.stringify({ message: err.message, ...err.details });
    for (const leak of ["voucher_number", "v_general_ledger", "source-table", "breakout",
                        "database", "mb_", "SELECT", "reporting.", String(RESOLVED.tableId)]) {
      expect(wire).not.toContain(leak);
    }
    // It names the field the way the user sees it, and nothing else.
    expect(wire).toContain("Voucher Number");
  });

  test("an allowed report throws nothing", async () => {
    const r = runnerFor(3);
    await expect(headingBudget.assertWithinBudget({
      layout: layoutWith(voucherAcross()),
      resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    })).resolves.toEqual({ headings: 3, exact: true, allowed: true });
  });
});

/* ── The maximum is the server's, and written down once ─────────────────── */

describe("the maximum", () => {
  test("is a number the server owns", () => {
    expect(Number.isInteger(MAX)).toBe(true);
    expect(MAX).toBe(50);
  });

  test("is not something a request can raise", async () => {
    /* A layout cannot carry its own limit for this: the probe builds its own
       query and the bound comes from the module. */
    const r = runnerFor(MAX + 1);
    const layout = layoutWith(voucherAcross(), { limit: 100000, maxHeadings: 100000 });
    const count = await headingBudget.countHeadings({
      layout, resolved: RESOLVED, organizationId: ORG, companyIds: CO, runQuery: r.runQuery,
    });
    expect(r.sent[0].query.limit).toBe(MAX + 1);
    expect(count.allowed).toBe(false);
  });
});
