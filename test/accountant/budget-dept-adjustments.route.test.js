// A department asking to change its own approved allocation.
//
// The rule this file protects: asking moves nothing. The allocation changes
// only when finance approves through its own endpoint, and a department can
// neither approve its own ask nor reach another department's line.
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
/* ── THE SECOND SIGNATURE ────────────────────────────────────────────────────
 * Raising an allocation now takes the same two people as spending past one:
 * finance and the CEO, and they must be different people. The owner above is
 * the CEO; this is finance. */
const APPROVER_USER = {
  id: new (require("mongoose").Types.ObjectId)().toString(),
  name: "Anil Approver", email: "anil.approver@example.com", role: "approver",
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
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** Approve an increase the way the rule now requires: finance, then the CEO.
 *  The owner signs the CEO slot, so the approver has to sign as well. */
const finBoth = async (path, body) => {
  const first = await fin(path, body, APPROVER_USER);
  const second = await fin(path, body, OWNER);
  return { first, second };
};

const fin = (path, body, user = OWNER) =>
  fetch(`${finBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed({ status = "active" } = {}) {
  const company = await Acc_Company.create({ companyName: `Adj ${seq++}`, booksFromDate: new Date("2026-04-01") });
  const eg = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const rg = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const exp = await Acc_Ledger.create({ companyId: company._id, name: "Raw Material", groupId: eg._id, groupName: eg.name, nature: "expense" });
  const rev = await Acc_Ledger.create({ companyId: company._id, name: "Export Sales", groupId: rg._id, groupName: rg.name, nature: "revenue" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "logistics", name: "Logistics", accessSlug: "sales" });
  await Acc_BudgetDepartment.create({ companyId: company._id, slug: "board", name: "Board", accessSlug: "ceo" });

  const budget = await Acc_Budget.create({
    name: "FY26-27", financialYear: "2026-27", period: "yearly", status,
    startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: exp._id, ledgerName: exp.name, groupName: eg.name, nature: "expense", department: "Logistics", allocatedAmount: 2000000 },
      { ledgerId: rev._id, ledgerName: rev.name, groupName: rg.name, nature: "revenue", department: "Logistics", allocatedAmount: 9000000 },
      { ledgerId: exp._id, ledgerName: exp.name, groupName: eg.name, nature: "expense", department: "Board", allocatedAmount: 5000000 },
    ],
    budgetRequests: [], adjustments: [],
  });
  return { company, budget, mine: budget.items[0], revenue: budget.items[1], theirs: budget.items[2] };
}

const ask = (company, budget, line, over = {}) =>
  dept("/adjustments", {
    companyId: company._id.toString(), budgetId: budget._id.toString(), lineId: String(line._id),
    type: "supplementary", requestedDeltaAmount: 500000, reason: "Fabric prices moved.", ...over,
  });

/* ═══ ASKING ═══════════════════════════════════════════════════════════════ */

describe("a department asks", () => {
  test("a supplementary stores both numbers and moves nothing", async () => {
    const { company, budget, mine } = await seed();
    const { status, body } = await ask(company, budget, mine);
    expect(status).toBe(201);
    expect(body.adjustment.currentAllocatedAmount).toBe(2000000);
    expect(body.adjustment.requestedDeltaAmount).toBe(500000);
    expect(body.adjustment.requestedNewAmount).toBe(2500000); // derived
    expect(body.adjustment.state).toBe("submitted");

    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.items[0].allocatedAmount).toBe(2000000); // untouched
    expect(fresh.adjustments[0].requestedBy).toBe("head@demo.example");
  });

  test("a revision downward stores a negative delta", async () => {
    const { company, budget, mine } = await seed();
    const { status, body } = await ask(company, budget, mine, {
      type: "revision", requestedNewAmount: 1500000, requestedDeltaAmount: undefined,
    });
    expect(status).toBe(201);
    expect(body.adjustment.requestedNewAmount).toBe(1500000);
    expect(body.adjustment.requestedDeltaAmount).toBe(-500000);
  });

  test("a revenue line keeps its nature on the ask", async () => {
    const { company, budget, revenue } = await seed();
    const { body } = await ask(company, budget, revenue, {
      type: "revision", requestedNewAmount: 12000000, requestedDeltaAmount: undefined,
    });
    expect(body.adjustment.nature).toBe("revenue");
  });

  test("a supplementary of zero or less is refused", async () => {
    const { company, budget, mine } = await seed();
    const { status, body } = await ask(company, budget, mine, { requestedDeltaAmount: 0 });
    expect(status).toBe(400);
    expect(body.message).toMatch(/greater than 0/);
  });

  test("no reason is refused", async () => {
    const { company, budget, mine } = await seed();
    expect((await ask(company, budget, mine, { reason: "  " })).status).toBe(400);
  });

  test("a bad type is refused", async () => {
    const { company, budget, mine } = await seed();
    expect((await ask(company, budget, mine, { type: "topup" })).status).toBe(400);
  });

  test("a working breakdown is recomputed, not trusted", async () => {
    const { company, budget, mine } = await seed();
    const { status, body } = await ask(company, budget, mine, {
      workingLines: [{ label: "Extra seats", quantity: 7, unit: "users", rate: 6000, multiplier: 12, amount: 1 }],
    });
    expect(status).toBe(201);
    expect(body.adjustment.workingLines[0].amount).toBe(504000);
  });

  test("finance fields cannot be smuggled in", async () => {
    const { company, budget, mine } = await seed();
    await ask(company, budget, mine, {
      state: "approved", approvedNewAmount: 9999999, approvedDeltaAmount: 9999999,
      financeNote: "approved by me", requestedBy: "someone.else@example.com",
      department: "Board", currentAllocatedAmount: 1,
    });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    const a = fresh.adjustments[0];
    expect(a.state).toBe("submitted");
    expect(a.approvedNewAmount).toBeUndefined();
    expect(a.financeNote).toBeUndefined();
    expect(a.requestedBy).toBe("head@demo.example");
    expect(a.department).toBe("Logistics"); // from the LINE, not the body
    expect(a.currentAllocatedAmount).toBe(2000000);
  });

  test("a department ask is marked as one, and finance's is not", async () => {
    /* `sourceRequestId` cannot answer this: it says the target LINE came from
       a proposal, which is true whichever side later asks to change it. */
    const { company, budget, mine } = await seed();
    await ask(company, budget, mine);
    const financeRaised = await fin(`/${budget._id}/adjustments?companyId=${company._id}`, {
      type: "supplementary", targetItemId: String(mine._id), requestedDeltaAmount: 100000,
      reason: "Finance's own top-up.",
    });
    expect(financeRaised.status).toBe(201);

    const fresh = await Acc_Budget.findById(budget._id).lean();
    const byDept = fresh.adjustments.find((a) => a.reason === "Fabric prices moved.");
    const byFin = fresh.adjustments.find((a) => a.reason === "Finance's own top-up.");
    expect(byDept.origin).toBe("department");
    expect(byFin.origin).toBe("finance");
  });

  test("origin cannot be claimed from the body", async () => {
    const { company, budget, mine } = await seed();
    await ask(company, budget, mine, { origin: "finance" });
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.adjustments[0].origin).toBe("department");
  });

  test("a second open ask of the same type is refused", async () => {
    const { company, budget, mine } = await seed();
    expect((await ask(company, budget, mine)).status).toBe(201);
    const dup = await ask(company, budget, mine);
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("duplicate_adjustment");
    // a different TYPE on the same line is still allowed
    expect((await ask(company, budget, mine, { type: "revision", requestedNewAmount: 1000000 })).status).toBe(201);
  });
});

/* ═══ THE BOUNDARY ═════════════════════════════════════════════════════════ */

describe("scoping", () => {
  test("another department's line is not found", async () => {
    const { company, budget, theirs } = await seed();
    const { status } = await ask(company, budget, theirs);
    expect(status).toBe(404);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.adjustments).toHaveLength(0);
  });

  test("an unmapped portal cannot ask", async () => {
    const { company, budget, mine } = await seed();
    const { status } = await dept("/adjustments", {
      companyId: company._id.toString(), budgetId: budget._id.toString(), lineId: String(mine._id),
      type: "supplementary", requestedDeltaAmount: 1, reason: "x",
    }, tokenFor("store", "other@demo.example"));
    expect(status).toBe(403);
  });

  test("a closed budget cannot be adjusted", async () => {
    const { company, budget, mine } = await seed({ status: "closed" });
    const { status } = await ask(company, budget, mine);
    expect(status).toBe(409);
  });

  test("the list shows only this department's asks", async () => {
    const { company, budget, mine, theirs } = await seed();
    await ask(company, budget, mine);
    // plant one for the other department directly
    const doc = await Acc_Budget.findById(budget._id);
    doc.adjustments.push({
      type: "supplementary", targetItemId: theirs._id, department: "Board",
      currentAllocatedAmount: 5000000, requestedDeltaAmount: 100000, requestedNewAmount: 5100000,
      reason: "theirs", state: "submitted", requestedAt: new Date(), requestedBy: "board@x.com",
    });
    await doc.save();

    const { body } = await dept(`/adjustments?companyId=${company._id}`);
    expect(body.adjustments).toHaveLength(1);
    expect(body.adjustments[0].department).toBe("Logistics");
    expect(JSON.stringify(body)).not.toContain("Board");
    // and people are not named on the wire
    expect(body.adjustments[0].requestedBy).toBeUndefined();
  });
});

/* ═══ CANCELLING ═══════════════════════════════════════════════════════════ */

describe("withdrawing", () => {
  test("a submitted ask can be withdrawn", async () => {
    const { company, budget, mine } = await seed();
    const { body } = await ask(company, budget, mine);
    const { status } = await dept(`/adjustments/${body.adjustment._id}/cancel`, {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
    });
    expect(status).toBe(200);
    const fresh = await Acc_Budget.findById(budget._id).lean();
    expect(fresh.adjustments[0].state).toBe("cancelled");
  });

  test("an approved ask cannot be withdrawn", async () => {
    const { company, budget, mine } = await seed();
    const { body } = await ask(company, budget, mine);
    await finBoth(`/${budget._id}/adjustments/${body.adjustment._id}/approve?companyId=${company._id}`, {});
    const { status } = await dept(`/adjustments/${body.adjustment._id}/cancel`, {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
    });
    expect(status).toBe(409);
  });

  test("another department's ask cannot be withdrawn", async () => {
    const { company, budget, mine } = await seed();
    const { body } = await ask(company, budget, mine);
    const { status } = await dept(`/adjustments/${body.adjustment._id}/cancel`, {
      companyId: company._id.toString(), budgetId: budget._id.toString(),
    }, tokenFor("ceo", "board@demo.example"));
    expect(status).toBe(404);
  });
});

/* ═══ FINANCE DECIDES ══════════════════════════════════════════════════════ */

describe("only finance applies it", () => {
  test("approving moves the allocation; the department sees the new figure", async () => {
    const { company, budget, mine } = await seed();
    const { body } = await ask(company, budget, mine);

    const before = await Acc_Budget.findById(budget._id).lean();
    expect(before.items[0].allocatedAmount).toBe(2000000);

    const { first, second: ok } = await finBoth(`/${budget._id}/adjustments/${body.adjustment._id}/approve?companyId=${company._id}`, {});
    /* One approver is not two. The allocation does not move on the first. */
    expect(first.status).toBe(202);
    expect(first.body.escalation.waitingOn).toBe("ceo");
    expect(ok.status).toBe(200);

    const after = await Acc_Budget.findById(budget._id).lean();
    expect(after.items[0].allocatedAmount).toBe(2500000);
    expect(after.adjustments[0].state).toBe("approved");

    const mineNow = await dept(`/adjustments?companyId=${company._id}`);
    expect(mineNow.body.adjustments[0].state).toBe("approved");
    expect(mineNow.body.adjustments[0].approvedNewAmount).toBe(2500000);
  });

  test("rejecting leaves the allocation alone", async () => {
    const { company, budget, mine } = await seed();
    const { body } = await ask(company, budget, mine);
    const res = await fin(`/${budget._id}/adjustments/${body.adjustment._id}/reject?companyId=${company._id}`, {
      financeNote: "Absorb it in the existing budget.",
    });
    expect(res.status).toBe(200);

    const after = await Acc_Budget.findById(budget._id).lean();
    expect(after.items[0].allocatedAmount).toBe(2000000);
    expect(after.adjustments[0].state).toBe("rejected");

    const mineNow = await dept(`/adjustments?companyId=${company._id}`);
    expect(mineNow.body.adjustments[0].state).toBe("rejected");
    expect(mineNow.body.adjustments[0].financeNote).toMatch(/Absorb it/);
  });

  test("the department has no route that approves its own ask", async () => {
    const { company, budget, mine } = await seed();
    const { body } = await ask(company, budget, mine);
    const res = await fetch(`${deptBase}/adjustments/${body.adjustment._id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor()}` },
      body: JSON.stringify({ companyId: company._id.toString(), budgetId: budget._id.toString() }),
    });
    expect(res.status).toBe(404);
    const after = await Acc_Budget.findById(budget._id).lean();
    expect(after.items[0].allocatedAmount).toBe(2000000);
  });
});
