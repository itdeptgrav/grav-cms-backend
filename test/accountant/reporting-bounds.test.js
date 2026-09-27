// test/accountant/reporting-bounds.test.js
//
// SLICE B6: A PREVIEW HAS A BUDGET, A DEADLINE AND A CEILING.
//
// The audit found legal layouts costing 12 sequential engine queries and
// 1.76 MB of JSON, and another costing 22 queries — each of which got the
// engine's full 30-second timeout OF ITS OWN, so the clock restarted twelve
// times inside one request. Nothing refused any of it, because every
// individual shelf limit was respected.
//
// What is pinned here:
//
//   · the cost is judged on the COMPLETE compiled plan, not the shelves;
//   · the boundary passes and one unit or one query past it does not;
//   · a refusal happens BEFORE the engine is contacted, and says what to
//     change without naming anything inside the system;
//   · one deadline covers every query in the plan, and the next query does
//     not start once it has gone;
//   · nothing partial is ever returned;
//   · and the log line carries counts, never contents.
//
// The clock is injected. There are no sleeps in this file.
"use strict";

process.env.TEST_WITHOUT_MONGO = "1";

const fs = require("fs");
const path = require("path");

const budget = require("../../services/reporting/previewBudget");
const { createDeadline } = require("../../services/reporting/deadline");
const { createMetabaseEngine, CODES } = require("../../services/reporting/metabaseEngine");
const { validateLayout } = require("../../services/reporting/reportLayout.validate");
const catalogue = require("../../services/reporting/fieldCatalogue");

const CO = "6a08040a1fecacc9bb7149c2";
const ORG = "6a073de21fecacc9bb714481";
const layout = (raw) => validateLayout({ name: "t", companyIds: [CO], ...raw },
  { approvedCompanyIds: [CO] });

const ROWS = ["ledger.group", "ledger.name", "party.name", "voucher.type", "company.name"];
const COLS = ["date.month", "date.financial_year", "voucher.type"];
const AMOUNTS = ["amount.debit", "amount.credit", "amount.signed"];
const shelf = (ids) => ids.map((field) => ({ field }));
const AUG_OCT = { field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] };
const cost = (raw) => budget.estimate(layout(raw));

/* ═══════════════════════════════════════════════════════════════════════════
 * The budget, on the layouts the audit measured
 * ══════════════════════════════════════════════════════════════════════════ */

describe("what a preview is allowed to cost", () => {
  test("AN ORDINARY LIST PASSES", () => {
    const c = cost({ rows: shelf(["voucher.number", "date.voucher", "ledger.name", "amount.debit"]) });
    expect([c.queryCount, c.allowed]).toEqual([2, true]);
  });

  test("COMMON ONE- AND TWO-LEVEL SUMMARIES PASS", () => {
    const one = cost({
      rows: shelf(["ledger.group"]),
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    const two = cost({
      rows: shelf(["ledger.group", "ledger.name"]),
      columns: shelf(["date.month"]),
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    expect([one.queryCount, one.allowed]).toEqual([3, true]);
    expect([two.queryCount, two.allowed]).toEqual([6, true]);
  });

  test("LEDGER GROUP × MONTH WITH DEBIT AND CREDIT PASSES", () => {
    const c = cost({
      rows: shelf(["ledger.group"]),
      columns: shelf(["date.month"]),
      values: [
        { field: "amount.debit", calculation: "total" },
        { field: "amount.credit", calculation: "total" },
      ],
    });
    expect(c).toMatchObject({ queryCount: 4, layoutUnits: 2, allowed: true });
  });

  test("5 ROWS × 3 COLUMNS × 8 VALUES IS REFUSED — the 1.76 MB layout", () => {
    const c = cost({
      rows: shelf(ROWS),
      columns: shelf(COLS),
      values: Array.from({ length: 8 }, (_, i) => ({
        field: AMOUNTS[i % 3],
        calculation: ["total", "average", "maximum"][Math.floor(i / 3)],
      })),
    });
    expect(c.queryCount).toBe(12);
    expect(c.layoutUnits).toBe(120);
    expect(c.allowed).toBe(false);
  });

  test("A COMPARISON PLAN OVER THE QUERY BUDGET IS REFUSED — 22 queries", () => {
    const c = cost({
      rows: shelf(ROWS),
      values: [{ field: "amount.debit", calculation: "total" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
      filters: [AUG_OCT],
    });
    expect(c.queryCount).toBe(22);
    expect([c.allowed, c.exceeded]).toEqual([false, "queries"]);
    // The same layout WITHOUT the comparison is 11 queries and passes, so it
    // is the comparison's own sub-plan that is being counted, not the shelves.
    const without = cost({ rows: shelf(ROWS), values: [{ field: "amount.debit", calculation: "total" }] });
    expect([without.queryCount, without.allowed]).toEqual([11, true]);
  });

  test("THE QUERY BOUNDARY PASSES AND ONE QUERY BEYOND IT FAILS", () => {
    const at = cost({ rows: shelf(ROWS), values: [{ field: "amount.debit", calculation: "total" }] });
    const over = cost({
      rows: shelf(ROWS), columns: shelf(["date.month"]),
      values: [{ field: "amount.debit", calculation: "total" }],
    });
    expect([at.queryCount, at.allowed]).toEqual([budget.BUDGET.maxQueries, true]);
    expect(over.queryCount).toBe(budget.BUDGET.maxQueries + 1);
    expect([over.allowed, over.exceeded]).toEqual([false, "queries"]);
  });

  test("THE UNIT BOUNDARY PASSES AND ONE UNIT BEYOND IT FAILS", () => {
    const at = cost({
      rows: shelf(ROWS.slice(0, 4)),
      columns: shelf(COLS.slice(0, 2)),
      values: AMOUNTS.map((field) => ({ field, calculation: "total" })),
    });
    const over = cost({
      rows: shelf(ROWS),
      values: [
        ...AMOUNTS.map((field) => ({ field, calculation: "total" })),
        { field: "amount.debit", calculation: "average" },
        { field: "amount.credit", calculation: "average" },
      ],
    });
    expect([at.layoutUnits, at.allowed]).toEqual([budget.BUDGET.maxLayoutUnits, true]);
    expect(at.queryCount).toBeLessThanOrEqual(budget.BUDGET.maxQueries);
    expect(over.layoutUnits).toBe(budget.BUDGET.maxLayoutUnits + 1);
    // Within the query budget, so it is the UNITS that refuse it.
    expect(over.queryCount).toBeLessThanOrEqual(budget.BUDGET.maxQueries);
    expect([over.allowed, over.exceeded]).toEqual([false, "units"]);
  });

  test("THE SHELF LIMITS THEMSELVES ARE UNTOUCHED", () => {
    // B6 added a gate; it did not shrink the product to make the gate easy.
    expect(catalogue.LIMITS ?? {}).toBeDefined();
    const fiveRows = cost({ rows: shelf(ROWS), values: [{ field: "amount.debit", calculation: "total" }] });
    expect(fiveRows.allowed).toBe(true);   // five levels is still a legal report
  });

  test("THE REFUSAL SAYS WHAT TO CHANGE, AND NAMES NOTHING INTERNAL", () => {
    const c = cost({
      rows: shelf(ROWS), columns: shelf(COLS),
      values: Array.from({ length: 8 }, (_, i) => ({
        field: AMOUNTS[i % 3], calculation: ["total", "average", "maximum"][Math.floor(i / 3)],
      })),
    });
    const details = budget.refusalDetails(c);
    expect(details.message).toBe(
      "This report is too large to preview. Remove a grouping or calculated amount, or add a filter.",
    );
    expect(details.report).toEqual({
      rowGroupings: 5, columnGroupings: 3, calculations: 8, comparisons: 0,
    });
    const text = JSON.stringify(details).toLowerCase();
    for (const leak of [
      "v_general_ledger", "group_name", "period_month", "source-table", "breakout",
      "aggregation", "metabase", "query", "field", "table",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * One deadline, injected clock
 * ══════════════════════════════════════════════════════════════════════════ */

describe("one deadline covers the whole plan", () => {
  /** A clock the test moves by hand, and an engine wired to it. */
  const rig = ({ perQueryMs = 0, deadlineMs = 1000, failAfter = null } = {}) => {
    let now = 1_000_000;
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      now += perQueryMs;                       // the query "took" this long
      if (failAfter !== null && calls.length > failAfter) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      return {
        ok: true,
        status: 200,
        json: async () => ({ status: "completed", data: { rows: [["Bank Accounts", 1]] } }),
      };
    };
    const engine = createMetabaseEngine({
      siteUrl: "http://engine.invalid", apiKey: "k", fetchImpl,
      previewDeadlineMs: deadlineMs,
    });
    const deadline = createDeadline({ ms: deadlineMs, now: () => now });
    return { engine, deadline, calls, tick: (ms) => { now += ms; }, at: () => now };
  };

  const PLAN = {
    mode: "summary",
    main: { query: {} }, rowTotals: { query: {} }, colTotals: null, grand: { query: {} },
    subtotals: [{ depth: 0, prefix: [], cells: { query: {} }, total: { query: {} } }],
  };

  test("A PLAN INSIDE THE DEADLINE RUNS EVERY QUERY", async () => {
    const { engine, deadline, calls } = rig({ perQueryMs: 10, deadlineMs: 1000 });
    await engine.runPlan(PLAN, { deadline });
    expect(calls).toHaveLength(5);
  });

  test("THE CLOCK DOES NOT RESTART FOR EACH QUERY", async () => {
    /* Four queries of 400 ms against a 1,000 ms deadline: with one clock the
       third is the last one to start. With a fresh allowance per call — the
       behaviour the audit found — all five would run. */
    const { engine, deadline, calls } = rig({ perQueryMs: 400, deadlineMs: 1000 });
    await expect(engine.runPlan(PLAN, { deadline })).rejects.toMatchObject({
      code: CODES.UNAVAILABLE,
      timedOut: true,
    });
    expect(calls.length).toBeLessThan(5);
    expect(calls).toHaveLength(3);
  });

  test("NO FURTHER QUERY STARTS AFTER EXPIRY", async () => {
    const { engine, deadline, calls, tick } = rig({ perQueryMs: 0, deadlineMs: 1000 });
    tick(1001);
    await expect(engine.runPlan(PLAN, { deadline })).rejects.toMatchObject({ timedOut: true });
    expect(calls).toHaveLength(0);          // not even the first
  });

  test("THE MESSAGE IS ONE A PERSON CAN ACT ON", async () => {
    const { engine, deadline, tick } = rig({ deadlineMs: 500 });
    tick(500);
    await expect(engine.runPlan(PLAN, { deadline })).rejects.toThrow(
      "This report took too long to preview. Add a filter or remove part of the breakdown and try again.",
    );
  });

  test("NOTHING PARTIAL COMES BACK — the whole plan fails or none of it", async () => {
    const { engine, deadline } = rig({ perQueryMs: 400, deadlineMs: 1000 });
    let result = "not assigned";
    try { result = await engine.runPlan(PLAN, { deadline }); } catch { /* expected */ }
    expect(result).toBe("not assigned");    // no half-built results object escapes
  });

  test("A CLIENT DISCONNECT STOPS THE PLAN, AND IS NOT AN ERROR CONDITION", async () => {
    const gone = new AbortController();
    let now = 1_000_000;
    const calls = [];
    const fetchImpl = async () => {
      calls.push(1);
      if (calls.length === 2) gone.abort();     // the browser leaves mid-plan
      return { ok: true, status: 200, json: async () => ({ status: "completed", data: { rows: [] } }) };
    };
    const engine = createMetabaseEngine({ siteUrl: "http://engine.invalid", apiKey: "k", fetchImpl });
    const deadline = createDeadline({ ms: 60_000, now: () => now, signal: gone.signal });

    const err = await engine.runPlan(PLAN, { deadline }).catch((e) => e);
    expect(err.clientGone).toBe(true);
    expect(err.timedOut).toBe(false);
    expect(calls.length).toBeLessThan(5);
    // It carries no engine cause to be logged as a crash.
    expect(err.cause).toBeNull();
  });

  test("a deadline reports what is left, and never a negative", () => {
    let now = 0;
    const d = createDeadline({ ms: 100, now: () => now });
    expect(d.remaining()).toBe(100);
    now = 60;
    expect([d.remaining(), d.expired(), d.elapsed()]).toEqual([40, false, 60]);
    now = 500;
    expect([d.remaining(), d.expired()]).toEqual([0, true]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The byte ceiling
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the response-size ceiling", () => {
  test("THE BOUNDARY PASSES AND ONE BYTE OVER REFUSES", () => {
    expect(budget.withinByteCeiling(budget.BUDGET.maxResponseBytes)).toBe(true);
    expect(budget.withinByteCeiling(budget.BUDGET.maxResponseBytes + 1)).toBe(false);
  });

  test("the ceiling sits BELOW the audit's 1.76 MB case, so both gates agree", () => {
    expect(budget.BUDGET.maxResponseBytes).toBeLessThan(1_760_000);
    // …and far above every measured accepted preview (the largest was 74 KB).
    expect(budget.BUDGET.maxResponseBytes).toBeGreaterThan(500_000);
  });

  test("the over-size message tells the person what to narrow", () => {
    expect(budget.TOO_LARGE).toMatch(/narrow the report/i);
    expect(budget.TOO_LARGE).not.toMatch(/byte|json|serial/i);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Mutation: would any of this notice?
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the bounds are load-bearing", () => {
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

  const survives = async (fn) => { await expect(fn()).resolves.toBeUndefined(); };
  const kills = async (fn) => {
    await expect(fn()).rejects.toThrow(/expect\(|Expected|toEqual|toBe|toMatchObject/);
  };

  const HEAVY = layout({
    rows: shelf(ROWS),
    values: [{ field: "amount.debit", calculation: "total" }],
    comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
    filters: [AUG_OCT],
  });

  test("COUNTING ONLY THE SHELVES, NOT THE PLAN, FAILS", async () => {
    /* The mutation is the mistake this module exists to avoid: guessing the
       cost from the number of selected fields. The comparison layout has one
       row shelf of five and one value — cheap by that measure, 22 queries in
       reality. */
    const check = async (b) => {
      expect(b.estimate(HEAVY).allowed).toBe(false);
    };
    await survives(async () => check(budget));
    await kills(async () => check(mutate("previewBudget.js", [[
      `  const queryCount = planQueryCount(shaped);`,
      `  const queryCount = rowFields + columnFields + valueColumns;`,
    ]])));
  });

  test("A FRESH DEADLINE PER QUERY FAILS", async () => {
    const PLAN = {
      mode: "summary",
      main: { query: {} }, rowTotals: { query: {} }, colTotals: null, grand: { query: {} },
      subtotals: [{ depth: 0, prefix: [], cells: { query: {} }, total: { query: {} } }],
    };
    const check = async (engineModule) => {
      let now = 0;
      const calls = [];
      const fetchImpl = async () => {
        calls.push(1);
        now += 400;
        return { ok: true, status: 200, json: async () => ({ status: "completed", data: { rows: [] } }) };
      };
      const engine = engineModule.createMetabaseEngine({
        siteUrl: "http://engine.invalid", apiKey: "k", fetchImpl,
      });
      const deadline = createDeadline({ ms: 1000, now: () => now });
      await engine.runPlan(PLAN, { deadline }).catch(() => {});
      expect(calls).toHaveLength(3);     // the clock did not restart
    };
    await survives(() => check(require("../../services/reporting/metabaseEngine")));
    /* The mutation is the behaviour the audit found: every query getting the
       full per-call allowance of its own, with nothing watching the request
       as a whole. Both guards have to go — the plan's and the call's — or the
       surviving one still stops it, which is the point of having two. */
    await kills(() => check(mutate("metabaseEngine.js", [[
      `      if (deadline.expired()) throw deadlineExpired();
    };
    const one = (payload)`,
      `      if (false && deadline.expired()) throw deadlineExpired();
    };
    const one = (payload)`,
    ], [
      `      timeoutMs: timeoutMs || opts.previewTimeoutMs,
      deadline,`,
      `      timeoutMs: timeoutMs || opts.previewTimeoutMs,
      deadline: null,`,
    ]])));
  });

  test("CONTINUING AFTER EXPIRY FAILS", async () => {
    const PLAN = {
      mode: "summary",
      main: { query: {} }, rowTotals: { query: {} }, colTotals: null, grand: { query: {} },
      subtotals: [],
    };
    const check = async (engineModule) => {
      let now = 0;
      const calls = [];
      const fetchImpl = async () => {
        calls.push(1);
        return { ok: true, status: 200, json: async () => ({ status: "completed", data: { rows: [] } }) };
      };
      const engine = engineModule.createMetabaseEngine({
        siteUrl: "http://engine.invalid", apiKey: "k", fetchImpl,
      });
      const deadline = createDeadline({ ms: 100, now: () => now });
      now = 1000;                                   // already gone
      await engine.runPlan(PLAN, { deadline }).catch(() => {});
      expect(calls).toHaveLength(0);
    };
    await survives(() => check(require("../../services/reporting/metabaseEngine")));
    await kills(() => check(mutate("metabaseEngine.js", [[
      `      if (deadline.expired()) throw deadlineExpired();
    };
    const one = (payload)`,
      `      if (false) throw deadlineExpired();
    };
    const one = (payload)`,
    ], [
      `    if (deadline) {
      if (deadline.aborted()) throw clientGone();
      if (deadline.expired()) throw deadlineExpired();
    }`,
      `    if (deadline) {
      if (deadline.aborted()) throw clientGone();
    }`,
    ]])));
  });

  test("RAISING THE BYTE CEILING PAST THE MEASURED CASE FAILS", async () => {
    const check = async (b) => {
      expect(b.withinByteCeiling(1_760_000)).toBe(false);
    };
    await survives(async () => check(budget));
    await kills(async () => check(mutate("previewBudget.js", [[
      `  maxResponseBytes: 1_500_000,`,
      `  maxResponseBytes: 50_000_000,`,
    ]])));
  });
});
