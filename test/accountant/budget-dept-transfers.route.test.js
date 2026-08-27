// A department asking to move approved budget between its own lines.
//
// Two rules this file protects. Asking moves nothing — the money changes hands
// in finance's approve handler and nowhere else. And availability, not
// allocation, bounds the ask: a line that has already spent its budget has
// nothing to give, however large its allocation looks.
"use strict";

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

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
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");

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

const tokenFor = (slug = "sales", email = "head@demo.example") =>
  jwt.sign({ v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: slug, email, name: "Head" }, SECRET, { expiresIn: "1h" });

const dept = (path, body, token = tokenFor()) =>
  fetch(`${deptBase}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body) =>
  fetch(`${finBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed({ status = "active" } = {}) {
  const company = await Acc_Company.create({ companyName: `Tr ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const eg = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const rg = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const a = await Acc_Ledger.create({ companyId: company._id, name: "Raw Material", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const b = await Acc_Ledger.create({ companyId: company._id, name: "Freight", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const rev = await Acc_Ledger.create({ companyId: company._id, name: "Export Sales", groupId: rg._id, groupName: rg.name, nature: "revenue" });
  const secret = await Acc_Ledger.create({ companyId: company._id, name: "Executive Travel", groupId: eg._id, groupName: eg.name, nature: "expense" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "board", name: "Board", accessSlug: "ceo" });

  const budget = await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status,
    startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: a._id, ledgerName: a.name, groupName: eg.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
      { ledgerId: b._id, ledgerName: b.name, groupName: eg.name, nature: "expense", department: "Logistics", allocatedAmount: 400000 },
      { ledgerId: rev._id, ledgerName: rev.name, groupName: rg.name, nature: "revenue", department: "Logistics", allocatedAmount: 9000000 },
      { ledgerId: secret._id, ledgerName: secret.name, groupName: eg.name, nature: "expense", department: "Board", allocatedAmount: 5000000 },
    ],
    transfers: [],
  });
  return { company, budget, ledgers: { a, b, rev },
    from: budget.items[0], to: budget.items[1], revenue: budget.items[2], theirs: budget.items[3] };
}

const askBody = (company, budget, from, to, over = {}) => ({
  companyId: company._id.toString(), budgetId: budget._id.toString(),
  fromLineId: String(from._id), toLineId: String(to._id),
  amount: 200000, reason: "Freight overran; Raw Material will not use it all.", ...over,
});

const ask = (company, budget, from, to, over = {}, token) =>
  dept("/transfers", askBody(company, budget, from, to, over), token);

/* ═══ ASKING ═══════════════════════════════════════════════════════════════ */

describe("a department asks to move its own budget", () => {
  test("a valid ask is stored pending, and moves nothing", async () => {
    const { company, budget, from, to } = await seed();
    const { status, body } = await ask(company, budget, from, to);
    expect(status).toBe(201);
    expect(body.transfer.state).toBe("submitted");
    expect(body.transfer.origin).toBe("department");
    expect(body.transfer.fromLedgerName).toBe("Raw Material");
    expect(body.transfer.toLedgerName).toBe("Freight");

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.items[0].allocatedAmount).toBe(1000000);
    expect(fresh.items[1].allocatedAmount).toBe(400000);
    expect(fresh.transfers[0].appliedAt).toBeUndefined();
    expect(fresh.transfers[0].requestedBy).toBe("head@demo.example");
  });

  test("availability, not allocation, bounds the ask", async () => {
    /* 9,00,000 already spent on a 10,00,000 line leaves 1,00,000 to give. */
    const { company, budget, from, to, ledgers } = await seed();
    await Acc_Voucher.create({
      companyId: company._id, voucherType: "payment", voucherNumber: `PV-${seq++}`,
      voucherDate: new Date("2026-05-10"), status: "posted", grandTotal: 900000,
      ledgerEntries: [
        { ledgerId: ledgers.a._id, ledgerName: ledgers.a.name, type: "Dr", amount: 900000 },
        { ledgerId: ledgers.a._id, ledgerName: ledgers.a.name, type: "Cr", amount: 0 },
      ],
    });

    const tooMuch = await ask(company, budget, from, to, { amount: 200000 });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.code).toBe("TRANSFER_EXCEEDS_AVAILABLE");
    expect(tooMuch.body.available.remaining).toBe(100000);
    expect(tooMuch.body.message).toMatch(/already spent/);

    const ok = await ask(company, budget, from, to, { amount: 100000 });
    expect(ok.status).toBe(201);
  });

  test("zero or negative is refused", async () => {
    const { company, budget, from, to } = await seed();
    expect((await ask(company, budget, from, to, { amount: 0 })).status).toBe(400);
    expect((await ask(company, budget, from, to, { amount: -1 })).status).toBe(400);
  });

  test("no reason is refused", async () => {
    const { company, budget, from, to } = await seed();
    expect((await ask(company, budget, from, to, { reason: " " })).status).toBe(400);
  });

  test("the same line on both sides is refused", async () => {
    const { company, budget, from } = await seed();
    expect((await ask(company, budget, from, from)).status).toBe(400);
  });

  test("expense to revenue is refused", async () => {
    const { company, budget, from, revenue } = await seed();
    const { status, body } = await ask(company, budget, from, revenue);
    expect(status).toBe(400);
    expect(body.message).toMatch(/different kinds of number/);
  });

  test("finance fields cannot be smuggled in", async () => {
    const { company, budget, from, to } = await seed();
    await ask(company, budget, from, to, {
      state: "approved", origin: "finance", appliedAt: new Date().toISOString(),
      reviewedBy: "someone@x.com", financeNote: "approved by me",
      requestedBy: "someone.else@example.com",
    });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    const t = fresh.transfers[0];
    expect(t.state).toBe("submitted");
    expect(t.origin).toBe("department");
    expect(t.appliedAt).toBeUndefined();
    expect(t.financeNote).toBeUndefined();
    expect(t.requestedBy).toBe("head@demo.example");
    expect(fresh.items[0].allocatedAmount).toBe(1000000);
  });
});

/* ═══ THE BOUNDARY ═════════════════════════════════════════════════════════ */

describe("scoping", () => {
  test("cannot move FROM another department's line", async () => {
    const { company, budget, theirs, to } = await seed();
    expect((await ask(company, budget, theirs, to)).status).toBe(404);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.transfers).toHaveLength(0);
  });

  test("cannot move INTO another department's line", async () => {
    const { company, budget, from, theirs } = await seed();
    expect((await ask(company, budget, from, theirs)).status).toBe(404);
  });

  test("cannot reach a budget in another company", async () => {
    /* Refused at the department gate rather than the line lookup: the caller
       holds no mapped department in that company, so there is nothing to
       resolve their slugs against. Either way nothing is written. */
    const { budget, from, to } = await seed();
    const other = await Acc_Company.create({ companyName: `Other ${seq++}`, booksFromDate: new Date("2026-04-01") });
    const { status } = await dept("/transfers", {
      companyId: other._id.toString(), budgetId: budget._id.toString(),
      fromLineId: String(from._id), toLineId: String(to._id), amount: 1, reason: "x",
    });
    expect(status).toBe(403);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.transfers).toHaveLength(0);
  });

  test("a budget id from another company is not found even when mapped there", async () => {
    /* The budget lookup is scoped by companyId, so naming our own company
       with someone else's budget id finds nothing. */
    const { company, from, to } = await seed();
    const otherSeed = await seed();
    const { status } = await dept("/transfers", {
      companyId: company._id.toString(), budgetId: otherSeed.budget._id.toString(),
      fromLineId: String(from._id), toLineId: String(to._id), amount: 1, reason: "x",
    });
    expect(status).toBe(404);
  });

  test("an unmapped portal cannot ask", async () => {
    const { company, budget, from, to } = await seed();
    const { status } = await ask(company, budget, from, to, {}, tokenFor("store", "x@y.z"));
    expect(status).toBe(403);
  });

  test("a closed budget cannot be moved between", async () => {
    const { company, budget, from, to } = await seed({ status: "closed" });
    expect((await ask(company, budget, from, to)).status).toBe(409);
  });

  test("an unusable line id is not found", async () => {
    const { company, budget, to } = await seed();
    const { status } = await dept("/transfers", {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
      fromLineId: "not-an-id", toLineId: String(to._id), amount: 1, reason: "x",
    });
    expect(status).toBe(404);
  });
});

/* ═══ WHAT CAN BE MOVED ════════════════════════════════════════════════════ */

test("available lists only this department's lines, with real availability", async () => {
  const { company, budget, ledgers } = await seed();
  await Acc_Voucher.create({
    companyId: company._id, voucherType: "payment", voucherNumber: `PV-${seq++}`,
    voucherDate: new Date("2026-05-10"), status: "posted", grandTotal: 250000,
    ledgerEntries: [
      { ledgerId: ledgers.a._id, ledgerName: ledgers.a.name, type: "Dr", amount: 250000 },
      { ledgerId: ledgers.a._id, ledgerName: ledgers.a.name, type: "Cr", amount: 0 },
    ],
  });

  const { status, body } = await dept(`/transfers/available?companyId=${company._id}`);
  expect(status).toBe(200);
  expect(body.lines).toHaveLength(3); // ours only — the Board line is absent
  expect(JSON.stringify(body)).not.toContain("Executive Travel");

  const raw = body.lines.find((l) => l.ledgerName === "Raw Material");
  expect(raw.allocated).toBe(1000000);
  expect(raw.actual).toBe(250000);
  expect(raw.available).toBe(750000);
});

/* ═══ LISTING AND WITHDRAWING ══════════════════════════════════════════════ */

describe("the list and the withdrawal", () => {
  test("only transfers touching this department appear, and theirs is unnamed", async () => {
    const { company, budget, from, to, theirs } = await seed();
    await ask(company, budget, from, to);

    /* Finance moves budget from the Board's line into ours. We may see that
       it happened without learning what their head is called. */
    const doc = await Acc_Budget.findById(budget._id);
    doc.transfers.push({
      fromItemId: theirs._id, toItemId: from._id, amount: 50000, reason: "rebalance",
      state: "submitted", origin: "finance", requestedAt: new Date(), requestedBy: "fin@x.com",
      fromSnapshot: { department: "Board", ledgerName: "Executive Travel", allocatedAmount: 5000000, actual: 0, remaining: 5000000 },
      toSnapshot: { department: "Logistics", ledgerName: "Raw Material", allocatedAmount: 1000000, actual: 0, remaining: 1000000 },
    });
    await doc.save();

    const { body } = await dept(`/transfers?companyId=${company._id}`);
    expect(body.transfers).toHaveLength(2);
    const financeRaised = body.transfers.find((t) => t.origin === "finance");
    expect(financeRaised.fromLedgerName).toBe("another department");
    expect(financeRaised.toLedgerName).toBe("Raw Material");
    expect(JSON.stringify(body)).not.toContain("Executive Travel");
  });

  test("a department withdraws its own pending ask", async () => {
    const { company, budget, from, to } = await seed();
    const { body } = await ask(company, budget, from, to);
    const { status } = await dept(`/transfers/${body.transfer._id}/cancel`, {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
    });
    expect(status).toBe(200);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.transfers[0].state).toBe("cancelled");
    expect(fresh.items[0].allocatedAmount).toBe(1000000);
  });

  test("an approved transfer cannot be withdrawn", async () => {
    const { company, budget, from, to } = await seed();
    const { body } = await ask(company, budget, from, to);
    await fin(`/${budget._id}/transfers/${body.transfer._id}/approve?companyId=${company._id}`, {});
    const { status } = await dept(`/transfers/${body.transfer._id}/cancel`, {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
    });
    expect(status).toBe(409);
  });

  test("a department cannot withdraw a transfer finance raised", async () => {
    const { company, budget, from, to } = await seed();
    const doc = await Acc_Budget.findById(budget._id);
    doc.transfers.push({
      fromItemId: from._id, toItemId: to._id, amount: 1000, reason: "finance's own",
      state: "submitted", origin: "finance", requestedAt: new Date(), requestedBy: "fin@x.com",
      fromSnapshot: { department: "Logistics", ledgerName: "Raw Material" },
      toSnapshot: { department: "Logistics", ledgerName: "Freight" },
    });
    await doc.save();
    const id = String(doc.transfers[0]._id);
    const { status } = await dept(`/transfers/${id}/cancel`, {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
    });
    expect(status).toBe(403);
  });
});

/* ═══ FINANCE STILL OWNS THE MOVE ══════════════════════════════════════════ */

test("approval performs the actual move, and only then", async () => {
  const { company, budget, from, to } = await seed();
  const { body } = await ask(company, budget, from, to, { amount: 200000 });

  const before = await Acc_Budget.findById(budget._id).lean();
  expect(before.items[0].allocatedAmount).toBe(1000000);
  expect(before.items[1].allocatedAmount).toBe(400000);

  const ok = await fin(`/${budget._id}/transfers/${body.transfer._id}/approve?companyId=${company._id}`, {});
  expect(ok.status).toBe(200);

  const after = await Acc_Budget.findById(budget._id).lean();
  expect(after.items[0].allocatedAmount).toBe(800000);
  expect(after.items[1].allocatedAmount).toBe(600000);
  /* The company's total is exactly where it was — that is what makes this a
     transfer and not a supplementary. */
  expect(after.items[0].allocatedAmount + after.items[1].allocatedAmount).toBe(1400000);

  const mine = await dept(`/transfers?companyId=${company._id}`);
  expect(mine.body.transfers[0].state).toBe("approved");
});

test("rejection leaves both lines alone and the department sees why", async () => {
  const { company, budget, from, to } = await seed();
  const { body } = await ask(company, budget, from, to);
  await fin(`/${budget._id}/transfers/${body.transfer._id}/reject?companyId=${company._id}`, {
    financeNote: "Raw Material will need it after all.",
  });
  const after = await Acc_Budget.findById(budget._id).lean();
  expect(after.items[0].allocatedAmount).toBe(1000000);
  expect(after.items[1].allocatedAmount).toBe(400000);

  const mine = await dept(`/transfers?companyId=${company._id}`);
  expect(mine.body.transfers[0].state).toBe("rejected");
  expect(mine.body.transfers[0].financeNote).toMatch(/after all/);
});

/* ═══ THE ACTION CENTRE PICKS IT UP ════════════════════════════════════════ */

test("a pending ask and a decided one both surface in the action centre", async () => {
  const { company, budget, from, to } = await seed();
  const pending = await ask(company, budget, from, to, { amount: 100000 });
  const decided = await ask(company, budget, to, from, { amount: 50000, reason: "the other way" });
  await fin(`/${budget._id}/transfers/${decided.body.transfer._id}/reject?companyId=${company._id}`, {
    financeNote: "No.",
  });

  const { body } = await dept(`/action-centre?companyId=${company._id}`);
  const waiting = body.waitingOnFinance.filter((a) => a.type === "transfer_pending");
  expect(waiting).toHaveLength(1);
  expect(waiting[0].transferId).toBe(String(pending.body.transfer._id));
  expect(JSON.stringify(body)).not.toContain("Executive Travel");
});
