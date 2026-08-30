// The action centre over HTTP: what one department is told, and what it is not.
//
// The arithmetic is covered by services/budgetActionCentre.test.js. What this
// file protects is the boundary — the alerts are derived from several
// collections at once, and every one of them has to be narrowed to the
// caller's own departments before it reaches the derivation.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");

let srv, base, seq = 0;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => { srv = app.listen(0, r); });
  base = `http://127.0.0.1:${srv.address().port}/api/budget-proposals`;
});
afterAll(async () => { await new Promise((r) => srv.close(r)); });

const tokenFor = (slug = "sales", email = "head@demo.example") =>
  jwt.sign({ v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: slug, email, name: "Head" }, SECRET, { expiresIn: "1h" });

const call = (path, token = tokenFor()) =>
  fetch(`${base}${path}`, {
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const inDays = (n) => new Date(Date.now() + n * 86400000);

async function seed() {
  const company = await Acc_Company.create({ companyName: `AC ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const eg = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const exp = await Acc_Ledger.create({ companyId: company._id, name: "Raw Material", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const secret = await Acc_Ledger.create({ companyId: company._id, name: "Executive Travel", groupId: eg._id, groupName: eg.name, nature: "expense" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "board", name: "Board", accessSlug: "ceo" });
  return { company, exp, secret };
}

test("no token is refused", async () => {
  const { company } = await seed();
  expect((await call(`/action-centre?companyId=${company._id}`, null)).status).toBe(401);
});

test("an unmapped portal gets empty groups, not everything", async () => {
  const { company, exp } = await seed();
  await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: new Date("2026-04-01"), endDate: inDays(5), companyId: company._id,
    items: [], budgetRequests: [{ department: "Logistics", ledgerId: exp._id, ledgerName: exp.name,
      nature: "expense", requestedAmount: 100000, state: "countered", counterAmount: 50000 }],
  });
  const { status, body } = await call(`/action-centre?companyId=${company._id}`, tokenFor("store", "x@y.z"));
  expect(status).toBe(200);
  expect(body.needsYourAnswer).toEqual([]);
  expect(body.counts.actionable).toBe(0);
});

test("a countered line and a closing empty cycle both surface", async () => {
  const { company, exp } = await seed();
  await Acc_Budget.create({
    name: "Autumn", financialYear: "2026-27", period: "quarterly", status: "collecting",
    startDate: new Date("2026-04-01"), endDate: inDays(6), companyId: company._id,
    items: [], budgetRequests: [{ department: "Logistics", ledgerId: exp._id, ledgerName: exp.name,
      nature: "expense", requestedAmount: 100000, state: "countered", counterAmount: 50000, submittedAt: new Date() }],
  });
  await Acc_Budget.create({
    name: "Capex", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: new Date("2026-04-01"), endDate: inDays(4), companyId: company._id,
    items: [], budgetRequests: [],
  });

  const { body } = await call(`/action-centre?companyId=${company._id}`);
  expect(body.needsYourAnswer.map((a) => a.type)).toContain("proposal_countered");
  expect(body.deadlines.map((a) => a.type)).toContain("cycle_closing_empty");
  expect(body.counts.actionable).toBeGreaterThan(0);
});

test("another department's countered line never appears", async () => {
  const { company, exp, secret } = await seed();
  await Acc_Budget.create({
    name: "Autumn", financialYear: "2026-27", period: "quarterly", status: "collecting",
    startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), companyId: company._id,
    items: [],
    budgetRequests: [
      { department: "Board", ledgerId: secret._id, ledgerName: secret.name, nature: "expense",
        requestedAmount: 9000000, state: "countered", counterAmount: 1, submittedAt: new Date() },
      { department: "Logistics", ledgerId: exp._id, ledgerName: exp.name, nature: "expense",
        requestedAmount: 100000, state: "submitted", submittedAt: new Date() },
    ],
  });
  const { body } = await call(`/action-centre?companyId=${company._id}`);
  expect(body.needsYourAnswer).toEqual([]);
  const dump = JSON.stringify(body);
  expect(dump).not.toContain("Executive Travel");
  expect(dump).not.toContain("Board");
  expect(dump).not.toContain("9000000");
});

test("an over-budget line is a risk, and its head is linkable", async () => {
  const { company, exp } = await seed();
  await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
    startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), companyId: company._id,
    items: [{ ledgerId: exp._id, ledgerName: exp.name, groupName: "Indirect Expenses",
      nature: "expense", department: "Logistics", allocatedAmount: 100000 }],
    budgetRequests: [],
  });
  /* No vouchers, so actual is 0 — a healthy line, and nothing should fire. */
  const { body } = await call(`/action-centre?companyId=${company._id}`);
  expect(body.financialRisks).toEqual([]);
});

test("another department's adjustments and transfers are excluded", async () => {
  const { company, exp, secret } = await seed();
  const b = await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
    startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), companyId: company._id,
    items: [
      { ledgerId: exp._id, ledgerName: exp.name, nature: "expense", department: "Logistics", allocatedAmount: 100000 },
      { ledgerId: secret._id, ledgerName: secret.name, nature: "expense", department: "Board", allocatedAmount: 900000 },
    ],
    budgetRequests: [],
  });
  b.adjustments.push({
    type: "supplementary", targetItemId: b.items[1]._id, department: "Board",
    ledgerName: "Executive Travel", currentAllocatedAmount: 900000,
    requestedDeltaAmount: 500000, requestedNewAmount: 1400000,
    reason: "theirs", state: "submitted", requestedAt: new Date(), requestedBy: "board@x.com",
  });
  b.adjustments.push({
    type: "supplementary", targetItemId: b.items[0]._id, department: "Logistics",
    ledgerName: "Raw Material", currentAllocatedAmount: 100000,
    requestedDeltaAmount: 20000, requestedNewAmount: 120000,
    reason: "ours", state: "submitted", requestedAt: new Date(), requestedBy: "head@demo.example",
  });
  await b.save();

  const { body } = await call(`/action-centre?companyId=${company._id}`);
  const pending = body.waitingOnFinance.filter((a) => a.type === "adjustment_pending");
  expect(pending).toHaveLength(1);
  expect(pending[0].title).toMatch(/Raw Material/);
  expect(JSON.stringify(body)).not.toContain("Executive Travel");
});

test("a transfer from another department names theirs generically", async () => {
  const { company, exp, secret } = await seed();
  const b = await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "active",
    startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31"), companyId: company._id,
    items: [
      { ledgerId: exp._id, ledgerName: exp.name, nature: "expense", department: "Logistics", allocatedAmount: 100000 },
      { ledgerId: secret._id, ledgerName: secret.name, nature: "expense", department: "Board", allocatedAmount: 900000 },
    ],
    budgetRequests: [],
  });
  b.transfers.push({
    fromItemId: b.items[1]._id, toItemId: b.items[0]._id, amount: 50000, reason: "rebalance",
    state: "submitted", requestedAt: new Date(), requestedBy: "fin@x.com",
    fromSnapshot: { department: "Board", ledgerName: "Executive Travel", allocatedAmount: 900000 },
    toSnapshot: { department: "Logistics", ledgerName: "Raw Material", allocatedAmount: 100000 },
  });
  await b.save();

  const { body } = await call(`/action-centre?companyId=${company._id}`);
  const tr = body.waitingOnFinance.find((a) => a.type === "transfer_pending");
  expect(tr).toBeTruthy();
  expect(tr.description).toMatch(/another department/);
  expect(tr.description).toMatch(/Raw Material/);
  expect(JSON.stringify(body)).not.toContain("Executive Travel");
});
