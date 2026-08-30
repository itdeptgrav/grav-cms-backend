// test/accountant/budget-proposal-phasing.route.test.js
//
// Department-submitted monthly phasing, and the boundary around it.
//
// The proposal route is the first place a DEPARTMENT can write a shape that
// finance will later approve into a real allocation line. So the questions
// here are not "does the maths work" — services/budgetPhasing.test.js owns
// that — but:
//
//   - can a department state a shape at all, in each of the three modes the
//     form offers;
//   - is a shape that cannot be funded refused, rather than stored;
//   - can a department reach any of finance's fields by sending them;
//   - does the shape survive to the allocation line finance approves it into.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

/* Only the ACCOUNTANT middleware is mocked. The department route under test
   authenticates itself with a real signed token (see tokenFor) and is
   untouched by this — which is the point: the boundary being tested is the
   real one. */
jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
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

const tokenFor = ({ deptSlug = "sales", email = "head@demo.example" } = {}) =>
  jwt.sign(
    { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug, email, name: "Dept Head" },
    SECRET,
    { expiresIn: "1h" },
  );

async function call(path, { method = "GET", body, token = tokenFor() } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/* IST instants. A UTC end-of-day would be 1 April 05:29 IST and make a
   twelve-month year touch a thirteenth month. */
const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

async function seed() {
  const company = await Acc_Company.create({
    companyName: `Phasing Proposals ${seq++}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const eg = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const rg = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const expense = await Acc_Ledger.create({
    companyId: company._id, name: "Raw Material", groupId: eg._id, groupName: eg.name, nature: "expense",
  });
  /* A second expense head, so bulk fixtures can put DISTINCT heads on each
     line — one head twice in a proposal is now a duplicate, which is the
     point of those rules and not what these tests are about. */
  const expense2 = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding", groupId: eg._id, groupName: eg.name, nature: "expense",
  });
  const revenue = await Acc_Ledger.create({
    companyId: company._id, name: "Export Sales", groupId: rg._id, groupName: rg.name, nature: "revenue",
  });
  await Acc_BudgetDepartment.create({
    companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales",
  });
  const budget = await Acc_Budget.create({
    name: "FY26-27 Collection", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  return { company, budget, expense, expense2, revenue };
}

const submit = (budget, company, over = {}) =>
  call(`/${budget._id}/requests?companyId=${company._id}`, {
    method: "POST",
    body: {
      department: "Logistics",
      requestedAmount: 1200000,
      purpose: "Peak season raw material",
      ...over,
    },
  });

/* ═══ THE THREE MODES THE FORM OFFERS ══════════════════════════════════════ */

describe("a department can state a monthly shape", () => {
  test("even across the cycle stores no rows", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      phasingMode: "even",
    });
    expect(status).toBe(201);
    expect(body.request.phasingMode).toBe("even");
    expect(body.request.monthlyPhasing).toEqual([]);
  });

  test("no phasing sent at all defaults to even", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, { ledgerId: expense._id.toString() });
    expect(status).toBe(201);
    expect(body.request.phasingMode).toBe("even");
  });

  test("one month puts the whole amount in that month", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 1200000 }],
    });
    expect(status).toBe(201);
    expect(body.request.monthlyPhasing).toEqual([{ month: "2026-09", amount: 1200000 }]);
  });

  test("a custom peak-season split is stored in period order", async () => {
    const { company, budget, revenue } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: revenue._id.toString(),
      requestedAmount: 1000000,
      purpose: "Export target, weighted to the autumn buying season",
      phasingMode: "custom_monthly",
      /* Deliberately out of order, to prove the store sorts. */
      monthlyPhasing: [
        { month: "2026-11", amount: 500000 },
        { month: "2026-09", amount: 200000 },
        { month: "2026-10", amount: 300000 },
      ],
    });
    expect(status).toBe(201);
    expect(body.request.nature).toBe("revenue");
    expect(body.request.monthlyPhasing.map((r) => r.month)).toEqual([
      "2026-09", "2026-10", "2026-11",
    ]);
  });
});

/* ═══ A SHAPE THAT CANNOT BE FUNDED IS REFUSED ═════════════════════════════ */

describe("an unfundable split is refused, not stored", () => {
  test("a split that does not add up to the ask is a 400", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 1200000,
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 900000 }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PHASING_SUM_MISMATCH");

    // and nothing was persisted
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(0);
  });

  test("a month outside the cycle is a 400", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2028-06", amount: 1200000 }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PHASING_OUTSIDE_PERIOD");
  });

  test("a custom mode with no rows is a 400", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      phasingMode: "custom_monthly",
      monthlyPhasing: [],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PHASING_EMPTY");
  });

  test("a negative month is a 400", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      phasingMode: "custom_monthly",
      monthlyPhasing: [
        { month: "2026-09", amount: 1400000 },
        { month: "2026-10", amount: -200000 },
      ],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PHASING_NEGATIVE");
  });
});

/* ═══ THE BOUNDARY ═════════════════════════════════════════════════════════ */

describe("a department cannot reach finance's fields", () => {
  test("agreed amount, agreed phasing, state and submittedBy are all ignored", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 1200000 }],
      // everything below is finance's, or the server's
      agreedAmount: 9999999,
      agreedPhasingMode: "custom_monthly",
      agreedMonthlyPhasing: [{ month: "2026-04", amount: 9999999 }],
      counterAmount: 500,
      state: "agreed",
      submittedBy: "someone.else@example.com",
      financeNote: "approved by me, obviously",
    });
    expect(status).toBe(201);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    const row = fresh.budgetRequests[0];
    expect(row.state).toBe("submitted");
    expect(row.agreedAmount).toBeUndefined();
    expect(row.agreedPhasingMode).toBeUndefined();
    expect(row.agreedMonthlyPhasing).toBeUndefined();
    expect(row.counterAmount).toBeUndefined();
    expect(row.financeNote).toBeUndefined();
    expect(row.submittedBy).toBe("head@demo.example");
    // the department's OWN shape did land
    expect(row.phasingMode).toBe("custom_monthly");
  });
});

/* ═══ REVISING ═════════════════════════════════════════════════════════════ */

describe("revising a request", () => {
  const first = async () => {
    const s = await seed();
    const { body } = await submit(s.budget, s.company, {
      ledgerId: s.expense._id.toString(),
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 1200000 }],
    });
    return { ...s, requestId: body.request._id };
  };

  test("the split can be reshaped while the request is editable", async () => {
    const { company, budget, requestId } = await first();
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      {
        method: "PUT",
        body: {
          requestedAmount: 1200000,
          purpose: "Re-phased after the buyer moved the shipment",
          phasingMode: "custom_monthly",
          monthlyPhasing: [
            { month: "2026-10", amount: 700000 },
            { month: "2026-11", amount: 500000 },
          ],
        },
      },
    );
    expect(status).toBe(200);
    expect(body.request.monthlyPhasing.map((r) => r.month)).toEqual(["2026-10", "2026-11"]);
  });

  test("switching back to even clears the stored rows", async () => {
    const { company, budget, requestId } = await first();
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 1200000, phasingMode: "even" } },
    );
    expect(status).toBe(200);
    expect(body.request.phasingMode).toBe("even");
    expect(body.request.monthlyPhasing).toEqual([]);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].monthlyPhasing || []).toEqual([]);
  });

  test("changing the amount without resending the split is refused", async () => {
    /* The split still says 12,00,000. Letting this through would leave a line
       whose shape disagrees with its own total. */
    const { company, budget, requestId } = await first();
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 900000 } },
    );
    expect(status).toBe(400);
    expect(body.code).toBe("PHASING_SUM_MISMATCH");
  });

  test("an agreed request can no longer be revised by the department", async () => {
    const { company, budget, requestId } = await first();
    const doc = await Acc_Budget.findById(budget._id);
    doc.budgetRequests.id(requestId).state = "agreed";
    await doc.save();

    const { status } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 100, phasingMode: "even" } },
    );
    expect(status).toBe(409);
  });

  test("another department's request cannot be revised", async () => {
    const { company, budget, requestId } = await first();
    const { status } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 100 }, token: tokenFor({ deptSlug: "store" }) },
    );
    expect(status).toBe(404);
  });
});

/* ═══ WHAT THE DEPARTMENT GETS BACK ════════════════════════════════════════ */

test("my-requests carries the shape back to the department app", async () => {
  const { company, budget, expense } = await seed();
  await submit(budget, company, {
    ledgerId: expense._id.toString(),
    phasingMode: "custom_monthly",
    monthlyPhasing: [
      { month: "2026-09", amount: 400000 },
      { month: "2026-10", amount: 800000 },
    ],
  });
  const { status, body } = await call(`/my-requests?companyId=${company._id}`);
  expect(status).toBe(200);
  const r = body.requests[0];
  expect(r.phasingMode).toBe("custom_monthly");
  expect(r.monthlyPhasing).toHaveLength(2);
  expect(r.agreedPhasingMode).toBeNull();
});

/* ═══ FINANCE COMPATIBILITY ════════════════════════════════════════════════
 * These do not test new code. They pin down behaviour the department form now
 * depends on: that a shape a department states is the shape finance approves
 * into a real allocation line unless finance deliberately says otherwise.
 * If a later change to the finance route breaks that, the department's peak
 * season silently becomes a straight line — and nothing on either screen
 * would say so.
 * ═════════════════════════════════════════════════════════════════════════ */

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

describe("finance approval carries the department's shape", () => {
  const financeApp = express();
  let financeServer;
  let financeBase;

  beforeAll(async () => {
    financeApp.use(express.json());
    financeApp.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
    await new Promise((r) => { financeServer = financeApp.listen(0, r); });
    financeBase = `http://127.0.0.1:${financeServer.address().port}/api/accountant/budgets`;
  });
  afterAll(async () => { await new Promise((r) => financeServer.close(r)); });

  const agree = (budgetId, requestId, body) =>
    fetch(`${financeBase}/${budgetId}/requests/${requestId}/agree`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  const counter = (budgetId, requestId, body) =>
    fetch(`${financeBase}/${budgetId}/requests/${requestId}/counter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  const proposeSplit = async () => {
    const s = await seed();
    const { body } = await submit(s.budget, s.company, {
      ledgerId: s.expense._id.toString(),
      requestedAmount: 1200000,
      phasingMode: "custom_monthly",
      monthlyPhasing: [
        { month: "2026-09", amount: 300000 },
        { month: "2026-10", amount: 900000 },
      ],
    });
    return { ...s, requestId: body.request._id };
  };

  test("agreeing the amount as asked keeps the department's split on the line", async () => {
    const { company, budget, requestId } = await proposeSplit();
    const { status } = await agree(budget._id, requestId, {
      companyId: company._id.toString(),
      agreedAmount: 1200000,
    });
    expect(status).toBe(200);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    const line = fresh.items.find((i) => String(i.sourceRequestId) === String(requestId));
    expect(line).toBeTruthy();
    expect(line.allocatedAmount).toBe(1200000);
    // the shape survived the approval, unchanged
    expect(line.phasingMode).toBe("custom_monthly");
    expect(line.monthlyPhasing.map((m) => [m.month, m.amount])).toEqual([
      ["2026-09", 300000],
      ["2026-10", 900000],
    ]);
  });

  test("finance re-phases through a counter, and the line takes that shape", async () => {
    /* Re-phasing at approval used to be one click. It is now a counter, because
       a department finding out afterwards that its festival money was moved to
       January is not something they agreed to. What must survive the change is
       the record: the ask keeps its own shape, the settlement keeps finance's. */
    const { company, budget, requestId } = await proposeSplit();
    const countered = await counter(budget._id, requestId, {
      companyId: company._id.toString(),
      counterAmount: 1200000,
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2027-01", amount: 1200000 }],
      financeNote: "Same money, but after the festival quarter.",
    });
    expect(countered.status).toBe(200);

    const { status } = await agree(budget._id, requestId, {
      companyId: company._id.toString(),
    });
    expect(status).toBe(200);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    const line = fresh.items.find((i) => String(i.sourceRequestId) === String(requestId));
    expect(line.monthlyPhasing.map((m) => m.month)).toEqual(["2027-01"]);

    // and the ASK is still on the record — the negotiation keeps its memory
    const row = fresh.budgetRequests.find((r) => String(r._id) === String(requestId));
    expect(row.monthlyPhasing.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);
    expect(row.agreedMonthlyPhasing.map((m) => m.month)).toEqual(["2027-01"]);
  });

  test("cutting the amount at approval is refused as an edit", async () => {
    const { company, budget, requestId } = await proposeSplit();
    const { status, body } = await agree(budget._id, requestId, {
      companyId: company._id.toString(),
      agreedAmount: 800000,
    });
    expect(status).toBe(400);
    expect(body.code).toBe("AGREE_IS_NOT_AN_EDIT");
  });

  test("cutting it by counter without re-phasing is still refused rather than straight-lined", async () => {
    /* The arithmetic this always protected, on its new path. The department's
       split still sums to 12,00,000; finance has to say how the smaller number
       is spread, or the line's months do not add up to its own total. */
    const { company, budget, requestId } = await proposeSplit();
    const countered = await counter(budget._id, requestId, {
      companyId: company._id.toString(),
      counterAmount: 800000,
    });
    expect(countered.status).toBe(200);

    const { status, body } = await agree(budget._id, requestId, {
      companyId: company._id.toString(),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("PHASING_SUM_MISMATCH");
  });

  test("agreeing a request with a breakdown notes what it was built from", async () => {
    const s2 = await seed();
    const { body } = await submit(s2.budget, s2.company, {
      ledgerId: s2.expense._id.toString(),
      requestedAmount: 660000,
      purpose: "Team tooling for FY26-27",
      workingLines: SUBS,
    });
    const { status } = await agree(s2.budget._id, body.request._id, {
      companyId: s2.company._id.toString(),
      agreedAmount: 660000,
    });
    expect(status).toBe(200);

    const fresh = await Acc_Budget.findById(s2.budget._id).lean();
    const line = fresh.items.find((i) => String(i.sourceRequestId) === String(body.request._id));
    expect(line.allocatedAmount).toBe(660000);
    /* The line explains itself, and points back at the request that still
       holds the arithmetic — the breakdown is NOT copied onto the line. */
    expect(line.notes).toMatch(/Team tooling/);
    expect(line.notes).toMatch(/Built from 3 lines/);
    expect(line.workingLines).toBeUndefined();

    // and the request keeps the detail
    const row = fresh.budgetRequests.find((r) => String(r._id) === String(body.request._id));
    expect(row.workingLines).toHaveLength(3);
  });

  test("an evenly-phased ask countered down stays even", async () => {
    const s = await seed();
    const { body } = await submit(s.budget, s.company, {
      ledgerId: s.expense._id.toString(),
      requestedAmount: 1200000,
      phasingMode: "even",
    });
    const countered = await counter(s.budget._id, body.request._id, {
      companyId: s.company._id.toString(),
      counterAmount: 800000,
    });
    expect(countered.status).toBe(200);

    const { status } = await agree(s.budget._id, body.request._id, {
      companyId: s.company._id.toString(),
    });
    expect(status).toBe(200);
    const fresh = await Acc_Budget.findById(s.budget._id).lean();
    const line = fresh.items.find((i) => String(i.sourceRequestId) === String(body.request._id));
    expect(line.allocatedAmount).toBe(800000);
    expect(line.phasingMode).toBe("even");
  });
});


/* ═══ THE STRUCTURED BREAKDOWN ═════════════════════════════════════════════
 * Over HTTP, because the arithmetic rules are already covered by
 * services/budgetWorking.test.js. What matters here is what actually lands in
 * the document, and what the route refuses to let a department write.
 * ═════════════════════════════════════════════════════════════════════════ */

const SUBS = [
  { label: "Claude Team", quantity: 5, unit: "users", rate: 6000, multiplier: 12, multiplierUnit: "months" },
  { label: "Codex usage", quantity: 1, unit: "account", rate: 20000, multiplier: 12, multiplierUnit: "months" },
  { label: "GitHub Copilot", quantity: 5, unit: "users", rate: 1000, multiplier: 12, multiplierUnit: "months" },
];

describe("a department can show its working", () => {
  test("a matching breakdown is stored with the request", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 660000,
      purpose: "Team tooling for FY26-27",
      workingLines: SUBS,
    });
    expect(status).toBe(201);
    expect(body.request.workingLines).toHaveLength(3);
    expect(body.request.workingTotal).toBe(660000);
    expect(body.request.manualAmountOverride).toBe(false);
    expect(body.request.workingLines[0].amount).toBe(360000);
  });

  test("the server recomputes rows and ignores a client-supplied amount", async () => {
    const { company, budget, expense } = await seed();
    const { status } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 660000,
      /* Every row claims an amount that does not follow from its own inputs.
         If any of these were trusted the request would not reconcile. */
      workingLines: SUBS.map((l) => ({ ...l, amount: 1 })),
    });
    expect(status).toBe(201);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    const stored = fresh.budgetRequests[0].workingLines;
    expect(stored.map((l) => l.amount)).toEqual([360000, 240000, 60000]);
  });

  test("an amount that does not match its breakdown is refused", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 800000,
      workingLines: SUBS,
    });
    expect(status).toBe(400);
    expect(body.code).toBe("WORKING_SUM_MISMATCH");

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(0);
  });

  test("a mismatch is accepted when it is explained", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 800000,
      workingLines: SUBS,
      manualAmountOverride: true,
      manualOverrideReason: "The quote covers year one; I am asking for the whole contract.",
    });
    expect(status).toBe(201);
    expect(body.request.manualAmountOverride).toBe(true);
    expect(body.request.manualOverrideReason).toMatch(/whole contract/);
    expect(body.request.requestedAmount).toBe(800000);
    expect(body.request.workingTotal).toBe(660000);
  });

  test("an override without a reason is refused", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 800000,
      workingLines: SUBS,
      manualAmountOverride: true,
    });
    expect(status).toBe(400);
    expect(body.code).toBe("WORKING_OVERRIDE_NO_REASON");
  });

  test("a negative row is refused", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 660000,
      workingLines: [{ label: "Refund", quantity: -1, rate: 1000, multiplier: 1 }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("WORKING_NEGATIVE");
  });

  test("a revenue target can be built the same way", async () => {
    const { company, budget, revenue } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: revenue._id.toString(),
      requestedAmount: 4500000,
      purpose: "EU autumn order book",
      workingLines: [
        { label: "Expected orders", quantity: 150, unit: "orders", rate: 30000, multiplier: 1 },
      ],
    });
    expect(status).toBe(201);
    expect(body.request.nature).toBe("revenue");
    expect(body.request.workingTotal).toBe(4500000);
  });
});

describe("revising a breakdown", () => {
  const withBreakdown = async () => {
    const s = await seed();
    const { body } = await submit(s.budget, s.company, {
      ledgerId: s.expense._id.toString(),
      requestedAmount: 660000,
      purpose: "Team tooling",
      workingLines: SUBS,
    });
    return { ...s, requestId: body.request._id };
  };

  test("changing the rows and the total together is accepted", async () => {
    const { company, budget, requestId } = await withBreakdown();
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      {
        method: "PUT",
        body: {
          requestedAmount: 600000,
          purpose: "Team tooling, Copilot dropped",
          workingLines: SUBS.slice(0, 2),
        },
      },
    );
    expect(status).toBe(200);
    expect(body.request.workingLines).toHaveLength(2);
    expect(body.request.workingTotal).toBe(600000);
  });

  test("changing the amount without touching the rows is refused", async () => {
    /* The stored rows still add up to 6,60,000. */
    const { company, budget, requestId } = await withBreakdown();
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 900000 } },
    );
    expect(status).toBe(400);
    expect(body.code).toBe("WORKING_SUM_MISMATCH");
  });

  test("clearing the breakdown leaves the amount standing on its own", async () => {
    const { company, budget, requestId } = await withBreakdown();
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { requestedAmount: 900000, workingLines: [] } },
    );
    expect(status).toBe(200);
    expect(body.request.workingLines).toEqual([]);
    expect(body.request.workingTotal).toBeNull();
    expect(body.request.requestedAmount).toBe(900000);
  });

  test("an override survives a revise that only re-sends the rows", async () => {
    const { company, budget, requestId } = await withBreakdown();
    await call(`/${budget._id}/requests/${requestId}?companyId=${company._id}`, {
      method: "PUT",
      body: {
        requestedAmount: 800000,
        workingLines: SUBS,
        manualAmountOverride: true,
        manualOverrideReason: "Contract spans two years.",
      },
    });
    const { status, body } = await call(
      `/${budget._id}/requests/${requestId}?companyId=${company._id}`,
      { method: "PUT", body: { purpose: "Team tooling, revised wording" } },
    );
    expect(status).toBe(200);
    expect(body.request.manualAmountOverride).toBe(true);
    expect(body.request.requestedAmount).toBe(800000);
  });
});

test("a department cannot smuggle finance fields alongside a breakdown", async () => {
  const { company, budget, expense } = await seed();
  const { status } = await submit(budget, company, {
    ledgerId: expense._id.toString(),
    requestedAmount: 660000,
    workingLines: SUBS,
    agreedAmount: 9999999,
    state: "agreed",
    financeNote: "approved by me",
    submittedBy: "someone.else@example.com",
  });
  expect(status).toBe(201);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  const row = fresh.budgetRequests[0];
  expect(row.state).toBe("submitted");
  expect(row.agreedAmount).toBeUndefined();
  expect(row.financeNote).toBeUndefined();
  expect(row.submittedBy).toBe("head@demo.example");
  expect(row.workingLines).toHaveLength(3);
});

/* ═══ SUBMITTING A WHOLE PROPOSAL AT ONCE ══════════════════════════════════
 * The department form is a multi-line page now. What matters is that a
 * proposal cannot half-land: five lines with a bad third one must leave the
 * cycle exactly as it was, not holding lines one and two.
 * ═════════════════════════════════════════════════════════════════════════ */

describe("bulk submit", () => {
  const bulk = (budget, company, lines) =>
    call(`/${budget._id}/requests/bulk?companyId=${company._id}`, {
      method: "POST",
      body: { lines },
    });

  const line = (over = {}) => ({
    department: "Logistics",
    requestedAmount: 500000,
    purpose: "Peak season",
    ...over,
  });

  test("several lines land together", async () => {
    const { company, budget, expense, expense2, revenue } = await seed();
    const { status, body } = await bulk(budget, company, [
      line({ ledgerId: expense._id.toString(), requestedAmount: 660000, workingLines: SUBS }),
      line({
        ledgerId: expense2._id.toString(),
        requestedAmount: 1200000,
        phasingMode: "custom_monthly",
        monthlyPhasing: [{ month: "2026-09", amount: 1200000 }],
      }),
      line({ ledgerId: revenue._id.toString(), requestedAmount: 4500000, purpose: "EU order book" }),
    ]);
    expect(status).toBe(201);
    expect(body.requests).toHaveLength(3);
    expect(body.requests[2].nature).toBe("revenue");

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(3);
    // one submission stamp for the whole proposal
    const stamps = new Set(fresh.budgetRequests.map((r) => r.submittedAt.toISOString()));
    expect(stamps.size).toBe(1);
    expect(fresh.budgetRequests.every((r) => r.submittedBy === "head@demo.example")).toBe(true);
  });

  test("one bad line refuses the whole proposal and writes nothing", async () => {
    const { company, budget, expense, expense2, revenue } = await seed();
    const { status, body } = await bulk(budget, company, [
      line({ ledgerId: expense._id.toString() }),
      line({ ledgerId: expense2._id.toString() }),
      // the third does not add up
      line({
        ledgerId: revenue._id.toString(),
        requestedAmount: 800000,
        workingLines: SUBS,
      }),
      line({ ledgerId: expense._id.toString(), department: "Logistics", requestedAmount: 1 }),
    ]);
    expect(status).toBe(400);
    expect(body.code).toBe("WORKING_SUM_MISMATCH");
    // named by position, one-based, so the message points at a row on screen
    expect(body.line).toBe(3);
    expect(body.message).toMatch(/^Line 3:/);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(0);
  });

  test("a line for another department refuses the whole proposal", async () => {
    const { company, budget, expense, expense2 } = await seed();
    const { status } = await bulk(budget, company, [
      line({ ledgerId: expense._id.toString() }),
      line({ ledgerId: expense2._id.toString(), department: "Board" }),
    ]);
    expect(status).toBe(403);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(0);
  });

  test("an unmapped portal cannot bulk submit", async () => {
    const { company, budget, expense } = await seed();
    const { status } = await call(`/${budget._id}/requests/bulk?companyId=${company._id}`, {
      method: "POST",
      body: { lines: [line({ ledgerId: expense._id.toString() })] },
      token: tokenFor({ deptSlug: "store" }),
    });
    expect(status).toBe(403);
  });

  test("an empty list is refused", async () => {
    const { company, budget } = await seed();
    expect((await bulk(budget, company, [])).status).toBe(400);
  });

  test("finance fields cannot be smuggled through the bulk path either", async () => {
    const { company, budget, expense } = await seed();
    const { status } = await bulk(budget, company, [
      line({
        ledgerId: expense._id.toString(),
        state: "agreed",
        agreedAmount: 9999999,
        submittedBy: "someone.else@example.com",
      }),
    ]);
    expect(status).toBe(201);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].state).toBe("submitted");
    expect(fresh.budgetRequests[0].agreedAmount).toBeUndefined();
    expect(fresh.budgetRequests[0].submittedBy).toBe("head@demo.example");
  });
});

/* ═══ A MONTH-WISE ASK, ITEM BY ITEM ═══════════════════════════════════════
   The form no longer asks the months twice. A Month-wise line's items carry
   their own months, the line's split is those added up, and the line's amount
   is the sum of the rows. What arrives here is exactly that: rows with
   `monthly`, and a `monthlyPhasing` that is their column totals.

   The questions are whether the item months survive to the stored request —
   so finance can see WHICH item spends in November — and whether the old
   shape, rows with no months at all, still behaves as it always did. */

describe("item-level months", () => {
  const MONTH_WISE = {
    phasingMode: "custom_monthly",
    requestedAmount: 190000,
    monthlyPhasing: [
      { month: "2026-04", amount: 120000 },
      { month: "2026-05", amount: 20000 },
      { month: "2026-09", amount: 50000 },
    ],
    workingLines: [
      {
        label: "Campaign", manualAmount: true, amount: 150000,
        monthly: [{ month: "2026-04", amount: 100000 }, { month: "2026-09", amount: 50000 }],
      },
      {
        label: "Agency", description: "retainer", manualAmount: true, amount: 40000,
        monthly: [{ month: "2026-04", amount: 20000 }, { month: "2026-05", amount: 20000 }],
      },
    ],
  };

  test("each item keeps its own months, so finance can see who spends when", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      ...MONTH_WISE,
    });
    expect(status).toBe(201);

    const [campaign, agency] = body.request.workingLines;
    expect(campaign.monthly.map((m) => [m.month, m.amount])).toEqual([
      ["2026-04", 100000], ["2026-09", 50000],
    ]);
    expect(agency.monthly.map((m) => [m.month, m.amount])).toEqual([
      ["2026-04", 20000], ["2026-05", 20000],
    ]);
    /* Stored, not merely echoed. */
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].workingLines[1].monthly[1].amount).toBe(20000);
  });

  test("a row's amount is its months added up, whatever the client claimed", async () => {
    const { company, budget, expense } = await seed();
    const { body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      ...MONTH_WISE,
      workingLines: [
        { ...MONTH_WISE.workingLines[0], amount: 999999 },
        MONTH_WISE.workingLines[1],
      ],
    });
    expect(body.request.workingLines[0].amount).toBe(150000);
    expect(body.request.requestedAmount).toBe(190000);
  });

  test("the split and the items have to be the same money", async () => {
    /* The form derives one from the other, so a disagreement means something
       is wrong on the way in — not something to average out. */
    const { company, budget, expense } = await seed();
    const { status } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      ...MONTH_WISE,
      monthlyPhasing: [{ month: "2026-04", amount: 190000 }],
      requestedAmount: 150000,
    });
    expect(status).toBe(400);
  });

  test("a proposal with no item months is stored exactly as it always was", async () => {
    const { company, budget, expense } = await seed();
    const { status, body } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 360000,
      phasingMode: "even",
      workingLines: [{ label: "Seats", quantity: 5, unit: "users", rate: 6000, multiplier: 12 }],
    });
    expect(status).toBe(201);
    expect(body.request.workingLines[0].amount).toBe(360000);
    expect(body.request.workingLines[0].monthly).toBeUndefined();
  });

  test("a month that is not a month is refused", async () => {
    const { company, budget, expense } = await seed();
    const { status } = await submit(budget, company, {
      ledgerId: expense._id.toString(),
      requestedAmount: 5000,
      phasingMode: "even",
      workingLines: [{ label: "X", monthly: [{ month: "April", amount: 5000 }] }],
    });
    expect(status).toBe(400);
  });
});
