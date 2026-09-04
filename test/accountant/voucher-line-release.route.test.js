// test/accountant/voucher-line-release.route.test.js
//
// THE REAL VOUCHER API, NOT A HAND-BUILT ROW.
//
// ── WHY THIS SUITE EXISTS SEPARATELY ────────────────────────────────────────
// The engine tests build commitment and voucher objects directly. They prove
// the arithmetic and prove nothing about the thing a person actually does:
// open the purchase-voucher form, prefill from a PO, save, post. Every defect
// this correction fixes lived in that gap —
//
//   · the model's post-save hook released the WHOLE commitment before the
//     partial path ran, because it never loaded `inventoryEntries`;
//   · two competing release calls raced on one transition;
//   · line identity was matched by raw item, so two PO lines naming the same
//     fabric discharged whichever allocation came first;
//   · the reconciliation existed only on the create response and vanished on
//     the next page load.
//
// Everything here goes through the routes.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

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
jest.mock("../../Middlewear/AccountantOrgAuthMiddleware", () => ({
  orgAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
  requireRole: () => (req, res, next) => next(),
  requirePermission: () => (req, res, next) => next(),
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const { planEveryItem, PLANNED_KEY } = require("../requests/plannedItems.helper");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
const budgetMatch = require("../../services/budgetCommitment.service");

let server, accBase, spendBase, seq = 0;

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", role: "owner", email: "owner@books.example",
  permissions: { canEdit: true, canApprove: true },
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/vouchers", require("../../routes/Accountant_Routes/Acc_vouchers"));
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  accBase = `http://127.0.0.1:${server.address().port}/api/accountant/vouchers`;
  spendBase = `http://127.0.0.1:${server.address().port}/api/requests/spend`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const acc = (path, { method = "GET", body } = {}) =>
  fetch(`${accBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(OWNER) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const empToken = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
    name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const spend = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${spendBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${empToken(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `VR Co ${n}`, booksFromDate: new Date("2026-04-01"),
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
  const supplier = await Acc_Ledger.create({
    companyId: company._id, name: `Mill Co ${n}`,
    groupId: group._id, groupName: "Sundry Creditors", nature: "liability",
  });

  const budget = await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [raw, packaging].map((l) => ({
      ledgerId: l._id, ledgerName: l.name, nature: "expense",
      department: "Logistics", allocatedAmount: 50000,
    })),
    budgetRequests: [],
  }));

  const tl = await Employee.create({ firstName: "Sakib", lastName: `Tl${n}`, email: `vrtl${n}@d.example`, isActive: true, gender: "Other", biometricId: `VRTL${n}`, department: "Logistics" });
  const emp = await Employee.create({ firstName: "Rutu", lastName: `Emp${n}`, email: `vremp${n}@d.example`, isActive: true, gender: "Other", biometricId: `VREM${n}`, department: "Logistics", primaryManager: { managerId: tl._id } });
  const finEmp = await Employee.create({ firstName: "Soumya", lastName: `Fin${n}`, email: `vrfin${n}@d.example`, isActive: true, gender: "Other", biometricId: `VRFN${n}`, department: "Accounts" });
  await Acc_User.create({ organizationId: new mongoose.Types.ObjectId(), email: `vrfin${n}@d.example`, name: "Finance", role: "approver", isActive: true, passwordHash: "x" });

  const storeDept = (await AccessDepartment.findOne({ slug: "store" }))
    || (await AccessDepartment.create({ key: `store-${n}`, slug: "store", name: "Store & Purchase", dashboardPath: "/store", isActive: true }));
  const store = await Employee.create({ firstName: "Bikash", lastName: `S${n}`, email: `vrstore${n}@d.example`, isActive: true, gender: "Other", biometricId: `VRST${n}`, department: "Store", accessDepartmentId: storeDept._id });

  const lineOf = (l) => budget.items.find((i) => String(i.ledgerId) === String(l._id));
  return { company, budget, raw, packaging, supplier, emp, tl, finEmp, store, lineOf };
}

/**
 * A two-line request whose BOTH lines name the SAME raw item, charged to two
 * different heads — the case a raw-item match cannot tell apart.
 */
async function twoLinesOneItem(s) {
  const item = await RawItem.create({ name: `Cotton ${++seq}`, sku: `SKU${seq}`, unit: "roll" });

  const { body } = await spend(s.emp, "/", {
    method: "POST",
    body: {
      title: "Two rolls", requestType: "PRODUCT", purpose: "Q3",
      ledgerId: String(s.raw._id), plannedItemKey: PLANNED_KEY,
      items: [
        { name: "Cotton roll A", whyNeeded: "x", quantity: 1, unit: "roll", rate: 6000 },
        { name: "Cotton roll B", whyNeeded: "x", quantity: 1, unit: "roll", rate: 4000 },
      ],
    },
  });
  const id = body.request._id;
  await spend(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });

  /* The same raw item on both lines, and a supplier so the PO can be raised. */
  await SpendRequest.updateOne({ _id: id }, {
    $set: {
      "items.0.rawItem": item._id, "items.1.rawItem": item._id,
      "items.0.vendorName": "Mill Co", "items.1.vendorName": "Mill Co",
    },
  });

  const doc = await SpendRequest.findById(id).lean();
  const lineIds = doc.items.map((l) => String(l._id));
  await spend(s.finEmp, `/${id}/approve`, {
    method: "PATCH",
    body: { lineAllocations: { lines: [
      { spendLineId: lineIds[0], budgetLineId: String(s.lineOf(s.raw)._id) },
      { spendLineId: lineIds[1], budgetLineId: String(s.lineOf(s.packaging)._id) },
    ] } },
  });

  const po = await spend(s.store, `/${id}/purchase-order`, { method: "POST", body: {} });
  expect(po.status).toBe(201);
  const order = await PurchaseOrder.findOne({ spendRequestId: id }).lean();

  return { id, lineIds, item, order };
}

/**
 * The body the real purchase-voucher form submits.
 *
 * Balanced double entry, because the route validates it: the purchase head is
 * debited and the supplier credited. Building this properly is the point of
 * the suite — a hand-made row would skip the very validation the form's
 * output has to survive.
 */
const voucherBody = (s, over = {}) => {
  const total = over.grandTotal ?? 0;
  return {
    companyId: String(s.company._id),
    voucherType: "purchase",
    voucherNumber: `PUR-${++seq}`,
    voucherDate: new Date("2026-08-01"),
    partyLedgerId: String(s.supplier._id),
    autoPost: true,
    ledgerEntries: [
      { ledgerId: String(s.raw._id), ledgerName: s.raw.name, type: "Dr", amount: total },
      { ledgerId: String(s.supplier._id), ledgerName: s.supplier.name, type: "Cr", amount: total },
    ],
    inventoryEntries: [],
    ...over,
    grandTotal: total,
  };
};

const invEntry = (over = {}) => ({
  stockItemName: "Cotton", quantity: 1, unit: "roll",
  rate: 0, discount: 0, amount: 0, taxRate: 0, taxAmount: 0, ...over,
});

const liveOn = async (s, ledger) =>
  (await budgetMatch.committedByLine([s.lineOf(ledger)._id]))
    .get(String(s.lineOf(ledger)._id)) || 0;

/* ═══ EXACT LINE IDENTITY THROUGH THE REAL FORM ════════════════════════════ */

describe("two order lines, one raw item", () => {
  test("poItemId releases the correct allocation for each", async () => {
    const s = await seed();
    const { order, lineIds } = await twoLinesOneItem(s);
    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(await liveOn(s, s.packaging)).toBe(4000);

    /* Bill ONLY the second order line — the one on Packaging. Its raw item is
       identical to the first's, so nothing but `poItemId` distinguishes it. */
    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 4000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[1]._id),
          rate: 4000, amount: 4000,
        })],
      }),
    });
    expect(created.status).toBe(201);

    /* Packaging discharged; Raw Materials untouched. A raw-item match would
       have hit whichever line came first. */
    expect(await liveOn(s, s.packaging)).toBe(0);
    expect(await liveOn(s, s.raw)).toBe(6000);

    const c = await Commitment.findOne({ spendRequestId: (await PurchaseOrder.findById(order._id).lean()).spendRequestId }).lean();
    const byLine = new Map(c.allocations.map((a) => [String(a.spendLineId), a]));
    expect(byLine.get(lineIds[1]).status).toBe("released");
    expect(byLine.get(lineIds[0]).status).toBe("committed");
  });

  test("a raw-item-only bill releases nothing when the match is ambiguous", async () => {
    const s = await seed();
    const { order, item } = await twoLinesOneItem(s);

    /* A legacy-shaped bill: the raw item and nothing else. Two order lines
       carry it, so which allocation it discharges is unknowable. */
    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 4000,
        inventoryEntries: [invEntry({ rawItem: String(item._id), rate: 4000, amount: 4000 })],
      }),
    });
    expect(created.status).toBe(201);

    /* Releasing the wrong one would be worse than releasing none, and would
       look entirely correct. */
    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(await liveOn(s, s.packaging)).toBe(4000);
  });

  test("a raw-item-only bill DOES map when exactly one order line matches", async () => {
    const s = await seed();
    const other = await RawItem.create({ name: `Carton ${++seq}`, sku: `SKU${seq}`, unit: "box" });
    const { order, lineIds } = await twoLinesOneItem(s);
    /* Give the second order line a distinct item — now unambiguous. */
    await PurchaseOrder.updateOne({ _id: order._id }, { $set: { "items.1.rawItem": other._id } });

    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 4000,
        inventoryEntries: [invEntry({ rawItem: String(other._id), rate: 4000, amount: 4000 })],
      }),
    });
    expect(created.status).toBe(201);

    expect(await liveOn(s, s.packaging)).toBe(0);
    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(lineIds).toHaveLength(2);
  });

  test("a client-supplied spendLineId is ignored", async () => {
    const s = await seed();
    const { order, lineIds } = await twoLinesOneItem(s);

    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 4000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[1]._id),
          /* Pointing at the OTHER, larger allocation. */
          spendLineId: lineIds[0],
          rate: 4000, amount: 4000,
        })],
      }),
    });
    expect(created.status).toBe(201);

    /* The order line decided, not the client. */
    expect(await liveOn(s, s.packaging)).toBe(0);
    expect(await liveOn(s, s.raw)).toBe(6000);

    const v = await Acc_Voucher.findById(created.body._id).lean();
    expect(String(v.inventoryEntries[0].spendLineId)).toBe(lineIds[1]);
  });
});

/* ═══ ONE ORCHESTRATOR ═════════════════════════════════════════════════════ */

describe("the posting lifecycle", () => {
  test("the model hook cannot whole-release a line-wise commitment", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);

    /* A bill mapping to ONE line only. Before the correction the hook fired
       first, took the legacy path, and freed BOTH heads. */
    await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 6000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[0]._id), rate: 6000, amount: 6000,
        })],
      }),
    });

    expect(await liveOn(s, s.raw)).toBe(0);
    /* The head nobody billed. */
    expect(await liveOn(s, s.packaging)).toBe(4000);
  });

  test("only one release happens, even though the hook runs on every save", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);

    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 6000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[0]._id), rate: 6000, amount: 6000,
        })],
      }),
    });
    expect(created.status).toBe(201);

    const c = await Commitment.findOne({ budgetLineId: null, spendRequestNumber: { $exists: true } })
      .where("allocations.releases.voucherId").equals(created.body._id).lean();
    const a = c.allocations.find((x) => (x.releases || []).length);
    /* The create path saves the voucher at least twice — once to write it and
       once to post it — and the hook runs on both. */
    expect(a.releases).toHaveLength(1);
    expect(a.releasedAmount).toBe(6000);
  });

  test("posting an existing draft reaches the same orchestrator", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);

    const draft = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        autoPost: false,
        purchaseOrderId: String(order._id),
        grandTotal: 6000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[0]._id), rate: 6000, amount: 6000,
        })],
      }),
    });
    expect(draft.status).toBe(201);
    /* A draft promises nothing. */
    expect(await liveOn(s, s.raw)).toBe(6000);

    /* Post it the way the screen does — through the model, which is the
       chokepoint every posting path shares. */
    const v = await Acc_Voucher.findById(draft.body._id);
    v.status = "posted";
    await v.save();
    await new Promise((r) => setTimeout(r, 50));

    expect(await liveOn(s, s.raw)).toBe(0);
    expect(await liveOn(s, s.packaging)).toBe(4000);
  });

  test("cancelling restores exactly this voucher's contributions", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);

    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 6000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[0]._id), rate: 6000, amount: 6000,
        })],
      }),
    });
    expect(await liveOn(s, s.raw)).toBe(0);

    const v = await Acc_Voucher.findById(created.body._id);
    v.status = "cancelled";
    await v.save();
    await new Promise((r) => setTimeout(r, 50));

    expect(await liveOn(s, s.raw)).toBe(6000);
    expect(await liveOn(s, s.packaging)).toBe(4000);
  });
});

/* ═══ THE RECONCILIATION SURVIVES A REFRESH ════════════════════════════════ */

describe("reopening the voucher", () => {
  test("a fresh GET returns the reconciliation, not just the create response", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);

    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 6000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[0]._id), rate: 6000, amount: 6000,
        })],
      }),
    });
    expect(created.status).toBe(201);

    /* ── THE DEFECT ────────────────────────────────────────────────────────
       The reconciliation used to exist only on the creation response. This is
       what somebody sees when they come back to the voucher tomorrow. */
    const reopened = await acc(`/${created.body._id}`);
    expect(reopened.status).toBe(200);

    const rec = reopened.body.commitmentRelease;
    expect(rec).toBeTruthy();
    expect(rec.spendRequestNumber).toBeTruthy();
    expect(rec.reserved).toBe(10000);
    expect(rec.releasedByThisVoucher).toBe(6000);
    expect(rec.releasedToDate).toBe(6000);
    expect(rec.remaining).toBe(4000);
    expect(rec.status).toBe("partially_released");
    expect(rec.lines).toHaveLength(1);
    expect(rec.lines[0].released).toBe(6000);
  });

  test("it is the same on every subsequent visit", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);
    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 6000,
        inventoryEntries: [invEntry({
          poItemId: String(order.items[0]._id), rate: 6000, amount: 6000,
        })],
      }),
    });

    const first = await acc(`/${created.body._id}`);
    const second = await acc(`/${created.body._id}`);
    /* Present on BOTH — comparing two absences passes and proves nothing. */
    expect(first.body.commitmentRelease).toBeTruthy();
    expect(second.body.commitmentRelease).toBeTruthy();
    expect(second.body.commitmentRelease).toEqual(first.body.commitmentRelease);
  });

  test("an unmapped bill line is listed with its reason", async () => {
    const s = await seed();
    const { order } = await twoLinesOneItem(s);

    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        purchaseOrderId: String(order._id),
        grandTotal: 6500,
        inventoryEntries: [
          invEntry({ poItemId: String(order.items[0]._id), rate: 6000, amount: 6000 }),
          /* A freight charge belonging to no request line. */
          invEntry({ stockItemName: "Freight", rate: 500, amount: 500, isCharge: true }),
        ],
      }),
    });

    const rec = (await acc(`/${created.body._id}`)).body.commitmentRelease;
    expect(rec.unmapped.length).toBeGreaterThan(0);
    expect(rec.unmapped[0].reason).toMatch(/not matched to a request line/i);
  });

  test("an ordinary voucher carries no reconciliation at all", async () => {
    const s = await seed();
    const created = await acc("/", {
      method: "POST",
      body: voucherBody(s, {
        grandTotal: 1000,
        inventoryEntries: [invEntry({ rate: 1000, amount: 1000 })],
      }),
    });
    expect(created.status).toBe(201);

    const reopened = await acc(`/${created.body._id}`);
    expect(reopened.body.commitmentRelease).toBeUndefined();
  });
});
