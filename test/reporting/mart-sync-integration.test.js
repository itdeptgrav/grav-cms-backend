// test/reporting/mart-sync-integration.test.js
//
// THE MART, AGAINST A REAL POSTGRES.
//
// Everything a unit test structurally cannot show: that the refresh is one
// transaction and a failure inside it leaves nothing behind, that the
// reconciliation gate actually blocks a commit, that the curated views exclude
// what they claim to, and that a repeated full sync is genuinely idempotent
// rather than merely intended to be.
//
// ── ISOLATION ───────────────────────────────────────────────────────────────
// Mongo is the in-memory server from test/setup.js, seeded with invented
// fixtures. NO REAL ACCOUNTING RECORD IS READ OR WRITTEN.
//
// Postgres is a SEPARATE DATABASE — `reporting_test` — created here and dropped
// at the end. The live mart is never touched: a test that truncated the real
// `reporting.fact_voucher_line` would be indistinguishable from a bug in the
// sync, and would destroy the very data the gate exists to protect.
//
// The suite SKIPS ITSELF, loudly, when no admin connection is configured, so
// `npx jest` on a machine without the pilot running still passes honestly
// rather than by pretending these checks ran.
"use strict";

require("dotenv").config();

const mongoose = require("mongoose");
const { Client } = require("pg");

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Organization } = require("../../models/Accountant_model/Acc_OrgModels");

const ADMIN_URL = process.env.REPORTING_ADMIN_URL;
const TEST_DB = "reporting_test";

/* The service modules are required at the top, like any other module. They must
   NOT be re-required through `jest.resetModules()`: that hands them a second
   copy of mongoose, unconnected, and every model call then buffers until it
   times out. `pgClient` reads its connection URLs lazily, when a pool is first
   created, so redirecting them in `beforeAll` is enough and is what keeps this
   suite off the live mart. */
const pg = require("../../services/reporting/pgClient");
const sync = require("../../services/reporting/martSync.service");
const reconcile = require("../../services/reporting/martReconcile.service");
const migrator = require("../../services/reporting/martMigrate.service");

/** The admin URL with its database swapped for the throwaway one. */
function testUrl(url, dbName) {
  const u = new URL(url);
  u.pathname = `/${dbName}`;
  return u.toString();
}

const describeOrSkip = ADMIN_URL ? describe : describe.skip;

if (!ADMIN_URL) {
  // Visible in the run output rather than a silently green suite.
  test("reporting integration tests are SKIPPED — REPORTING_ADMIN_URL is not set", () => {
    expect(ADMIN_URL).toBeUndefined();
  });
}

describeOrSkip("reporting mart — integration", () => {
  beforeAll(async () => {
    // Build the throwaway database from the maintenance connection.
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.query(`CREATE DATABASE ${TEST_DB}`);
    /* A new database comes up with CONNECT granted to PUBLIC — PostgreSQL does
       not copy the template's ACL — so `metabase_reader` could open a session
       on this one. It holds accounting fixtures and is no business of the
       reader's, and leaving it open also races
       test/reporting/readonly-role.test.js, which asserts that the reader can
       reach no other database in the cluster. */
    await root.query(`REVOKE CONNECT ON DATABASE ${TEST_DB} FROM PUBLIC`);
    await root.end();

    /* Point every connection level at the throwaway database before any pool
       exists. pgClient creates them lazily, so nothing here can reach the live
       mart — and the assertion below is what would catch it if that changed. */
    process.env.REPORTING_ADMIN_URL = testUrl(ADMIN_URL, TEST_DB);
    process.env.REPORTING_SYNC_URL = testUrl(ADMIN_URL, TEST_DB);
    expect(pg.target("admin")).toMatch(new RegExp(`/${TEST_DB}$`));
    expect(pg.target("sync")).toMatch(new RegExp(`/${TEST_DB}$`));

    await migrator.migrate({ log: () => {} });
  }, 60_000);

  afterAll(async () => {
    await pg.closeAll();
    const root = new Client({ connectionString: ADMIN_URL });
    await root.connect();
    await root.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${TEST_DB}'`,
    );
    await root.query(`DROP DATABASE IF EXISTS ${TEST_DB}`);
    await root.end();
  }, 60_000);

  beforeEach(async () => {
    // test/setup.js clears Mongo between tests; the mart needs the same.
    await pg.query("admin", "DELETE FROM reporting.fact_voucher_line");
    await pg.query("admin", "DELETE FROM reporting.fact_voucher");
    await pg.query("admin", "DELETE FROM reporting.dim_ledger");
    await pg.query("admin", "DELETE FROM reporting.dim_group");
    await pg.query("admin", "DELETE FROM reporting.dim_company");
    await pg.query("admin", "DELETE FROM reporting.mart_sync_run");
  });

  /* ── Fixtures. Invented, and balanced unless a test says otherwise. ────── */

  async function seedCompany({ name = "Fixture Co", vouchers = [] } = {}) {
    const company = await Acc_Company.create({
      companyName: name,
      booksFromDate: new Date("2025-04-01"),
      isPrimary: true,
    });
    const org = await Acc_Organization.create({
      name: `Org for ${name}`,
      tallyCompanyIds: [company._id],
    });
    const group = await Acc_Group.create({
      companyId: company._id,
      name: "Sundry Debtors",
      nature: "asset",
      isPrimary: true,
    });
    const debtor = await Acc_Ledger.create({
      companyId: company._id,
      name: "Acme Exports",
      groupId: group._id,
      groupName: group.name,
      nature: "asset",
      openingBalance: 5000,
      openingBalanceType: "Dr",
    });
    const sales = await Acc_Ledger.create({
      companyId: company._id,
      name: "Sales",
      groupId: group._id,
      groupName: group.name,
      nature: "revenue",
    });

    const made = [];
    for (const v of vouchers) {
      made.push(
        await Acc_Voucher.create({
          companyId: company._id,
          voucherType: v.type || "sales",
          voucherNumber: v.number,
          voucherDate: new Date(v.date),
          status: v.status || "posted",
          isOptional: v.isOptional || false,
          grandTotal: v.amount,
          ledgerEntries: [
            { ledgerId: debtor._id, ledgerName: "Acme Exports", type: "Dr", amount: v.amount },
            { ledgerId: sales._id, ledgerName: "Sales", type: "Cr", amount: v.amount },
          ],
        }),
      );
    }
    return { company, org, group, debtor, sales, vouchers: made };
  }

  const q = async (sql, params) => (await pg.query("admin", sql, params)).rows;

  /* ═════════════════════════════════════════════════════════════════════════
   * A full sync, end to end
   * ════════════════════════════════════════════════════════════════════════ */

  test("a full sync writes every row, stamped with its organisation", async () => {
    const { company, org } = await seedCompany({
      vouchers: [
        { number: "S-1", date: "2026-05-04", amount: 1000 },
        { number: "S-2", date: "2026-05-20", amount: 250.5 },
      ],
    });

    const result = await sync.fullSync({ log: () => {} });
    expect(result.ok).toBe(true);

    const [counts] = await q(
      `SELECT (SELECT count(*) FROM reporting.dim_company)       c,
              (SELECT count(*) FROM reporting.dim_group)         g,
              (SELECT count(*) FROM reporting.dim_ledger)        l,
              (SELECT count(*) FROM reporting.fact_voucher)      v,
              (SELECT count(*) FROM reporting.fact_voucher_line) n`,
    );
    expect(counts).toMatchObject({ c: "1", g: "1", l: "2", v: "2", n: "4" });

    const orgs = await q(
      "SELECT DISTINCT organization_id FROM reporting.fact_voucher_line",
    );
    expect(orgs).toEqual([{ organization_id: String(org._id) }]);

    const [company_row] = await q("SELECT * FROM reporting.dim_company");
    expect(company_row.company_id).toBe(String(company._id));
    expect(company_row.synced_at).toBeInstanceOf(Date);
  });

  test("money survives the round trip exactly, and the books balance to zero", async () => {
    await seedCompany({
      vouchers: [
        { number: "S-1", date: "2026-05-04", amount: 0.1 },
        { number: "S-2", date: "2026-05-05", amount: 0.2 },
        { number: "S-3", date: "2026-05-06", amount: 1234.56 },
      ],
    });
    await sync.fullSync({ log: () => {} });

    const [totals] = await q(
      `SELECT SUM(debit) d, SUM(credit) c, SUM(signed_amount) s,
              SUM(signed_amount) = 0 AS exactly_zero
         FROM reporting.v_general_ledger`,
    );
    expect(totals.d).toBe("1234.86");
    expect(totals.c).toBe("1234.86");
    expect(totals.exactly_zero).toBe(true);
  });

  test("a repeated full sync is idempotent — identical rows, no duplicates", async () => {
    await seedCompany({
      vouchers: [
        { number: "S-1", date: "2026-05-04", amount: 1000 },
        { number: "S-2", date: "2026-06-04", amount: 500 },
      ],
    });

    await sync.fullSync({ log: () => {} });
    const fingerprint = async () =>
      (
        await q(
          `SELECT md5(string_agg(t,'|' ORDER BY t)) f, count(*) n FROM (
             SELECT source_id||':'||dr_cr||':'||amount||':'||signed_amount||':'||line_no AS t
               FROM reporting.fact_voucher_line) x`,
        )
      )[0];

    const before = await fingerprint();
    await sync.fullSync({ log: () => {} });
    await sync.fullSync({ log: () => {} });
    const after = await fingerprint();

    expect(after.n).toBe(before.n);
    expect(after.f).toBe(before.f);
    expect(Number(after.n)).toBe(4);
  });

  test("THE SYNC NEVER WRITES TO MONGODB", async () => {
    const { company } = await seedCompany({
      vouchers: [{ number: "S-1", date: "2026-05-04", amount: 1000 }],
    });

    const snapshot = async () => {
      const db = mongoose.connection.db;
      const out = {};
      for (const c of ["acc_companies", "acc_groups", "acc_ledgers", "acc_vouchers", "acc_organizations"]) {
        const docs = await db.collection(c).find({}).toArray();
        out[c] = docs
          .map((d) => `${d._id}:${d.updatedAt ? d.updatedAt.getTime() : "-"}:${JSON.stringify(d).length}`)
          .sort();
      }
      return out;
    };

    const before = await snapshot();
    await sync.fullSync({ log: () => {} });
    await sync.fullSync({ log: () => {} });
    expect(await snapshot()).toEqual(before);
    expect(company).toBeTruthy();
  });

  /* ═════════════════════════════════════════════════════════════════════════
   * The curated views
   * ════════════════════════════════════════════════════════════════════════ */

  test("draft, pending, cancelled and void are kept in the fact and EXCLUDED from the views", async () => {
    await seedCompany({
      vouchers: [
        { number: "P-1", date: "2026-05-04", amount: 1000, status: "posted" },
        { number: "D-1", date: "2026-05-05", amount: 9999, status: "draft" },
        { number: "A-1", date: "2026-05-06", amount: 8888, status: "pending_approval" },
        { number: "C-1", date: "2026-05-07", amount: 7777, status: "cancelled" },
        { number: "V-1", date: "2026-05-08", amount: 6666, status: "void" },
      ],
    });
    await sync.fullSync({ log: () => {} });

    // The raw fact keeps everything — a cancellation has to stay auditable.
    const [raw] = await q("SELECT count(*) n FROM reporting.fact_voucher_line");
    expect(raw.n).toBe("10");
    const statuses = await q(
      "SELECT DISTINCT voucher_status FROM reporting.fact_voucher_line ORDER BY 1",
    );
    expect(statuses.map((r) => r.voucher_status)).toEqual([
      "cancelled", "draft", "pending_approval", "posted", "void",
    ]);

    // The curated views show the posted one and only the posted one.
    const [gl] = await q(
      "SELECT count(*) n, SUM(debit) d FROM reporting.v_general_ledger",
    );
    expect(gl.n).toBe("2");
    expect(gl.d).toBe("1000.00");

    const [tb] = await q("SELECT SUM(debit_total) d FROM reporting.v_trial_balance");
    expect(tb.d).toBe("1000.00");

    // And not one excluded amount leaks into either view.
    const leak = await q(
      `SELECT count(*) n FROM reporting.v_general_ledger
        WHERE amount IN (9999, 8888, 7777, 6666)`,
    );
    expect(leak[0].n).toBe("0");
  });

  test("v_trial_balance per ledger equals the posted movement", async () => {
    const { debtor, sales } = await seedCompany({
      vouchers: [
        { number: "S-1", date: "2026-05-04", amount: 1000 },
        { number: "S-2", date: "2026-05-20", amount: 500 },
        { number: "C-1", date: "2026-05-21", amount: 9999, status: "cancelled" },
      ],
    });
    await sync.fullSync({ log: () => {} });

    const rows = await q(
      `SELECT ledger_id, SUM(debit_total) d, SUM(credit_total) c
         FROM reporting.v_trial_balance GROUP BY ledger_id`,
    );
    const byLedger = Object.fromEntries(rows.map((r) => [r.ledger_id, r]));
    expect(byLedger[String(debtor._id)]).toMatchObject({ d: "1500.00", c: "0.00" });
    expect(byLedger[String(sales._id)]).toMatchObject({ d: "0.00", c: "1500.00" });
  });

  /* ═════════════════════════════════════════════════════════════════════════
   * The reconciliation gate
   * ════════════════════════════════════════════════════════════════════════ */

  test("a clean sync passes every check and is recorded as succeeded", async () => {
    await seedCompany({
      vouchers: [{ number: "S-1", date: "2026-05-04", amount: 1000 }],
    });
    const result = await sync.fullSync({ log: () => {} });

    expect(result.results[0].status).toBe("succeeded");
    const names = result.results[0].reconciliation.checks.map((c) => c.check).sort();
    expect(names).toEqual([
      "balanced_periods",
      "lines_per_voucher",
      "period_totals",
      "row_counts",
      "tenant_stamping",
      "trial_balance_per_ledger",
    ]);
    expect(result.results[0].reconciliation.checks.every((c) => c.ok)).toBe(true);

    const runs = await q("SELECT status, company_name FROM reporting.mart_sync_run");
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("succeeded");
  });

  test("AN UNBALANCED COMPANY FAILS, naming the period and the exact difference", async () => {
    /* The source's own books do not balance. The gate must report it rather
       than round it away — and must not commit the data. */
    const { company, org, debtor } = await seedCompany({});
    await Acc_Voucher.create({
      companyId: company._id,
      voucherType: "journal",
      voucherNumber: "J-BAD",
      voucherDate: new Date("2026-05-04"),
      status: "posted",
      grandTotal: 100,
      // 100 Dr against 60 Cr — 40 unaccounted for.
      ledgerEntries: [
        { ledgerId: debtor._id, ledgerName: "Acme Exports", type: "Dr", amount: 100 },
        { ledgerId: debtor._id, ledgerName: "Acme Exports", type: "Cr", amount: 60 },
      ],
    });

    const result = await sync.fullSync({ log: () => {} });
    expect(result.ok).toBe(false);
    expect(result.results[0].status).toBe("failed");
    expect(result.results[0].failureReason).toMatch(/balanced_periods/);

    const failed = result.results[0].reconciliation.checks.find(
      (c) => c.check === "balanced_periods",
    );
    expect(failed.ok).toBe(false);
    expect(failed.imbalances[0]).toMatchObject({
      companyId: String(company._id),
      period: "2026-05-01",
      signedTotal: "40.00",
      difference: "40.0000",
    });
    expect(org).toBeTruthy();
  });

  test("A FAILED SYNC LEAVES NOTHING BEHIND — the transaction rolls back", async () => {
    const { company, debtor } = await seedCompany({});
    await Acc_Voucher.create({
      companyId: company._id,
      voucherType: "journal",
      voucherNumber: "J-BAD",
      voucherDate: new Date("2026-05-04"),
      status: "posted",
      grandTotal: 100,
      ledgerEntries: [
        { ledgerId: debtor._id, ledgerName: "Acme", type: "Dr", amount: 100 },
        { ledgerId: debtor._id, ledgerName: "Acme", type: "Cr", amount: 60 },
      ],
    });

    await sync.fullSync({ log: () => {} });

    for (const table of [
      "dim_company", "dim_group", "dim_ledger", "fact_voucher", "fact_voucher_line",
    ]) {
      const [row] = await q(`SELECT count(*) n FROM reporting.${table}`);
      expect(row.n).toBe("0");
    }

    // The ATTEMPT is still recorded — it is written outside the data
    // transaction precisely so a rollback cannot erase the evidence.
    const runs = await q("SELECT status, failure_reason FROM reporting.mart_sync_run");
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("failed");
    expect(runs[0].failure_reason).toMatch(/Reconciliation failed/);
  });

  test("A FAILED SYNC KEEPS THE PREVIOUS SUCCESSFUL DATASET CURRENT", async () => {
    /* The property that makes a stale mart recoverable and a wrong one
       impossible: the bad refresh must not take the good data with it. */
    const { company, debtor } = await seedCompany({
      vouchers: [{ number: "S-1", date: "2026-05-04", amount: 1000 }],
    });
    await sync.fullSync({ log: () => {} });

    const good = await q(
      "SELECT source_id, amount FROM reporting.fact_voucher_line ORDER BY source_id",
    );
    expect(good).toHaveLength(2);

    // Now break the source and sync again.
    await Acc_Voucher.create({
      companyId: company._id,
      voucherType: "journal",
      voucherNumber: "J-BAD",
      voucherDate: new Date("2026-05-05"),
      status: "posted",
      grandTotal: 100,
      ledgerEntries: [
        { ledgerId: debtor._id, ledgerName: "Acme", type: "Dr", amount: 100 },
        { ledgerId: debtor._id, ledgerName: "Acme", type: "Cr", amount: 60 },
      ],
    });

    const second = await sync.fullSync({ log: () => {} });
    expect(second.ok).toBe(false);

    const after = await q(
      "SELECT source_id, amount FROM reporting.fact_voucher_line ORDER BY source_id",
    );
    expect(after).toEqual(good);
    // The broken voucher is nowhere in the mart.
    const [bad] = await q(
      "SELECT count(*) n FROM reporting.fact_voucher WHERE voucher_number = 'J-BAD'",
    );
    expect(bad.n).toBe("0");
  });

  test("a deliberate row-count mismatch is caught", async () => {
    /* Reconciliation is only a gate if it fails when the data is wrong. Here
       the mart is corrupted mid-transaction, from inside, so the gate is the
       only thing between it and a commit. */
    const { company, org } = await seedCompany({
      vouchers: [{ number: "S-1", date: "2026-05-04", amount: 1000 }],
    });

    await expect(
      pg.withTransaction("sync", async (client) => {
        await client.query(
          `INSERT INTO reporting.dim_company
             (company_id, organization_id, source_id, company_name, is_primary, is_active, synced_at)
           VALUES ($1,$2,$1,'Fixture Co',true,true, now())`,
          [String(company._id), String(org._id)],
        );
        // One ledger deliberately missing: the source has two.
        await client.query(
          `INSERT INTO reporting.dim_ledger
             (ledger_id, organization_id, company_id, source_id, ledger_name, opening_balance, is_active, synced_at)
           VALUES ('only-one',$2,$1,'only-one','Acme',0,true, now())`,
          [String(company._id), String(org._id)],
        );
        await reconcile.reconcileCompany({
          client,
          company: await Acc_Company.findById(company._id).lean(),
          organizationId: String(org._id),
          sourceCounts: { companies: 1, groups: 1, ledgers: 2, vouchers: 1, voucherLines: 2 },
        });
      }),
    ).rejects.toMatchObject({ code: "RECONCILIATION_FAILED" });

    // And nothing was committed.
    const [row] = await q("SELECT count(*) n FROM reporting.dim_company");
    expect(row.n).toBe("0");
  });

  test("a mismatched tenant stamp is caught", async () => {
    const { company, org } = await seedCompany({});
    await expect(
      pg.withTransaction("sync", async (client) => {
        await client.query(
          `INSERT INTO reporting.dim_company
             (company_id, organization_id, source_id, company_name, is_primary, is_active, synced_at)
           VALUES ($1,'WRONG-ORG',$1,'Fixture Co',true,true, now())`,
          [String(company._id)],
        );
        await client.query(
          `INSERT INTO reporting.dim_group
             (group_id, organization_id, company_id, source_id, group_name, nature, is_active, synced_at)
           VALUES ('g1','WRONG-ORG',$1,'g1','Sundry Debtors','asset',true, now())`,
          [String(company._id)],
        );
        await reconcile.reconcileCompany({
          client,
          company: await Acc_Company.findById(company._id).lean(),
          organizationId: String(org._id),
          sourceCounts: { companies: 1, groups: 1, ledgers: 0, vouchers: 0, voucherLines: 0 },
        });
      }),
    ).rejects.toMatchObject({ code: "RECONCILIATION_FAILED" });
  });

  test("a company with no owner refuses the whole run, before any row is written", async () => {
    await Acc_Company.create({ companyName: "Orphan", booksFromDate: new Date("2025-04-01") });
    await seedCompany({ name: "Owned", vouchers: [{ number: "S-1", date: "2026-05-04", amount: 10 }] });

    await expect(sync.fullSync({ log: () => {} })).rejects.toMatchObject({
      code: "OWNERSHIP_MISSING",
    });

    // Not even the company that DOES have an owner was written: a partial mart
    // is harder to reason about than an empty one.
    const [row] = await q("SELECT count(*) n FROM reporting.dim_company");
    expect(row.n).toBe("0");
  });

  /* ═════════════════════════════════════════════════════════════════════════
   * Multi-company isolation
   * ════════════════════════════════════════════════════════════════════════ */

  test("one company's refresh does not disturb another's rows", async () => {
    const a = await seedCompany({
      name: "Company A",
      vouchers: [{ number: "S-1", date: "2026-05-04", amount: 100 }],
    });
    const b = await seedCompany({
      name: "Company B",
      vouchers: [{ number: "S-9", date: "2026-05-04", amount: 900 }],
    });
    await sync.fullSync({ log: () => {} });

    const before = await q(
      "SELECT source_id FROM reporting.fact_voucher_line WHERE company_id = $1 ORDER BY 1",
      [String(b.company._id)],
    );

    await sync.fullSync({ companyIds: [String(a.company._id)], log: () => {} });

    const after = await q(
      "SELECT source_id FROM reporting.fact_voucher_line WHERE company_id = $1 ORDER BY 1",
      [String(b.company._id)],
    );
    expect(after).toEqual(before);
    expect(after).toHaveLength(2);
  });

  test("each company's rows carry its OWN organisation", async () => {
    const a = await seedCompany({ name: "Company A" });
    const b = await seedCompany({ name: "Company B" });
    await sync.fullSync({ log: () => {} });

    const rows = await q(
      "SELECT company_id, organization_id FROM reporting.dim_company ORDER BY company_id",
    );
    const map = Object.fromEntries(rows.map((r) => [r.company_id, r.organization_id]));
    expect(map[String(a.company._id)]).toBe(String(a.org._id));
    expect(map[String(b.company._id)]).toBe(String(b.org._id));
    expect(map[String(a.company._id)]).not.toBe(map[String(b.company._id)]);
  });
});
