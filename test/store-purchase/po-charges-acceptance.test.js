// test/store-purchase/po-charges-acceptance.test.js
//
// THE COMMERCIAL-ADJUSTMENT FEATURE, THROUGH THE ROUTES PEOPLE ACTUALLY USE.
//
// ── WHY THIS SUITE EXISTS ───────────────────────────────────────────────────
// Purchase orders have always carried shipping, a discount and labelled
// charges. A2 stopped the purchase order being where they are DECIDED, because
// each one moves what the company owes against a budget approved for a smaller
// figure. That is only a correction if the deciding moved somewhere real — if
// it moved nowhere, the feature was removed.
//
// So nothing here writes `approvedShippingCharges` and friends with a database
// update. Every figure in this suite is entered by Store through
// `PATCH /:id/adjustments`, confirmed by the requester, approved by Finance,
// and read back off the purchase order. A suite that seeded those fields
// directly would prove the schema can hold them, not that anybody can use them.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");

const adjustments = require("../../services/spendAdjustments.service");

let spendSrv, spendBase, poSrv, poBase, seq = 0;

beforeAll(async () => {
  const spendApp = express();
  spendApp.use(express.json());
  spendApp.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { spendSrv = spendApp.listen(0, r); });
  spendBase = `http://127.0.0.1:${spendSrv.address().port}/api/requests/spend`;

  const poApp = express();
  poApp.use(express.json());
  poApp.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { poSrv = poApp.listen(0, r); });
  poBase = `http://127.0.0.1:${poSrv.address().port}/api/cms/purchase-orders`;
});
afterAll(async () => {
  await new Promise((r) => spendSrv.close(r));
  await new Promise((r) => poSrv.close(r));
});

const tokenFor = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
    name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

const spend = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${spendBase}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const po = (emp, path, { method = "GET", body, key } = {}) =>
  fetch(`${poBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(emp)}`,
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");
const newKey = () => `acc-${++seq}-${Date.now()}`;

/**
 * A company with a live budget, a Store person who may fulfil and raise orders,
 * and a Finance approver — the three real identities this journey needs.
 */
async function world() {
  const n = ++seq;
  const company = await Acc_Company.create({
    companyName: `Charges Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Direct Expenses", nature: "expense",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: `Materials ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  const budget = await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: ledger._id, ledgerName: ledger.name, nature: "expense",
              department: "Cutting", allocatedAmount: 500000 }],
    budgetRequests: [],
  });
  /* The head Finance will charge each line to. */
  const budgetLineId = budget.items[0]._id;

  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" }))
    || (await AccessDepartment.create({
      key: `store-${n}`, slug: "store", name: "Store & Purchase",
      dashboardPath: "/store/dashboard", isActive: true,
    }));

  const requesterEmp = await Employee.create({
    firstName: "Meena", lastName: `Req${n}`, email: `req${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `RQ${n}`, department: "Cutting",
  });
  const store = await Employee.create({
    firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `ST${n}`,
    department: "Store", accessDepartmentId: storeDept._id,
  });
  const finance = await Employee.create({
    firstName: "Soumya", lastName: `Fin${n}`, email: `fin${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  /* Store also needs Store & Purchase membership to raise the order itself. */
  await DepartmentRole.create({
    departmentSlug: "store", email: store.email, role: "approver", name: "Store", isActive: true,
  });
  await SpCompanyMembership.create({
    companyId: company._id, email: store.email, employeeRef: store._id, personName: "Store",
  });

  return { company, ledger, budget, budgetLineId, requesterEmp, store, finance };
}

/**
 * A material request with a purchase shortfall, and the PRODUCT spend request
 * Store raised from it — written straight in, because THIS suite is about
 * charges, not about the MRF chain that `governed-po-*` already covers.
 *
 * Nothing here touches an adjustment field: every one of those is entered
 * through the route below.
 */
async function quoteAwaitingCharges(w, { rate = 120, qty = 100 } = {}) {
  const ri = await RawItem.create({ name: `Cotton ${++seq}`, sku: `SKU-${seq}`, unit: "m" });
  const mrf = await MRF.create({
    companyId: w.company._id, mrfNumber: `MRF/${++seq}`,
    requestedFor: w.requesterEmp._id, requestedForName: "Meena", requestedForDept: "Cutting",
    createdByRef: w.requesterEmp._id, createdByModel: "Employee",
    requestType: "USES_BASED", status: "APPROVED", fulfilmentDecision: "buy_or_service",
    items: [{
      rawItem: ri._id, rawItemName: ri.name, rawItemSku: ri.sku,
      requestedQty: qty, unit: "m", issuedQty: 0, buyQty: qty, itemStatus: "PENDING",
    }],
  });
  const line = mrf.items[0];
  const net = qty * rate;
  const tax = Math.round(net * 0.05 * 100) / 100;

  const r = await SpendRequest.collection.insertOne({
    companyId: w.company._id, requestNumber: `SR/${++seq}`,
    title: `${mrf.mrfNumber} — balance to buy`, purpose: "Cutting shortfall",
    requestType: "PRODUCT",
    /* With Store, priced, and not yet sent to Finance — the moment charges are
       agreed with the supplier. */
    status: "requester_confirmed",
    department: "Cutting",
    requestedBy: w.requesterEmp._id, requestedByName: "Meena",
    sourceMrfId: mrf._id, sourceMrfNumber: mrf.mrfNumber,
    budgetAccountHeadId: w.ledger._id, budgetDepartment: "Cutting",
    budgetFinancialYear: "2026-27", budgetMatchStatus: "matched",
    items: [{
      _id: new mongoose.Types.ObjectId(), name: line.rawItemName, whyNeeded: "Shortfall",
      sourceMrfLineId: line._id, rawItem: line.rawItem, rawItemSku: line.rawItemSku,
      variantId: null, quantity: qty, unit: "m", rate,
      amount: net, gstPercent: 5, taxAmount: tax, lineTotal: net + tax,
      vendorName: "Northwind Textiles",
    }],
    totalAmount: net, taxAmount: tax, grandTotal: net + tax,
    createdAt: new Date(),
  });
  await MRF.updateOne({ _id: mrf._id }, {
    $set: { spendRequestId: r.insertedId, spendRequestNumber: `SR/${seq}` },
  });
  return { mrf, id: r.insertedId, net, tax };
}

/* ══ 1–3. STORE ENTERS THE ADJUSTMENTS, THROUGH THE ROUTE ═══════════════ */

describe("Store enters commercial adjustments while quoting", () => {
  it("Store can enter shipping", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    const res = await spend(w.store, `/${id}/adjustments`, {
      method: "PATCH", body: { shippingCharges: 500 },
    });
    expect(res.status).toBe(200);
    expect(res.body.payable.shippingCharges).toBe(500);
    expect(res.body.payable.grandTotal).toBe(13100);   // 12,000 + 600 + 500
  });

  it("Store can enter a discount", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    const res = await spend(w.store, `/${id}/adjustments`, {
      method: "PATCH", body: { discount: 600 },
    });
    expect(res.status).toBe(200);
    expect(res.body.payable.discount).toBe(600);
    expect(res.body.payable.grandTotal).toBe(12000);
  });

  it("Store can enter labelled charges, and each label survives", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    const res = await spend(w.store, `/${id}/adjustments`, {
      method: "PATCH",
      body: { customCharges: [{ label: "Handling", amount: 250 }, { label: "Insurance", amount: 150 }] },
    });
    expect(res.status).toBe(200);
    /* Individually, not as one combined figure — Finance approves what each
       charge is FOR as well as what it costs. */
    expect(res.body.payable.customCharges).toEqual([
      { label: "Handling", amount: 250 },
      { label: "Insurance", amount: 150 },
    ]);
    expect(res.body.payable.grandTotal).toBe(13000);
  });

  it("a malformed adjustment is refused, and nothing is stored", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    for (const [body, field] of [
      [{ shippingCharges: -1 }, "shippingCharges"],
      [{ discount: -1 }, "discount"],
      [{ discount: 99999 }, "discount"],
      [{ customCharges: [{ amount: 50 }] }, "customCharges"],
      [{ customCharges: [{ label: "Handling" }] }, "customCharges"],
      [{ shippingCharges: "abc" }, "shippingCharges"],
    ]) {
      const res = await spend(w.store, `/${id}/adjustments`, { method: "PATCH", body });
      expect(res.status).toBe(400);
      expect(res.body.field).toBe(field);
    }
    const after = await SpendRequest.findById(id).lean();
    /* Absent or zero both mean "nothing was stored" — the fixture inserts
       through the driver, so a default was never applied. What matters is
       that no refused value was kept, and that the total did not move. */
    expect(after.quotedShippingCharges || 0).toBe(0);
    expect(after.quotedDiscount || 0).toBe(0);
    expect(after.quotedCustomCharges || []).toEqual([]);
    expect(after.grandTotal).toBe(12600);
  });

  it("only Store may set them", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    const res = await spend(w.requesterEmp, `/${id}/adjustments`, {
      method: "PATCH", body: { shippingCharges: 500 },
    });
    expect(res.status).toBe(403);
  });
});

/* ══ 4–5. THE REQUESTER AND FINANCE SEE THE SAME PAYABLE FIGURE ═════════ */

describe("the requester and Finance see the total they are agreeing to", () => {
  it("the requester's own view carries the full payable figure and its parts", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    await spend(w.store, `/${id}/adjustments`, {
      method: "PATCH",
      body: { shippingCharges: 500, customCharges: [{ label: "Handling", amount: 250 }], discount: 100 },
    });

    const seen = await spend(w.requesterEmp, `/${id}`);
    expect(seen.status).toBe(200);
    /* 12,000 + 600 tax + 500 freight + 250 handling − 100 discount */
    expect(seen.body.request.grandTotal).toBe(13250);
    expect(seen.body.request.quotedShippingCharges).toBe(500);
    expect(seen.body.request.quotedDiscount).toBe(100);
    expect(seen.body.request.quotedCustomCharges).toEqual([{ label: "Handling", amount: 250 }]);
  });

  it("the history names each charge, not just a combined total", async () => {
    const w = await world();
    const { id } = await quoteAwaitingCharges(w);
    await spend(w.store, `/${id}/adjustments`, {
      method: "PATCH",
      body: { shippingCharges: 500, customCharges: [{ label: "Handling", amount: 250 }] },
    });
    const doc = await SpendRequest.findById(id).lean();
    const entry = doc.history[doc.history.length - 1];
    expect(entry.note).toMatch(/freight 500/);
    expect(entry.note).toMatch(/Handling 250/);
  });
});

/* ══ 6–10. THROUGH APPROVAL, ONTO THE ORDER, AND OUT ════════════════════ */

describe("the approved figures reach the purchase order and back out again", () => {
  /** Store quotes charges, Finance approves, and the commitment is written. */
  async function approvedWithCharges(w, body) {
    const q = await quoteAwaitingCharges(w);
    const set = await spend(w.store, `/${q.id}/adjustments`, { method: "PATCH", body });
    expect(set.status).toBe(200);

    const sent = await spend(w.store, `/${q.id}/send-to-finance`, { method: "PATCH", body: {} });
    expect(sent.status).toBe(200);

    /* Finance names the budget head for each line, exactly as the approval
       screen does — the allocation is theirs to make, not the request's. */
    const doc = await SpendRequest.findById(q.id).lean();
    const approved = await spend(w.finance, `/${q.id}/approve`, {
      method: "PATCH",
      body: {
        lineAllocations: {
          lines: doc.items.map((l) => ({
            spendLineId: String(l._id), budgetLineId: String(w.budgetLineId),
          })),
        },
      },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.request.status).toBe("approved");
    return { ...q, payable: set.body.payable };
  }

  it("Finance's commitment is written for the complete payable total", async () => {
    const w = await world();
    const { id, payable } = await approvedWithCharges(w, {
      shippingCharges: 500, customCharges: [{ label: "Handling", amount: 250 }], discount: 100,
    });
    expect(payable.grandTotal).toBe(13250);

    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c).toBeTruthy();
    /* The money promised is what the requester confirmed and Finance saw —
       not the line subtotal plus tax. */
    expect(c.amount).toBe(13250);
  });

  it("approval snapshots the quoted charges, and the order carries them exactly", async () => {
    const w = await world();
    const { mrf, id } = await approvedWithCharges(w, {
      shippingCharges: 500, customCharges: [{ label: "Handling", amount: 250 }], discount: 100,
    });

    const after = await SpendRequest.findById(id).lean();
    expect(after.approvedShippingCharges).toBe(500);
    expect(after.approvedDiscount).toBe(100);
    expect(after.approvedCustomCharges).toEqual([{ label: "Handling", amount: 250 }]);
    expect(after.adjustmentsApprovedAt).toBeTruthy();

    const created = await po(w.store, "", {
      method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) },
    });
    expect(created.status).toBe(201);

    const order = await PurchaseOrder.findById(created.body.purchaseOrder._id).lean();
    expect(order.shippingCharges).toBe(500);
    expect(order.discount).toBe(100);
    expect(order.customCharges.map((c) => ({ label: c.label, amount: c.amount })))
      .toEqual([{ label: "Handling", amount: 250 }]);
    expect(order.totalAmount).toBe(13250);
    /* And it says where those figures were approved. */
    expect(String(order.spendRequestId)).toBe(String(id));
    expect(order.spendRequestNumber).toBe(after.requestNumber);
  });

  it("the order cannot change a label or an amount", async () => {
    const w = await world();
    const { mrf } = await approvedWithCharges(w, {
      shippingCharges: 500, customCharges: [{ label: "Handling", amount: 250 }],
    });

    for (const body of [
      { shippingCharges: 900 },
      { customCharges: [{ label: "Freight", amount: 250 }] },
      { customCharges: [{ label: "Handling", amount: 900 }] },
      { discount: 50 },
    ]) {
      const res = await po(w.store, "", {
        method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id), ...body },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
    }
  });

  it("reordered and differently cased charges are the same agreement", async () => {
    const w = await world();
    const { mrf } = await approvedWithCharges(w, {
      customCharges: [{ label: "Handling", amount: 250 }, { label: "Insurance", amount: 150 }],
    });
    const res = await po(w.store, "", {
      method: "POST", key: newKey(),
      body: {
        sourceMrfId: String(mrf._id),
        customCharges: [{ label: " insurance", amount: 150 }, { label: "HANDLING", amount: 250 }],
      },
    });
    expect(res.status).toBe(201);
  });

  it("an adjusted order survives the issue-time reload from the database", async () => {
    /* The projection bug this covers: `assertIssuable` reloads the request and
       rebuilds the allocation from `grandTotal`. Omit that field from the
       projection and the allocator falls back to the sum of the LINES, loses
       the header adjustment, and refuses a perfectly good order. */
    const w = await world();
    const { mrf } = await approvedWithCharges(w, { shippingCharges: 500 });
    const created = await po(w.store, "", {
      method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) },
    });
    expect(created.status).toBe(201);

    const issued = await po(w.store, `/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(200);
    expect((await PurchaseOrder.findById(created.body.purchaseOrder._id).lean()).status).toBe("ISSUED");
  });

  it("a negative adjustment survives the reload too", async () => {
    const w = await world();
    const { mrf } = await approvedWithCharges(w, { discount: 600 });
    const created = await po(w.store, "", {
      method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) },
    });
    expect(created.status).toBe(201);
    expect((await PurchaseOrder.findById(created.body.purchaseOrder._id).lean()).totalAmount).toBe(12000);

    const issued = await po(w.store, `/${created.body.purchaseOrder._id}/status`, {
      method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(200);
  });
});

/* ══ 9 + 11. CHANGING A CHARGE, AND A STALE TOTAL ══════════════════════ */

describe("an approved figure cannot be edited in place", () => {
  it("setting a charge on an approved request is refused, and points at requoting", async () => {
    const w = await world();
    const q = await quoteAwaitingCharges(w);
    await spend(w.store, `/${q.id}/adjustments`, { method: "PATCH", body: { shippingCharges: 500 } });
    await spend(w.store, `/${q.id}/send-to-finance`, { method: "PATCH", body: {} });
    const doc0 = await SpendRequest.findById(q.id).lean();
    await spend(w.finance, `/${q.id}/approve`, {
      method: "PATCH",
      body: { lineAllocations: { lines: doc0.items.map((l) => ({
        spendLineId: String(l._id), budgetLineId: String(w.budgetLineId),
      })) } },
    });

    const res = await spend(w.store, `/${q.id}/adjustments`, {
      method: "PATCH", body: { shippingCharges: 900 },
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("ADJUSTMENTS_SETTLED");
    expect(res.body.message).toMatch(/requote/i);

    /* And the approved snapshot is untouched. */
    const after = await SpendRequest.findById(q.id).lean();
    expect(after.approvedShippingCharges).toBe(500);
    expect(after.grandTotal).toBe(13100);
  });

  it("a stale grand total fails closed rather than being trusted", async () => {
    const w = await world();
    const q = await quoteAwaitingCharges(w);
    await spend(w.store, `/${q.id}/adjustments`, { method: "PATCH", body: { shippingCharges: 500 } });
    await spend(w.store, `/${q.id}/send-to-finance`, { method: "PATCH", body: {} });
    const doc0 = await SpendRequest.findById(q.id).lean();
    await spend(w.finance, `/${q.id}/approve`, {
      method: "PATCH",
      body: { lineAllocations: { lines: doc0.items.map((l) => ({
        spendLineId: String(l._id), budgetLineId: String(w.budgetLineId),
      })) } },
    });

    /* The sort of drift a forgotten recompute leaves behind. */
    await SpendRequest.collection.updateOne({ _id: q.id }, { $set: { grandTotal: 99999 } });

    const res = await po(w.store, "", {
      method: "POST", key: newKey(), body: { sourceMrfId: String(q.mrf._id) },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("GRAND_TOTAL_STALE");
    expect(res.body.error.details.reconstructed).toBe(13100);
    expect(await PurchaseOrder.countDocuments({ companyId: w.company._id })).toBe(0);
  });
});

/* ══ 12. THE FEATURE IS THE ROUTE, NOT THE SCHEMA ══════════════════════ */

describe("the upstream writing path is what makes this a feature", () => {
  it("a production route writes the quoted adjustments", () => {
    /* If this route were removed, the fields would be writable only by a test
       or a database update — which is the defect this suite exists to prevent.
       Asserted on the source so its DISAPPEARANCE fails, not merely its
       misbehaviour. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Requests/spendRequests.js"), "utf8");
    expect(src).toMatch(/router\.patch\("\/:id\/adjustments"/);
    expect(src).toMatch(/quotedShippingCharges = payable\.shippingCharges/);
    /* And the requote path carries them too, so a re-quote does not drop the
       freight agreed last week. */
    expect(src).toMatch(/sentAdjustment/);
  });

  it("Finance's approval is what turns a quote into an approved figure", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/spendFinanceDecision.service.js"), "utf8");
    expect(src).toMatch(/request\.approvedShippingCharges = Number\(request\.quotedShippingCharges\)/);
    expect(src).toMatch(/request\.adjustmentsApprovedAt = now/);
  });

  it("the MRF fulfilment quote accepts them at the very first pricing", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Inventory/Operations/mrfRoutes.js"), "utf8");
    expect(src).toMatch(/spendAdjustments\.readAdjustments/);
    expect(src).toMatch(/spend\.grandTotal = payable\.grandTotal/);
  });

  it("one authority computes the total everywhere", () => {
    /* subtotal + tax + shipping + charges − discount, in one place. */
    const s = adjustments.summarise({
      subtotal: 12000, taxAmount: 600, shipping: 500,
      customCharges: [{ label: "Handling", amount: 250 }], discount: 100,
    });
    expect(s.grandTotal).toBe(13250);
  });
});
