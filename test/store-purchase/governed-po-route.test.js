// test/store-purchase/governed-po-route.test.js
//
// A2 AT THE HTTP BOUNDARY — the New purchase order form's own endpoint.
//
// The service suite proves the chain rules. This proves the door: that the form
// cannot get round them, that a refusal leaves nothing behind, that provenance
// is written by the server, and that legacy and service flows are untouched.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Acc_BudgetCommitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

const governed = require("../../services/storePurchase/governedPurchaseOrder.service");
const lineAllocation = require("../../services/lineAllocation.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `A2${seq}`, name: "A2", email: "a@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { token, method = "GET", body, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const t = await r.text(); let b = null;
    try { b = JSON.parse(t || "null"); } catch { b = t; }
    return { status: r.status, body: b };
  });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(co) {
  const n = ++seq; const email = `a2${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "A2", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "A2" });
  return tokenFor({ id: String(employeeRef), email });
}

async function rawItem() {
  return RawItem.create({ name: `Cotton ${++seq}`, sku: `SKU-${seq}`, unit: "m" });
}

async function mrfWithShortfall(co, over = {}) {
  const ri = await rawItem();
  return MRF.create({
    companyId: co._id, mrfNumber: over.mrfNumber || `MRF/${++seq}`,
    requestedFor: new mongoose.Types.ObjectId(), requestedForName: "Meena",
    requestedForDept: over.department || "Cutting",
    createdByRef: new mongoose.Types.ObjectId(), createdByModel: "Employee",
    requestType: "USES_BASED", status: "APPROVED",
    fulfilmentDecision: "buy_or_service",
    items: [{
      rawItem: ri._id, rawItemName: ri.name, rawItemSku: ri.sku,
      requestedQty: 100, unit: "m", issuedQty: 0,
      buyQty: over.buyQty ?? 100, itemStatus: "PENDING",
    }],
  });
}

async function approvedRequestFor(co, mrf, over = {}) {
  const line = mrf.items[0];
  const r = await SpendRequest.collection.insertOne({
    companyId: co._id, requestNumber: over.requestNumber || `SR/${++seq}`,
    title: "Cotton shortfall", purpose: "Cutting shortfall",
    requestType: over.requestType || "PRODUCT", status: over.status || "approved",
    department: mrf.requestedForDept,
    requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Meena",
    sourceMrfId: mrf._id, sourceMrfNumber: mrf.mrfNumber,
    budgetApprovalKind: over.budgetApprovalKind || "within_budget",
    items: over.items || [{
      _id: new mongoose.Types.ObjectId(), name: line.rawItemName,
      whyNeeded: "Shortfall",
      /* As the MRF flow writes it. */
      sourceMrfLineId: line._id,
      rawItem: line.rawItem, rawItemSku: line.rawItemSku, variantId: line.variantId || null,
      quantity: line.buyQty, unit: line.unit, rate: 120,
      amount: line.buyQty * 120, gstPercent: 5,
      taxAmount: line.buyQty * 120 * 0.05,
      vendorName: "Northwind Textiles",
    }],
    ...(over.approvedShippingCharges !== undefined ? { approvedShippingCharges: over.approvedShippingCharges } : {}),
    ...(over.approvedDiscount !== undefined ? { approvedDiscount: over.approvedDiscount } : {}),
    ...(over.approvedCustomCharges !== undefined ? { approvedCustomCharges: over.approvedCustomCharges } : {}),
    /* The payable figure. A stored total that does not follow from its own
       parts fails closed downstream — which is the point — so it is stated
       consistently here. */
    grandTotal: over.grandTotal ?? (
      line.buyQty * 120 * 1.05
      + (over.approvedShippingCharges || 0)
      + (over.approvedCustomCharges || []).reduce((t, c) => t + c.amount, 0)
      - (over.approvedDiscount || 0)
    ),
    createdAt: new Date(),
  });
  await MRF.updateOne({ _id: mrf._id }, {
    $set: { spendRequestId: r.insertedId, spendRequestNumber: over.requestNumber || `SR/${seq}` },
  });

  /* Finance's promise, and the marker saying one was required. A missing
     commitment is no longer read as "budget review was paused". */
  if (over.budgetMode === "BUDGET_PAUSED") {
    await SpendRequest.collection.updateOne({ _id: r.insertedId }, {
      $set: {
        budgetApprovalMode: "BUDGET_PAUSED",
        budgetApprovalModeAt: new Date(),
        budgetApprovalModeSource: "test fixture",
      },
    });
  } else if (over.commitment !== false) {
    const c = await Acc_BudgetCommitment.create({
      spendRequestId: r.insertedId,
      companyId: over.commitmentCompanyId || co._id,
      /* The GRAND total, as the approval workflow reserves it — 100 × 120
         plus 5% GST. Committing the subtotal would leave the tax
         unpromised, which is the case the amount check exists for. */
      amount: over.commitmentAmount ?? 12600,
      status: over.commitmentStatus || "committed",
    });
    await SpendRequest.collection.updateOne({ _id: r.insertedId }, {
      $set: {
        commitmentId: c._id,
        commitmentStatus: c.status,
        budgetApprovalMode: "COMMITMENT_REQUIRED",
        budgetApprovalModeAt: new Date(),
        budgetApprovalModeSource: "test fixture",
      },
    });
  } else {
    /* Commitment mode declared, promise deliberately absent. */
    await SpendRequest.collection.updateOne({ _id: r.insertedId }, {
      $set: {
        budgetApprovalMode: "COMMITMENT_REQUIRED",
        budgetApprovalModeAt: new Date(),
        budgetApprovalModeSource: "test fixture",
      },
    });
  }

  return SpendRequest.findById(r.insertedId).lean();
}

const PO = "/api/cms/purchase-orders";
const newKey = () => `a2-${++seq}-${Date.now()}`;

/* ══ 1–5. THE FORM CANNOT ORDER WITHOUT A PROVEN NEED ════════════════════ */

describe("the New purchase order endpoint requires a source MRF", () => {
  it("refuses a body with no MRF, and creates nothing", async () => {
    const co = await company();
    const token = await actor(co);
    const before = await PurchaseOrder.countDocuments({ companyId: co._id });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { vendorName: "Anyone", items: [{ quantity: 5, unitPrice: 10 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MRF_REQUIRED");

    /* No number allocated, no partial order, nothing to clean up. */
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(before);
  });

  it("refuses a fabricated MRF id", async () => {
    const co = await company();
    const token = await actor(co);
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(new mongoose.Types.ObjectId()), items: [{ quantity: 1 }] },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MRF_UNAVAILABLE");
  });

  it("another company's MRF leaks nothing through the endpoint", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const foreign = await mrfWithShortfall(theirs, { mrfNumber: "MRF/THEIRS" });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(foreign._id), items: [{ quantity: 1 }] },
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("MRF_UNAVAILABLE");
    expect(JSON.stringify(res.body)).not.toContain("MRF/THEIRS");
  });

  it("refuses an MRF with no purchase shortfall", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co, { buyQty: 0 });
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), items: [{ quantity: 1 }] },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MRF_NO_PURCHASE_SHORTFALL");
  });

  it("refuses a shortfall with no approved purchase request, and says where to go", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), items: [{ quantity: 1 }] },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MRF_NO_PURCHASE_REQUEST");
    expect(res.body.error.details.correction).toContain("/order-requests/");
  });

  it("refuses an unapproved request without allocating a PO number", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { status: "pending_finance" });
    const before = await PurchaseOrder.countDocuments({ companyId: co._id });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), items: [{ quantity: 1 }] },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("REQUEST_NOT_APPROVED");
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(before);
  });
});

/* ══ 9–12, 17, 21–22. THE GOVERNED ORDER ════════════════════════════════ */

describe("a complete chain creates a governed draft", () => {
  async function created(co, token, extra = {}) {
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), notes: "Deliver to gate 2", ...extra },
    });
    return { mrf, sr, res };
  }

  it("creates the order and carries the whole chain on it", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr, res } = await created(co, token);

    expect(res.status).toBe(201);
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();

    /* PO → material request, PO → purchase request, both by id AND number. */
    expect(String(po.sourceMrfId)).toBe(String(mrf._id));
    expect(po.sourceMrfNumber).toBe(mrf.mrfNumber);
    expect(po.sourceMrfDepartment).toBe("Cutting");
    expect(String(po.spendRequestId)).toBe(String(sr._id));
    expect(po.spendRequestNumber).toBe(sr.requestNumber);
    /* The rules it was raised under. */
    expect(po.provenancePolicy).toBe(governed.PROVENANCE_POLICY);
    /* A new order is always a draft; approving money is not sending an order. */
    expect(po.status).toBe("DRAFT");
  });

  it("every line carries its approved purchase-request line", async () => {
    const co = await company();
    const token = await actor(co);
    const { sr, res } = await created(co, token);
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();
    expect(String(po.items[0].spendLineId)).toBe(String(sr.items[0]._id));
  });

  it("operational fields the caller sent are kept", async () => {
    const co = await company();
    const token = await actor(co);
    const { res } = await created(co, token);
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();
    /* Delivery instructions and notes do not alter the approved decision. */
    expect(po.notes).toBe("Deliver to gate 2");
  });

  it("a company in the body is refused outright, not quietly substituted", async () => {
    /* Stronger than ignoring it: a client that sends a company believes the
       field works, and silently swapping it would teach it that it does. */
    const co = await company();
    const other = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), companyId: String(other._id) },
    });
    expect(res.status).toBe(400);
    expect(await PurchaseOrder.countDocuments({ companyId: other._id })).toBe(0);
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("client-supplied commercial facts are ignored in favour of the approval", async () => {
    const co = await company();
    const token = await actor(co);
    const { res } = await created(co, token, {
      vendorName: "Somebody Else",
      vendor: String(new mongoose.Types.ObjectId()),
      items: [{ rawItem: String(new mongoose.Types.ObjectId()), quantity: 99999, unitPrice: 1, gstRate: 0 }],
      subtotal: 1, taxAmount: 0, totalAmount: 1,
    });
    expect(res.status).toBe(201);
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();

    expect(String(po.companyId)).toBe(String(co._id));
    expect(po.vendorName).toBe("Northwind Textiles");
    expect(po.items).toHaveLength(1);
    expect(po.items[0].quantity).toBe(100);
    expect(po.items[0].unitPrice).toBe(120);
    expect(po.totalAmount).toBeGreaterThan(1);
  });

  it("the emergency flag is recorded but bypasses nothing", async () => {
    const co = await company();
    const token = await actor(co);
    /* No MRF at all, and the most urgent flag there is. */
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { isEmergencyOrder: true, vendorName: "Urgent Co", items: [{ quantity: 1, unitPrice: 5 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MRF_REQUIRED");
  });

  it("creation posts no stock, no receipt and no Accounting entry", async () => {
    const co = await company();
    const token = await actor(co);
    const { res } = await created(co, token);
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();
    /* Nothing has arrived and nothing has been paid. */
    expect(po.totalReceived).toBe(0);
    expect(po.items.every((i) => i.receivedQuantity === 0)).toBe(true);
    expect(po.paymentStatus).toBe("PENDING");
    expect(po.payments || []).toHaveLength(0);
  });

  it("the approved budget commitment is reused, never duplicated", async () => {
    const co = await company();
    const token = await actor(co);
    const { sr, res } = await created(co, token);
    expect(res.status).toBe(201);
    /* The request still owns exactly the commitment it had; creating an order
       neither makes a second promise nor releases the first. */
    const after = await SpendRequest.findById(sr._id).lean();
    expect(String(after.commitmentId || "")).toBe(String(sr.commitmentId || ""));
  });
});

/* ══ 13–14. QUANTITY IS SPENDABLE ONCE ══════════════════════════════════ */

describe("approved quantity cannot be exceeded or spent twice", () => {
  it("refuses any client attempt to choose quantities at all", async () => {
    /* One approved request converts to one order, so ordering less does not
       leave the rest for later — it strands it behind a request that can never
       be ordered again. */
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), requestedLines: [{ quantity: 500 }] },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("QUANTITY_EXCEEDS_APPROVED");
    expect(res.body.error.message).toMatch(/whole approved purchase request/i);
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("a reduced quantity cannot strand the approved remainder", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    /* Ask for less... */
    const less = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), requestedLines: [{ quantity: 10 }] },
    });
    expect(less.status).toBe(409);

    /* ...and the full order is still available, with nothing lost. */
    const full = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(full.status).toBe(201);
    const po = await PurchaseOrder.findById(full.body.purchaseOrder._id).lean();
    expect(po.items[0].quantity).toBe(100);
  });

  it("dropping or adding lines is refused, not silently honoured", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: {
        sourceMrfId: String(mrf._id),
        items: [
          { rawItem: String(new mongoose.Types.ObjectId()), quantity: 1 },
          { rawItem: String(new mongoose.Types.ObjectId()), quantity: 1 },
        ],
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("LINE_NOT_APPROVED");
  });

  it("a second order against a fully ordered request is refused", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    const first = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(first.status).toBe(201);

    const second = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("QUANTITY_ALREADY_ORDERED");
    /* Exactly one order exists for that approval. */
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(1);
  });
});

/* ══ 18–19. IDEMPOTENCY AND CONCURRENCY ═════════════════════════════════ */

describe("one user action makes one order", () => {
  it("retrying with the same key returns the same order", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const key = newKey();
    const body = { sourceMrfId: String(mrf._id) };

    const a = await call(PO, { token, method: "POST", key, body });
    const b = await call(PO, { token, method: "POST", key, body });

    expect(a.status).toBe(201);
    expect(String(b.body.purchaseOrder._id)).toBe(String(a.body.purchaseOrder._id));
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(1);
  });

  it("two concurrent creates cannot order the same approved quantity twice", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const body = { sourceMrfId: String(mrf._id) };

    /* Different keys, so idempotency cannot be what saves this — the database
       invariant has to. */
    const [a, b] = await Promise.all([
      call(PO, { token, method: "POST", key: newKey(), body }),
      call(PO, { token, method: "POST", key: newKey(), body }),
    ]);

    const created = [a, b].filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(1);
  });
});

/* ══ 16. ISSUE-TIME ENFORCEMENT ═════════════════════════════════════════ */

describe("issuing re-proves the chain", () => {
  async function draft(co, token) {
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);
    return { mrf, sr, id: res.body.purchaseOrder._id };
  }

  it("a draft whose approval was withdrawn cannot be issued, and nothing changes", async () => {
    const co = await company();
    const token = await actor(co);
    const { sr, id } = await draft(co, token);

    /* The upstream record moves after the draft was saved. */
    await SpendRequest.updateOne({ _id: sr._id }, { $set: { status: "cancelled" } });

    const res = await call(`${PO}/${id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");

    const after = await PurchaseOrder.findById(id).lean();
    expect(after.status).toBe("DRAFT");
    expect(after.approvedBy).toBeFalsy();
  });

  it("a draft whose material request vanished cannot be issued", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, id } = await draft(co, token);
    await MRF.deleteOne({ _id: mrf._id });

    const res = await call(`${PO}/${id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");
    expect((await PurchaseOrder.findById(id).lean()).status).toBe("DRAFT");
  });

  it("a draft edited beyond its approved quantity cannot be issued", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await draft(co, token);
    /* Straight into the collection — the sort of change an edit path or a
       script could make after the draft was validated. */
    await PurchaseOrder.updateOne({ _id: id }, { $set: { "items.0.quantity": 500 } });

    const res = await call(`${PO}/${id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");
  });

  it("an intact chain issues normally", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await draft(co, token);
    const res = await call(`${PO}/${id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(200);
    expect((await PurchaseOrder.findById(id).lean()).status).toBe("ISSUED");
  });
});

/* ══ 23–24. LEGACY ORDERS ═══════════════════════════════════════════════ */

describe("historical orders keep working; new ones cannot pretend to be old", () => {
  const legacyPo = (co, over = {}) => PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/OLD/${++seq}`, status: "DRAFT",
    createdBy: new mongoose.Types.ObjectId(), vendorName: "Old Supplier",
    subtotal: 100, taxAmount: 0, totalAmount: 100,
    items: [{
      _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(),
      itemName: "Old cloth", sku: "OLD", unit: "m", quantity: 10, unitPrice: 10,
      totalPrice: 100, receivedQuantity: 0, pendingQuantity: 10, status: "PENDING",
    }],
    ...over,
  });

  /* ── HISTORICAL IS SOMETHING A RECORD CARRIES ──────────────────────────
     The first version inferred it from `createdAt`, which fails OPEN: an order
     with a missing or unreadable date was treated as historical and inherited
     every allowance. Now only the controlled migration's marker confers it. */
  const migrate = (id) => PurchaseOrder.collection.updateOne({ _id: id },
    { $set: { provenancePolicy: governed.LEGACY_POLICY, provenanceMigratedAt: new Date() } });

  it("a migrated historical order is legacy and still issues", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);
    await migrate(po._id);

    const reloaded = await PurchaseOrder.findById(po._id).lean();
    expect(governed.isLegacyOrder(reloaded)).toBe(true);

    const res = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(200);
  });

  it("an unmigrated order is NOT legacy, however old its date", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);
    /* Backdated well before the rule, and still unstamped. A date is not
       provenance: only the migration says an order predates the rule. */
    await PurchaseOrder.collection.updateOne({ _id: po._id },
      { $set: { createdAt: new Date("2020-01-01") } });

    const reloaded = await PurchaseOrder.findById(po._id).lean();
    expect(governed.isLegacyOrder(reloaded)).toBe(false);

    const res = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");
    expect(res.body.error.details.reason).toBe("PROVENANCE_UNPROVEN");
    expect((await PurchaseOrder.findById(po._id).lean()).status).toBe("DRAFT");
  });

  it("an order with NO creation date cannot gain a legacy exemption", async () => {
    /* The fail-open case the date rule could not answer: a bulk insert, a
       restored backup, a bad migration. "We could not read its date" was
       treated as "it predates the rule". */
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);
    await PurchaseOrder.collection.updateOne({ _id: po._id }, { $unset: { createdAt: "" } });

    const reloaded = await PurchaseOrder.findById(po._id).lean();
    expect(reloaded.createdAt).toBeFalsy();
    expect(governed.isLegacyOrder(reloaded)).toBe(false);

    const res = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("PROVENANCE_UNPROVEN");
  });

  it("an unparseable creation date is unproven too, not historical", async () => {
    const co = await company();
    const po = await legacyPo(co);
    await PurchaseOrder.collection.updateOne({ _id: po._id }, { $set: { createdAt: "not-a-date" } });
    const reloaded = await PurchaseOrder.collection.findOne({ _id: po._id });
    expect(governed.isLegacyOrder(reloaded)).toBe(false);
  });

  it("a newly inserted unlinked order cannot masquerade as historical", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);   // dated now, unstamped

    const res = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(res.status).toBe(409);
    expect((await PurchaseOrder.findById(po._id).lean()).status).toBe("DRAFT");
  });

  it("a migrated order stays readable in the register and on its detail page", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);
    await migrate(po._id);

    const list = await call(PO, { token });
    expect(list.status).toBe(200);
    expect(list.body.purchaseOrders.map((p) => p.poNumber)).toContain(po.poNumber);

    const detail = await call(`${PO}/${po._id}`, { token });
    expect(detail.status).toBe(200);
  });

  it("an unmigrated order is still readable — it is refused only from acting", async () => {
    /* Fail closed on ACTION, not on access: hiding it would lose the evidence
       somebody needs to decide what it is. */
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);

    const list = await call(PO, { token });
    expect(list.body.purchaseOrders.map((p) => p.poNumber)).toContain(po.poNumber);
    expect((await call(`${PO}/${po._id}`, { token })).status).toBe(200);
  });

  it("a migrated order can still be cancelled", async () => {
    const co = await company();
    const token = await actor(co);
    const po = await legacyPo(co);
    await migrate(po._id);
    const res = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "CANCELLED", reason: "No longer needed" },
    });
    expect(res.status).toBe(200);
  });
});

/* ══ 25. SERVICES ARE UNTOUCHED ═════════════════════════════════════════ */

describe("service requests keep their own flow", () => {
  it("a SERVICE request cannot become a material purchase order", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { requestType: "SERVICE" });

    const res = await call(PO, {
      token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) },
    });
    /* Not "no MRF" — the need exists; there is simply no MATERIAL request. */
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MRF_NO_PURCHASE_REQUEST");
  });

  it("the MRF rule is not applied to service orders at all", async () => {
    /* The governed authority is only reachable through the material
       purchase-order door. Nothing in it is wired into the service-order
       route, which keeps its own approved-service-request flow. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Inventory/Operations/serviceOrders.js"), "utf8");
    expect(src).not.toContain("governedPurchaseOrder");
    expect(src).not.toContain("sourceMrfId");
  });
});

/* The classification no longer depends on `createdAt` at all — but the field
   is `immutable` anyway, so nothing can quietly re-date an order either. */
describe("dates confer nothing", () => {
  it("an ordinary update cannot even change an order's creation date", async () => {
    const co = await company();
    const po = await PurchaseOrder.create({
      companyId: co._id, poNumber: `PO/IMM/${++seq}`, status: "DRAFT",
      createdBy: new mongoose.Types.ObjectId(), vendorName: "X",
      subtotal: 0, taxAmount: 0, totalAmount: 0,
      items: [{
        _id: new mongoose.Types.ObjectId(), rawItem: new mongoose.Types.ObjectId(),
        itemName: "X", sku: "X", unit: "m", quantity: 1, unitPrice: 1, totalPrice: 1,
        receivedQuantity: 0, pendingQuantity: 1, status: "PENDING",
      }],
    });
    await PurchaseOrder.updateOne({ _id: po._id }, { $set: { createdAt: new Date("2020-01-01") } });
    const after = await PurchaseOrder.findById(po._id).lean();
    expect(new Date(after.createdAt).getFullYear()).not.toBe(2020);
    expect(governed.isLegacyOrder(after)).toBe(false);
  });
});

/* ══ 27–30. THE SELECTOR THE FORM USES ══════════════════════════════════ */

describe("the source material request selector", () => {
  it("is registered before /:id, or it is read as an order id", async () => {
    const co = await company();
    const token = await actor(co);
    const res = await call(`${PO}/source-mrfs`, { token });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it("shows only this company's material requests", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const ours = await mrfWithShortfall(mine);
    const notOurs = await mrfWithShortfall(theirs, { mrfNumber: "MRF/THEIRS" });

    const res = await call(`${PO}/source-mrfs`, { token });
    const numbers = res.body.rows.map((r) => r.mrfNumber);
    expect(numbers).toContain(ours.mrfNumber);
    expect(numbers).not.toContain(notOurs.mrfNumber);
    expect(JSON.stringify(res.body)).not.toContain(String(theirs._id));
  });

  it("each row identifies the request, its origin and its shortfall", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co, { department: "Cutting" });

    const res = await call(`${PO}/source-mrfs`, { token });
    const row = res.body.rows.find((r) => r.mrfNumber === mrf.mrfNumber);
    expect(row.department).toBe("Cutting");
    expect(row.hasPurchaseShortfall).toBe(true);
    expect(row.shortfallLines[0].buyQty).toBe(100);
    expect(row.shortfallLines[0].requestedQty).toBe(100);
  });

  it("says why an ineligible request cannot be used, and where to go", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);   // no purchase request yet

    const res = await call(`${PO}/source-mrfs`, { token });
    const row = res.body.rows.find((r) => r.mrfNumber === mrf.mrfNumber);
    expect(row.eligible).toBe(false);
    expect(row.ineligibleReason).toMatch(/no approved purchase request/i);
    expect(row.correction).toContain("/order-requests/");
  });

  it("an approved chain is eligible and shows its purchase request", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);

    const res = await call(`${PO}/source-mrfs`, { token });
    const row = res.body.rows.find((r) => r.mrfNumber === mrf.mrfNumber);
    expect(row.eligible).toBe(true);
    expect(row.purchaseRequestNumber).toBe(sr.requestNumber);
    expect(row.purchaseRequestStatus).toBe("approved");
    expect(row.budgetApprovalKind).toBe("within_budget");
  });

  it("eligible requests are offered first", async () => {
    const co = await company();
    const token = await actor(co);
    await mrfWithShortfall(co);                       // ineligible
    const good = await mrfWithShortfall(co);
    await approvedRequestFor(co, good);               // eligible

    const res = await call(`${PO}/source-mrfs`, { token });
    expect(res.body.rows[0].eligible).toBe(true);
  });

  it("is searchable, and the search stays inside the company", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const ours = await mrfWithShortfall(mine, { mrfNumber: "MRF/FINDME-1" });
    const notOurs = await mrfWithShortfall(theirs, { mrfNumber: "MRF/FINDME-2" });

    const res = await call(`${PO}/source-mrfs?search=FINDME`, { token });
    const numbers = res.body.rows.map((r) => r.mrfNumber);
    expect(numbers).toContain(ours.mrfNumber);
    expect(numbers).not.toContain(notOurs.mrfNumber);
  });

  it("is bounded, and says so when it truncates", async () => {
    const co = await company();
    const token = await actor(co);
    await mrfWithShortfall(co);
    await mrfWithShortfall(co);

    const res = await call(`${PO}/source-mrfs?limit=1`, { token });
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.coverage.truncated).toBe(true);
    expect(res.body.coverage.note).toMatch(/older ones exist/i);
  });

  it("never returns every historical request without a bound", async () => {
    const co = await company();
    const token = await actor(co);
    const res = await call(`${PO}/source-mrfs`, { token });
    expect(res.body.coverage.scanCap).toBeGreaterThan(0);
    expect(res.body.rows.length).toBeLessThanOrEqual(res.body.coverage.scanCap);
  });
});

describe("the provenance summary the form shows after selection", () => {
  it("names the three documents separately", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);

    const res = await call(`${PO}/source-mrfs/${mrf._id}/provenance`, { token });
    expect(res.status).toBe(200);

    /* The material request is the need and the shortfall. */
    expect(res.body.materialRequest.number).toBe(mrf.mrfNumber);
    expect(res.body.materialRequest.department).toBe("Cutting");
    expect(res.body.materialRequest.lines[0].satisfiedFromStock).toBe(0);
    expect(res.body.materialRequest.lines[0].requiringPurchase).toBe(100);

    /* The purchase request is sourcing and budget — a different document, and
       never called an MRF. */
    expect(res.body.purchaseRequest.number).toBe(sr.requestNumber);
    expect(res.body.purchaseRequest.financeApproved).toBe(true);
    expect(res.body.purchaseRequest.budgetApprovalKind).toBe("within_budget");
    expect(res.body.purchaseRequest.supplierName).toBe("Northwind Textiles");
  });

  it("shows how much is already ordered and how much remains", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    const res = await call(`${PO}/source-mrfs/${mrf._id}/provenance`, { token });
    expect(res.body.orderable[0].approvedQuantity).toBe(100);
    expect(res.body.orderable[0].alreadyOrdered).toBe(0);
    expect(res.body.orderable[0].remainingQuantity).toBe(100);
  });

  it("refuses an unusable chain with the same reason creation would give", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);   // no purchase request

    const res = await call(`${PO}/source-mrfs/${mrf._id}/provenance`, { token });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("MRF_NO_PURCHASE_REQUEST");
  });

  it("another company's material request is unavailable here too", async () => {
    const mine = await company();
    const theirs = await company();
    const token = await actor(mine);
    const foreign = await mrfWithShortfall(theirs, { mrfNumber: "MRF/HIDDEN" });

    const res = await call(`${PO}/source-mrfs/${foreign._id}/provenance`, { token });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain("MRF/HIDDEN");
  });
});

/* ══ BUDGET AUTHORITY IS PROVED, NEVER INFERRED ═════════════════════════ */

describe("budget authority", () => {
  it("a missing commitment is refused when commitment mode applies", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { commitment: false });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BUDGET_AUTHORITY_UNAVAILABLE");
    expect(res.body.error.details.reason).toBe("COMMITMENT_MISSING");
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("a missing commitment is allowed ONLY on explicit persisted paused evidence", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { budgetMode: "BUDGET_PAUSED" });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();
    expect(po.provenancePolicy).toBe(governed.PROVENANCE_POLICY);
  });

  it("an unproven mode falls back to the stricter reading, not the permissive one", async () => {
    /* A request raised before the marker existed cannot say which rules it was
       approved under. It must still show a commitment — absence is not proof
       that review was paused. */
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf, { commitment: false });
    await SpendRequest.collection.updateOne({ _id: sr._id }, { $unset: { budgetApprovalMode: "" } });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("BUDGET_AUTHORITY_UNAVAILABLE");
  });

  it("a commitment belonging to another company is refused", async () => {
    const co = await company();
    const other = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { commitmentCompanyId: other._id });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COMMITMENT_FOREIGN_COMPANY");
  });

  it("a released commitment no longer holds the money", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { commitmentStatus: "released" });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COMMITMENT_NOT_LIVE");
  });

  it("a deleted commitment is refused rather than read as a paused policy", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await Acc_BudgetCommitment.deleteOne({ spendRequestId: sr._id });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COMMITMENT_NOT_FOUND");
  });

  it.each(["within_budget", "over_budget", "unbudgeted"])(
    "a Finance-approved %s request with a live commitment still orders", async (kind) => {
      const co = await company();
      const token = await actor(co);
      const mrf = await mrfWithShortfall(co);
      await approvedRequestFor(co, mrf, {
        budgetApprovalKind: kind,
        commitmentStatus: kind === "unbudgeted" ? "unbudgeted" : "committed",
      });
      const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
      expect(res.status).toBe(201);
    });
});

/* ══ THE COMMERCIAL VALUE CANNOT BE RAISED FROM THE FORM ════════════════ */

describe("charges, discounts and totals belong to the approval", () => {
  it("a client-supplied shipping charge is refused, not quietly added", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), shippingCharges: 40000 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("a custom charge and a discount are refused the same way", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    const charge = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), customCharges: [{ label: "Freight", amount: 9000 }] },
    });
    expect(charge.body.error.code).toBe("CHARGES_EXCEED_APPROVED");

    const disc = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), discount: 5000 },
    });
    expect(disc.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
  });

  it("a governed order's total is the approved total, with no charges on it", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();

    /* 100 × 120 = 12,000 net, 5% = 600. */
    expect(po.subtotal).toBe(12000);
    expect(po.taxAmount).toBe(600);
    expect(po.totalAmount).toBe(12600);
    expect(po.shippingCharges).toBe(0);
    expect(po.discount).toBe(0);
    expect(po.customCharges).toEqual([]);
  });
});

/* ══ DRIFT AFTER DRAFTING BLOCKS ISSUE ══════════════════════════════════ */

describe("issue-time revalidation catches drift", () => {
  async function draftFor(co, token) {
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);
    return { mrf, sr, id: res.body.purchaseOrder._id };
  }
  const issue = (id, token) => call(`${PO}/${id}/status`, {
    token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
  });

  it("a supplier swapped on the draft blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await draftFor(co, token);
    await PurchaseOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) },
      { $set: { vendorName: "Someone Else Entirely" } });

    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");
    expect((await PurchaseOrder.findById(id).lean()).status).toBe("DRAFT");
  });

  it("a raised tax rate blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await draftFor(co, token);
    await PurchaseOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) },
      { $set: { "items.0.gstRate": 28 } });
    expect((await issue(id, token)).status).toBe(409);
  });

  it("a charge added after drafting blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await draftFor(co, token);
    await PurchaseOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) },
      { $set: { shippingCharges: 25000, totalAmount: 37600 } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");
  });

  it("a released commitment after drafting blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { sr, id } = await draftFor(co, token);
    await Acc_BudgetCommitment.updateOne({ spendRequestId: sr._id }, { $set: { status: "released" } });

    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PROVENANCE_CHANGED");
    expect(res.body.error.message).toMatch(/budget authority/i);
  });

  it("an MRF whose shortfall was withdrawn blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, id } = await draftFor(co, token);
    /* The store filled it from stock after all. */
    await MRF.collection.updateOne({ _id: mrf._id }, { $set: { "items.0.buyQty": 0 } });
    expect((await issue(id, token)).status).toBe(409);
  });

  it("an inflated header total blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await draftFor(co, token);
    await PurchaseOrder.collection.updateOne({ _id: new mongoose.Types.ObjectId(String(id)) },
      { $set: { totalAmount: 999999 } });
    expect((await issue(id, token)).status).toBe(409);
  });

  it("a refused issue leaves no side effect of any kind", async () => {
    const co = await company();
    const token = await actor(co);
    const { sr, id } = await draftFor(co, token);
    const before = await PurchaseOrder.findById(id).lean();
    await SpendRequest.collection.updateOne({ _id: sr._id }, { $set: { status: "cancelled" } });

    const res = await issue(id, token);
    expect(res.status).toBe(409);

    const after = await PurchaseOrder.findById(id).lean();
    expect(after.status).toBe("DRAFT");
    expect(after.approvedBy).toBeFalsy();
    expect(after.poNumber).toBe(before.poNumber);           // no number consumed
    expect(after.totalReceived).toBe(0);                    // no stock
    expect(after.paymentStatus).toBe("PENDING");            // no ledger
    /* And the commitment is untouched. */
    const c = await Acc_BudgetCommitment.findOne({ spendRequestId: sr._id }).lean();
    expect(c.status).toBe("committed");
  });
});

/* ══ EVERY GOVERNED ORDER CARRIES ITS WHOLE CHAIN ═══════════════════════ */

describe("no governed order is created without full provenance", () => {
  it("sourceMrfId, sourceMrfNumber and spendRequestId are all non-null", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);

    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();
    expect(po.sourceMrfId).toBeTruthy();
    expect(po.sourceMrfNumber).toBeTruthy();
    expect(po.spendRequestId).toBeTruthy();
    expect(String(po.sourceMrfId)).toBe(String(mrf._id));
    expect(String(po.spendRequestId)).toBe(String(sr._id));
    expect(po.items.every((l) => l.spendLineId)).toBe(true);
  });

  it("no order anywhere in this company has a null source material request", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);
    await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });

    /* The dead-end draft the old intake path produced would show up here. */
    const orphans = await PurchaseOrder.countDocuments({
      companyId: co._id,
      provenancePolicy: governed.PROVENANCE_POLICY,
      $or: [{ sourceMrfId: null }, { sourceMrfId: { $exists: false } }],
    });
    expect(orphans).toBe(0);
  });
});

/* ══ THE CONTEXTUAL JOURNEY END TO END ══════════════════════════════════ */

describe("Create purchase order from an approved MRF-origin request", () => {
  /* The contextual action lives on the spend router, so it is stood up beside
     the purchase-order router here — the point is that BOTH doors produce the
     same governed order, and that the order this one makes can actually be
     issued. The old intake path produced a draft that never could. */
  let spendServer, spendBase;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use("/api/requests/spend", require("../../routes/CMS_Routes/Requests/spendRequests"));
    await new Promise((r) => { spendServer = app.listen(0, r); });
    spendBase = `http://127.0.0.1:${spendServer.address().port}`;
  });
  afterAll(async () => { await new Promise((r) => spendServer.close(r)); });

  async function storeEmployee(co) {
    const n = ++seq;
    const email = `ctx${n}@x.example`;
    const empId = new mongoose.Types.ObjectId();
    const biometricId = `CTX${n}`;
    await require("../../models/Employee").collection.insertOne({
      _id: empId, firstName: "Ctx", lastName: "User", email, biometricId, isActive: true,
    });
    await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "Ctx", isActive: true });
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: empId, personName: "Ctx" });
    return { token: tokenFor({ id: String(empId), employeeId: biometricId, email }), empId, email };
  }

  const convert = (spendId, token) =>
    fetch(`${spendBase}/api/requests/spend/${spendId}/purchase-order`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: "{}",
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

  it("creates a governed order, and that exact order can be issued", async () => {
    const co = await company();
    const { token } = await storeEmployee(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);

    const conv = await convert(sr._id, token);
    expect(conv.status).toBe(201);

    const po = await PurchaseOrder.findOne({ spendRequestId: sr._id }).lean();
    /* The whole chain, from the door that is not the form. */
    expect(String(po.sourceMrfId)).toBe(String(mrf._id));
    expect(po.sourceMrfNumber).toBe(mrf.mrfNumber);
    expect(po.provenancePolicy).toBe(governed.PROVENANCE_POLICY);
    expect(po.items.every((l) => l.spendLineId)).toBe(true);

    /* And it is not a dead end: the order this door makes can be issued. */
    const issued = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(200);
    expect((await PurchaseOrder.findById(po._id).lean()).status).toBe("ISSUED");
  });

  it("refuses an intake-origin request and creates no draft", async () => {
    const co = await company();
    const { token } = await storeEmployee(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    await SpendRequest.collection.updateOne({ _id: sr._id }, {
      $unset: { sourceMrfId: "", sourceMrfNumber: "" },
      $set: { intakeRequestId: new mongoose.Types.ObjectId() },
    });

    const conv = await convert(sr._id, token);
    expect(conv.status).toBe(400);
    expect(conv.body.error.code).toBe("MRF_REQUIRED");
    expect(await PurchaseOrder.countDocuments({ spendRequestId: sr._id })).toBe(0);
    /* The request is untouched — no status moved, no order number minted. */
    const after = await SpendRequest.findById(sr._id).lean();
    expect(after.status).toBe("approved");
    expect(after.purchaseOrderId).toBeFalsy();
  });

  it("both doors refuse a missing commitment identically", async () => {
    const co = await company();
    const { token } = await storeEmployee(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf, { commitment: false });

    const viaForm = await call(PO, {
      token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) },
    });
    const viaContext = await convert(sr._id, token);

    /* One authority, so one answer. */
    expect(viaForm.body.error.code).toBe("BUDGET_AUTHORITY_UNAVAILABLE");
    expect(viaContext.body.error.code).toBe("BUDGET_AUTHORITY_UNAVAILABLE");
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });
});

/* ══ THE COMPLETE APPROVED SET, AND EXACT RECONCILIATION, AT ISSUE ══════ */

describe("issuing requires the whole approved order, reconciled exactly", () => {
  /* A two-line request, so "one line missing" is a state that can exist. */
  async function twoLineDraft(co, token) {
    const ri2 = await rawItem();
    const mrf = await MRF.findByIdAndUpdate(
      (await mrfWithShortfall(co))._id,
      { $push: { items: {
        rawItem: ri2._id, rawItemName: ri2.name, rawItemSku: ri2.sku,
        requestedQty: 20, unit: "m", issuedQty: 0, buyQty: 20, itemStatus: "PENDING",
      } } },
      { new: true },
    ).lean();

    const r = await SpendRequest.collection.insertOne({
      companyId: co._id, requestNumber: `SR/${++seq}`, title: "Two lines",
      purpose: "Two lines", requestType: "PRODUCT", status: "approved",
      department: mrf.requestedForDept,
      requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Meena",
      sourceMrfId: mrf._id, sourceMrfNumber: mrf.mrfNumber,
      budgetApprovalKind: "within_budget",
      items: mrf.items.map((l) => ({
        _id: new mongoose.Types.ObjectId(), name: l.rawItemName, whyNeeded: "Shortfall",
        sourceMrfLineId: l._id, rawItem: l.rawItem, rawItemSku: l.rawItemSku,
        variantId: l.variantId || null,
        quantity: l.buyQty, unit: l.unit, rate: 120, amount: l.buyQty * 120,
        gstPercent: 5, taxAmount: l.buyQty * 120 * 0.05,
        vendorName: "Northwind Textiles",
      })),
      /* Lines + tax, with no header adjustment — stated so the stored total
         follows from its own parts. */
      grandTotal: Math.round(mrf.items.reduce((t, l) => t + l.buyQty * 120 * 1.05, 0) * 100) / 100,
      createdAt: new Date(),
    });
    await MRF.updateOne({ _id: mrf._id }, { $set: { spendRequestId: r.insertedId } });
    const total = mrf.items.reduce((t, l) => t + l.buyQty * 120 * 1.05, 0);
    const c = await Acc_BudgetCommitment.create({
      spendRequestId: r.insertedId, companyId: co._id, amount: Math.round(total * 100) / 100, status: "committed",
    });
    await SpendRequest.collection.updateOne({ _id: r.insertedId }, {
      $set: {
        commitmentId: c._id, commitmentStatus: "committed",
        budgetApprovalMode: "COMMITMENT_REQUIRED", budgetApprovalModeAt: new Date(),
      },
    });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);
    return { mrf, id: res.body.purchaseOrder._id };
  }
  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  const issue = (id, token) => call(`${PO}/${id}/status`, {
    token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
  });

  it("a three-line order issues with all its lines", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    expect((await PurchaseOrder.findById(id).lean()).items).toHaveLength(2);
    expect((await issue(id, token)).status).toBe(200);
  });

  it("deleting an approved line from the draft blocks issue", async () => {
    /* The hole this closes: looping only over remaining lines let a draft drop
       one approved line and issue the rest, marking the request ordered in
       full while a quarter of it was never bought. */
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $pop: { items: 1 } });

    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/is missing from it/i);
    expect((await PurchaseOrder.findById(id).lean()).status).toBe("DRAFT");
  });

  it("cancelling one approved line blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { "items.0.status": "CANCELLED" } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/has been cancelled/i);
  });

  it("a duplicated line blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    const po = await PurchaseOrder.findById(id).lean();
    await PurchaseOrder.collection.updateOne({ _id: oid(id) },
      { $push: { items: { ...po.items[0], _id: new mongoose.Types.ObjectId() } } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/more than once/i);
  });

  it("an extra line nobody approved blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    const po = await PurchaseOrder.findById(id).lean();
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, {
      $push: { items: { ...po.items[0], _id: new mongoose.Types.ObjectId(), spendLineId: new mongoose.Types.ObjectId() } },
    });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not on the approved purchase request/i);
  });

  it("a reduced quantity blocks issue, not only an increased one", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { "items.0.quantity": 1 } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/but 100 was approved|but 20 was approved/i);
  });

  it("a zero header total blocks issue", async () => {
    /* ₹100,000 of lines under a zero total is not harmless: the order, the
       budget and the eventual invoice all disagree. */
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { totalAmount: 0 } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/its total is 0/i);
  });

  it("an understated subtotal blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { subtotal: 1 } });
    expect((await issue(id, token)).status).toBe(409);
  });

  it("an altered tax AMOUNT blocks issue even with the rate unchanged", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    const po = await PurchaseOrder.findById(id).lean();
    /* Rate still 5%, amount quietly halved. */
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, {
      $set: { "items.0.gstAmount": po.items[0].gstAmount / 2 },
    });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/tax amount/i);
  });

  it("an unapproved per-line charge blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, {
      $set: { "items.0.itemChargesTotal": 500, "items.0.itemCharges": [{ label: "Handling", value: "500", type: "amount", amount: 500 }] },
    });
    expect((await issue(id, token)).status).toBe(409);
  });

  it("an unknown provenance policy blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await twoLineDraft(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { provenancePolicy: "MRF_REQUIRED_V2" } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("PROVENANCE_UNSUPPORTED");
  });
});

/* ══ APPROVED ADJUSTMENTS ARE A PRESERVED FEATURE ═══════════════════════ */

describe("charges approved on the request flow onto the order", () => {
  it("approved shipping and custom charges reach the purchase order", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, {
      approvedShippingCharges: 500,
      approvedCustomCharges: [{ label: "Handling", amount: 250 }],
      approvedDiscount: 100,
      commitmentAmount: 13250,
    });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      /* The buyer may send them — they must match what was approved. */
      body: { sourceMrfId: String(mrf._id), shippingCharges: 500, discount: 100,
        customCharges: [{ label: "Handling", amount: 250 }] },
    });
    expect(res.status).toBe(201);

    const po = await PurchaseOrder.findById(res.body.purchaseOrder._id).lean();
    expect(po.shippingCharges).toBe(500);
    expect(po.discount).toBe(100);
    expect(po.customCharges).toHaveLength(1);
    expect(po.customCharges[0].label).toBe("Handling");
    /* 12,000 + 600 tax + 500 + 250 − 100 */
    expect(po.totalAmount).toBe(13250);

    /* And it issues — the feature works end to end. */
    const issued = await call(`${PO}/${po._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(200);
  });

  it("a charge the request did not approve is refused", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);   // nothing approved
    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), shippingCharges: 500 },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
  });

  it("a negative or malformed adjustment is refused, never silently dropped", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf);

    for (const body of [
      { shippingCharges: -100 },
      { discount: -50 },
      { shippingCharges: "abc" },
      { customCharges: [{ label: "Odd", amount: -5 }] },
      { customCharges: "not-a-list" },
    ]) {
      const res = await call(PO, {
        token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id), ...body },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
    }
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("a charge removed from an approved order blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { approvedShippingCharges: 500, commitmentAmount: 13100 });
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);

    await PurchaseOrder.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(res.body.purchaseOrder._id)) },
      { $set: { shippingCharges: 0, totalAmount: 12600 } },
    );
    const issued = await call(`${PO}/${res.body.purchaseOrder._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(409);
  });
});

/* ══ THE COMMITMENT MUST COVER THE MONEY ════════════════════════════════ */

describe("the budget amount, not only the commitment's existence", () => {
  it("a commitment too small for the order is refused at creation", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, { commitmentAmount: 1 });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COMMITMENT_TOO_SMALL");
    expect(res.body.error.details.remaining).toBe(1);
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("a partly released commitment no longer covers the full order", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf, { commitmentStatus: "partially_released" });
    await Acc_BudgetCommitment.updateOne({ spendRequestId: sr._id }, { $set: { releasedAmount: 12000 } });

    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COMMITMENT_PARTLY_RELEASED");
  });

  it("a commitment released after drafting blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    const sr = await approvedRequestFor(co, mrf);
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    expect(res.status).toBe(201);

    await Acc_BudgetCommitment.updateOne({ spendRequestId: sr._id },
      { $set: { releasedAmount: 12600, status: "partially_released" } });

    const issued = await call(`${PO}/${res.body.purchaseOrder._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(409);
  });

  /* ══════════════════════════════════════════════════════════════════════
     PER-LINE ALLOCATIONS — FINANCE'S ARITHMETIC, NOT A SECOND FORMULA

     `lineAllocation.allocateLines()` returns, per line:
       lineAmount  the line before the header adjustment
       adjustment  its apportioned share of freight / discount / rounding
       amount      lineAmount + adjustment — the FINAL committed figure

     So `amount` alone is the authority. Adding `adjustment` to it applies the
     header twice: it overstates with freight, and understates with a discount
     (where the adjustment is negative), refusing perfectly valid orders.
     ══════════════════════════════════════════════════════════════════════ */

  /** An approved request whose grand total differs from its lines by `delta`. */
  async function requestWithHeader(co, delta, lineCount = 1) {
    const mrf = await mrfWithShortfall(co);
    const extra = [];
    for (let i = 1; i < lineCount; i += 1) {
      const ri = await rawItem();
      extra.push({
        rawItem: ri._id, rawItemName: ri.name, rawItemSku: ri.sku,
        requestedQty: 100, unit: "m", issuedQty: 0, buyQty: 100, itemStatus: "PENDING",
      });
    }
    if (extra.length) await MRF.updateOne({ _id: mrf._id }, { $push: { items: { $each: extra } } });
    const full = await MRF.findById(mrf._id).lean();

    const items = full.items.map((l) => ({
      _id: new mongoose.Types.ObjectId(), name: l.rawItemName, whyNeeded: "Shortfall",
      sourceMrfLineId: l._id, rawItem: l.rawItem, rawItemSku: l.rawItemSku,
      variantId: l.variantId || null,
      quantity: l.buyQty, unit: l.unit, rate: 120,
      amount: l.buyQty * 120, gstPercent: 5, taxAmount: l.buyQty * 120 * 0.05,
      vendorName: "Northwind Textiles",
    }));
    const lineSum = items.reduce((t, i) => t + i.amount + i.taxAmount, 0);
    const grandTotal = Math.round((lineSum + delta) * 100) / 100;

    const r = await SpendRequest.collection.insertOne({
      companyId: co._id, requestNumber: `SR/${++seq}`, title: "Header adjustment",
      purpose: "Header adjustment", requestType: "PRODUCT", status: "approved",
      department: full.requestedForDept,
      requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Meena",
      sourceMrfId: full._id, sourceMrfNumber: full.mrfNumber,
      budgetApprovalKind: "within_budget",
      items, grandTotal,
      /* The header adjustment, approved where Finance can see it. */
      ...(delta > 0 ? { approvedShippingCharges: delta } : {}),
      ...(delta < 0 ? { approvedDiscount: Math.abs(delta) } : {}),
      createdAt: new Date(),
    });
    await MRF.updateOne({ _id: full._id }, { $set: { spendRequestId: r.insertedId } });
    return { mrf: full, sr: await SpendRequest.findById(r.insertedId).lean(), grandTotal };
  }

  /** The allocator's own answer — never a figure this test computed. */
  function expectedSplit(sr) {
    const out = lineAllocation.allocateLines({ lines: sr.items, grandTotal: sr.grandTotal });
    expect(out.ok).toBe(true);
    return out.allocations;
  }

  async function commitWith(co, sr, allocations, over = {}) {
    const c = await Acc_BudgetCommitment.create({
      spendRequestId: sr._id, companyId: co._id,
      amount: over.total ?? sr.grandTotal,
      releasedAmount: over.releasedAmount ?? 0,
      status: over.status || "committed",
      allocations,
    });
    await SpendRequest.collection.updateOne({ _id: sr._id }, {
      $set: {
        commitmentId: c._id, commitmentStatus: c.status,
        budgetApprovalMode: "COMMITMENT_REQUIRED", budgetApprovalModeAt: new Date(),
      },
    });
    return c;
  }
  const create = (co, mrf, token) =>
    call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });

  it("a positive freight adjustment allocates and passes", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 600);
    const split = expectedSplit(sr);
    /* lineAmount 12,600 + adjustment 600 = amount 13,200. */
    expect(split[0].lineAmount).toBe(12600);
    expect(split[0].adjustment).toBe(600);
    expect(split[0].amount).toBe(13200);

    await commitWith(co, sr, split.map((a) => ({
      spendLineId: a.spendLineId, amount: a.amount, adjustment: a.adjustment, status: "committed",
    })));
    expect((await create(co, mrf, token)).status).toBe(201);
  });

  it("a negative discount adjustment allocates and passes", async () => {
    /* The case `amount + adjustment` got backwards: it would compute 11,400
       and refuse an order of 12,000 that Finance had fully approved. */
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, -600);
    const split = expectedSplit(sr);
    expect(split[0].lineAmount).toBe(12600);
    expect(split[0].adjustment).toBe(-600);
    expect(split[0].amount).toBe(12000);

    await commitWith(co, sr, split.map((a) => ({
      spendLineId: a.spendLineId, amount: a.amount, adjustment: a.adjustment, status: "committed",
    })));
    expect((await create(co, mrf, token)).status).toBe(201);
  });

  it("combined freight and discount allocate to their net", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 400);   // +500 freight, -100 discount
    const split = expectedSplit(sr);
    expect(split[0].amount).toBe(13000);
    await commitWith(co, sr, split.map((a) => ({
      spendLineId: a.spendLineId, amount: a.amount, adjustment: a.adjustment, status: "committed",
    })));
    expect((await create(co, mrf, token)).status).toBe(201);
  });

  it("a one-paise proportional remainder lands where the allocator puts it", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0.01, 3);
    const split = expectedSplit(sr);
    /* The remainder is not spread — it goes on the LAST eligible line, so the
       parts add to the whole by construction. */
    expect(split.reduce((t, a) => t + a.amount, 0)).toBeCloseTo(sr.grandTotal, 2);
    expect(split[split.length - 1].adjustment).toBeCloseTo(0.01, 2);

    await commitWith(co, sr, split.map((a) => ({
      spendLineId: a.spendLineId, amount: a.amount, adjustment: a.adjustment, status: "committed",
    })));
    expect((await create(co, mrf, token)).status).toBe(201);
  });

  it("a stored amount that already includes the adjustment is correct, not doubled", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 600);
    const split = expectedSplit(sr);
    /* Exactly what the allocator stored: amount 13,200 WITH adjustment 600
       beside it. A check that added them would look for 13,800 and refuse. */
    await commitWith(co, sr, [{
      spendLineId: split[0].spendLineId, amount: 13200, adjustment: 600, status: "committed",
    }]);
    expect((await create(co, mrf, token)).status).toBe(201);
  });

  it("an allocation that disagrees with the approved split is refused", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 600);
    const split = expectedSplit(sr);
    /* The old, doubled figure. */
    await commitWith(co, sr, [{
      spendLineId: split[0].spendLineId, amount: 13800, adjustment: 600, status: "committed",
    }]);
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("ALLOCATION_MISMATCH");
    expect(res.body.error.details.expected).toBe(13200);
  });

  it("a partially released allocation no longer covers its line", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0);
    const split = expectedSplit(sr);
    await commitWith(co, sr, [{
      spendLineId: split[0].spendLineId, amount: split[0].amount, adjustment: split[0].adjustment,
      status: "partially_released", releasedAmount: 600, remainingAmount: split[0].amount - 600,
    }]);
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("ALLOCATION_PARTLY_RELEASED");
    expect(res.body.error.details.remaining).toBe(12000);
  });

  it("a fully released allocation holds nothing", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0);
    const split = expectedSplit(sr);
    await commitWith(co, sr, [{
      spendLineId: split[0].spendLineId, amount: split[0].amount, adjustment: split[0].adjustment,
      status: "released", releasedAmount: split[0].amount, remainingAmount: 0,
    }]);
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("ALLOCATION_NOT_LIVE");
  });

  it("one line cannot consume another line's allocation", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0, 2);
    const split = expectedSplit(sr);
    /* Both allocations point at the first line. Overall the money is there;
       line by line, the second line has nothing promised against it. */
    await commitWith(co, sr, [
      { spendLineId: split[0].spendLineId, amount: split[0].amount, adjustment: 0, status: "committed" },
      { spendLineId: split[0].spendLineId, amount: split[1].amount, adjustment: 0, status: "committed" },
    ]);
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("ALLOCATION_DUPLICATE");
  });

  it("an allocation for a line that is not on the request is refused", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0);
    await commitWith(co, sr, [{
      spendLineId: new mongoose.Types.ObjectId(), amount: sr.grandTotal, adjustment: 0, status: "committed",
    }]);
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("ALLOCATION_UNKNOWN_LINE");
  });

  it("a line with no allocation at all is refused", async () => {
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0, 2);
    const split = expectedSplit(sr);
    /* Only the first line is promised for. */
    await commitWith(co, sr, [{
      spendLineId: split[0].spendLineId, amount: split[0].amount, adjustment: 0, status: "committed",
    }]);
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("ALLOCATION_MISSING");
  });

  it("the whole remaining commitment must still cover the grand total", async () => {
    /* The per-line check does not replace the top-level one. */
    const co = await company();
    const token = await actor(co);
    const { mrf, sr } = await requestWithHeader(co, 0);
    const split = expectedSplit(sr);
    await commitWith(co, sr, split.map((a) => ({
      spendLineId: a.spendLineId, amount: a.amount, adjustment: a.adjustment, status: "committed",
    })), { total: 1 });
    const res = await create(co, mrf, token);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("COMMITMENT_TOO_SMALL");
  });

});

/* ══ CUSTOM CHARGES ARE COMPARED EXACTLY ════════════════════════════════ */

describe("approved charges are compared by label and amount, not by count and total", () => {
  it("the same count and the same total do not pass when the labels differ", async () => {
    /* approved: Handling 200, Insurance 50   →  2 charges, 250
       ordered:  Freight  100, Other     150  →  2 charges, 250
       A count-and-total comparison calls these identical, and the company pays
       for something Finance never agreed to. */
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, {
      approvedCustomCharges: [{ label: "Handling", amount: 200 }, { label: "Insurance", amount: 50 }],
      commitmentAmount: 12850,
    });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: {
        sourceMrfId: String(mrf._id),
        customCharges: [{ label: "Freight", amount: 100 }, { label: "Other", amount: 150 }],
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
    expect(await PurchaseOrder.countDocuments({ companyId: co._id })).toBe(0);
  });

  it("the same labels with individually different amounts do not pass", async () => {
    /* Handling 200 + Insurance 50 vs Handling 50 + Insurance 200 — same names,
       same total, different agreement. */
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, {
      approvedCustomCharges: [{ label: "Handling", amount: 200 }, { label: "Insurance", amount: 50 }],
      commitmentAmount: 12850,
    });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: {
        sourceMrfId: String(mrf._id),
        customCharges: [{ label: "Handling", amount: 50 }, { label: "Insurance", amount: 200 }],
      },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("CHARGES_EXCEED_APPROVED");
  });

  it("order and casing do not matter — a charge list is a set of agreed costs", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, {
      approvedCustomCharges: [{ label: "Handling", amount: 200 }, { label: "Insurance", amount: 50 }],
      commitmentAmount: 12850,
    });

    const res = await call(PO, {
      token, method: "POST", key: newKey(),
      body: {
        sourceMrfId: String(mrf._id),
        /* Reordered and differently cased: the same agreement. */
        customCharges: [{ label: "  insurance ", amount: 50 }, { label: "HANDLING", amount: 200 }],
      },
    });
    expect(res.status).toBe(201);
  });

  it("a duplicate label is two charges, not one", async () => {
    /* Two ₹50 handling rows are ₹100 of handling; collapsing them would hide
       one of them. */
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, {
      approvedCustomCharges: [{ label: "Handling", amount: 50 }, { label: "Handling", amount: 50 }],
      commitmentAmount: 12700,
    });

    const one = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), customCharges: [{ label: "Handling", amount: 100 }] },
    });
    expect(one.status).toBe(409);

    const two = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), customCharges: [{ label: "Handling", amount: 50 }, { label: "Handling", amount: 50 }] },
    });
    expect(two.status).toBe(201);
  });

  it("swapped charges on a draft block issue", async () => {
    const co = await company();
    const token = await actor(co);
    const mrf = await mrfWithShortfall(co);
    await approvedRequestFor(co, mrf, {
      approvedCustomCharges: [{ label: "Handling", amount: 200 }],
      commitmentAmount: 12800,
    });
    const created = await call(PO, {
      token, method: "POST", key: newKey(),
      body: { sourceMrfId: String(mrf._id), customCharges: [{ label: "Handling", amount: 200 }] },
    });
    expect(created.status).toBe(201);

    /* Same count, same total, different charge. */
    await PurchaseOrder.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(created.body.purchaseOrder._id)) },
      { $set: { customCharges: [{ label: "Freight", amount: 200 }] } },
    );
    const issued = await call(`${PO}/${created.body.purchaseOrder._id}/status`, {
      token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
    });
    expect(issued.status).toBe(409);
    expect(issued.body.error.message).toMatch(/not the ones the purchase request approved/i);
  });
});

/* ══ SUPPLIER IDENTITY SURVIVES BY ID ═══════════════════════════════════ */

describe("an approved supplier id must survive exactly", () => {
  async function withVendor(co, token, over = {}) {
    const Vendor = governed.Vendor;
    const vendor = await Vendor.create({ companyName: "Northwind Textiles", companyId: co._id });
    const mrf = await mrfWithShortfall(co);
    const line = mrf.items[0];
    const r = await SpendRequest.collection.insertOne({
      companyId: co._id, requestNumber: `SR/${++seq}`, title: "With supplier id",
      purpose: "With supplier id", requestType: "PRODUCT", status: "approved",
      department: mrf.requestedForDept,
      requestedBy: new mongoose.Types.ObjectId(), requestedByName: "Meena",
      sourceMrfId: mrf._id, sourceMrfNumber: mrf.mrfNumber, budgetApprovalKind: "within_budget",
      items: [{
        _id: new mongoose.Types.ObjectId(), name: line.rawItemName, whyNeeded: "Shortfall",
        sourceMrfLineId: line._id, rawItem: line.rawItem, rawItemSku: line.rawItemSku,
        variantId: line.variantId || null,
        quantity: line.buyQty, unit: line.unit, rate: 120, amount: line.buyQty * 120,
        gstPercent: 5, taxAmount: line.buyQty * 120 * 0.05,
        ...(over.nameOnly ? {} : { vendorId: vendor._id }),
        vendorName: "Northwind Textiles",
      }],
      grandTotal: 12600,
      createdAt: new Date(),
    });
    await MRF.updateOne({ _id: mrf._id }, { $set: { spendRequestId: r.insertedId } });
    const c = await Acc_BudgetCommitment.create({
      spendRequestId: r.insertedId, companyId: co._id, amount: 12600, status: "committed",
    });
    await SpendRequest.collection.updateOne({ _id: r.insertedId }, {
      $set: { commitmentId: c._id, commitmentStatus: "committed",
        budgetApprovalMode: "COMMITMENT_REQUIRED", budgetApprovalModeAt: new Date() },
    });
    const res = await call(PO, { token, method: "POST", key: newKey(), body: { sourceMrfId: String(mrf._id) } });
    return { vendor, mrf, id: res.body?.purchaseOrder?._id, res };
  }
  const oid = (id) => new mongoose.Types.ObjectId(String(id));
  const issue = (id, token) => call(`${PO}/${id}/status`, {
    token, method: "PATCH", key: newKey(), body: { status: "ISSUED" },
  });

  it("the exact approved supplier id succeeds", async () => {
    const co = await company();
    const token = await actor(co);
    const { vendor, id, res } = await withVendor(co, token);
    expect(res.status).toBe(201);
    expect(String((await PurchaseOrder.findById(id).lean()).vendor)).toBe(String(vendor._id));
    expect((await issue(id, token)).status).toBe(200);
  });

  it("removing the id while keeping the name blocks issue", async () => {
    /* The hole: a name is not a substitute for an approved identity. */
    const co = await company();
    const token = await actor(co);
    const { id } = await withVendor(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $unset: { vendor: "" } });

    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/supplier id has been removed/i);
    expect((await PurchaseOrder.findById(id).lean()).status).toBe("DRAFT");
  });

  it("swapping in a same-name supplier blocks issue", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await withVendor(co, token);
    /* A different supplier that happens to share the approved name. */
    const twin = await governed.Vendor.create({ companyName: "Northwind Textiles", companyId: co._id });
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { vendor: twin._id } });

    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/not the one on the approved purchase request/i);
  });

  it("a same-name supplier from another company blocks issue", async () => {
    const co = await company();
    const other = await company();
    const token = await actor(co);
    const { id } = await withVendor(co, token);
    const foreign = await governed.Vendor.create({ companyName: "Northwind Textiles", companyId: other._id });
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { vendor: foreign._id } });
    expect((await issue(id, token)).status).toBe(409);
  });

  it("a drifted supplier name blocks issue even with the right id", async () => {
    const co = await company();
    const token = await actor(co);
    const { id } = await withVendor(co, token);
    await PurchaseOrder.collection.updateOne({ _id: oid(id) }, { $set: { vendorName: "Someone Else" } });
    const res = await issue(id, token);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no longer matches the supplier it is addressed to/i);
  });

  it("a genuinely name-only approval keeps its normalised-name behaviour", async () => {
    const co = await company();
    const token = await actor(co);
    const { id, res } = await withVendor(co, token, { nameOnly: true });
    expect(res.status).toBe(201);
    /* No id was approved, so the name is all there is — and it still works. */
    expect((await issue(id, token)).status).toBe(200);
  });
});
