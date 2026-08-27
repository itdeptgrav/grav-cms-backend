// test/accountant/cost-centres.route.test.js
//
// Project / cost-centre budget attribution.
//
// The defect being closed: a budget line matched spend on ledger + company +
// date, so a budget named after a project claimed EVERY rupee spent on that
// head company-wide. That made a project budget a label rather than a control,
// and one that reported inflated actuals — the exact failure the module exists
// to prevent.
//
// The load-bearing test in this file is "a project budget does not claim all
// ledger spend". Everything else supports it.
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

const {
  Acc_Company, Acc_Group, Acc_Ledger, Acc_CostCentre,
} = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", email: "priya.owner@example.com", role: "owner",
  permissions: { canView: true, canEdit: true, canApprove: true },
};
const VIEWER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Vik Viewer", email: "vik.viewer@example.com", role: "viewer",
  permissions: { canView: true },
};

let server; let base; let seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  app.use("/api/accountant/cost-centres", require("../../routes/Accountant_Routes/Acc_costCentres"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/accountant`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

async function call(path, { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedCompany() {
  const company = await Acc_Company.create({
    companyName: `Company ${seq++}`, booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({ companyId: company._id, name: "Indirect Expenses", nature: "expense" });
  const revGroup = await Acc_Group.create({ companyId: company._id, name: "Direct Income", nature: "revenue" });
  const expenseLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding",
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const revenueLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Export Sales",
    groupId: revGroup._id, groupName: revGroup.name, nature: "revenue",
  });
  return { company, expenseLedger, revenueLedger };
}

const cc = (company, name) =>
  Acc_CostCentre.create({ companyId: company._id, name, category: "Projects" });

const YEAR = { startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") };

const mkBudget = ({ company, items, name = "Greenfield", scope = "project", ...rest }) =>
  Acc_Budget.create({
    name, financialYear: "2026-27", period: "yearly", status: "active",
    companyId: company._id, scope, ...YEAR, items, ...rest,
  });

const line = (ledger, { costCentre = null, allocatedAmount = 500000, nature = "expense", department = "Projects" } = {}) => ({
  ledgerId: ledger._id, ledgerName: ledger.name, nature, department, allocatedAmount,
  ...(costCentre ? { costCentreId: costCentre._id, costCentreName: costCentre.name } : {}),
});

/** A posted voucher. `allocations` is [[costCentre, amount], …] on the entry. */
const post = ({ company, ledger, amount, type = "Dr", date = "2026-08-15", allocations = [] }) =>
  Acc_Voucher.create({
    companyId: company._id, voucherType: type === "Cr" ? "sales" : "purchase",
    voucherNumber: `CC/${seq++}/${Date.now()}`,
    voucherDate: new Date(date), status: "posted", grandTotal: amount,
    ledgerEntries: [{
      ledgerId: ledger._id, ledgerName: ledger.name, type, amount,
      costCentreAllocations: allocations.map(([c, amt]) => ({
        costCentreId: c._id, costCentreName: c.name, amount: amt,
      })),
    }],
  });

const detail = (budget, company) =>
  call(`/budgets/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DEFECT
 * ══════════════════════════════════════════════════════════════════════════ */

describe("a project budget no longer claims all spend on its head", () => {
  test("a bound line counts ONLY what was tagged to its cost centre", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const other = await cc(company, "Riverside");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });

    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 100000]] });
    await post({ company, ledger: expenseLedger, amount: 900000, allocations: [[other, 900000]] });

    const { body } = await detail(budget, company);
    const item = body.budget.items[0];

    /* Before cost-centre binding this read ₹10,00,000 — the whole head, ten
       times the project's real spend. */
    expect(item.actual).toBe(100000);
    expect(item.costCentreBound).toBe(true);
  });

  test("THE LOAD-BEARING CASE: nothing tagged reads zero, and says why", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });

    /* Real money on the head, none of it attributed to any project. */
    await post({ company, ledger: expenseLedger, amount: 5200000 });

    const { body } = await detail(budget, company);
    const item = body.budget.items[0];

    /* It must NOT fall back to the head total — that fallback is the whole
       defect, and it would be invisible. */
    expect(item.actual).toBe(0);
    /* But a bare zero reads as "nothing was spent", which is false and would
       be read as an underspend. The line carries what DID move. */
    expect(item.headActual).toBe(5200000);
    expect(item.unattributed).toBe(5200000);
    expect(body.budget.attribution.trustworthy).toBe(false);
  });

  test("an unbound line on a project budget is reported, not hidden", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    /* Written directly, bypassing the route's inheritance — a legacy project
       budget from before cost-centre binding existed. */
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger)],
    });
    await post({ company, ledger: expenseLedger, amount: 5200000 });

    const { body } = await detail(budget, company);

    /* It still claims the whole head — that is what an unbound line DOES —
       but the budget says so rather than presenting it as a project figure. */
    expect(body.budget.items[0].actual).toBe(5200000);
    expect(body.budget.attribution.unboundLines).toHaveLength(1);
    expect(body.budget.attribution.trustworthy).toBe(false);
  });

  test("a fully attributed project budget reports itself as trustworthy", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    await post({ company, ledger: expenseLedger, amount: 120000, allocations: [[green, 120000]] });

    const { body } = await detail(budget, company);
    expect(body.budget.attribution).toMatchObject({
      trustworthy: true, attributed: 120000, unattributed: 0, boundLineCount: 1,
    });
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SPLITS
 * ══════════════════════════════════════════════════════════════════════════ */

describe("split allocations contribute only their share", () => {
  test("a voucher split across two projects gives each its own amount", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const river = await cc(company, "Riverside");

    const a = await mkBudget({
      company, name: "Greenfield", costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    const b = await mkBudget({
      company, name: "Riverside", costCentreId: river._id, costCentreName: river.name,
      items: [line(expenseLedger, { costCentre: river })],
    });

    /* ONE ₹1,00,000 entry, 60/40 across two projects. */
    await post({
      company, ledger: expenseLedger, amount: 100000,
      allocations: [[green, 60000], [river, 40000]],
    });

    expect((await detail(a, company)).body.budget.items[0].actual).toBe(60000);
    expect((await detail(b, company)).body.budget.items[0].actual).toBe(40000);
  });

  test("a partly tagged entry leaves the rest untagged, not doubled", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const project = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    await post({
      company, ledger: expenseLedger, amount: 100000, allocations: [[green, 60000]],
    });

    const { body } = await detail(project, company);
    expect(body.budget.items[0].actual).toBe(60000);
    /* The other ₹40,000 moved on the head but belongs to no project. */
    expect(body.budget.items[0].unattributed).toBe(40000);
  });

  test("the drilldown explains the same number the line reports", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const other = await cc(company, "Riverside");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 60000], [other, 40000]] });
    await post({ company, ledger: expenseLedger, amount: 900000 });

    const { body } = await detail(budget, company);
    const item = body.budget.items[0];

    const drill = await call(
      `/budgets/${budget._id}/items/${item._id}/vouchers?companyId=${company._id}`,
    );

    /* A user told the actual is ₹60,000 must not count ₹10,00,000 on screen —
       that disagreement is how people stop trusting a budget. */
    expect(drill.body.totals.actual).toBe(item.actual);
    expect(drill.body.totals.actual).toBe(60000);
    expect(drill.body.vouchers).toHaveLength(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NOTHING ELSE MOVED
 * ══════════════════════════════════════════════════════════════════════════ */

describe("company and department budgets are untouched", () => {
  test("a line with no cost centre behaves exactly as it always did", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, name: "Company FY", scope: "company", items: [line(expenseLedger)],
    });

    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 100000]] });
    await post({ company, ledger: expenseLedger, amount: 300000 });

    const { body } = await detail(budget, company);
    /* An unbound line counts the head as a whole — tagged spend included. A
       company budget that stopped counting money the moment someone tagged it
       would drop for a reason nobody could see. */
    expect(body.budget.items[0].actual).toBe(400000);
    expect(body.budget.items[0].costCentreBound).toBe(false);
    expect(body.budget.attribution).toBeNull();
  });

  test("legacy vouchers with no allocations at all still read", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await mkBudget({ company, name: "Company FY", scope: "company", items: [line(expenseLedger)] });
    /* Written the way all ~1,700 existing vouchers were: no cost-centre key. */
    await Acc_Voucher.create({
      companyId: company._id, voucherType: "purchase",
      voucherNumber: `LEG/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-08-15"), status: "posted", grandTotal: 250000,
      ledgerEntries: [{ ledgerId: expenseLedger._id, ledgerName: "F", type: "Dr", amount: 250000 }],
    });

    const { body } = await detail(budget, company);
    expect(body.budget.items[0].actual).toBe(250000);
  });

  test("revenue keeps its sign when bound to a cost centre", async () => {
    const { company, revenueLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(revenueLedger, { costCentre: green, nature: "revenue", allocatedAmount: 4000000 })],
    });
    await post({ company, ledger: revenueLedger, amount: 900000, type: "Cr", allocations: [[green, 900000]] });

    const { body } = await detail(budget, company);
    /* A credit on a revenue head is earned revenue, positive — the allocation
       carries a magnitude, and the ENTRY decides the side. */
    expect(body.budget.items[0].actual).toBe(900000);
  });

  test("draft and optional vouchers are excluded from tagged spend too", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 100000]] });
    await Acc_Voucher.create({
      companyId: company._id, voucherType: "purchase", voucherNumber: `D/${seq++}/${Date.now()}`,
      voucherDate: new Date("2026-08-15"), status: "draft", grandTotal: 999999,
      ledgerEntries: [{ ledgerId: expenseLedger._id, ledgerName: "F", type: "Dr", amount: 999999,
        costCentreAllocations: [{ costCentreId: green._id, costCentreName: green.name, amount: 999999 }] }],
    });

    const { body } = await detail(budget, company);
    expect(body.budget.items[0].actual).toBe(100000);
  });

  test("another company's tagged spend never reaches a project budget", async () => {
    const { company, expenseLedger } = await seedCompany();
    const other = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 100000]] });
    await post({ company: other.company, ledger: expenseLedger, amount: 700000, allocations: [[green, 700000]] });

    const { body } = await detail(budget, company);
    expect(body.budget.items[0].actual).toBe(100000);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE MASTER
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the cost-centre master", () => {
  test("create and list, company-scoped", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const { status, body } = await call(`/cost-centres?companyId=${a.company._id}`, {
      method: "POST", body: { name: "  Greenfield Industrial Park  " },
    });
    expect(status).toBe(201);
    expect(body.costCentre).toMatchObject({ name: "Greenfield Industrial Park", category: "Projects", isActive: true });

    expect((await call(`/cost-centres?companyId=${a.company._id}`)).body.costCentres).toHaveLength(1);
    expect((await call(`/cost-centres?companyId=${b.company._id}`)).body.costCentres).toEqual([]);
  });

  test("a differently-cased duplicate returns the existing one", async () => {
    const { company } = await seedCompany();
    await call(`/cost-centres?companyId=${company._id}`, { method: "POST", body: { name: "Greenfield" } });
    const { status, body } = await call(`/cost-centres?companyId=${company._id}`, {
      method: "POST", body: { name: "GREENFIELD" },
    });
    /* The model's unique index is case-SENSITIVE, so Mongo would happily store
       both and the picker would show one project twice. */
    expect(status).toBe(200);
    expect(body.alreadyExisted).toBe(true);
  });

  test("a nameless cost centre is refused, and a read-only role cannot create", async () => {
    const { company } = await seedCompany();
    expect((await call(`/cost-centres?companyId=${company._id}`, { method: "POST", body: { name: "  " } })).status).toBe(400);
    expect((await call(`/cost-centres?companyId=${company._id}`, { method: "POST", body: { name: "X" }, user: VIEWER })).status).toBe(403);
  });

  test("a retired cost centre leaves the picker but keeps reporting", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({
      company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })],
    });
    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 100000]] });

    await call(`/cost-centres/${green._id}?companyId=${company._id}`, {
      method: "PATCH", body: { isActive: false },
    });

    expect((await call(`/cost-centres?companyId=${company._id}`)).body.costCentres).toEqual([]);
    expect((await call(`/cost-centres?companyId=${company._id}&includeInactive=true`)).body.costCentres).toHaveLength(1);
    /* A project closed in March still has to explain what it spent in January. */
    expect((await detail(budget, company)).body.budget.items[0].actual).toBe(100000);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * BINDING LINES THROUGH THE ROUTE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("budget lines bind to cost centres", () => {
  const payload = (company, ledger, extra = {}) => ({
    name: "Greenfield FY", financialYear: "2026-27", period: "yearly", status: "active",
    startDate: "2026-04-01", endDate: "2027-03-31",
    items: [{ ledgerId: String(ledger._id), nature: "expense", department: "Projects", allocatedAmount: 500000 }],
    ...extra,
  });

  test("a project budget's lines INHERIT its cost centre rather than staying unbound", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");

    const { status, body } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST",
      body: payload(company, expenseLedger, {
        scope: "project", costCentreId: String(green._id), costCentreName: green.name,
      }),
    });

    expect(status).toBe(201);
    /* An unbound line on a project budget claims the whole head. Inheriting
       closes that by default instead of leaving it to be noticed. */
    expect(String(body.budget.items[0].costCentreId)).toBe(String(green._id));
    expect(body.budget.items[0].costCentreName).toBe("Greenfield");
  });

  test("a line may name a different cost centre than the budget's", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const sub = await cc(company, "Greenfield — Phase 2");

    const { body } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST",
      body: payload(company, expenseLedger, {
        scope: "project", costCentreId: String(green._id), costCentreName: green.name,
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", allocatedAmount: 500000, costCentreId: String(sub._id) }],
      }),
    });
    expect(String(body.budget.items[0].costCentreId)).toBe(String(sub._id));
    expect(body.budget.items[0].costCentreName).toBe("Greenfield — Phase 2");
  });

  test("company and department budget lines do NOT inherit anything", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { body } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST", body: payload(company, expenseLedger, { scope: "company" }),
    });
    expect(body.budget.items[0].costCentreId).toBeUndefined();
  });

  test("another company's cost centre is refused, not silently dropped", async () => {
    const { company, expenseLedger } = await seedCompany();
    const other = await seedCompany();
    const theirs = await cc(other.company, "Theirs");

    const { status, body } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST",
      body: payload(company, expenseLedger, {
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", allocatedAmount: 1, costCentreId: String(theirs._id) }],
      }),
    });

    /* Dropped, the line would read zero forever with nothing explaining why. */
    expect(status).toBe(400);
    expect(body.message).toMatch(/does not belong to this company/);
  });

  test("an unparseable cost centre id is refused", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { status } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST",
      body: payload(company, expenseLedger, {
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", allocatedAmount: 1, costCentreId: "not-an-id" }],
      }),
    });
    expect(status).toBe(400);
  });

  test("editing a budget binds its lines too", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const budget = await mkBudget({ company, scope: "company", items: [line(expenseLedger)] });

    const { body } = await call(`/budgets/${budget._id}?companyId=${company._id}`, {
      method: "PUT",
      body: {
        scope: "project", costCentreId: String(green._id), costCentreName: green.name,
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", allocatedAmount: 500000 }],
      },
    });
    expect(String(body.budget.items[0].costCentreId)).toBe(String(green._id));
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * BUDGET CONTROL
 * ══════════════════════════════════════════════════════════════════════════ */

describe("budget control respects the cost centre", () => {
  const check = (company, entries) =>
    call("/budgets/check-availability", {
      method: "POST",
      body: { companyId: String(company._id), voucherDate: "2026-08-15", ledgerEntries: entries },
    });

  const entry = (ledger, amount, allocations = []) => ({
    ledgerId: String(ledger._id), type: "Dr", amount,
    costCentreAllocations: allocations.map(([c, amt]) => ({ costCentreId: String(c._id), costCentreName: c.name, amount: amt })),
  });

  test("spend tagged to the project is authorised by the project's budget", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    await mkBudget({ company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    const { body } = await check(company, [entry(expenseLedger, 50000, [[green, 50000]])]);
    const row = body.results.find((r) => String(r.costCentreId) === String(green._id));
    expect(row.status).toBe("ok");
    expect(row.allocated).toBe(500000);
  });

  test("spend tagged to a DIFFERENT project is not authorised by this one", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const river = await cc(company, "Riverside");
    await mkBudget({ company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    const { body } = await check(company, [entry(expenseLedger, 50000, [[river, 50000]])]);
    /* A project budget authorising another project's spend would be the same
       defect as claiming its actuals. */
    expect(body.results[0].status).toBe("missing_budget");
  });

  test("UNTAGGED spend on a project-budgeted head asks for a tag, not a lie", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    await mkBudget({ company, costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    const { body } = await check(company, [entry(expenseLedger, 50000)]);

    /* "No approved allocation" would be false — there is ₹5,00,000 sitting
       right there — and would send the user hunting for a budget that exists. */
    expect(body.results[0].status).toBe("needs_cost_centre");
    expect(body.results[0].note).toMatch(/Greenfield/);
    expect(body.results[0].costCentreOptions[0].costCentreName).toBe("Greenfield");
    expect(body.requiredOverride).toBe(true);
  });

  test("a company budget on the same head still clears untagged spend", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    await mkBudget({ company, name: "Company FY", scope: "company", items: [line(expenseLedger)] });
    await mkBudget({ company, name: "Greenfield", costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    const { body } = await check(company, [entry(expenseLedger, 50000)]);
    /* The company line is unbound and authorises the head as a whole. */
    expect(body.results[0].status).toBe("ok");
  });

  test("a split entry is checked per project", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    const river = await cc(company, "Riverside");
    await mkBudget({ company, name: "Greenfield", costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green, allocatedAmount: 500000 })] });
    await mkBudget({ company, name: "Riverside", costCentreId: river._id, costCentreName: river.name,
      items: [line(expenseLedger, { costCentre: river, allocatedAmount: 10000 })] });

    const { body } = await check(company, [entry(expenseLedger, 100000, [[green, 60000], [river, 40000]])]);

    const g = body.results.find((r) => String(r.costCentreId) === String(green._id));
    const r = body.results.find((r) => String(r.costCentreId) === String(river._id));
    expect(g.status).toBe("ok");
    /* ₹40,000 against a ₹10,000 project allocation. */
    expect(r.status).toBe("over_budget");
  });

  test("company/department budgets with no cost centre behave exactly as before", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, name: "Company FY", scope: "company", items: [line(expenseLedger, { allocatedAmount: 100000 })] });

    const okBody = (await check(company, [entry(expenseLedger, 50000)])).body;
    expect(okBody.results[0].status).toBe("ok");
    expect(okBody.results[0].costCentreId).toBeNull();

    const overBody = (await check(company, [entry(expenseLedger, 500000)])).body;
    expect(overBody.results[0].status).toBe("over_budget");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ALLOCATION VALIDATION
 * ══════════════════════════════════════════════════════════════════════════ */

describe("allocation arithmetic", () => {
  const { validateCostCentreAllocations } = require("../../services/budgetControl.service");
  const alloc = (id, amount, name = "P") => ({ costCentreId: id, costCentreName: name, amount });
  const A = new mongoose.Types.ObjectId();
  const B = new mongoose.Types.ObjectId();

  test("allocations may total less than the line — the rest is simply untagged", () => {
    expect(validateCostCentreAllocations([
      { ledgerName: "Freight", amount: 100000, costCentreAllocations: [alloc(A, 60000)] },
    ])).toEqual([]);
  });

  test("allocations may total exactly the line", () => {
    expect(validateCostCentreAllocations([
      { ledgerName: "Freight", amount: 100000, costCentreAllocations: [alloc(A, 60000), alloc(B, 40000)] },
    ])).toEqual([]);
  });

  test("allocating MORE than the line holds is refused", () => {
    const problems = validateCostCentreAllocations([
      { ledgerName: "Freight", amount: 100000, costCentreAllocations: [alloc(A, 60000), alloc(B, 60000)] },
    ]);
    /* Stored, this would let a project report more spend than the ledger
       recorded — the one direction an accounting figure must never be wrong. */
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/more than the line/);
  });

  test("one project allocated twice on one line is refused", () => {
    const problems = validateCostCentreAllocations([
      { ledgerName: "Freight", amount: 100000, costCentreAllocations: [alloc(A, 10000), alloc(A, 10000)] },
    ]);
    expect(problems[0]).toMatch(/allocated twice/);
  });

  test("an allocation with no cost centre, or a negative amount, is refused", () => {
    expect(validateCostCentreAllocations([
      { ledgerName: "F", amount: 100, costCentreAllocations: [{ amount: 10 }] },
    ])[0]).toMatch(/no cost centre/);
    expect(validateCostCentreAllocations([
      { ledgerName: "F", amount: 100, costCentreAllocations: [alloc(A, -5)] },
    ])[0]).toMatch(/invalid amount/);
  });

  test("entries with no allocations at all pass untouched", () => {
    expect(validateCostCentreAllocations([
      { ledgerName: "F", amount: 100000 },
      { ledgerName: "G", amount: 100000, costCentreAllocations: [] },
    ])).toEqual([]);
  });

  test("a rounding-sized excess is tolerated, matching the Dr/Cr rule", () => {
    expect(validateCostCentreAllocations([
      { ledgerName: "F", amount: 100000, costCentreAllocations: [alloc(A, 100000.005)] },
    ])).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OVERLAP DEDUPE STILL WORKS
 * ══════════════════════════════════════════════════════════════════════════ */

describe("dashboard dedupe with cost-centre lines", () => {
  const dash = (company) =>
    call(`/budgets/dashboard?companyId=${company._id}&asOf=2027-03-31`);

  test("project beats company for TAGGED spend, and the voucher counts once", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    await mkBudget({ company, name: "Company FY", scope: "company", items: [line(expenseLedger)] });
    await mkBudget({ company, name: "Greenfield", costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 100000]] });

    const { body } = await dash(company);
    const byName = Object.fromEntries(body.budgets.map((b) => [b.name, b]));

    expect(body.totals.expense.actual).toBe(100000);
    expect(byName["Greenfield"].totals.expense.actual).toBe(100000);
    expect(byName["Company FY"].totals.expense.actual).toBe(0);
  });

  test("UNTAGGED spend goes to the company budget — the project cannot claim it", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    await mkBudget({ company, name: "Company FY", scope: "company", items: [line(expenseLedger)] });
    await mkBudget({ company, name: "Greenfield", costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    await post({ company, ledger: expenseLedger, amount: 700000 });

    const { body } = await dash(company);
    const byName = Object.fromEntries(body.budgets.map((b) => [b.name, b]));

    expect(byName["Company FY"].totals.expense.actual).toBe(700000);
    expect(byName["Greenfield"].totals.expense.actual).toBe(0);
    expect(body.totals.expense.actual).toBe(700000);
  });

  test("a split voucher lands partly on the project and partly on the company", async () => {
    const { company, expenseLedger } = await seedCompany();
    const green = await cc(company, "Greenfield");
    await mkBudget({ company, name: "Company FY", scope: "company", items: [line(expenseLedger)] });
    await mkBudget({ company, name: "Greenfield", costCentreId: green._id, costCentreName: green.name,
      items: [line(expenseLedger, { costCentre: green })] });

    await post({ company, ledger: expenseLedger, amount: 100000, allocations: [[green, 60000]] });

    const { body } = await dash(company);
    const byName = Object.fromEntries(body.budgets.map((b) => [b.name, b]));

    expect(byName["Greenfield"].totals.expense.actual).toBe(60000);
    expect(byName["Company FY"].totals.expense.actual).toBe(40000);
    /* One ₹1,00,000 voucher, counted once in total. */
    expect(body.totals.expense.actual).toBe(100000);
  });
});
