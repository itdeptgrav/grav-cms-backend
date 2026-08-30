// A department budgeting for something the chart of accounts has no head for.
//
// The rule this file exists to protect: an allocation is NEVER written without
// a real ledger. A department may ask for a head; only finance turns that ask
// into a binding, and until it does the request cannot be agreed.
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

const tokenFor = (deptSlug = "sales", email = "head@demo.example") =>
  jwt.sign({ v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug, email, name: "Dept Head" }, SECRET, { expiresIn: "1h" });

const dept = (path, body, token = tokenFor()) =>
  fetch(`${deptBase}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body, user = OWNER) =>
  fetch(`${finBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed() {
  const company = await Acc_Company.create({ companyName: `Head ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const eg = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const rg = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const software = await Acc_Ledger.create({ companyId: company._id, name: "Software Expenses", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const sales = await Acc_Ledger.create({ companyId: company._id, name: "Export Sales", groupId: rg._id, groupName: rg.name, nature: "revenue" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  const budget = await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  return { company, budget, software, sales };
}

const ASK = {
  department: "Logistics", requestedAmount: 660000, purpose: "AI tooling for the team",
  requestedHead: {
    name: "Claude Team", nature: "expense",
    reason: "Software Expenses lumps every tool together; we need this one tracked on its own.",
    suggestedGroupName: "Indirect Expenses",
  },
};

const propose = (budget, company, over = {}) =>
  dept(`/${budget._id}/requests?companyId=${company._id}`, { ...ASK, ...over });

/* ═══ THE DEPARTMENT ASKS ══════════════════════════════════════════════════ */

describe("a department can ask for a head that does not exist", () => {
  test("a requested head is stored, with no ledger and no allocation", async () => {
    const { company, budget } = await seed();
    const { status, body } = await propose(budget, company);
    expect(status).toBe(201);
    expect(body.request.requestedHead.name).toBe("Claude Team");
    expect(body.request.requestedHead.state).toBe("requested");
    expect(body.request.ledgerId).toBeFalsy();

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].ledgerId).toBeUndefined();
    expect(fresh.items).toHaveLength(0);
    // server-derived, like submittedBy
    expect(fresh.budgetRequests[0].requestedHead.requestedBy).toBe("head@demo.example");
    expect(fresh.budgetRequests[0].requestedHead.requestedAt).toBeInstanceOf(Date);
  });

  test("a normal ledger-backed line is unaffected", async () => {
    const { company, budget, software } = await seed();
    const { status, body } = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
      department: "Logistics", ledgerId: software._id.toString(), requestedAmount: 500000, purpose: "Licences",
    });
    expect(status).toBe(201);
    expect(String(body.request.ledgerId)).toBe(String(software._id));
    expect(body.request.requestedHead).toBeNull();
  });

  test("neither a ledger nor a requested head is refused", async () => {
    const { company, budget } = await seed();
    const { status } = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
      department: "Logistics", requestedAmount: 500000, purpose: "Something",
    });
    expect(status).toBe(400);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests).toHaveLength(0);
  });

  test.each([
    ["no name", { name: "" }, /Name the budget head/],
    ["no nature", { nature: "" }, /revenue target or an expense budget/],
    ["no reason", { reason: "" }, /why the existing heads do not fit/],
  ])("%s is refused", async (_label, patch, msg) => {
    const { company, budget } = await seed();
    const { status, body } = await propose(budget, company, {
      requestedHead: { ...ASK.requestedHead, ...patch },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(msg);
  });

  test("the department cannot pre-resolve its own head", async () => {
    const { company, budget, software } = await seed();
    await propose(budget, company, {
      requestedHead: {
        ...ASK.requestedHead,
        state: "mapped",
        resolvedLedgerId: software._id.toString(),
        resolvedLedgerName: "Software Expenses",
        financeNote: "approved by me",
      },
    });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    const rh = fresh.budgetRequests[0].requestedHead;
    expect(rh.state).toBe("requested");
    expect(rh.resolvedLedgerId).toBeUndefined();
    expect(rh.financeNote).toBeUndefined();
    expect(fresh.budgetRequests[0].ledgerId).toBeUndefined();
  });

  test("working rows and phasing still validate on a requested-head line", async () => {
    const { company, budget } = await seed();
    const { status, body } = await propose(budget, company, {
      requestedAmount: 360000,
      workingLines: [{ label: "Claude Team", quantity: 5, unit: "users", rate: 6000, multiplier: 12 }],
      phasingMode: "custom_monthly",
      monthlyPhasing: [{ month: "2026-09", amount: 360000 }],
    });
    expect(status).toBe(201);
    expect(body.request.workingTotal).toBe(360000);
    expect(body.request.monthlyPhasing).toEqual([{ month: "2026-09", amount: 360000 }]);
  });

  test("a broken breakdown is still refused when the head is a request", async () => {
    /* Asking for a head does not buy an exemption from the arithmetic: the
       rows here total 3,60,000 against an ask of 6,60,000. */
    const { company, budget } = await seed();
    const { status, body } = await propose(budget, company, {
      requestedAmount: 660000,
      workingLines: [{ label: "Claude Team", quantity: 5, unit: "users", rate: 6000, multiplier: 12 }],
    });
    expect(status).toBe(400);
    expect(body.code).toBe("WORKING_SUM_MISMATCH");
  });
});

/* ═══ FINANCE RESOLVES ═════════════════════════════════════════════════════ */

describe("only finance resolves a requested head", () => {
  const asked = async () => {
    const s = await seed();
    const { body } = await propose(s.budget, s.company);
    return { ...s, id: body.request._id };
  };

  test("agree is refused while the head is unresolved", async () => {
    const { company, budget, id } = await asked();
    const { status, body } = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, {
      agreedAmount: 660000,
    });
    expect(status).toBe(409);
    expect(body.code).toBe("HEAD_UNRESOLVED");
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.items).toHaveLength(0);
  });

  test("mapping writes the real ledger onto the request, and agree then allocates", async () => {
    const { company, budget, software, id } = await asked();
    const mapped = await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
      action: "map", ledgerId: software._id.toString(), financeNote: "Folded into Software Expenses.",
    });
    expect(mapped.status).toBe(200);

    const mid = await Acc_Budget.findById(budget._id).lean();
    expect(String(mid.budgetRequests[0].ledgerId)).toBe(String(software._id));
    expect(mid.budgetRequests[0].requestedHead.state).toBe("mapped");
    expect(mid.items).toHaveLength(0); // mapping alone allocates nothing

    const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 660000 });
    expect(agreed.status).toBe(200);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.items).toHaveLength(1);
    expect(String(fresh.items[0].ledgerId)).toBe(String(software._id));
    expect(fresh.items[0].allocatedAmount).toBe(660000);
  });

  test("the ledger's own nature wins over the department's guess", async () => {
    /* Asked for as an expense; mapped onto a revenue ledger. Letting the two
       disagree is how a sales target gets counted as spend. */
    const { company, budget, sales, id } = await asked();
    await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
      action: "map", ledgerId: sales._id.toString(),
    });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].nature).toBe("revenue");
  });

  test("marking it created records that, and still allocates against the ledger", async () => {
    const { company, budget, id } = await asked();
    const g = await Acc_Group.findOne({ companyId: budget.companyId, nature: "expense" });
    const made = await Acc_Ledger.create({
      companyId: budget.companyId, name: "Claude Team", groupId: g._id, groupName: g.name, nature: "expense",
    });
    await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
      action: "map", ledgerId: made._id.toString(), created: true,
    });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].requestedHead.state).toBe("created");
    expect(String(fresh.budgetRequests[0].ledgerId)).toBe(String(made._id));
  });

  test("rejecting leaves no ledger, so agree stays refused", async () => {
    const { company, budget, id } = await asked();
    const r = await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
      action: "reject", financeNote: "Use Software Expenses.",
    });
    expect(r.status).toBe(200);
    const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 1 });
    expect(agreed.status).toBe(409);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].requestedHead.state).toBe("rejected");
    expect(fresh.items).toHaveLength(0);
  });

  test("a rejection after a mapping clears the ledger too", async () => {
    const { company, budget, software, id } = await asked();
    await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
      action: "map", ledgerId: software._id.toString(),
    });
    await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, { action: "reject" });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.budgetRequests[0].ledgerId).toBeUndefined();
    const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 1 });
    expect(agreed.status).toBe(409);
  });

  test("a ledger from another company cannot be mapped", async () => {
    const { company, budget, id } = await asked();
    const other = await Acc_Company.create({ companyName: `Other ${seq++}`, booksFromDate: new Date("2026-04-01") });
    const og = await Acc_Group.create({ companyId: other._id, name: "Indirect Expenses", nature: "expense" });
    const foreign = await Acc_Ledger.create({ companyId: other._id, name: "Their Head", groupId: og._id, groupName: og.name, nature: "expense" });
    const { status } = await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
      action: "map", ledgerId: foreign._id.toString(),
    });
    expect(status).toBe(400);
  });

  test("a user without approval rights cannot resolve", async () => {
    const { company, budget, software, id } = await asked();
    const { status } = await fin(
      `/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`,
      { action: "map", ledgerId: software._id.toString() },
      { id: "u2", name: "Clerk", email: "clerk@example.com", role: "accountant", permissions: { canEdit: true, canApprove: false } },
    );
    expect(status).toBe(403);
  });

  test("resolving a request that never asked for a head is refused", async () => {
    const { company, budget, software } = await seed();
    const { body } = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
      department: "Logistics", ledgerId: software._id.toString(), requestedAmount: 100, purpose: "x",
    });
    const { status } = await fin(
      `/${budget._id}/requests/${body.request._id}/resolve-head?companyId=${company._id}`,
      { action: "map", ledgerId: software._id.toString() },
    );
    expect(status).toBe(400);
  });
});

/* ═══ WHAT THE DEPARTMENT SEES ═════════════════════════════════════════════ */

test("the department sees the decision, and no one else's", async () => {
  const s = await seed();
  const { body } = await propose(s.budget, s.company);
  await fin(`/${s.budget._id}/requests/${body.request._id}/resolve-head?companyId=${s.company._id}`, {
    action: "clarification", financeNote: "Is this per seat or per org?",
  });

  const mine = await dept(`/my-requests?companyId=${s.company._id}`);
  const row = mine.body.requests[0];
  expect(row.requestedHead.state).toBe("clarification");
  expect(row.requestedHead.financeNote).toMatch(/per seat/);
  // people are not named on the wire
  expect(row.requestedHead.resolvedBy).toBeUndefined();
  expect(row.requestedHead.requestedBy).toBeUndefined();

  // another department sees nothing
  const other = await dept(`/my-requests?companyId=${s.company._id}`, undefined, tokenFor("store", "other@demo.example"));
  expect(other.body.requests).toEqual([]);
});

/* ═══ THE WHOLE JOURNEY ════════════════════════════════════════════════════
 * The chunk's own verification, end to end: ask → flagged → blocked → mapped
 * → agreed → allocated against the resolved ledger, with the department able
 * to see every step.
 * ═════════════════════════════════════════════════════════════════════════ */

test("ask, resolve, agree — the allocation lands on the mapped ledger", async () => {
  const { company, budget, software } = await seed();

  // 1 · the department asks, with working and a custom split
  const made = await propose(budget, company, {
    requestedAmount: 360000,
    workingLines: [{ label: "Claude Team", quantity: 5, unit: "users", rate: 6000, multiplier: 12 }],
    phasingMode: "custom_monthly",
    monthlyPhasing: [{ month: "2026-09", amount: 160000 }, { month: "2026-10", amount: 200000 }],
  });
  expect(made.status).toBe(201);
  const id = made.body.request._id;

  // 2 · finance sees an unresolved head and cannot agree
  const blocked = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 360000 });
  expect(blocked.status).toBe(409);

  // 3 · finance maps it
  await fin(`/${budget._id}/requests/${id}/resolve-head?companyId=${company._id}`, {
    action: "map", ledgerId: software._id.toString(), financeNote: "Folded into Software Expenses.",
  });

  // 4 · now it agrees, keeping the department's split
  const agreed = await fin(`/${budget._id}/requests/${id}/agree?companyId=${company._id}`, { agreedAmount: 360000 });
  expect(agreed.status).toBe(200);

  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find((i) => String(i.sourceRequestId) === String(id));
  expect(line).toBeTruthy();
  // the allocation posts against the RESOLVED ledger, never the free text
  expect(String(line.ledgerId)).toBe(String(software._id));
  expect(line.ledgerName).toBe("Software Expenses");
  expect(line.allocatedAmount).toBe(360000);
  expect(line.phasingMode).toBe("custom_monthly");
  expect(line.monthlyPhasing.map((m) => m.month)).toEqual(["2026-09", "2026-10"]);

  // 5 · and the department can see how it was resolved
  const mine = await dept(`/my-requests?companyId=${company._id}`);
  const row = mine.body.requests.find((x) => String(x._id) === String(id));
  expect(row.state).toBe("agreed");
  expect(row.requestedHead.state).toBe("mapped");
  expect(row.requestedHead.resolvedLedgerName).toBe("Software Expenses");
  expect(row.requestedHead.financeNote).toMatch(/Folded into/);
});

test("no allocation anywhere in the cycle lacks a ledger", async () => {
  /* The invariant this whole chunk exists to protect, asserted over the
     document rather than one line. */
  const { company, budget, software } = await seed();
  const a = await propose(budget, company, { requestedAmount: 100000 });
  const b = await dept(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: software._id.toString(), requestedAmount: 200000, purpose: "Licences",
  });
  await fin(`/${budget._id}/requests/${b.body.request._id}/agree?companyId=${company._id}`, { agreedAmount: 200000 });
  await fin(`/${budget._id}/requests/${a.body.request._id}/agree?companyId=${company._id}`, { agreedAmount: 100000 });

  const fresh = await Acc_Budget.findById(budget._id).lean();
  expect(fresh.items).toHaveLength(1); // only the ledger-backed one landed
  expect(fresh.items.every((i) => !!i.ledgerId)).toBe(true);
});
