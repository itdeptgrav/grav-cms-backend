// test/accountant/reporting-bounds.route.test.js
//
// SLICE B6, AT THE ROUTE: the gate, the deadline, the ceiling and the log,
// against the REAL middleware chain and a fake engine that counts calls.
//
// The pure suite (reporting-bounds.test.js) proves what the budget decides and
// how the deadline behaves. Only this one can prove the thing that matters
// operationally: that a refusal happens with the engine NEVER CONTACTED, and
// in the right order — an unowned company is refused before anybody works out
// whether its report would have been expensive.
//
// The last block copies the route module, mutates one line, mounts the copy,
// and requires these tests to die.
"use strict";

require("dotenv").config();
process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_reporting_bounds";

const fs = require("fs");
const path = require("path");
const express = require("express");

const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { ReportingError, CODES } = require("../../services/reporting/metabaseEngine");
const budget = require("../../services/reporting/previewBudget");

const ROUTES = path.join(__dirname, "..", "..", "routes", "Accountant_Routes");
const reportingRouter = require("../../routes/Accountant_Routes/Acc_reporting");

let server, origin, logSpy, errorSpy;
let engineCalls = [];
/** "ok" | "deadline" | "client-gone" | "huge" | "at-ceiling" */
let engineBehaviour = "ok";

/** A matrix whose serialized body is EXACTLY `bytes` long. */
function matrixOfSize(bytes) {
  const base = {
    mode: "summary",
    columnLevels: [{ heading: "", headers: [{ label: "Debit", span: 1 }] }],
    leafColumns: [{ id: "[]::amount.debit:total", heading: "Debit", type: "money", isTotal: false, isComparison: false }],
    rowLevels: [{ heading: "Ledger Group" }],
    rows: [],
    grandTotal: null,
    previewRowCount: 0,
    groupCount: 0,
    totalRowCount: 0,
    truncated: false,
    omitted: null,
    dataAsOf: null,
  };
  const row = (i, label) => ({
    kind: "data", depth: 0, labels: [label ?? `Ledger ${i}`], keys: [`L${i}`],
    cells: [{ value: i, display: "money" }],
  });
  const length = () => Buffer.byteLength(JSON.stringify(base));

  // Fill to just under, then make the last label carry the remainder exactly.
  while (length() < bytes - 400) base.rows.push(row(base.rows.length + 1));
  base.rows.push(row(base.rows.length + 1, ""));
  base.previewRowCount = base.rows.length;
  base.groupCount = base.rows.length;
  base.totalRowCount = base.rows.length;
  const short = bytes - length();
  if (short < 0) throw new Error(`matrixOfSize overshot by ${-short}`);
  base.rows[base.rows.length - 1].labels[0] = "x".repeat(short);
  if (length() !== bytes) throw new Error(`matrixOfSize produced ${length()} not ${bytes}`);
  return base;
}

function fakeEngine() {
  return {
    isConfigured: () => true,
    previewDeadlineMs: 20_000,
    async runPreview(args) {
      engineCalls.push({ kind: "preview", ...args });
      if (engineBehaviour === "deadline") {
        throw new ReportingError(
          CODES.UNAVAILABLE,
          "This report took too long to preview. Add a filter or remove part of the breakdown and try again.",
          { status: 504, timedOut: true },
        );
      }
      if (engineBehaviour === "client-gone") {
        throw new ReportingError(CODES.UNAVAILABLE, "The preview was cancelled.", {
          status: 499, clientGone: true,
        });
      }
      if (engineBehaviour === "huge") return matrixOfSize(budget.BUDGET.maxResponseBytes + 1);
      if (engineBehaviour === "at-ceiling") return matrixOfSize(budget.BUDGET.maxResponseBytes);
      return {
        mode: args.layout.mode,
        columnLevels: [], leafColumns: [], rowLevels: [],
        rows: [{ kind: "data", depth: 0, labels: ["x"], keys: ["x"], cells: [] }],
        grandTotal: null,
        previewRowCount: 1, groupCount: 1, totalRowCount: 1, truncated: false, omitted: null,
        dataAsOf: null,
      };
    },
    async runExport() { throw new Error("not used here"); },
    async metadata() { return { databaseId: 1, views: {} }; },
    async refreshMetadata() { return { databaseId: 1, views: {} }; },
  };
}

beforeAll(async () => {
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  reportingRouter.setEngine(fakeEngine());
  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use("/api/accountant/reporting", reportingRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  jest.restoreAllMocks();
  await new Promise((r) => server.close(r));
});

beforeEach(() => { engineCalls = []; engineBehaviour = "ok"; logSpy.mockClear(); errorSpy.mockClear(); });

async function call(body, { at = origin, bearer } = {}) {
  const res = await fetch(`${at}/api/accountant/reporting/preview`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed, bytes: Buffer.byteLength(text), headers: res.headers };
}

let seq = 0;
async function scenario(companyCount = 1) {
  const companies = [];
  for (let i = 0; i < companyCount; i += 1) {
    companies.push(await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2025-04-01") }));
  }
  const org = await Acc_Organization.create({ name: `Org ${++seq}`, tallyCompanyIds: companies.map((c) => c._id) });
  const user = new Acc_User({ organizationId: org._id, name: `U${++seq}`, email: `u${seq}@e.com`, role: "owner" });
  await user.setPassword("a-long-enough-password");
  await user.save();
  return { org, user, bearer: signOrgToken(user), companyId: String(companies[0]._id) };
}

const ROWS = ["ledger.group", "ledger.name", "party.name", "voucher.type", "company.name"];
const COLS = ["date.month", "date.financial_year", "voucher.type"];
const AMOUNTS = ["amount.debit", "amount.credit", "amount.signed"];
const shelf = (ids) => ids.map((field) => ({ field }));

const SIMPLE = (companyIds) => ({
  name: "Untitled report", companyIds,
  rows: [{ field: "ledger.group" }],
  values: [{ field: "amount.debit", calculation: "total" }],
  filters: [], limit: 100,
});
const LIST = (companyIds) => ({
  name: "A list", companyIds,
  rows: shelf(["voucher.number", "date.voucher", "ledger.name", "amount.debit"]),
  filters: [], limit: 100,
});
const MONTHLY = (companyIds) => ({
  name: "Monthly", companyIds,
  rows: [{ field: "ledger.group" }], columns: [{ field: "date.month" }],
  values: [
    { field: "amount.debit", calculation: "total" },
    { field: "amount.credit", calculation: "total" },
  ],
  filters: [], limit: 100,
});
/** 5 × 3 × 8 — the audit's 1.76 MB layout, 12 queries. */
const HUGE = (companyIds) => ({
  name: "Everything", companyIds,
  rows: shelf(ROWS), columns: shelf(COLS),
  values: Array.from({ length: 8 }, (_, i) => ({
    field: AMOUNTS[i % 3], calculation: ["total", "average", "maximum"][Math.floor(i / 3)],
  })),
  filters: [], limit: 100,
});
/** 5 rows + one comparison — 22 queries. */
const COMPARED = (companyIds) => ({
  name: "Compared", companyIds,
  rows: shelf(ROWS),
  values: [{ field: "amount.debit", calculation: "total" }],
  comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
  filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
  limit: 100,
});
/** 4 × 2 × 3 = 24 units, 10 queries: the boundary, both ways. */
const AT_BOUNDARY = (companyIds) => ({
  name: "Boundary", companyIds,
  rows: shelf(ROWS.slice(0, 4)), columns: shelf(COLS.slice(0, 2)),
  values: AMOUNTS.map((field) => ({ field, calculation: "total" })),
  filters: [], limit: 100,
});
/** One unit past it: 5 × 1 × 5 = 25, still 11 queries. */
const ONE_OVER = (companyIds) => ({
  name: "One over", companyIds,
  rows: shelf(ROWS),
  values: [
    ...AMOUNTS.map((field) => ({ field, calculation: "total" })),
    { field: "amount.debit", calculation: "average" },
    { field: "amount.credit", calculation: "average" },
  ],
  filters: [], limit: 100,
});

const lastPreviewLog = () => {
  const line = [...logSpy.mock.calls].reverse().find((c) => c[0] === "[reporting/preview]");
  return line ? JSON.parse(line[1]) : null;
};

/* ═══════════════════════════════════════════════════════════════════════════
 * What passes, and what is refused before the engine
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the complexity gate", () => {
  test("A NORMAL DETAIL PREVIEW PASSES", async () => {
    const s = await scenario();
    const r = await call(LIST([s.companyId]), { bearer: s.bearer });
    expect(r.status).toBe(200);
    expect(engineCalls).toHaveLength(1);
  });

  test("A COMMON MONTHLY SUMMARY PASSES", async () => {
    const s = await scenario();
    const r = await call(MONTHLY([s.companyId]), { bearer: s.bearer });
    expect(r.status).toBe(200);
    expect(engineCalls).toHaveLength(1);
  });

  test("THE BOUNDARY LAYOUT PASSES", async () => {
    const s = await scenario();
    const r = await call(AT_BOUNDARY([s.companyId]), { bearer: s.bearer });
    expect(r.status).toBe(200);
    expect(lastPreviewLog()).toMatchObject({ outcome: "ok", layoutUnits: budget.BUDGET.maxLayoutUnits });
  });

  test("ONE UNIT OVER THE BOUNDARY IS 422, BEFORE THE ENGINE RUNS", async () => {
    const s = await scenario();
    const r = await call(ONE_OVER([s.companyId]), { bearer: s.bearer });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(engineCalls).toHaveLength(0);
    expect(r.body.message).toBe(
      "This report is too large to preview. Remove a grouping or calculated amount, or add a filter.",
    );
    expect(r.body.report).toEqual({ rowGroupings: 5, columnGroupings: 0, calculations: 5, comparisons: 0 });
  });

  test("THE 1.76 MB LAYOUT IS REFUSED BEFORE THE ENGINE RUNS", async () => {
    const s = await scenario();
    const r = await call(HUGE([s.companyId]), { bearer: s.bearer });
    expect(r.status).toBe(422);
    expect(engineCalls).toHaveLength(0);
  });

  test("A QUERY-HEAVY COMPARISON IS REFUSED BEFORE THE ENGINE RUNS", async () => {
    const s = await scenario();
    const r = await call(COMPARED([s.companyId]), { bearer: s.bearer });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(engineCalls).toHaveLength(0);
    expect(lastPreviewLog()).toMatchObject({ outcome: "refused", refusedBy: "complexity", queryCount: 22 });
  });

  test("A REFUSAL NAMES NOTHING INSIDE THE SYSTEM", async () => {
    const s = await scenario();
    const r = await call(HUGE([s.companyId]), { bearer: s.bearer });
    const text = JSON.stringify(r.body).toLowerCase();
    for (const leak of [
      "v_general_ledger", "group_name", "period_month", "source-table", "breakout",
      "aggregation", "metabase", "mbql", "api_key", "select ", "database",
    ]) {
      expect(text).not.toContain(leak);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Security comes first, always
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the order of the gates", () => {
  test("AN UNOWNED COMPANY IS 403 WITH NO ENGINE CALL — even when the layout is also too big", async () => {
    /* And the 403 must not hint that the report was expensive: a person
       probing another organisation's data learns nothing about its shape. */
    const s = await scenario();
    const theirs = await Acc_Company.create({ companyName: "Someone else's", booksFromDate: new Date("2025-04-01") });

    for (const body of [HUGE([String(theirs._id)]), HUGE([s.companyId, String(theirs._id)])]) {
      engineCalls = [];
      const r = await call(body, { bearer: s.bearer });
      expect([r.status, r.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
      expect(engineCalls).toHaveLength(0);
      expect(JSON.stringify(r.body)).not.toMatch(/too large|grouping|calculation/i);
      expect(r.body.report).toBeUndefined();
    }
  });

  test("an invalid layout is refused before the cost is even computed", async () => {
    const s = await scenario();
    const r = await call({ ...SIMPLE([s.companyId]), rows: [{ field: "group_name" }] }, { bearer: s.bearer });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(r.body.problems).toBeDefined();          // the validator's sentences
    expect(r.body.report).toBeUndefined();          // not the budget's refusal
    expect(engineCalls).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Deadline and size, as the caller sees them
 * ══════════════════════════════════════════════════════════════════════════ */

describe("what a caller is told", () => {
  test("A DEADLINE BECOMES AN ACTIONABLE REPORTING_UNAVAILABLE", async () => {
    const s = await scenario();
    engineBehaviour = "deadline";
    const r = await call(SIMPLE([s.companyId]), { bearer: s.bearer });
    expect([r.status, r.body.code]).toEqual([504, "REPORTING_UNAVAILABLE"]);
    expect(r.body.message).toBe(
      "This report took too long to preview. Add a filter or remove part of the breakdown and try again.",
    );
    // Nothing partial: no rows, no totals, no comparisons.
    expect(r.body.rows).toBeUndefined();
    expect(r.body.grandTotal).toBeUndefined();
    expect(lastPreviewLog()).toMatchObject({ outcome: "refused", refusedBy: "deadline" });
  });

  test("A CANCELLED PREVIEW IS NOT LOGGED AS A CRASH", async () => {
    const s = await scenario();
    engineBehaviour = "client-gone";
    await call(SIMPLE([s.companyId]), { bearer: s.bearer }).catch(() => null);
    expect(lastPreviewLog()).toMatchObject({ outcome: "cancelled", refusedBy: "client" });
    expect(errorSpy).not.toHaveBeenCalled();
  });

  test("A RESPONSE AT THE CEILING IS SENT WHOLE", async () => {
    const s = await scenario();
    engineBehaviour = "at-ceiling";
    const r = await call(SIMPLE([s.companyId]), { bearer: s.bearer });
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(budget.BUDGET.maxResponseBytes);
    expect(lastPreviewLog()).toMatchObject({ outcome: "ok", bytes: budget.BUDGET.maxResponseBytes });
  });

  test("ONE BYTE OVER IT IS REFUSED WHOLE — never trimmed to fit", async () => {
    const s = await scenario();
    engineBehaviour = "huge";
    const r = await call(SIMPLE([s.companyId]), { bearer: s.bearer });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(r.body.message).toMatch(/narrow the report/i);
    expect(r.body.rows).toBeUndefined();
    expect(r.bytes).toBeLessThan(1000);             // a refusal, not a trimmed report
    expect(lastPreviewLog()).toMatchObject({
      outcome: "refused", refusedBy: "size", bytes: budget.BUDGET.maxResponseBytes + 1,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Telemetry
 * ══════════════════════════════════════════════════════════════════════════ */

describe("one line per preview", () => {
  test("IT CARRIES THE SAFE METRICS", async () => {
    const s = await scenario();
    const r = await call(MONTHLY([s.companyId]), { bearer: s.bearer });
    expect(r.status).toBe(200);
    const line = lastPreviewLog();
    expect(Object.keys(line).sort()).toEqual([
      "bytes", "columnFields", "comparisons", "layoutUnits", "mode", "ms",
      "outcome", "previewRowCount", "queryCount", "refusedBy", "rowFields", "values",
    ]);
    expect(line).toMatchObject({
      outcome: "ok", mode: "summary", queryCount: 4,
      rowFields: 1, columnFields: 1, values: 2, comparisons: 0, previewRowCount: 1,
    });
    expect(line.bytes).toBeGreaterThan(0);
    expect(typeof line.ms).toBe("number");
  });

  test("ONE REQUEST PRODUCES ONE LINE, NOT ONE PER QUERY", async () => {
    const s = await scenario();
    await call(MONTHLY([s.companyId]), { bearer: s.bearer });
    const lines = logSpy.mock.calls.filter((c) => c[0] === "[reporting/preview]");
    expect(lines).toHaveLength(1);
  });

  test("IT CARRIES NO LAYOUT VALUE, NO FIGURE AND NO ENGINE VOCABULARY", async () => {
    const s = await scenario();
    await call({
      ...MONTHLY([s.companyId]),
      name: "Mayfair Hotels reconciliation",
      filters: [{ field: "party.name", operation: "is", value: "M/s Mayfair Hotels & Resorts Ltd." }],
    }, { bearer: s.bearer });

    const text = JSON.stringify(lastPreviewLog()).toLowerCase();
    for (const secret of [
      "mayfair", "reconciliation", "party", "ledger", "amount.debit", "is",
      "v_general_ledger", "group_name", "period_month", "breakout", "metabase",
      "api_key", "select ", String(s.companyId).toLowerCase(),
    ]) {
      if (secret === "is") continue;                 // too short to be meaningful
      expect(text).not.toContain(secret);
    }
    // …and no figure from the result, either.
    expect(text).not.toContain("cells");
    expect(text).not.toContain("labels");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Mutation: the ORDER is the thing, and orders are easy to break
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the route's order is load-bearing", () => {
  const written = [];
  const mounted = [];

  /** Copy the route module beside itself, edit it, mount it, return its origin. */
  const mutantRoute = async (edits) => {
    const source = fs.readFileSync(path.join(ROUTES, "Acc_reporting.js"), "utf8");
    let mutated = source;
    for (const [find, replace] of edits) {
      if (!mutated.includes(find)) {
        throw new Error(`Mutation target not found:\n${find}\nThe route moved — re-point the mutation.`);
      }
      mutated = mutated.replace(find, replace);
    }
    expect(mutated).not.toBe(source);
    const file = path.join(ROUTES, `__mutant_${Date.now()}_${written.length}__.js`);
    fs.writeFileSync(file, mutated);
    written.push(file);

    const router = require(file);
    router.setEngine(fakeEngine());
    const app = express();
    app.use(express.json({ limit: "10mb" }));
    app.use("/api/accountant/reporting", router);
    const srv = await new Promise((resolve) => { const x = app.listen(0, () => resolve(x)); });
    mounted.push(srv);
    return `http://127.0.0.1:${srv.address().port}`;
  };

  afterAll(async () => {
    for (const srv of mounted) await new Promise((r) => srv.close(r));
    for (const f of written) { try { fs.unlinkSync(f); } catch { /* already gone */ } }
  });

  const survives = async (fn) => { await expect(fn()).resolves.toBeUndefined(); };
  const kills = async (fn) => {
    await expect(fn()).rejects.toThrow(/expect\(|Expected|toEqual|toBe|toMatchObject/);
  };

  test("CHECKING COMPLEXITY AFTER THE ENGINE FAILS", async () => {
    const check = async (at) => {
      const s = await scenario();
      engineCalls = [];
      const r = await call(HUGE([s.companyId]), { at, bearer: s.bearer });
      expect(r.status).toBe(422);
      expect(engineCalls).toHaveLength(0);
    };
    await survives(() => check(origin));
    const at = await mutantRoute([[
      `    const cost = budget.estimate(layout, { organizationId: String(req.organization._id) });
    telemetry.cost = cost;
    if (!cost.allowed) {`,
      `    const cost = budget.estimate(layout, { organizationId: String(req.organization._id) });
    telemetry.cost = cost;
    await engine().runPreview({ layout, organizationId: String(req.organization._id), companyIds: req.companyIds, dataAsOf: null });
    if (!cost.allowed) {`,
    ]]);
    await kills(() => check(at));
  });

  test("MOVING THE COMPANY CHECK AFTER THE COMPLEXITY GATE FAILS", async () => {
    /* The refusal a probe receives must be 403 and must say nothing about the
       report's shape. With the order swapped, an unowned company with an
       expensive layout answers 422 and describes it. */
    const check = async (at) => {
      const s = await scenario();
      const theirs = await Acc_Company.create({ companyName: "Not theirs", booksFromDate: new Date("2025-04-01") });
      const r = await call(HUGE([String(theirs._id)]), { at, bearer: s.bearer });
      expect([r.status, r.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
      expect(r.body.report).toBeUndefined();
    };
    await survives(() => check(origin));
    const at = await mutantRoute([[
      `const guard = [reportingAuth, canonicalReportParams, reportingCompanyScope()];`,
      `const guard = [reportingAuth, canonicalReportParams, (req, res, next) => next()];`,
    ], [
      `    const dataAsOf = await freshnessFor(req.companyIds);`,
      `    reportingCompanyScope()(req, res, () => {}); const dataAsOf = await freshnessFor(req.companyIds);`,
    ]]);
    await kills(() => check(at));
  });

  test("RETURNING AN OVERSIZED BODY PARTIALLY FAILS", async () => {
    const check = async (at) => {
      const s = await scenario();
      engineBehaviour = "huge";
      const r = await call(SIMPLE([s.companyId]), { at, bearer: s.bearer });
      expect(r.status).toBe(422);
      expect(r.bytes).toBeLessThan(1000);
      engineBehaviour = "ok";
    };
    await survives(() => check(origin));
    const at = await mutantRoute([[
      `      return refuse(res, CODES.INVALID_SPEC, 422, {
        ...budget.refusalDetails(cost),
        message: budget.TOO_LARGE,
      });`,
      `      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.send(json.slice(0, budget.BUDGET.maxResponseBytes));`,
    ]]);
    await kills(() => check(at));
  });

  test("LOGGING THE WHOLE LAYOUT OR RESULT FAILS", async () => {
    const check = async (at) => {
      const s = await scenario();
      await call({ ...MONTHLY([s.companyId]), name: "Mayfair reconciliation" }, { at, bearer: s.bearer });
      expect(JSON.stringify(lastPreviewLog()).toLowerCase()).not.toContain("mayfair");
    };
    await survives(() => check(origin));
    const at = await mutantRoute([[
      `      previewRowCount: telemetry.rows,`,
      `      previewRowCount: telemetry.rows, layout,`,
    ]]);
    await kills(() => check(at));
  });
});
