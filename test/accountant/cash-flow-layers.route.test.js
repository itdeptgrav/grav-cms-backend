// test/accountant/cash-flow-layers.route.test.js
//
// THE THREE LAYERS OF A CASH-FLOW FORECAST.
//
//   confirmed         an accounting document exists    invoice, bill, voucher
//   with_commitments  + finance approved a request, no document yet
//   budget_scenario   + what the budget plans, where nothing stronger exists
//
// ── WHAT THIS SUITE IS REALLY GUARDING ──────────────────────────────────────
// Two things, and the second is the one that would be hardest to notice.
//
// 1. The confirmed layer must report the SAME figures whether or not the
//    layers above it were asked for. Not similar — the same. Otherwise the
//    three are not comparable and nobody can tell which part of a change came
//    from where.
//
// 2. The same intention must not be counted twice. ₹1,00,000 budgeted for a
//    head in September with a ₹40,000 approved request against it is
//    ₹1,00,000 of expected spending, not ₹1,40,000. Confirmed wins over
//    committed, committed wins over plan, and the plan fills only the gap —
//    matched on budget line, department and month, never on vendor or amount.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

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
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");

const USER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/accountant/cash-flow-forecast",
    require("../../routes/Accountant_Routes/Acc_cashFlowForecast"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/cash-flow-forecast`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (qs) =>
  fetch(`${base}${qs}`, { headers: { "x-test-user": JSON.stringify(USER) } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* The forecast runs from today, so the fixtures are placed relative to it —
   a hard-coded September would fall out of the horizon next year. */
const TODAY = new Date();
const inDays = (n) => new Date(TODAY.getTime() + n * 86400000);
const iso = (d) => d.toISOString().slice(0, 10);
const monthOf = (d) =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/**
 * A company with a live budget: ₹1,00,000 of Software and ₹2,50,000 of Export
 * Sales, both phased onto the month twenty days out so they land inside a
 * 60-day horizon.
 */
async function seed({ softwarePlan = 100000, revenuePlan = 250000 } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Layer Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const mk = async (name, nature) => {
    const g = await Acc_Group.create({
      companyId: company._id,
      name: nature === "revenue" ? "Direct Income" : nature === "asset" ? "Cash-in-Hand" : "Indirect Expenses",
      nature,
    });
    return Acc_Ledger.create({
      companyId: company._id, name: `${name} ${n}`, groupId: g._id,
      groupName: g.name, nature,
    });
  };
  await mk("Cash", "asset");
  const software = await mk("Software", "expense");
  const sales = await mk("Export Sales", "revenue");

  const planMonth = monthOf(inDays(20));
  const budget = await Acc_Budget.create({
    name: `Budget ${n}`, financialYear: "2026-27", period: "yearly", status: "active",
    startDate: inDays(-200), endDate: inDays(160), companyId: company._id,
    items: [
      { ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "Tech", allocatedAmount: softwarePlan,
        phasingMode: "custom_monthly",
        monthlyPhasing: [{ month: planMonth, amount: softwarePlan }] },
      { ledgerId: sales._id, ledgerName: sales.name, nature: "revenue",
        department: "Tech", allocatedAmount: revenuePlan,
        phasingMode: "custom_monthly",
        monthlyPhasing: [{ month: planMonth, amount: revenuePlan }] },
    ],
  });

  return { company, software, sales, budget, line: budget.items[0], planMonth };
}

/** An approved request and the commitment it made. */
async function commit({ company, software, budget, line, amount = 40000,
                        expectedPaymentDate = inDays(5), status = "committed" }) {
  const request = await SpendRequest.create({
    title: "Design tooling", requestType: "SERVICE",
    requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Rutu",
    requestedById: `EM${seq}`, department: "Tech",
    companyId: company._id, ledgerId: software._id, ledgerName: software.name,
    purpose: "Renewal",
    items: [{ name: "Licence", whyNeeded: "Renewal", quantity: 1, unit: "year", rate: amount, amount }],
    totalAmount: amount, status: "approved",
    budgetCycleId: budget._id, budgetLineId: line._id, budgetMatchStatus: "matched",
  });
  return Commitment.create({
    spendRequestId: request._id, spendRequestNumber: "SPR-TEST",
    companyId: company._id, budgetId: budget._id, budgetLineId: line._id,
    department: "Tech", ledgerId: software._id, ledgerName: software.name,
    amount, status, expectedPaymentDate,
  });
}

const q = (company, layer) =>
  `/?companyId=${company._id}&horizon=60${layer ? `&layer=${layer}` : ""}`;

/* ═══ THE ANSWER SAYS WHICH LAYER IT IS ═══════════════════════════════════ */

test("every response names its layer", async () => {
  const { company } = await seed();
  for (const [asked, expected] of [
    ["confirmed", "confirmed"],
    ["with_commitments", "with_commitments"],
    ["budget_scenario", "budget_scenario"],
    ["nonsense", "with_commitments"],   // falls back rather than refusing
    [undefined, "with_commitments"],
  ]) {
    const { body } = await call(q(company, asked));
    expect(body.layer).toBe(expected);
    expect(body.layerLabel).toBeTruthy();
  }
});

/* ═══ CONFIRMED ═══════════════════════════════════════════════════════════ */

test("confirmed excludes commitments AND the budget plan", async () => {
  const s = await seed();
  await commit({ ...s });

  const { body } = await call(q(s.company, "confirmed"));
  expect(body.totals.sources.commitmentOutflows).toBe(0);
  expect(body.totals.sources.plannedOutflows).toBe(0);
  expect(body.totals.sources.plannedInflows).toBe(0);
  expect(body.inclusion.includedCommitments).toBe(0);
  expect(body.inclusion.includedPlannedItems).toBe(0);
});

test("and its figures are identical to the layers above it", async () => {
  /* Not similar. The same — or the three cannot be compared. */
  const s = await seed();
  await commit({ ...s });

  const [confirmed, committed, scenario] = await Promise.all([
    call(q(s.company, "confirmed")),
    call(q(s.company, "with_commitments")),
    call(q(s.company, "budget_scenario")),
  ]);
  for (const other of [committed, scenario]) {
    expect(other.body.totals.sources.openPayables).toBe(confirmed.body.totals.sources.openPayables);
    expect(other.body.totals.sources.openReceivables).toBe(confirmed.body.totals.sources.openReceivables);
    expect(other.body.totals.confirmed).toBe(confirmed.body.totals.confirmed);
  }
});

/* ═══ COMMITTED ═══════════════════════════════════════════════════════════ */

test("with_commitments includes a live dated commitment, but no budget plan", async () => {
  const s = await seed();
  await commit({ ...s, amount: 40000 });

  const { body } = await call(q(s.company, "with_commitments"));
  expect(body.totals.sources.commitmentOutflows).toBe(40000);
  expect(body.inclusion.includedCommitments).toBe(1);
  /* The raw budget line is NOT in this layer. */
  expect(body.totals.sources.plannedOutflows).toBe(0);
});

test("a request that finance has not approved is not a commitment", async () => {
  /* An ask is not an agreement. Only a commitment row reaches the forecast,
     and only finance's approval creates one. */
  const s = await seed();
  await SpendRequest.create({
    title: "Pending ask", requestType: "SERVICE",
    requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Rutu",
    requestedById: "EMX", department: "Tech",
    companyId: s.company._id, ledgerId: s.software._id, ledgerName: s.software.name,
    purpose: "x",
    items: [{ name: "L", whyNeeded: "y", quantity: 1, unit: "u", rate: 55000, amount: 55000 }],
    totalAmount: 55000, status: "pending_finance",
    budgetCycleId: s.budget._id, budgetLineId: s.line._id, budgetMatchStatus: "matched",
  });

  const { body } = await call(q(s.company, "with_commitments"));
  expect(body.totals.sources.commitmentOutflows).toBe(0);
});

test("a released commitment is excluded and counted — its voucher is the confirmed item", async () => {
  const s = await seed();
  await commit({ ...s, status: "released" });

  const { body } = await call(q(s.company, "with_commitments"));
  expect(body.totals.sources.commitmentOutflows).toBe(0);
  expect(body.inclusion.releasedCommitmentsExcluded).toBe(1);
});

test("an undated commitment is excluded, and reported rather than silently dropped", async () => {
  const s = await seed();
  await commit({ ...s, expectedPaymentDate: null, amount: 33000 });

  const { body } = await call(q(s.company, "with_commitments"));
  expect(body.totals.sources.commitmentOutflows).toBe(0);
  expect(body.inclusion.undatedCommitments).toBe(1);
  expect(body.inclusion.undatedCommitmentAmount).toBe(33000);
});

/* ═══ THE SCENARIO ════════════════════════════════════════════════════════ */

test("budget_scenario adds the plan: expenses as outflows, revenue as inflows", async () => {
  const s = await seed({ softwarePlan: 100000, revenuePlan: 250000 });

  const { body } = await call(q(s.company, "budget_scenario"));
  expect(body.totals.sources.plannedOutflows).toBe(100000);
  expect(body.totals.sources.plannedInflows).toBe(250000);
  expect(body.hasBudgetPlan).toBe(true);
});

test("A COMMITMENT REDUCES THE PLANNED REMAINDER, IT DOES NOT ADD TO IT", async () => {
  /* The rule this whole layer turns on. ₹1,00,000 planned with a ₹40,000
     approved request against the same line and month is ₹1,00,000 of expected
     spending — ₹40,000 committed and ₹60,000 still only planned. */
  const s = await seed({ softwarePlan: 100000 });
  await commit({ ...s, amount: 40000, expectedPaymentDate: inDays(20) });

  const { body } = await call(q(s.company, "budget_scenario"));
  expect(body.totals.sources.commitmentOutflows).toBe(40000);
  expect(body.totals.sources.plannedOutflows).toBe(60000);
  /* And together they are the plan, not the plan plus the commitment. */
  expect(
    body.totals.sources.commitmentOutflows + body.totals.sources.plannedOutflows,
  ).toBe(100000);
});

test("a line fully covered by commitments adds no planned remainder at all", async () => {
  const s = await seed({ softwarePlan: 100000 });
  await commit({ ...s, amount: 100000, expectedPaymentDate: inDays(20) });

  const { body } = await call(q(s.company, "budget_scenario"));
  expect(body.totals.sources.plannedOutflows).toBe(0);
  expect(body.totals.sources.commitmentOutflows).toBe(100000);
});

test("a released commitment does NOT reduce the plan — nothing replaced it here", async () => {
  /* Released means a voucher exists, and that voucher is a confirmed item.
     With no voucher in this fixture the plan stands at its full amount, which
     is the honest answer: the money has not been agreed and has not been paid. */
  const s = await seed({ softwarePlan: 100000 });
  await commit({ ...s, amount: 40000, status: "released", expectedPaymentDate: inDays(20) });

  const { body } = await call(q(s.company, "budget_scenario"));
  expect(body.totals.sources.commitmentOutflows).toBe(0);
  expect(body.totals.sources.plannedOutflows).toBe(100000);
});

test("a company with no budget at all says so rather than drawing an empty scenario", async () => {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `No Plan ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const { body } = await call(q(company, "budget_scenario"));
  expect(body.hasBudgetPlan).toBe(false);
  expect(body.totals.sources.plannedOutflows).toBe(0);
});

test("the totals carry the three-way split so a net figure can be read apart", async () => {
  const s = await seed({ softwarePlan: 100000, revenuePlan: 250000 });
  await commit({ ...s, amount: 40000, expectedPaymentDate: inDays(20) });

  const { body } = await call(q(s.company, "budget_scenario"));
  expect(body.totals).toHaveProperty("confirmed");
  expect(body.totals.committed).toBe(-40000);
  expect(body.totals.planned).toBe(250000 - 60000);
});
