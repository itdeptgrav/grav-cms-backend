// test/accountant/reporting-chart.route.test.js
//
// POST /chart-session, against the REAL middleware and a fake bridge.
//
// Who may ask for a chart, of what, and what comes back. The bridge is faked
// because everything here is decided before a Metabase is touched — and
// because the one thing this route must never do is let a caller reach past
// the guards into the engine, which is easier to prove when the engine is a
// spy that records what it was asked for.
"use strict";

process.env.JWT_SECRET = "test_secret_for_reporting_charts";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";
process.env.METABASE_SITE_URL = process.env.METABASE_SITE_URL || "http://engine.invalid:3100";
process.env.METABASE_PUBLIC_URL = "http://charts.example:3100";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_CustomReport } = require("../../models/Accountant_model/Acc_CustomReport");
/* The pointer table lives in the reporting mart's Postgres, which this suite
   deliberately does not have: everything here is decided before a database of
   figures is touched. The repository is mocked so the route can be asked
   "suppose a chart already exists for this report" without one. */
jest.mock("../../services/reporting/chartRegistry", () => ({
  findByReport: jest.fn(async () => null),
  findByHash: jest.fn(async () => null),
  insert: jest.fn(),
  touch: jest.fn(),
  rewrite: jest.fn(),
  reassign: jest.fn(),
  remove: jest.fn(),
  markArchived: jest.fn(),
  staleDrafts: jest.fn(async () => []),
  counts: jest.fn(async () => ({ draft: { live: 0 }, saved: { live: 0 } })),
}));
const registry = require("../../services/reporting/chartRegistry");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");

const reportingRouter = require("../../routes/Accountant_Routes/Acc_reporting");

const EMBED_SECRET = "an-embedding-secret-that-is-not-the-session-secret";

let server, origin;
let bridgeCalls = [];
let bridgeBehaviour = "ok";
let nextCardId = 500;

/** A bridge that records rather than calls, and can be made to fail. */
function fakeBridge() {
  const { ReportingError, CODES } = require("../../services/reporting/metabaseEngine");
  const maybeThrow = () => {
    if (bridgeBehaviour === "unreachable") {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine is unreachable.", { status: 503 });
    }
    if (bridgeBehaviour === "leaky") {
      throw new ReportingError(CODES.UNAVAILABLE, "The reporting engine could not prepare this chart.", {
        status: 502,
        cause: new Error('metabase 400: {"error":"no such field group_name","api_key":"mb_SUPERSECRET","database_id":2}'),
      });
    }
    if (bridgeBehaviour === "noadmin") {
      throw new ReportingError(CODES.UNAVAILABLE,
        "Charts need an administrator credential for this reporting engine, which is not configured.",
        { status: 503 });
    }
  };
  return {
    TOKEN_TTL_SECONDS: 120,
    isConfigured: () => true,
    async ensureCard(args) {
      /* The spread comes FIRST and `kind` after it: `args` carries a `kind` of
         its own ("draft"), and spreading it last quietly renamed every
         recorded call. */
      bridgeCalls.push({ ...args, kind: "ensureCard" });
      maybeThrow();
      return { cardId: (nextCardId += 1), hash: "hash", created: true };
    },
    async syncSavedReport(args) {
      bridgeCalls.push({ ...args, kind: "syncSavedReport" });
      maybeThrow();
      return { cardId: (nextCardId += 1), hash: "hash", created: false, updated: true };
    },
    async forgetSavedReport(args) {
      bridgeCalls.push({ ...args, kind: "forgetSavedReport" });
      if (bridgeBehaviour === "unreachable") throw new Error("metabase down");
      return { archived: true };
    },
    signEmbedToken(cardId) {
      bridgeCalls.push({ kind: "signEmbedToken", cardId });
      const now = Math.floor(Date.now() / 1000);
      return jwt.sign({ resource: { question: Number(cardId) }, params: {}, iat: now, exp: now + 120 },
        EMBED_SECRET, { algorithm: "HS256" });
    },
    async cleanupDrafts() { return { considered: 0, archived: 0, failed: [] }; },
  };
}

function fakeEngine() {
  return {
    isConfigured: () => true,
    async resolveView() {
      return {
        databaseId: 2,
        tableId: 41,
        fieldIds: Object.fromEntries(
          [...require("../../services/reporting/fieldCatalogue").FIELDS.map((f) => f.column),
           "organization_id", "company_id"].map((c, i) => [c, 9000 + i]),
        ),
      };
    },
    async runPreview() { return { mode: "summary", rows: [], leafColumns: [] }; },
  };
}

beforeAll(async () => {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
  reportingRouter.setEngine(fakeEngine());
  reportingRouter.setCharts(fakeBridge());
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

beforeEach(() => {
  bridgeCalls = [];
  bridgeBehaviour = "ok";
  /* Reset, not just re-stub: a `…Once` queued by a test that never consumed it
     would otherwise answer the NEXT test's question, and the failure lands
     somewhere unrelated. */
  registry.findByReport.mockReset();
  registry.findByReport.mockResolvedValue(null);
});

async function call(path, { method = "POST", body, bearer } = {}) {
  const res = await fetch(`${origin}/api/accountant/reporting${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: parsed, headers: res.headers };
}

let seq = 0;
const makeCompany = (name = `Chart Co ${++seq}`) =>
  Acc_Company.create({ companyName: name, booksFromDate: new Date("2025-04-01") });

async function scenario(role = "owner", companyCount = 1) {
  const companies = [];
  for (let i = 0; i < companyCount; i += 1) companies.push(await makeCompany());
  const org = await Acc_Organization.create({
    name: `Chart Org ${++seq}`, tallyCompanyIds: companies.map((c) => c._id),
  });
  const user = new Acc_User({ organizationId: org._id, name: `U${++seq}`, email: `chart${seq}@e.com`, role });
  await user.setPassword("a-long-enough-password");
  await user.save();
  return { companies, org, user, bearer: signOrgToken(user), ids: companies.map((c) => String(c._id)) };
}

const LAYOUT = (companyIds, over = {}) => ({
  companyIds,
  rows: [{ field: "ledger.group" }],
  values: [{ field: "amount.debit", calculation: "total" }],
  filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
  ...over,
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The gates
 * ══════════════════════════════════════════════════════════════════════════ */

describe("who may ask for a chart", () => {
  test("an anonymous caller may not", async () => {
    const r = await call("/chart-session", { body: LAYOUT(["6a08040a1fecacc9bb7149c2"]) });
    expect([r.status, r.body.code]).toEqual([401, "REPORTING_UNAUTHORISED"]);
  });

  test("a legacy CMS session may not", async () => {
    const legacy = jwt.sign({ id: new mongoose.Types.ObjectId().toString(), role: "accountant" },
      process.env.JWT_SECRET, { expiresIn: "1h" });
    const r = await call("/chart-session", { bearer: legacy, body: LAYOUT(["6a08040a1fecacc9bb7149c2"]) });
    expect([r.status, r.body.code]).toEqual([401, "REPORTING_UNAUTHORISED"]);
  });

  test("A COMPANY THIS ORGANISATION DOES NOT HOLD IS REFUSED", async () => {
    const { bearer, ids } = await scenario();
    const foreign = String((await makeCompany("Someone else's")). _id);
    for (const companyIds of [[foreign], [ids[0], foreign], [foreign, ids[0]]]) {
      const r = await call("/chart-session", { bearer, body: LAYOUT(companyIds) });
      expect([r.status, r.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
    }
    expect(bridgeCalls).toHaveLength(0);
  });

  test("a viewer may chart — reading a report is reading a report", async () => {
    for (const role of ["viewer", "editor", "owner"]) {
      const s = await scenario(role);
      const r = await call("/chart-session", { bearer: s.bearer, body: LAYOUT(s.ids) });
      expect([role, r.status]).toEqual([role, 200]);
    }
  });

  test("AND THE PERMISSION IS CHECKED WHERE THE ROUTE IS DECLARED", () => {
    /* The chain, read from the source: a guard that is written and not mounted
       is the failure this catches, and no request can demonstrate its absence
       once every role in the product happens to pass it. */
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "routes", "Accountant_Routes", "Acc_reporting.js"),
      "utf8",
    );
    const chain = source.slice(source.indexOf('"/chart-session"'), source.indexOf("async (req, res) => {", source.indexOf('"/chart-session"')));
    expect(chain).toMatch(/reportingAuth/);
    expect(chain).toMatch(/canonicalReportParams/);
    expect(chain).toMatch(/reportingCompanyScope/);
    expect(chain).toMatch(/requirePermission\("canView"\)/);
  });

  test("THE ENGINE IS ONLY EVER ASKED WITH THE GUARD'S OWN VALUES", async () => {
    const { bearer, ids, org } = await scenario("owner", 2);
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    expect([r.status, r.body.code ?? null]).toEqual([200, null]);
    const [ensure] = bridgeCalls.filter((c) => c.kind === "ensureCard");
    expect(String(ensure.organizationId)).toBe(String(org._id));
    expect(ensure.companyIds).toEqual(ids);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The contract
 * ══════════════════════════════════════════════════════════════════════════ */

describe("what comes back", () => {
  test("THE RESPONSE IS THE CONTRACT AND NOTHING MORE", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });

    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual([
      "chartSupported", "embedToken", "expiresIn", "metabaseInstanceUrl", "ok", "visualization",
    ]);
    expect(r.body.ok).toBe(true);
    expect(r.body.chartSupported).toBe(true);
    expect(r.body.metabaseInstanceUrl).toBe("http://charts.example:3100");
    expect(r.body.expiresIn).toBe(120);
    expect(r.body.visualization.type).toBe("bar");
    expect(r.body.visualization.supportedTypes).toEqual(
      ["bar", "row", "pie", "treemap", "funnel", "table"],
    );
  });

  test("a chart session is never cached", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  test("NOTHING IN THE RESPONSE IDENTIFIES ANYTHING INSIDE THE ENGINE", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    const text = JSON.stringify(r.body);

    for (const forbidden of [
      "api_key", "apiKey", "x-api-key", "mb_", "dataset_query", "source-table",
      "database", "table_id", "field_id", "card", "collection", "native", "SELECT",
      "group_name", "voucher_date", "organization_id", "company_id",
    ]) {
      expect(text).not.toContain(forbidden);
    }
    // The token is a ticket, not a payload: it names a question and nothing else.
    const decoded = jwt.decode(r.body.embedToken);
    expect(Object.keys(decoded).sort()).toEqual(["exp", "iat", "params", "resource"]);
  });

  test("the token expires inside two minutes", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    const decoded = jwt.decode(r.body.embedToken);
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(120);
    expect(r.body.expiresIn).toBeLessThanOrEqual(120);
  });

  test("AND IS SIGNED WITH THE EMBEDDING SECRET, NOT THE SESSION SECRET", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    expect(() => jwt.verify(r.body.embedToken, EMBED_SECRET)).not.toThrow();
    expect(() => jwt.verify(r.body.embedToken, process.env.JWT_SECRET)).toThrow();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * What can and cannot be drawn
 * ══════════════════════════════════════════════════════════════════════════ */

describe("chartSupported", () => {
  test("A COMPARISON OF AN AVERAGE IS ANSWERED, NOT FAILED", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids, {
      values: [{ field: "amount.debit", calculation: "average" }],
      comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
    })});

    expect(r.status).toBe(200);
    expect(r.body.chartSupported).toBe(false);
    expect(r.body.reason).toMatch(/cannot be drawn as one chart/i);
    expect(r.body.visualization).toEqual({ type: null, supportedTypes: [] });
    expect(r.body.embedToken).toBeUndefined();
    // And no question was made for a chart that will not be drawn.
    expect(bridgeCalls.filter((c) => c.kind === "ensureCard")).toHaveLength(0);
  });

  test("a half-built pivot is refused as a LAYOUT, before any chart is considered", async () => {
    /* Headings with nothing under them is not an undrawable report — it is an
       incomplete one, and the layout validator says so first. The chart path
       keeps its own answer for the same case (`chartCapability` refuses a
       summary with no values) because defence in depth is cheap and the two
       are reached by different callers. */
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: {
      companyIds: ids,
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
    }});
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(r.body.problems.join(" ")).toMatch(/Values/i);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("a detail report is offered as a table", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: {
      companyIds: ids,
      rows: [{ field: "date.voucher" }, { field: "party.name" }],
      filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
    }});
    expect(r.body.chartSupported).toBe(true);
    expect(r.body.visualization).toMatchObject({ type: "table", supportedTypes: ["table"] });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * The settings the browser may send
 * ══════════════════════════════════════════════════════════════════════════ */

describe("visualization settings", () => {
  test("a supported type is honoured", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: {
      ...LAYOUT(ids), visualization: { type: "row", title: "Debit by group", palette: "ledger" } } });
    expect(r.body.visualization.type).toBe("row");
    expect(r.body.visualization.settings.title).toBe("Debit by group");
  });

  test("AN UNSUPPORTED TYPE IS REFUSED WITH THE LIST THAT WOULD WORK", async () => {
    const { bearer, ids } = await scenario();
    const r = await call("/chart-session", { bearer, body: {
      ...LAYOUT(ids), visualization: { type: "map" } } });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(r.body.problems[0]).toMatch(/bar, row/);
  });

  test("A CRAFTED SETTINGS OBJECT IS REFUSED", async () => {
    const { bearer, ids } = await scenario();
    for (const visualization of [
      { type: "bar", dataset_query: { type: "native", native: { query: "SELECT 1" } } },
      { type: "bar", click_behavior: { type: "link", linkTemplate: "https://evil.example" } },
      { type: "bar", "card.title": "<script>alert(1)</script>" },
      { type: "bar", palette: "javascript:alert(1)" },
      { type: "bar", dimensions: ["company_id"] },
    ]) {
      const r = await call("/chart-session", { bearer, body: { ...LAYOUT(ids), visualization } });
      expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
      expect(bridgeCalls.filter((c) => c.kind === "ensureCard")).toHaveLength(0);
    }
  });

  test("a crafted LAYOUT is refused before any of this", async () => {
    const { bearer, ids } = await scenario();
    for (const body of [
      { ...LAYOUT(ids), sql: "SELECT 1" },
      { ...LAYOUT(ids), rows: [{ field: "group_name" }] },
      { ...LAYOUT(ids), native: { query: "x" } },
    ]) {
      const r = await call("/chart-session", { bearer, body });
      expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * Saved reports
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a saved report's chart", () => {
  const save = async (bearer, ids, over = {}) => {
    const r = await call("/custom-reports", { bearer, body: { ...LAYOUT(ids), name: `Saved ${++seq}`, ...over } });
    expect(r.status).toBe(201);
    return r.body.report;
  };

  test("a report id draws the report, not the body's layout", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids);
    bridgeCalls = [];

    const r = await call("/chart-session", { bearer, body: { reportId: report.id } });
    expect(r.status).toBe(200);
    const [sync] = bridgeCalls.filter((c) => c.kind === "syncSavedReport");
    expect(String(sync.reportId)).toBe(report.id);
    expect(sync.companyIds).toEqual(ids);
  });

  test("ANOTHER ORGANISATION'S REPORT ID IS NOT FOUND", async () => {
    const mine = await scenario();
    const theirs = await scenario();
    const report = await save(theirs.bearer, theirs.ids);
    bridgeCalls = [];

    const r = await call("/chart-session", { bearer: mine.bearer, body: { reportId: report.id } });
    expect([r.status, r.body.code]).toEqual([404, "REPORTING_FORBIDDEN"]);
    expect(bridgeCalls).toHaveLength(0);
  });

  test("the chart settings are stored with the report and come back with it", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids, { visualization: { type: "row", title: "By group" } });
    expect(report.visualization).toMatchObject({ type: "row", title: "By group" });

    const reopened = await call(`/custom-reports/${report.id}`, { method: "GET", bearer });
    expect(reopened.body.report.visualization).toMatchObject({ type: "row" });
  });

  test("AND THE QUESTION BEHIND IT IS NEVER IN THE RESPONSE", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids);
    registry.findByReport.mockResolvedValueOnce({
      id: 1, organizationId: String((await Acc_CustomReport.findById(report.id)).organizationId),
      kind: "saved", reportId: report.id, layoutHash: "h", cardId: 4242,
    });

    for (const r of [
      await call(`/custom-reports/${report.id}`, { method: "GET", bearer }),
      await call("/custom-reports", { method: "GET", bearer }),
    ]) {
      const text = JSON.stringify(r.body);
      expect(text).not.toContain("4242");
      expect(text).not.toMatch(/cardId|card_id|layoutHash|question/i);
    }
  });

  test("saving a changed layout refreshes a chart that exists", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids);
    const doc = await Acc_CustomReport.findById(report.id);
    registry.findByReport.mockResolvedValueOnce({
      id: 2, organizationId: String(doc.organizationId), kind: "saved",
      reportId: String(doc._id), layoutHash: "old", cardId: 77,
    });
    bridgeCalls = [];

    const updated = await call(`/custom-reports/${report.id}`, {
      method: "PUT",
      bearer,
      body: { ...LAYOUT(ids, { values: [{ field: "amount.credit", calculation: "total" }] }), name: doc.name },
    });
    expect(updated.status).toBe(200);
    expect(bridgeCalls.filter((c) => c.kind === "syncSavedReport")).toHaveLength(1);
  });

  test("and saving one with NO chart makes no question", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids);
    bridgeCalls = [];
    await call(`/custom-reports/${report.id}`, { method: "PUT", bearer,
      body: { ...LAYOUT(ids), name: "Renamed" } });
    expect(bridgeCalls.filter((c) => c.kind === "syncSavedReport")).toHaveLength(0);
  });

  test("DELETING THE REPORT FORGETS THE QUESTION", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids);
    bridgeCalls = [];
    const r = await call(`/custom-reports/${report.id}`, { method: "DELETE", bearer });
    expect(r.body).toEqual({ ok: true });
    expect(bridgeCalls.filter((c) => c.kind === "forgetSavedReport")).toHaveLength(1);
  });

  test("and a Metabase that is down does not keep the report alive", async () => {
    const { bearer, ids } = await scenario();
    const report = await save(bearer, ids);
    bridgeBehaviour = "unreachable";
    const r = await call(`/custom-reports/${report.id}`, { method: "DELETE", bearer });
    expect(r.body).toEqual({ ok: true });
    expect(await Acc_CustomReport.findById(report.id)).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * When the engine fails
 * ══════════════════════════════════════════════════════════════════════════ */

describe("failures", () => {
  test("an unreachable engine is one of the four codes", async () => {
    const { bearer, ids } = await scenario();
    bridgeBehaviour = "unreachable";
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    expect([r.status, r.body.code]).toEqual([503, "REPORTING_UNAVAILABLE"]);
  });

  test("A LEAKY ENGINE ERROR IS LOGGED AND NOT SENT", async () => {
    const { bearer, ids } = await scenario();
    bridgeBehaviour = "leaky";
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("mb_SUPERSECRET");
    expect(text).not.toContain("group_name");
    expect(text).not.toContain("database_id");
    expect(r.body.code).toBe("REPORTING_UNAVAILABLE");
  });

  test("a missing administrator credential is reported as unavailable", async () => {
    const { bearer, ids } = await scenario();
    bridgeBehaviour = "noadmin";
    const r = await call("/chart-session", { bearer, body: LAYOUT(ids) });
    expect([r.status, r.body.code]).toEqual([503, "REPORTING_UNAVAILABLE"]);
  });
});
