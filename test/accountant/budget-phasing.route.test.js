// test/accountant/budget-phasing.route.test.js
//
// HTTP-level tests for monthly phasing on budget lines and budget requests.
//
// What this proves that services/budgetPhasing.test.js cannot:
//   - the validation actually rejects a bad split over a real HTTP round trip,
//     with a 400 and a code, and leaves NOTHING persisted;
//   - a stored custom split survives create → read;
//   - the DASHBOARD's monthly series uses the split instead of an equal
//     average — the requirement this chunk exists for, and the one a pure
//     function test can only assert about a helper rather than about what the
//     screen is actually served;
//   - agreeing a request carries the agreed phasing onto the allocation line,
//     so the plan curve matches the decision that produced it;
//   - the even-spread default is byte-for-byte unchanged.
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
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/budgets`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedCompany() {
  const company = await Acc_Company.create({
    companyName: `Phasing Co ${Math.random().toString(36).slice(2, 8)}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Direct Income",
    nature: "revenue",
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id,
    name: "Indirect Expenses",
    nature: "expense",
  });
  const revenueLedger = await Acc_Ledger.create({
    companyId: company._id,
    name: "Export Sales",
    groupId: revGroup._id,
    groupName: revGroup.name,
    nature: "revenue",
  });
  const expenseLedger = await Acc_Ledger.create({
    companyId: company._id,
    name: "Freight & Forwarding",
    groupId: expGroup._id,
    groupName: expGroup.name,
    nature: "expense",
  });
  return { company, revenueLedger, expenseLedger };
}

/* IST instants. A UTC end-of-day would be 1 April 05:29 IST and make a
   twelve-month year touch a thirteenth month — see the pure test file. */
const FY_START = "2026-03-31T18:30:00.000Z";
const FY_END = "2027-03-31T18:29:59.999Z";

function budgetPayload({ company, expenseLedger, revenueLedger, items }) {
  return {
    name: "FY26-27 Phased",
    financialYear: "2026-27",
    period: "yearly",
    status: "draft",
    startDate: FY_START,
    endDate: FY_END,
    companyId: company._id.toString(),
    items,
  };
}

const monthOf = (series, key) => series.find((m) => m.key === key);

/* ── the default is untouched ─────────────────────────────────────────────── */

test("a line with no phasing still spreads evenly", async () => {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  const created = await call("/", {
    method: "POST",
    body: budgetPayload({
      company,
      expenseLedger,
      revenueLedger,
      items: [
        {
          ledgerId: expenseLedger._id.toString(),
          nature: "expense",
          allocatedAmount: 1200000,
        },
      ],
    }),
  });
  expect(created.status).toBe(201);
  expect(created.body.budget.items[0].phasingMode).toBe("even");

  const dash = await call(
    `/dashboard?companyId=${company._id.toString()}&financialYear=2026-27`,
  );
  expect(dash.status).toBe(200);
  const months = dash.body.monthly || dash.body.dashboard?.monthly || [];
  expect(months.length).toBeGreaterThan(0);
  // 1200000 over twelve months, so every month carries the same 100000.
  const planned = months.map((m) => Math.round(m.plannedExpense));
  const nonZero = planned.filter((v) => v > 0);
  expect(nonZero.length).toBe(12);
  expect(new Set(nonZero).size).toBe(1);
  expect(nonZero[0]).toBe(100000);
});

/* ── the custom split, stored and served ──────────────────────────────────── */

test("a custom split is stored and the dashboard months use it, not an average", async () => {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  const created = await call("/", {
    method: "POST",
    body: budgetPayload({
      company,
      expenseLedger,
      revenueLedger,
      items: [
        {
          ledgerId: revenueLedger._id.toString(),
          nature: "revenue",
          allocatedAmount: 1200000,
          phasingMode: "custom_monthly",
          monthlyPhasing: [
            { month: "2026-04", amount: 200000 },
            { month: "2027-03", amount: 1000000 },
          ],
        },
      ],
    }),
  });
  expect(created.status).toBe(201);
  const line = created.body.budget.items[0];
  expect(line.phasingMode).toBe("custom_monthly");
  expect(line.monthlyPhasing.map((r) => r.month)).toEqual(["2026-04", "2027-03"]);

  const dash = await call(
    `/dashboard?companyId=${company._id.toString()}&financialYear=2026-27`,
  );
  const months = dash.body.monthly || dash.body.dashboard?.monthly || [];
  expect(Math.round(monthOf(months, "2026-04").plannedRevenue)).toBe(200000);
  expect(Math.round(monthOf(months, "2027-03").plannedRevenue)).toBe(1000000);
  // A month the split left out plans nothing — NOT the 100000 an even
  // spread would have shown, which is the whole point.
  expect(Math.round(monthOf(months, "2026-09").plannedRevenue)).toBe(0);
  // and the year still adds up to what was allocated
  const total = months.reduce((s, m) => s + (m.plannedRevenue || 0), 0);
  expect(Math.round(total)).toBe(1200000);
});

test("phasing works the same on an expense line as on a revenue line", async () => {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  await call("/", {
    method: "POST",
    body: budgetPayload({
      company,
      expenseLedger,
      revenueLedger,
      items: [
        {
          ledgerId: expenseLedger._id.toString(),
          nature: "expense",
          allocatedAmount: 600000,
          phasingMode: "custom_monthly",
          monthlyPhasing: [{ month: "2026-10", amount: 600000 }],
        },
      ],
    }),
  });
  const dash = await call(
    `/dashboard?companyId=${company._id.toString()}&financialYear=2026-27`,
  );
  const months = dash.body.monthly || dash.body.dashboard?.monthly || [];
  expect(Math.round(monthOf(months, "2026-10").plannedExpense)).toBe(600000);
  /* The ONLY month carrying plan. Asserted this way rather than by naming an
     empty month, because the series trims inactive months off both ends — so
     an even spread would fail this by planning in twelve months, which is the
     distinction the test is for. */
  const planned = months.filter((m) => (m.plannedExpense || 0) > 0).map((m) => m.key);
  expect(planned).toEqual(["2026-10"]);
});

/* ── validation, over a real round trip ───────────────────────────────────── */

test("a split outside the period is rejected and nothing is persisted", async () => {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  const before = await Acc_Budget.countDocuments({ companyId: company._id });

  const res = await call("/", {
    method: "POST",
    body: budgetPayload({
      company,
      expenseLedger,
      revenueLedger,
      items: [
        {
          ledgerId: expenseLedger._id.toString(),
          nature: "expense",
          allocatedAmount: 1200000,
          phasingMode: "custom_monthly",
          monthlyPhasing: [
            { month: "2026-04", amount: 600000 },
            { month: "2027-04", amount: 600000 },
          ],
        },
      ],
    }),
  });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("PHASING_OUTSIDE_PERIOD");
  expect(res.body.message).toMatch(/2027-04/);
  expect(await Acc_Budget.countDocuments({ companyId: company._id })).toBe(before);
});

test("a split that does not add up to the allocation is rejected", async () => {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  const res = await call("/", {
    method: "POST",
    body: budgetPayload({
      company,
      expenseLedger,
      revenueLedger,
      items: [
        {
          ledgerId: expenseLedger._id.toString(),
          nature: "expense",
          allocatedAmount: 1200000,
          phasingMode: "custom_monthly",
          monthlyPhasing: [{ month: "2026-04", amount: 500000 }],
        },
      ],
    }),
  });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("PHASING_SUM_MISMATCH");
});

test("a negative month is rejected", async () => {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  const res = await call("/", {
    method: "POST",
    body: budgetPayload({
      company,
      expenseLedger,
      revenueLedger,
      items: [
        {
          ledgerId: expenseLedger._id.toString(),
          nature: "expense",
          allocatedAmount: 100000,
          phasingMode: "custom_monthly",
          monthlyPhasing: [
            { month: "2026-04", amount: -50000 },
            { month: "2026-05", amount: 150000 },
          ],
        },
      ],
    }),
  });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("PHASING_NEGATIVE");
});

/* ── the request flow ─────────────────────────────────────────────────────── */

async function budgetForRequests() {
  const { company, expenseLedger, revenueLedger } = await seedCompany();
  const created = await call("/", {
    method: "POST",
    body: budgetPayload({ company, expenseLedger, revenueLedger, items: [] }),
  });
  expect(created.status).toBe(201);
  return { company, expenseLedger, revenueLedger, budget: created.body.budget };
}

test("a department proposes a split, and agreeing carries it onto the line", async () => {
  const { company, expenseLedger, budget } = await budgetForRequests();

  const raised = await call(`/${budget._id}/requests`, {
    method: "POST",
    body: {
      department: "Marketing",
      ledgerId: expenseLedger._id.toString(),
      requestedAmount: 900000,
      purpose: "Festival campaign, not spread across the year",
      phasingMode: "custom_monthly",
      monthlyPhasing: [
        { month: "2026-09", amount: 600000 },
        { month: "2026-10", amount: 300000 },
      ],
    },
  });
  expect(raised.status).toBe(201);
  expect(raised.body.request.phasingMode).toBe("custom_monthly");

  const agreed = await call(
    `/${budget._id}/requests/${raised.body.request._id}/agree`,
    { method: "POST" },
  );
  expect(agreed.status).toBe(200);
  expect(agreed.body.created).toBe(true);
  // The proposal is accepted along with its amount, and the LINE carries it.
  expect(agreed.body.item.phasingMode).toBe("custom_monthly");
  expect(agreed.body.item.monthlyPhasing.map((r) => r.amount)).toEqual([600000, 300000]);

  const dash = await call(
    `/dashboard?companyId=${company._id.toString()}&financialYear=2026-27`,
  );
  const months = dash.body.monthly || dash.body.dashboard?.monthly || [];
  expect(Math.round(monthOf(months, "2026-09").plannedExpense)).toBe(600000);
  expect(Math.round(monthOf(months, "2026-10").plannedExpense)).toBe(300000);
  const planned = months.filter((m) => (m.plannedExpense || 0) > 0).map((m) => m.key);
  expect(planned).toEqual(["2026-09", "2026-10"]);
});

test("agreeing a different amount against an unchanged split is refused", async () => {
  const { expenseLedger, budget } = await budgetForRequests();
  const raised = await call(`/${budget._id}/requests`, {
    method: "POST",
    body: {
      department: "Marketing",
      ledgerId: expenseLedger._id.toString(),
      requestedAmount: 900000,
      purpose: "Festival campaign",
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 900000 }],
    },
  });
  expect(raised.status).toBe(201);

  /* Finance cutting the amount without restating the split would otherwise
     store a line whose months add up to more than the line itself. */
  const agreed = await call(
    `/${budget._id}/requests/${raised.body.request._id}/agree`,
    { method: "POST", body: { agreedAmount: 400000 } },
  );
  expect(agreed.status).toBe(400);
  expect(agreed.body.code).toBe("PHASING_SUM_MISMATCH");
});

test("finance can agree a different amount by restating the split", async () => {
  const { expenseLedger, budget } = await budgetForRequests();
  const raised = await call(`/${budget._id}/requests`, {
    method: "POST",
    body: {
      department: "Marketing",
      ledgerId: expenseLedger._id.toString(),
      requestedAmount: 900000,
      purpose: "Festival campaign",
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 900000 }],
    },
  });
  const agreed = await call(
    `/${budget._id}/requests/${raised.body.request._id}/agree`,
    {
      method: "POST",
      body: {
        agreedAmount: 400000,
        phasingMode: "custom_monthly",
        monthlyPhasing: [{ month: "2026-09", amount: 400000 }],
      },
    },
  );
  expect(agreed.status).toBe(200);
  expect(agreed.body.item.allocatedAmount).toBe(400000);
  expect(agreed.body.item.monthlyPhasing[0].amount).toBe(400000);
});

test("a request with an unsplit ask still agrees to an even line", async () => {
  const { expenseLedger, budget } = await budgetForRequests();
  const raised = await call(`/${budget._id}/requests`, {
    method: "POST",
    body: {
      department: "Admin",
      ledgerId: expenseLedger._id.toString(),
      requestedAmount: 120000,
      purpose: "Office consumables through the year",
    },
  });
  expect(raised.status).toBe(201);
  expect(raised.body.request.phasingMode).toBe("even");

  const agreed = await call(
    `/${budget._id}/requests/${raised.body.request._id}/agree`,
    { method: "POST" },
  );
  expect(agreed.status).toBe(200);
  expect(agreed.body.item.phasingMode).toBe("even");
  expect(agreed.body.item.monthlyPhasing).toEqual([]);
});

test("a department cannot propose a split that does not add up to its own ask", async () => {
  const { expenseLedger, budget } = await budgetForRequests();
  const raised = await call(`/${budget._id}/requests`, {
    method: "POST",
    body: {
      department: "Marketing",
      ledgerId: expenseLedger._id.toString(),
      requestedAmount: 900000,
      purpose: "Festival campaign",
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 100000 }],
    },
  });
  expect(raised.status).toBe(400);
  expect(raised.body.code).toBe("PHASING_SUM_MISMATCH");
});
