// test/accountant/reporting-integration.route.test.js
//
// THE REAL ENGINE, THE REAL MART, THE REAL METABASE.
//
// The pure suite proves what the compiler emits; the route suite proves who may
// ask for what. Neither can show that the query Metabase actually accepts
// returns the numbers the mart actually holds — and that is the only thing that
// makes the screen trustworthy. So this runs the whole path and checks every
// figure against Postgres directly.
//
//
// ── RUN THESE SERIALLY: `npm run test:reporting:live` ───────────────────────
// Both live suites talk to ONE Metabase and one reporting mart. Run in
// parallel they queue behind each other's pivots and time out — the whole set
// took nineteen minutes and failed; in band it takes twenty-four seconds and
// passes. The failure looks like flakiness and is contention, which is why it
// is written down here rather than rediscovered.
// Skipped, visibly, when the pilot is not up. A suite that silently passes when
// the thing it tests is absent is worse than no suite.
"use strict";

require("dotenv").config();

process.env.JWT_SECRET = process.env.JWT_SECRET || "test_secret_reporting_integration_v2";
process.env.ACCOUNTANT_AUTH_BYPASS = "false";

const express = require("express");
const mongoose = require("mongoose");

const { Acc_Organization, Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const { signOrgToken } = require("../../Middlewear/AccountantOrgAuthMiddleware");
const pg = require("../../services/reporting/pgClient");

/* The REAL ids in the local development database: the compiled tenant filters
   ARE these values, so a fixture with a random id would compile a query that
   correctly matches nothing and the suite would pass while proving nothing. */
const ORG_ID = "6a073de21fecacc9bb714481";
const GRAV = "6a08040a1fecacc9bb7149c2";
const IE_GARMENTS = "6ab1459d11fca003ca6f6062";

const CONFIGURED =
  Boolean(process.env.METABASE_SITE_URL) &&
  Boolean(process.env.METABASE_REPORTING_API_KEY) &&
  Boolean(process.env.REPORTING_ADMIN_URL);

let reachable = false;
let server, origin, bearer;
const truth = {};

const describeOrSkip = CONFIGURED ? describe : describe.skip;
if (!CONFIGURED) {
  test("reporting integration is SKIPPED — the Metabase pilot is not configured", () => {
    expect(CONFIGURED).toBe(false);
  });
}

describeOrSkip("Custom Reports against the live pilot", () => {
  beforeAll(async () => {
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const res = await fetch(`${process.env.METABASE_SITE_URL}/api/health`, { signal: AbortSignal.timeout(5000) });
      reachable = res.ok;
    } catch { reachable = false; }
    if (!reachable) return;

    const app = express();
    app.use(express.json());
    app.use("/api/accountant/reporting", require("../../routes/Accountant_Routes/Acc_reporting"));
    await new Promise((r) => { server = app.listen(0, r); });
    origin = `http://127.0.0.1:${server.address().port}`;

    // Every assertion is checked against these, read straight from Postgres.
    const q = async (sql, params) => (await pg.query("admin", sql, params)).rows;
    truth.byGroupMonth = await q(
      `SELECT group_name, to_char(period_month,'YYYY-MM') AS m, SUM(debit) d, SUM(credit) c
         FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY group_name, period_month ORDER BY group_name, period_month`, [GRAV]);
    truth.grand = (await q(
      `SELECT SUM(debit) d, SUM(credit) c FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'`, [GRAV]))[0];
    truth.months = (await q(
      `SELECT DISTINCT to_char(period_month,'YYYY-MM') AS m FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        ORDER BY 1`, [GRAV])).map((r) => r.m);
    truth.dataAsOf = (await q(
      `SELECT max(finished_at) f FROM reporting.mart_sync_run
        WHERE company_id = $1 AND status = 'succeeded'`, [GRAV]))[0].f;
    truth.priorGrand = (await q(
      `SELECT SUM(debit) d FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-05-03' AND '2025-07-31'`, [GRAV]))[0];
  }, 60_000);

  /* Rebuilt for EVERY test: test/setup.js clears collections after each one. */
  beforeEach(async () => {
    if (!reachable) return;
    for (const [id, name] of [[GRAV, "GRAV CLOTHING PVT LTD"], [IE_GARMENTS, "IE Demo Garments"]]) {
      await Acc_Company.create({
        _id: new mongoose.Types.ObjectId(id), companyName: name,
        booksFromDate: new Date("2025-04-01"),
      });
    }
    // This fixture organisation owns ONLY GRAV CLOTHING, so IE Demo Garments is
    // the inaccessible company the scope tests need.
    const org = await Acc_Organization.create({
      _id: new mongoose.Types.ObjectId(ORG_ID), name: "GRAV",
      tallyCompanyIds: [new mongoose.Types.ObjectId(GRAV)],
    });
    const user = new Acc_User({
      organizationId: org._id, name: "Integration Owner",
      email: "integration@example.com", role: "owner",
    });
    await user.setPassword("a-long-enough-password");
    await user.save();
    bearer = signOrgToken(user);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    if (server) await new Promise((r) => server.close(r));
    await pg.closeAll();
  });

  const skipIfDown = () => !reachable;

  async function call(path, { method = "GET", body, raw = false } = {}) {
    const res = await fetch(`${origin}/api/accountant/reporting${path}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (raw) return res;
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text.slice(0, 300) }; }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  const AUG_OCT = { field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-10-31"] };
  const PIVOT = (over = {}) => ({
    name: "Ledger group by month",
    companyIds: [GRAV],
    rows: [{ field: "ledger.group", heading: "Ledger Group" }],
    columns: [{ field: "date.month", heading: "Month" }],
    values: [
      { field: "amount.debit", heading: "Debit", calculation: "total" },
      { field: "amount.credit", heading: "Credit", calculation: "total" },
    ],
    filters: [AUG_OCT],
    limit: 100,
    ...over,
  });

  /* ═══════════════════════════════════════════════════════════════════════ */

  test("the mart is synced and the synthetic schema is gone", async () => {
    if (skipIfDown()) return;
    expect(truth.dataAsOf).toBeTruthy();
    expect(truth.byGroupMonth.length).toBeGreaterThan(0);
    const { rows } = await pg.query("admin",
      "SELECT count(*) n FROM information_schema.tables WHERE table_schema = 'accounting'");
    expect(Number(rows[0].n)).toBe(0);
  });

  test("the catalogue is one flat list of real fields", async () => {
    if (skipIfDown()) return;
    const r = await call(`/catalog?companyId=${GRAV}`);
    expect(r.status).toBe(200);
    /* `grain` joined the catalogue in slice B2, so the frontend can say WHY a
       voucher number repeats down a list instead of guessing. */
    expect(Object.keys(r.body).sort()).toEqual(["fields", "grain"]);
    expect(r.body.grain.id).toBe("voucher_line");
    expect(r.body.fields.map((f) => f.id)).toEqual(
      expect.arrayContaining(["date.voucher", "ledger.group", "amount.debit", "amount.credit"]),
    );
  });

  test("THE MATRIX AGREES WITH THE MART, cell by cell", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", { method: "POST", body: PIVOT() });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("summary");

    // Every row's cells align with leafColumns — including totals.
    for (const row of r.body.rows) expect(row.cells).toHaveLength(r.body.leafColumns.length);
    expect(r.body.grandTotal.cells).toHaveLength(r.body.leafColumns.length);

    // MONTHS ARE CHRONOLOGICAL.
    const monthLevel = r.body.columnLevels.find((l) => l.heading === "Month");
    const shown = monthLevel.headers.filter((h) => h.label !== "Total").map((h) => h.label);
    /* Full month names since slice B2: a month's label is the month's own
       sentence, the same one its key and its cells carry. */
    const MONTHS = ["January", "February", "March", "April", "May", "June",
                    "July", "August", "September", "October", "November", "December"];
    const expected = truth.months.map((m) => {
      const [y, mm] = m.split("-");
      return `${MONTHS[Number(mm) - 1]} ${y}`;
    });
    expect(shown).toEqual(expected);

    // Every data cell equals the mart's own figure.
    const wanted = new Map(truth.byGroupMonth.map((t) => [`${t.group_name}|${t.m}`, t]));
    for (const row of r.body.rows.filter((x) => x.kind === "data")) {
      const group = row.labels[0];
      truth.months.forEach((m, i) => {
        const t = wanted.get(`${group}|${m}`);
        // Two values per month: debit then credit, in the layout's order.
        const debit = row.cells[i * 2].value;
        const credit = row.cells[i * 2 + 1].value;
        if (t) {
          expect(Number(debit)).toBeCloseTo(Number(t.d), 2);
          expect(Number(credit)).toBeCloseTo(Number(t.c), 2);
        } else {
          expect(debit).toBeNull();
        }
      });
    }
  }, 60_000);

  test("ROW AND GRAND TOTALS MATCH THE MART", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", { method: "POST", body: PIVOT() });
    const totalLeaves = r.body.leafColumns
      .map((c, i) => ({ ...c, i }))
      .filter((c) => c.isTotal);
    expect(totalLeaves).toHaveLength(2);

    expect(Number(r.body.grandTotal.cells[totalLeaves[0].i].value)).toBeCloseTo(Number(truth.grand.d), 2);
    expect(Number(r.body.grandTotal.cells[totalLeaves[1].i].value)).toBeCloseTo(Number(truth.grand.c), 2);

    // The column-total row exists and agrees with the grand total's row-total.
    const totalRow = r.body.rows.find((x) => x.kind === "total");
    expect(totalRow).toBeTruthy();
    expect(Number(totalRow.cells[totalLeaves[0].i].value)).toBeCloseTo(Number(truth.grand.d), 2);

    // And each row's own total is the sum of its months, from its own query.
    for (const row of r.body.rows.filter((x) => x.kind === "data")) {
      const monthly = truth.months.map((_, i) => Number(row.cells[i * 2].value || 0));
      expect(Number(row.cells[totalLeaves[0].i].value)).toBeCloseTo(monthly.reduce((a, b) => a + b, 0), 2);
    }
  }, 60_000);

  test("NESTED ROWS PRODUCE SUBTOTALS from their own aggregate query", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: PIVOT({
        rows: [{ field: "ledger.group", heading: "Group" }, { field: "ledger.name", heading: "Ledger" }],
        values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
        filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-08-31"] }],
      }),
    });
    expect(r.status).toBe(200);
    const subtotals = r.body.rows.filter((x) => x.kind === "subtotal");
    expect(subtotals.length).toBeGreaterThan(0);
    for (const row of r.body.rows) expect(row.cells).toHaveLength(r.body.leafColumns.length);

    const { rows: mart } = await pg.query("admin",
      `SELECT group_name, SUM(debit) d FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-08-31'
        GROUP BY group_name`, [GRAV]);
    const byGroup = new Map(mart.map((m) => [m.group_name, Number(m.d)]));
    const totalLeaf = r.body.leafColumns.findIndex((c) => c.isTotal);
    for (const s of subtotals) {
      const group = s.labels[0].replace(/ total$/, "");
      expect(Number(s.cells[totalLeaf].value)).toBeCloseTo(byGroup.get(group), 2);
    }
  }, 60_000);

  test("A PREVIOUS-PERIOD COMPARISON IS COMPUTED SERVER-SIDE AND IS CORRECT", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: PIVOT({
        columns: [],
        values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
        comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference", with: null }],
      }),
    });
    expect(r.status).toBe(200);
    const cmp = r.body.leafColumns.findIndex((c) => c.isComparison);
    expect(cmp).toBeGreaterThanOrEqual(0);
    expect(r.body.leafColumns[cmp].heading).toMatch(/change vs previous period/i);

    // The shifted window for 1 Aug–31 Oct (92 days) is 1 May–31 Jul 2025.
    const { rows: prior } = await pg.query("admin",
      `SELECT group_name, SUM(debit) d FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-05-01' AND '2025-07-31'
        GROUP BY group_name`, [GRAV]);
    const priorBy = new Map(prior.map((p) => [p.group_name, Number(p.d)]));

    const valueLeaf = r.body.leafColumns.findIndex((c) => !c.isComparison && !c.isTotal);
    for (const row of r.body.rows.filter((x) => x.kind === "data")) {
      const current = Number(row.cells[valueLeaf].value || 0);
      const was = priorBy.get(row.labels[0]) || 0;
      expect(Number(row.cells[cmp].value)).toBeCloseTo(current - was, 2);
    }
  }, 60_000);

  test("a percentage comparison against zero is null, never Infinity", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: PIVOT({
        columns: [],
        values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
        comparisons: [{ field: "amount.debit", mode: "previous_period", display: "percentage_difference", with: null }],
      }),
    });
    const cmp = r.body.leafColumns.findIndex((c) => c.isComparison);
    for (const row of r.body.rows) {
      const v = row.cells[cmp].value;
      expect(v === null || Number.isFinite(Number(v))).toBe(true);
    }
    // At least one group has no prior-period figure in this dataset.
    expect(r.body.rows.some((row) => row.cells[cmp].value === null)).toBe(true);
  }, 60_000);

  test("a detail report lists real records", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: {
        name: "Detail", companyIds: [GRAV],
        rows: [
          { field: "date.voucher", heading: "Date" },
          { field: "voucher.number", heading: "Voucher No." },
          { field: "party.name", heading: "Party" },
          { field: "amount.debit", heading: "Debit" },
          { field: "amount.credit", heading: "Credit" },
        ],
        filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-08-31"] }],
        limit: 10,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("detail");
    expect(r.body.leafColumns.map((c) => c.heading)).toEqual(["Date", "Voucher No.", "Party", "Debit", "Credit"]);
    expect(r.body.rows.length).toBe(10);
    for (const row of r.body.rows) expect(row.cells).toHaveLength(5);

    const { rows } = await pg.query("admin",
      `SELECT count(*) n FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-08-31'`, [GRAV]);
    expect(r.body.totalRowCount).toBe(Number(rows[0].n));
    expect(r.body.truncated).toBe(true);
    // B4: a list counts records. There are no groups to count, and the
    // omitted records' figures are not invented.
    expect(r.body.previewRowCount).toBe(10);
    expect(r.body.groupCount).toBeNull();
    expect(r.body.omitted).toEqual({ rows: Number(rows[0].n) - 10, values: null });
  }, 60_000);

  test("dataAsOf is the mart's last successful sync, not a clock", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", { method: "POST", body: PIVOT() });
    expect(r.body.dataAsOf).toBe(new Date(truth.dataAsOf).toISOString());
    expect(Date.parse(r.body.dataAsOf)).toBeLessThan(Date.now() - 1000);
  });

  test("AN INACCESSIBLE COMPANY REFUSES THE WHOLE REQUEST", async () => {
    if (skipIfDown()) return;
    const alone = await call("/preview", { method: "POST", body: PIVOT({ companyIds: [IE_GARMENTS] }) });
    expect([alone.status, alone.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
    // And mixed with an accessible one — never a partial run.
    const mixed = await call("/preview", { method: "POST", body: PIVOT({ companyIds: [GRAV, IE_GARMENTS] }) });
    expect([mixed.status, mixed.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
  });

  test("A CRAFTED PAYLOAD IS REFUSED BY THE LIVE ROUTE", async () => {
    if (skipIfDown()) return;
    for (const body of [
      { ...PIVOT(), sql: "SELECT * FROM reporting.dim_ledger" },
      { ...PIVOT(), native: { query: "SELECT current_user" } },
      PIVOT({ rows: [{ field: "voucher_date" }] }),
      PIVOT({ rows: [{ field: "ledger_group" }] }),
      PIVOT({ values: [{ field: "signed_amount", calculation: "total" }] }),
      PIVOT({ filters: [AUG_OCT, { field: "company_id", operation: "is", value: IE_GARMENTS }] }),
    ]) {
      const r = await call("/preview", { method: "POST", body });
      expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    }
  });

  test("AN INCOMPATIBLE-GRAIN COMBINATION IS REFUSED", async () => {
    if (skipIfDown()) return;
    /* The live catalogue is one grain, so the fields that WOULD duplicate money
       are simply absent — asserted here, because "cannot be combined" and
       "cannot be named at all" are both correct answers and only one of them
       is what this catalogue does. */
    const r = await call("/preview", {
      method: "POST", body: PIVOT({ values: [{ field: "amount.voucher_total", calculation: "total" }] }),
    });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    const cat = await call(`/catalog?companyId=${GRAV}`);
    const ids = cat.body.fields.map((f) => f.id);
    expect(ids).not.toContain("amount.voucher_total");
    expect(ids).not.toContain("balance.opening");
  });

  test("THE XLSX IS A REAL WORKBOOK, and says it is flat rather than pivoted", async () => {
    if (skipIfDown()) return;
    const res = await call("/export/xlsx", {
      method: "POST", raw: true,
      body: PIVOT({ name: "August to October", limit: null }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="august-to-october-\d{4}-\d{2}-\d{2}\.xlsx"/);
    // The limitation is stated, not implied away.
    expect(res.headers.get("x-reporting-layout")).toBe("flat-aggregation");

    const buffer = Buffer.from(await res.arrayBuffer());
    expect(buffer.slice(0, 2).toString()).toBe("PK");

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];

    /* PARITY OF FIGURES, not of shape: the workbook is one row per
       (group, month) with debit and credit alongside, and its totals must equal
       the preview's to the paisa. */
    expect(ws.rowCount - 1).toBe(truth.byGroupMonth.length);
    let debit = 0;
    for (let i = 2; i <= ws.rowCount; i += 1) debit += Number(ws.getRow(i).getCell(3).value || 0);
    expect(debit).toBeCloseTo(Number(truth.grand.d), 2);
    expect(typeof ws.getRow(2).getCell(3).value).toBe("number");
  }, 90_000);

  /* ── Characterized during the semantic-contract audit (2026-09-26) ──────
     docs/audits/accounting-custom-report-semantic-contract-audit.md. These
     pin what the workbook ACTUALLY contains today, including two things the
     audit found wrong: the headings are the engine's column names, and a month
     is written as a day-formatted date. The slice that fixes either must
     update the assertion rather than discover the change in a downloaded
     file. */
  test("XLSX: a voucher number stays text, and 00531 keeps its zeroes", async () => {
    if (skipIfDown()) return;
    const res = await call("/export/xlsx", {
      method: "POST", raw: true,
      body: {
        name: "Voucher numbers", companyIds: [GRAV],
        rows: [{ field: "voucher.number" }, { field: "amount.debit" }],
        filters: [{ field: "voucher.number", operation: "is", value: "00531" }],
        limit: null,
      },
    });
    expect(res.status).toBe(200);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const cell = wb.worksheets[0].getRow(2).getCell(1);
    expect(typeof cell.value).toBe("string");
    expect(cell.value).toBe("00531");
  }, 90_000);

  /* ── Slice B5: the file GRAV writes, opened and read back ────────────────
     Metabase still computes every figure; these check the PRESENTATION and
     then reconcile the figures against the mart so the presentation cannot
     have quietly changed one. */
  const openWorkbook = async (body) => {
    const res = await call("/export/xlsx", { method: "POST", raw: true, body });
    expect(res.status).toBe(200);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    return { res, wb, ws: wb.worksheets[0] };
  };

  test("XLSX: A MONTH SUMMARY IS HEADED `Month` AND FORMATTED `mmmm yyyy`", async () => {
    if (skipIfDown()) return;
    const { ws } = await openWorkbook({
      name: "Months", companyIds: [GRAV],
      rows: [{ field: "date.month" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [AUG_OCT],
      limit: null,
    });

    expect(ws.getRow(1).values.slice(1)).toEqual(["Month", "Total Debit"]);
    const month = ws.getRow(2).getCell(1);
    expect(month.value).toBeInstanceOf(Date);
    expect(month.numFmt).toBe("mmmm yyyy");
    // August, not "August 1", and not July — the +05:30 instant is not parsed.
    expect(month.value.toISOString()).toBe("2025-08-01T00:00:00.000Z");
    expect(ws.getRow(2).getCell(2).numFmt).toContain("₹");

    /* The figures are still the engine's, to the paisa. */
    const mart = (await pg.query("admin",
      `SELECT to_char(period_month,'YYYY-MM') m, SUM(debit) d FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY period_month ORDER BY period_month`, [GRAV])).rows;
    expect(ws.rowCount - 1).toBe(mart.length);
    mart.forEach((row, i) => {
      const cell = ws.getRow(i + 2);
      expect(cell.getCell(1).value.toISOString().slice(0, 7)).toBe(row.m);
      expect(Number(cell.getCell(2).value)).toBeCloseTo(Number(row.d), 2);
    });
  }, 120_000);

  test("XLSX: A DETAIL WORKBOOK KEEPS ITS DATES, ITS ZEROES AND ITS BLANKS", async () => {
    if (skipIfDown()) return;
    const { ws } = await openWorkbook({
      name: "August detail", companyIds: [GRAV],
      rows: [
        { field: "voucher.number" }, { field: "date.voucher" },
        { field: "party.name" }, { field: "amount.debit" }, { field: "amount.credit" },
      ],
      filters: [{ field: "date.voucher", operation: "between", value: ["2025-08-01", "2025-08-31"] }],
      limit: null,
    });

    expect(ws.getRow(1).values.slice(1))
      .toEqual(["Voucher Number", "Voucher Date", "Party", "Debit", "Credit"]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(ws.autoFilter).toMatch(/^A1:E\d+$/);

    const ExcelJS = require("exceljs");
    let blankParties = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      expect(typeof row.getCell(1).value).toBe("string");        // voucher number
      expect(row.getCell(2).value).toBeInstanceOf(Date);          // voucher date
      expect(row.getCell(2).numFmt).toBe("dd mmm yyyy");
      // Inside the filter, to the day, with no timezone slide.
      const day = row.getCell(2).value.toISOString().slice(0, 10);
      expect(day >= "2025-08-01" && day <= "2025-08-31").toBe(true);

      /* Most lines in this mart carry no party. The cell must be EMPTY — not
         zero, not "(none)", not the word null. */
      const party = row.getCell(3);
      if (party.type === ExcelJS.ValueType.Null) {
        blankParties += 1;
        expect(party.value).toBeNull();
        expect(String(party.text ?? "")).toBe("");
      } else {
        expect(typeof party.value).toBe("string");
      }

      for (const c of [4, 5]) {
        const cell = row.getCell(c);
        if (cell.type === ExcelJS.ValueType.Null) continue;   // a blank figure is allowed
        expect(cell.type).toBe(ExcelJS.ValueType.Number);     // never a formatted string
        expect(cell.numFmt).toContain("0.00");
      }
    }
    expect(blankParties).toBeGreaterThan(0);

    const mart = (await pg.query("admin",
      `SELECT count(*)::int n, SUM(debit) d, SUM(credit) c FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-08-31'`, [GRAV])).rows[0];
    expect(ws.rowCount - 1).toBe(mart.n);
    const column = (c) => {
      let sum = 0;
      for (let r = 2; r <= ws.rowCount; r += 1) {
        const v = ws.getRow(r).getCell(c).value;
        if (typeof v === "number") sum += v;
      }
      return sum;
    };
    expect(column(4)).toBeCloseTo(Number(mart.d), 2);
    expect(column(5)).toBeCloseTo(Number(mart.c), 2);
  }, 180_000);

  test("XLSX: 00531 SURVIVES THE ROUND TRIP AS TEXT", async () => {
    if (skipIfDown()) return;
    const { ws } = await openWorkbook({
      name: "Voucher numbers", companyIds: [GRAV],
      rows: [{ field: "voucher.number" }, { field: "amount.debit" }],
      filters: [{ field: "voucher.number", operation: "is", value: "00531" }],
      limit: null,
    });
    const cell = ws.getRow(2).getCell(1);
    expect(typeof cell.value).toBe("string");
    expect(cell.value).toBe("00531");
  }, 90_000);

  test("XLSX: LEDGER GROUP × MONTH IS A FLAT LIST WITH FRIENDLY HEADINGS, AND SAYS SO", async () => {
    if (skipIfDown()) return;
    const { res, ws } = await openWorkbook({
      name: "Group by month", companyIds: [GRAV],
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [AUG_OCT],
      limit: null,
    });

    expect(ws.getRow(1).values.slice(1)).toEqual(["Ledger Group", "Month", "Total Debit"]);
    expect(res.headers.get("x-reporting-layout")).toBe("flat-aggregation");
    expect(res.headers.get("x-reporting-layout-note")).toMatch(/flat list rather than the pivoted matrix/i);

    const mart = (await pg.query("admin",
      `SELECT count(*)::int n, SUM(d)::numeric total FROM (
         SELECT SUM(debit) d FROM reporting.v_general_ledger
          WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
          GROUP BY group_name, period_month) x`, [GRAV])).rows[0];
    expect(ws.rowCount - 1).toBe(mart.n);
    let total = 0;
    for (let r = 2; r <= ws.rowCount; r += 1) total += Number(ws.getRow(r).getCell(3).value ?? 0);
    expect(total).toBeCloseTo(Number(mart.total), 2);
  }, 120_000);

  test("XLSX: A COUNT AND A MONEY COLUMN IN ONE FILE, FORMATTED APART", async () => {
    if (skipIfDown()) return;
    const { ws } = await openWorkbook({
      name: "Lines and money", companyIds: [GRAV],
      rows: [{ field: "ledger.group" }],
      values: [
        { field: "amount.debit", heading: "Debit", calculation: "count" },
        { field: "amount.debit", heading: "Debit", calculation: "total" },
      ],
      filters: [AUG_OCT],
      limit: null,
    });
    expect(ws.getRow(1).values.slice(1)).toEqual(["Ledger Group", "Count of Debit", "Total Debit"]);

    const ExcelJS = require("exceljs");
    const count = ws.getRow(2).getCell(2);
    const money = ws.getRow(2).getCell(3);
    expect(count.type).toBe(ExcelJS.ValueType.Number);
    expect(count.numFmt).toBe("#,##0");
    expect(count.numFmt).not.toContain("₹");
    expect(Number.isInteger(count.value)).toBe(true);
    expect(money.numFmt).toContain("₹");

    const mart = (await pg.query("admin",
      `SELECT group_name, count(*)::int n, SUM(debit) d FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY group_name`, [GRAV])).rows;
    const byGroup = new Map(mart.map((m) => [m.group_name, m]));
    for (let r = 2; r <= ws.rowCount; r += 1) {
      const row = ws.getRow(r);
      const truth = byGroup.get(row.getCell(1).value);
      expect(truth).toBeTruthy();
      expect(row.getCell(2).value).toBe(truth.n);
      expect(Number(row.getCell(3).value)).toBeCloseTo(Number(truth.d), 2);
    }
  }, 120_000);

  test("XLSX: NO ENGINE VOCABULARY IN THE FILE OR ITS HEADERS", async () => {
    if (skipIfDown()) return;
    const { res, wb, ws } = await openWorkbook({
      name: "Leak check", companyIds: [GRAV],
      rows: [{ field: "ledger.group" }],
      columns: [{ field: "date.month" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [AUG_OCT],
      limit: null,
    });

    const cells = [];
    ws.eachRow((row) => row.eachCell((c) => cells.push(String(c.value ?? ""))));
    const inFile = [
      ...cells, ws.name, wb.creator || "", wb.company || "", wb.keywords || "",
    ].join(" | ").toLowerCase();

    for (const leak of [
      "v_general_ledger", "reporting.", "group_name", "period_month", "signed_amount",
      "source-table", "breakout", "aggregation", "metabase", "api_key", "mb_", "select ",
    ]) {
      expect(inFile).not.toContain(leak);
    }

    /* The headers carry two deliberate strings — `flat-aggregation` and its
       note — which exist precisely so nobody assumes the file is the pivot.
       Everything else must still be absent. */
    const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join(" | ").toLowerCase();
    expect(headers).toContain("flat-aggregation");
    for (const leak of [
      "v_general_ledger", "reporting.v_", "group_name", "period_month",
      "source-table", "breakout", "metabase", "api_key", "mb_", "select ",
    ]) {
      expect(headers).not.toContain(leak);
    }
  }, 120_000);

  test("XLSX: AN UNOWNED OR MIXED COMPANY IS REFUSED BEFORE ANY EXPORT RUNS", async () => {
    if (skipIfDown()) return;
    for (const ids of [[IE_GARMENTS], [GRAV, IE_GARMENTS]]) {
      const r = await call("/export/xlsx", {
        method: "POST",
        body: {
          name: "Not mine", companyIds: ids,
          rows: [{ field: "ledger.group" }],
          values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
          filters: [AUG_OCT], limit: null,
        },
      });
      expect([r.status, r.body.code]).toEqual([403, "REPORTING_FORBIDDEN"]);
      // A refusal, not a workbook: nothing about a file came back.
      expect(r.headers.get("content-type")).toMatch(/json/);
      expect(r.headers.get("content-disposition")).toBeNull();
    }
  }, 90_000);


  /* ── Slice B3: the order on screen is the order that was asked for ────────
     Checked against the MART, not against another GRAV response: two services
     agreeing proves they share a bug as readily as it proves they are right. */
  test("A DIMENSION SORT MATCHES THE MART, ASCENDING AND DESCENDING", async () => {
    if (skipIfDown()) return;
    const layout = (direction) => ({
      name: "Sorted", companyIds: [GRAV],
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [AUG_OCT],
      sort: [{ field: "ledger.group", direction }],
      limit: 100,
    });
    const labels = (r) => r.body.rows.filter((x) => x.kind === "data").map((x) => x.labels[0]);

    for (const direction of ["asc", "desc"]) {
      const r = await call("/preview", { method: "POST", body: layout(direction) });
      expect(r.status).toBe(200);
      const fromMart = (await pg.query("admin",
        `SELECT group_name FROM reporting.v_general_ledger
          WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
          GROUP BY group_name ORDER BY group_name ${direction === "desc" ? "DESC" : "ASC"}`,
        [GRAV])).rows.map((x) => x.group_name);
      expect(labels(r)).toEqual(fromMart);
    }

    const asc = await call("/preview", { method: "POST", body: layout("asc") });
    const desc = await call("/preview", { method: "POST", body: layout("desc") });
    expect(labels(desc)).toEqual([...labels(asc)].reverse());
  }, 90_000);

  test("A MEASURE SORT MATCHES THE MART — ledgers by debit", async () => {
    if (skipIfDown()) return;
    const layout = (direction) => ({
      name: "Ledgers by debit", companyIds: [GRAV],
      rows: [{ field: "ledger.name" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [AUG_OCT],
      sort: [{ field: "amount.debit", direction }],
      limit: 500,
    });

    /* Equal figures are common here (many ledgers have no debit at all), and
       GRAV breaks those ties on the label with JavaScript's locale collation
       while Postgres uses its own. The figure sequence must match exactly; the
       names within one figure are compared as a set, which is what the two
       collations legitimately disagree about. The tie-break itself is pinned
       offline in reporting-sorting.test.js. */
    const groupByFigure = (pairs) => {
      const out = [];
      pairs.forEach(([name, total]) => {
        const at = Math.round(Number(total) * 100) / 100;
        const last = out[out.length - 1];
        if (last && last.total === at) last.names.push(name);
        else out.push({ total: at, names: [name] });
      });
      return out.map((g) => ({ total: g.total, names: [...g.names].sort() }));
    };

    for (const direction of ["desc", "asc"]) {
      const r = await call("/preview", { method: "POST", body: layout(direction) });
      expect(r.status).toBe(200);
      const rows = r.body.rows.filter((x) => x.kind === "data");

      const fromMart = (await pg.query("admin",
        `SELECT ledger_name, SUM(debit) AS total FROM reporting.v_general_ledger
          WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
          GROUP BY ledger_name
          ORDER BY SUM(debit) ${direction === "desc" ? "DESC" : "ASC"}`, [GRAV])).rows;

      /* Preview caps the rows it returns, so compare the prefix — minus the
         tie-group the cap lands in the middle of, whose membership either side
         may legitimately differ on. */
      const mine = groupByFigure(rows.map((x) => [x.labels[0], x.cells[0].value]));
      let theirs = groupByFigure(fromMart.map((x) => [x.ledger_name, x.total]))
        .slice(0, mine.length);
      const lastMine = mine[mine.length - 1];
      const lastTheirs = theirs[theirs.length - 1];
      if (lastMine.names.length !== lastTheirs.names.length) {
        mine.pop();
        theirs = theirs.slice(0, -1);
      }
      expect(mine.length).toBeGreaterThan(5);
      expect(mine).toEqual(theirs);

      // And the figures really are ordered, not merely labelled as if they were.
      const figures = rows.map((x) => Number(x.cells[0].value));
      const sorted = [...figures].sort((a, b) => (direction === "desc" ? b - a : a - b));
      expect(figures).toEqual(sorted);
    }
  }, 120_000);

  test("MONTHS SORT BY PERIOD, BOTH WAYS, ACROSS THE YEAR BOUNDARY", async () => {
    if (skipIfDown()) return;
    const layout = (direction) => ({
      name: "By month", companyIds: [GRAV],
      rows: [{ field: "date.month" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [],
      sort: [{ field: "date.month", direction }],
      limit: 100,
    });
    const keysOf = (r) => r.body.rows.filter((x) => x.kind === "data").map((x) => x.keys[0]);

    const fromMart = (await pg.query("admin",
      `SELECT to_char(period_month, 'YYYY-MM') AS m FROM reporting.v_general_ledger
        WHERE company_id = $1 GROUP BY period_month ORDER BY period_month ASC`,
      [GRAV])).rows.map((x) => x.m);

    const asc = await call("/preview", { method: "POST", body: layout("asc") });
    const desc = await call("/preview", { method: "POST", body: layout("desc") });
    expect(keysOf(asc)).toEqual(fromMart);
    expect(keysOf(desc)).toEqual([...fromMart].reverse());
    // The boundary the audit called out, in the real data.
    expect(keysOf(asc).join(",")).toContain("2025-12,2026-01");
    expect(keysOf(desc).join(",")).toContain("2026-01,2025-12");
  }, 90_000);

  test("A SORTED PIVOT KEEPS ITS GROUPS WHOLE AND ITS MONTHS CHRONOLOGICAL", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: PIVOT({
        rows: [{ field: "ledger.group", heading: "Group" }, { field: "ledger.name", heading: "Ledger" }],
        values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
        sort: [{ field: "ledger.group", direction: "desc" }],
        limit: 500,
      }),
    });
    expect(r.status).toBe(200);

    /* The outer level runs backwards, as asked. */
    const groups = [];
    for (const row of r.body.rows.filter((x) => x.kind === "data")) {
      if (groups[groups.length - 1] !== row.labels[0]) groups.push(row.labels[0]);
    }
    const martGroups = (await pg.query("admin",
      `SELECT group_name FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY group_name ORDER BY group_name DESC`, [GRAV])).rows.map((x) => x.group_name);
    expect(groups).toEqual(martGroups.slice(0, groups.length));
    expect(new Set(groups).size).toBe(groups.length);   // each group appears once: contiguous

    /* Every group is closed by its own subtotal before the next one opens, and
       the grand total is last. */
    const shape = r.body.rows.map((x) => ({
      kind: x.kind,
      group: x.kind === "subtotal" ? x.labels[0].replace(/ total$/, "") : x.labels[0],
    }));
    /* Preview caps the rows it returns, so the final group on screen may be cut
       off mid-way; every group that is wholly present is closed by its own
       subtotal before the next one opens. */
    const whole = groups.slice(0, -1);
    expect(whole.length).toBeGreaterThan(3);
    const at = shape.map((x) => x.group);
    whole.forEach((group, i) => {
      const last = at.lastIndexOf(group);
      expect(shape[last].kind).toBe("subtotal");
      expect(shape[last + 1].group).toBe(groups[i + 1]);
    });
    expect(r.body.grandTotal).toBeTruthy();

    /* The column axis is time, and a descending row sort does not turn it round. */
    const semantics = require("../../services/reporting/semantics");
    const martMonths = (await pg.query("admin",
      `SELECT to_char(period_month, 'YYYY-MM-DD') AS m FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY period_month ORDER BY period_month ASC`, [GRAV])).rows.map((x) => x.m);
    const headings = r.body.columnLevels[0].headers
      .map((h) => h.label).filter((l) => l !== "Total");
    expect(headings).toEqual(martMonths.map((m) => semantics.periodText("month", m)));
  }, 120_000);

  test("THE WORKBOOK IS IN THE SAME ORDER AS THE SHEET", async () => {
    if (skipIfDown()) return;
    const layout = {
      name: "Sorted export", companyIds: [GRAV],
      rows: [{ field: "ledger.group" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [AUG_OCT],
      sort: [{ field: "amount.debit", direction: "desc" }],
    };

    const preview = await call("/preview", { method: "POST", body: { ...layout, limit: 100 } });
    const onScreen = preview.body.rows.filter((x) => x.kind === "data").map((x) => x.labels[0]);

    const res = await call("/export/xlsx", { method: "POST", raw: true, body: { ...layout, limit: null } });
    expect(res.status).toBe(200);
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const ws = wb.worksheets[0];
    const inFile = [];
    for (let i = 2; i <= ws.rowCount; i += 1) inFile.push(ws.getRow(i).getCell(1).value);

    expect(inFile).toEqual(onScreen);
    // …and it really is by figure: the first row holds the largest total.
    const fromMart = (await pg.query("admin",
      `SELECT group_name FROM reporting.v_general_ledger
        WHERE company_id = $1 AND voucher_date BETWEEN '2025-08-01' AND '2025-10-31'
        GROUP BY group_name ORDER BY SUM(debit) DESC, group_name ASC LIMIT 1`,
      [GRAV])).rows[0].group_name;
    expect(inFile[0]).toBe(fromMart);
  }, 120_000);


  /* ── Slice B4: the response says how much of the report it is showing ─────
     The audit's own case, against the mart it came from. */
  test("THE 333-LEDGER CASE: VISIBLE + OMITTED = THE MART, FOR EVERY SERIES", async () => {
    if (skipIfDown()) return;
    const body = {
      name: "Every ledger", companyIds: [GRAV],
      rows: [{ field: "ledger.name" }],
      values: [
        { field: "amount.debit", heading: "Debit", calculation: "total" },
        { field: "amount.credit", heading: "Credit", calculation: "total" },
        { field: "amount.signed", heading: "Signed", calculation: "total" },
      ],
      filters: [],
      limit: 100,
    };
    const r = await call("/preview", { method: "POST", body });
    expect(r.status).toBe(200);

    const mart = (await pg.query("admin",
      `SELECT count(DISTINCT ledger_name)::int AS ledgers,
              SUM(debit) AS d, SUM(credit) AS c, SUM(signed_amount) AS s
         FROM reporting.v_general_ledger WHERE company_id = $1`, [GRAV])).rows[0];

    const data = r.body.rows.filter((x) => x.kind === "data");
    expect(data).toHaveLength(100);
    expect(r.body.previewRowCount).toBe(100);
    expect(r.body.groupCount).toBe(mart.ledgers);          // 333
    expect(r.body.totalRowCount).toBe(mart.ledgers);        // unchanged meaning
    expect(r.body.truncated).toBe(true);
    expect(r.body.omitted.rows).toBe(mart.ledgers - 100);   // 233

    const complete = [Number(mart.d), Number(mart.c), Number(mart.s)];
    r.body.leafColumns.forEach((leaf, i) => {
      const visible = data.reduce((n, row) => n + Number(row.cells[i].value ?? 0), 0);
      const omitted = r.body.omitted.values[leaf.id];
      expect(typeof omitted).toBe("number");
      expect(visible + omitted).toBeCloseTo(complete[i], 2);
    });

    /* The finding the audit reported, now measured rather than inferred: the
       hundred rows on screen are a minority of the money. */
    const visibleDebit = data.reduce((n, row) => n + Number(row.cells[0].value ?? 0), 0);
    expect(visibleDebit / Number(mart.d)).toBeLessThan(0.25);

    // A signed amount stays signed: the omitted tail is not an absolute value.
    const signedLeaf = r.body.leafColumns[2];
    const visibleSigned = data.reduce((n, row) => n + Number(row.cells[2].value ?? 0), 0);
    expect(r.body.omitted.values[signedLeaf.id]).toBeCloseTo(-visibleSigned, 2);
    expect(Math.abs(r.body.omitted.values[signedLeaf.id])).toBeGreaterThan(0);
  }, 120_000);

  test("ASCENDING AND DESCENDING OMIT DIFFERENT TAILS AND RECONCILE ALIKE", async () => {
    if (skipIfDown()) return;
    const body = (direction) => ({
      name: "Every ledger", companyIds: [GRAV],
      rows: [{ field: "ledger.name" }],
      values: [{ field: "amount.debit", heading: "Debit", calculation: "total" }],
      filters: [],
      sort: [{ field: "amount.debit", direction }],
      limit: 100,
    });
    const martDebit = Number((await pg.query("admin",
      `SELECT SUM(debit) AS d FROM reporting.v_general_ledger WHERE company_id = $1`,
      [GRAV])).rows[0].d);

    const seen = {};
    for (const direction of ["asc", "desc"]) {
      const r = await call("/preview", { method: "POST", body: body(direction) });
      const data = r.body.rows.filter((x) => x.kind === "data");
      const id = r.body.leafColumns[0].id;
      const visible = data.reduce((n, row) => n + Number(row.cells[0].value ?? 0), 0);
      expect(visible + r.body.omitted.values[id]).toBeCloseTo(martDebit, 2);
      seen[direction] = { labels: data.map((x) => x.labels[0]), omitted: r.body.omitted.values[id] };
    }

    // Different hundred rows, therefore a different omitted figure — and the
    // same complete total either way.
    expect(seen.asc.labels).not.toEqual(seen.desc.labels);
    expect(seen.asc.omitted).toBeGreaterThan(seen.desc.omitted);
  }, 120_000);

  /* ── Slice B6: what a preview is allowed to cost, against the real engine ─ */
  test("THE BOUNDARY LAYOUT STILL PREVIEWS — 24 units, ten real queries", async () => {
    if (skipIfDown()) return;
    const startedAt = Date.now();
    const r = await call("/preview", {
      method: "POST",
      body: {
        name: "Boundary", companyIds: [GRAV],
        rows: [{ field: "ledger.group" }, { field: "ledger.name" },
               { field: "party.name" }, { field: "voucher.type" }],
        columns: [{ field: "date.month" }, { field: "date.financial_year" }],
        values: [
          { field: "amount.debit", calculation: "total" },
          { field: "amount.credit", calculation: "total" },
          { field: "amount.signed", calculation: "total" },
        ],
        filters: [AUG_OCT], limit: 100,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.mode).toBe("summary");
    // Comfortably inside the 20-second request deadline on real data.
    expect(Date.now() - startedAt).toBeLessThan(20_000);
  }, 120_000);

  test("THE 1.76 MB LAYOUT IS REFUSED, AND THE ENGINE IS NEVER ASKED", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: {
        name: "Everything", companyIds: [GRAV],
        rows: [{ field: "ledger.group" }, { field: "ledger.name" }, { field: "party.name" },
               { field: "voucher.type" }, { field: "company.name" }],
        columns: [{ field: "date.month" }, { field: "date.financial_year" }, { field: "voucher.type" }],
        values: [
          { field: "amount.debit", calculation: "total" },
          { field: "amount.credit", calculation: "total" },
          { field: "amount.signed", calculation: "total" },
          { field: "amount.debit", calculation: "average" },
          { field: "amount.credit", calculation: "average" },
          { field: "amount.signed", calculation: "average" },
          { field: "amount.debit", calculation: "maximum" },
          { field: "amount.credit", calculation: "maximum" },
        ],
        filters: [AUG_OCT], limit: 100,
      },
    });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(r.body.message).toBe(
      "This report is too large to preview. Remove a grouping or calculated amount, or add a filter.",
    );
    expect(r.body.report).toEqual({ rowGroupings: 5, columnGroupings: 3, calculations: 8, comparisons: 0 });
    /* The refusal is instant because nothing ran: the audit measured this same
       layout at 2,443 ms and 1.76 MB when it was allowed to. */
    const text = JSON.stringify(r.body).toLowerCase();
    for (const leak of ["v_general_ledger", "group_name", "period_month", "breakout", "metabase"]) {
      expect(text).not.toContain(leak);
    }
  }, 60_000);

  test("THE 22-QUERY COMPARISON IS REFUSED", async () => {
    if (skipIfDown()) return;
    const r = await call("/preview", {
      method: "POST",
      body: {
        name: "Compared", companyIds: [GRAV],
        rows: [{ field: "ledger.group" }, { field: "ledger.name" }, { field: "party.name" },
               { field: "voucher.type" }, { field: "company.name" }],
        values: [{ field: "amount.debit", calculation: "total" }],
        comparisons: [{ field: "amount.debit", mode: "previous_period", display: "difference" }],
        filters: [AUG_OCT], limit: 100,
      },
    });
    expect([r.status, r.body.code]).toEqual([422, "REPORTING_INVALID_SPEC"]);
    expect(r.body.report).toMatchObject({ rowGroupings: 5, comparisons: 1 });

    // The same five levels WITHOUT the comparison are eleven queries and pass.
    const allowed = await call("/preview", {
      method: "POST",
      body: {
        name: "Five levels", companyIds: [GRAV],
        rows: [{ field: "ledger.group" }, { field: "ledger.name" }, { field: "party.name" },
               { field: "voucher.type" }, { field: "company.name" }],
        values: [{ field: "amount.debit", calculation: "total" }],
        filters: [AUG_OCT], limit: 100,
      },
    });
    expect(allowed.status).toBe(200);
  }, 120_000);

  test("the saved-layout lifecycle works against the live catalogue", async () => {
    if (skipIfDown()) return;
    const body = PIVOT({ name: `Integration ${Date.now()}` });
    const created = await call("/custom-reports", { method: "POST", body });
    expect(created.status).toBe(201);
    expect(created.body.report.layoutSummary).toBe("Ledger Group by Month");

    const opened = await call(`/custom-reports/${created.body.report.id}`);
    expect(opened.body.report.staleProblems).toBeNull();
    expect(opened.body.report.schemaVersion).toBe(2);

    // The SAVED layout actually runs.
    const ran = await call("/preview", {
      method: "POST",
      body: { ...opened.body.report.layout, name: "x", companyIds: [GRAV], limit: 10 },
    });
    expect(ran.status).toBe(200);
    expect(ran.body.rows.length).toBeGreaterThan(0);

    expect((await call(`/custom-reports/${created.body.report.id}`, { method: "DELETE" })).body).toEqual({ ok: true });
  }, 60_000);

  test("no live response carries an engine credential or identifier", async () => {
    if (skipIfDown()) return;
    const key = process.env.METABASE_REPORTING_API_KEY;
    const host = new URL(process.env.METABASE_SITE_URL).host;

    /* Engine ids are small integers, so scanning the JSON text for one matches
       a rupee figure sooner or later — the first draft of this test failed on
       a real total that happened to contain "3100". What actually has to be
       absent is the SHAPE: an engine key, its host, and any MBQL or
       identifier-bearing key anywhere in the tree, at any depth. */
    const FORBIDDEN_KEYS = [
      "database", "table_id", "field_id", "card_id", "collection_id",
      "source-table", "source_table", "query", "native", "dataset_query", "mbql",
    ];
    const walk = (node, path = "$") => {
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
      if (node && typeof node === "object") {
        for (const [k, v] of Object.entries(node)) {
          if (FORBIDDEN_KEYS.includes(k)) throw new Error(`engine key "${k}" leaked at ${path}`);
          walk(v, `${path}.${k}`);
        }
      }
    };

    for (const r of [
      await call(`/catalog?companyId=${GRAV}`),
      await call("/preview", { method: "POST", body: PIVOT() }),
      await call("/preview", { method: "POST", body: PIVOT({ rows: [{ field: "not_a_field" }] }) }),
      await call("/preview", { method: "POST", body: PIVOT({ filters: [] }) }),
    ]) {
      const text = JSON.stringify(r.body);
      expect(() => walk(r.body)).not.toThrow();
      expect(text).not.toContain(key);
      expect(text).not.toContain(host);
      expect(text.toLowerCase()).not.toContain("metabase");
      expect(text.toLowerCase()).not.toContain("select ");
      // Nor a single raw mart column name, which is the leak nobody notices.
      for (const column of ["voucher_date", "ledger_name", "group_name", "signed_amount", "company_id"]) {
        expect(text).not.toMatch(new RegExp(`\\b${column}\\b`));
      }
    }
  }, 90_000);
});
