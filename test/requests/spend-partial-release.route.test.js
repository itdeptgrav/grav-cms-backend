// test/requests/spend-partial-release.route.test.js
//
// A BILL FOR SOME LINES RELEASES SOME LINES.
//
// ── THE BUG THIS SUITE EXISTS FOR ───────────────────────────────────────────
// A request buys fabric, packaging, freight and a repair, and commits against
// four budget heads. The supplier bills the fabric. Release was
// whole-document, so posting that bill freed the budget on all four — three
// heads had money back that nothing had been billed against, and the budget
// report said so with complete confidence.
//
// These exercise the real chain end to end: request → allocation → commitment
// → release, through the same functions the voucher route calls.
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
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Employee = require("../../models/Employee");
const budgetMatch = require("../../services/budgetCommitment.service");
const release = require("../../services/commitmentRelease.service");

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

async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `PR Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const mk = (name) => Acc_Ledger.create({
    companyId: company._id, name: `${name} ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  const raw = await mk("Raw Materials");
  const packaging = await mk("Packaging");
  const freight = await mk("Freight");
  const repairs = await mk("Repairs");

  const budget = await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [raw, packaging, freight, repairs].map((l) => ({
      ledgerId: l._id, ledgerName: l.name, nature: "expense",
      department: "Logistics", allocatedAmount: 50000,
    })),
    budgetRequests: [],
  }));

  const tl = await Employee.create({ firstName: "Sakib", lastName: `Tl${n}`, email: `prtl${n}@d.example`, isActive: true, gender: "Other", biometricId: `PRTL${n}`, department: "Logistics" });
  const emp = await Employee.create({ firstName: "Rutu", lastName: `Emp${n}`, email: `premp${n}@d.example`, isActive: true, gender: "Other", biometricId: `PREM${n}`, department: "Logistics", primaryManager: { managerId: tl._id } });
  const finEmp = await Employee.create({ firstName: "Soumya", lastName: `Fin${n}`, email: `prfin${n}@d.example`, isActive: true, gender: "Other", biometricId: `PRFN${n}`, department: "Accounts" });
  await Acc_User.create({ organizationId: new mongoose.Types.ObjectId(), email: `prfin${n}@d.example`, name: "Finance", role: "approver", isActive: true, passwordHash: "x" });

  const storeDept = (await AccessDepartment.findOne({ slug: "store" }))
    || (await AccessDepartment.create({ key: `store-${n}`, slug: "store", name: "Store & Purchase", dashboardPath: "/store", isActive: true }));
  const store = await Employee.create({ firstName: "Bikash", lastName: `S${n}`, email: `prstore${n}@d.example`, isActive: true, gender: "Other", biometricId: `PRST${n}`, department: "Store", accessDepartmentId: storeDept._id });

  const lineOf = (l) => budget.items.find((i) => String(i.ledgerId) === String(l._id));
  return { company, budget, raw, packaging, freight, repairs, emp, tl, finEmp, store, lineOf };
}

/** A four-line PRODUCT request, approved across four heads. */
async function approvedFourHeads(s) {
  const { body } = await call(s.emp, "/", {
    method: "POST",
    body: {
      title: "Production run", requestType: "PRODUCT", purpose: "Q3",
      ledgerId: String(s.raw._id), plannedItemKey: PLANNED_KEY,
      items: [
        { name: "Cotton fabric", whyNeeded: "x", quantity: 1, unit: "roll", rate: 6000 },
        { name: "Cartons", whyNeeded: "x", quantity: 1, unit: "box", rate: 4000 },
        { name: "Inbound carriage", whyNeeded: "x", quantity: 1, unit: "trip", rate: 2000 },
        { name: "Machine service", whyNeeded: "x", quantity: 1, unit: "visit", rate: 3000 },
      ],
    },
  });
  const id = body.request._id;
  await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
  const doc = await SpendRequest.findById(id).lean();
  const ids = doc.items.map((l) => String(l._id));

  await call(s.finEmp, `/${id}/approve`, {
    method: "PATCH",
    body: { lineAllocations: { lines: [
      { spendLineId: ids[0], budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: ids[1], budgetLineId: String(s.lineOf(s.packaging)._id) },
      { spendLineId: ids[2], budgetLineId: String(s.lineOf(s.freight)._id) },
      { spendLineId: ids[3], budgetLineId: String(s.lineOf(s.repairs)._id) },
    ] } },
  });
  return { id, lineIds: ids };
}

/** A bill, in the shape the voucher route hands the release engine. */
const bill = (over = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  voucherNumber: `PUR-${++seq}`,
  companyId: null,
  grandTotal: null,
  inventoryEntries: [],
  ...over,
});

const entry = (spendLineId, amount, taxAmount = 0) => ({
  _id: new mongoose.Types.ObjectId(),
  stockItemName: "Thing", quantity: 1, amount, taxAmount,
  ...(spendLineId ? { spendLineId } : {}),
});

const liveOn = async (s, ledger) =>
  (await budgetMatch.committedByLine([s.lineOf(ledger)._id]))
    .get(String(s.lineOf(ledger)._id)) || 0;

/* ═══ ONE OF FOUR ══════════════════════════════════════════════════════════ */

describe("billing one line of four", () => {
  test("releases only that allocation, and leaves the other three promised", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    await release.applyRelease({
      commitment,
      voucher: bill({ inventoryEntries: [entry(lineIds[0], 6000)] }),
      actor: { name: "Asha" },
    });

    const c = await Commitment.findById(commitment._id).lean();
    const byLine = new Map(c.allocations.map((a) => [String(a.spendLineId), a]));
    expect(byLine.get(lineIds[0]).status).toBe("released");
    expect(byLine.get(lineIds[0]).remainingAmount).toBe(0);
    /* The three heads nobody billed. This is the whole bug. */
    for (const other of [1, 2, 3]) {
      expect(byLine.get(lineIds[other]).status).toBe("committed");
      expect(byLine.get(lineIds[other]).releasedAmount).toBe(0);
    }
    /* And the document is not finished. */
    expect(c.status).toBe("partially_released");
  });

  test("the three unbilled heads still reduce available budget", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    await release.applyRelease({
      commitment,
      voucher: bill({ inventoryEntries: [entry(lineIds[0], 6000)] }),
      actor: {},
    });

    expect(await liveOn(s, s.raw)).toBe(0);
    expect(await liveOn(s, s.packaging)).toBe(4000);
    expect(await liveOn(s, s.freight)).toBe(2000);
    expect(await liveOn(s, s.repairs)).toBe(3000);
  });

  test("one voucher covering two heads releases both", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    await release.applyRelease({
      commitment,
      voucher: bill({ inventoryEntries: [
        entry(lineIds[0], 6000), entry(lineIds[2], 2000),
      ] }),
      actor: {},
    });

    expect(await liveOn(s, s.raw)).toBe(0);
    expect(await liveOn(s, s.freight)).toBe(0);
    expect(await liveOn(s, s.packaging)).toBe(4000);
  });
});

/* ═══ TWO LINES, ONE HEAD ══════════════════════════════════════════════════ */

describe("two lines sharing one head", () => {
  async function twoOnOneHead(s) {
    const { body } = await call(s.emp, "/", {
      method: "POST",
      body: {
        title: "Two rolls", requestType: "PRODUCT", purpose: "Q3",
        ledgerId: String(s.raw._id), plannedItemKey: PLANNED_KEY,
        items: [
          { name: "Roll A", whyNeeded: "x", quantity: 1, unit: "roll", rate: 6000 },
          { name: "Roll B", whyNeeded: "x", quantity: 1, unit: "roll", rate: 4000 },
        ],
      },
    });
    const id = body.request._id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const doc = await SpendRequest.findById(id).lean();
    const ids = doc.items.map((l) => String(l._id));
    await call(s.finEmp, `/${id}/approve`, {
      method: "PATCH",
      body: { lineAllocations: { lines: ids.map((x) => ({
        spendLineId: x, budgetLineId: String(s.lineOf(s.raw)._id),
      })) } },
    });
    return { id, lineIds: ids };
  }

  test("they release independently but aggregate on the head", async () => {
    const s = await seed();
    const { id, lineIds } = await twoOnOneHead(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });
    expect(await liveOn(s, s.raw)).toBe(10000);

    await release.applyRelease({
      commitment,
      voucher: bill({ inventoryEntries: [entry(lineIds[0], 6000)] }),
      actor: {},
    });

    /* One of the two lines billed: the head is still blocked by the other. */
    expect(await liveOn(s, s.raw)).toBe(4000);
    const c = await Commitment.findById(commitment._id).lean();
    expect(c.allocations.find((a) => String(a.spendLineId) === lineIds[0]).status).toBe("released");
    expect(c.allocations.find((a) => String(a.spendLineId) === lineIds[1]).status).toBe("committed");
  });
});

/* ═══ PROGRESSIVE AND REPEATED ═════════════════════════════════════════════ */

describe("several bills against one line", () => {
  test("two partial vouchers release progressively", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    let commitment = await Commitment.findOne({ spendRequestId: id });

    await release.applyRelease({
      commitment, voucher: bill({ inventoryEntries: [entry(lineIds[0], 2000)] }), actor: {},
    });
    expect(await liveOn(s, s.raw)).toBe(4000);

    commitment = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({
      commitment, voucher: bill({ inventoryEntries: [entry(lineIds[0], 4000)] }), actor: {},
    });
    expect(await liveOn(s, s.raw)).toBe(0);

    const c = await Commitment.findById(commitment._id).lean();
    const a = c.allocations.find((x) => String(x.spendLineId) === lineIds[0]);
    expect(a.releases).toHaveLength(2);
    /* The approved figure is never rewritten. */
    expect(a.amount).toBe(6000);
    expect(a.releasedAmount).toBe(6000);
  });

  test("over-billing caps the release at what was promised", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    await release.applyRelease({
      commitment, voucher: bill({ inventoryEntries: [entry(lineIds[0], 9000)] }), actor: {},
    });

    const c = await Commitment.findById(commitment._id).lean();
    const a = c.allocations.find((x) => String(x.spendLineId) === lineIds[0]);
    expect(a.releasedAmount).toBe(6000);
    /* Never negative — the head must not be given money it never had. */
    expect(a.remainingAmount).toBe(0);
    expect(await liveOn(s, s.raw)).toBe(0);
  });

  test("saving the same voucher twice does not release twice", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const v = bill({ inventoryEntries: [entry(lineIds[0], 3000)] });

    let commitment = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment, voucher: v, actor: {} });
    commitment = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment, voucher: v, actor: {} });

    const c = await Commitment.findById(commitment._id).lean();
    const a = c.allocations.find((x) => String(x.spendLineId) === lineIds[0]);
    expect(a.releases).toHaveLength(1);
    expect(a.releasedAmount).toBe(3000);
    expect(await liveOn(s, s.raw)).toBe(3000);
  });
});

/* ═══ CANCELLATION ═════════════════════════════════════════════════════════ */

describe("cancelling a bill", () => {
  test("restores only its own amount, not another voucher's", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const first = bill({ inventoryEntries: [entry(lineIds[0], 2000)] });
    const second = bill({ inventoryEntries: [entry(lineIds[0], 3000)] });

    let c = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment: c, voucher: first, actor: {} });
    c = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment: c, voucher: second, actor: {} });
    expect(await liveOn(s, s.raw)).toBe(1000);

    c = await Commitment.findOne({ spendRequestId: id });
    await release.restoreVoucher({ commitment: c, voucher: first });

    /* The second bill is still posted and its discharge stands. */
    expect(await liveOn(s, s.raw)).toBe(3000);
    const after = await Commitment.findById(c._id).lean();
    const a = after.allocations.find((x) => String(x.spendLineId) === lineIds[0]);
    expect(a.releasedAmount).toBe(3000);
    expect(a.releases).toHaveLength(1);
    expect(String(a.releases[0].voucherId)).toBe(String(second._id));
  });

  test("re-posting after cancellation is idempotent", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    /* PARTIAL on purpose. A bill that exhausts the line is protected by the
       over-billing cap even without the duplicate guard — so a full bill
       cannot tell the two mechanisms apart, and this test would pass against
       code that released twice. */
    const v = bill({ inventoryEntries: [entry(lineIds[0], 2000)] });

    let c = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment: c, voucher: v, actor: {} });
    c = await Commitment.findOne({ spendRequestId: id });
    await release.restoreVoucher({ commitment: c, voucher: v });
    expect(await liveOn(s, s.raw)).toBe(6000);

    c = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment: c, voucher: v, actor: {} });
    c = await Commitment.findOne({ spendRequestId: id });
    await release.applyRelease({ commitment: c, voucher: v, actor: {} });

    const after = await Commitment.findById(c._id).lean();
    const a = after.allocations.find((x) => String(x.spendLineId) === lineIds[0]);
    expect(a.releases).toHaveLength(1);
    expect(a.releasedAmount).toBe(2000);
    expect(await liveOn(s, s.raw)).toBe(4000);
  });
});

/* ═══ WHAT IT REFUSES TO GUESS ═════════════════════════════════════════════ */

describe("an unmapped bill", () => {
  test("leaves a line-wise commitment active, with a warning", async () => {
    const s = await seed();
    const { id } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    const out = await release.applyRelease({
      commitment,
      /* A bill with no request-line identity on any line. */
      voucher: bill({ inventoryEntries: [entry(null, 6000)] }),
      actor: {},
    });

    expect(out.released).toBe(false);
    const c = await Commitment.findById(commitment._id).lean();
    /* NEVER whole-document. Freeing the money because the mapping was missing
       is the behaviour being removed. */
    expect(c.status).toBe("committed");
    expect(c.reconciliationWarning).toMatch(/carries a request line/i);
    expect(await liveOn(s, s.raw)).toBe(6000);
  });

  test("there is exactly one release orchestrator, and it never falls back", () => {
    /* ── STRUCTURAL, BECAUSE THE WIRING IS THE THING ──────────────────────
       B3B briefly had two: the model's post-save hook calling the legacy
       whole-document release, and the create route calling the line-wise one.
       For a line-wise commitment the hook could get there first and free every
       head — the exact bug the chunk existed to fix, reintroduced by the fix.

       An engine-level test cannot see this: the engine is correct either way,
       and the defect is which code runs. */
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "../..");

    /* The route calls nothing. */
    const route = fs.readFileSync(path.join(root, "routes/Accountant_Routes/Acc_vouchers.js"), "utf8");
    expect(route).not.toMatch(/releaseForVoucher/);
    expect(route).not.toMatch(/restoreForVoucher/);
    expect(route).not.toMatch(/applyRelease/);

    /* The model hook calls the orchestrator and nothing else. */
    const model = fs.readFileSync(path.join(root, "models/Accountant_model/Acc_VoucherModels.js"), "utf8");
    const at = model.indexOf("afterVoucherSaved");
    expect(at).toBeGreaterThan(-1);
    const hook = model.slice(at, model.indexOf("\n});", at));
    expect(hook).toMatch(/release\.orchestrate\(/);
    expect(hook).not.toMatch(/releaseForVoucher/);
    expect(hook).not.toMatch(/restoreForVoucher/);
    /* And it loads the lines, without which partial release is impossible. */
    expect(hook).toMatch(/inventoryEntries/);

    /* The orchestrator hands a line-wise commitment to the line-wise engine
       and calls the whole-document release only when there are NO
       allocations — never as a fallback when nothing mapped. */
    const svc = fs.readFileSync(path.join(root, "services/commitmentRelease.service.js"), "utf8");
    const o = svc.indexOf("async function orchestrate");
    const body = svc.slice(o, svc.indexOf("\nmodule.exports", o));
    expect(body).toMatch(/if \(!hasAllocations\) \{[\s\S]{0,300}?releaseForVoucher/);
    expect((body.match(/releaseForVoucher/g) || []).length).toBe(1);
    expect(body).toMatch(/return applyRelease\(/);
  });

  test("a legacy commitment still releases whole-document", async () => {
    const s = await seed();
    const line = s.lineOf(s.raw);
    const legacy = await Commitment.create({
      spendRequestId: new mongoose.Types.ObjectId(), spendRequestNumber: "OLD-1",
      companyId: s.company._id, budgetId: s.budget._id, budgetLineId: line._id,
      ledgerId: s.raw._id, ledgerName: s.raw.name, amount: 7500, status: "committed",
    });
    expect(await liveOn(s, s.raw)).toBe(7500);

    /* The line-wise engine refuses it; the old path handles it, unchanged. */
    const refused = await release.applyRelease({
      commitment: legacy, voucher: bill(), actor: {},
    });
    expect(refused.why).toBe("legacy_whole_document");

    await budgetMatch.releaseForVoucher({
      commitment: await Commitment.findById(legacy._id),
      voucher: bill(), actor: {},
    });
    expect(await liveOn(s, s.raw)).toBe(0);
  });
});

/* ═══ THE IDENTITY CHAIN ═══════════════════════════════════════════════════ */

describe("line identity survives the chain", () => {
  test("a purchase order carries each request line's id", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    await SpendRequest.updateOne({ _id: id }, {
      $set: { "items.0.vendorName": "Mill Co", "items.1.vendorName": "Mill Co",
        "items.2.vendorName": "Mill Co", "items.3.vendorName": "Mill Co" },
    });

    const po = await call(s.store, `/${id}/purchase-order`, { method: "POST", body: {} });
    expect(po.status).toBe(201);

    const order = await PurchaseOrder.findOne({ spendRequestId: id }).lean();
    /* Exactly the request's own line ids, in order — the chain the release
       engine walks. Without this, goods could only ever release whole. */
    expect(order.items.map((i) => String(i.spendLineId))).toEqual(lineIds);
  });

  test("nothing is matched by name, amount or position", async () => {
    const s = await seed();
    const { id } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    /* The right names and the right amounts, in the right order — and no ids. */
    const out = await release.applyRelease({
      commitment,
      voucher: bill({ inventoryEntries: [
        { _id: new mongoose.Types.ObjectId(), stockItemName: "Cotton fabric", quantity: 1, amount: 6000, taxAmount: 0 },
        { _id: new mongoose.Types.ObjectId(), stockItemName: "Cartons", quantity: 1, amount: 4000, taxAmount: 0 },
      ] }),
      actor: {},
    });

    expect(out.released).toBe(false);
    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(await liveOn(s, s.packaging)).toBe(4000);
  });

  test("committedByLine counts remaining, never the original", async () => {
    const s = await seed();
    const { id, lineIds } = await approvedFourHeads(s);
    const commitment = await Commitment.findOne({ spendRequestId: id });

    await release.applyRelease({
      commitment, voucher: bill({ inventoryEntries: [entry(lineIds[0], 2000)] }), actor: {},
    });

    /* ₹6,000 promised, ₹2,000 billed → ₹4,000 still blocking the head.
       Summing `amount` would keep blocking the full ₹6,000 forever. */
    expect(await liveOn(s, s.raw)).toBe(4000);
    const c = await Commitment.findById(commitment._id).lean();
    /* And the compatibility fields are not counted a second time: this is a
       four-line request, so the document carries no top-level budgetLineId. */
    expect(c.budgetLineId).toBeUndefined();
  });
});
