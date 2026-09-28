// test/requests/spend-line-allocation.route.test.js
//
// ONE REQUEST, SEVERAL BUDGET HEADS, ONE COMMITMENT.
//
// ── THE PROBLEM ─────────────────────────────────────────────────────────────
// A request buys fabric from Raw Materials, packaging from Packaging, freight
// from Freight and a repair from Repairs & Maintenance. A commitment could
// express exactly one head, so finance either split the request into four or
// charged three of them somewhere they do not belong — and the budget report
// was then wrong about all four, in a way the report itself could not show.
//
// ── AND THE TRAP THIS SUITE EXISTS FOR ──────────────────────────────────────
// Two lines charged to the same head are ONE claim on its headroom. Checking
// them separately lets each read the same starting availability and each
// conclude it fits, so ₹6,000 and ₹5,000 both pass against ₹10,000 and the
// head goes ₹1,000 over on two individually correct approvals.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const ItemCategoryBudget = require("../../models/Accountant_model/Acc_ItemCategoryBudget");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const Employee = require("../../models/Employee");
const budgetMatch = require("../../services/budgetCommitment.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests/spend`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
    name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * A company with FOUR approved heads for Logistics — the point of the chunk is
 * that one request can span them — plus one head approved for a DIFFERENT
 * department, which this one must never be able to charge.
 */
async function seed({ amounts = {} } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `LW Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const mk = async (name) => Acc_Ledger.create({
    companyId: company._id, name: `${name} ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });

  const raw = await mk("Raw Materials");
  const packaging = await mk("Packaging");
  const freight = await mk("Freight");
  const repairs = await mk("Repairs & Maintenance");
  const elsewhere = await mk("Design Tools");

  const budget = await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: raw._id, ledgerName: raw.name, nature: "expense", department: "Logistics", allocatedAmount: amounts.raw ?? 50000 },
      { ledgerId: packaging._id, ledgerName: packaging.name, nature: "expense", department: "Logistics", allocatedAmount: amounts.packaging ?? 50000 },
      { ledgerId: freight._id, ledgerName: freight.name, nature: "expense", department: "Logistics", allocatedAmount: amounts.freight ?? 50000 },
      { ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense", department: "Logistics", allocatedAmount: amounts.repairs ?? 50000 },
      /* Approved, live, and NOT this department's. */
      { ledgerId: elsewhere._id, ledgerName: elsewhere.name, nature: "expense", department: "Design", allocatedAmount: 50000 },
    ],
    budgetRequests: [],
  }));

  const tl = await Employee.create({ firstName: "Sakib", lastName: `Tl${n}`, email: `lwtl${n}@demo.example`, isActive: true, gender: "Other", biometricId: `LWTL${n}`, department: "Logistics" });
  const emp = await Employee.create({ firstName: "Rutu", lastName: `Emp${n}`, email: `lwemp${n}@demo.example`, isActive: true, gender: "Other", biometricId: `LWEM${n}`, department: "Logistics", primaryManager: { managerId: tl._id } });
  const finEmp = await Employee.create({ firstName: "Soumya", lastName: `Fin${n}`, email: `lwfin${n}@demo.example`, isActive: true, gender: "Other", biometricId: `LWFN${n}`, department: "Accounts" });
  await Acc_User.create({ organizationId: new mongoose.Types.ObjectId(), email: `lwfin${n}@demo.example`, name: "Finance", role: "approver", isActive: true, passwordHash: "x" });

  const storeDept = (await AccessDepartment.findOne({ slug: "store" }))
    || (await AccessDepartment.create({ key: `store-${n}`, slug: "store", name: "Store & Purchase", dashboardPath: "/store", isActive: true }));
  const store = await Employee.create({ firstName: "Bikash", lastName: `S${n}`, email: `lwstore${n}@demo.example`, isActive: true, gender: "Other", biometricId: `LWST${n}`, department: "Store", accessDepartmentId: storeDept._id });

  const lineOf = (ledger) => budget.items.find((i) => String(i.ledgerId) === String(ledger._id));
  return {
    company, budget, raw, packaging, freight, repairs, elsewhere,
    emp, tl, finEmp, store, lineOf,
  };
}

/** A PRODUCT request on the given head, with the given lines, at pending_finance. */
async function productAtFinance(s, ledger, items) {
  const { body } = await call(s.emp, "/", {
    method: "POST",
    body: {
      title: "Mixed purchase", requestType: "PRODUCT", purpose: "Production run",
      ledgerId: String(ledger._id), plannedItemKey: PLANNED_KEY,
      items: items.map((i) => ({ whyNeeded: "needed", unit: "pcs", ...i })),
    },
  });
  if (!body?.request) throw new Error(`raise failed: ${JSON.stringify(body)}`);
  const id = body.request._id;
  await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
  return id;
}

const approve = (s, id, body = {}) =>
  call(s.finEmp, `/${id}/approve`, { method: "PATCH", body });

const review = (s, id) => call(s.finEmp, `/${id}/line-allocations`);

const lineIds = async (id) =>
  (await SpendRequest.findById(id).lean()).items.map((l) => String(l._id));

const mkItem = (over = {}) => RawItem.create({
  name: `Item ${++seq}`, sku: `SKU${seq}`, unit: "pcs", ...over,
});

/* ═══ 1–4 · SEVERAL HEADS, ONE DOCUMENT ════════════════════════════════════ */

describe("one request, several budget heads", () => {
  test("two lines allocate to two different heads", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "Cotton fabric", quantity: 1, rate: 6000 },
      { name: "Cartons", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);

    const res = await approve(s, id, {
      lineAllocations: { lines: [
        { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
        { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
      ] },
    });

    expect(res.status).toBe(200);
    const heads = res.body.allocation.heads;
    expect(heads).toHaveLength(2);
    expect(heads.map((h) => h.ledgerName).sort())
      .toEqual([s.packaging.name, s.raw.name].sort());
    expect(heads.find((h) => h.ledgerName === s.raw.name).amount).toBe(6000);
    expect(heads.find((h) => h.ledgerName === s.packaging.name).amount).toBe(4000);
  });

  test("one commitment document contains both allocations", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "Cotton fabric", quantity: 1, rate: 6000 },
      { name: "Cartons", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });

    /* One approval, one promise. Three documents would hand back the
       idempotency the unique index exists to give. */
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(1);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.allocations).toHaveLength(2);
    expect(c.allocations.map((x) => x.amount).sort((x, y) => x - y)).toEqual([4000, 6000]);
    expect(c.amount).toBe(10000);
    expect(c.headCount).toBe(2);
    expect(c.allocationMode).toBe("line_wise");
  });

  test("no fake top-level primary ledger is stored for a multi-head commitment", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "Cotton fabric", quantity: 1, rate: 6000 },
      { name: "Cartons", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    /* Naming one of them at the top would be a figure every report reads and
       no human chose. */
    expect(c.ledgerId).toBeUndefined();
    expect(c.ledgerName).toBeUndefined();
    expect(c.budgetLineId).toBeUndefined();
    expect(c.budgetId).toBeUndefined();
    expect(c.snapshot).toBeUndefined();
    /* And the real answer is present. */
    expect(c.headCount).toBe(2);
  });

  test("a single-head request keeps its compatibility fields populated", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [{ name: "Cotton fabric", quantity: 1, rate: 6000 }]);

    await approve(s, id);

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.allocationMode).toBe("single_head");
    /* Every existing reader, report and compatibility path untouched. */
    expect(String(c.ledgerId)).toBe(String(s.raw._id));
    expect(c.ledgerName).toBe(s.raw.name);
    expect(String(c.budgetLineId)).toBe(String(s.lineOf(s.raw)._id));
    expect(c.snapshot).toBeTruthy();
    expect(c.allocations).toHaveLength(1);
  });
});

/* ═══ 5–8 · WHERE EACH LINE'S HEAD COMES FROM ══════════════════════════════ */

describe("resolving a head per line", () => {
  test("a product item override resolves the line", async () => {
    const s = await seed();
    const item = await mkItem({
      category: "Fabric",
      budgetLedgerId: s.packaging._id, budgetLedgerName: s.packaging.name,
    });
    const id = await productAtFinance(s, s.raw, [{ name: "Cotton fabric", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });

    const res = await review(s, id);
    const [l] = res.body.allocation.lines;
    expect(l.resolutionSource).toBe("item_override");
    expect(l.ledgerName).toBe(s.packaging.name);
  });

  test("a product category mapping resolves the line", async () => {
    const s = await seed();
    await ItemCategoryBudget.create({
      companyId: s.company._id, category: "Packing", categoryKey: "packing",
      budgetLedgerId: s.packaging._id, budgetLedgerName: s.packaging.name,
    });
    const item = await mkItem({ category: "Packing" });
    const id = await productAtFinance(s, s.raw, [{ name: "Cartons", quantity: 1, rate: 4000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });

    const res = await review(s, id);
    const [l] = res.body.allocation.lines;
    expect(l.resolutionSource).toBe("category_mapping");
    expect(l.ledgerName).toBe(s.packaging.name);
  });

  test("a service default resolves the line", async () => {
    const s = await seed();
    const svc = await Service.create({
      companyId: s.company._id, serviceCode: `SVC-${++seq}`, name: "Lift AMC", status: "ACTIVE",
      budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { body } = await call(s.emp, "/", { method: "POST", body: {
      title: "AMC", requestType: "SERVICE", purpose: "annual",
      ledgerId: String(s.raw._id), plannedItemKey: PLANNED_KEY,
      items: [{ name: "Lift service", whyNeeded: "annual", quantity: 1, unit: "visit", rate: 6000 }],
    } });
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const [a] = await lineIds(id);
    await call(s.store, `/${id}/service-lines`, {
      method: "PATCH", body: { lines: [{ spendLineId: a, serviceId: String(svc._id) }] },
    });

    const res = await review(s, id);
    const [l] = res.body.allocation.lines;
    expect(l.resolutionSource).toBe("service_default");
    expect(l.ledgerName).toBe(s.repairs.name);
  });

  test("a service never falls through to an Item Category mapping", async () => {
    const s = await seed();
    /* An item category spelled exactly like the service's own. */
    await ItemCategoryBudget.create({
      companyId: s.company._id, category: "Facilities", categoryKey: "facilities",
      budgetLedgerId: s.packaging._id, budgetLedgerName: s.packaging.name,
    });
    const svc = await Service.create({
      companyId: s.company._id, serviceCode: `SVC-${++seq}`, name: "Lift AMC",
      category: "Facilities", status: "ACTIVE",
    });
    const { body } = await call(s.emp, "/", { method: "POST", body: {
      title: "AMC", requestType: "SERVICE", purpose: "annual",
      ledgerId: String(s.raw._id), plannedItemKey: PLANNED_KEY,
      items: [{ name: "Lift service", whyNeeded: "annual", quantity: 1, unit: "visit", rate: 6000 }],
    } });
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const [a] = await lineIds(id);
    await call(s.store, `/${id}/service-lines`, {
      method: "PATCH", body: { lines: [{ spendLineId: a, serviceId: String(svc._id) }] },
    });

    const res = await review(s, id);
    const [l] = res.body.allocation.lines;
    /* Item categories describe what the STORE STOCKS. A maintenance contract
       inheriting one would be charged to a materials budget and look entirely
       deliberate on the report. */
    expect(l.resolutionSource).not.toBe("category_mapping");
    expect(l.ledgerName).not.toBe(s.packaging.name);
    /* It falls back to the request's own approved head, recorded as such. */
    expect(l.resolutionSource).toBe("request_head");
    expect(l.ledgerName).toBe(s.raw.name);
  });

  test("a line nothing resolves falls back to the request's head, named honestly", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [{ name: "Free-typed thing", quantity: 1, rate: 6000 }]);

    const res = await review(s, id);
    const [l] = res.body.allocation.lines;
    /* Not dressed as a line-level classification — nobody classified it. */
    expect(l.resolutionSource).toBe("request_head");
    expect(l.ledgerName).toBe(s.raw.name);
  });
});

/* ═══ 9–12 · FINANCE'S OWN CHOICES ═════════════════════════════════════════ */

describe("finance choosing a different head", () => {
  test("changing a configured default requires a reason, and stores it", async () => {
    const s = await seed();
    const item = await mkItem({
      category: "Fabric",
      budgetLedgerId: s.raw._id, budgetLedgerName: s.raw.name,
    });
    const id = await productAtFinance(s, s.raw, [{ name: "Cotton fabric", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });
    const [a] = await lineIds(id);

    const refused = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.freight)._id) },
    ] } });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("LINE_ALLOCATION_UNRESOLVED");
    expect(refused.body.problems[0].code).toBe("REASON_REQUIRED");
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);

    const ok = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.freight)._id),
        reason: "This roll is inbound carriage, not material." },
    ] } });
    expect(ok.status).toBe(200);

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.allocations[0].resolutionSource).toBe("manual_selection");
    expect(c.allocations[0].resolutionReason).toMatch(/inbound carriage/);
    expect(c.allocations[0].selectedByName).toMatch(/^Soumya/);
    expect(c.allocations[0].selectedAt).toBeInstanceOf(Date);
    expect(c.allocations[0].ledgerName).toBe(s.freight.name);
  });

  test("choosing the suggested head by hand is not a manual override", async () => {
    const s = await seed();
    const item = await mkItem({ budgetLedgerId: s.raw._id, budgetLedgerName: s.raw.name });
    const id = await productAtFinance(s, s.raw, [{ name: "Cotton fabric", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });
    const [a] = await lineIds(id);

    /* No reason needed: nothing was contradicted. */
    const res = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
    ] } });
    expect(res.status).toBe(200);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.allocations[0].resolutionSource).toBe("item_override");
  });

  test("another department's approved head is refused", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [{ name: "Cotton fabric", quantity: 1, rate: 6000 }]);
    const [a] = await lineIds(id);

    /* `Design Tools` is a real, live, approved budget line — for Design. */
    const res = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.elsewhere)._id), reason: "why not" },
    ] } });

    expect(res.status).toBe(409);
    expect(res.body.problems[0].code).toBe("HEAD_NOT_APPROVED");
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("an arbitrary expense ledger is not an approved budget head", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [{ name: "Cotton fabric", quantity: 1, rate: 6000 }]);
    const [a] = await lineIds(id);

    /* Exists in the chart of accounts, has no approved budget line at all. */
    const res = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(new mongoose.Types.ObjectId()), reason: "x" },
    ] } });

    expect(res.status).toBe(409);
    expect(res.body.problems[0].code).toBe("HEAD_NOT_APPROVED");
  });

  test("a suggested head this department has no budget on cannot silently approve", async () => {
    const s = await seed();
    /* The item points at Design Tools — approved, but for Design. */
    const item = await mkItem({
      budgetLedgerId: s.elsewhere._id, budgetLedgerName: s.elsewhere.name,
    });
    const id = await productAtFinance(s, s.raw, [{ name: "Design asset", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });

    const res = await approve(s, id);

    /* Neither charged to it nor quietly moved to the request's head: finance
       must say which they mean. */
    expect(res.status).toBe(409);
    expect(res.body.problems[0].code).toBe("SUGGESTED_HEAD_UNAVAILABLE");
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("an explicitly unbudgeted line stays visible and reduces nothing", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "Cotton fabric", quantity: 1, rate: 6000 },
      { name: "Something with no head", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);

    const res = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, unbudgeted: true, reason: "No head covers this yet." },
    ] } });
    expect(res.status).toBe(200);

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    const un = c.allocations.find((x) => x.status === "unbudgeted");
    expect(un.amount).toBe(4000);
    expect(un.budgetLineId).toBeNull();
    /* Still a promise the company has made, and finance can total it. */
    expect(res.body.allocation.unbudgeted.amount).toBe(4000);
    /* Half budgeted is not an unbudgeted request. */
    expect(c.status).toBe("committed");

    /* And the head only carries the budgeted part. */
    const live = await budgetMatch.committedByLine([s.lineOf(s.raw)._id]);
    expect(live.get(String(s.lineOf(s.raw)._id))).toBe(6000);
  });
});

/* ═══ 13–14 · CUMULATIVE AVAILABILITY ══════════════════════════════════════ */

describe("two lines on one head are one claim", () => {
  test("the brief's example: 10,000 against 6,000 + 5,000 reports a 1,000 shortage", async () => {
    const s = await seed({ amounts: { raw: 10000 } });
    const id = await productAtFinance(s, s.raw, [
      { name: "Line A", quantity: 1, rate: 6000 },
      { name: "Line B", quantity: 1, rate: 5000 },
    ]);
    const [a, b] = await lineIds(id);
    const rawLine = String(s.lineOf(s.raw)._id);

    const res = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: rawLine },
      { spendLineId: b, budgetLineId: rawLine },
    ] } });

    expect(res.status).toBe(200);
    const heads = res.body.allocation.heads;
    /* ONE head, both lines, checked once. */
    expect(heads).toHaveLength(1);
    expect(heads[0].lineCount).toBe(2);
    expect(heads[0].amount).toBe(11000);
    expect(heads[0].availableBefore).toBe(10000);
    expect(heads[0].availableAfter).toBe(-1000);
    expect(heads[0].shortfall).toBe(1000);
    expect(heads[0].status).toBe("insufficient");
    /* The existing vocabulary, at the grouped level — finance is not blocked,
       and the request records which kind of yes it was. */
    expect(res.body.request.budgetApprovalKind).toBe("over_budget");
  });

  test("neither line alone would have shown a shortage — which is the trap", async () => {
    const s = await seed({ amounts: { raw: 10000 } });
    const id = await productAtFinance(s, s.raw, [{ name: "Line A", quantity: 1, rate: 6000 }]);

    const res = await approve(s, id);
    expect(res.body.allocation.heads[0].status).toBe("within_budget");
    expect(res.body.request.budgetApprovalKind).toBe("within_budget");
  });

  test("two lines on DIFFERENT heads are checked separately", async () => {
    const s = await seed({ amounts: { raw: 10000, packaging: 10000 } });
    const id = await productAtFinance(s, s.raw, [
      { name: "Line A", quantity: 1, rate: 6000 },
      { name: "Line B", quantity: 1, rate: 5000 },
    ]);
    const [a, b] = await lineIds(id);

    const res = await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });

    expect(res.body.allocation.heads.every((h) => h.status === "within_budget")).toBe(true);
    expect(res.body.request.budgetApprovalKind).toBe("within_budget");
  });
});

/* ═══ 15–17 · THE PAISE ════════════════════════════════════════════════════ */

describe("line amounts and the approved total", () => {
  test("lines plus proportional adjustments equal grandTotal exactly", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 3333.33 },
      { name: "B", quantity: 1, rate: 3333.33 },
      { name: "C", quantity: 1, rate: 3333.34 },
    ]);
    /* A header round-off that belongs to no line. */
    await SpendRequest.updateOne({ _id: id }, { $set: { grandTotal: 9000 } });

    const res = await approve(s, id);

    expect(res.status).toBe(200);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    const paise = c.allocations.reduce((t, a) => t + Math.round(a.amount * 100), 0);
    expect(paise).toBe(900000);
    expect(c.amount).toBe(9000);
    /* And the adjustment is visible per line, not folded in silently. */
    expect(c.allocations.every((a) => typeof a.adjustment === "number")).toBe(true);
    expect(c.allocations.reduce((t, a) => t + Math.round(a.adjustment * 100), 0)).toBe(-100000);
  });

  test("an explicit zero line survives into its allocation", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "Paid", quantity: 1, rate: 6000 },
      { name: "Free of charge", quantity: 1, rate: 0.01 },
    ]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.1.amount": 0, "items.1.lineTotal": 0 } });

    const res = await approve(s, id);
    expect(res.status).toBe(200);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    const zero = c.allocations.find((a) => a.name === "Free of charge");
    /* Zero is a figure. Absent would have been refused. */
    expect(zero.amount).toBe(0);
    expect(zero.status).toBe("committed");
  });

  test("a negative line amount refuses the approval", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.lineTotal": -1 } });

    const res = await approve(s, id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("NEGATIVE_LINE_AMOUNT");
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("an unallocatable header adjustment refuses rather than dropping a paise", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, {
      $set: { "items.0.amount": 0, "items.0.lineTotal": 0, grandTotal: 500 },
    });

    const res = await approve(s, id);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("ADJUSTMENT_NOT_ALLOCATABLE");
  });
});

/* ═══ 18–20 · AVAILABILITY COUNTS EACH SHAPE ONCE ══════════════════════════ */

describe("committedByLine reads both commitment shapes", () => {
  test("a line-wise commitment counts through its allocations", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });

    const live = await budgetMatch.committedByLine([
      s.lineOf(s.raw)._id, s.lineOf(s.packaging)._id,
    ]);
    expect(live.get(String(s.lineOf(s.raw)._id))).toBe(6000);
    expect(live.get(String(s.lineOf(s.packaging)._id))).toBe(4000);
  });

  test("a legacy commitment with no allocations still counts by its top-level amount", async () => {
    const s = await seed();
    const line = s.lineOf(s.raw);
    await Commitment.create({
      spendRequestId: new mongoose.Types.ObjectId(),
      spendRequestNumber: "OLD-1",
      companyId: s.company._id,
      budgetId: s.budget._id, budgetLineId: line._id,
      ledgerId: s.raw._id, ledgerName: s.raw.name,
      amount: 7500, status: "committed",
    });

    const live = await budgetMatch.committedByLine([line._id]);
    expect(live.get(String(line._id))).toBe(7500);
  });

  test("a SINGLE-head commitment carries both shapes and still counts once", async () => {
    /* ── WHERE THE DOUBLE-COUNT ACTUALLY LIVES ────────────────────────────
       A multi-head commitment has no top-level `budgetLineId`, so the legacy
       query cannot reach it whatever else is true — the exclusion is belt as
       well as braces there.

       A SINGLE-head one has BOTH: the compatibility fields the old readers
       need AND an `allocations[]`. That is the document that gets counted
       twice if the legacy query does not exclude allocation-bearing rows,
       and it is the ordinary shape of almost every request. */
    const s = await seed();
    const rawLine = s.lineOf(s.raw);
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 6000 }]);
    await approve(s, id);

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    /* Both shapes on one document — the precondition for the trap. */
    expect(c.allocationMode).toBe("single_head");
    expect(String(c.budgetLineId)).toBe(String(rawLine._id));
    expect(c.allocations).toHaveLength(1);

    const live = await budgetMatch.committedByLine([rawLine._id]);
    expect(live.get(String(rawLine._id))).toBe(6000);
    expect(live.get(String(rawLine._id))).not.toBe(12000);
  });

  test("a new commitment is never counted through both paths", async () => {
    const s = await seed();
    const rawLine = s.lineOf(s.raw);
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    /* BOTH lines on the same head: the top-level amount (10,000) equals the
       allocation total, so a double count would be invisible as a sum and
       show only as exactly twice the figure. */
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(rawLine._id) },
      { spendLineId: b, budgetLineId: String(rawLine._id) },
    ] } });

    const live = await budgetMatch.committedByLine([rawLine._id]);
    expect(live.get(String(rawLine._id))).toBe(10000);
    expect(live.get(String(rawLine._id))).not.toBe(20000);
  });

  test("legacy and line-wise commitments on one head add up once each", async () => {
    const s = await seed();
    const rawLine = s.lineOf(s.raw);
    await Commitment.create({
      spendRequestId: new mongoose.Types.ObjectId(), spendRequestNumber: "OLD-2",
      companyId: s.company._id, budgetId: s.budget._id, budgetLineId: rawLine._id,
      ledgerId: s.raw._id, ledgerName: s.raw.name, amount: 1000, status: "committed",
    });
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 2000 }]);
    await approve(s, id);

    const live = await budgetMatch.committedByLine([rawLine._id]);
    expect(live.get(String(rawLine._id))).toBe(3000);
  });

  test("an unbudgeted allocation reduces no approved line", async () => {
    const s = await seed();
    const rawLine = s.lineOf(s.raw);
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(rawLine._id) },
      { spendLineId: b, unbudgeted: true, reason: "No head yet." },
    ] } });

    const live = await budgetMatch.committedByLine([rawLine._id]);
    expect(live.get(String(rawLine._id))).toBe(6000);
  });

  test("a released commitment stops counting", async () => {
    const s = await seed();
    const rawLine = s.lineOf(s.raw);
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 6000 }]);
    await approve(s, id);
    await Commitment.updateOne({ spendRequestId: id }, { $set: { status: "released" } });

    const live = await budgetMatch.committedByLine([rawLine._id]);
    expect(live.get(String(rawLine._id)) || 0).toBe(0);
  });
});

/* ═══ 21–24 · WHAT MUST NOT HAVE CHANGED ═══════════════════════════════════ */

describe("the boundary", () => {
  test("approving twice creates no second commitment", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    const alloc = { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] };

    await approve(s, id, { lineAllocations: alloc });
    await approve(s, id, { lineAllocations: alloc });

    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(1);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.allocations).toHaveLength(2);
  });

  test("cancelling the request releases the one commitment once", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });

    const cancelled = await call(s.finEmp, `/${id}/cancel`, {
      method: "PATCH", body: { note: "No longer needed." },
    });
    expect(cancelled.status).toBe(200);

    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(1);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.status).toBe("released");
    /* And neither head is still blocked. */
    const live = await budgetMatch.committedByLine([
      s.lineOf(s.raw)._id, s.lineOf(s.packaging)._id,
    ]);
    expect(live.get(String(s.lineOf(s.raw)._id)) || 0).toBe(0);
    expect(live.get(String(s.lineOf(s.packaging)._id)) || 0).toBe(0);
  });

  test("rejection is never gated on allocation", async () => {
    const s = await seed();
    const item = await mkItem({
      budgetLedgerId: s.elsewhere._id, budgetLedgerName: s.elsewhere.name,
    });
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });

    /* Approval would be refused — the suggested head is another department's.
       Refusing an unallocatable request is still a perfectly good answer. */
    const res = await call(s.finEmp, `/${id}/reject`, {
      method: "PATCH", body: { note: "Not this year." },
    });
    expect(res.status).toBe(200);
    expect((await SpendRequest.findById(id).lean()).status).toBe("rejected");
  });

  test("the approved commercial snapshot still reaches an order", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 2, rate: 3000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.vendorName": "Fabric Co", "items.1.vendorName": "Fabric Co" } });
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });

    const po = await call(s.store, `/${id}/purchase-order`, { method: "POST", body: {} });
    expect(po.status).toBe(201);
    const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
    const order = await PurchaseOrder.findOne({ spendRequestId: id }).lean();
    /* Allocation split the BUDGET, not the quote — the order still carries
       exactly what was approved commercially. (`unitPrice` on the order, not
       `rate`: the request line and the order line name it differently.) */
    expect(order.items[0].quantity).toBe(2);
    expect(order.items[0].unitPrice).toBe(3000);
    expect(order.items[0].itemName).toBe("A");
    expect(order.items[1].unitPrice).toBe(4000);
    expect(order.totalAmount).toBe(10000);
  });

  test("approval creates no voucher, actual or stock record", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    const [a, b] = await lineIds(id);

    const WATCHED = ["acc_vouchers", "purchaseorders", "serviceorders",
      "stocktransactions", "stockadjustments", "goodsreceipts"];
    const db = mongoose.connection.db;
    const countAll = async () => {
      const out = {};
      for (const n of WATCHED) out[n] = await db.collection(n).countDocuments();
      return out;
    };

    const before = await countAll();
    await approve(s, id, { lineAllocations: { lines: [
      { spendLineId: a, budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: b, budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } });
    const after = await countAll();

    /* A promise, not an accounting actual. The commitment is the one thing
       approval writes, and it already did before B3A. */
    expect(after).toEqual(before);
  });
});

/* ═══ THE REVIEW SURFACE ═══════════════════════════════════════════════════ */

describe("what finance reviews before approving", () => {
  test("the review shows every line, its suggestion and its head's figures", async () => {
    const s = await seed({ amounts: { raw: 10000 } });
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 5000 },
    ]);

    const res = await review(s, id);

    expect(res.status).toBe(200);
    expect(res.body.allocation.lines).toHaveLength(2);
    const [g] = res.body.allocation.heads;
    expect(g.approved).toBe(10000);
    expect(g.committedBefore).toBe(0);
    expect(g.actual).toBe(0);
    expect(g.availableBefore).toBe(10000);
    expect(g.availableAfter).toBe(-1000);
    expect(g.status).toBe("insufficient");
    /* And the heads finance may choose are approved LINES, not the chart. */
    expect(res.body.heads.map((h) => h.name).sort())
      .toEqual([s.freight.name, s.packaging.name, s.raw.name, s.repairs.name].sort());
    expect(res.body.heads.map((h) => h.name)).not.toContain(s.elsewhere.name);
  });

  test("the review reports an unresolvable line rather than refusing", async () => {
    const s = await seed();
    const item = await mkItem({
      budgetLedgerId: s.elsewhere._id, budgetLedgerName: s.elsewhere.name,
    });
    const id = await productAtFinance(s, s.raw, [{ name: "A", quantity: 1, rate: 6000 }]);
    await SpendRequest.updateOne({ _id: id }, { $set: { "items.0.rawItem": item._id } });

    const res = await review(s, id);

    /* This is the surface finance fixes it on; an error page would be the
       wrong answer. */
    expect(res.status).toBe(200);
    expect(res.body.allocation).toBeNull();
    expect(res.body.problems[0].code).toBe("SUGGESTED_HEAD_UNAVAILABLE");
    expect(res.body.heads.length).toBeGreaterThan(0);
  });

  test("the totals reconcile the request against what was allocated", async () => {
    const s = await seed();
    const id = await productAtFinance(s, s.raw, [
      { name: "A", quantity: 1, rate: 6000 },
      { name: "B", quantity: 1, rate: 4000 },
    ]);
    await SpendRequest.updateOne({ _id: id }, { $set: { grandTotal: 9500 } });

    const res = await review(s, id);
    expect(res.body.allocation.totals.lines).toBe(10000);
    expect(res.body.allocation.totals.approved).toBe(9500);
    expect(res.body.allocation.totals.adjustment).toBe(-500);
    expect(res.body.allocation.totals.allocated).toBe(9500);
  });
});
