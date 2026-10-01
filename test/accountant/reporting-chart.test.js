// test/accountant/reporting-chart.test.js
//
// THE CHART BRIDGE, WITHOUT A METABASE.
//
// What can be drawn, as what, with which settings, and — the part that matters
// most — that the query behind a chart is the same query, with the same two
// tenant clauses, that the spreadsheet runs. A chart is the one surface where
// a second, friendlier query path would be easy to justify and impossible to
// notice, so the tests that would fail if one appeared are here.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const jwt = require("jsonwebtoken");

const catalogue = require("../../services/reporting/fieldCatalogue");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");
const {
  compileChartQuery, compilePlan, previousPeriod, previousYear,
} = require("../../services/reporting/mbqlCompiler");
const {
  chartSupport, resultShape, supportedVisualizations, ALL_DISPLAYS,
} = require("../../services/reporting/chartCapability");
const {
  validateVisualization, VizError, PALETTES,
} = require("../../services/reporting/vizSettings.validate");
const { createChartBridge, TOKEN_TTL_SECONDS } = require("../../services/reporting/metabaseCharts.service");

const ORG = "6a073de21fecacc9bb714481";
const CO_A = "6a08040a1fecacc9bb7149c2";
const CO_B = "6ab1459d11fca003ca6f6062";

/** Metabase ids, made up: nothing here talks to a Metabase. */
const RESOLVED = {
  databaseId: 2,
  tableId: 41,
  fieldIds: Object.fromEntries(
    [...catalogue.FIELDS.map((f) => f.column), "organization_id", "company_id"]
      .map((column, i) => [column, 7000 + i]),
  ),
};

const layout = (raw, companies = [CO_A]) =>
  validateLayout({ name: "Chart", companyIds: companies, ...raw }, { approvedCompanyIds: companies });

const AUG_OCT = { field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] };

const GROUP_BY_DEBIT = () => layout({
  rows: [{ field: "ledger.group" }],
  values: [{ field: "amount.debit", calculation: "total" }],
  filters: [AUG_OCT],
});

const compile = (l, companies = [CO_A]) =>
  compileChartQuery({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: companies });

/* ═══════════════════════════════════════════════════════════════════════════
 * One query, and it is the same one
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the chart runs the report's own query", () => {
  test("WITHOUT COMPARISONS IT IS THE PREVIEW'S MAIN QUERY, BYTE FOR BYTE", () => {
    /* The strongest form of "no second query path": not a similar query, the
       same one. If these ever diverge, the chart and the sheet can disagree
       about a figure and nothing on screen would say which is right. */
    const l = GROUP_BY_DEBIT();
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO_A] });
    expect(compile(l)).toEqual(plan.main);
  });

  test("a detail report charts the same list the sheet lists", () => {
    const l = layout({
      rows: [{ field: "date.voucher" }, { field: "voucher.number" }, { field: "amount.debit" }],
      filters: [AUG_OCT],
    });
    const plan = compilePlan({ layout: l, resolved: RESOLVED, organizationId: ORG, companyIds: [CO_A] });
    expect(compile(l)).toEqual(plan.main);
  });

  test("EVERY CHART QUERY CARRIES BOTH TENANT CLAUSES, FIRST", () => {
    const shapes = [
      GROUP_BY_DEBIT(),
      layout({ rows: [{ field: "ledger.group" }], columns: [{ field: "date.month" }],
               values: [{ field: "amount.debit", calculation: "total" },
                        { field: "amount.credit", calculation: "total" }], filters: [AUG_OCT] }),
      layout({ rows: [{ field: "date.voucher" }, { field: "party.name" }], filters: [AUG_OCT] }),
      layout({ values: [{ field: "amount.debit", calculation: "total" }], filters: [AUG_OCT] }),
      layout({ rows: [{ field: "ledger.group" }],
               values: [{ field: "amount.debit", calculation: "total" }],
               comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
               filters: [AUG_OCT] }),
    ];

    for (const l of shapes) {
      const q = compile(l, [CO_A, CO_B]);
      const [first, org, company] = q.query.filter;
      expect(first).toBe("and");
      expect(org).toEqual(["=", ["field", RESOLVED.fieldIds.organization_id, null], ORG]);
      expect(company).toEqual([
        "=", ["field", RESOLVED.fieldIds.company_id, null], CO_A, CO_B,
      ]);
    }
  });

  test("no chart query is ever native SQL", () => {
    for (const l of [GROUP_BY_DEBIT(), layout({ rows: [{ field: "date.voucher" }], filters: [AUG_OCT] })]) {
      const q = compile(l);
      expect(q.type).toBe("query");
      expect(q.native).toBeUndefined();
      expect(JSON.stringify(q)).not.toMatch(/\bnative\b|\bselect\b/i);
    }
  });

  test("the chart query names no mart column as a string", () => {
    /* Columns are addressed by the engine's numeric field ids. A column NAME
       inside the query would mean the compiler had stopped resolving and
       started guessing. */
    const text = JSON.stringify(compile(GROUP_BY_DEBIT()));
    for (const column of ["group_name", "voucher_date", "debit", "company_id", "organization_id"]) {
      expect(text).not.toMatch(new RegExp(`"${column}"`));
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Comparisons in a single question
 * ══════════════════════════════════════════════════════════════════════════ */

describe("comparisons", () => {
  const compared = (mode, display, calculation = "total", extra = {}) => layout({
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation }],
    comparisons: [{ field: "amount.debit", mode, display, ...extra }],
    filters: [AUG_OCT],
  }, mode === "other_company" ? [CO_A, CO_B] : [CO_A]);

  test("A PERIOD COMPARISON WIDENS THE DATE FILTER AND MAKES EVERY FIGURE CONDITIONAL", () => {
    /* One query cannot have two date ranges. The range widens to cover both
       and each aggregation carries its own window — otherwise the "current"
       figure would quietly include the period it is being compared against. */
    const q = compile(compared("previous_period", "side_by_side"));
    const dateClause = q.query.filter.find((c) => Array.isArray(c) && c[0] === "between");
    const prior = previousPeriod(["2025-08-01", "2025-10-31"]);
    expect(dateClause.slice(2)).toEqual([prior[0], "2025-10-31"]);

    const aggs = q.query.aggregation;
    expect(aggs).toHaveLength(2);
    for (const agg of aggs) {
      expect(agg[0]).toBe("aggregation-options");
      expect(agg[1][0]).toBe("sum-where");
    }
    const heading = GROUP_BY_DEBIT().values[0].heading;
    expect(aggs[0][2]["display-name"]).toBe(heading);
    expect(aggs[1][2]["display-name"]).toBe(`${heading} — previous period`);
  });

  test("the windows are the ones the sheet compares", () => {
    const q = compile(compared("previous_period", "side_by_side"));
    const [current, prior] = q.query.aggregation.map((a) => a[1][2]);
    expect(current.slice(2)).toEqual(["2025-08-01", "2025-10-31"]);
    // The compiler's own shift, not a number typed twice: this is the same
    // function the sheet's comparison query uses.
    expect(prior.slice(2)).toEqual(previousPeriod(["2025-08-01", "2025-10-31"]));

    const lastYear = compile(compared("previous_year", "side_by_side"));
    expect(lastYear.query.aggregation[1][1][2].slice(2))
      .toEqual(previousYear(["2025-08-01", "2025-10-31"]));
  });

  test("a difference REPLACES the pair, as the sheet's columns do", () => {
    const q = compile(compared("previous_period", "difference"));
    const [, comparison] = q.query.aggregation;
    expect(comparison[1][0]).toBe("-");
    expect(comparison[2]["display-name"])
      .toBe(`${GROUP_BY_DEBIT().values[0].heading} — change vs previous period`);
  });

  test("A PERCENTAGE IS THE SHEET'S OWN ARITHMETIC, INCLUDING THE ABSOLUTE VALUE", () => {
    /* matrix.js computes ((current − prior) ÷ |prior|) × 100. Dividing by a
       signed prior instead would flip the sign of every change measured
       against a credit balance — and the chart would disagree with the sheet
       beside it without either being obviously wrong. */
    const q = compile(compared("previous_period", "percentage_difference"));
    const expr = q.query.aggregation[1][1];
    expect(expr[0]).toBe("*");
    expect(expr[2]).toBe(100);
    expect(expr[1][0]).toBe("/");
    expect(expr[1][2][0]).toBe("abs");
  });

  test("another company is compared by condition, inside the approved list", () => {
    const q = compile(compared("other_company", "side_by_side", "total", { with: CO_B }), [CO_A, CO_B]);
    const [, other] = q.query.aggregation;
    const condition = other[1][2];
    // The condition names the company; the tenant clause still names both, so
    // the query cannot reach a company the guard did not approve.
    expect(JSON.stringify(condition)).toContain(CO_B);
    expect(q.query.filter[2]).toEqual([
      "=", ["field", RESOLVED.fieldIds.company_id, null], CO_A, CO_B,
    ]);
  });

  test("A COUNT CAN BE COMPARED; AN AVERAGE CANNOT, AND SAYS SO", () => {
    expect(chartSupport(compared("previous_period", "difference", "count")).supported).toBe(true);

    const refused = chartSupport(compared("previous_period", "difference", "average"));
    expect(refused.supported).toBe(false);
    expect(refused.reason).toMatch(/comparison of an average cannot be drawn/i);
    // The reason is for a person: no engine, no function name, no version.
    expect(refused.reason).not.toMatch(/metabase|sum-where|avg|mbql|500/i);
  });

  test("and the compiler refuses to compile one rather than drawing something else", () => {
    expect(() => compile(compared("previous_period", "difference", "average")))
      .toThrow(/cannot be compared in a single chart/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Which charts suit which shape
 * ══════════════════════════════════════════════════════════════════════════ */

describe("supported visualizations", () => {
  const shapeOf = (l) => resultShape(l);

  test("a list of records is a table and only a table", () => {
    const l = layout({ rows: [{ field: "date.voucher" }, { field: "party.name" }], filters: [AUG_OCT] });
    expect(chartSupport(l).types).toEqual(["table"]);
  });

  test("one figure with nothing to group it by is a headline number", () => {
    const l = layout({ values: [{ field: "amount.debit", calculation: "total" }], filters: [AUG_OCT] });
    expect(chartSupport(l).types).toEqual(["scalar", "gauge", "progress", "table"]);
  });

  test("A DATE ON THE AXIS IS NEVER OFFERED AS A PIE", () => {
    const l = layout({ rows: [{ field: "date.month" }],
                       values: [{ field: "amount.debit", calculation: "total" }], filters: [AUG_OCT] });
    const types = chartSupport(l).types;
    expect(types[0]).toBe("line");
    expect(types).not.toContain("pie");
  });

  test("a category with one figure offers the shapes that read", () => {
    expect(chartSupport(GROUP_BY_DEBIT()).types).toEqual(
      ["bar", "row", "pie", "treemap", "funnel", "table"],
    );
  });

  test("two things to group by and two figures is a table, not a guess", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }], columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", calculation: "total" },
               { field: "amount.credit", calculation: "total" }],
      filters: [AUG_OCT],
    });
    expect(chartSupport(l).types).toEqual(["table", "pivot"]);
  });

  test("every type offered is one this engine accepts", () => {
    const shapes = [
      GROUP_BY_DEBIT(),
      layout({ rows: [{ field: "date.month" }], values: [{ field: "amount.debit", calculation: "total" }], filters: [AUG_OCT] }),
      layout({ values: [{ field: "amount.debit", calculation: "total" }], filters: [AUG_OCT] }),
    ];
    for (const l of shapes) {
      for (const type of chartSupport(l).types) expect(ALL_DISPLAYS).toContain(type);
    }
  });

  test("a table is always among them", () => {
    for (const dims of [0, 1, 2, 3]) {
      const shape = { mode: "summary", dimensions: Array.from({ length: dims }, () => ({ type: "text" })), metrics: [{}] };
      expect(supportedVisualizations(shape)).toContain("table");
    }
  });

  test("the shape counts one column per value AND per comparison", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "side_by_side" }],
      filters: [AUG_OCT],
    });
    const shape = shapeOf(l);
    expect(shape.metrics).toHaveLength(2);
    // Which is exactly how many aggregations the compiler emits.
    expect(compile(l).query.aggregation).toHaveLength(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * What the browser may ask for
 * ══════════════════════════════════════════════════════════════════════════ */

describe("visualization settings", () => {
  const ctx = (l = GROUP_BY_DEBIT()) => {
    const s = chartSupport(l);
    return { shape: s.shape, types: s.types, layout: l };
  };

  test("a chart the shape cannot support is refused, and the refusal helps", () => {
    try {
      validateVisualization({ type: "map" }, ctx());
      throw new Error("should have refused");
    } catch (err) {
      expect(err).toBeInstanceOf(VizError);
      expect(err.problems[0]).toMatch(/cannot be drawn as a map/);
      expect(err.problems[0]).toMatch(/bar, row/);
    }
  });

  test("AN UNKNOWN SETTING IS REFUSED, NOT IGNORED", () => {
    /* Dropped silently, a setting the user chose would simply not happen and
       they would have no way to tell. Refused, they are told. */
    for (const bad of [
      { type: "bar", onClick: "alert(1)" },
      { type: "bar", "click_behavior": { type: "link", linkTemplate: "http://x" } },
      { type: "bar", visualization_settings: { "card.title": "x" } },
      { type: "bar", dataset_query: { type: "native" } },
    ]) {
      expect(() => validateVisualization(bad, ctx())).toThrow(VizError);
    }
  });

  /** The sentence a refusal actually carries, which is on `problems`. */
  const problemsOf = (fn) => {
    try { fn(); } catch (err) { return err.problems.join(" "); }
    throw new Error("should have refused");
  };

  test("an axis can only name a field that is in the report", () => {
    expect(problemsOf(() => validateVisualization({ type: "bar", dimensions: ["amount.credit"] }, ctx())))
      .toMatch(/not in this report/);
    expect(problemsOf(() => validateVisualization({ type: "bar", metrics: ["ledger.name"] }, ctx())))
      .toMatch(/not in this report/);
  });

  test("a colour is chosen from a list, never sent", () => {
    expect(problemsOf(() => validateVisualization({ type: "bar", palette: "#ff0000" }, ctx())))
      .toMatch(/colour sets on offer/);
    const ok = validateVisualization({ type: "bar", palette: "ledger" }, ctx());
    expect(Object.values(ok.settings.series_settings)[0].color).toBe(PALETTES.ledger[0]);
  });

  test("a title is text and stays text", () => {
    const v = validateVisualization(
      { type: "bar", title: "  <script>alert(1)</script> Debit by group  " }, ctx());
    expect(v.settings["card.title"]).toBe("scriptalert(1)/script Debit by group");
    expect(v.settings["card.title"]).not.toMatch(/[<>]/);
  });

  test("THE SETTINGS SENT TO THE ENGINE ARE BUILT HERE, NOT PASSED THROUGH", () => {
    const v = validateVisualization({ type: "bar", showDataLabels: true, stacked: "stacked",
                                      xAxisLabel: "Group", yAxisLabel: "Rupees" }, ctx());
    expect(Object.keys(v.settings).sort()).toEqual([
      "graph.dimensions", "graph.metrics", "graph.show_values",
      "graph.x_axis.title_text", "graph.y_axis.title_text", "stackable.stack_type",
    ]);
    // The axes are named by MART COLUMN, which is why this mapping is server-side.
    expect(v.settings["graph.dimensions"]).toEqual(["group_name"]);
    expect(v.settings["graph.metrics"]).toEqual(["sum"]);
  });

  test("a comparison's columns are addressed by the names the compiler gave them", () => {
    const l = layout({
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", calculation: "total" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "side_by_side" }],
      filters: [AUG_OCT],
    });
    const v = validateVisualization({ type: "bar" }, ctx(l));
    const names = compile(l).query.aggregation.map((a) => a[2].name);
    expect(v.settings["graph.metrics"]).toEqual(names);
  });

  test("nothing chooses a default the shape does not support", () => {
    const detail = layout({ rows: [{ field: "date.voucher" }], filters: [AUG_OCT] });
    const v = validateVisualization(null, ctx(detail));
    expect(v.type).toBe("table");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The ticket
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the embed token", () => {
  const SECRET = "a-secret-that-is-not-the-accounting-one";
  const bridge = createChartBridge({
    siteUrl: "http://engine.invalid", apiKey: "query-key",
    adminApiKey: "admin-key", embeddingSecret: SECRET,
  });

  test("it expires within two minutes", () => {
    const decoded = jwt.decode(bridge.signEmbedToken(11));
    expect(decoded.exp - decoded.iat).toBe(TOKEN_TTL_SECONDS);
    expect(TOKEN_TTL_SECONDS).toBeLessThanOrEqual(120);
  });

  test("IT NAMES ONE QUESTION AND CARRIES NOTHING ELSE", () => {
    const decoded = jwt.decode(bridge.signEmbedToken(11));
    expect(decoded.resource).toEqual({ question: 11 });
    /* `params: {}` is load-bearing: a question with no declared parameters
       refuses every parameter, which is what makes the tenant filters inside
       its query unreachable from the browser. */
    expect(decoded.params).toEqual({});
    expect(Object.keys(decoded).sort()).toEqual(["exp", "iat", "params", "resource"]);
    expect(JSON.stringify(decoded)).not.toMatch(/company|organization|filter|key/i);
  });

  test("it is signed with the embedding secret and not the session secret", () => {
    const token = bridge.signEmbedToken(11);
    expect(() => jwt.verify(token, SECRET)).not.toThrow();
    expect(() => jwt.verify(token, process.env.JWT_SECRET || "test-jwt-secret")).toThrow();
  });

  test("a token for one question does not verify as another", () => {
    const a = jwt.decode(bridge.signEmbedToken(11));
    const b = jwt.decode(bridge.signEmbedToken(12));
    expect(a.resource.question).not.toBe(b.resource.question);
  });

  test("THE HASH SEPARATES TENANTS EVEN WHEN THE QUERY LOOKS THE SAME", () => {
    const query = { database: 2, type: "query", query: { "source-table": 41 } };
    const one = bridge.chartHash({ organizationId: ORG, companyIds: [CO_A], query, display: "bar", settings: {} });
    const other = bridge.chartHash({ organizationId: "6a073de21fecacc9bb714482", companyIds: [CO_A], query, display: "bar", settings: {} });
    const otherCompany = bridge.chartHash({ organizationId: ORG, companyIds: [CO_B], query, display: "bar", settings: {} });
    expect(one).not.toBe(other);
    expect(one).not.toBe(otherCompany);
  });

  test("the same chart asked for twice is the same hash", () => {
    const args = { organizationId: ORG, companyIds: [CO_B, CO_A],
                   query: { a: 1 }, display: "bar", settings: { "card.title": "x" } };
    expect(bridge.chartHash(args)).toBe(bridge.chartHash({ ...args, companyIds: [CO_A, CO_B] }));
  });

  test("a different chart type is a different question", () => {
    const args = { organizationId: ORG, companyIds: [CO_A], query: { a: 1 }, settings: {} };
    expect(bridge.chartHash({ ...args, display: "bar" }))
      .not.toBe(bridge.chartHash({ ...args, display: "line" }));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The administrator credential
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the one privileged call", () => {
  test("EVERY RUNTIME CALL USES THE QUERY KEY", async () => {
    const seen = [];
    const bridge = createChartBridge({
      siteUrl: "http://engine.invalid", apiKey: "query-key", adminApiKey: "ADMIN",
      embeddingSecret: "s".repeat(32),
      fetchImpl: async (url, init) => {
        seen.push({ url, key: init.headers["x-api-key"], method: init.method });
        const body = url.endsWith("/api/collection") && init.method === "GET" ? [] : { id: 5, name: "x" };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    });

    await bridge.archiveCard(5);
    await bridge.ensureCollection();
    expect(seen).not.toHaveLength(0);
    expect(seen.every((c) => c.key === "query-key")).toBe(true);
  });

  test("THE ADMIN CREDENTIAL HAS EXACTLY ONE CALL SITE", () => {
    /* Checked against the source, because the property worth protecting is not
       "it is used correctly today" but "there is one place to look". The
       runtime guard `assertKeyUse` refuses any other path or method; this
       makes a second call site visible in review rather than in an audit log. */
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "services", "reporting", "metabaseCharts.service.js"),
      "utf8",
    );
    // Comments stripped: the file EXPLAINS the exception as well as making it,
    // and an explanation is not a call site.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    const callSites = code.match(/admin:\s*true/g) || [];
    expect(callSites).toHaveLength(1);
    const line = code.split("\n").find((l) => /admin:\s*true/.test(l));
    expect(line).toMatch(/enable_embedding/);
    expect(line).toMatch(/PUT/);
    // And the guard that enforces it at runtime is still there.
    expect(source).toMatch(/function assertKeyUse/);
    expect(source).toMatch(/method !== "PUT" \|\| !\/\^\\\/api\\\/card/);
  });
});
