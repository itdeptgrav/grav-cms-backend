// test/accountant/budget-tracker.route.test.js
//
// The department budget TRACKER: approved against actually spent.
//
// This endpoint is the first thing in the department app that reads posted
// vouchers, so most of this file is about the boundary rather than the
// arithmetic (services/budgetTracker.test.js covers that). What must hold:
//
//   - an unmapped caller gets nothing, never everything;
//   - a mapped caller sees ONLY their own department's heads, and never
//     another department's name — even inside the same budget document;
//   - a draft or collecting round is not tracked, because nobody approved it;
//   - "spent" means posted vouchers, and nothing else.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");

let server;
let base;
let seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/budget-proposals`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = ({ deptSlug, email = "head@demo.example", isAdmin = false } = {}) =>
  jwt.sign(
    { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug, email, name: "Dept Head", isAdmin },
    SECRET,
    { expiresIn: "1h" },
  );

async function call(path, { token } = {}) {
  const res = await fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

async function seed() {
  const company = await Acc_Company.create({
    companyName: `Tracker Co ${seq++}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const revGroup = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const freight = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding",
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const secret = await Acc_Ledger.create({
    companyId: company._id, name: "Executive Travel",
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const sales = await Acc_Ledger.create({
    companyId: company._id, name: "Export Sales",
    groupId: revGroup._id, groupName: revGroup.name, nature: "revenue",
  });
  return { company, freight, secret, sales };
}

const link = (company, { name, accessSlug }) =>
  Acc_BudgetDepartment.create({
    companyId: company._id,
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    name, accessSlug,
  });

const budget = (company, items, over = {}) =>
  Acc_Budget.create({
    name: "FY26-27 Operating", financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END,
    companyId: company._id, items, ...over,
  });

/** A posted voucher moving `amount` onto `ledger` as a debit. */
const spend = (company, ledger, amount, when = "2026-05-10", over = {}) =>
  Acc_Voucher.create({
    companyId: company._id,
    voucherType: "payment",
    voucherNumber: `PV-${seq++}`,
    voucherDate: new Date(when),
    status: "posted",
    ledgerEntries: [
      { ledgerId: ledger._id, ledgerName: ledger.name, type: "Dr", amount },
      { ledgerId: ledger._id, ledgerName: ledger.name, type: "Cr", amount: 0 },
    ],
    grandTotal: amount,
    ...over,
  });

/* ═══ THE BOUNDARY ═════════════════════════════════════════════════════════ */

describe("scoping", () => {
  test("no token is refused", async () => {
    const { company } = await seed();
    expect((await call(`/tracker?companyId=${company._id}`)).status).toBe(401);
  });

  test("an unmapped portal gets nothing, not everything", async () => {
    const { company, freight } = await seed();
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
    ]);
    const { status, body } = await call(`/tracker?companyId=${company._id}`, {
      token: tokenFor({ deptSlug: "sales" }),
    });
    expect(status).toBe(200);
    expect(body.heads).toEqual([]);
    expect(body.totals).toBeNull();
  });

  test("a valid token with no deptSlug is not a wildcard", async () => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
    ]);
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "" }) });
    expect(body.heads).toEqual([]);
  });

  test("another department's lines in the SAME budget are never returned", async () => {
    const { company, freight, secret } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
      { ledgerId: secret._id, ledgerName: secret.name, nature: "expense", department: "Board", allocatedAmount: 9000000 },
    ]);
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });

    expect(body.heads).toHaveLength(1);
    expect(body.heads[0].ledgerName).toBe("Freight & Forwarding");
    // and no trace of the other department anywhere in the payload
    const dump = JSON.stringify(body);
    expect(dump).not.toContain("Executive Travel");
    expect(dump).not.toContain("Board");
    expect(body.totals.expense.approved).toBe(1000000);
  });

  test("a department spelled three ways is one department", async () => {
    const { company, freight, sales } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 400000 },
      { ledgerId: sales._id, ledgerName: sales.name, nature: "revenue", department: "logistics", allocatedAmount: 700000 },
    ]);
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads).toHaveLength(2);
  });
});

/* ═══ WHAT COUNTS AS APPROVED ══════════════════════════════════════════════ */

describe("only approved budgets are tracked", () => {
  test.each(["draft", "collecting", "review"])("a %s round is not tracked", async (status) => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
    ], { status });
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads).toEqual([]);
  });

  test("an active budget IS tracked", async () => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
    ]);
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads).toHaveLength(1);
    expect(body.heads[0].approved).toBe(1000000);
  });
});

/* ═══ WHAT COUNTS AS SPENT ═════════════════════════════════════════════════ */

describe("spent means posted vouchers", () => {
  test("a posted voucher lands on the head and in the month it was dated", async () => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1200000 },
    ]);
    await spend(company, freight, 300000, "2026-05-10");

    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads[0].actual).toBe(300000);
    expect(body.totals.expense.actual).toBe(300000);
    expect(body.heads[0].remaining).toBe(900000);

    const may = body.months.expense.find((m) => m.key === "2026-05");
    expect(may.actual).toBe(300000);
    expect(Math.round(may.planned)).toBe(100000); // even spread of 12,00,000
  });

  test("a draft voucher is not money and is not counted", async () => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1200000 },
    ]);
    await spend(company, freight, 500000, "2026-05-10", { status: "draft" });
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads[0].actual).toBe(0);
  });

  test("Tally's optional planning voucher is not achievement", async () => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 1200000 },
    ]);
    await spend(company, freight, 500000, "2026-05-10", { isOptional: true });
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads[0].actual).toBe(0);
  });

  test("overspend is reported as a negative remaining, not clamped", async () => {
    const { company, freight } = await seed();
    await link(company, { name: "Logistics", accessSlug: "sales" });
    await budget(company, [
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: 100000 },
    ]);
    await spend(company, freight, 130000, "2026-05-10");
    const { body } = await call(`/tracker?companyId=${company._id}`, { token: tokenFor({ deptSlug: "sales" }) });
    expect(body.heads[0].actual).toBe(130000);
    expect(body.heads[0].remaining).toBe(-30000);
    expect(body.totals.expense.remaining).toBe(-30000);
  });
});
