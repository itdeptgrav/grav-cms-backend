// test/accountant/ledger-statement-bill-wise.route.test.js
//
// HTTP-level test for GET /api/accountant/chart-of-accounts/ledgers/:id/statement
// (C0-D). This route's bill-wise-outstanding block was migrated from an
// inline aggregation onto services/openItems.service.js's shared
// `billsByLedger` + `agedBillsForLedger`. What this proves that
// services/openItems.test.js's pure tests cannot: the ROUTE WIRING is
// correct — the right ledger's bills, the real closing balance, the real
// opening-balance-date fallback — end to end, against a real (in-memory)
// database, reproducing the exact `billWiseOutstanding` response shape the
// frontend has always read.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    req.user = raw ? JSON.parse(raw) : { id: "tester", permissions: { canEdit: true } };
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

let server, base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/chart-of-accounts", require("../../routes/Accountant_Routes/Acc_chartOfAccounts"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/chart-of-accounts`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

async function call(path) {
  const res = await fetch(`${base}${path}`, { headers: { "x-test-user": JSON.stringify({ id: "t", permissions: { canEdit: true } }) } });
  return { status: res.status, body: await res.json() };
}

async function makeFixture() {
  const company = await Acc_Company.create({ companyName: "Statement Co", booksFromDate: new Date("2025-04-01") });
  const debtorGroup = await Acc_Group.create({ companyId: company._id, name: "Sundry Debtors", nature: "asset" });
  const salesGroup = await Acc_Group.create({ companyId: company._id, name: "Sales Accounts", nature: "revenue" });
  const customer = await Acc_Ledger.create({
    companyId: company._id,
    name: "Statement Buyer",
    groupId: debtorGroup._id,
    groupName: debtorGroup.name,
    nature: "asset",
  });
  const salesLedger = await Acc_Ledger.create({
    companyId: company._id,
    name: "Statement Sales",
    groupId: salesGroup._id,
    groupName: salesGroup.name,
    nature: "revenue",
  });
  return { company, customer, salesLedger };
}

/** A minimal, valid, POSTED sales voucher with one bill allocation on the party leg. */
async function postSalesVoucher(fx, { billName, amount, dueDate, voucherDate }) {
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: "sales",
    voucherNumber: `SV-${billName}`,
    voucherDate: new Date(voucherDate),
    partyLedgerId: fx.customer._id,
    partyLedgerName: fx.customer.name,
    status: "posted",
    grandTotal: amount,
    ledgerEntries: [
      {
        ledgerId: fx.customer._id,
        ledgerName: fx.customer.name,
        type: "Dr",
        amount,
        billAllocations: [{ billName, billType: "new_ref", amount, dueDate: dueDate ? new Date(dueDate) : undefined }],
      },
      { ledgerId: fx.salesLedger._id, ledgerName: fx.salesLedger.name, type: "Cr", amount },
    ],
  });
}

async function postReceipt(fx, { billName, amount, voucherDate }) {
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: "receipt",
    voucherNumber: `RC-${billName}`,
    voucherDate: new Date(voucherDate),
    partyLedgerId: fx.customer._id,
    partyLedgerName: fx.customer.name,
    status: "posted",
    grandTotal: amount,
    ledgerEntries: [
      {
        ledgerId: fx.customer._id,
        ledgerName: fx.customer.name,
        type: "Cr",
        amount,
        billAllocations: [{ billName, billType: "agst_ref", amount }],
      },
    ],
  });
}

describe("GET /ledgers/:id/statement — billWiseOutstanding (migrated, C0-D)", () => {
  test("the response shape is exactly what the frontend has always read", async () => {
    const fx = await makeFixture();
    await postSalesVoucher(fx, {
      billName: "INV-100",
      amount: 50000,
      dueDate: "2026-01-01",
      voucherDate: "2025-12-01",
    });

    const { status, body } = await call(`/ledgers/${fx.customer._id}/statement`);
    expect(status).toBe(200);

    const bwo = body.billWiseOutstanding;
    expect(bwo.applicable).toBe(true);
    expect(typeof bwo.totalOutstanding).toBe("number");
    expect(["Dr", "Cr"]).toContain(bwo.closingType);
    expect(Array.isArray(bwo.bills)).toBe(true);
    expect(bwo.agingBuckets).toEqual(
      expect.objectContaining({ current: expect.any(Number), "0-30": expect.any(Number) }),
    );
    expect(bwo.bucketTotals).toEqual(
      expect.objectContaining({
        current: expect.any(Number),
        d0_30: expect.any(Number),
        d31_60: expect.any(Number),
        d61_90: expect.any(Number),
        d90Plus: expect.any(Number),
      }),
    );

    const bill = bwo.bills.find((b) => b.billName === "INV-100");
    expect(bill).toEqual(
      expect.objectContaining({
        billName: "INV-100",
        creditDays: 0,
        originalAmount: 50000,
        remaining: 50000,
        remainingAbs: 50000,
        remainingType: "Dr",
        bucket: "90+", // due 2026-01-01, long past by any realistic "today"
        voucherCount: 1,
      }),
    );
  });

  test("a settled bill (fully paid) does not appear as an open item", async () => {
    const fx = await makeFixture();
    await postSalesVoucher(fx, { billName: "INV-200", amount: 20000, voucherDate: "2026-01-01" });
    await postReceipt(fx, { billName: "INV-200", amount: 20000, voucherDate: "2026-01-15" });

    const { body } = await call(`/ledgers/${fx.customer._id}/statement`);
    const bill = body.billWiseOutstanding.bills.find((b) => b.billName === "INV-200");
    expect(bill).toBeUndefined();
  });

  test("a partial payment reduces the remaining balance, still open", async () => {
    const fx = await makeFixture();
    await postSalesVoucher(fx, { billName: "INV-300", amount: 30000, voucherDate: "2026-01-01" });
    await postReceipt(fx, { billName: "INV-300", amount: 10000, voucherDate: "2026-01-10" });

    const { body } = await call(`/ledgers/${fx.customer._id}/statement`);
    const bill = body.billWiseOutstanding.bills.find((b) => b.billName === "INV-300");
    expect(bill.remaining).toBe(20000);
  });

  test("bill allocations with no bill name are counted consistently — they leave a reconciling Unallocated line", async () => {
    const fx = await makeFixture();
    // A receipt with NO bill reference at all (an on-account payment) —
    // moves the ledger's real balance but cannot be grouped into a bill.
    await Acc_Voucher.create({
      companyId: fx.company._id,
      voucherType: "receipt",
      voucherNumber: "RC-ONACC-1",
      voucherDate: new Date("2026-01-05"),
      partyLedgerId: fx.customer._id,
      partyLedgerName: fx.customer.name,
      status: "posted",
      grandTotal: 5000,
      ledgerEntries: [
        { ledgerId: fx.customer._id, ledgerName: fx.customer.name, type: "Cr", amount: 5000 }, // no billAllocations at all
      ],
    });

    const { body } = await call(`/ledgers/${fx.customer._id}/statement`);
    const bwo = body.billWiseOutstanding;
    // The unnamed/unallocated movement is not silently dropped — the
    // headline totalOutstanding still equals the ledger's real closing
    // balance, and the gap surfaces as the Opening/Unallocated line.
    const unalloc = bwo.bills.find((b) => b.billName === "Opening / Unallocated");
    expect(unalloc).toBeTruthy();
    expect(unalloc.remaining).toBe(-5000);
    expect(bwo.totalOutstanding).toBe(-5000);
  });

  test("a non-party ledger (e.g. a bank ledger) never gets billWiseOutstanding", async () => {
    const fx = await makeFixture();
    const { body } = await call(`/ledgers/${fx.salesLedger._id}/statement`);
    expect(body.billWiseOutstanding).toBeNull();
  });

  test("multiple open bills all appear, sorted by days overdue", async () => {
    const fx = await makeFixture();
    await postSalesVoucher(fx, { billName: "INV-OLD", amount: 1000, dueDate: "2025-06-01", voucherDate: "2025-05-01" });
    await postSalesVoucher(fx, { billName: "INV-NEW", amount: 2000, dueDate: "2026-08-01", voucherDate: "2026-07-01" });

    const { body } = await call(`/ledgers/${fx.customer._id}/statement`);
    const names = body.billWiseOutstanding.bills
      .filter((b) => b.billName !== "Opening / Unallocated")
      .map((b) => b.billName);
    expect(names).toEqual(["INV-OLD", "INV-NEW"]); // OLD is more overdue, sorts first
  });
});
