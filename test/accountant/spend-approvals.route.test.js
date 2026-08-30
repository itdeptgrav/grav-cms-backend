// test/accountant/spend-approvals.route.test.js
//
// PAYABLES → SPEND APPROVALS.
//
// ── THE DISTINCTION UNDER TEST ──────────────────────────────────────────────
// Budgets → Department submissions is a PLANNING conversation: a department
// arguing in March for next year's envelope. Payables → Spend approvals is an
// OPERATIONAL one: one purchase, priced by Store against a named vendor, that
// becomes a payable the moment finance agrees.
//
// They live in different collections and always did — a budget proposal is a
// row inside `Acc_Budget.budgetRequests[]` and this is a `SpendRequest` — so
// the first group here is a guard rather than a fix: it proves a Store-priced
// purchase cannot leak into the planning queue, and that the planning queue
// still answers with its own rows.
//
// ── AND THE ONE THAT MATTERS MOST ───────────────────────────────────────────
// Approving is the moment money is promised: it writes a budget commitment.
// There are now two doors onto that decision, and the last group proves they
// are the same decision — same gate, same commitment, same record — because
// both call one service rather than keeping a copy of the rule.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Not authenticated" });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));
jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    req.user = JSON.parse(req.headers["x-test-user"] || "{}");
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");

let server, base, seq = 0;

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
  permissions: { canView: true, canEdit: true, canApprove: true },
};
const EDITOR = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Ed Editor",
  email: "ed.editor@example.com",
  role: "editor",
  permissions: { canView: true, canEdit: true },
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/spend-approvals", require("../../routes/Accountant_Routes/Acc_spendApprovals"));
  /* The planning queue, mounted alongside so "it does not appear there" is an
     assertion about a real endpoint rather than about the absence of one. */
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (user, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * One active budget with an approved head, one department employee, and a
 * Store-priced purchase sitting at finance — the state Payables opens on.
 *
 * The budget also carries a `budgetRequests[]` row: a department's ANNUAL ask,
 * which is the thing this queue must never show and the planning queue must
 * still show.
 */
async function seed({ priced = true } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Payables Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const consumables = await Acc_Ledger.create({
    companyId: company._id, name: `Consumables ${n}`,
    groupId: group._id, groupName: group.name, nature: "expense",
  });
  const budget = await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: consumables._id, ledgerName: consumables.name, nature: "expense",
              department: "Tech", allocatedAmount: 100000 }],
    /* Next year's envelope, argued for by the department. A different kind of
       thing entirely, and the reason these two queues are separate. */
    budgetRequests: [{
      department: "Tech", ledgerId: consumables._id, ledgerName: consumables.name,
      nature: "expense", requestedAmount: 250000,
      purpose: "More machine consumables next year", state: "submitted",
    }],
  });

  const emp = await Employee.create({
    firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `TC${n}`, department: "Tech",
  });

  const lines = [{
    name: "Cutting blade", whyNeeded: "The old ones failed inspection",
    quantity: 6, unit: "pcs", rate: priced ? 250 : 0, amount: priced ? 1500 : 0,
  }];
  const spend = await SpendRequest.create({
    title: "MRF-2609-0001 — balance to buy",
    requestType: "PRODUCT",
    purpose: "The old ones failed inspection",
    requestedBy: emp._id, requestedByName: "Rutu", requestedById: emp.biometricId,
    department: "Tech", companyId: company._id,
    ledgerId: consumables._id, ledgerName: consumables.name,
    budgetCycleId: budget._id, budgetLineId: budget.items[0]._id,
    budgetFinancialYear: "2026-27", budgetDepartment: "Tech",
    budgetMatchStatus: "matched",
    budgetSnapshot: {
      approved: 100000, committedBefore: 0, actual: 0,
      availableBefore: 100000, requested: priced ? 1500 : 0,
      availableAfter: priced ? 98500 : 100000,
    },
    vendorName: "Sharma Engineering",
    gstin: "21AAAAA0000A1Z5",
    items: lines,
    totalAmount: priced ? 1500 : 0,
    ...(priced
      ? {
          gstPercent: 18, taxAmount: 270, grandTotal: 1770,
          expectedDeliveryDate: new Date("2026-09-20"),
          pricedByName: "Bikash Store", pricedAt: new Date(),
        }
      : {}),
    sourceMrfId: new mongoose.Types.ObjectId(),
    sourceMrfNumber: `MRF-2609-000${n}`,
    tlApprovedByName: "Meera", tlApprovedAt: new Date(),
    status: "pending_finance",
    submittedAt: new Date(),
  });

  return { company, consumables, budget, emp, spend };
}

/* ═══ 1 · THE TWO QUEUES ARE DIFFERENT QUEUES ═════════════════════════════ */

describe("planning and operational spend stay apart", () => {
  test("a Store-priced purchase is in Payables", async () => {
    const s = await seed();
    const { status, body } = await call(OWNER, "/spend-approvals");
    expect(status).toBe(200);
    expect(body.requests.map((r) => r.requestNumber)).toContain(s.spend.requestNumber);
  });

  test("and is NOT in Budget department submissions", async () => {
    /* The planning queue reads `Acc_Budget.budgetRequests[]`. A spend request
       is a different collection and must never surface there — a purchase
       order in a planning meeting is a category error, not a filter mistake. */
    const s = await seed();
    const { body } = await call(OWNER, `/budgets/${s.budget._id}/requests`);
    const numbers = JSON.stringify(body.requests || []);
    expect(numbers).not.toContain(s.spend.requestNumber);
    expect(numbers).not.toContain("Sharma Engineering");
  });

  test("the planning queue still answers with its own row", async () => {
    /* The other half of the guard: keeping them apart must not have emptied
       the queue that was always right. */
    const s = await seed();
    const { body } = await call(OWNER, `/budgets/${s.budget._id}/requests`);
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({ department: "Tech", requestedAmount: 250000 });
  });

  test("and a budget proposal is not in Payables", async () => {
    const s = await seed();
    const { body } = await call(OWNER, "/spend-approvals");
    expect(body.requests.every((r) => r.requestNumber?.startsWith("SPR-"))).toBe(true);
    expect(JSON.stringify(body.requests)).not.toContain("More machine consumables next year");
  });
});

/* ═══ 2 · WHAT THE LIST SAYS ══════════════════════════════════════════════ */

describe("the queue", () => {
  test("carries everything the row has to be triaged on", async () => {
    const s = await seed();
    const { body } = await call(OWNER, "/spend-approvals");
    const row = body.requests.find((r) => r.requestNumber === s.spend.requestNumber);

    expect(row).toMatchObject({
      sourceMrfNumber: s.spend.sourceMrfNumber,
      requestedByName: "Rutu",
      department: "Tech",
      vendorName: "Sharma Engineering",
      requestTypeLabel: "Product",
      totalAmount: 1500,
      taxAmount: 270,
      grandTotal: 1770,
      gstPercent: 18,
      status: "pending_finance",
      priced: true,
    });
    expect(row.ledgerName).toMatch(/Consumables/);
    expect(row.expectedDeliveryDate).toBeTruthy();
  });

  test("counts what is answerable apart from what is not", async () => {
    await seed({ priced: true });
    await seed({ priced: false });
    const { body } = await call(OWNER, "/spend-approvals");
    expect(body.counts.total).toBe(2);
    expect(body.counts.priced).toBe(1);
    expect(body.counts.unpriced).toBe(1);
    /* Only the answerable one is money the company is about to owe. */
    expect(body.counts.payable).toBe(1770);
  });

  test("holds nothing that is not waiting on finance", async () => {
    const s = await seed();
    await SpendRequest.updateOne({ _id: s.spend._id }, { $set: { status: "approved" } });
    const { body } = await call(OWNER, "/spend-approvals");
    expect(body.requests).toHaveLength(0);
  });

  test("a request with no source MRF still renders", async () => {
    /* Raised straight through the purchase door, before any of this existed.
       Hiding a payable because it has no MRF number would be worse than
       showing one without it. */
    const s = await seed();
    await SpendRequest.updateOne({ _id: s.spend._id }, { $unset: { sourceMrfId: 1, sourceMrfNumber: 1 } });
    const { body } = await call(OWNER, "/spend-approvals");
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].sourceMrfNumber).toBeNull();
    expect(body.requests[0].priced).toBe(true);
  });
});

/* ═══ 3 · WHAT THE DETAIL SAYS ════════════════════════════════════════════ */

describe("the detail", () => {
  test("shows the ask, the pricing and the live position as three things", async () => {
    const s = await seed();
    const { status, body } = await call(OWNER, `/spend-approvals/${s.spend._id}`);
    expect(status).toBe(200);

    /* The department's words. */
    expect(body.request.ask).toMatchObject({
      requestedByName: "Rutu", department: "Tech", tlApprovedByName: "Meera",
    });
    expect(body.request.ask.purpose).toMatch(/failed inspection/);

    /* Store's commercial work. */
    expect(body.request.pricing).toMatchObject({
      vendorName: "Sharma Engineering", gstPercent: 18,
      subtotal: 1500, taxAmount: 270, grandTotal: 1770,
      pricedByName: "Bikash Store",
    });
    expect(body.request.pricing.lines[0]).toMatchObject({
      name: "Cutting blade", quantity: 6, unit: "pcs", rate: 250, amount: 1500,
    });

    /* And the envelope, read LIVE — not the snapshot Store was looking at. */
    expect(body.request.position).toMatchObject({
      approved: 100000, actual: 0, committed: 0,
      availableBefore: 100000, requested: 1770, availableAfter: 98230,
    });
  });

  test("the position is today's, not the one stored at pricing time", async () => {
    const s = await seed();
    /* Finance cuts the head after Store priced it. The snapshot on the request
       still says 100000 — the live read must not. */
    await Acc_Budget.updateOne(
      { _id: s.budget._id, "items.ledgerId": s.consumables._id },
      { $set: { "items.$.allocatedAmount": 2000 } },
    );
    const { body } = await call(OWNER, `/spend-approvals/${s.spend._id}`);
    expect(body.request.position.approved).toBe(2000);
    expect(body.request.position.availableAfter).toBe(230);
  });

  test("an unpriced request says why it cannot be approved", async () => {
    const s = await seed({ priced: false });
    const { body } = await call(OWNER, `/spend-approvals/${s.spend._id}`);
    expect(body.request.priced).toBe(false);
    expect(body.request.pricingMessage).toMatch(/has not been priced yet/);
  });
});

/* ═══ 4 · THE DECISION ════════════════════════════════════════════════════ */

describe("approving from the books", () => {
  test("a priced request is approved and the money is committed", async () => {
    const s = await seed();
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body.request.status).toBe("approved");

    const doc = await SpendRequest.findById(s.spend._id).lean();
    expect(doc.financeApprovedByName).toBe("Priya Owner");
    expect(doc.budgetApprovalKind).toBe("within_budget");

    /* The whole point of the approval. */
    const commitment = await Commitment.findOne({ spendRequestId: s.spend._id }).lean();
    expect(commitment).toBeTruthy();
        /* ── THIS FIGURE CHANGED, AND IS NOW THE RIGHT ONE ──────────────────
       The commitment used to reserve `totalAmount` — the SUBTOTAL. This
       fixture carries 18% GST, so a request that will cost ₹1770 reserved only
       ₹1500, and the tax appeared when the voucher posted, putting the head over
       by an amount nobody had promised. It now reserves what will actually
       leave the bank. */
    expect(commitment.amount).toBe(1770);
    expect(commitment.status).toBe("committed");
  });

  test("an unpriced request cannot be approved", async () => {
    const s = await seed({ priced: false });
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NOT_PRICED");
    expect(await Commitment.countDocuments({})).toBe(0);

    const doc = await SpendRequest.findById(s.spend._id).lean();
    expect(doc.status).toBe("pending_finance");
  });

  test("but it can be rejected, with a reason", async () => {
    const s = await seed({ priced: false });
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/reject`, {
      method: "POST", body: { note: "Use the grade we already stock" },
    });
    expect(r.status).toBe(200);
    const doc = await SpendRequest.findById(s.spend._id).lean();
    expect(doc.status).toBe("rejected");
    expect(doc.decisionNote).toMatch(/already stock/);
    expect(await Commitment.countDocuments({})).toBe(0);
  });

  test("a rejection without a reason is refused", async () => {
    const s = await seed();
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/reject`, { method: "POST" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("NEEDS_REASON");
  });

  test("an editor may write vouchers but may not agree to spend", async () => {
    /* Entering a voucher is not the same as agreeing to the money, and the
       accounting module already draws that line for its own writes. */
    const s = await seed();
    const r = await call(EDITOR, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/owner's or an approver's call/);
  });

  test("nobody approves their own request", async () => {
    const s = await seed();
    /* The two doors identify people differently; the address is the only thing
       an accounting user and a CMS employee share. */
    const self = { ...OWNER, email: s.emp.email };
    const r = await call(self, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/your own request/i);
  });

  test("approving twice does not promise the money twice", async () => {
    const s = await seed();
    await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    const again = await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    /* It is no longer at finance, so there is nothing to answer. */
    expect(again.status).toBe(400);
    expect(again.body.code).toBe("WRONG_STATE");
    expect(await Commitment.countDocuments({ spendRequestId: s.spend._id })).toBe(1);
  });

  test("an over-budget approval is allowed and goes on the record as one", async () => {
    /* Finance may always say yes. What changes is what it is recorded as —
       the distinction that matters when somebody asks how the year went over. */
    const s = await seed();
    await SpendRequest.updateOne(
      { _id: s.spend._id },
      { $set: { "budgetSnapshot.availableAfter": -500 } },
    );
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    expect(r.status).toBe(200);
    const doc = await SpendRequest.findById(s.spend._id).lean();
    expect(doc.budgetApprovalKind).toBe("over_budget");
  });
});

/* ═══ OVER BUDGET GOES BACK TO THE REQUESTER, NOT TO STORE ══════════════════
 *
 * ── THE POLICY ──────────────────────────────────────────────────────────────
 * Store is the fulfilment and commercial medium. They match stock and price a
 * quote; whether the department can afford that quote is finance's question.
 * So an overrun never stops Store sending a quote, and it never goes back to
 * Store to be justified — it goes back to the person who asked, who is the
 * only one who can trim the ask, move it to another head, or argue for more
 * money.
 *
 * ── AND WHY IT IS NOT A REJECTION ───────────────────────────────────────────
 * A rejection says no to the need. This says nothing about the need and
 * nothing about the quote: it says the figure does not fit the head. Parking
 * that in `rejected` ends the request and invites an identical one next week.
 */
describe("the budget exception", () => {
  test("finance sees the overrun as a figure, not just a negative balance", async () => {
    const s = await seed();
    const { body } = await call(OWNER, `/spend-approvals/${s.spend._id}`);
    expect(body.request.position).toMatchObject({ overrun: 0 });
    // Within budget, so the overrun is zero rather than absent — a missing
    // field reads as "not calculated".
    expect(body.request.position.availableAfter).toBeGreaterThanOrEqual(0);
  });

  test("finance can send it back over the figure, and it is not a rejection", async () => {
    const s = await seed();
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/budget-exception`, {
      method: "POST",
      body: { note: "This is 40% over the head. Trim it or move it to Consumables." },
    });

    expect(r.status).toBe(200);
    const doc = await SpendRequest.findById(s.spend._id).lean();
    expect(doc.status).toBe("budget_exception");
    expect(doc.status).not.toBe("rejected");
    expect(doc.budgetExceptionByName).toBe("Priya Owner");
    expect(doc.budgetExceptionNote).toMatch(/Trim it/);
    // Recorded, not recomputed: the head moves as others commit against it.
    expect(doc.budgetExceptionAvailable).toBe(100000);

    // No commitment is raised — nothing was approved.
    const commitment = await Commitment.findOne({ spendRequestId: s.spend._id }).lean();
    expect(commitment).toBeNull();
  });

  test("a reason is required — an unexplained send-back invites the same request again", async () => {
    const s = await seed();
    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/budget-exception`, {
      method: "POST",
      body: { note: "   " },
    });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/what the requester needs to change/i);
  });

  test("an overrun never blocks approval — finance may always say yes", async () => {
    const s = await seed();
    /* Push the quote far past the head. The point of this test is that the
       route does NOT refuse: an overrun is a fact finance records, not a gate
       the system enforces on them. */
    await SpendRequest.updateOne(
      { _id: s.spend._id },
      { $set: { totalAmount: 999999, grandTotal: 999999 } },
    );

    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });
    expect(r.status).toBe(200);
    const doc = await SpendRequest.findById(s.spend._id).lean();
    expect(doc.status).toBe("approved");
  });

  test("a request already settled cannot be sent back", async () => {
    const s = await seed();
    await call(OWNER, `/spend-approvals/${s.spend._id}/approve`, { method: "POST" });

    const r = await call(OWNER, `/spend-approvals/${s.spend._id}/budget-exception`, {
      method: "POST",
      body: { note: "Too late" },
    });
    expect(r.status).toBe(409);
  });

  test("a viewer cannot raise one", async () => {
    const s = await seed();
    const r = await call(
      { ...EDITOR, role: "viewer", permissions: { canView: true } },
      `/spend-approvals/${s.spend._id}/budget-exception`,
      { method: "POST", body: { note: "Nope" } },
    );
    expect([401, 403]).toContain(r.status);
  });
});
