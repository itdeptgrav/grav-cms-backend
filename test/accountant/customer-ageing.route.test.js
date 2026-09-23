// test/accountant/customer-ageing.route.test.js
//
// Lane B, Chunk 3 — Customer Invoice-wise Ageing, over real collections.
//
// What this file exists to prove that the pure tests cannot:
//   • A partial receipt, several receipts and a credit note each reduce the
//     bill they are allocated against — through real `billAllocations` on real
//     vouchers, not hand-built fold objects.
//   • Future-dated, unposted and optional vouchers do not settle a bill, and a
//     future-dated invoice does not create one.
//   • A bill with no due date anywhere is disclosed as undated, not aged from
//     its invoice date.
//   • Opening balances and on-account receipts surface as unallocated.
//   • THE TIE-OUT: aged − bill credits + unallocated = the ledger, and the
//     report's clamped totals equal the Customer Outstanding Summary's
//     `receivable` and `customerCredit` for the same company and date.
//   • Cross-company ids, the three scopes, and GET/POST equivalence.
//
// `orgAuth` is mocked so identity is assertable without a JWT — it is Lane A's.
// `requireCompanyAccess` is the REAL one.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => {
  const actual = jest.requireActual("../../Middlewear/AccountantOrgAuthMiddleware");
  return {
    ...actual,
    orgAuth: (req, res, next) => {
      const raw = req.headers["x-test-user"];
      if (!raw) {
        return res.status(401).json({ success: false, message: "Authentication required" });
      }
      const parsed = JSON.parse(raw);
      req.user = parsed.user;
      req.organization = parsed.organization || null;
      next();
    },
  };
});

const {
  Acc_Company,
  Acc_Group,
  Acc_Ledger,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/customers/reports",
    require("../../routes/Accountant_Routes/Acc_customerReports"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/customers/reports`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/* ── Fixtures ────────────────────────────────────────────────────────────── */

async function seedCompany(name) {
  const company = await Acc_Company.create({
    companyName: name,
    booksFromDate: new Date("2025-04-01"),
  });
  const debtors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const creditors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Creditors",
    nature: "liability",
  });
  const salesGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Sales Accounts",
    nature: "revenue",
  });
  const sales = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Sales`,
    groupId: salesGroup._id,
    groupName: salesGroup.name,
    nature: "revenue",
  });
  return { company, debtors, creditors, sales };
}

async function makeCustomer(fx, name, opts = {}) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: opts.group ? opts.group._id : fx.debtors._id,
    groupName: opts.group ? opts.group.name : fx.debtors.name,
    nature: "asset",
    gstin: opts.gstin,
    openingBalance: opts.openingBalance || 0,
    openingBalanceType: opts.openingBalanceType || "Dr",
  });
}

/**
 * A sales invoice: DEBITS the customer, with a `new_ref` bill allocation that
 * establishes the bill and carries its due date.
 */
async function invoice(fx, party, o = {}) {
  const amount = o.amount ?? 100000;
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: "sales",
    voucherTypeName: o.voucherTypeName || "Tax Invoice",
    voucherNumber: o.billName || `INV-${Math.random().toString(36).slice(2, 8)}`,
    voucherDate: new Date(o.date || "2026-04-01"),
    ...(o.headerDueDate ? { dueDate: new Date(o.headerDueDate) } : {}),
    partyLedgerId: party._id,
    partyLedgerName: party.name,
    status: o.status || "posted",
    isOptional: o.isOptional || false,
    grandTotal: amount,
    ledgerEntries: [
      {
        ledgerId: party._id,
        ledgerName: party.name,
        type: "Dr",
        amount,
        billAllocations: [
          {
            billName: o.billName || "INV-1",
            billType: "new_ref",
            amount,
            ...(o.dueDate ? { dueDate: new Date(o.dueDate) } : {}),
            ...(o.creditDays ? { creditDays: o.creditDays } : {}),
          },
        ],
      },
      { ledgerId: fx.sales._id, ledgerName: fx.sales.name, type: "Cr", amount },
    ],
  });
}

/** A receipt or credit note: CREDITS the customer against a named bill. */
async function settlement(fx, party, o = {}) {
  const amount = o.amount ?? 40000;
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: o.voucherType || "receipt",
    voucherTypeName: o.voucherTypeName,
    voucherNumber: o.voucherNumber || `RCT-${Math.random().toString(36).slice(2, 8)}`,
    voucherDate: new Date(o.date || "2026-05-01"),
    partyLedgerId: party._id,
    partyLedgerName: party.name,
    status: o.status || "posted",
    isOptional: o.isOptional || false,
    grandTotal: amount,
    ledgerEntries: [
      {
        ledgerId: party._id,
        ledgerName: party.name,
        type: "Cr",
        amount,
        billAllocations: [
          {
            billName: o.billName || "INV-1",
            billType: o.billType || "agst_ref",
            amount,
          },
        ],
      },
      { ledgerId: fx.sales._id, ledgerName: fx.sales.name, type: "Dr", amount },
    ],
  });
}

/** Money received with no bill named — an on-account advance. */
async function onAccount(fx, party, o = {}) {
  const amount = o.amount ?? 50000;
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: "receipt",
    voucherNumber: o.voucherNumber || `ADV-${Math.random().toString(36).slice(2, 8)}`,
    voucherDate: new Date(o.date || "2026-05-01"),
    partyLedgerId: party._id,
    partyLedgerName: party.name,
    status: "posted",
    grandTotal: amount,
    ledgerEntries: [
      {
        ledgerId: party._id,
        ledgerName: party.name,
        type: "Cr",
        amount,
        ...(o.named === false ? {} : { billAllocations: [] }),
      },
      { ledgerId: fx.sales._id, ledgerName: fx.sales.name, type: "Dr", amount },
    ],
  });
}

const orgFor = (company) => ({
  user: { id: new mongoose.Types.ObjectId().toString(), role: "owner" },
  organization: { tallyCompanyIds: [String(company._id)] },
});

async function call(path, { user, raw = false, method = "GET", body: reqBody } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(user === null ? {} : { "x-test-user": JSON.stringify(user) }),
      ...(reqBody !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(reqBody !== undefined ? { body: JSON.stringify(reqBody) } : {}),
  });
  if (raw) return res;
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

const AS_OF = "2026-06-30";
const q = (companyId, extra = "") => `/ageing?companyId=${companyId}&asOf=${AS_OF}${extra}`;
const party0 = (r) => r.body.report.parties[0];

/* ── Settlements against a bill ──────────────────────────────────────────── */

describe("partial receipts, further receipts and credit notes", () => {
  test("an unsettled invoice ages at its full value", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toHaveLength(1);
    expect(r.body.report.rows[0].remaining).toBe(100000);
    expect(r.body.report.rows[0].bucket).toBe("d31_60");
    expect(party0(r).buckets.d31_60).toBe(100000);
  });

  test("a PARTIAL receipt reduces the bill and the invoice value is still shown", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 40000, date: "2026-05-20" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.remaining).toBe(60000);
    expect(row.originalAmount).toBe(100000);
    expect(row.bucket).toBe("d31_60");
  });

  test("SEVERAL receipts against one bill all reduce it", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 30000, date: "2026-05-10" });
    await settlement(a, c, { billName: "INV-1", amount: 25000, date: "2026-06-10" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.remaining).toBe(45000);
  });

  test("a CREDIT NOTE against the bill reduces it the same way a receipt does", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, {
      billName: "INV-1",
      amount: 18000,
      voucherType: "credit_note",
      date: "2026-05-15",
    });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.remaining).toBe(82000);
  });

  test("a FULLY settled invoice disappears from the ageing", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 100000, date: "2026-05-20" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.totals.agedTotal).toBe(0);
    expect(r.body.report.parties).toEqual([]);
  });

  test("an OVER-received invoice becomes a bill credit, not a negative bucket", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 130000, date: "2026-05-20" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(party0(r).billCredits).toBe(30000);
    expect(party0(r).agedTotal).toBe(0);
    for (const k of Object.keys(party0(r).buckets)) {
      expect(party0(r).buckets[k]).toBe(0);
    }
  });

  test("two invoices settle independently — one paid, one open", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await invoice(a, c, { billName: "INV-2", amount: 60000, dueDate: "2026-06-20", date: "2026-05-20" });
    await settlement(a, c, { billName: "INV-1", amount: 100000, date: "2026-05-25" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["INV-2"]);
    expect(party0(r).buckets.d1_30).toBe(60000);
    expect(party0(r).buckets.d31_60).toBe(0);
  });
});

/* ── Which vouchers count ────────────────────────────────────────────────── */

describe("only posted, non-optional vouchers through the as-of date", () => {
  test("a receipt banked AFTER the as-of date does not settle the bill", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 100000, date: "2026-07-15" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows[0].remaining).toBe(100000);
    expect(party0(r).reconciles).toBe(true);
  });

  test("a FUTURE-dated invoice is not aged, even with no asOf supplied", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await invoice(a, c, { billName: "INV-FUTURE", amount: 9000000, date: "2099-01-01" });

    const r = await call(`/ageing?companyId=${a.company._id}`, { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["INV-1"]);
    expect(JSON.stringify(r.body)).not.toContain("9000000");
    expect(r.body.report.asOf).toBeTruthy();
  });

  test("draft, pending, cancelled, void and optional documents are all ignored", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    // None of these may settle INV-1, and none may raise a bill of their own.
    for (const status of ["draft", "pending_approval", "cancelled", "void"]) {
      await settlement(a, c, { billName: "INV-1", amount: 25000, status, date: "2026-05-10" });
      await invoice(a, c, { billName: `INV-${status}`, amount: 777, status, date: "2026-04-05" });
    }
    await settlement(a, c, { billName: "INV-1", amount: 25000, isOptional: true, date: "2026-05-10" });
    await invoice(a, c, { billName: "INV-OPT", amount: 777, isOptional: true, date: "2026-04-05" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["INV-1"]);
    expect(r.body.report.rows[0].remaining).toBe(100000);
  });
});

/* ── Due dates ───────────────────────────────────────────────────────────── */

describe("due-date precedence and undated bills", () => {
  test("the allocation's due date is used and its source is recorded", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, {
      billName: "INV-1",
      dueDate: "2026-05-01",
      headerDueDate: "2026-07-01",
      creditDays: 90,
    });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.dueDateSource).toBe("allocation");
    expect(row.bucket).toBe("d31_60");
  });

  test("the voucher header's due date is the fallback", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", headerDueDate: "2026-06-01" });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.dueDateSource).toBe("voucher");
    expect(row.bucket).toBe("d1_30");
  });

  test("invoice date plus EXPLICIT credit days is the third choice", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", date: "2026-04-01", creditDays: 45 });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.dueDateSource).toBe("creditDays");
    expect(row.creditDays).toBe(45);
    expect(row.bucket).toBe("d31_60"); // due 16 May, 45 days before 30 Jun
  });

  test("a bill with NO date anywhere is 'Date unavailable', not aged from its invoice date", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    // Raised 1 April — 90 days before the as-of date. A report that aged it
    // from the invoice would put it in 61-90 and call that a fact.
    await invoice(a, c, { billName: "INV-1", amount: 100000, date: "2026-04-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.bucket).toBe("unknown");
    expect(row.dueDate).toBeNull();
    expect(row.daysOverdue).toBeNull();
    expect(row.dueDateSource).toBe("none");
    expect(party0(r).buckets.unknown).toBe(100000);
    expect(party0(r).buckets.d61_90).toBe(0);
    expect(r.body.report.totals.undatedBillCount).toBe(1);
  });

  test("a SETTLED bill keeps the invoice's due date, whatever order the rows come back in", async () => {
    /* THE BUG THIS PINS. `foldAllocations` takes `dueDate` from whichever
     * allocation row the aggregation returns FIRST, and the aggregation is
     * unsorted. A receipt's allocation carries no due date, so when Mongo
     * returned the receipt first the invoice's date vanished and a 60-day-old
     * bill was reported as "Date unavailable". It reproduced only in a full
     * suite run, where the collection state differs. */
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    // Several settlements, so the invoice row is unlikely to be returned first.
    await settlement(a, c, { billName: "INV-1", amount: 10000, date: "2026-05-10" });
    await settlement(a, c, { billName: "INV-1", amount: 10000, date: "2026-05-11" });
    await settlement(a, c, { billName: "INV-1", amount: 20000, date: "2026-05-12" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.dueDateSource).toBe("allocation");
    expect(row.bucket).toBe("d31_60");
    expect(row.remaining).toBe(60000);
    expect(party0(r).buckets.unknown).toBe(0);
  });

  test("the ledger's own credit period is NOT used to date a bill", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await Acc_Ledger.updateOne({ _id: c._id }, { $set: { creditPeriodDays: 30 } });
    await invoice(a, c, { billName: "INV-1", date: "2026-04-01" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.bucket).toBe("unknown");
    expect(row.dueDateSource).toBe("none");
  });
});

/* ── Unallocated balances and customer credits ───────────────────────────── */

describe("unallocated balances are disclosed, never aged and never netted", () => {
  test("an OPENING balance no bill explains surfaces as unallocated", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports", {
      openingBalance: 30000,
      openingBalanceType: "Dr",
    });
    await invoice(a, c, { billName: "INV-1", amount: 50000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(party0(r).agedTotal).toBe(50000);
    expect(party0(r).unallocatedReceivable).toBe(30000);
    expect(party0(r).ledgerBalance).toBe(80000);
    expect(party0(r).reconciles).toBe(true);
  });

  test("an ON-ACCOUNT receipt is an unallocated credit and does not reduce a bucket", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await onAccount(a, c, { amount: 300000, date: "2026-05-10" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(party0(r).buckets.d31_60).toBe(100000);
    expect(party0(r).agedTotal).toBe(100000);
    expect(party0(r).unallocatedCredit).toBe(300000);
    expect(party0(r).ledgerBalanceType).toBe("Cr");
    expect(party0(r).ledgerBalance).toBe(200000);
    expect(party0(r).reconciles).toBe(true);
    // The customer is in credit overall, yet the invoice is still overdue.
    expect(r.body.report.totals.ledgerCredit).toBe(200000);
    expect(r.body.report.totals.ledgerReceivable).toBe(0);
  });

  test("a customer wholly in credit appears with no aged rows", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Prepaid Buyer");
    await onAccount(a, c, { amount: 75000, date: "2026-05-10" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(party0(r).unallocatedCredit).toBe(75000);
    expect(r.body.report.totals.agedTotal).toBe(0);
    expect(r.body.report.totals.ledgerCredit).toBe(75000);
  });

  test("a fully settled customer is omitted entirely", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Settled Buyer");
    await invoice(a, c, { billName: "INV-1", amount: 50000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 50000, date: "2026-05-20" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.parties).toEqual([]);
    expect(r.body.report.consideredLedgerCount).toBe(1);
  });
});

/* ── THE TIE-OUT ─────────────────────────────────────────────────────────── */

describe("reconciliation to the Customer Outstanding Summary", () => {
  /** A company with every awkward shape at once. */
  async function messyCompany() {
    const a = await seedCompany("Alpha");
    const plain = await makeCustomer(a, "Plain Buyer");
    const partial = await makeCustomer(a, "Partly Paid Buyer");
    const opening = await makeCustomer(a, "Opening Balance Buyer", {
      openingBalance: 33000,
      openingBalanceType: "Dr",
    });
    const advance = await makeCustomer(a, "On Account Buyer");
    const over = await makeCustomer(a, "Over Received Buyer");
    const undated = await makeCustomer(a, "Undated Buyer");

    await invoice(a, plain, { billName: "P-1", amount: 100000, dueDate: "2026-05-01" });
    await invoice(a, partial, { billName: "Q-1", amount: 80000, dueDate: "2026-06-25" });
    await settlement(a, partial, { billName: "Q-1", amount: 30000, date: "2026-06-26" });
    await invoice(a, opening, { billName: "R-1", amount: 20000, dueDate: "2026-03-01" });
    await invoice(a, advance, { billName: "S-1", amount: 60000, dueDate: "2026-05-01" });
    await onAccount(a, advance, { amount: 90000, date: "2026-05-05" });
    await invoice(a, over, { billName: "T-1", amount: 40000, dueDate: "2026-05-01" });
    await settlement(a, over, { billName: "T-1", amount: 55000, date: "2026-05-20" });
    await invoice(a, undated, { billName: "U-1", amount: 25000, date: "2026-04-01" });

    return { a };
  }

  test("every party reconciles: aged − bill credits + unallocated = ledger balance", async () => {
    const { a } = await messyCompany();
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.reconciliation.reconciles).toBe(true);
    expect(r.body.report.reconciliation.partiesOutOfBalance).toEqual([]);

    for (const p of r.body.report.parties) {
      expect(
        Math.abs(p.agedTotal - p.billCredits + p.unallocatedSigned - p.ledgerSigned),
      ).toBeLessThan(0.02);
    }
  });

  test("the ageing's clamped totals EQUAL the Outstanding Summary's, same company and date", async () => {
    const { a } = await messyCompany();
    const user = orgFor(a.company);
    const ageing = (await call(q(a.company._id), { user })).body.report;
    const outstanding = (
      await call(`/outstanding?companyId=${a.company._id}&asOf=${AS_OF}`, { user })
    ).body.report;

    expect(ageing.totals.ledgerReceivable).toBe(outstanding.totals.receivable);
    expect(ageing.totals.ledgerCredit).toBe(outstanding.totals.customerCredit);
  });

  test("the two reports agree ledger by ledger, not just in total", async () => {
    const { a } = await messyCompany();
    const user = orgFor(a.company);
    const ageing = (await call(q(a.company._id), { user })).body.report;
    const outstanding = (
      await call(`/outstanding?companyId=${a.company._id}&asOf=${AS_OF}`, { user })
    ).body.report;

    const byId = new Map(outstanding.rows.map((x) => [x.ledgerId, x]));
    for (const p of ageing.parties) {
      const o = byId.get(p.ledgerId);
      expect(o).toBeTruthy();
      expect(p.ledgerSigned).toBe(o.signedBalance);
      expect(p.ledgerBalanceType).toBe(o.balanceType);
    }
  });

  test("the buckets sum to the aged total, and the aged total is not the ledger total", async () => {
    const { a } = await messyCompany();
    const t = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.totals;
    const summed = Object.values(t.buckets).reduce((s, v) => s + v, 0);
    expect(Math.abs(summed - t.agedTotal)).toBeLessThan(0.02);
    // The on-account advance and the over-receipt mean these must differ; if
    // they matched, something would be netting that must not.
    expect(t.agedTotal).not.toBe(t.ledgerReceivable);
  });

  test("the tie-out still holds at an earlier as-of date", async () => {
    const { a } = await messyCompany();
    const user = orgFor(a.company);
    const early = "2026-05-15";
    const ageing = (await call(`/ageing?companyId=${a.company._id}&asOf=${early}`, { user }))
      .body.report;
    const outstanding = (
      await call(`/outstanding?companyId=${a.company._id}&asOf=${early}`, { user })
    ).body.report;
    expect(ageing.reconciliation.reconciles).toBe(true);
    expect(ageing.totals.ledgerReceivable).toBe(outstanding.totals.receivable);
    expect(ageing.totals.ledgerCredit).toBe(outstanding.totals.customerCredit);
  });
});

/* ── Scope, isolation and transport ──────────────────────────────────────── */

describe("scope, isolation and transport", () => {
  async function twoCompanies() {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aCust = await makeCustomer(a, "Alpha Buyer");
    const bCust = await makeCustomer(b, "Beta Buyer");
    await invoice(a, aCust, { billName: "A-1", amount: 11000, dueDate: "2026-05-01" });
    await invoice(b, bCust, { billName: "B-1", amount: 999999, dueDate: "2026-05-01" });
    return { a, b, aCust, bCust };
  }

  test("Company A's ageing contains no Company B bill", async () => {
    const { a } = await twoCompanies();
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["A-1"]);
    expect(JSON.stringify(r.body)).not.toContain("999999");
    expect(JSON.stringify(r.body)).not.toContain("Beta Buyer");
  });

  test("a SPOOFED ledger id from another company is excluded", async () => {
    const { a, aCust, bCust } = await twoCompanies();
    const r = await call(
      q(a.company._id, `&scope=selected&ledgerIds=${aCust._id},${bCust._id}`),
      { user: orgFor(a.company) },
    );
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Alpha Buyer"]);
  });

  test("a supplier ledger cannot be aged through the customer door", async () => {
    const a = await seedCompany("Alpha");
    const supplier = await Acc_Ledger.create({
      companyId: a.company._id,
      name: "Alpha Supplier",
      groupId: a.creditors._id,
      groupName: a.creditors.name,
      nature: "liability",
    });
    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${supplier._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties).toEqual([]);
  });

  test("no companyId is a 400; another company is a 403", async () => {
    const { a, b } = await twoCompanies();
    expect((await call("/ageing", { user: orgFor(a.company) })).status).toBe(400);
    expect((await call(q(b.company._id), { user: orgFor(a.company) })).status).toBe(403);
  });

  test("a conflicting companyId in query and body is refused", async () => {
    const { a, b } = await twoCompanies();
    const r = await call(`/ageing?companyId=${a.company._id}`, {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id) },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("filtered exports exactly the ids it was given", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeCustomer(a, "Buyer One");
    const two = await makeCustomer(a, "Buyer Two");
    await invoice(a, one, { billName: "O-1", amount: 10000, dueDate: "2026-05-01" });
    await invoice(a, two, { billName: "T-1", amount: 20000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, `&scope=filtered&ledgerIds=${two._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Buyer Two"]);
    expect(r.body.report.totals.agedTotal).toBe(20000);
    expect(r.body.report.filterSummary).toMatch(/current filtered result \(1\)/);
  });

  test("an EMPTY filtered set ages nothing, and never widens to every customer", async () => {
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, "&scope=filtered&ledgerIds="), {
      user: orgFor(a.company),
    });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.parties).toEqual([]);
    expect(r.body.report.totals.agedTotal).toBe(0);
  });

  test("scope=filtered with the ledgerIds parameter missing is refused", async () => {
    const a = await seedCompany("Alpha");
    const r = await call(q(a.company._id, "&scope=filtered"), { user: orgFor(a.company) });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/must send the ledger ids/);
  });

  test("selected returns exactly the chosen customers", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeCustomer(a, "Buyer One");
    const two = await makeCustomer(a, "Buyer Two");
    await invoice(a, one, { billName: "O-1", amount: 10000, dueDate: "2026-05-01" });
    await invoice(a, two, { billName: "T-1", amount: 20000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${one._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Buyer One"]);
    expect(r.body.report.filterSummary).toMatch(/selected customers \(1\)/);
  });

  test("GET and POST produce equivalent reports", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeCustomer(a, "Buyer One");
    const two = await makeCustomer(a, "Buyer Two");
    await invoice(a, one, { billName: "O-1", amount: 10000, dueDate: "2026-05-01" });
    await invoice(a, two, { billName: "T-1", amount: 20000, dueDate: "2026-05-01" });
    const ids = [String(one._id), String(two._id)];

    const viaGet = await call(q(a.company._id, `&scope=filtered&ledgerIds=${ids.join(",")}`), {
      user: orgFor(a.company),
    });
    const viaPost = await call("/ageing", {
      user: orgFor(a.company),
      method: "POST",
      body: {
        companyId: String(a.company._id),
        asOf: AS_OF,
        scope: "filtered",
        ledgerIds: ids,
      },
    });

    expect(viaPost.status).toBe(200);
    const shape = (b) => {
      const { generatedAt, ...rest } = b.report;
      return rest;
    };
    expect(shape(viaPost.body)).toEqual(shape(viaGet.body));
  });

  test("the minimum applies to the AGED total and never suppresses a disclosure", async () => {
    const a = await seedCompany("Alpha");
    const big = await makeCustomer(a, "Big Buyer");
    const small = await makeCustomer(a, "Small Buyer");
    await invoice(a, big, { billName: "B-1", amount: 100000, dueDate: "2026-05-01" });
    await invoice(a, small, { billName: "S-1", amount: 400, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, "&minOutstanding=1000"), { user: orgFor(a.company) });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Big Buyer"]);
    expect(r.body.report.filterSummary).toMatch(/Minimum aged receivable/);
  });
});

/* ── Read-only ───────────────────────────────────────────────────────────── */

test("generating an ageing report changes nothing", async () => {
  const a = await seedCompany("Alpha");
  const c = await makeCustomer(a, "Acme Exports", {
    openingBalance: 5000,
    openingBalanceType: "Dr",
  });
  await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
  await settlement(a, c, { billName: "INV-1", amount: 40000, date: "2026-05-20" });

  const snapshot = async () => ({
    ledgers: await Acc_Ledger.find({}).lean(),
    vouchers: await Acc_Voucher.find({}).lean(),
    companies: await Acc_Company.find({}).lean(),
  });
  const before = await snapshot();

  await call(q(a.company._id), { user: orgFor(a.company) });
  await call(q(a.company._id, "&format=xlsx"), { user: orgFor(a.company), raw: true });
  await call(q(a.company._id, "&format=pdf"), { user: orgFor(a.company), raw: true });

  expect(JSON.stringify(await snapshot())).toBe(JSON.stringify(before));
});

/* ── The files ───────────────────────────────────────────────────────────── */

describe("Excel and PDF", () => {
  const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  async function reportFixture() {
    const a = await seedCompany("Alpha Textiles Pvt. Ltd.");
    const c = await makeCustomer(a, "Acme Exports", { gstin: "27AAAAA0000A1Z5" });
    const d = await makeCustomer(a, "Undated Buyer");
    await invoice(a, c, { billName: "INV-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, c, { billName: "INV-1", amount: 40000, date: "2026-05-20" });
    await invoice(a, d, { billName: "INV-2", amount: 25000, date: "2026-04-01" });
    return { a };
  }

  test("the ageing XLSX has both sheets, the buckets, and a reconciliation block", async () => {
    const { a } = await reportFixture();
    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-textiles-pvt-ltd-customer-ageing-as-on-2026-06-30.xlsx",
    );

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

    const ws = wb.getWorksheet("Ageing");
    expect(ws).toBeTruthy();
    expect(String(ws.getCell("A1").value)).toBe("Alpha Textiles Pvt. Ltd.");
    expect(String(ws.getCell("A2").value)).toContain("Customer Invoice-wise Ageing");
    expect(String(ws.getCell("A3").value)).toContain("As on:");
    expect(String(ws.getCell("A4").value)).toContain("Ageing: by due date");

    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((c) => ws.getCell(7, c).value)).toEqual([
      "Code",
      "Customer",
      "GSTIN",
      "Not yet due",
      "1–30 days",
      "31–60 days",
      "61–90 days",
      "90+ days",
      "Date unavailable",
      "Aged total",
    ]);

    // Acme sorts first (larger aged total). Amounts are NUMBERS.
    expect(ws.getCell(8, 2).value).toBe("Acme Exports");
    expect(typeof ws.getCell(8, 6).value).toBe("number");
    expect(ws.getCell(8, 6).value).toBe(60000); // 31-60 bucket
    expect(ws.getCell(9, 2).value).toBe("Undated Buyer");
    expect(ws.getCell(9, 9).value).toBe(25000); // Date unavailable

    expect(ws.getCell(10, 1).value).toBe("TOTAL");
    expect(ws.getCell(10, 10).value).toBe(85000);

    /* The tie-out is stated on the sheet, not left to the reader. Located by
     * scanning column A rather than by a hard-coded row: the assertion is
     * about the block being PRESENT and complete, and pinning it to a row
     * number makes an unrelated layout tweak look like a missing tie-out. */
    const colA = [];
    for (let r = 1; r <= 30; r += 1) colA.push(String(ws.getCell(r, 1).value || ""));
    expect(colA).toContain("RECONCILIATION");
    const recText = colA.slice(colA.indexOf("RECONCILIATION")).join(" | ");
    expect(recText).toMatch(/Aged receivables \(bucketed\)/);
    expect(recText).toMatch(/less bill credits/);
    expect(recText).toMatch(/unallocated debit/);
    expect(recText).toMatch(/Outstanding Summary/);
    expect(recText).toMatch(/Every customer reconciles/);

    const iws = wb.getWorksheet("Invoices");
    expect(iws).toBeTruthy();
    expect([1, 2, 3, 6, 7, 9, 11].map((c) => iws.getCell(7, c).value)).toEqual([
      "Code",
      "Customer",
      "Invoice / Ref",
      "Due Date",
      "Due Date From",
      "Outstanding",
      "Bucket",
    ]);
    const bills = [];
    for (let r = 8; r <= 20; r += 1) {
      const v = iws.getCell(r, 3).value;
      if (v && String(v) !== "TOTAL") bills.push(String(v));
    }
    expect(bills.sort()).toEqual(["INV-1", "INV-2"]);
  });

  test("the detail tab is called 'Invoices' and dates are worded for an INVOICE", async () => {
    /* The workbook writer is shared with the supplier ageing. These two
     * strings are the ones that would drift if it stopped reading the report's
     * labels: a customer sheet must never say "Bills" or "Bill + credit
     * days". The supplier suite asserts the mirror. */
    const a = await seedCompany("Alpha");
    const c = await makeCustomer(a, "Acme Exports");
    // creditDays, so the derived wording is actually exercised.
    await invoice(a, c, { billName: "INV-1", amount: 100000, date: "2026-04-01", creditDays: 45 });

    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

    expect(wb.worksheets.map((w) => w.name)).toEqual(["Ageing", "Invoices"]);
    expect(wb.getWorksheet("Bills")).toBeUndefined();

    const iws = wb.getWorksheet("Invoices");
    expect([3, 5, 7, 8].map((cc) => iws.getCell(7, cc).value)).toEqual([
      "Invoice / Ref",
      "Invoice Date",
      "Due Date From",
      "Invoice Amount",
    ]);
    expect(iws.getCell(8, 7).value).toBe("Invoice + credit days");
    expect(String(wb.getWorksheet("Ageing").getCell("A2").value)).toContain(
      "Customer Invoice-wise Ageing",
    );
  });

  test("the invoice sheet names where each due date came from", async () => {
    const { a } = await reportFixture();
    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const iws = wb.getWorksheet("Invoices");
    const sources = [];
    for (let r = 8; r <= 20; r += 1) {
      const bill = iws.getCell(r, 3).value;
      if (!bill || String(bill) === "TOTAL") continue;
      sources.push(String(iws.getCell(r, 7).value));
    }
    expect(sources.sort()).toEqual(["Bill allocation", "Not available"]);
  });

  test("the ageing PDF renders with a dated filename", async () => {
    const { a } = await reportFixture();
    const res = await call(q(a.company._id, "&format=pdf"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      "customer-ageing-as-on-2026-06-30.pdf",
    );
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  });

  test("a 200-customer ageing PDF paginates", async () => {
    const a = await seedCompany("Alpha");
    for (let i = 0; i < 200; i += 1) {
      const c = await makeCustomer(a, `Buyer ${String(i).padStart(3, "0")}`, {
        openingBalance: 1000 + i,
        openingBalanceType: "Dr",
      });
      await invoice(a, c, { billName: `B-${i}`, amount: 1000 + i, dueDate: "2026-05-01" });
    }
    const res = await call(q(a.company._id, "&format=pdf"), {
      user: orgFor(a.company),
      raw: true,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.toString("latin1")).toMatch(/\/Count\s+[2-9]/);
  });

  test("an unknown format is refused", async () => {
    const a = await seedCompany("Alpha");
    const r = await call(q(a.company._id, "&format=csv"), { user: orgFor(a.company) });
    expect(r.status).toBe(400);
  });
});
