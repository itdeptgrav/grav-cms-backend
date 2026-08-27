// test/accountant/cash-flow-forecast.route.test.js
//
// HTTP-level tests for Chunk 1-A's Base cash-flow forecast.
//
// The pure engine already proves the arithmetic in isolation
// (services/cashFlowForecast.test.js). What THIS file exists to prove is the
// half a pure test cannot reach:
//   - company scoping genuinely reaches the database, so one company's cash,
//     bills and schedules can never appear in another's forecast
//   - opening cash really is computed from POSTED vouchers only, and really
//     does exclude same-day movement from the opening figure
//   - a dated receivable/payable read through the real C0-F ladder lands on
//     the right day as the right direction
//   - the whole request writes NOTHING — asserted against real collections
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

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");
const Acc_RecurringItem = require("../../models/Accountant_model/Acc_RecurringItem");
const Acc_ForecastCashLedgerConfig = require("../../models/Accountant_model/Acc_ForecastCashLedgerConfig");

const USER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Editor",
  permissions: { canEdit: true, canView: true },
};

const AS_OF = "2026-09-01";

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/cash-flow-forecast",
    require("../../routes/Accountant_Routes/Acc_cashFlowForecast"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/cash-flow-forecast`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(qs, { user = USER } = {}) {
  const res = await fetch(`${base}${qs}`, {
    headers: { ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/**
 * A company with a cash ledger and a Sundry Debtors / Sundry Creditors pair,
 * which is the minimum shape the forecast reads from.
 */
async function seedCompany(name = "Company A") {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2026-04-01"),
  });

  const cashGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Cash-in-Hand",
    nature: "asset",
  });
  const cash = await Acc_Ledger.create({
    companyId: company._id,
    name: "Cash",
    groupId: cashGroup._id,
    groupName: cashGroup.name,
    nature: "asset",
  });

  const debtorGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const customer = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Buyer`,
    groupId: debtorGroup._id,
    groupName: debtorGroup.name,
    nature: "asset",
  });

  const creditorGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Creditors",
    nature: "liability",
  });
  const vendor = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Supplier`,
    groupId: creditorGroup._id,
    groupName: creditorGroup.name,
    nature: "liability",
  });

  return { company, cash, customer, vendor };
}

let voucherSeq = 0;

/**
 * A two-line voucher. `cashType` is the cash ledger's side: "Dr" is money in.
 * The counter-party line carries the bill allocation the open-item reader
 * folds on.
 */
async function seedVoucher({
  company,
  cash,
  party,
  cashType = "Dr",
  amount = 1000,
  voucherDate,
  status = "posted",
  billName = null,
  dueDate = undefined,
  partyType = "Cr",
}) {
  voucherSeq += 1;
  return Acc_Voucher.create({
    companyId: company._id,
    voucherNumber: `V-${Date.now().toString(36)}-${voucherSeq}`,
    voucherType: "receipt",
    voucherDate: new Date(voucherDate),
    status,
    grandTotal: amount,
    ...(dueDate !== undefined ? { dueDate: new Date(dueDate) } : {}),
    ledgerEntries: [
      {
        ledgerId: cash._id,
        ledgerName: cash.name,
        type: cashType,
        amount,
      },
      {
        ledgerId: party._id,
        ledgerName: party.name,
        type: partyType,
        amount,
        ...(billName
          ? {
              billAllocations: [
                { billName, billType: "new_ref", amount },
              ],
            }
          : {}),
      },
    ],
  });
}

/** A bare open bill on a party ledger, with no cash line to confuse opening cash. */
async function seedOpenBill({ company, party, billName, amount, entryType = "Dr", voucherDate, dueDate }) {
  voucherSeq += 1;
  return Acc_Voucher.create({
    companyId: company._id,
    voucherNumber: `B-${Date.now().toString(36)}-${voucherSeq}`,
    voucherType: "sales",
    voucherDate: new Date(voucherDate),
    status: "posted",
    grandTotal: amount,
    ...(dueDate !== undefined ? { dueDate: new Date(dueDate) } : {}),
    ledgerEntries: [
      {
        ledgerId: party._id,
        ledgerName: party.name,
        type: entryType,
        amount,
        billAllocations: [{ billName, billType: "new_ref", amount }],
      },
    ],
  });
}

/* ── Request validation ──────────────────────────────────────────────────── */

describe("request validation", () => {
  test("no auth is refused", async () => {
    const { status } = await call(`?companyId=${new mongoose.Types.ObjectId()}`, { user: null });
    expect(status).toBe(401);
  });

  test("a missing companyId is refused — never an unscoped read", async () => {
    const { status, body } = await call("");
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_COMPANY");
    expect(body.rows).toBeUndefined();
  });

  test("a malformed companyId is refused", async () => {
    const { status, body } = await call("?companyId=not-an-object-id");
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_COMPANY");
  });

  test("a well-formed but non-existent companyId is a clean 404", async () => {
    const { status, body } = await call(`?companyId=${new mongoose.Types.ObjectId()}`);
    expect(status).toBe(404);
    expect(body.code).toBe("COMPANY_NOT_FOUND");
  });

  test("every allowed horizon works and returns that many rows", async () => {
    const { company } = await seedCompany();
    for (const h of [7, 15, 30, 60, 90]) {
      const { status, body } = await call(
        `?companyId=${company._id}&horizon=${h}&asOfDate=${AS_OF}`,
      );
      expect(status).toBe(200);
      expect(body.horizonDays).toBe(h);
      expect(body.rows).toHaveLength(h);
    }
  });

  test("horizon defaults to 30 when omitted", async () => {
    const { company } = await seedCompany();
    const { status, body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}`);
    expect(status).toBe(200);
    expect(body.horizonDays).toBe(30);
  });

  test("an unsupported horizon is refused, not silently clamped", async () => {
    const { company } = await seedCompany();
    for (const bad of ["45", "0", "-30", "365", "abc", "30.5"]) {
      const { status, body } = await call(
        `?companyId=${company._id}&horizon=${bad}&asOfDate=${AS_OF}`,
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_HORIZON");
    }
  });

  test("an unparseable asOfDate is refused rather than falling back to today", async () => {
    const { company } = await seedCompany();
    const { status, body } = await call(`?companyId=${company._id}&asOfDate=not-a-date`);
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_AS_OF_DATE");
  });

  test("the response is Base-scenario only — no bands, alerts or best/worst", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.scenario).toBe("base");
    expect(body.best).toBeUndefined();
    expect(body.worst).toBeUndefined();
    expect(body.confidence).toBeUndefined();
    expect(body.alerts).toBeUndefined();
    expect(body.rows[0].bandLow).toBeUndefined();
  });
});

/* ── Opening cash ────────────────────────────────────────────────────────── */

describe("opening cash", () => {
  test("comes from POSTED vouchers only — a draft moves nothing", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 5000, voucherDate: "2026-08-01", status: "posted" });
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 9999, voucherDate: "2026-08-02", status: "draft" });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.openingCash).toBe(5000);
  });

  test("a cash DEBIT increases it and a cash CREDIT decreases it", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 8000, voucherDate: "2026-08-01" });
    await seedVoucher({ company, cash, party: customer, cashType: "Cr", amount: 3000, voucherDate: "2026-08-02", partyType: "Dr" });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.openingCash).toBe(5000);
  });

  test("movement ON the as-of date is NOT in opening cash — it belongs to day 1", async () => {
    // Counting it in both the opening balance and day 1's movement would
    // double it.
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 1000, voucherDate: "2026-08-31" });
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 7777, voucherDate: AS_OF });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.openingCash).toBe(1000);
  });

  test("the ledger's own opening balance is included, signed by its type", async () => {
    const { company } = await seedCompany();
    const grp = await Acc_Group.findOne({ companyId: company._id, name: "Cash-in-Hand" }).lean();
    await Acc_Ledger.create({
      companyId: company._id,
      name: "Petty Cash",
      groupId: grp._id,
      groupName: grp.name,
      nature: "asset",
      openingBalance: 2500,
      openingBalanceType: "Dr",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.openingCash).toBe(2500);
  });

  test("a company with no cash ledgers reports zero, not an error", async () => {
    const company = await Acc_Company.create({
      companyName: "Cashless Co",
      booksFromDate: new Date("2026-04-01"),
    });
    const { status, body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(status).toBe(200);
    expect(body.openingCash).toBe(0);
    expect(body.cashLedgerCount).toBe(0);
  });

  test("day 1's opening equals openingCash, and the line rolls forward from it", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 4200, voucherDate: "2026-08-01" });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    expect(body.rows[0].opening).toBe(4200);
    expect(body.totals.closingCash).toBe(4200);
  });
});

/* ── Open items ──────────────────────────────────────────────────────────── */

describe("dated open items", () => {
  test("a dated RECEIVABLE appears as an inflow on its due date", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-1",
      amount: 60000,
      entryType: "Dr", // a debtor balance — they owe us
      voucherDate: "2026-08-15",
      dueDate: "2026-09-10",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const row = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-10");
    expect(row.inflows).toBe(60000);
    expect(row.sources.openReceivables).toBe(60000);
    expect(body.totals.inflows).toBe(60000);
    expect(body.coverage.openItemsIncluded).toBe(1);
  });

  test("a dated PAYABLE appears as an outflow on its due date", async () => {
    const { company, vendor } = await seedCompany();
    await seedOpenBill({
      company,
      party: vendor,
      billName: "PB-1",
      amount: 25000,
      entryType: "Cr", // a creditor balance — we owe them
      voucherDate: "2026-08-15",
      dueDate: "2026-09-12",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const row = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-12");
    expect(row.outflows).toBe(25000);
    expect(row.sources.openPayables).toBe(25000);
    expect(body.totals.outflows).toBe(25000);
  });

  test("a due date from an Acc_BillTerms sidecar row is honoured", async () => {
    // The C0-F ladder's third rung, read through the real collection.
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-SIDE",
      amount: 15000,
      entryType: "Dr",
      voucherDate: "2026-08-01",
      // no header dueDate and no allocation dueDate
    });
    await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: customer._id,
      billName: "INV-SIDE",
      dueDate: new Date("2026-09-20"),
      source: "party_terms",
      creditDaysUsed: 50,
      basisDate: new Date("2026-08-01"),
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const row = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-20");
    expect(row.inflows).toBe(15000);
  });

  test("an UNDATED open item is excluded and reported in coverage, never guessed", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-NODATE",
      amount: 40000,
      entryType: "Dr",
      voucherDate: "2026-08-01",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    expect(body.totals.inflows).toBe(0);
    expect(body.coverage.openItemsUndated).toBe(1);
    expect(body.coverage.openItemsTotal).toBe(1);
    expect(body.coverage.openItemsIncluded).toBe(0);
  });

  test("an OVERDUE dated item is excluded from rows but visible in coverage", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-LATE",
      amount: 33000,
      entryType: "Dr",
      voucherDate: "2026-07-01",
      dueDate: "2026-08-10", // before as-of
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    expect(body.totals.inflows).toBe(0);
    expect(body.coverage.openItemsOverdue).toBe(1);
    expect(body.coverage.openItemsOverdueAmount).toBe(33000);
  });
});

/* ── Recurring items ─────────────────────────────────────────────────────── */

describe("recurring items", () => {
  async function seedRecurring(company, overrides = {}) {
    return Acc_RecurringItem.create({
      companyId: company._id,
      name: "Monthly rent",
      type: "rent",
      direction: "outflow",
      amount: 85000,
      frequency: "monthly",
      dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"),
      startDate: new Date("2026-01-05"),
      status: "active",
      source: "manual",
      ...overrides,
    });
  }

  test("an ACTIVE recurring outflow appears on schedule", async () => {
    const { company } = await seedCompany();
    await seedRecurring(company);

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=60`);
    const hits = body.rows.filter((r) => r.outflows > 0).map((r) => r.date.slice(0, 10));
    expect(hits).toEqual(["2026-09-05", "2026-10-05"]);
    expect(body.rows.find((r) => r.date.slice(0, 10) === "2026-09-05").sources.recurringOutflows).toBe(85000);
    expect(body.coverage.recurringItemsIncluded).toBe(1);
  });

  test("a PAUSED recurring item is excluded", async () => {
    const { company } = await seedCompany();
    await seedRecurring(company, { status: "paused" });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=60`);
    expect(body.totals.outflows).toBe(0);
    expect(body.coverage.recurringItemsActive).toBe(0);
  });

  test("an ENDED recurring item is excluded", async () => {
    const { company } = await seedCompany();
    await seedRecurring(company, { status: "ended" });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=60`);
    expect(body.totals.outflows).toBe(0);
  });

  test("a recurring INFLOW lands in inflows", async () => {
    const { company } = await seedCompany();
    await seedRecurring(company, { direction: "inflow", name: "Sublet income", amount: 12000 });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const row = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-05");
    expect(row.inflows).toBe(12000);
    expect(row.sources.recurringInflows).toBe(12000);
  });

  test("the register's nextDueDate is READ, never advanced by running a forecast", async () => {
    const { company } = await seedCompany();
    const item = await seedRecurring(company);
    const before = (await Acc_RecurringItem.findById(item._id).lean()).nextDueDate;

    await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);
    await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);

    const after = (await Acc_RecurringItem.findById(item._id).lean()).nextDueDate;
    expect(after.getTime()).toBe(before.getTime());
  });
});

/* ── Company scoping ─────────────────────────────────────────────────────── */

describe("company scoping", () => {
  test("one company's cash, bills and schedules never appear in another's forecast", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");

    // B gets all the data; A gets none.
    await seedVoucher({ company: b.company, cash: b.cash, party: b.customer, cashType: "Dr", amount: 99999, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company: b.company,
      party: b.customer,
      billName: "B-INV",
      amount: 50000,
      entryType: "Dr",
      voucherDate: "2026-08-01",
      dueDate: "2026-09-10",
    });
    await Acc_RecurringItem.create({
      companyId: b.company._id,
      name: "B rent",
      type: "rent",
      direction: "outflow",
      amount: 70000,
      frequency: "monthly",
      dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"),
      startDate: new Date("2026-01-05"),
      status: "active",
      source: "manual",
    });

    const { body } = await call(`?companyId=${a.company._id}&asOfDate=${AS_OF}&horizon=30`);
    expect(body.openingCash).toBe(0);
    expect(body.totals.inflows).toBe(0);
    expect(body.totals.outflows).toBe(0);
    expect(body.coverage.openItemsTotal).toBe(0);
    expect(body.coverage.recurringItemsActive).toBe(0);

    // And B's own forecast does see them, so the isolation is real rather
    // than the data simply not existing.
    const bResult = await call(`?companyId=${b.company._id}&asOfDate=${AS_OF}&horizon=30`);
    expect(bResult.body.openingCash).toBe(99999);
    expect(bResult.body.totals.inflows).toBe(50000);
    expect(bResult.body.totals.outflows).toBe(70000);
  });
});

/* ── End-to-end arithmetic through the real stack ────────────────────────── */

describe("end to end", () => {
  test("opening cash, a receivable and a recurring outflow roll forward correctly", async () => {
    const { company, cash, customer } = await seedCompany();

    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 100000, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-E2E",
      amount: 40000,
      entryType: "Dr",
      voucherDate: "2026-08-10",
      dueDate: "2026-09-03",
    });
    await Acc_RecurringItem.create({
      companyId: company._id,
      name: "Rent",
      type: "rent",
      direction: "outflow",
      amount: 30000,
      frequency: "monthly",
      dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"),
      startDate: new Date("2026-01-05"),
      status: "active",
      source: "manual",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);

    expect(body.openingCash).toBe(100000);
    expect(body.rows.find((r) => r.date.slice(0, 10) === "2026-09-03").closing).toBe(140000);
    expect(body.rows.find((r) => r.date.slice(0, 10) === "2026-09-05").closing).toBe(110000);
    expect(body.totals.inflows).toBe(40000);
    expect(body.totals.outflows).toBe(30000);
    expect(body.totals.netMovement).toBe(10000);
    expect(body.totals.closingCash).toBe(110000);
    // Cash is lowest before the receivable arrives, on day 1 and 2 alike —
    // ties keep the earliest.
    expect(body.totals.minimumCash).toBe(100000);
    expect(body.totals.minimumCashDate.slice(0, 10)).toBe(AS_OF);
  });
});

/* ── Scope guard: a forecast writes nothing ──────────────────────────────── */

describe("scope guard — read only", () => {
  test("running a forecast creates or changes NOTHING in any collection", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 1000, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-RO",
      amount: 500,
      entryType: "Dr",
      voucherDate: "2026-08-02",
      dueDate: "2026-09-09",
    });
    await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: customer._id,
      billName: "OTHER",
      dueDate: new Date("2026-09-15"),
      source: "party_terms",
      creditDaysUsed: 30,
      basisDate: new Date("2026-08-16"),
    });
    await Acc_RecurringItem.create({
      companyId: company._id,
      name: "Rent",
      type: "rent",
      direction: "outflow",
      amount: 100,
      frequency: "monthly",
      dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"),
      startDate: new Date("2026-01-05"),
      status: "active",
      source: "manual",
    });

    const snapshot = async () => ({
      vouchers: await Acc_Voucher.countDocuments({}),
      billTerms: await Acc_BillTerms.countDocuments({}),
      recurring: await Acc_RecurringItem.countDocuments({}),
      ledgers: await Acc_Ledger.countDocuments({}),
      groups: await Acc_Group.countDocuments({}),
      companies: await Acc_Company.countDocuments({}),
      voucherUpdatedAt: (await Acc_Voucher.find({}).select("updatedAt").lean())
        .map((v) => new Date(v.updatedAt).getTime())
        .sort()
        .join(","),
      recurringUpdatedAt: (await Acc_RecurringItem.find({}).select("updatedAt").lean())
        .map((v) => new Date(v.updatedAt).getTime())
        .sort()
        .join(","),
    });

    const before = await snapshot();
    for (const h of [7, 30, 90]) {
      const { status } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=${h}`);
      expect(status).toBe(200);
    }
    const after = await snapshot();

    // Counts AND updatedAt stamps: a write that replaced a document in place
    // would keep the count identical, so the timestamps are what actually
    // prove nothing was touched.
    expect(after).toEqual(before);
  });

  test("the route and orchestrator contain no write calls at all", async () => {
    // Structural, not behavioural: the files cannot write what they never
    // call. Cheaper and more durable than trying to provoke every path.
    const fs = require("fs");
    const files = [
      require.resolve("../../routes/Accountant_Routes/Acc_cashFlowForecast"),
      require.resolve("../../services/cashFlowForecastOrchestrator.service"),
      require.resolve("../../services/cashFlowForecast.service"),
    ];
    const writers =
      /\.(create|insertOne|insertMany|save|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|deleteOne|deleteMany|findOneAndDelete|findByIdAndDelete|bulkWrite|replaceOne)\s*\(/;

    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // Strip comments first: the files explain at length what they must never
      // do, and that prose is not a write.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code).not.toMatch(writers);
    }
  });

  test("no scenario, band, alert or export machinery is exposed by the endpoint", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    for (const forbidden of ["scenarios", "bands", "confidence", "alerts", "whatIf", "actuals", "export"]) {
      expect(body[forbidden]).toBeUndefined();
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-B — EXPLAINABILITY, through the real stack
 *
 * The Chunk 1-A tests above were NOT edited. That they still pass is the
 * proof that 1-B added fields without moving a number.
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("Chunk 1-B — explainability", () => {
  test("the response carries items, inclusion, sourceBreakdown and diagnostics", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-SHAPE",
      amount: 1000,
      entryType: "Dr",
      voucherDate: "2026-08-10",
      dueDate: "2026-09-10",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);

    expect(Array.isArray(body.rows[0].items)).toBe(true);
    expect(body.inclusion).toBeDefined();
    expect(body.sourceBreakdown).toBeDefined();
    expect(body.diagnostics).toBeDefined();
    // EXTENDED BY CHUNK 1-C: `manualExpectedDate` joined the buckets when
    // overdue treatment landed. The assertion is exhaustive on purpose — it
    // is what made that addition an explicit decision.
    expect(Object.keys(body.sourceBreakdown).sort()).toEqual([
      "billTermsSidecar",
      "companyDefaultDerived",
      "explicitBillAllocationDueDate",
      "manualExpectedDate",
      "partyTermsDerived",
      "recurringManual",
      "voucherDueDate",
    ]);
    expect(Object.keys(body.diagnostics).sort()).toEqual([
      "concentration",
      "topMovementDates",
      "topParties",
    ]);
  });

  test("a drilldown item names the party, the bill and the voucher", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-DRILL",
      amount: 60000,
      entryType: "Dr",
      voucherDate: "2026-08-10",
      dueDate: "2026-09-10",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const row = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-10");

    expect(row.items).toHaveLength(1);
    const it = row.items[0];
    expect(it.kind).toBe("open_item");
    expect(it.direction).toBe("inflow");
    expect(it.amount).toBe(60000);
    expect(it.billName).toBe("INV-DRILL");
    expect(it.partyOrLedgerName).toBe("Company A Buyer");
    expect(it.voucherNumber).toBeTruthy();
    expect(it.sourceLabel).toBe("Voucher due date");
    expect(it.derived).toBe(false);
  });

  test("a sidecar row backfilled from the COMPANY DEFAULT is labelled and traceable to its run", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-CD",
      amount: 20000,
      entryType: "Dr",
      voucherDate: "2026-08-01",
      // no header due date — the sidecar is the only dated source
    });
    const runId = new mongoose.Types.ObjectId();
    await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: customer._id,
      billName: "INV-CD",
      dueDate: new Date("2026-09-16"),
      source: "company_default",
      creditDaysUsed: 46,
      basisDate: new Date("2026-08-01"),
      backfillRunId: runId,
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const it = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-16").items[0];

    expect(it.source).toBe("company_default");
    expect(it.sourceLabel).toBe("Backfilled from company default");
    expect(it.derived).toBe(true);
    expect(it.backfillRunId).toBe(String(runId));

    // Counted under its own bucket, NOT hidden inside a generic sidecar total.
    expect(body.sourceBreakdown.companyDefaultDerived).toEqual({ count: 1, amount: 20000 });
    expect(body.sourceBreakdown.billTermsSidecar).toEqual({ count: 0, amount: 0 });
  });

  test("a party-terms sidecar row is distinguished from a company-default one", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-PT",
      amount: 5000,
      entryType: "Dr",
      voucherDate: "2026-08-01",
    });
    await Acc_BillTerms.create({
      companyId: company._id,
      ledgerId: customer._id,
      billName: "INV-PT",
      dueDate: new Date("2026-09-14"),
      source: "party_terms",
      creditDaysUsed: 44,
      basisDate: new Date("2026-08-01"),
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const it = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-14").items[0];
    expect(it.sourceLabel).toBe("Backfilled from party terms");
    expect(body.sourceBreakdown.partyTermsDerived).toEqual({ count: 1, amount: 5000 });
    expect(body.sourceBreakdown.companyDefaultDerived.count).toBe(0);
  });

  test("a recurring item appears in the drilldown as a schedule", async () => {
    const { company } = await seedCompany();
    await Acc_RecurringItem.create({
      companyId: company._id,
      name: "Office rent",
      type: "rent",
      direction: "outflow",
      amount: 85000,
      frequency: "monthly",
      dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"),
      startDate: new Date("2026-01-05"),
      status: "active",
      source: "manual",
      ledgerName: "Rent Expense",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const it = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-05").items[0];

    expect(it.kind).toBe("recurring_item");
    expect(it.sourceLabel).toBe("Recurring schedule");
    expect(it.direction).toBe("outflow");
    expect(body.sourceBreakdown.recurringManual).toEqual({ count: 1, amount: 85000 });
  });

  test("overdue items are in the inclusion summary but in no row's items", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-LATE",
      amount: 33000,
      entryType: "Dr",
      voucherDate: "2026-07-01",
      dueDate: "2026-08-10",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    expect(body.inclusion.excludedOverdueOpenItems).toBe(1);
    expect(body.inclusion.excludedOverdueAmount).toBe(33000);
    expect(body.rows.flatMap((r) => r.items)).toHaveLength(0);
    expect(body.totals.inflows).toBe(0);
  });

  test("undated items are reported with their amount, and never dated", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company,
      party: customer,
      billName: "INV-NODATE",
      amount: 41000,
      entryType: "Dr",
      voucherDate: "2026-08-01",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    expect(body.inclusion.excludedUndatedOpenItems).toBe(1);
    expect(body.inclusion.excludedUndatedAmount).toBe(41000);
    expect(body.totals.inflows).toBe(0);
  });

  test("diagnostics surface the heaviest date and the top party", async () => {
    const { company, customer } = await seedCompany();
    // Two bills on one day, one on another — a deliberate cluster.
    for (const [bill, amt] of [["C1", 30000], ["C2", 20000]]) {
      await seedOpenBill({
        company, party: customer, billName: bill, amount: amt,
        entryType: "Dr", voucherDate: "2026-08-01", dueDate: "2026-09-19",
      });
    }
    await seedOpenBill({
      company, party: customer, billName: "C3", amount: 5000,
      entryType: "Dr", voucherDate: "2026-08-01", dueDate: "2026-09-25",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);
    const c = body.diagnostics.concentration;

    expect(c.maxDate.slice(0, 10)).toBe("2026-09-19");
    expect(c.maxDateAmount).toBe(50000);
    expect(c.maxDateShareOfMovement).toBe(90.9); // 50000 of 55000
    expect(c.movingDays).toBe(2);
    expect(c.horizonDays).toBe(30);

    expect(body.diagnostics.topMovementDates[0].itemCount).toBe(2);
    expect(body.diagnostics.topParties[0].name).toBe("Company A Buyer");
    expect(body.diagnostics.topParties[0].count).toBe(3);
    expect(body.diagnostics.topParties[0].amount).toBe(55000);
  });

  test("diagnostics carry no severity, threshold or warning field — descriptive only", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);
    for (const k of ["severity", "level", "warning", "breached", "threshold", "alert"]) {
      expect(body.diagnostics.concentration[k]).toBeUndefined();
    }
    expect(body.alerts).toBeUndefined();
  });

  test("company scoping still holds — no drilldown item leaks across companies", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");
    await seedOpenBill({
      company: b.company, party: b.customer, billName: "B-SECRET", amount: 77000,
      entryType: "Dr", voucherDate: "2026-08-01", dueDate: "2026-09-10",
    });

    const { body } = await call(`?companyId=${a.company._id}&asOfDate=${AS_OF}&horizon=30`);
    const allItems = body.rows.flatMap((r) => r.items);
    expect(allItems).toHaveLength(0);
    expect(body.diagnostics.topParties).toHaveLength(0);
    expect(body.inclusion.includedOpenItems).toBe(0);
    expect(JSON.stringify(body)).not.toContain("B-SECRET");
    expect(JSON.stringify(body)).not.toContain("Company B Buyer");
  });

  test("Chunk 1-A totals are unchanged for the same fixture", async () => {
    // The exact end-to-end fixture Chunk 1-A asserted, re-run against the
    // 1-B code. Every figure must be identical.
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 100000, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company, party: customer, billName: "INV-E2E", amount: 40000,
      entryType: "Dr", voucherDate: "2026-08-10", dueDate: "2026-09-03",
    });
    await Acc_RecurringItem.create({
      companyId: company._id, name: "Rent", type: "rent", direction: "outflow",
      amount: 30000, frequency: "monthly", dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"), startDate: new Date("2026-01-05"),
      status: "active", source: "manual",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=7`);

    expect(body.openingCash).toBe(100000);
    expect(body.rows.find((r) => r.date.slice(0, 10) === "2026-09-03").closing).toBe(140000);
    expect(body.rows.find((r) => r.date.slice(0, 10) === "2026-09-05").closing).toBe(110000);
    expect(body.totals.inflows).toBe(40000);
    expect(body.totals.outflows).toBe(30000);
    expect(body.totals.netMovement).toBe(10000);
    expect(body.totals.closingCash).toBe(110000);
    expect(body.totals.minimumCash).toBe(100000);
    expect(body.totals.minimumCashDate.slice(0, 10)).toBe(AS_OF);
  });

  test("1-B writes nothing either — counts and updatedAt unchanged", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 1000, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company, party: customer, billName: "INV-RO2", amount: 500,
      entryType: "Dr", voucherDate: "2026-08-02", dueDate: "2026-09-09",
    });
    await Acc_BillTerms.create({
      companyId: company._id, ledgerId: customer._id, billName: "OTHER2",
      dueDate: new Date("2026-09-15"), source: "company_default",
      creditDaysUsed: 46, basisDate: new Date("2026-07-31"),
    });
    await Acc_RecurringItem.create({
      companyId: company._id, name: "Rent", type: "rent", direction: "outflow",
      amount: 100, frequency: "monthly", dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"), startDate: new Date("2026-01-05"),
      status: "active", source: "manual",
    });

    const snap = async () => ({
      v: await Acc_Voucher.countDocuments({}),
      bt: await Acc_BillTerms.countDocuments({}),
      ri: await Acc_RecurringItem.countDocuments({}),
      lg: await Acc_Ledger.countDocuments({}),
      vU: (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      btU: (await Acc_BillTerms.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      riU: (await Acc_RecurringItem.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    });

    const before = await snap();
    for (const h of [7, 30, 90]) {
      const { status } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=${h}`);
      expect(status).toBe(200);
    }
    expect(await snap()).toEqual(before);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-E — WEEKLY GROUPING
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("Chunk 1-E — grouping", () => {
  test("the response carries grouping metadata and weeklyRows", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30`);

    expect(body.grouping).toEqual({
      mode: "daily",
      available: ["daily", "weekly"],
      defaultMode: "daily",
    });
    expect(Array.isArray(body.weeklyRows)).toBe(true);
    expect(body.weeklyRows.length).toBeGreaterThan(0);
    expect(body.rows).toHaveLength(30);
  });

  test("the default mode follows the horizon: daily to 30, weekly at 60/90", async () => {
    const { company } = await seedCompany();
    for (const [h, mode] of [[7, "daily"], [15, "daily"], [30, "daily"], [60, "weekly"], [90, "weekly"]]) {
      const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=${h}`);
      expect(body.grouping.defaultMode).toBe(mode);
      expect(body.grouping.mode).toBe(mode);
    }
  });

  test("groupBy=daily and groupBy=weekly are honoured over the default", async () => {
    const { company } = await seedCompany();

    const weekly30 = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30&groupBy=weekly`);
    expect(weekly30.body.grouping.mode).toBe("weekly");
    expect(weekly30.body.grouping.defaultMode).toBe("daily");

    const daily90 = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90&groupBy=daily`);
    expect(daily90.body.grouping.mode).toBe("daily");
    expect(daily90.body.rows).toHaveLength(90);
  });

  test("an invalid groupBy is refused, not silently defaulted", async () => {
    const { company } = await seedCompany();
    for (const bad of ["monthly", "DAILY", "weekly ", "1", "yes"]) {
      const { status, body } = await call(
        `?companyId=${company._id}&asOfDate=${AS_OF}&horizon=30&groupBy=${encodeURIComponent(bad)}`,
      );
      expect(status).toBe(400);
      expect(body.code).toBe("INVALID_GROUPING");
    }
  });

  test("daily rows stay in the payload even when grouped weekly — drilldown survives", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company, party: customer, billName: "INV-W", amount: 60000,
      entryType: "Dr", voucherDate: "2026-08-10", dueDate: "2026-09-10",
    });

    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90&groupBy=weekly`);
    expect(body.rows).toHaveLength(90);
    const day = body.rows.find((r) => r.date.slice(0, 10) === "2026-09-10");
    expect(day.items).toHaveLength(1);

    // And the same item is reachable through the week that contains it.
    const week = body.weeklyRows.find(
      (w) => w.weekStart.slice(0, 10) <= "2026-09-10" && w.weekEnd.slice(0, 10) >= "2026-09-10",
    );
    expect(week.items.map((i) => i.billName)).toContain("INV-W");
  });

  test("weekly and daily views agree on every total, through the real stack", async () => {
    const { company, cash, customer, vendor } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 100000, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company, party: customer, billName: "IN-1", amount: 40000,
      entryType: "Dr", voucherDate: "2026-08-10", dueDate: "2026-09-19",
    });
    await seedOpenBill({
      company, party: vendor, billName: "OUT-1", amount: 15000,
      entryType: "Cr", voucherDate: "2026-08-10", dueDate: "2026-09-20",
    });
    await Acc_RecurringItem.create({
      companyId: company._id, name: "Rent", type: "rent", direction: "outflow",
      amount: 30000, frequency: "monthly", dayOfMonth: 5,
      nextDueDate: new Date("2026-09-05"), startDate: new Date("2026-01-05"),
      status: "active", source: "manual",
    });

    const d = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90&groupBy=daily`);
    const w = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90&groupBy=weekly`);

    expect(w.body.totals).toEqual(d.body.totals);
    expect(w.body.openingCash).toBe(d.body.openingCash);
    expect(w.body.sourceBreakdown).toEqual(d.body.sourceBreakdown);
    expect(w.body.inclusion).toEqual(d.body.inclusion);

    const wIn = w.body.weeklyRows.reduce((s, x) => s + x.inflows, 0);
    const wOut = w.body.weeklyRows.reduce((s, x) => s + x.outflows, 0);
    expect(Math.round(wIn * 100) / 100).toBe(d.body.totals.inflows);
    expect(Math.round(wOut * 100) / 100).toBe(d.body.totals.outflows);
    expect(w.body.weeklyRows[w.body.weeklyRows.length - 1].closing).toBe(d.body.totals.closingCash);
  });

  test("weeks are clipped to the horizon and cover every day exactly once", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=60&groupBy=weekly`);

    expect(body.weeklyRows.reduce((s, w) => s + w.dayCount, 0)).toBe(60);
    expect(body.weeklyRows[0].weekStart.slice(0, 10)).toBe(AS_OF);
    const last = body.weeklyRows[body.weeklyRows.length - 1];
    expect(last.weekEnd.slice(0, 10)).toBe(body.rows[59].date.slice(0, 10));
  });

  test("the Chunk 1-D cash-ledger config is still respected under weekly grouping", async () => {
    // Grouping is presentation; it must not reach back into opening cash.
    const { company, cash } = await seedCompany();
    await seedVoucher({ company, cash, party: (await seedCompany("Tmp")).customer, cashType: "Dr", amount: 77000, voucherDate: "2026-08-01" });

    const before = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90&groupBy=weekly`);
    expect(before.body.openingCashConfig.status).toBe("suggested_default");

    await Acc_ForecastCashLedgerConfig.create({
      companyId: company._id,
      includedLedgerIds: [],
      excludedLedgerIds: [cash._id],
      odLedgerIds: [],
    });

    const after = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90&groupBy=weekly`);
    expect(after.body.openingCashConfig.status).toBe("saved");
    expect(after.body.openingCash).toBe(0);
    expect(after.body.weeklyRows[0].opening).toBe(0);
  });

  test("grouping writes nothing", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 1000, voucherDate: "2026-08-01" });

    const snap = async () => ({
      v: await Acc_Voucher.countDocuments({}),
      bt: await Acc_BillTerms.countDocuments({}),
      ri: await Acc_RecurringItem.countDocuments({}),
      lg: await Acc_Ledger.countDocuments({}),
      cfg: await Acc_ForecastCashLedgerConfig.countDocuments({}),
      vU: (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    });

    const before = await snap();
    for (const g of ["daily", "weekly"]) {
      for (const h of [7, 30, 90]) {
        const { status } = await call(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=${h}&groupBy=${g}`);
        expect(status).toBe(200);
      }
    }
    expect(await snap()).toEqual(before);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHUNK 1-G — ACTION CENTER (read-only guidance)
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("Chunk 1-G — action center", () => {
  const AC = (qs) => call(`/action-center${qs}`);

  test("returns a summary and ranked actions for a valid company", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company, party: customer, billName: "AC-1", amount: 90000,
      entryType: "Dr", voucherDate: "2026-08-01",
    });
    await Acc_BillTerms.create({
      companyId: company._id, ledgerId: customer._id, billName: "AC-1",
      dueDate: new Date("2026-09-15"), source: "company_default",
      creditDaysUsed: 46, basisDate: new Date("2026-08-01"),
    });

    const { status, body } = await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);
    expect(status).toBe(200);
    expect(body.summary).toBeDefined();
    expect(Array.isArray(body.actions)).toBe(true);
    expect(body.actions.length).toBeGreaterThan(0);
    expect(["Needs setup", "Partially ready", "Ready for base use"]).toContain(body.summary.scoreLabel);

    const party = body.actions.find((a) => a.type === "set_party_terms");
    expect(party.targetLabel).toBe("Company A Buyer");
    expect(party.amount).toBe(90000);
    expect(party.href).toBe("/accountant/settings#party-terms");
  });

  test("an empty recurring register and unsaved cash config both produce actions", async () => {
    const { company } = await seedCompany();
    const { body } = await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);

    const types = body.actions.map((a) => a.type);
    expect(types).toContain("add_recurring_items");
    expect(types).toContain("review_cash_ledgers");
    expect(body.summary.recurringActiveCount).toBe(0);
    expect(body.summary.openingCashConfigStatus).toBe("suggested_default");
  });

  test("a SAVED cash config suppresses the cash-ledger action", async () => {
    const { company, cash } = await seedCompany();
    await Acc_ForecastCashLedgerConfig.create({
      companyId: company._id, includedLedgerIds: [cash._id], excludedLedgerIds: [], odLedgerIds: [],
    });

    const { body } = await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);
    expect(body.actions.map((a) => a.type)).not.toContain("review_cash_ledgers");
    expect(body.summary.openingCashConfigStatus).toBe("saved");
  });

  test("a populated recurring register suppresses the recurring action", async () => {
    const { company } = await seedCompany();
    for (const type of ["payroll", "rent"]) {
      await Acc_RecurringItem.create({
        companyId: company._id, name: `${type} schedule`, type,
        direction: "outflow", amount: 1000, frequency: "monthly", dayOfMonth: 5,
        nextDueDate: new Date("2026-09-05"), startDate: new Date("2026-01-05"),
        status: "active", source: "manual",
      });
    }
    const { body } = await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);
    expect(body.actions.map((a) => a.type)).not.toContain("add_recurring_items");
    expect(body.summary.recurringActiveCount).toBe(2);
  });

  test("overdue bills produce an expected-date action pointing at the drawer", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company, party: customer, billName: "OLD-1", amount: 33000,
      entryType: "Dr", voucherDate: "2026-06-01", dueDate: "2026-07-01",
    });

    const { body } = await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);
    const a = body.actions.find((x) => x.type === "set_overdue_expected_date");
    expect(a).toBeDefined();
    expect(a.amount).toBe(33000);
    expect(a.count).toBe(1);
    expect(a.href).toBe("#overdue");
    expect(body.summary.overdueExcludedAmount).toBe(33000);
  });

  test("no action carries a recommended value or a mutation payload", async () => {
    const { company, customer } = await seedCompany();
    await seedOpenBill({
      company, party: customer, billName: "AC-2", amount: 5000,
      entryType: "Dr", voucherDate: "2026-06-01", dueDate: "2026-07-01",
    });

    const { body } = await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=90`);
    for (const a of body.actions) {
      for (const forbidden of [
        "proposedCreditPeriodDays", "suggestedCreditDays", "forecastExpectedDate",
        "includedLedgerIds", "payload", "method",
      ]) {
        expect(a[forbidden]).toBeUndefined();
      }
      expect(a.href).toBeTruthy();
      expect(a.ctaLabel).toBeTruthy();
    }
  });

  test("a missing or malformed companyId is refused", async () => {
    expect((await AC("")).status).toBe(400);
    expect((await AC("?companyId=not-an-id")).status).toBe(400);
  });

  test("an invalid horizon is refused, same as the forecast route", async () => {
    const { company } = await seedCompany();
    const { status, body } = await AC(`?companyId=${company._id}&horizon=45`);
    expect(status).toBe(400);
    expect(body.code).toBe("INVALID_HORIZON");
  });

  test("a non-existent company is a clean 404", async () => {
    const { status } = await AC(`?companyId=${new mongoose.Types.ObjectId()}`);
    expect(status).toBe(404);
  });

  test("no auth is refused", async () => {
    const { company } = await seedCompany();
    const res = await fetch(`${base}/action-center?companyId=${company._id}`);
    expect(res.status).toBe(401);
  });

  test("one company's parties never appear in another's action center", async () => {
    const a = await seedCompany("Company A");
    const b = await seedCompany("Company B");
    await seedOpenBill({
      company: b.company, party: b.customer, billName: "B-SECRET", amount: 500000,
      entryType: "Dr", voucherDate: "2026-08-01", dueDate: "2026-09-15",
    });

    const { body } = await AC(`?companyId=${a.company._id}&asOfDate=${AS_OF}&horizon=90`);
    expect(JSON.stringify(body)).not.toContain("Company B Buyer");
    expect(JSON.stringify(body)).not.toContain("B-SECRET");
    expect(body.actions.filter((x) => x.type === "set_party_terms")).toHaveLength(0);
  });

  test("the action center writes nothing", async () => {
    const { company, cash, customer } = await seedCompany();
    await seedVoucher({ company, cash, party: customer, cashType: "Dr", amount: 1000, voucherDate: "2026-08-01" });
    await seedOpenBill({
      company, party: customer, billName: "AC-RO", amount: 500,
      entryType: "Dr", voucherDate: "2026-08-02", dueDate: "2026-09-09",
    });

    const snap = async () => ({
      v: await Acc_Voucher.countDocuments({}),
      bt: await Acc_BillTerms.countDocuments({}),
      ri: await Acc_RecurringItem.countDocuments({}),
      lg: await Acc_Ledger.countDocuments({}),
      cfg: await Acc_ForecastCashLedgerConfig.countDocuments({}),
      vU: (await Acc_Voucher.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      lU: (await Acc_Ledger.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
      btU: (await Acc_BillTerms.find({}).select("updatedAt").lean()).map((x) => +new Date(x.updatedAt)).sort().join(","),
    });

    const before = await snap();
    for (const h of [7, 30, 90]) {
      expect((await AC(`?companyId=${company._id}&asOfDate=${AS_OF}&horizon=${h}`)).status).toBe(200);
    }
    expect(await snap()).toEqual(before);
  });
});
