// Duplicate prevention, over HTTP, across all four ask types.
//
// The service tests own the rules; this file proves they are actually wired
// into every path a department can reach — including the bulk submit, where a
// proposal can duplicate a row inside its own payload.
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

const dept = (path, body, token = tokenFor(), method) =>
  fetch(`${deptBase}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body) =>
  fetch(`${finBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed({ status = "collecting" } = {}) {
  const company = await Acc_Company.create({ companyName: `Dup ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const eg = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const rg = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const a = await Acc_Ledger.create({ companyId: company._id, name: "Raw Material", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const b = await Acc_Ledger.create({ companyId: company._id, name: "Freight", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const c = await Acc_Ledger.create({ companyId: company._id, name: "Packaging", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const rev = await Acc_Ledger.create({ companyId: company._id, name: "Export Sales", groupId: rg._id, groupName: rg.name, nature: "revenue" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "board", name: "Board", accessSlug: "ceo" });
  const budget = await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status,
    startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [], budgetRequests: [], adjustments: [], transfers: [],
  });
  return { company, budget, a, b, c, rev };
}

const propose = (company, budget, over = {}) =>
  dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", requestedAmount: 100000, purpose: "Fabric", ...over,
  });

/* ═══ PROPOSALS ════════════════════════════════════════════════════════════ */

describe("proposal lines", () => {
  test("a second open line on the same head is a 409 naming the first", async () => {
    const { company, budget, a } = await seed();
    const first = await propose(company, budget, { ledgerId: a._id.toString() });
    expect(first.status).toBe(201);

    const dup = await propose(company, budget, { ledgerId: a._id.toString(), requestedAmount: 200000 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_proposal");
    expect(dup.body.existing.id).toBe(String(first.body.request._id));
    expect(dup.body.existing.state).toBe("submitted");

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(1);
  });

  test("a different head in the same cycle is fine", async () => {
    const { company, budget, a, b } = await seed();
    await propose(company, budget, { ledgerId: a._id.toString() });
    expect((await propose(company, budget, { ledgerId: b._id.toString() })).status).toBe(201);
  });

  test("once finance has decided, the head may be proposed again", async () => {
    const { company, budget, a } = await seed();
    const first = await propose(company, budget, { ledgerId: a._id.toString() });
    const doc = await Acc_Budget.findById(budget._id);
    doc.budgetRequests.id(first.body.request._id).state = "agreed";
    await doc.save();

    expect((await propose(company, budget, { ledgerId: a._id.toString() })).status).toBe(201);
  });

  test("a countered line still blocks — it is the same conversation", async () => {
    const { company, budget, a } = await seed();
    const first = await propose(company, budget, { ledgerId: a._id.toString() });
    const doc = await Acc_Budget.findById(budget._id);
    doc.budgetRequests.id(first.body.request._id).state = "countered";
    await doc.save();
    expect((await propose(company, budget, { ledgerId: a._id.toString() })).status).toBe(409);
  });

  test("revising a line does not collide with itself", async () => {
    const { company, budget, a } = await seed();
    const first = await propose(company, budget, { ledgerId: a._id.toString() });
    /* Revise is a PUT that edits the row in place — there is nothing to
       duplicate, and the guard must not mistake the row for its own rival. */
    const { status } = await dept(
      `/${budget._id}/requests/${first.body.request._id}?companyId=${company._id}`,
      { requestedAmount: 250000, purpose: "Fabric, revised" },
      tokenFor(),
      "PUT",
    );
    expect(status).toBe(200);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(1);
    expect(fresh.budgetRequests[0].requestedAmount).toBe(250000);
  });

  test("another department may propose the same head", async () => {
    const { company, budget, a } = await seed();
    await propose(company, budget, { ledgerId: a._id.toString() });
    const theirs = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
      department: "Board", ledgerId: a._id.toString(), requestedAmount: 1, purpose: "theirs",
    }, tokenFor("ceo", "board@demo.example"));
    expect(theirs.status).toBe(201);
  });

  test("the same head twice inside one bulk submit is refused", async () => {
    const { company, budget, a } = await seed();
    const line = { department: "Logistics", ledgerId: a._id.toString(), requestedAmount: 1000, purpose: "x" };
    const { status, body } = await dept(`/${budget._id}/requests/bulk?companyId=${company._id}`, {
      lines: [line, { ...line, requestedAmount: 2000 }],
    });
    expect(status).toBe(409);
    expect(body.code).toBe("duplicate_proposal");
    expect(body.message).toMatch(/appears twice/);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(0);
  });

  test("bulk is also checked against what is already in the cycle", async () => {
    const { company, budget, a, b } = await seed();
    await propose(company, budget, { ledgerId: a._id.toString() });
    const { status, body } = await dept(`/${budget._id}/requests/bulk?companyId=${company._id}`, {
      lines: [
        { department: "Logistics", ledgerId: b._id.toString(), requestedAmount: 1000, purpose: "ok" },
        { department: "Logistics", ledgerId: a._id.toString(), requestedAmount: 1000, purpose: "dup" },
      ],
    });
    expect(status).toBe(409);
    expect(body.message).toMatch(/^Line 2:/);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(1); // the original only
  });
});

/* ═══ REQUESTED HEADS ══════════════════════════════════════════════════════ */

describe("requested heads", () => {
  const askHead = (company, budget, name, over = {}) =>
    propose(company, budget, {
      requestedHead: { name, nature: "expense", reason: "Nothing existing fits.", ...over },
    });

  test("the same head name typed differently is one ask", async () => {
    const { company, budget } = await seed();
    const first = await askHead(company, budget, "Claude Team");
    expect(first.status).toBe(201);

    const dup = await askHead(company, budget, "  claude   TEAM ");
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_head_request");
    expect(dup.body.existing.id).toBe(String(first.body.request._id));
    expect(dup.body.existing.state).toBe("requested");
  });

  test("once finance maps it, the name is no longer an open ask", async () => {
    const { company, budget, a } = await seed();
    const first = await askHead(company, budget, "Claude Team");
    await fin(`/${budget._id}/requests/${first.body.request._id}/resolve-head?companyId=${company._id}`, {
      action: "map", ledgerId: a._id.toString(),
    });
    /* Mapped, so a fresh ask for that name is legitimate — though in practice
       the department would now pick the mapped ledger. */
    expect((await askHead(company, budget, "Claude Team")).status).toBe(201);
  });

  test("a head finance questioned is still open and still blocks", async () => {
    const { company, budget } = await seed();
    const first = await askHead(company, budget, "Claude Team");
    await fin(`/${budget._id}/requests/${first.body.request._id}/resolve-head?companyId=${company._id}`, {
      action: "clarification", financeNote: "Per seat?",
    });
    const dup = await askHead(company, budget, "Claude Team");
    expect(dup.status).toBe(409);
    expect(dup.body.existing.state).toBe("clarification");
  });

  test("the same name as a revenue head is a different ask", async () => {
    const { company, budget } = await seed();
    await askHead(company, budget, "Claude Team");
    expect((await askHead(company, budget, "Claude Team", { nature: "revenue" })).status).toBe(201);
  });
});

/* ═══ ADJUSTMENTS ══════════════════════════════════════════════════════════ */

describe("adjustments", () => {
  async function live() {
    const s = await seed({ status: "active" });
    const doc = await Acc_Budget.findById(s.budget._id);
    doc.items.push({ ledgerId: s.a._id, ledgerName: s.a.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 });
    await doc.save();
    return { ...s, budget: doc, line: doc.items[0] };
  }
  const ask = (s, over = {}) =>
    dept("/adjustments", {
      companyId: s.company._id.toString(), budgetId: s.budget._id.toString(), lineId: String(s.line._id),
      type: "supplementary", requestedDeltaAmount: 50000, reason: "prices moved", ...over,
    });

  test("a second open ask of the same type is a 409 naming the first", async () => {
    const s = await live();
    const first = await ask(s);
    const dup = await ask(s);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_adjustment");
    expect(dup.body.existing.id).toBe(String(first.body.adjustment._id));
  });

  test("after finance decides, a new ask is allowed", async () => {
    const s = await live();
    const first = await ask(s);
    await fin(`/${s.budget._id}/adjustments/${first.body.adjustment._id}/reject?companyId=${s.company._id}`, {});
    expect((await ask(s)).status).toBe(201);
  });

  test("finance's own open ask does not block the department", async () => {
    const s = await live();
    await fin(`/${s.budget._id}/adjustments?companyId=${s.company._id}`, {
      type: "supplementary", targetItemId: String(s.line._id), requestedDeltaAmount: 1000, reason: "finance's",
    });
    expect((await ask(s)).status).toBe(201);
  });
});

/* ═══ TRANSFERS ════════════════════════════════════════════════════════════ */

describe("transfers", () => {
  async function live() {
    const s = await seed({ status: "active" });
    const doc = await Acc_Budget.findById(s.budget._id);
    doc.items.push(
      { ledgerId: s.a._id, ledgerName: s.a.name, nature: "expense", department: "Logistics", allocatedAmount: 1000000 },
      { ledgerId: s.b._id, ledgerName: s.b.name, nature: "expense", department: "Logistics", allocatedAmount: 200000 },
      /* A THIRD expense line, so a second transfer out of the same source has
         somewhere legitimate to go — routing it at the revenue line would be
         refused on nature before the money rule was ever reached. */
      { ledgerId: s.c._id, ledgerName: s.c.name, nature: "expense", department: "Logistics", allocatedAmount: 300000 },
    );
    await doc.save();
    return { ...s, budget: doc, from: doc.items[0], to: doc.items[1], third: doc.items[2] };
  }
  const move = (s, over = {}) =>
    dept("/transfers", {
      companyId: s.company._id.toString(), budgetId: s.budget._id.toString(),
      fromLineId: String(s.from._id), toLineId: String(s.to._id),
      amount: 100000, reason: "rebalance", ...over,
    });

  test("the same route twice is a 409 naming the first", async () => {
    const s = await live();
    const first = await move(s);
    const dup = await move(s);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_transfer");
    expect(dup.body.existing.id).toBe(String(first.body.transfer._id));
  });

  test("after a decision the same route may be asked again", async () => {
    const s = await live();
    const first = await move(s);
    await fin(`/${s.budget._id}/transfers/${first.body.transfer._id}/reject?companyId=${s.company._id}`, {});
    expect((await move(s)).status).toBe(201);
  });

  test("open asks out of one line are added up against its availability", async () => {
    /* 10,00,000 free. First ask takes 8,00,000; a second for 5,00,000 is
       individually affordable and not affordable alongside the first. */
    const s = await live();
    expect((await move(s, { amount: 800000 })).status).toBe(201);

    const second = await move(s, { toLineId: String(s.third._id), amount: 500000 });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("duplicate_transfer");
    expect(second.body.message).toMatch(/already promised/);
    expect(second.body.available.committed).toBe(800000);
    expect(second.body.available.spare).toBe(200000);
  });

  test("what still fits alongside an open ask is accepted", async () => {
    /* The mirror of the test above: 2,00,000 is exactly the spare left after
       an open ask of 8,00,000, so it goes through. Without this the rule
       could be "refuse everything" and still pass. */
    const s = await live();
    await move(s, { amount: 800000 });
    const fits = await move(s, { toLineId: String(s.third._id), amount: 200000 });
    expect(fits.status).toBe(201);
  });

  test("a transfer into a revenue line is still refused on nature, not money", async () => {
    const s = await live();
    const doc = await Acc_Budget.findById(s.budget._id);
    doc.items.push({ ledgerId: s.rev._id, ledgerName: s.rev.name, nature: "revenue", department: "Logistics", allocatedAmount: 5000000 });
    await doc.save();
    const { status, body } = await move(s, { toLineId: String(doc.items[3]._id), amount: 1000 });
    expect(status).toBe(400);
    expect(body.message).toMatch(/different kinds of number/);
  });

  test("withdrawing an ask frees what it had promised", async () => {
    const s = await live();
    const first = await move(s, { amount: 800000 });
    await dept(`/transfers/${first.body.transfer._id}/cancel`, {
      companyId: s.company._id.toString(), budgetId: s.budget._id.toString(),
    });
    expect((await move(s, { amount: 900000 })).status).toBe(201);
  });

  test("finance still rechecks availability at approval", async () => {
    const s = await live();
    const first = await move(s, { amount: 900000 });
    /* Finance approves; the source drops to 1,00,000 allocated. A second ask
       raised before that would now exceed it — which is why approval
       recomputes rather than trusting the ask. */
    const ok = await fin(`/${s.budget._id}/transfers/${first.body.transfer._id}/approve?companyId=${s.company._id}`, {});
    expect(ok.status).toBe(200);
    const fresh = await Acc_Budget.findById(s.budget._id).lean();
    expect(fresh.items[0].allocatedAmount).toBe(100000);
    expect(fresh.items[1].allocatedAmount).toBe(1100000);
  });
});

/* ═══ SCOPING ══════════════════════════════════════════════════════════════ */

test("duplicate checks do not reach across companies", async () => {
  const one = await seed();
  const two = await seed();
  await propose(one.company, one.budget, { ledgerId: one.a._id.toString() });
  /* Same department name, same head name, different company — a separate
     budget entirely, so nothing blocks. */
  expect((await propose(two.company, two.budget, { ledgerId: two.a._id.toString() })).status).toBe(201);
});
