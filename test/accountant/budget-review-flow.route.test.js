// The chunk's own verification, as a test: a department proposal with working
// rows and a custom split, agreed by finance, then countered — checking the
// allocation line each time.
"use strict";
const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", email: "priya.owner@example.com", role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};
const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

let deptSrv, finSrv, deptBase, finBase, seq = 0;
beforeAll(async () => {
  const d = express(); d.use(express.json());
  d.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => { deptSrv = d.listen(0, r); });
  deptBase = `http://127.0.0.1:${deptSrv.address().port}/api/budget-proposals`;
  const f = express(); f.use(express.json());
  f.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { finSrv = f.listen(0, r); });
  finBase = `http://127.0.0.1:${finSrv.address().port}/api/accountant/budgets`;
});
afterAll(async () => {
  await new Promise((r) => deptSrv.close(r));
  await new Promise((r) => finSrv.close(r));
});

const deptToken = jwt.sign(
  { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: "sales", email: "head@demo.example", name: "Dept Head" },
  SECRET, { expiresIn: "1h" });

const dept = (path, body) => fetch(`${deptBase}${path}`, {
  method: body ? "POST" : "GET",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${deptToken}` },
  ...(body ? { body: JSON.stringify(body) } : {}),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body) => fetch(`${finBase}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed() {
  const company = await Acc_Company.create({ companyName: `Flow ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const g = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({ companyId: company._id, name: "Software Subscriptions", groupId: g._id, groupName: g.name, nature: "expense" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  const budget = await Acc_Budget.create({
    name: "FY26-27 Annual", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  return { company, budget, ledger };
}

const SUBS = [
  { label: "Claude Team", quantity: 5, unit: "users", rate: 6000, multiplier: 12, multiplierUnit: "months" },
  { label: "Codex usage", quantity: 1, unit: "account", rate: 20000, multiplier: 12, multiplierUnit: "months" },
];

async function propose(budget, company) {
  const { status, body } = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: company && undefined, requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 200000 }, { month: "2026-10", amount: 400000 }],
  });
  return { status, body };
}

test("propose with working + custom split, finance agrees keeping both", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 200000 }, { month: "2026-10", amount: 400000 }],
  });
  expect(made.status).toBe(201);
  const id = made.body.request._id;

  // the review page sends only an amount + note when "keep theirs" is chosen
  const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 600000, financeNote: "Approved as proposed.",
  });
  expect(agreed.status).toBe(200);

  const fresh = await Acc_Budget.findById(budget._id).lean();
  const lines = fresh.items.filter((i) => String(i.sourceRequestId) === String(id));
  expect(lines).toHaveLength(1);
  expect(lines[0].allocatedAmount).toBe(600000);
  expect(lines[0].phasingMode).toBe("custom_monthly");
  expect(lines[0].monthlyPhasing.map((m) => [m.month, m.amount])).toEqual([
    ["2026-09", 200000], ["2026-10", 400000],
  ]);
});

test("agreeing twice does not duplicate the allocation", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
  });
  const id = made.body.request._id;
  await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 600000 });
  await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 500000 });
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const lines = fresh.items.filter((i) => String(i.sourceRequestId) === String(id));
  expect(lines).toHaveLength(1);
  expect(lines[0].allocatedAmount).toBe(500000);
});

test("finance can spread evenly instead of keeping their split", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 600000 }],
  });
  const id = made.body.request._id;
  const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    agreedAmount: 600000, phasingMode: "even",
  });
  expect(agreed.status).toBe(200);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find((i) => String(i.sourceRequestId) === String(id));
  expect(line.phasingMode).toBe("even");
  expect(line.monthlyPhasing || []).toEqual([]);
});

test("counter with an edited shape allocates nothing and reaches the department", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 600000,
    purpose: "Team tooling", workingLines: SUBS,
  });
  const id = made.body.request._id;

  const countered = await fin(`/${budget._id}/requests/${id}/counter?companyId=${company._id}`, {
    counterAmount: 450000,
    financeNote: "Drop Codex to six months.",
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2027-01", amount: 450000 }],
  });
  expect(countered.status).toBe(200);

  const fresh = await Acc_Budget.findById(budget._id).lean();
  expect(fresh.items.filter((i) => String(i.sourceRequestId) === String(id))).toHaveLength(0);

  // and the department app sees it
  const mine = await dept(`/my-requests?companyId=${company._id}`);
  const row = mine.body.requests.find((x) => String(x._id) === String(id));
  expect(row.state).toBe("countered");
  expect(row.counterAmount).toBe(450000);
  expect(row.financeNote).toMatch(/six months/);
  expect(row.agreedPhasingMode).toBe("custom_monthly");
  expect(row.agreedMonthlyPhasing.map((m) => m.month)).toEqual(["2027-01"]);
});

test("an approver cannot agree their own request", async () => {
  const { company, budget, ledger } = await seed();
  const made = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(), requestedAmount: 100000, purpose: "x",
  });
  const id = made.body.request._id;
  const doc = await Acc_Budget.findById(budget._id);
  doc.budgetRequests.id(id).submittedBy = "manager@example.com";
  await doc.save();

  const res = await fetch(`${finBase}/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-test-user": JSON.stringify({
        id: new mongoose.Types.ObjectId().toString(), name: "Manager", email: "manager@example.com",
        role: "manager", permissions: { canEdit: true, canApprove: true },
      }),
    },
    body: JSON.stringify({ agreedAmount: 100000 }),
  });
  expect(res.status).toBe(403);
});
