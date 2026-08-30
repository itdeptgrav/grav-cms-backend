// test/accountant/budget-request-context.route.test.js
//
// WHETHER AGREEING A DEPARTMENT'S ASK IS SAFE — over a real HTTP round trip.
//
// What this proves that services/budgetRequestContext.test.js cannot: that the
// figures on the desk are the same figures the rest of the budget module
// produces. The service test hands `buildOne` its numbers; this one makes the
// route go and find them — real allocations, real posted vouchers, real
// commitments — and checks what comes back out of the endpoint.
//
// The four scenarios are the ones finance actually meets:
//
//   a safe expense ask        room on the head, nothing alarming
//   an overspent head         already spent past what agreeing would allow
//   a revenue target ask      target / earned / achieved, and no word of spend
//   a head that is not a head yet
//
// ── AND THAT NOTHING ELSE CHANGED ───────────────────────────────────────────
// The context is opt-in. The last group asserts the endpoint without
// `?context=1` returns exactly the shape it always returned, because every
// other caller of it is still relying on that.
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
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant/budgets`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

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

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * A cycle carrying four asks — one of each shape finance meets.
 *
 * Tech's Repairs head has ₹1,00,000 allocated and ₹2,00,000 already spent, so
 * agreeing another ₹40,000 still leaves it short. Software has ₹1,00,000 and
 * ₹10,000 spent, which is the safe one.
 */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Desk Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: "Direct Income", nature: "revenue",
  });
  const mk = (name, g) =>
    Acc_Ledger.create({
      companyId: company._id, name: `${name} ${n}`, groupId: g._id,
      groupName: g.name, nature: g.nature,
    });

  const software = await mk("Software Subscription", expGroup);
  const repairs = await mk("Repairs & Maintenance", expGroup);
  const exportSales = await mk("Export Sales", revGroup);

  /* ₹10,000 spent on Software, ₹2,00,000 on Repairs, ₹1,20,000 earned on
     Export Sales. Posted vouchers, so the actuals are the module's own. */
  const spend = (ledger, amount) =>
    Acc_Voucher.create({
      companyId: company._id, voucherType: "payment", voucherNumber: `PV-${n}-${amount}`,
      voucherDate: new Date("2026-05-10"), status: "posted", grandTotal: amount,
      ledgerEntries: [
        { ledgerId: ledger._id, ledgerName: ledger.name, type: "Dr", amount },
        { ledgerId: ledger._id, ledgerName: ledger.name, type: "Cr", amount: 0 },
      ],
    });
  const earn = (ledger, amount) =>
    Acc_Voucher.create({
      companyId: company._id, voucherType: "sales", voucherNumber: `SV-${n}-${amount}`,
      voucherDate: new Date("2026-05-10"), status: "posted", grandTotal: amount,
      ledgerEntries: [
        { ledgerId: ledger._id, ledgerName: ledger.name, type: "Cr", amount },
        { ledgerId: ledger._id, ledgerName: ledger.name, type: "Dr", amount: 0 },
      ],
    });

  await Promise.all([
    spend(software, 10000),
    spend(repairs, 200000),
    earn(exportSales, 120000),
  ]);

  const budget = await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "review", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "Tech", allocatedAmount: 100000 },
      { ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense",
        department: "Tech", allocatedAmount: 100000 },
      { ledgerId: exportSales._id, ledgerName: exportSales.name, nature: "revenue",
        department: "Sales", allocatedAmount: 2000000 },
    ],
    budgetRequests: [
      { department: "Tech", ledgerId: software._id, ledgerName: software.name,
        nature: "expense", requestedAmount: 40000, state: "submitted",
        purpose: "Two more seats", submittedBy: "rutu@demo.example",
        workingLines: [
          { description: "Seats", quantity: 2, unit: "seat", rate: 20000, amount: 40000 },
        ] },
      { department: "Tech", ledgerId: repairs._id, ledgerName: repairs.name,
        nature: "expense", requestedAmount: 40000, state: "submitted",
        purpose: "Compressor AMC", submittedBy: "rutu@demo.example" },
      { department: "Sales", ledgerId: exportSales._id, ledgerName: exportSales.name,
        nature: "revenue", requestedAmount: 300000, state: "submitted",
        purpose: "New market", submittedBy: "meera@demo.example" },
      { department: "Ops", ledgerName: "Drone hire", nature: "expense",
        requestedAmount: 75000, state: "submitted", purpose: "Roof survey",
        requestedHead: { name: "Drone hire", state: "requested" },
        submittedBy: "bikash@demo.example" },
    ],
  });

  return { company, budget, software, repairs, exportSales };
}

const ctxOf = (body, i) => body.contexts[String(body.requests[i]._id)];

/* ═══ AN EXPENSE ASK ══════════════════════════════════════════════════════ */

describe("an expense request", () => {
  test("carries approved, spent, committed, available and after-approval", async () => {
    const { company, budget } = await seed();
    const { status, body } = await call(
      `/${budget._id}/requests?context=1&companyId=${company._id}`,
    );
    expect(status).toBe(200);

    const c = ctxOf(body, 0); // Software: 1,00,000 approved, 10,000 spent
    expect(c.kind).toBe("expense");
    expect(c.approved).toBe(100000);
    expect(c.actual).toBe(10000);
    expect(c.committed).toBe(0);
    expect(c.availableBefore).toBe(90000);
    // Agreeing RAISES the envelope — a budget request asks to be allocated.
    expect(c.approvedAfter).toBe(140000);
    expect(c.availableAfter).toBe(130000);
    expect(c.usageAfterPct).toBeCloseTo(7.1, 1);
    expect(c.verdictLabel).toBe("Within budget");
  });

  test("a head already spent past the new envelope reads as a risk", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);

    const c = ctxOf(body, 1); // Repairs: 1,00,000 approved, 2,00,000 spent
    expect(c.approved).toBe(100000);
    expect(c.actual).toBe(200000);
    expect(c.availableBefore).toBe(-100000);
    expect(c.availableAfter).toBe(-60000);
    expect(c.verdict).toBe("exceeds");
    expect(c.verdictLabel).toBe("Will exceed budget");
    expect(c.usageAfterPct).toBeGreaterThan(100);
  });

  test("the head is read for the REQUESTER's department, not any department", async () => {
    // One ledger can be budgeted for four departments; a Tech ask answered with
    // Merchandising's line would be answered with somebody else's money.
    const { company, budget, software } = await seed();
    await Acc_Budget.updateOne(
      { _id: budget._id },
      { $push: { items: {
        ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "Merchandising", allocatedAmount: 5000000,
      } } },
    );

    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    // Still Tech's 1,00,000, not 51,00,000.
    expect(ctxOf(body, 0).approved).toBe(100000);
  });
});

/* ═══ A REVENUE ASK ═══════════════════════════════════════════════════════ */

describe("a revenue target request", () => {
  test("speaks target and earned, and never spend or over-budget", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);

    const c = ctxOf(body, 2); // Export Sales: 20,00,000 target, 1,20,000 earned
    expect(c.kind).toBe("revenue");
    expect(c.target).toBe(2000000);
    expect(c.earned).toBe(120000);
    expect(c.targetAfter).toBe(2300000);
    expect(c.toGo).toBe(2180000);
    expect(c.achievedPct).toBeCloseTo(5.2, 1);
    // Compared before-against-after, not ask-against-standing: agreeing adds a
    // line rather than replacing one, so ₹3L on a ₹20L head RAISES it.
    expect(c.direction).toBe("increased");
    expect(c.verdictLabel).toBe("Revenue target change");

    // The expense vocabulary is not merely unused — it is not on the shape, so
    // a screen cannot read a number that means something else.
    expect(c.availableAfter).toBeUndefined();
    expect(c.approved).toBeUndefined();
    expect(c.usageAfterPct).toBeUndefined();
    expect(c.verdict).not.toBe("exceeds");
  });
});

/* ═══ A HEAD THAT IS NOT A HEAD YET ═══════════════════════════════════════ */

describe("a new or unbudgeted head", () => {
  test("is marked, and carries no invented figures", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);

    const c = ctxOf(body, 3);
    expect(c.kind).toBe("no_head");
    expect(c.verdictLabel).toBe("No approved budget head");
    expect(c.hasHead).toBe(false);
    // Zeroes would render as "no budget used" rather than "nobody has decided
    // what this posts against".
    expect(c.approved).toBeUndefined();
    expect(c.availableAfter).toBeUndefined();
  });
});

/* ═══ THE HEADLINE ════════════════════════════════════════════════════════ */

describe("the summary", () => {
  test("splits expense from revenue and names the biggest risk", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const s = body.summary;

    expect(s.waiting).toBe(4);
    // 40,000 Software + 40,000 Repairs + 75,000 unresolved head. The revenue
    // ask is NOT in here — adding a target to an envelope is meaningless.
    expect(s.requestedExpense).toBe(155000);
    expect(s.requestedRevenue).toBe(300000);
    expect(s.unresolvedHeads).toBe(1);
    expect(s.exceeding).toBe(1);

    expect(s.biggestRisk.verdict).toBe("exceeds");
    expect(s.biggestRisk.department).toBe("Tech");
    expect(s.biggestRisk.ledgerName).toMatch(/Repairs/);
    expect(s.biggestRisk.shortfall).toBe(60000);
  });

  test("planned net and net-after-pending are both reported", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    // 20,00,000 revenue − 2,00,000 expense allocated.
    expect(body.summary.plannedNet).toBe(1800000);
    // + 3,00,000 asked in targets − 1,55,000 asked in spend.
    expect(body.summary.netAfterPending).toBe(1945000);
  });
});

/* ═══ THE SHAPE OF THE YEAR ═══════════════════════════════════════════════ */

describe("the monthly series", () => {
  test("covers every month of the cycle, including the quiet ones", async () => {
    // A chart that skipped empty months would compress the gaps and misdraw
    // the shape of the year.
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const m = body.summary.monthly;

    expect(m).toHaveLength(12);
    expect(m[0].key).toBe("2026-04");
    expect(m[11].key).toBe("2027-03");
  });

  test("keeps plan, actual and pending apart — they are three kinds of fact", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const m = body.summary.monthly;

    // The cycle's own allocations, spread evenly over twelve months.
    const plannedRevenue = m.reduce((n, x) => n + x.plannedRevenue, 0);
    const plannedExpense = m.reduce((n, x) => n + x.plannedExpense, 0);
    expect(Math.round(plannedRevenue)).toBe(2000000);
    expect(Math.round(plannedExpense)).toBe(200000);

    // What actually moved, in the month the vouchers were posted.
    const may = m.find((x) => x.key === "2026-05");
    expect(may.actualExpense).toBe(210000);
    expect(may.actualRevenue).toBe(120000);
    // And nothing moved in a month nothing was posted in.
    expect(m.find((x) => x.key === "2026-09").actualExpense).toBe(0);

    // The waiting requests, on top of the plan and never mixed into it.
    const pendingExpense = m.reduce((n, x) => n + x.pendingExpense, 0);
    const pendingRevenue = m.reduce((n, x) => n + x.pendingRevenue, 0);
    expect(Math.round(pendingExpense)).toBe(155000);
    expect(Math.round(pendingRevenue)).toBe(300000);
  });

  test("each month carries three nets, because there are three questions", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const may = body.summary.monthly.find((x) => x.key === "2026-05");

    expect(may.plannedNet).toBeCloseTo(may.plannedRevenue - may.plannedExpense, 2);
    expect(may.actualNet).toBe(120000 - 210000);
    expect(may.netAfterPending).toBeCloseTo(
      may.plannedRevenue + may.pendingRevenue - may.plannedExpense - may.pendingExpense,
      2,
    );
  });

  test("a request phased across chosen months lands in those months", async () => {
    // A department that phased its ask across three months is not asking for
    // the money in April, and drawing it there would invent a cash problem.
    const { company, budget } = await seed();
    await Acc_Budget.updateOne(
      { _id: budget._id, "budgetRequests.department": "Ops" },
      {
        $set: {
          "budgetRequests.$.phasingMode": "custom_monthly",
          "budgetRequests.$.monthlyPhasing": [
            { month: "2026-08", amount: 50000 },
            { month: "2026-09", amount: 25000 },
          ],
        },
      },
    );

    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const m = body.summary.monthly;
    const aug = m.find((x) => x.key === "2026-08");
    const sep = m.find((x) => x.key === "2026-09");
    const apr = m.find((x) => x.key === "2026-04");

    // The Ops ask sits where it was phased; only the two evenly-spread Tech
    // asks reach April.
    expect(aug.pendingExpense).toBeGreaterThan(apr.pendingExpense);
    expect(Math.round(aug.pendingExpense - apr.pendingExpense)).toBe(50000);
    expect(Math.round(sep.pendingExpense - apr.pendingExpense)).toBe(25000);
  });

  test("the running position is read off the series, and names the month it goes under", async () => {
    // A dip in one column of twelve is easy to miss, which is the whole point
    // of computing it rather than leaving it to be spotted.
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const s = body.summary;

    // 20L target against 2L spend plus 1.55L asked: comfortably in surplus, so
    // there is no month it goes under and the reading says so with a null.
    expect(s.firstDeficitMonth).toBeNull();
    expect(s.closingPosition).toBeCloseTo(s.netAfterPending, 0);
    expect(s.worstMonth.key).toBe("2026-04");
  });

  test("a cycle with no revenue at all goes under in its first month", async () => {
    const { company, budget } = await seed();
    // Drop the revenue target; the year is now spend and asks only.
    await Acc_Budget.updateOne(
      { _id: budget._id },
      { $pull: { items: { nature: "revenue" } } },
    );

    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const s = body.summary;
    expect(s.firstDeficitMonth).not.toBeNull();
    expect(s.firstDeficitMonth.key).toBe("2026-04");
    expect(s.closingPosition).toBeLessThan(0);
    // The lowest point of a monotonically falling year is its last month.
    expect(s.worstMonth.key).toBe("2027-03");
  });
});

/* ═══ AND NOTHING ELSE MOVED ══════════════════════════════════════════════ */

describe("the endpoint without the flag", () => {
  test("returns exactly what it always returned", async () => {
    const { company, budget } = await seed();
    const { status, body } = await call(`/${budget._id}/requests?companyId=${company._id}`);

    expect(status).toBe(200);
    expect(body.requests).toHaveLength(4);
    expect(body.budgetStatus).toBe("review");
    // Opt-in: every other caller of this endpoint still gets the old shape.
    expect(body.contexts).toBeUndefined();
    expect(body.summary).toBeUndefined();
  });

  test("the existing filters still work, with and without context", async () => {
    const { company, budget } = await seed();
    const plain = await call(`/${budget._id}/requests?department=Tech&companyId=${company._id}`);
    expect(plain.body.requests).toHaveLength(2);

    const withCtx = await call(
      `/${budget._id}/requests?department=Tech&context=1&companyId=${company._id}`,
    );
    expect(withCtx.body.requests).toHaveLength(2);
    // The context covers the filtered set, not the whole cycle.
    expect(Object.keys(withCtx.body.contexts)).toHaveLength(2);
    expect(withCtx.body.summary.waiting).toBe(2);
  });

  test("the working rows the review page needs are still on the request", async () => {
    const { company, budget } = await seed();
    const { body } = await call(`/${budget._id}/requests?context=1&companyId=${company._id}`);
    const r = body.requests[0];
    expect(r.workingLines).toHaveLength(1);
    expect(r.workingLines[0]).toMatchObject({ quantity: 2, unit: "seat", rate: 20000 });
    expect(r.purpose).toBe("Two more seats");
  });
});
