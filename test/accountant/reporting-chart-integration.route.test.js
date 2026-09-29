// test/accountant/reporting-chart-integration.route.test.js
//
// THE CHART BRIDGE AGAINST THE REAL METABASE.
//
// The pure suite proves what the compiler emits and the route suite proves who
// may ask for it. Neither can show that Metabase accepts the question, that a
// browser with nothing but the token can render it, or that it refuses
// everything else — and those are the claims the whole design rests on. So
// this runs the real thing and checks each one.
//
//
// ── RUN THESE SERIALLY: `npm run test:reporting:live` ───────────────────────
// Both live suites talk to ONE Metabase and one reporting mart. Run in
// parallel they queue behind each other's pivots and time out — the whole set
// took nineteen minutes and failed; in band it takes twenty-four seconds and
// passes. The failure looks like flakiness and is contention, which is why it
// is written down here rather than rediscovered.
// Skipped, visibly, when the pilot is not up.
"use strict";

require("dotenv").config();

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_chart_integration";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const registry = require("../../services/reporting/chartRegistry");
const pg = require("../../services/reporting/pgClient");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const { createChartBridge } = require("../../services/reporting/metabaseCharts.service");

const ORG_ID = "6a073de21fecacc9bb714481";
const GRAV = "6a08040a1fecacc9bb7149c2";
const OTHER = "6ab1459d11fca003ca6f6062";

const SITE = (process.env.METABASE_SITE_URL || "").replace(/\/+$/, "");
const CONFIGURED = Boolean(
  SITE && process.env.METABASE_REPORTING_API_KEY && process.env.METABASE_EMBEDDING_SECRET,
);

let reachable = false;
let server, origin, bearer, bridge;
let watermark = 0;
const made = [];

const describeOrSkip = CONFIGURED ? describe : describe.skip;
if (!CONFIGURED) {
  test("chart integration is SKIPPED — the Metabase pilot is not configured", () => {
    expect(CONFIGURED).toBe(false);
  });
}

describeOrSkip("charts against the live pilot", () => {
  beforeAll(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    try {
      reachable = (await fetch(`${SITE}/api/health`, { signal: AbortSignal.timeout(5000) })).ok;
    } catch { reachable = false; }
    if (!reachable) return;

    const app = express();
    app.use(express.json());
    app.use("/api/accountant/reporting", require("../../routes/Accountant_Routes/Acc_reporting"));
    await new Promise((r) => { server = app.listen(0, r); });
    origin = `http://127.0.0.1:${server.address().port}`;

    /* Postgres is NOT cleared between tests the way the in-memory Mongo is, and
       this suite runs against the same mart a developer uses. So it records the
       highest pointer id before it starts and removes exactly the rows above
       that line — never a row somebody else's session made. */
    const { rows } = await pg.query("admin",
      "SELECT COALESCE(max(id), 0) AS id FROM reporting.report_chart");
    watermark = Number(rows[0].id);

    /* And rows left by a run that failed before it could tidy up: they point
       at questions that were archived on the way out, so they are rubbish, and
       a stale row with a live hash makes the NEXT run fail for a reason that
       has nothing to do with the code. */
    await pg.query("admin",
      "DELETE FROM reporting.report_chart WHERE organization_id = $1 AND archived_at IS NOT NULL",
      [ORG_ID]);

    bridge = createChartBridge({
      siteUrl: SITE,
      apiKey: process.env.METABASE_REPORTING_API_KEY,
      adminApiKey: process.env.METABASE_EMBED_ADMIN_API_KEY,
      embeddingSecret: process.env.METABASE_EMBEDDING_SECRET,
      parentCollectionId: process.env.METABASE_REPORTING_COLLECTION_ID
        ? Number(process.env.METABASE_REPORTING_COLLECTION_ID) : null,
    });
  }, 60_000);

  beforeEach(async () => {
    if (!reachable) return;
    for (const [id, name] of [[GRAV, "GRAV CLOTHING PVT LTD"], [OTHER, "IE Demo Garments"]]) {
      await Acc_Company.create({
        _id: new mongoose.Types.ObjectId(id), companyName: name,
        booksFromDate: new Date("2025-04-01"),
      });
    }
    const org = await Acc_Organization.create({
      _id: new mongoose.Types.ObjectId(ORG_ID), name: "GRAV",
      tallyCompanyIds: [new mongoose.Types.ObjectId(GRAV)],
    });
    const user = new Acc_User({
      organizationId: org._id, name: "Chart Owner", email: "charts@example.com", role: "owner",
    });
    await user.setPassword("a-long-enough-password");
    await user.save();
    bearer = signOrgToken(user);

    await pg.query("admin", "DELETE FROM reporting.report_chart WHERE id > $1", [watermark]);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (server) await new Promise((r) => server.close(r));
    /* Every question this suite made is archived again. A test that leaves
       objects behind in a shared instance is a test that gets switched off. */
    for (const cardId of made) {
      try { await bridge.archiveCard(cardId); } catch { /* already gone */ }
    }
    if (reachable) {
      await pg.query("admin", "DELETE FROM reporting.report_chart WHERE id > $1", [watermark]);
      await pg.closeAll();
    }
  }, 60_000);

  const skipIfDown = () => !reachable;

  async function session(body) {
    const res = await fetch(`${origin}/api/accountant/reporting/chart-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 200) }; }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** Pointers THIS suite made, which is the only thing it may assert about. */
  const liveCount = async (kind) => {
    const { rows } = await pg.query("admin",
      `SELECT count(*) AS n FROM reporting.report_chart
        WHERE id > $1 AND kind = $2 AND archived_at IS NULL`, [watermark, kind]);
    return Number(rows[0].n);
  };

  const anon = async (path) => {
    const res = await fetch(SITE + path);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text: text.slice(0, 160) };
  };

  const LAYOUT = (over = {}) => ({
    name: "Chart integration",
    companyIds: [GRAV],
    rows: [{ field: "ledger.group" }],
    values: [{ field: "amount.debit", calculation: "total" }],
    filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] }],
    ...over,
  });

  /** The card a session just created, so the suite can tidy up after itself. */
  async function cardIdOf(token) {
    const id = jwt.decode(token).resource.question;
    if (!made.includes(id)) made.push(id);
    return id;
  }

  /* ═══════════════════════════════════════════════════════════════════════ */

  test("A HIDDEN QUESTION IS CREATED AND RENDERS WITH NO API KEY", async () => {
    if (skipIfDown()) return;
    const r = await session({ ...LAYOUT(), visualization: { type: "bar", title: "Debit by group" } });
    expect(r.status).toBe(200);
    expect(r.body.chartSupported).toBe(true);
    const cardId = await cardIdOf(r.body.embedToken);

    // The browser's whole toolkit: the address and the token.
    const page = await anon(`/embed/question/${r.body.embedToken}`);
    expect(page.status).toBe(200);

    const data = await anon(`/api/embed/card/${r.body.embedToken}/query`);
    expect(data.status).toBe(202);
    expect(data.json.data.rows.length).toBeGreaterThan(0);

    // And it is our question, drawn the way we asked.
    const meta = await anon(`/api/embed/card/${r.body.embedToken}`);
    expect(meta.json.display).toBe("bar");
    expect(meta.json.visualization_settings["card.title"]).toBe("Debit by group");
    expect(cardId).toEqual(expect.any(Number));
  }, 60_000);

  test("THE CHART'S FIGURES ARE THE SHEET'S FIGURES", async () => {
    if (skipIfDown()) return;
    const chart = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    await cardIdOf(chart.body.embedToken);
    const rows = (await anon(`/api/embed/card/${chart.body.embedToken}/query`)).json.data.rows;

    const preview = await fetch(`${origin}/api/accountant/reporting/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...LAYOUT(), limit: 100 }),
    }).then((res) => res.json());

    const fromChart = new Map(rows.map(([label, value]) => [label, Number(value)]));
    const valueColumn = preview.leafColumns.findIndex((c) => !c.isTotal);
    for (const row of preview.rows.filter((r) => r.kind === "data")) {
      expect(fromChart.get(row.labels[0])).toBeCloseTo(Number(row.cells[valueColumn].value), 2);
    }
  }, 90_000);

  /* ── Slice B3 ─────────────────────────────────────────────────────────────
     A bar chart is read left to right: if the sheet is by figure and the chart
     is alphabetical, one of them is lying about which ledger group is biggest.
     Checked against Postgres, not against the sheet alone. */
  test("THE CHART IS DRAWN IN THE ORDER THAT WAS ASKED FOR", async () => {
    if (skipIfDown()) return;
    const layout = LAYOUT({ sort: [{ field: "amount.debit", direction: "desc" }] });
    const chart = await session({ ...layout, visualization: { type: "bar" } });
    expect(chart.body.chartSupported).toBe(true);
    await cardIdOf(chart.body.embedToken);

    const rows = (await anon(`/api/embed/card/${chart.body.embedToken}/query`)).json.data.rows;
    const figures = rows.map(([, v]) => Number(v));
    expect(figures).toEqual([...figures].sort((a, b) => b - a));

    const fromMart = (await pg.query("admin",
      `SELECT group_name, SUM(debit) AS total FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY group_name
        ORDER BY SUM(debit) DESC, group_name ASC`, [GRAV])).rows;   // the documented tie-break
    expect(rows.map(([label]) => label)).toEqual(fromMart.map((x) => x.group_name));
    rows.forEach(([, v], i) => expect(Number(v)).toBeCloseTo(Number(fromMart[i].total), 2));

    // The sheet for the same layout draws the same line-up.
    const preview = await fetch(`${origin}/api/accountant/reporting/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...layout, limit: 100 }),
    }).then((res) => res.json());
    expect(preview.rows.filter((r) => r.kind === "data").map((r) => r.labels[0]))
      .toEqual(rows.map(([label]) => label));
  }, 90_000);

  test("A COMPARISON IS ONE QUESTION, AND AGREES WITH THE SHEET TO THE DECIMAL", async () => {
    if (skipIfDown()) return;
    const layout = LAYOUT({
      comparisons: [{ field: "amount.debit", mode: "previous_period",
                      display: "percentage_difference", with: null }],
    });
    const chart = await session({ ...layout, visualization: { type: "bar" } });
    expect(chart.body.chartSupported).toBe(true);
    await cardIdOf(chart.body.embedToken);

    const rows = (await anon(`/api/embed/card/${chart.body.embedToken}/query`)).json.data.rows;
    const cols = (await anon(`/api/embed/card/${chart.body.embedToken}/query`)).json.data.cols;
    expect(cols.map((c) => c.display_name)).toEqual([
      expect.any(String), expect.stringContaining("Debit"),
      expect.stringContaining("% change vs previous period"),
    ]);

    const preview = await fetch(`${origin}/api/accountant/reporting/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...layout, limit: 100 }),
    }).then((res) => res.json());

    const ci = preview.leafColumns.findIndex((c) => c.isComparison);
    const fromChart = new Map(rows.map((row) => [row[0], row[2]]));
    for (const row of preview.rows.filter((r) => r.kind === "data")) {
      const sheet = row.cells[ci].value;
      const chartValue = fromChart.get(row.labels[0]);
      if (sheet === null) expect(chartValue).toBeNull();
      else expect(Number(chartValue)).toBeCloseTo(Number(sheet), 6);
    }
  }, 120_000);

  test("a comparison of an average is refused rather than approximated", async () => {
    if (skipIfDown()) return;
    const r = await session({
      ...LAYOUT({
        values: [{ field: "amount.debit", calculation: "average" }],
        comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
      }),
    });
    expect(r.status).toBe(200);
    expect(r.body.chartSupported).toBe(false);
    expect(r.body.embedToken).toBeUndefined();
  }, 60_000);

  test("THE SAME LAYOUT REUSES ONE QUESTION; A CHANGED ONE MAKES ANOTHER", async () => {
    if (skipIfDown()) return;
    const first = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const again = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const changed = await session({ ...LAYOUT(), visualization: { type: "row" } });

    const a = await cardIdOf(first.body.embedToken);
    const b = await cardIdOf(again.body.embedToken);
    const c = await cardIdOf(changed.body.embedToken);

    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(await liveCount("draft")).toBe(2);
  }, 90_000);

  test("the questions are filed in the private collection, and nowhere else", async () => {
    if (skipIfDown()) return;
    const r = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const cardId = await cardIdOf(r.body.embedToken);

    const card = await fetch(`${SITE}/api/card/${cardId}`, {
      headers: { "x-api-key": process.env.METABASE_REPORTING_API_KEY },
    }).then((res) => res.json());

    const collection = await bridge.ensureCollection();
    expect(card.collection_id).toBe(collection);
    expect(card.name).toMatch(/^GRAV /);
    expect(card.enable_embedding).toBe(true);
  }, 60_000);

  /* ── Security, against the running instance ───────────────────────────── */

  test("A TOKEN IS ONLY EVER A TICKET TO ONE QUESTION", async () => {
    if (skipIfDown()) return;
    const mine = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const cardId = await cardIdOf(mine.body.embedToken);
    const secret = process.env.METABASE_EMBEDDING_SECRET;
    const soon = () => Math.floor(Date.now() / 1000) + 120;

    /* The signature is the whole authority. Without the secret a token for our
       own question is refused outright. */
    const forged = jwt.sign({ resource: { question: cardId }, params: {} }, "not-the-embedding-secret");
    expect((await anon(`/api/embed/card/${forged}/query`)).status).toBe(400);

    /* And a correctly-signed token still reaches only a question that was
       PREPARED for embedding — a question nobody has enabled is not openable
       however the token names it. */
    const notEmbeddable = jwt.sign(
      { resource: { question: 999_999_999 }, params: {}, exp: soon() }, secret);
    expect((await anon(`/api/embed/card/${notEmbeddable}/query`)).status).toBe(400);

    /* What a token CANNOT do, even correctly signed, is reach another
       organisation's figures: the scope is compiled into the question's own
       query and is not addressable from outside it — which the parameter test
       below proves against this instance, and the compiler tests prove for
       every shape of report. */
    const legit = await anon(`/api/embed/card/${mine.body.embedToken}/query`);
    expect(legit.status).toBe(202);
  }, 60_000);

  test("AN EXPIRED TOKEN IS REFUSED", async () => {
    if (skipIfDown()) return;
    const mine = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const cardId = await cardIdOf(mine.body.embedToken);

    const expired = jwt.sign(
      { resource: { question: cardId }, params: {}, exp: Math.floor(Date.now() / 1000) - 3600 },
      process.env.METABASE_EMBEDDING_SECRET,
    );
    const r = await anon(`/api/embed/card/${expired}/query`);
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/expired/i);
  }, 60_000);

  test("THE TENANT FILTERS CANNOT BE REPLACED FROM THE BROWSER", async () => {
    if (skipIfDown()) return;
    const mine = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    await cardIdOf(mine.body.embedToken);
    const token = mine.body.embedToken;

    // On the URL.
    expect((await anon(`/api/embed/card/${token}/query?company_id=${OTHER}`)).status).toBe(400);
    // In the token itself, correctly signed.
    const withParams = jwt.sign(
      { resource: { question: jwt.decode(token).resource.question },
        params: { company_id: OTHER }, exp: Math.floor(Date.now() / 1000) + 120 },
      process.env.METABASE_EMBEDDING_SECRET,
    );
    const r = await anon(`/api/embed/card/${withParams}/query`);
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/unknown parameter/i);

    // And the rows are this company's, whatever anyone asks for.
    const rows = (await anon(`/api/embed/card/${token}/query`)).json.data.rows;
    expect(rows.length).toBeGreaterThan(0);
  }, 60_000);

  test("THE QUESTION CANNOT BE OPENED AS ANYTHING ELSE", async () => {
    if (skipIfDown()) return;
    const mine = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const cardId = await cardIdOf(mine.body.embedToken);

    // No session, no key.
    expect((await anon(`/api/card/${cardId}`)).status).toBe(401);
    expect((await anon(`/api/collection`)).status).toBe(401);

    // And the key this server queries with cannot run SQL at all.
    const native = await fetch(`${SITE}/api/dataset`, {
      method: "POST",
      headers: { "x-api-key": process.env.METABASE_REPORTING_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ database: 2, type: "native", native: { query: "SELECT 1" } }),
    });
    expect(native.status).toBe(403);
  }, 60_000);

  test("no response carries a credential or an engine identifier", async () => {
    if (skipIfDown()) return;
    const r = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    await cardIdOf(r.body.embedToken);
    const text = JSON.stringify(r.body);

    expect(text).not.toContain(process.env.METABASE_REPORTING_API_KEY);
    expect(text).not.toContain(process.env.METABASE_EMBED_ADMIN_API_KEY || "impossible");
    expect(text).not.toContain(process.env.METABASE_EMBEDDING_SECRET);
    for (const word of ["dataset_query", "source-table", "collection_id", "card_id", "database"]) {
      expect(text).not.toContain(word);
    }
    expect(r.headers.get("cache-control")).toBe("no-store");
  }, 60_000);

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  test("CLEANUP ARCHIVES STALE DRAFTS AND LEAVES SAVED REPORTS ALONE", async () => {
    if (skipIfDown()) return;
    const draft = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    const draftCard = await cardIdOf(draft.body.embedToken);

    // A saved-report row pointing at the same question, to prove the filter is
    // `kind` and not "it looks old".
    await registry.insert({
      organizationId: ORG_ID, kind: "saved",
      reportId: String(new mongoose.Types.ObjectId()), layoutHash: `saved-${Date.now()}`,
      cardId: draftCard,
    });
    await pg.query("admin",
      "UPDATE reporting.report_chart SET last_used_at = to_timestamp(0) WHERE kind = 'draft'");

    const dry = await bridge.cleanupDrafts({ olderThanMs: 1000, apply: false });
    expect(dry.considered).toBeGreaterThanOrEqual(1);
    expect(dry.archived).toBe(0);

    const applied = await bridge.cleanupDrafts({ olderThanMs: 1000, apply: true });
    expect(applied.archived).toBeGreaterThanOrEqual(1);
    expect(applied.failed).toEqual([]);

    expect(await liveCount("saved")).toBe(1);
    expect(await liveCount("draft")).toBe(0);

    // An archived question no longer renders, which is the point of archiving.
    const token = bridge.signEmbedToken(draftCard);
    expect((await anon(`/api/embed/card/${token}/query`)).status).toBe(400);
  }, 120_000);

  test("a saved report's question is updated in place, not replaced", async () => {
    if (skipIfDown()) return;
    const create = await fetch(`${origin}/api/accountant/reporting/custom-reports`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...LAYOUT(), name: `Saved chart ${Date.now()}`,
                             visualization: { type: "bar" } }),
    }).then((res) => res.json());

    const first = await session({ reportId: create.report.id });
    const cardId = await cardIdOf(first.body.embedToken);

    // Change the report; the question follows it rather than a new one appearing.
    await fetch(`${origin}/api/accountant/reporting/custom-reports/${create.report.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ ...LAYOUT({ values: [{ field: "amount.credit", calculation: "total" }] }),
                             name: create.report.name }),
    });

    const after = await session({ reportId: create.report.id });
    expect(after.status).toBe(200);
    expect(await cardIdOf(after.body.embedToken)).toBe(cardId);
    expect(await liveCount("saved")).toBe(1);

    // And deleting the report takes the question with it.
    await fetch(`${origin}/api/accountant/reporting/custom-reports/${create.report.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}` },
    });
    expect(await liveCount("saved")).toBe(0);
    expect((await anon(`/api/embed/card/${bridge.signEmbedToken(cardId)}/query`)).status).toBe(400);
  }, 150_000);

  test("downloads work through the embed token; drill-through does not", async () => {
    if (skipIfDown()) return;
    const r = await session({ ...LAYOUT(), visualization: { type: "bar" } });
    await cardIdOf(r.body.embedToken);

    /* A static embed CAN hand the viewer the figures as a file — verified,
       because "downloads" is one of the Metabase features worth keeping. */
    const csv = await fetch(`${SITE}/api/embed/card/${r.body.embedToken}/query/csv`);
    expect(csv.status).toBe(200);
    expect((await csv.text()).split("\n")[0]).toMatch(/,/);

    /* It CANNOT let the viewer click through to the underlying records: that
       needs the interactive embedding this licence does not carry, and the
       endpoint a drill-through would use is not open to a token. */
    const drill = await anon(`/api/embed/card/${r.body.embedToken}/query/json?filtered=1`);
    expect([400, 401, 404]).toContain(drill.status);
  }, 60_000);
});
