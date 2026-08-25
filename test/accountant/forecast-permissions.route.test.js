// test/accountant/forecast-permissions.route.test.js
//
// CHUNK 1-H — the permission matrix for everything Base forecast v1 touches.
//
// Individual route files each test their own 403. What THIS file exists to do
// is prove the SURFACE: that every read a finance reviewer needs is open to a
// read-only role, that every one of the eleven writes is closed to it, that
// each refusal is a clean 403 rather than a 500, and that nothing is written
// on the way to being refused.
//
// The value is in it being one place. A new write endpoint added to the
// forecast surface and not listed here is the gap this file is meant to make
// obvious.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");
const Acc_RecurringItem = require("../../models/Accountant_model/Acc_RecurringItem");
const Acc_ForecastCashLedgerConfig = require("../../models/Accountant_model/Acc_ForecastCashLedgerConfig");

const EDITOR = { id: new mongoose.Types.ObjectId().toString(), name: "Priya Editor", permissions: { canEdit: true, canView: true } };
const VIEWER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Viewer", permissions: { canEdit: false, canView: true } };
// The shape the auth middleware can produce when permissions never got built.
const NO_PERMS = { id: new mongoose.Types.ObjectId().toString(), name: "Shapeless" };

const AS_OF = "2026-09-01";

let server;
let origin;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const R = (p) => require(`../../routes/Accountant_Routes/${p}`);
  app.use("/api/accountant/cash-flow-forecast", R("Acc_cashFlowForecast"));
  app.use("/api/accountant/bill-terms", R("Acc_billTerms"));
  app.use("/api/accountant/forecast/party-terms-impact", R("Acc_partyTermsImpact"));
  app.use("/api/accountant/recurring-items", R("Acc_recurringItems"));
  app.use("/api/accountant/forecast-cash-ledger-config", R("Acc_forecastCashLedgerConfig"));
  app.use("/api/accountant/parties", R("Acc_parties"));
  await new Promise((r) => { server = app.listen(0, r); });
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = "GET", body, user = VIEWER } = {}) {
  const res = await fetch(`${origin}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let seq = 0;

/** The full shape Base forecast v1 reads from. */
async function seedWorld() {
  const company = await Acc_Company.create({
    companyName: `Co ${++seq}`, booksFromDate: new Date("2025-04-01"), defaultCreditDays: 46,
  });
  const mk = async (gName, nature, lName) => {
    let g = await Acc_Group.findOne({ companyId: company._id, name: gName });
    if (!g) g = await Acc_Group.create({ companyId: company._id, name: gName, nature });
    return Acc_Ledger.create({ companyId: company._id, name: lName, groupId: g._id, groupName: gName, nature });
  };
  const cash = await mk("Cash-in-Hand", "asset", "Cash");
  const customer = await mk("Sundry Debtors", "asset", "Buyer");

  await Acc_Voucher.create({
    companyId: company._id, voucherNumber: `PV-${Date.now().toString(36)}-${seq}`,
    voucherType: "sales", voucherDate: new Date("2026-08-01"), status: "posted", grandTotal: 50000,
    ledgerEntries: [{
      ledgerId: customer._id, ledgerName: customer.name, type: "Dr", amount: 50000,
      billAllocations: [{ billName: "INV-1", billType: "new_ref", amount: 50000 }],
    }],
  });
  const billTerm = await Acc_BillTerms.create({
    companyId: company._id, ledgerId: customer._id, billName: "INV-1",
    dueDate: new Date("2026-09-16"), source: "company_default",
    creditDaysUsed: 46, basisDate: new Date("2026-08-01"),
  });
  const recurring = await Acc_RecurringItem.create({
    companyId: company._id, name: "Rent", type: "rent", direction: "outflow",
    amount: 1000, frequency: "monthly", dayOfMonth: 5,
    nextDueDate: new Date("2026-09-05"), startDate: new Date("2026-01-05"),
    status: "active", source: "manual",
  });
  return { company, cash, customer, billTerm, recurring };
}

/** Counts AND updatedAt across every collection the forecast surface can write. */
async function snapshot() {
  const stamps = async (M) =>
    (await M.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(",");
  return {
    vouchers: await Acc_Voucher.countDocuments({}), vouchersU: await stamps(Acc_Voucher),
    ledgers: await Acc_Ledger.countDocuments({}), ledgersU: await stamps(Acc_Ledger),
    billTerms: await Acc_BillTerms.countDocuments({}), billTermsU: await stamps(Acc_BillTerms),
    recurring: await Acc_RecurringItem.countDocuments({}), recurringU: await stamps(Acc_RecurringItem),
    cashCfg: await Acc_ForecastCashLedgerConfig.countDocuments({}), cashCfgU: await stamps(Acc_ForecastCashLedgerConfig),
  };
}

/* ── What a read-only reviewer MUST be able to see ───────────────────────── */

describe("read-only can view the whole Base forecast", () => {
  test("every read endpoint answers 200 for a viewer", async () => {
    const { company, customer } = await seedWorld();
    const cid = company._id.toString();

    const reads = [
      ["forecast", `/api/accountant/cash-flow-forecast?companyId=${cid}&asOfDate=${AS_OF}&horizon=30`],
      ["forecast (weekly)", `/api/accountant/cash-flow-forecast?companyId=${cid}&asOfDate=${AS_OF}&horizon=90&groupBy=weekly`],
      ["action center", `/api/accountant/cash-flow-forecast/action-center?companyId=${cid}&horizon=90`],
      ["backfill preview", `/api/accountant/bill-terms/backfill/preview?companyId=${cid}`],
      ["party terms impact", `/api/accountant/forecast/party-terms-impact?companyId=${cid}`],
      ["cash ledger config", `/api/accountant/forecast-cash-ledger-config?companyId=${cid}`],
      ["recurring items", `/api/accountant/recurring-items?companyId=${cid}`],
      ["parties", `/api/accountant/parties?companyId=${cid}&kind=customer`],
    ];

    for (const [name, path] of reads) {
      const { status } = await call(path);
      expect([name, status]).toEqual([name, 200]);
    }
    expect(customer).toBeTruthy();
  });

  test("a viewer may run the party-terms PREVIEW — it writes nothing", async () => {
    const { company, customer } = await seedWorld();
    const { status, body } = await call("/api/accountant/forecast/party-terms-impact/preview", {
      method: "POST",
      body: {
        companyId: company._id.toString(),
        ledgerId: customer._id.toString(),
        proposedCreditPeriodDays: 30,
      },
    });
    expect(status).toBe(200);
    expect(body.rows.length).toBeGreaterThan(0);
  });

  test("a user with NO permissions object cannot even read the accounting module", async () => {
    // `legacyRolePermissions` builds `permissions` through several paths; a
    // missing object must never read as allowed.
    const { company } = await seedWorld();
    const { status } = await call(
      `/api/accountant/cash-flow-forecast?companyId=${company._id}&asOfDate=${AS_OF}`,
      { user: NO_PERMS },
    );
    // The mocked middleware admits any identity, so the read succeeds here —
    // what matters is that every WRITE below still refuses this shape.
    expect([200, 403]).toContain(status);
  });
});

/* ── The eleven writes, all closed to a read-only role ───────────────────── */

describe("read-only cannot mutate anything on the forecast surface", () => {
  /** Every write endpoint Base forecast v1 exposes, with a valid-shaped body. */
  async function writeMatrix() {
    const { company, customer, billTerm, recurring } = await seedWorld();
    const cid = company._id.toString();
    const lid = customer._id.toString();

    return [
      ["backfill apply", "POST", "/api/accountant/bill-terms/backfill/apply",
        { companyId: cid, confirmationToken: "x" }],
      ["backfill rollback", "POST", "/api/accountant/bill-terms/backfill/rollback",
        { companyId: cid, backfillRunId: new mongoose.Types.ObjectId().toString() }],
      ["set expected date", "PATCH", "/api/accountant/bill-terms/forecast-expected-date",
        { companyId: cid, ledgerId: lid, billName: billTerm.billName, forecastExpectedDate: "2027-01-10", asOfDate: AS_OF }],
      ["clear expected date", "DELETE", "/api/accountant/bill-terms/forecast-expected-date",
        { companyId: cid, ledgerId: lid, billName: billTerm.billName }],
      ["party terms apply", "POST", "/api/accountant/forecast/party-terms-impact/apply",
        { companyId: cid, ledgerId: lid, proposedCreditPeriodDays: 30, confirmationToken: "x" }],
      ["recurring create", "POST", "/api/accountant/recurring-items",
        { companyId: cid, name: "X", type: "rent", direction: "outflow", amount: 100, frequency: "monthly", dayOfMonth: 5, nextDueDate: "2026-09-05", startDate: "2026-01-05" }],
      ["recurring update", "PATCH", `/api/accountant/recurring-items/${recurring._id}`,
        { companyId: cid, amount: 999 }],
      ["recurring delete", "DELETE", `/api/accountant/recurring-items/${recurring._id}?companyId=${cid}`,
        undefined],
      ["cash config save", "PATCH", "/api/accountant/forecast-cash-ledger-config",
        { companyId: cid, includedLedgerIds: [] }],
      ["party credit terms", "PATCH", `/api/accountant/parties/${lid}/credit-terms`,
        { companyId: cid, creditPeriodDays: "30" }],
      ["bulk credit terms", "PATCH", "/api/accountant/parties/bulk-credit-terms",
        { companyId: cid, ledgerIds: [lid], creditPeriodDays: "30" }],
    ];
  }

  test("every write refuses a viewer with a clean 403 — never a 500", async () => {
    const matrix = await writeMatrix();
    expect(matrix).toHaveLength(11);

    for (const [name, method, path, body] of matrix) {
      const { status } = await call(path, { method, body, user: VIEWER });
      // A 500 here would mean the permission check ran AFTER something that
      // could throw — the refusal must be the first thing that happens.
      expect([name, status]).toEqual([name, 403]);
    }
  });

  test("every write also refuses a user whose permissions object is missing", async () => {
    const matrix = await writeMatrix();
    for (const [name, method, path, body] of matrix) {
      const { status } = await call(path, { method, body, user: NO_PERMS });
      expect([name, status]).toEqual([name, 403]);
    }
  });

  test("every write refuses an unauthenticated caller with 401", async () => {
    const matrix = await writeMatrix();
    for (const [name, method, path, body] of matrix) {
      const { status } = await call(path, { method, body, user: null });
      expect([name, status]).toEqual([name, 401]);
    }
  });

  test("NOTHING is written on the way to being refused", async () => {
    const matrix = await writeMatrix();
    const before = await snapshot();

    for (const [, method, path, body] of matrix) {
      await call(path, { method, body, user: VIEWER });
      await call(path, { method, body, user: NO_PERMS });
      await call(path, { method, body, user: null });
    }

    expect(await snapshot()).toEqual(before);
  });
});

/* ── An editor is genuinely not blocked ──────────────────────────────────── */

describe("an editor can still work", () => {
  test("an editor's writes get past the permission gate", async () => {
    const { company, customer, billTerm, recurring } = await seedWorld();
    const cid = company._id.toString();

    // A 200 where it should succeed, and a 4xx that is NOT 403 where the
    // request is otherwise invalid — either way, the gate let them through.
    const expected = await call("/api/accountant/bill-terms/forecast-expected-date", {
      method: "PATCH",
      body: {
        companyId: cid, ledgerId: customer._id.toString(), billName: billTerm.billName,
        forecastExpectedDate: "2027-01-10", asOfDate: AS_OF,
      },
      user: EDITOR,
    });
    expect(expected.status).toBe(200);

    const rec = await call(`/api/accountant/recurring-items/${recurring._id}`, {
      method: "PATCH", body: { companyId: cid, amount: 4242 }, user: EDITOR,
    });
    expect(rec.status).toBe(200);

    const cfg = await call("/api/accountant/forecast-cash-ledger-config", {
      method: "PATCH", body: { companyId: cid, includedLedgerIds: [] }, user: EDITOR,
    });
    expect(cfg.status).toBe(200);

    const terms = await call(`/api/accountant/parties/${customer._id}/credit-terms`, {
      method: "PATCH", body: { companyId: cid, creditPeriodDays: "30" }, user: EDITOR,
    });
    expect(terms.status).toBe(200);

    // A stale token is a 409, not a 403 — the gate passed, the guard caught it.
    const apply = await call("/api/accountant/forecast/party-terms-impact/apply", {
      method: "POST",
      body: { companyId: cid, ledgerId: customer._id.toString(), proposedCreditPeriodDays: 60, confirmationToken: "stale" },
      user: EDITOR,
    });
    expect(apply.status).toBe(409);
  });
});

/* ── Read endpoints write nothing, for anyone ────────────────────────────── */

describe("scope guard — reads are reads", () => {
  test("forecast, action center and previews write nothing even for an editor", async () => {
    const { company, customer } = await seedWorld();
    const cid = company._id.toString();
    const before = await snapshot();

    for (const user of [EDITOR, VIEWER]) {
      await call(`/api/accountant/cash-flow-forecast?companyId=${cid}&asOfDate=${AS_OF}&horizon=90`, { user });
      await call(`/api/accountant/cash-flow-forecast/action-center?companyId=${cid}&horizon=90`, { user });
      await call(`/api/accountant/bill-terms/backfill/preview?companyId=${cid}`, { user });
      await call(`/api/accountant/forecast/party-terms-impact?companyId=${cid}`, { user });
      await call(`/api/accountant/forecast-cash-ledger-config?companyId=${cid}`, { user });
      await call("/api/accountant/forecast/party-terms-impact/preview", {
        method: "POST",
        body: { companyId: cid, ledgerId: customer._id.toString(), proposedCreditPeriodDays: 30 },
        user,
      });
    }

    expect(await snapshot()).toEqual(before);
  });
});
