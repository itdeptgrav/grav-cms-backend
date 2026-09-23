// test/accountant/supplier-ageing.route.test.js
//
// Lane B, Chunk 4 — Supplier Invoice-wise Ageing, over real collections.
//
// What this file exists to prove that the pure tests cannot:
//   • A partial payment, several payments and a debit note each reduce the
//     bill they are allocated against — through real `billAllocations` on real
//     vouchers, not hand-built fold objects.
//   • Overpaying a bill becomes a bill advance, not a negative payable.
//   • Future-dated, unposted and optional vouchers neither settle a bill nor
//     raise one.
//   • Undated bills are disclosed as undated, not aged from the bill date.
//   • Opening balances and on-account payments surface as unallocated.
//   • THE TIE-OUT: aged − bill advances + unallocated = the ledger, and the
//     report's clamped totals equal the Supplier Outstanding Summary's
//     `payable` and `supplierAdvance` for the same company and date.
//   • Cross-company ids, a customer ledger smuggled in, the three scopes and
//     GET/POST equivalence.
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
    "/api/accountant/vendors/reports",
    require("../../routes/Accountant_Routes/Acc_vendorReports"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/vendors/reports`;
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
  const creditors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Creditors",
    nature: "liability",
  });
  const sub = await Acc_Group.create({
    companyId: company._id,
    name: "Fabric Suppliers",
    parent: creditors._id,
    parentName: creditors.name,
    nature: "liability",
  });
  const debtors = await Acc_Group.create({
    companyId: company._id,
    name: "Sundry Debtors",
    nature: "asset",
  });
  const purchaseGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Purchase Accounts",
    nature: "expense",
  });
  const purchases = await Acc_Ledger.create({
    companyId: company._id,
    name: `${name} Purchases`,
    groupId: purchaseGroup._id,
    groupName: purchaseGroup.name,
    nature: "expense",
  });
  return { company, creditors, sub, debtors, purchases };
}

async function makeSupplier(fx, name, opts = {}) {
  return Acc_Ledger.create({
    companyId: fx.company._id,
    name,
    groupId: opts.group ? opts.group._id : fx.creditors._id,
    groupName: opts.group ? opts.group.name : fx.creditors.name,
    nature: "liability",
    gstin: opts.gstin,
    openingBalance: opts.openingBalance || 0,
    openingBalanceType: opts.openingBalanceType || "Cr",
  });
}

/**
 * A purchase bill: CREDITS the supplier, with a `new_ref` allocation that
 * establishes the bill and carries its due date.
 */
async function purchaseBill(fx, party, o = {}) {
  const amount = o.amount ?? 118000;
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: "purchase",
    voucherTypeName: o.voucherTypeName || "Purchase Bill",
    voucherNumber: o.billName || `PB-${Math.random().toString(36).slice(2, 8)}`,
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
        type: "Cr",
        amount,
        billAllocations: [
          {
            billName: o.billName || "PB-1",
            billType: "new_ref",
            amount,
            ...(o.dueDate ? { dueDate: new Date(o.dueDate) } : {}),
            ...(o.creditDays ? { creditDays: o.creditDays } : {}),
          },
        ],
      },
      { ledgerId: fx.purchases._id, ledgerName: fx.purchases.name, type: "Dr", amount },
    ],
  });
}

/** A payment or debit note: DEBITS the supplier against a named bill. */
async function settlement(fx, party, o = {}) {
  const amount = o.amount ?? 50000;
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: o.voucherType || "payment",
    voucherTypeName: o.voucherTypeName,
    voucherNumber: o.voucherNumber || `PAY-${Math.random().toString(36).slice(2, 8)}`,
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
        type: "Dr",
        amount,
        billAllocations: [
          { billName: o.billName || "PB-1", billType: o.billType || "agst_ref", amount },
        ],
      },
      { ledgerId: fx.purchases._id, ledgerName: fx.purchases.name, type: "Cr", amount },
    ],
  });
}

/** Money paid with no bill named — an on-account advance to the supplier. */
async function onAccount(fx, party, o = {}) {
  const amount = o.amount ?? 50000;
  return Acc_Voucher.create({
    companyId: fx.company._id,
    voucherType: "payment",
    voucherNumber: o.voucherNumber || `ADV-${Math.random().toString(36).slice(2, 8)}`,
    voucherDate: new Date(o.date || "2026-05-01"),
    partyLedgerId: party._id,
    partyLedgerName: party.name,
    status: "posted",
    grandTotal: amount,
    ledgerEntries: [
      { ledgerId: party._id, ledgerName: party.name, type: "Dr", amount, billAllocations: [] },
      { ledgerId: fx.purchases._id, ledgerName: fx.purchases.name, type: "Cr", amount },
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

/* ── What each document does to the bill ─────────────────────────────────── */

describe("payments, debit notes and overpayment", () => {
  test("an unpaid purchase bill ages at its full value, as a POSITIVE payable", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.status).toBe(200);
    expect(r.body.report.rows).toHaveLength(1);
    expect(r.body.report.rows[0].remaining).toBe(118000);
    expect(r.body.report.rows[0].bucket).toBe("d31_60");
    expect(party0(r).buckets.d31_60).toBe(118000);
    expect(party0(r).agedTotal).toBe(118000);
  });

  test("a PARTIAL payment reduces the bill, and the bill value is still shown", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 50000, date: "2026-05-20" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.remaining).toBe(68000);
    expect(row.originalAmount).toBe(118000);
  });

  test("SEVERAL payments against one bill all reduce it", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 30000, date: "2026-05-10" });
    await settlement(a, s, { billName: "PB-1", amount: 45000, date: "2026-06-10" });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.remaining).toBe(43000);
  });

  test("a DEBIT NOTE reduces the bill the same way a payment does", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, {
      billName: "PB-1",
      amount: 18000,
      voucherType: "debit_note",
      date: "2026-05-15",
    });

    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.remaining).toBe(100000);
  });

  test("a FULLY settled bill disappears from the ageing", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 118000, date: "2026-05-20" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(r.body.report.parties).toEqual([]);
    expect(r.body.report.totals.agedTotal).toBe(0);
  });

  test("OVERPAYING a bill becomes a bill advance, not a negative bucket", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 100000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 130000, date: "2026-05-20" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(party0(r).billAdvances).toBe(30000);
    expect(party0(r).agedTotal).toBe(0);
    for (const k of Object.keys(party0(r).buckets)) {
      expect(party0(r).buckets[k]).toBe(0);
    }
    expect(party0(r).reconciles).toBe(true);
  });

  test("two bills settle independently — one paid, one open", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 100000, dueDate: "2026-05-01" });
    await purchaseBill(a, s, {
      billName: "PB-2",
      amount: 60000,
      dueDate: "2026-06-20",
      date: "2026-05-20",
    });
    await settlement(a, s, { billName: "PB-1", amount: 100000, date: "2026-05-25" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["PB-2"]);
    expect(party0(r).buckets.d1_30).toBe(60000);
  });
});

/* ── Which vouchers count ────────────────────────────────────────────────── */

describe("only posted, non-optional vouchers through the as-of date", () => {
  test("a payment made AFTER the as-of date does not settle the bill", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 118000, date: "2026-07-15" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows[0].remaining).toBe(118000);
    expect(party0(r).reconciles).toBe(true);
  });

  test("a FUTURE-dated bill is not aged, even with no asOf supplied", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await purchaseBill(a, s, { billName: "PB-FUTURE", amount: 9000000, date: "2099-01-01" });

    const r = await call(`/ageing?companyId=${a.company._id}`, { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["PB-1"]);
    expect(JSON.stringify(r.body)).not.toContain("9000000");
    expect(r.body.report.asOf).toBeTruthy();
  });

  test("draft, pending, cancelled, void and optional documents are all ignored", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    for (const status of ["draft", "pending_approval", "cancelled", "void"]) {
      await settlement(a, s, { billName: "PB-1", amount: 25000, status, date: "2026-05-10" });
      await purchaseBill(a, s, { billName: `PB-${status}`, amount: 777, status, date: "2026-04-05" });
    }
    await settlement(a, s, { billName: "PB-1", amount: 25000, isOptional: true, date: "2026-05-10" });
    await purchaseBill(a, s, { billName: "PB-OPT", amount: 777, isOptional: true, date: "2026-04-05" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["PB-1"]);
    expect(r.body.report.rows[0].remaining).toBe(118000);
  });
});

/* ── Due dates ───────────────────────────────────────────────────────────── */

describe("due-date precedence and boundaries", () => {
  test("the allocation's due date wins, and its source is recorded", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, {
      billName: "PB-1",
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
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", headerDueDate: "2026-06-01" });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.dueDateSource).toBe("voucher");
    expect(row.bucket).toBe("d1_30");
  });

  test("bill date plus EXPLICIT credit days is the third choice", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", date: "2026-04-01", creditDays: 45 });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.dueDateSource).toBe("creditDays");
    expect(row.bucket).toBe("d31_60");
  });

  test("a bill with NO date anywhere is 'Date unavailable', not aged from its bill date", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, date: "2026-04-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    const row = r.body.report.rows[0];
    expect(row.bucket).toBe("unknown");
    expect(row.dueDate).toBeNull();
    expect(row.daysOverdue).toBeNull();
    expect(party0(r).buckets.unknown).toBe(118000);
    expect(party0(r).buckets.d61_90).toBe(0);
    expect(r.body.report.totals.undatedBillCount).toBe(1);
  });

  test("the ledger's own credit period is NOT used to date a bill", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await Acc_Ledger.updateOne({ _id: s._id }, { $set: { creditPeriodDays: 30 } });
    await purchaseBill(a, s, { billName: "PB-1", date: "2026-04-01" });
    const row = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows[0];
    expect(row.bucket).toBe("unknown");
  });

  test("every bucket boundary falls on the documented side", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    const cases = [
      ["2026-07-15", "notYetDue"],
      ["2026-06-30", "notYetDue"], // due ON the as-of date is not overdue
      ["2026-06-29", "d1_30"],
      ["2026-05-31", "d1_30"], // 30 days
      ["2026-05-30", "d31_60"], // 31 days
      ["2026-05-01", "d31_60"], // 60 days
      ["2026-04-30", "d61_90"], // 61 days
      ["2026-04-01", "d61_90"], // 90 days
      ["2026-03-31", "d90plus"], // 91 days
    ];
    for (const [due, , ] of cases) {
      await purchaseBill(a, s, {
        billName: `PB-${due}`,
        amount: 1000,
        date: "2026-01-01",
        dueDate: due,
      });
    }
    const rows = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.rows;
    const byBill = new Map(rows.map((x) => [x.billName, x.bucket]));
    for (const [due, bucket] of cases) {
      expect(byBill.get(`PB-${due}`)).toBe(bucket);
    }
  });

  test("a settled bill keeps its due date whatever order the allocation rows return in", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 10000, date: "2026-05-10" });
    await settlement(a, s, { billName: "PB-1", amount: 10000, date: "2026-05-11" });
    await settlement(a, s, { billName: "PB-1", amount: 20000, date: "2026-05-12" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows[0].dueDateSource).toBe("allocation");
    expect(r.body.report.rows[0].bucket).toBe("d31_60");
    expect(party0(r).buckets.unknown).toBe(0);
  });
});

/* ── Unallocated balances ────────────────────────────────────────────────── */

describe("unallocated balances are disclosed, never aged and never netted", () => {
  test("an OPENING Cr balance no bill explains surfaces as an unallocated payable", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics", {
      openingBalance: 30000,
      openingBalanceType: "Cr",
    });
    await purchaseBill(a, s, { billName: "PB-1", amount: 50000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(party0(r).agedTotal).toBe(50000);
    expect(party0(r).unallocatedPayable).toBe(30000);
    expect(party0(r).ledgerBalance).toBe(80000);
    expect(party0(r).ledgerBalanceType).toBe("Cr");
    expect(party0(r).reconciles).toBe(true);
  });

  test("an ON-ACCOUNT payment is an unallocated advance and does not reduce a bucket", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 100000, dueDate: "2026-05-01" });
    await onAccount(a, s, { amount: 300000, date: "2026-05-10" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(party0(r).buckets.d31_60).toBe(100000);
    expect(party0(r).agedTotal).toBe(100000);
    expect(party0(r).unallocatedAdvance).toBe(300000);
    expect(party0(r).unallocatedPayable).toBe(0);
    expect(party0(r).ledgerBalanceType).toBe("Dr");
    expect(party0(r).reconciles).toBe(true);
    expect(r.body.report.totals.ledgerAdvance).toBe(200000);
    expect(r.body.report.totals.ledgerPayable).toBe(0);
  });

  test("a supplier wholly in advance appears with no aged rows", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Prepaid Supplier");
    await onAccount(a, s, { amount: 75000, date: "2026-05-10" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows).toEqual([]);
    expect(party0(r).unallocatedAdvance).toBe(75000);
    expect(r.body.report.totals.ledgerAdvance).toBe(75000);
  });
});

/* ── THE TIE-OUT ─────────────────────────────────────────────────────────── */

describe("reconciliation to the Supplier Outstanding Summary", () => {
  async function messyCompany() {
    const a = await seedCompany("Alpha");
    const plain = await makeSupplier(a, "Plain Supplier");
    const partial = await makeSupplier(a, "Partly Paid Supplier");
    const opening = await makeSupplier(a, "Opening Balance Supplier", {
      openingBalance: 33000,
      openingBalanceType: "Cr",
    });
    const advance = await makeSupplier(a, "On Account Supplier");
    const over = await makeSupplier(a, "Over Paid Supplier");
    const undated = await makeSupplier(a, "Undated Supplier", { group: a.sub });

    await purchaseBill(a, plain, { billName: "P-1", amount: 100000, dueDate: "2026-05-01" });
    await purchaseBill(a, partial, { billName: "Q-1", amount: 80000, dueDate: "2026-06-25" });
    await settlement(a, partial, { billName: "Q-1", amount: 30000, date: "2026-06-26" });
    await purchaseBill(a, opening, { billName: "R-1", amount: 20000, dueDate: "2026-03-01" });
    await purchaseBill(a, advance, { billName: "S-1", amount: 60000, dueDate: "2026-05-01" });
    await onAccount(a, advance, { amount: 90000, date: "2026-05-05" });
    await purchaseBill(a, over, { billName: "T-1", amount: 40000, dueDate: "2026-05-01" });
    await settlement(a, over, { billName: "T-1", amount: 55000, date: "2026-05-20" });
    await purchaseBill(a, undated, { billName: "U-1", amount: 25000, date: "2026-04-01" });

    return { a };
  }

  test("every supplier reconciles: aged − bill advances + unallocated = ledger", async () => {
    const { a } = await messyCompany();
    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.reconciliation.reconciles).toBe(true);
    expect(r.body.report.reconciliation.partiesOutOfBalance).toEqual([]);

    for (const p of r.body.report.parties) {
      expect(
        Math.abs(p.agedTotal - p.billAdvances + p.unallocatedSigned - p.ledgerOwed),
      ).toBeLessThan(0.02);
    }
  });

  test("the ageing's clamped totals EQUAL the Supplier Outstanding Summary's", async () => {
    const { a } = await messyCompany();
    const user = orgFor(a.company);
    const ageing = (await call(q(a.company._id), { user })).body.report;
    const outstanding = (
      await call(`/outstanding?companyId=${a.company._id}&asOf=${AS_OF}`, { user })
    ).body.report;

    expect(ageing.totals.ledgerPayable).toBe(outstanding.totals.payable);
    expect(ageing.totals.ledgerAdvance).toBe(outstanding.totals.supplierAdvance);
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
      if (o.balanceType === "Cr") expect(p.ledgerOwed).toBe(o.payable);
    }
  });

  test("the buckets sum to the aged total, and the aged total is not the ledger total", async () => {
    const { a } = await messyCompany();
    const t = (await call(q(a.company._id), { user: orgFor(a.company) })).body.report.totals;
    const summed = Object.values(t.buckets).reduce((s, v) => s + v, 0);
    expect(Math.abs(summed - t.agedTotal)).toBeLessThan(0.02);
    expect(t.agedTotal).not.toBe(t.ledgerPayable);
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
    expect(ageing.totals.ledgerPayable).toBe(outstanding.totals.payable);
    expect(ageing.totals.ledgerAdvance).toBe(outstanding.totals.supplierAdvance);
  });
});

/* ── Scope, isolation and transport ──────────────────────────────────────── */

describe("scope, isolation and transport", () => {
  test("Company A's ageing contains no Company B bill", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSup = await makeSupplier(a, "Alpha Supplier");
    const bSup = await makeSupplier(b, "Beta Supplier");
    await purchaseBill(a, aSup, { billName: "A-1", amount: 11000, dueDate: "2026-05-01" });
    await purchaseBill(b, bSup, { billName: "B-1", amount: 999999, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id), { user: orgFor(a.company) });
    expect(r.body.report.rows.map((x) => x.billName)).toEqual(["A-1"]);
    expect(JSON.stringify(r.body)).not.toContain("999999");
    expect(JSON.stringify(r.body)).not.toContain("Beta Supplier");
  });

  test("a SPOOFED ledger id from another company is excluded", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const aSup = await makeSupplier(a, "Alpha Supplier");
    const bSup = await makeSupplier(b, "Beta Supplier");
    await purchaseBill(a, aSup, { billName: "A-1", amount: 11000, dueDate: "2026-05-01" });
    await purchaseBill(b, bSup, { billName: "B-1", amount: 999999, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${aSup._id},${bSup._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Alpha Supplier"]);
  });

  test("a CUSTOMER ledger cannot be aged through the supplier door", async () => {
    const a = await seedCompany("Alpha");
    const sup = await makeSupplier(a, "Alpha Supplier");
    await purchaseBill(a, sup, { billName: "A-1", amount: 11000, dueDate: "2026-05-01" });
    const cust = await Acc_Ledger.create({
      companyId: a.company._id,
      name: "Alpha Buyer",
      groupId: a.debtors._id,
      groupName: a.debtors.name,
      nature: "asset",
    });
    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${sup._id},${cust._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Alpha Supplier"]);
  });

  test("no companyId is a 400; another company is a 403", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    expect((await call("/ageing", { user: orgFor(a.company) })).status).toBe(400);
    expect((await call(q(b.company._id), { user: orgFor(a.company) })).status).toBe(403);
  });

  test("a conflicting companyId in query and body is refused", async () => {
    const a = await seedCompany("Alpha");
    const b = await seedCompany("Beta");
    const r = await call(`/ageing?companyId=${a.company._id}`, {
      user: orgFor(a.company),
      method: "POST",
      body: { companyId: String(b.company._id) },
    });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("COMPANY_SCOPE_CONFLICT");
  });

  test("filtered ages exactly the ids it was given, sub-grouped suppliers included", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeSupplier(a, "Supplier One");
    const two = await makeSupplier(a, "Supplier Two", { group: a.sub });
    await purchaseBill(a, one, { billName: "O-1", amount: 10000, dueDate: "2026-05-01" });
    await purchaseBill(a, two, { billName: "T-1", amount: 20000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, `&scope=filtered&ledgerIds=${two._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Supplier Two"]);
    expect(r.body.report.totals.agedTotal).toBe(20000);
    expect(r.body.report.filterSummary).toMatch(/current filtered result \(1\)/);
  });

  test("an EMPTY filtered set ages nothing, and never widens to every supplier", async () => {
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });

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

  test("selected ages exactly the chosen suppliers", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeSupplier(a, "Supplier One");
    const two = await makeSupplier(a, "Supplier Two");
    await purchaseBill(a, one, { billName: "O-1", amount: 10000, dueDate: "2026-05-01" });
    await purchaseBill(a, two, { billName: "T-1", amount: 20000, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, `&scope=selected&ledgerIds=${one._id}`), {
      user: orgFor(a.company),
    });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Supplier One"]);
    expect(r.body.report.filterSummary).toMatch(/selected suppliers \(1\)/);
  });

  test("GET and POST produce equivalent reports", async () => {
    const a = await seedCompany("Alpha");
    const one = await makeSupplier(a, "Supplier One");
    const two = await makeSupplier(a, "Supplier Two");
    await purchaseBill(a, one, { billName: "O-1", amount: 10000, dueDate: "2026-05-01" });
    await purchaseBill(a, two, { billName: "T-1", amount: 20000, dueDate: "2026-05-01" });
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

  test("the minimum applies to the AGED payable", async () => {
    const a = await seedCompany("Alpha");
    const big = await makeSupplier(a, "Big Supplier");
    const small = await makeSupplier(a, "Small Supplier");
    await purchaseBill(a, big, { billName: "B-1", amount: 100000, dueDate: "2026-05-01" });
    await purchaseBill(a, small, { billName: "S-1", amount: 400, dueDate: "2026-05-01" });

    const r = await call(q(a.company._id, "&minOutstanding=1000"), { user: orgFor(a.company) });
    expect(r.body.report.parties.map((p) => p.name)).toEqual(["Big Supplier"]);
    expect(r.body.report.filterSummary).toMatch(/Minimum aged payable/);
  });
});

/* ── Read-only ───────────────────────────────────────────────────────────── */

test("generating a supplier ageing report changes nothing", async () => {
  const a = await seedCompany("Alpha");
  const s = await makeSupplier(a, "Northline Fabrics", {
    openingBalance: 5000,
    openingBalanceType: "Cr",
  });
  await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
  await settlement(a, s, { billName: "PB-1", amount: 50000, date: "2026-05-20" });

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
    const s = await makeSupplier(a, "Northline Fabrics", { gstin: "27BBBBB0000B1Z5" });
    const d = await makeSupplier(a, "Undated Supplier");
    await purchaseBill(a, s, { billName: "PB-1", amount: 118000, dueDate: "2026-05-01" });
    await settlement(a, s, { billName: "PB-1", amount: 50000, date: "2026-05-20" });
    await purchaseBill(a, d, { billName: "PB-2", amount: 25000, date: "2026-04-01" });
    return { a };
  }

  test("the ageing XLSX has both sheets, supplier headings and a reconciliation block", async () => {
    const { a } = await reportFixture();
    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_TYPE);
    expect(res.headers.get("content-disposition")).toContain(
      "alpha-textiles-pvt-ltd-supplier-ageing-as-on-2026-06-30.xlsx",
    );

    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

    const ws = wb.getWorksheet("Ageing");
    expect(ws).toBeTruthy();
    expect(String(ws.getCell("A1").value)).toBe("Alpha Textiles Pvt. Ltd.");
    expect(String(ws.getCell("A2").value)).toContain("Supplier Invoice-wise Ageing");
    expect(String(ws.getCell("A3").value)).toContain("As on:");
    expect(String(ws.getCell("A4").value)).toContain("Ageing: by due date");

    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((c) => ws.getCell(7, c).value)).toEqual([
      "Code",
      "Supplier",
      "GSTIN",
      "Not yet due",
      "1–30 days",
      "31–60 days",
      "61–90 days",
      "90+ days",
      "Date unavailable",
      "Aged total",
      "Bill advances",
      "Unallocated payable",
      "Unallocated advance",
    ]);

    // Northline sorts first (larger aged total). Amounts are NUMBERS.
    expect(ws.getCell(8, 2).value).toBe("Northline Fabrics");
    expect(typeof ws.getCell(8, 6).value).toBe("number");
    expect(ws.getCell(8, 6).value).toBe(68000); // 31-60 bucket, payable positive
    expect(ws.getCell(9, 2).value).toBe("Undated Supplier");
    expect(ws.getCell(9, 9).value).toBe(25000); // Date unavailable

    expect(ws.getCell(10, 1).value).toBe("TOTAL");
    expect(ws.getCell(10, 10).value).toBe(93000);
    expect(String(ws.getCell(10, 2).value)).toMatch(/2 suppliers · 2 open bills/);

    const colA = [];
    for (let r = 1; r <= 30; r += 1) colA.push(String(ws.getCell(r, 1).value || ""));
    expect(colA).toContain("RECONCILIATION");
    const recText = colA.slice(colA.indexOf("RECONCILIATION")).join(" | ");
    expect(recText).toMatch(/Aged payables \(bucketed\)/);
    expect(recText).toMatch(/less bill advances/);
    expect(recText).toMatch(/unallocated payable/);
    expect(recText).toMatch(/Supplier Outstanding Summary/);
    expect(recText).toMatch(/Every supplier reconciles/);
    expect(recText).not.toMatch(/receivable/i);
  });

  test("the invoice sheet uses bill wording and names the due-date source", async () => {
    const { a } = await reportFixture();
    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    const iws = wb.getWorksheet("Bills");
    expect(iws).toBeTruthy();
    expect([1, 2, 3, 5, 6, 7, 8, 9, 11].map((c) => iws.getCell(7, c).value)).toEqual([
      "Code",
      "Supplier",
      "Bill / Ref",
      "Bill Date",
      "Due Date",
      "Due Date From",
      "Bill Amount",
      "Outstanding",
      "Bucket",
    ]);

    const rows = [];
    for (let r = 8; r <= 20; r += 1) {
      const v = iws.getCell(r, 3).value;
      if (!v || String(v) === "TOTAL") continue;
      rows.push({ bill: String(v), source: String(iws.getCell(r, 7).value), out: iws.getCell(r, 9).value });
    }
    expect(rows.map((x) => x.bill).sort()).toEqual(["PB-1", "PB-2"]);
    expect(rows.map((x) => x.source).sort()).toEqual(["Bill allocation", "Not available"]);
    expect(rows.find((x) => x.bill === "PB-1").out).toBe(68000);
  });

  test("the detail tab is called 'Bills' and dates are worded for a BILL", async () => {
    /* The mirror of the customer assertion. The workbook writer is shared, so
     * these two strings are exactly where a supplier sheet would inherit the
     * customer's vocabulary. */
    const a = await seedCompany("Alpha");
    const s = await makeSupplier(a, "Northline Fabrics");
    await purchaseBill(a, s, {
      billName: "PB-1",
      amount: 118000,
      date: "2026-04-01",
      creditDays: 45,
    });

    const res = await call(q(a.company._id, "&format=xlsx"), {
      user: orgFor(a.company),
      raw: true,
    });
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));

    expect(wb.worksheets.map((w) => w.name)).toEqual(["Ageing", "Bills"]);
    expect(wb.getWorksheet("Invoices")).toBeUndefined();

    const iws = wb.getWorksheet("Bills");
    expect([3, 5, 7, 8].map((cc) => iws.getCell(7, cc).value)).toEqual([
      "Bill / Ref",
      "Bill Date",
      "Due Date From",
      "Bill Amount",
    ]);
    expect(iws.getCell(8, 7).value).toBe("Bill + credit days");
    expect(iws.getCell(8, 7).value).not.toMatch(/Invoice/);
    expect(String(wb.getWorksheet("Ageing").getCell("A2").value)).toContain(
      "Supplier Invoice-wise Ageing",
    );
  });

  test("the ageing PDF renders with a dated filename", async () => {
    const { a } = await reportFixture();
    const res = await call(q(a.company._id, "&format=pdf"), {
      user: orgFor(a.company),
      raw: true,
    });
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toContain(
      "supplier-ageing-as-on-2026-06-30.pdf",
    );
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.slice(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(1000);
  });

  test("a 200-supplier ageing PDF paginates", async () => {
    const a = await seedCompany("Alpha");
    for (let i = 0; i < 200; i += 1) {
      const s = await makeSupplier(a, `Supplier ${String(i).padStart(3, "0")}`);
      await purchaseBill(a, s, {
        billName: `B-${i}`,
        amount: 1000 + i,
        dueDate: "2026-05-01",
      });
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
