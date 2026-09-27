// test/accountant/reporting.route.test.js
//
// THE SEVEN ENDPOINTS, against the REAL middleware and a fake engine.
//
// Authentication, organisation isolation, MULTI-COMPANY scoping, permissions,
// layout validation, the matrix contract and the versioned saved-report
// lifecycle. Real routers, real Lane A auth, real signed organisation tokens —
// a middleware unit test cannot show a guard is MOUNTED, and being mounted is
// the claim.
//
// The engine is faked. Every test here is about who may ask for what, which is
// decided before a query is compiled. The compiler and matrix have their own
// pure suite; the live engine has its own integration suite.
"use strict";

process.env.JWT_SECRET = "test_secret_for_reporting_routes_v2";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_CustomReport } = require("../../models/Accountant_model/Acc_CustomReport");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const catalogue = require("../../services/reporting/fieldCatalogue");

const reportingRouter = require("../../routes/Accountant_Routes/Acc_reporting");

let server, origin, logSpy;
let engineCalls = [];
let engineBehaviour = "ok";

function fakeEngine() {
  const { ReportingError, CODES } = require("../../services/reporting/metabaseEngine");
  const maybeThrow = () => {
    if (engineBehaviour === "timeout") throw new ReportingError(CODES.UNAVAILABLE, "The reporting query timed out.", { status: 504 });
    if (engineBehaviour === "unreachable") throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine is unreachable.", { status: 503 });
    if (engineBehaviour === "leaky") {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine failed.", {
        status: 502,
        cause: new Error('metabase 400: {"error":"SELECT reporting.v_general_ledger.gstin","database_id":2,"table_id":200,"api_key":"mb_SUPERSECRET"}'),
      });
    }
    if (engineBehaviour === "oversized") {
      throw new ReportingError(CODES.INVALID_SPEC, "This report has 200,000 rows. An export covers at most 100,000 — add a filter and try again.", { status: 400 });
    }
  };
  return {
    isConfigured: () => true,
    async runPreview(args) {
      engineCalls.push({ kind: "preview", ...args });
      maybeThrow();
      const leafColumns = args.layout.mode === "detail"
        ? args.layout.rows.map((r) => ({ id: r.field.id, heading: r.heading, type: r.field.type, isTotal: false, isComparison: false }))
        : args.layout.values.map((v) => ({ id: v.field.id, heading: v.heading, type: v.field.type, isTotal: false, isComparison: false }));
      return {
        mode: args.layout.mode,
        columnLevels: [{ heading: "", headers: leafColumns.map((l) => ({ label: l.heading, span: 1 })) }],
        leafColumns,
        rowLevels: args.layout.rows.map((r) => ({ heading: r.heading })),
        rows: [{ kind: "data", depth: 0, labels: ["x"], cells: leafColumns.map(() => ({ value: 1, display: "money" })) }],
        grandTotal: null,
        /* Deliberately a TRUNCATED answer: the counts contract is only
           interesting when something was left out, and this is the shape the
           route has to carry through untouched. */
        previewRowCount: 1,
        groupCount: 240,
        totalRowCount: 240,
        truncated: true,
        omitted: {
          rows: 239,
          values: Object.fromEntries(leafColumns.map((l) => [l.id, -1234.56])),
        },
        dataAsOf: args.dataAsOf,
      };
    },
    async runExport(args) {
      engineCalls.push({ kind: "export", ...args });
      maybeThrow();
      /* B5: the engine returns RAW ROWS and the route writes the workbook, so
         the fake returns one row shaped like the layout's own columns. */
      const width = args.layout.mode === "detail"
        ? args.layout.rows.length
        : args.layout.rows.length + args.layout.columns.length + args.layout.values.length;
      return { rows: [Array.from({ length: width }, (_, i) => (i === width - 1 ? 1234.5 : "x"))], pivoted: false };
    },
    async metadata() { return { databaseId: 1, views: {} }; },
    async refreshMetadata() { return { databaseId: 1, views: {} }; },
  };
}

beforeAll(async () => {
  logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  reportingRouter.setEngine(fakeEngine());
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/reporting", reportingRouter);
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  jest.restoreAllMocks();
  await new Promise((r) => server.close(r));
});

beforeEach(() => { engineCalls = []; engineBehaviour = "ok"; });

async function call(path, { method = "GET", body, bearer, raw = false } = {}) {
  const res = await fetch(`${origin}/api/accountant/reporting${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (raw) return res;
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

let seq = 0;
const makeCompany = (name = `Co ${++seq}`) =>
  Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01") });

const makeOrg = (companies = []) =>
  Acc_Organization.create({ name: `Org ${++seq}`, tallyCompanyIds: companies.map((c) => c._id) });

async function makeUser(org, role = "owner") {
  const u = new Acc_User({ organizationId: org._id, name: `U${++seq}`, email: `u${seq}@e.com`, role });
  await u.setPassword("a-long-enough-password");
  await u.save();
  return u;
}

async function scenario(role = "owner", companyCount = 1) {
  const companies = [];
  for (let i = 0; i < companyCount; i += 1) companies.push(await makeCompany());
  const org = await makeOrg(companies);
  const user = await makeUser(org, role);
  return {
    companies, org, user, bearer: signOrgToken(user),
    ids: companies.map((c) => String(c._id)),
    companyId: String(companies[0]._id),
  };
}

const LAYOUT = (companyIds, over = {}) => ({
  name: "Untitled report",
  companyIds,
  rows: [{ field: "ledger.group", heading: "Ledger Group" }],
  columns: [{ field: "date.month", heading: "Month" }],
  values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
  filters: [{ field: "date.voucher", operation: "between", value: ["2026-04-01", "2026-04-30"] }],
  comparisons: [],
  sort: [],
  showRowTotals: true, showColumnTotals: true, showGrandTotal: true,
  limit: 100,
  ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════ */

describe("authentication", () => {
  const ROUTES = [
    ["GET", "/catalog?companyId=6a08040a1fecacc9bb7149c2"],
    ["POST", "/preview"], ["POST", "/export/xlsx"],
    ["GET", "/custom-reports"], ["POST", "/custom-reports"],
    ["GET", "/custom-reports/6a08040a1fecacc9bb7149c2"],
    ["PUT", "/custom-reports/6a08040a1fecacc9bb7149c2"],
    ["DELETE", "/custom-reports/6a08040a1fecacc9bb7149c2"],
  ];

  test.each(ROUTES)("%s %s refuses an anonymous caller", async (method, path) => {
    const r = await call(path, { method, body: method === "GET" ? undefined : {} });
    expect([r.status, r.body.code]).toEqual([401, "REPORTING_UNAUTHORISED"]);
  });

  test.each(ROUTES)("%s %s refuses a legacy CMS session", async (method, path) => {
    const jwt = require("jsonwebtoken");
    const legacy = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), role: "accountant" },
      process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await call(path, { method, bearer: legacy, body: method === "GET" ? undefined : {} });
    expect([r.status, r.body.code]).toEqual([401, "REPORTING_UNAUTHORISED"]);
  });
});

describe("multi-company scope", () => {
  test("every company in the layout is checked independently", async () => {
    const s = await scenario("owner", 2);
    const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT(s.ids) });
    expect(r.status).toBe(200);
    expect(engineCalls[0].companyIds).toEqual(s.ids);
  });

  test("ONE FORBIDDEN COMPANY REFUSES THE WHOLE REQUEST", async () => {
    /* Never a partial run over the subset that passed: a report that quietly
       drops a company returns figures that look complete and are not. */
    const s = await scenario("owner", 1);
    const theirs = await makeCompany("Someone else's");
    const r = await call("/preview", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId, String(theirs._id)]),
    });
    expect([r.status, r.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
    expect(engineCalls).toHaveLength(0);
  });

  test("THE FIRST COMPANY PASSING IS NOT ENOUGH", async () => {
    const s = await scenario("owner", 1);
    const theirs = await makeCompany();
    // The accessible one leads; the inaccessible one is second.
    const r = await call("/preview", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId, String(theirs._id)]),
    });
    expect(r.status).toBe(403);
  });

  test("duplicates are removed and a maximum is imposed", async () => {
    const s = await scenario("owner", 1);
    const dupes = await call("/preview", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId, s.companyId, s.companyId]),
    });
    expect(dupes.status).toBe(200);
    expect(engineCalls[0].companyIds).toEqual([s.companyId]);

    const many = Array.from({ length: 11 }, () => new mongoose.Types.ObjectId().toString());
    const tooMany = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT(many) });
    expect([tooMany.status, tooMany.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
  });

  test("no company at all is refused, not answered unscoped", async () => {
    const s = await scenario();
    const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([]) });
    expect([r.status, r.body.code]).toEqual([400, "REPORTING_INVALID_SPEC"]);
    expect(engineCalls).toHaveLength(0);
  });

  test("THE ENGINE RECEIVES THE SESSION'S ORGANISATION, never the body's", async () => {
    const s = await scenario();
    await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) });
    expect(engineCalls[0].organizationId).toBe(String(s.org._id));
    expect(engineCalls[0].companyIds).toEqual([s.companyId]);
  });
});

describe("permissions", () => {
  test("a viewer may read the catalogue, preview and export", async () => {
    const s = await scenario("viewer");
    expect((await call(`/catalog?companyId=${s.companyId}`, { bearer: s.bearer })).status).toBe(200);
    expect((await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) })).status).toBe(200);
    expect((await call("/export/xlsx", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]), raw: true })).status).toBe(200);
  });

  test("a viewer may not create; an editor may", async () => {
    const v = await scenario("viewer");
    expect((await call("/custom-reports", { method: "POST", bearer: v.bearer, body: LAYOUT([v.companyId], { name: "V" }) })).status).toBe(403);
    const e = await scenario("editor");
    expect((await call("/custom-reports", { method: "POST", bearer: e.bearer, body: LAYOUT([e.companyId], { name: "E" }) })).status).toBe(201);
  });

  test("delete is the creator's or an owner's", async () => {
    const company = await makeCompany();
    const org = await makeOrg([company]);
    const creator = await makeUser(org, "editor");
    const other = await makeUser(org, "editor");
    const owner = await makeUser(org, "owner");
    const id = String(company._id);

    const made = await call("/custom-reports", {
      method: "POST", bearer: signOrgToken(creator), body: LAYOUT([id], { name: "R" }),
    });
    expect(made.status).toBe(201);
    expect((await call(`/custom-reports/${made.body.report.id}`, { method: "DELETE", bearer: signOrgToken(other) })).status).toBe(403);
    expect((await call(`/custom-reports/${made.body.report.id}`, { method: "DELETE", bearer: signOrgToken(owner) })).body).toEqual({ ok: true });
  });
});

describe("GET /catalog", () => {
  test("it returns ONE FLAT LIST with no raw column name", async () => {
    const s = await scenario();
    const r = await call(`/catalog?companyId=${s.companyId}`, { bearer: s.bearer });
    expect(r.status).toBe(200);
    /* `grain` joined `fields` in slice B2: the frontend has to be able to say
       WHY a voucher number repeats down a list, and guessing is what it was
       doing. Additive — a client that reads `.fields` is unaffected. */
    expect(Object.keys(r.body).sort()).toEqual(["fields", "grain"]);
    expect(r.body.grain).toEqual({
      id: "voucher_line",
      label: "Voucher line",
      description: expect.stringContaining("one ledger entry within a voucher"),
    });
    expect(r.body.subjects).toBeUndefined();
    const text = JSON.stringify(r.body);
    /* `financial_year` is exempt and only that: since slice B2 it is also the
       name of a semantic TYPE and of a display format — the English name of
       the business concept, which the catalogue is entitled to use. What must
       not exist is a field id that resolves to a column, and none does. */
    for (const column of catalogue.allColumns()) {
      if (column === "financial_year") continue;
      expect(text).not.toContain(`"${column}"`);
    }
    expect(catalogue.fieldOf("financial_year")).toBeNull();
    for (const forbidden of ["metabase", "postgres", "mbql", "source-table", "localhost", "api-key"]) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe("POST /preview", () => {
  test("the response is the matrix contract", async () => {
    const s = await scenario();
    const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      "columnLevels", "dataAsOf", "grandTotal", "groupCount", "leafColumns",
      "mode", "omitted", "previewRowCount", "rowLevels", "rows",
      "totalRowCount", "truncated",
    ]);
    for (const c of r.body.leafColumns) {
      expect(Object.keys(c).sort()).toEqual(["heading", "id", "isComparison", "isTotal", "type"]);
    }
    for (const row of r.body.rows) expect(row.cells).toHaveLength(r.body.leafColumns.length);
  });

  test("THE COUNTS AND THE OMITTED FIGURES REACH THE BROWSER INTACT", async () => {
    /* JSON.stringify drops `undefined` silently, and a negative that arrived
       as a string would break a client's arithmetic without an error. This is
       the whole B4 payload, read back off the wire. */
    const s = await scenario();
    const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) });
    expect(r.status).toBe(200);
    expect(r.body.previewRowCount).toBe(1);
    expect(r.body.groupCount).toBe(240);
    expect(r.body.totalRowCount).toBe(240);
    expect(r.body.truncated).toBe(true);
    expect(r.body.omitted.rows).toBe(239);
    for (const leaf of r.body.leafColumns) {
      expect(r.body.omitted.values[leaf.id]).toBe(-1234.56);   // sign and all
    }
    expect(r.body.previewRowCount + r.body.omitted.rows).toBe(r.body.groupCount);
  });

  test("AN UNOWNED COMPANY IS REFUSED BEFORE THE ENGINE IS ASKED ANYTHING", async () => {
    /* The counts are only trustworthy if the query that produced them was
       scoped. A mixed request must never reach the engine at all — not even to
       be counted. */
    const s = await scenario("owner", 1);
    const theirs = await makeCompany("Not theirs");
    for (const ids of [[String(theirs._id)], [s.companyId, String(theirs._id)]]) {
      engineCalls = [];
      const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT(ids) });
      expect([r.status, r.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
      expect(engineCalls).toHaveLength(0);
    }
  });

  test("detail mode is decided from the layout", async () => {
    const s = await scenario();
    const r = await call("/preview", {
      method: "POST", bearer: s.bearer,
      body: LAYOUT([s.companyId], {
        rows: [{ field: "date.voucher", heading: "Date" }, { field: "amount.debit", heading: "Debit" }],
        columns: [], values: [],
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("detail");
  });

  test("the preview limit is capped server-side at 100", async () => {
    const s = await scenario();
    await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId], { limit: 99999 }) });
    expect(engineCalls[0].layout.limit).toBe(100);
  });

  test("A CRAFTED SQL / MBQL / RAW-COLUMN PAYLOAD IS REFUSED", async () => {
    const s = await scenario();
    const attacks = [
      { ...LAYOUT([s.companyId]), sql: "SELECT * FROM reporting.dim_ledger" },
      { ...LAYOUT([s.companyId]), native: { query: "SELECT 1" } },
      { ...LAYOUT([s.companyId]), "source-table": 200 },
      { ...LAYOUT([s.companyId]), database: 2 },
      LAYOUT([s.companyId], { rows: [{ field: "voucher_date" }] }),
      LAYOUT([s.companyId], { rows: [{ field: "ledger_group" }] }),
      LAYOUT([s.companyId], { values: [{ field: "signed_amount", calculation: "total" }] }),
      LAYOUT([s.companyId], { filters: [{ field: "company_id", operation: "is", value: "x" }] }),
    ];
    for (const body of attacks) {
      const r = await call("/preview", { method: "POST", bearer: s.bearer, body });
      expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    }
    expect(engineCalls).toHaveLength(0);
  });

  test("a refusal names labels, never columns or internals", async () => {
    const s = await scenario();
    const r = await call("/preview", {
      method: "POST", bearer: s.bearer,
      body: LAYOUT([s.companyId], { columns: [{ field: "voucher.narration" }] }),
    });
    const text = JSON.stringify(r.body);
    expect(text).toContain("Narration");
    for (const column of catalogue.allColumns()) expect(text).not.toContain(`"${column}"`);
    expect(text.toLowerCase()).not.toContain("metabase");
  });
});

describe("engine failures are translated", () => {
  test.each([["timeout", 504], ["unreachable", 503]])("%s becomes REPORTING_UNAVAILABLE", async (mode, status) => {
    const s = await scenario();
    engineBehaviour = mode;
    const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) });
    expect([r.status, r.body.code]).toEqual([status, "REPORTING_UNAVAILABLE"]);
  });

  test("A LEAKY ENGINE ERROR LEAKS NOTHING", async () => {
    const s = await scenario();
    engineBehaviour = "leaky";
    const r = await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) });
    const text = JSON.stringify(r.body);
    for (const secret of ["SELECT", "gstin", "v_general_ledger", "mb_SUPERSECRET", "database_id", "table_id"]) {
      expect(text).not.toContain(secret);
    }
    expect(r.body.code).toBe("REPORTING_UNAVAILABLE");
  });

  test("an oversized export is refused with something actionable", async () => {
    const s = await scenario();
    engineBehaviour = "oversized";
    const r = await call("/export/xlsx", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) });
    expect([r.status, r.body.code]).toEqual([400, "REPORTING_INVALID_SPEC"]);
    expect(r.body.message).toMatch(/add a filter/i);
  });
});

describe("POST /export/xlsx", () => {
  test("it streams a workbook with the right type and a safe filename", async () => {
    const s = await scenario();
    const res = await call("/export/xlsx", {
      method: "POST", bearer: s.bearer, raw: true,
      body: LAYOUT([s.companyId], { name: "April / sales «report»" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toMatch(/filename="april-sales-report-\d{4}-\d{2}-\d{2}\.xlsx"/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(Buffer.from(await res.arrayBuffer()).slice(0, 2).toString()).toBe("PK");
  });

  test("IT SAYS THE WORKBOOK IS FLAT, rather than implying it matches the preview", async () => {
    /* Metabase cannot export the pivoted structure — see
       docs/decisions/metabase-pivot-export-capability.md. The response states
       that rather than letting the caller assume parity. */
    const s = await scenario();
    const res = await call("/export/xlsx", {
      method: "POST", bearer: s.bearer, raw: true, body: LAYOUT([s.companyId]),
    });
    expect(res.headers.get("x-reporting-layout")).toBe("flat-aggregation");
    expect(res.headers.get("x-reporting-layout-note")).toMatch(/flat list rather than the pivoted matrix/i);
  });

  test("THE EXPORT REVALIDATES — a prior preview buys nothing", async () => {
    const s = await scenario();
    expect((await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) })).status).toBe(200);
    engineCalls = [];
    const r = await call("/export/xlsx", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId], { rows: [{ field: "gstin" }] }),
    });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(engineCalls).toHaveLength(0);
  });

  test("the export is audited, with ids and counts and no values", async () => {
    const s = await scenario();
    logSpy.mockClear();
    await call("/export/xlsx", { method: "POST", bearer: s.bearer, raw: true, body: LAYOUT([s.companyId]) });
    const line = logSpy.mock.calls.find((c) => c[0] === "[reporting/export]");
    const audit = JSON.parse(line[1]);
    expect(audit).toMatchObject({ ok: true, mode: "summary", rows: 1, columns: 1, values: 1 });
    expect(audit.organization).toBe(String(s.org._id));
    expect(JSON.stringify(audit).toLowerCase()).not.toContain("select");
  });
});

describe("saved reports", () => {
  test("create, list, open, update, duplicate, delete", async () => {
    const s = await scenario("owner", 2);
    const created = await call("/custom-reports", {
      method: "POST", bearer: s.bearer, body: LAYOUT(s.ids, { name: "Monthly" }),
    });
    expect(created.status).toBe(201);
    expect(created.body.report).toMatchObject({
      name: "Monthly", companyIds: s.ids, schemaVersion: 2,
      layoutSummary: "Ledger Group by Month",
    });
    const id = created.body.report.id;

    const listed = await call("/custom-reports", { bearer: s.bearer });
    expect(Object.keys(listed.body.reports[0]).sort()).toEqual([
      "companyIds", "companyNames", "id", "layoutSummary", "name", "updatedAt",
    ]);
    expect(listed.body.reports[0].companyNames).toHaveLength(2);

    const opened = await call(`/custom-reports/${id}`, { bearer: s.bearer });
    expect(opened.body.report.layout.rows[0].field).toBe("ledger.group");
    expect(opened.body.report.staleProblems).toBeNull();

    const updated = await call(`/custom-reports/${id}`, {
      method: "PUT", bearer: s.bearer, body: LAYOUT(s.ids, { name: "Monthly v2" }),
    });
    expect(updated.body.report.name).toBe("Monthly v2");

    const copy = await call("/custom-reports", {
      method: "POST", bearer: s.bearer, body: LAYOUT(s.ids, { name: "Monthly v2 (copy)" }),
    });
    expect(copy.status).toBe(201);
    expect(copy.body.report.createdBy).toBe(String(s.user._id));

    expect((await call(`/custom-reports/${id}`, { method: "DELETE", bearer: s.bearer })).body).toEqual({ ok: true });
  });

  test("ONLY SAFE IDS ARE STORED — no SQL, MBQL or column", async () => {
    const s = await scenario();
    const created = await call("/custom-reports", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId], { name: "Stored" }),
    });
    const doc = await Acc_CustomReport.findById(created.body.report.id).lean();
    const stored = JSON.stringify(doc);
    for (const column of catalogue.allColumns()) expect(stored).not.toContain(`"${column}"`);
    for (const f of ["source-table", "native", "SELECT", "mbql"]) {
      expect(stored.toLowerCase()).not.toContain(f.toLowerCase());
    }
    expect(doc.schemaVersion).toBe(2);
    expect(doc.layout.rows[0].field).toBe("ledger.group");
  });

  test("ANOTHER ORGANISATION'S REPORT IS INVISIBLE, even with its exact id", async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const created = await call("/custom-reports", {
      method: "POST", bearer: theirs.bearer, body: LAYOUT([theirs.companyId], { name: "Theirs" }),
    });
    const id = created.body.report.id;
    expect((await call("/custom-reports", { bearer: mine.bearer })).body.reports).toEqual([]);
    for (const [method, body] of [["GET"], ["PUT", LAYOUT([mine.companyId], { name: "Stolen" })], ["DELETE"]]) {
      expect((await call(`/custom-reports/${id}`, { method, bearer: mine.bearer, body })).status).toBe(404);
    }
    expect((await call(`/custom-reports/${id}`, { bearer: theirs.bearer })).status).toBe(200);
  });

  test("A MOVED COMPANY TAKES ITS REPORTS OUT OF REACH IMMEDIATELY", async () => {
    const s = await scenario();
    const created = await call("/custom-reports", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId], { name: "Before" }),
    });
    await Acc_Organization.updateOne({ _id: s.org._id }, { $set: { tallyCompanyIds: [] } });
    expect((await call(`/custom-reports/${created.body.report.id}`, { bearer: s.bearer })).status).toBe(404);
    expect((await call("/custom-reports", { bearer: s.bearer })).body.reports).toEqual([]);
  });

  test("a multi-company report needs EVERY company still owned to be listed", async () => {
    const s = await scenario("owner", 2);
    await call("/custom-reports", { method: "POST", bearer: s.bearer, body: LAYOUT(s.ids, { name: "Both" }) });
    expect((await call("/custom-reports", { bearer: s.bearer })).body.reports).toHaveLength(1);
    // Drop one of the two companies from the organisation.
    await Acc_Organization.updateOne({ _id: s.org._id }, { $set: { tallyCompanyIds: [s.companies[0]._id] } });
    expect((await call("/custom-reports", { bearer: s.bearer })).body.reports).toEqual([]);
  });

  test("a saved layout is REVALIDATED when opened", async () => {
    const s = await scenario();
    const created = await call("/custom-reports", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId], { name: "Will rot" }),
    });
    await Acc_CustomReport.updateOne({ _id: created.body.report.id },
      { $set: { "layout.rows.0.field": "ledger.withdrawn" } });
    const opened = await call(`/custom-reports/${created.body.report.id}`, { bearer: s.bearer });
    expect(opened.status).toBe(200);
    expect(opened.body.report.staleProblems[0]).toMatch(/is not a field/i);
  });

  test("A v1 REPORT IS NOT REINTERPRETED — it is marked for recreation", async () => {
    /* The old contract had a `subject` and a flat column list and no Values
       shelf. There is no mapping to a PivotTable that is unambiguously right,
       so guessing is refused. */
    const s = await scenario();
    const legacy = await Acc_CustomReport.collection.insertOne({
      organizationId: s.org._id,
      companyIds: [s.companies[0]._id],
      createdBy: new mongoose.Types.ObjectId(s.user._id),
      name: "Old report",
      schemaVersion: 1,
      subject: "voucher-register",
      specification: { subject: "voucher-register", columns: [{ field: "vr.date" }] },
      layout: {},
      createdAt: new Date(), updatedAt: new Date(),
    });

    const opened = await call(`/custom-reports/${legacy.insertedId}`, { bearer: s.bearer });
    expect(opened.status).toBe(200);
    expect(opened.body.report.needsRecreation).toBe(true);
    expect(opened.body.report.schemaVersion).toBe(1);
    expect(opened.body.report.layout).toBeNull();
    expect(opened.body.report.legacySpecification).toBeTruthy();
    expect(opened.body.report.staleProblems[0]).toMatch(/build it again/i);

    const listed = await call("/custom-reports", { bearer: s.bearer });
    expect(listed.body.reports[0].needsRecreation).toBe(true);
  });

  test("a duplicate name is refused", async () => {
    const s = await scenario();
    const body = LAYOUT([s.companyId], { name: "Sales" });
    expect((await call("/custom-reports", { method: "POST", bearer: s.bearer, body })).status).toBe(201);
    const clash = await call("/custom-reports", { method: "POST", bearer: s.bearer, body });
    expect([clash.status, clash.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
  });

  test("a malformed id is a refusal, not a crash", async () => {
    const s = await scenario();
    for (const id of ["not-an-id", "../../etc/passwd", "%00"]) {
      expect((await call(`/custom-reports/${encodeURIComponent(id)}`, { bearer: s.bearer })).status).toBe(404);
    }
  });
});

describe("no engine credential escapes", () => {
  test("no response carries a Metabase key, URL or id", async () => {
    const s = await scenario();
    process.env.METABASE_REPORTING_API_KEY = "mb_THIS_MUST_NEVER_APPEAR";
    process.env.METABASE_SITE_URL = "http://metabase.internal:3100";
    const created = await call("/custom-reports", {
      method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId], { name: "R" }),
    });
    const responses = [
      await call(`/catalog?companyId=${s.companyId}`, { bearer: s.bearer }),
      await call("/preview", { method: "POST", bearer: s.bearer, body: LAYOUT([s.companyId]) }),
      await call("/custom-reports", { bearer: s.bearer }),
      await call(`/custom-reports/${created.body.report.id}`, { bearer: s.bearer }),
      await call("/preview", { method: "POST", bearer: s.bearer, body: { rows: [] } }),
    ];
    for (const r of responses) {
      const text = JSON.stringify(r.body);
      expect(text).not.toContain("mb_THIS_MUST_NEVER_APPEAR");
      expect(text).not.toContain("metabase.internal");
      expect(text.toLowerCase()).not.toContain("x-api-key");
    }
  });
});
