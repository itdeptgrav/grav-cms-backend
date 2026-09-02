// test/store-purchase/deliveries-returns.route.test.js
//
// Store & Purchase — Chunk 1C. Delivery reads and supplier returns.
//
// Two routers that both touch real inventory and had no company boundary at
// all. The return router additionally moved stock with no key and a silent
// clamp; the delivery router invented per-item quantities and a delivery value
// and served them as recorded fact.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Mounted exactly as server.js mounts them.
  app.use(
    "/api/cms/inventory/operations/deliveries",
    require("../../routes/CMS_Routes/Inventory/Operations/deliveries"),
  );
  app.use(
    "/api/cms/inventory/operations/purchase-orders/:poId/returns",
    require("../../routes/CMS_Routes/Inventory/Operations/returnRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/operations`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => {
  jest.restoreAllMocks();
  unitOfWork.__setTransactionSupport(null);
});

const newKey = () => `dr-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
  }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

/**
 * `grant` is the Store department role. `null` is an authenticated employee
 * with no Store & Purchase grant at all — the case the old routers served
 * everything to.
 */
async function person({ co, grant = null, role = "approver", name = "P" }) {
  const n = ++seq;
  const email = `dr${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `DR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * A received order with stock on the shelf and one delivery recorded.
 * `co: null` builds a legacy-global order — one that predates the boundary.
 */
async function receivedOrder({ co, stockQty = 100, receivedQty = 20, orderedQty = 20, createdBy = null }) {
  const n = ++seq;
  const raw = await RawItem.create({
    name: `Bolt ${n}`, sku: `BLT-${n}`, unit: "pcs", quantity: stockQty, minStock: 0,
  });
  const vendor = await Vendor.create({ companyName: `Vendor ${n}`, ...(co ? {} : {}) });
  const po = await PurchaseOrder.create({
    ...(co ? { companyId: co._id } : {}),
    createdBy: createdBy || new mongoose.Types.ObjectId(),
    poNumber: `PO/2026-27/${String(n).padStart(4, "0")}`,
    vendor: vendor._id, vendorName: vendor.companyName,
    status: "PARTIALLY_RECEIVED",
    items: [{
      rawItem: raw._id, itemName: raw.name, sku: raw.sku, unit: "pcs",
      quantity: orderedQty, receivedQuantity: receivedQty,
      pendingQuantity: Math.max(0, orderedQty - receivedQty),
      unitPrice: 50, totalPrice: orderedQty * 50,
    }],
    deliveries: [{
      deliveryDate: new Date(), quantityReceived: receivedQty, invoiceNumber: `INV-${n}`,
    }],
    totalReceived: receivedQty,
    totalPending: Math.max(0, orderedQty - receivedQty),
    totalAmount: orderedQty * 50,
  });
  return { po, raw, vendor, itemId: String(po.items[0]._id), deliveryId: String(po.deliveries[0]._id) };
}

const raiseReturn = (po, itemId, token, qty, key = newKey()) =>
  call(`/purchase-orders/${po._id}/returns`, {
    method: "POST", token, idempotencyKey: key,
    body: { poItemId: itemId, damagedQuantity: qty, reason: "Bent on arrival" },
  });

/* ═══ 1 · TENANT ISOLATION ═══════════════════════════════════════════════ */

describe("tenant isolation", () => {
  test("company A cannot list or read company B deliveries", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const { po, deliveryId } = await receivedOrder({ co: b });

    const list = await call("/deliveries", { token: storeA.token });
    expect(list.status).toBe(200);
    expect(list.body.deliveries.map((d) => d.poNumber)).not.toContain(po.poNumber);

    const detail = await call(`/deliveries/${deliveryId}`, { token: storeA.token });
    const missing = await call(`/deliveries/${new mongoose.Types.ObjectId()}`, { token: storeA.token });
    expect(detail.status).toBe(404);
    expect(missing.status).toBe(404);           // indistinguishable
    expect(JSON.stringify(detail.body)).not.toContain(po.poNumber);
  });

  test("delivery statistics and the pending-PO count are tenant-scoped", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    await receivedOrder({ co: b });
    await receivedOrder({ co: b, orderedQty: 50, receivedQty: 10 });   // B has a pending PO

    const list = await call("/deliveries", { token: storeA.token });
    expect(list.body.stats.totalDeliveries).toBe(0);
    expect(list.body.stats.totalQuantity).toBe(0);
    expect(list.body.stats.pendingPOs).toBe(0);       // was a global count

    const stats = await call("/deliveries/stats/summary", { token: storeA.token });
    expect(stats.status).toBe(200);
    expect(stats.body.stats.totalDeliveries).toBe(0);
    expect(stats.body.stats.vendorPerformance).toHaveLength(0);

    const pending = await call("/deliveries/data/pending-pos", { token: storeA.token });
    expect(pending.status).toBe(200);
    expect(pending.body.purchaseOrders).toHaveLength(0);
  });

  test("company A cannot read or mutate company B supplier returns", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const storeB = await person({ co: b, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: b });

    const created = await raiseReturn(po, itemId, storeB.token, 5);
    expect(created.status).toBe(201);
    const returnId = created.body.returnRequest._id;
    const stockAfterB = (await RawItem.findById(raw._id).lean()).quantity;

    expect((await call(`/purchase-orders/${po._id}/returns`, { token: storeA.token })).status).toBe(404);
    expect((await raiseReturn(po, itemId, storeA.token, 1)).status).toBe(404);
    expect((await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: storeA.token, idempotencyKey: newKey(), body: { quantityReceived: 1 },
    })).status).toBe(404);
    expect((await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: storeA.token, idempotencyKey: newKey(), body: {},
    })).status).toBe(404);

    // Nothing of B's moved.
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(stockAfterB);
    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(1);
    expect(stored.returnRequests[0].status).toBe("PENDING");
  });

  test("a companyId in the body or query cannot override resolved tenancy", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a });

    const created = await call(`/purchase-orders/${po._id}/returns?companyId=${b._id}`, {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { poItemId: itemId, damagedQuantity: 2, reason: "x", companyId: String(b._id) },
    });
    expect(created.status).toBe(201);

    /* The return lives on A's order; nothing about B was accepted, and the
       history row is stamped with the resolved company. */
    const entry = await SpActionHistory.findOne({ entityId: po._id }).lean();
    expect(String(entry.companyId)).toBe(String(a._id));

    // And a delivery list asked for as B still answers as A.
    const list = await call(`/deliveries?companyId=${b._id}`, { token: storeA.token });
    expect(list.status).toBe(200);
    for (const d of list.body.deliveries) {
      const owner = await PurchaseOrder.findById(d.purchaseOrderId).select("companyId").lean();
      expect(String(owner.companyId)).toBe(String(a._id));
    }
  });

  test("legacy-global orders are excluded from ordinary company reads", async () => {
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store" });
    const { po, deliveryId } = await receivedOrder({ co: null });   // no companyId

    const list = await call("/deliveries", { token: storeA.token });
    expect(list.body.deliveries.map((d) => d.poNumber)).not.toContain(po.poNumber);
    expect((await call(`/deliveries/${deliveryId}`, { token: storeA.token })).status).toBe(404);
    expect((await call(`/purchase-orders/${po._id}/returns`, { token: storeA.token })).status).toBe(404);

    // Ownership is never invented for it.
    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.companyId == null).toBe(true);
  });
});

/* ═══ 2 · CAPABILITIES ═══════════════════════════════════════════════════ */

describe("capabilities", () => {
  test("an authenticated user with no Store grant can read nothing here", async () => {
    const a = await company("Acme");
    const nobody = await person({ co: a });                 // member, no grant
    const { po, itemId, deliveryId } = await receivedOrder({ co: a });

    for (const path of ["/deliveries", `/deliveries/${deliveryId}`,
                        "/deliveries/data/pending-pos", "/deliveries/stats/summary",
                        `/purchase-orders/${po._id}/returns`]) {
      const res = await call(path, { token: nobody.token });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    }

    expect((await raiseReturn(po, itemId, nobody.token, 1)).status).toBe(403);
  });

  test("a viewer reads but cannot mutate", async () => {
    const a = await company("Acme");
    const viewer = await person({ co: a, grant: "store", role: "viewer" });
    const { po, itemId, raw, deliveryId } = await receivedOrder({ co: a });

    expect((await call("/deliveries", { token: viewer.token })).status).toBe(200);
    expect((await call(`/deliveries/${deliveryId}`, { token: viewer.token })).status).toBe(200);
    expect((await call(`/purchase-orders/${po._id}/returns`, { token: viewer.token })).status).toBe(200);

    const blocked = await raiseReturn(po, itemId, viewer.token, 2);
    expect(blocked.status).toBe(403);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);
  });

  test("the grant matrix is what it is: no Store role separates return from receipt", async () => {
    /* Stated rather than implied. An earlier version of this test used a Store
       editor for one mutation and an approver for the other and called that
       separation — but editor holds BOTH sp.stock.return and sp.receipt.record,
       so it proved only that a superset can do two things. If the business ever
       wants the two split, this assertion is what fails first. */
    const { GRANTS, CAPABILITIES: C } = require("../../services/storePurchase/capabilities");
    expect(GRANTS.store.editor).toEqual(expect.arrayContaining([C.STOCK_RETURN, C.RECEIPT_RECORD]));
    expect(GRANTS.store.approver).toEqual(expect.arrayContaining([C.STOCK_RETURN, C.RECEIPT_RECORD]));
    expect(GRANTS.store.viewer).not.toContain(C.STOCK_RETURN);
    expect(GRANTS.store.viewer).not.toContain(C.RECEIPT_RECORD);
    // Board level reads and writes nothing here.
    for (const role of ["viewer", "editor", "approver", "owner"]) {
      expect(GRANTS.ceo[role]).not.toContain(C.STOCK_RETURN);
      expect(GRANTS.ceo[role]).not.toContain(C.RECEIPT_RECORD);
    }
  });

  test("each route asks for ITS OWN capability, proved with an isolated set", async () => {
    /* No role grants one of these without the other, so the routes are probed
       against a synthetic context holding exactly one capability at a time.
       That is the only way to show the create route asks for sp.stock.return
       and the receive route asks for sp.receipt.record, rather than both
       happening to pass because one actor holds everything. */
    const tenantContext = require("../../services/storePurchase/tenantContext.service");
    const { CAPABILITIES: C } = require("../../services/storePurchase/capabilities");

    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const withOnly = (...caps) => jest.spyOn(tenantContext, "resolveForActor")
      .mockImplementation(async () => ({
        companyId: a._id, siteId: null, actorId: String(store.emp._id),
        capabilities: caps, capabilitySet: new Set([C.READ, ...caps]),
        legacyMode: false, memberships: [],
      }));

    // sp.stock.return alone: may raise, may not receive.
    let spy = withOnly(C.STOCK_RETURN);
    const raised = await raiseReturn(po, itemId, store.token, 3);
    expect(raised.status).toBe(201);
    const returnId = raised.body.returnRequest._id;
    const deniedReceive = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 1 },
    });
    expect(deniedReceive.status).toBe(403);
    expect(deniedReceive.body.error.details.required).toContain(C.RECEIPT_RECORD);
    spy.mockRestore();

    // sp.receipt.record alone: may receive, may not raise or cancel.
    spy = withOnly(C.RECEIPT_RECORD);
    const received = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 1 },
    });
    expect(received.status).toBe(200);
    const deniedRaise = await raiseReturn(po, itemId, store.token, 2);
    expect(deniedRaise.status).toBe(403);
    expect(deniedRaise.body.error.details.required).toContain(C.STOCK_RETURN);
    const deniedCancel = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(deniedCancel.status).toBe(403);
    expect(deniedCancel.body.error.details.required).toContain(C.STOCK_RETURN);
    spy.mockRestore();
  });
});

/* ═══ 3 · RETURN STOCK SAFETY ════════════════════════════════════════════ */

describe("supplier returns move stock at most once", () => {
  test("a duplicate creation deducts once", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const key = newKey();
    const first = await raiseReturn(po, itemId, store.token, 6, key);
    const retry = await raiseReturn(po, itemId, store.token, 6, key);

    expect(first.status).toBe(201);
    expect(retry.replayed).toBe(true);

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(94);                  // not 88
    expect(after.stockTransactions).toHaveLength(1);
    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(1);
  });

  test("a duplicate replacement receipt credits once", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 8);
    const returnId = created.body.returnRequest._id;

    const key = newKey();
    const body = { quantityReceived: 3 };
    const first = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    const retry = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });

    expect(first.status).toBe(200);
    expect(retry.replayed).toBe(true);

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(95);                  // 100 - 8 + 3, once
    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests[0].returnedQuantity).toBe(3);
    expect(stored.returnRequests[0].receipts).toHaveLength(1);
  });

  test("the same key with a changed payload conflicts", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const key = newKey();
    expect((await raiseReturn(po, itemId, store.token, 5, key)).status).toBe(201);

    const changed = await raiseReturn(po, itemId, store.token, 9, key);
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");

    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(95);
  });

  test("an effectful call without a key is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a });

    const res = await call(`/purchase-orders/${po._id}/returns`, {
      method: "POST", token: store.token,
      body: { poItemId: itemId, damagedQuantity: 2 },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);
  });

  test("a failure after the stock moved cannot deduct twice on retry", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const key = newKey();
    /* The stock saves, then the ORDER save fails — the one sequence that
       leaves the two halves of the action disagreeing. */
    const spy = jest.spyOn(PurchaseOrder.prototype, "save")
      .mockRejectedValueOnce(new Error("order save failed"));
    const failed = await raiseReturn(po, itemId, store.token, 7, key);
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const afterFailure = (await RawItem.findById(raw._id).lean()).quantity;
    expect(afterFailure).toBe(93);                    // the stock DID move

    const retry = await raiseReturn(po, itemId, store.token, 7, key);
    /* The order never recorded the return, so this is the honest, non-transactional
       answer: refuse, name the state, and ask for a human. */
    expect(retry.status).toBe(409);
    expect(retry.body.error.details.reason).toBe("PARTIAL_RETURN_NEEDS_RECONCILIATION");

    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(93);   // never 86
    expect((await RawItem.findById(raw._id).lean()).stockTransactions).toHaveLength(1);
  });
});

/* ═══ 4 · QUANTITY AND LIFECYCLE RULES ═══════════════════════════════════ */

describe("quantity and lifecycle rules", () => {
  test("insufficient stock is refused before anything is written, never clamped to zero", async () => {
    /* The old helper wrote `Math.max(0, prev + delta)`: deducting 40 from a
       shelf of 10 silently stored 0 and reported success. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 10, receivedQty: 40, orderedQty: 40 });

    const res = await raiseReturn(po, itemId, store.token, 40);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("INSUFFICIENT_STOCK");
    expect(res.body.error.details.available).toBe(10);

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(10);                  // untouched, not 0
    expect(after.stockTransactions || []).toHaveLength(0);
    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(0);
  });

  test("a return beyond the received quantity is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 5, orderedQty: 20 });

    const res = await raiseReturn(po, itemId, store.token, 9);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("RETURNABLE_QUANTITY_EXCEEDED");
    expect(res.body.error.details.receivedQuantity).toBe(5);
    expect(res.body.error.details.remainingReturnable).toBe(5);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);
  });

  test("a replacement beyond the pending quantity is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 4);
    const returnId = created.body.returnRequest._id;

    const res = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 9 },
    });
    expect(res.status).toBe(400);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(96);
  });

  test("partial then full replacement walks PENDING → PARTIAL → COMPLETED", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;
    expect(created.body.returnRequest.status).toBe("PENDING");

    const partial = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 4 },
    });
    expect(partial.status).toBe(200);
    expect(partial.body.returnRequest.status).toBe("PARTIAL");
    expect(partial.body.returnRequest.pendingReturnQty).toBe(6);

    const full = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 6 },
    });
    expect(full.status).toBe(200);
    expect(full.body.returnRequest.status).toBe("COMPLETED");
    expect(full.body.returnRequest.pendingReturnQty).toBe(0);

    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);  // 100 - 10 + 4 + 6
  });

  test("a completed return takes no further receipt and cannot be cancelled", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 3);
    const returnId = created.body.returnRequest._id;
    await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 3 },
    });

    const again = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 1 },
    });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("INVALID_TRANSITION");

    const cancel = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(cancel.status).toBe(409);
    expect(cancel.body.error.code).toBe("INVALID_TRANSITION");
  });

  test("a cancelled return takes no receipt, and cancelling again is deterministic", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 5);
    const returnId = created.body.returnRequest._id;

    const first = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(first.status).toBe(200);
    expect(first.body.returnRequest.status).toBe("CANCELLED");

    // A second cancellation, under a DIFFERENT key, answers the same way.
    const again = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.alreadyDone).toBe(true);
    expect(again.body.returnRequest.status).toBe("CANCELLED");

    const receipt = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 1 },
    });
    expect(receipt.status).toBe(409);

    /* Cancelling does NOT put the goods back — they are still damaged. */
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(95);
    expect(await SpActionHistory.countDocuments({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCELLED",
    })).toBe(1);
  });
});

/* ═══ 4b · RECOVERY IS OPERATION-SPECIFIC ════════════════════════════════ */

describe("recovery identifies the operation, not a lookalike", () => {
  const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

  test("an earlier identical return cannot satisfy recovery for a newer one", async () => {
    /* Recovery used to search by (poItemId, damagedQuantity). A second box of
       the same delivery turning out damaged is the ordinary case, and it
       produces a return that looks exactly like the first — so the caller was
       told their new return existed when nothing had been raised. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const first = await raiseReturn(po, itemId, store.token, 5);
    expect(first.status).toBe(201);
    const firstId = first.body.returnRequest._id;

    /* A NEW attempt, same item, same quantity, but its own key — and its PO
       save fails, so it never records. */
    const key = newKey();
    const spy = jest.spyOn(PurchaseOrder.prototype, "save")
      .mockRejectedValueOnce(new Error("order save failed"));
    const failed = await raiseReturn(po, itemId, store.token, 5, key);
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const retry = await raiseReturn(po, itemId, store.token, 5, key);
    /* It must NOT be told "already raised" on the strength of the first
       return. Its own stock moved and its own record is missing. */
    expect(retry.status).toBe(409);
    expect(retry.body.error.details.reason).toBe("PARTIAL_RETURN_NEEDS_RECONCILIATION");
    expect(JSON.stringify(retry.body)).not.toContain(firstId);

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(1);           // only the first
    expect(String(stored.returnRequests[0]._id)).toBe(String(firstId));
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(90);   // 5 + 5, never 85
  });

  test("an earlier replacement receipt cannot satisfy recovery for a newer one", async () => {
    /* Recovery used to treat ANY existing receipt as proof, so on a return
       that had already taken a partial replacement, a brand-new receipt was
       reported "already recorded" and the vendor's second delivery was lost. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;

    const firstReceipt = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 4 },
    });
    expect(firstReceipt.status).toBe(200);

    const key = newKey();
    const spy = jest.spyOn(PurchaseOrder.prototype, "save")
      .mockRejectedValueOnce(new Error("order save failed"));
    const failed = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: key, body: { quantityReceived: 3 },
    });
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const retry = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: key, body: { quantityReceived: 3 },
    });
    expect(retry.status).toBe(409);
    expect(retry.body.error.details.reason).toBe("PARTIAL_RETURN_RECEIPT_NEEDS_RECONCILIATION");

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests[0].receipts).toHaveLength(1);   // only the first
    expect(stored.returnRequests[0].returnedQuantity).toBe(4);
    // 100 − 10 + 4 (recorded) + 3 (moved, unrecorded) — and never a second 3.
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(97);
  });

  test("a failure BEFORE the stock changes leaves the record retryable", async () => {
    /* The marker used to be written before the stock moved, so an attempt that
       never reached the shelf still claimed EFFECT_APPLIED and every retry was
       refused as "already done" — for work that had not happened. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const key = newKey();
    const spy = jest.spyOn(RawItem, "findById")
      .mockImplementationOnce(() => { throw new Error("catalogue unavailable"); });
    const failed = await raiseReturn(po, itemId, store.token, 4, key);
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const record = await SpIdempotencyRecord.findOne({ key }).lean();
    expect(record.status).not.toBe("EFFECT_APPLIED");
    expect(record.effectAppliedAt == null).toBe(true);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);

    /* And the retry genuinely runs, because nothing happened the first time. */
    const retry = await raiseReturn(po, itemId, store.token, 4, key);
    expect(retry.status).toBe(201);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(96);
  });

  test("transactional mode threads one session through both writes", async () => {
    /* Where the deployment supports transactions, the RawItem write, the order
       write, the history entry and the effect marker share one session and
       commit together. mongodb-memory-server here is standalone, so the
       session is asserted at the seam rather than by committing one. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const seen = { rawItemSave: undefined, poSave: undefined };
    const rawSpy = jest.spyOn(RawItem.prototype, "save")
      .mockImplementation(function (opts) { seen.rawItemSave = opts?.session ?? null; return Promise.resolve(this); });
    const poSpy = jest.spyOn(PurchaseOrder.prototype, "save")
      .mockImplementation(function (opts) { seen.poSave = opts?.session ?? null; return Promise.resolve(this); });

    const marker = { session: undefined };
    const idem = require("../../services/storePurchase/idempotency.service");
    const markSpy = jest.spyOn(idem, "markEffectApplied")
      .mockImplementation(async (args) => { marker.session = args.session ?? null; });

    /* Force the transactional branch, with a REAL session so the queries the
       route runs are ones the driver accepts. Only the commit is skipped —
       this deployment is standalone — and what is under test is that one
       session reaches every write, not that Mongo can commit it. */
    unitOfWork.__setTransactionSupport(true);
    const realStartSession = mongoose.startSession.bind(mongoose);
    const sessionSpy = jest.spyOn(mongoose, "startSession").mockImplementation(async () => {
      const session = await realStartSession();
      session.withTransaction = async (fn) => fn(session);
      return session;
    });

    await raiseReturn(po, itemId, store.token, 2);

    /* Both domain writes received A session, and the same one. */
    expect(seen.rawItemSave).toBeTruthy();
    expect(seen.poSave).toBeTruthy();
    expect(seen.rawItemSave).toBe(seen.poSave);
    expect(marker.session).toBe(seen.poSave);

    sessionSpy.mockRestore(); markSpy.mockRestore();
    rawSpy.mockRestore(); poSpy.mockRestore();
    unitOfWork.__setTransactionSupport(null);
  });
});

/* ═══ 4c · THE CUMULATIVE RETURN HOLE ════════════════════════════════════ */

describe("returns cannot cumulatively exceed what the line received", () => {
  test("two returns below the received quantity still cannot exceed it together", async () => {
    /* Each request was checked against the line's received quantity on its
       own, so a line that received 20 accepted 15 and then another 15 — and
       30 units came off a shelf that only ever got 20. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({
      co: a, stockQty: 100, receivedQty: 20, orderedQty: 20,
    });

    expect((await raiseReturn(po, itemId, store.token, 15)).status).toBe(201);

    const second = await raiseReturn(po, itemId, store.token, 15);
    expect(second.status).toBe(409);
    expect(second.body.error.details.reason).toBe("RETURNABLE_QUANTITY_EXCEEDED");
    expect(second.body.error.details.receivedQuantity).toBe(20);
    expect(second.body.error.details.alreadyReturnedQuantity).toBe(15);
    expect(second.body.error.details.remainingReturnable).toBe(5);

    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(85);   // never 70

    // What is left is still returnable.
    expect((await raiseReturn(po, itemId, store.token, 5)).status).toBe(201);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(80);
    expect((await raiseReturn(po, itemId, store.token, 1)).status).toBe(409);
  });

  test("a cancelled return still consumes the returnable quantity", async () => {
    /* Cancelling does not put the goods back — the deduction stands — so the
       quantity is spent whatever the return's status says. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({
      co: a, stockQty: 100, receivedQty: 20, orderedQty: 20,
    });

    const created = await raiseReturn(po, itemId, store.token, 18);
    const returnId = created.body.returnRequest._id;
    await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(82);   // still deducted

    const after = await raiseReturn(po, itemId, store.token, 18);
    expect(after.status).toBe(409);
    expect(after.body.error.details.alreadyReturnedQuantity).toBe(18);
    expect(after.body.error.details.remainingReturnable).toBe(2);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(82);
  });

  test("a variant that cannot be found is refused, leaving both balances untouched", async () => {
    /* The helper used to fall through to adjusting only the item-level
       balance, so the item and its variants silently disagreed. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const n = ++seq;
    const raw = await RawItem.create({
      name: `Panel ${n}`, sku: `PNL-${n}`, unit: "pcs", quantity: 50, minStock: 0,
      variants: [{ combination: ["Red"], quantity: 20 }],
    });
    const po = await PurchaseOrder.create({
      companyId: a._id, createdBy: new mongoose.Types.ObjectId(),
      poNumber: `PO/2026-27/${String(n).padStart(4, "0")}`,
      vendorName: "V", status: "PARTIALLY_RECEIVED",
      items: [{
        rawItem: raw._id, itemName: raw.name, sku: raw.sku, unit: "pcs",
        quantity: 20, receivedQuantity: 20, pendingQuantity: 0,
        unitPrice: 10, totalPrice: 200,
        /* Names a variant the catalogue no longer holds. */
        variantId: new mongoose.Types.ObjectId(),
        variantCombination: ["Vermilion"],
      }],
      totalReceived: 20, totalPending: 0, totalAmount: 200,
    });

    const res = await raiseReturn(po, String(po.items[0]._id), store.token, 5);
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("VARIANT_NOT_FOUND");

    const after = await RawItem.findById(raw._id).lean();
    expect(after.quantity).toBe(50);                 // item-level untouched
    expect(after.variants[0].quantity).toBe(20);     // and the variant too
    expect(after.stockTransactions || []).toHaveLength(0);
    expect((await PurchaseOrder.findById(po._id).lean()).returnRequests).toHaveLength(0);
  });
});

/* ═══ 5 · HISTORY ════════════════════════════════════════════════════════ */

test("every governed return mutation writes append-only history", async () => {
  const a = await company("Acme");
  const store = await person({ co: a, grant: "store" });
  const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

  const created = await raiseReturn(po, itemId, store.token, 6);
  const returnId = created.body.returnRequest._id;
  await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
    method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 2 },
  });

  const rows = await SpActionHistory.find({ entityId: po._id }).lean();
  const actions = rows.map((r) => r.action);
  expect(actions).toEqual(expect.arrayContaining([
    "SUPPLIER_RETURN_RAISED", "SUPPLIER_RETURN_RECEIVED",
  ]));

  for (const row of rows) {
    expect(String(row.companyId)).toBe(String(a._id));
    expect(row.documentNumber).toBe(po.poNumber);
    expect(row.actorId).toBeTruthy();
    expect(row.at || row.createdAt).toBeTruthy();
  }

  const raised = rows.find((r) => r.action === "SUPPLIER_RETURN_RAISED");
  expect(raised.metadata.damagedQuantity).toBe(6);
  expect(raised.changes[0].from).toBe("100");         // before
  expect(raised.changes[0].to).toBe("94");            // after

  const receivedRow = rows.find((r) => r.action === "SUPPLIER_RETURN_RECEIVED");
  expect(receivedRow.previousState).toBe("PENDING");
  expect(receivedRow.resultingState).toBe("PARTIAL");

  // Append-only, still.
  await expect(SpActionHistory.updateOne({ _id: raised._id }, { $set: { action: "X" } }))
    .rejects.toThrow(/append-only/);
});

/* ═══ 6 · DELIVERY ACCURACY ══════════════════════════════════════════════ */

describe("deliveries report what was recorded, and say what was not", () => {
  test("the list returns no fabricated allocation or value", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await receivedOrder({ co: a, receivedQty: 20, orderedQty: 20 });

    const res = await call("/deliveries", { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.deliveries).toHaveLength(1);

    const d = res.body.deliveries[0];
    expect(d.totalQuantity).toBe(20);                 // the recorded aggregate
    /* Null, not [] and not 0 — an empty list reads as "nothing arrived" and a
       zero reads as "worth nothing", and both are claims nobody made. */
    expect(d.items).toBeNull();
    expect(d.totalValue).toBeNull();
    expect(d.itemAllocationRecorded).toBe(false);
    expect(d.deliveryValueRecorded).toBe(false);

    expect(res.body.stats.totalQuantity).toBe(20);
    expect(res.body.stats.totalValue).toBeNull();
    expect(res.body.stats.deliveryValueRecorded).toBe(false);
  });

  test("the detail view does not claim a per-delivery split of the order's lines", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { deliveryId } = await receivedOrder({ co: a, receivedQty: 20, orderedQty: 20 });

    const res = await call(`/deliveries/${deliveryId}`, { token: store.token });
    expect(res.status).toBe(200);

    const d = res.body.delivery;
    expect(d.totalQuantity).toBe(20);
    expect(d.items).toBeNull();
    expect(d.totalValue).toBeNull();
    expect(d.itemAllocationRecorded).toBe(false);

    /* The order's lines are still served — they are real — but named so they
       cannot be read as this delivery's contents, and with no per-delivery
       quantity invented on them. */
    expect(d.purchaseOrderLines).toHaveLength(1);
    expect(d.purchaseOrderLines[0]).not.toHaveProperty("receivedInThisDelivery");
    expect(d.purchaseOrderLines[0].totalReceived).toBe(20);
  });

  test("statistics count each delivery once, not once per order line", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 20, orderedQty: 20 });
    // A second delivery on the same order.
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $push: { deliveries: { deliveryDate: new Date(), quantityReceived: 5, invoiceNumber: "INV-2" } },
    });

    const res = await call("/deliveries/stats/summary", { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.stats.totalDeliveries).toBe(2);
    expect(res.body.stats.totalQuantity).toBe(25);    // 20 + 5, each counted once
    expect(res.body.stats.totalValue).toBeNull();
    expect(res.body.stats.vendorPerformance[0].totalValue).toBeNull();
  });

  test("the shape the UI renders cannot turn an unknown into a zero", async () => {
    /* The delivery screens read these fields directly. The contract they rely
       on is that "not recorded" arrives as null WITH a flag saying so — a bare
       0 or [] would be rendered as ₹0 and "no items", which is what the old
       API effectively claimed. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { deliveryId } = await receivedOrder({ co: a, receivedQty: 12, orderedQty: 30 });

    const list = await call("/deliveries", { token: store.token });
    const detail = await call(`/deliveries/${deliveryId}`, { token: store.token });

    for (const d of [list.body.deliveries[0], detail.body.delivery]) {
      expect(d.totalValue).toBeNull();
      expect(d.totalValue).not.toBe(0);
      expect(d.items).toBeNull();
      expect(d.items).not.toEqual([]);
      expect(d.deliveryValueRecorded).toBe(false);
      expect(d.itemAllocationRecorded).toBe(false);
      expect(typeof d.note).toBe("string");        // a sentence a person can read
      expect(d.totalQuantity).toBe(12);            // the one real figure
    }
  });

  test("a missing delivery quantity stays null, and a real zero stays zero", async () => {
    /* `quantityReceived` is optional on the stored delivery, and `|| 0` turned
       "never written down" into "0 units received" — a confident claim nobody
       made, indistinguishable from a delivery that genuinely arrived empty. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 12, orderedQty: 30 });

    await PurchaseOrder.updateOne({ _id: po._id }, {
      $push: {
        deliveries: {
          $each: [
            { deliveryDate: new Date(), invoiceNumber: "INV-NOQTY" },   // never recorded
            { deliveryDate: new Date(), invoiceNumber: "INV-ZERO", quantityReceived: 0 },
          ],
        },
      },
    });

    const list = await call("/deliveries", { token: store.token });
    const byInvoice = Object.fromEntries(list.body.deliveries.map((d) => [d.invoiceNumber, d]));

    expect(byInvoice["INV-NOQTY"].totalQuantity).toBeNull();
    expect(byInvoice["INV-NOQTY"].totalQuantity).not.toBe(0);
    expect(byInvoice["INV-NOQTY"].deliveryQuantityRecorded).toBe(false);

    /* A delivery that really arrived empty is a fact, and 0 is the right answer. */
    expect(byInvoice["INV-ZERO"].totalQuantity).toBe(0);
    expect(byInvoice["INV-ZERO"].deliveryQuantityRecorded).toBe(true);

    /* The aggregate cannot be complete while one delivery is unrecorded — a
       total that quietly skipped it would read as complete and be short. */
    expect(list.body.stats.totalQuantity).toBeNull();
    expect(list.body.stats.deliveryQuantityRecorded).toBe(false);
    expect(list.body.stats.quantityMissingFor).toBe(1);
    expect(list.body.stats.quantityRecordedFor).toBe(2);

    const stats = await call("/deliveries/stats/summary", { token: store.token });
    expect(stats.body.stats.totalQuantity).toBeNull();
    expect(stats.body.stats.quantityMissingFor).toBe(1);
    expect(stats.body.stats.vendorPerformance[0].totalQuantity).toBeNull();
  });

  test("date and invoice filters select deliveries, not their siblings", async () => {
    /* The Mongo filter selects ORDERS — one matching delivery pulls in the
       whole order — so flattening without re-checking returned deliveries the
       caller never asked about. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 5, orderedQty: 30 });
    const old = new Date("2026-01-10T00:00:00.000Z");
    const recent = new Date("2026-08-20T00:00:00.000Z");

    // Mongo refuses $set and $push on one path in a single update.
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: { "deliveries.0.deliveryDate": old, "deliveries.0.invoiceNumber": "INV-OLD" },
    });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $push: { deliveries: { deliveryDate: recent, quantityReceived: 7, invoiceNumber: "INV-NEW" } },
    });

    const byDate = await call(
      "/deliveries?startDate=2026-08-01&endDate=2026-08-31", { token: store.token },
    );
    expect(byDate.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-NEW"]);

    const byInvoice = await call("/deliveries?search=INV-NEW", { token: store.token });
    expect(byInvoice.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-NEW"]);

    /* An order matched on its OWN fields legitimately brings every delivery. */
    const byPo = await call(`/deliveries?search=${encodeURIComponent(po.poNumber)}`, { token: store.token });
    expect(byPo.body.deliveries.map((d) => d.invoiceNumber).sort()).toEqual(["INV-NEW", "INV-OLD"]);
  });

  test("the pending-PO route is reachable and not shadowed by /:id", async () => {
    /* `/:id` was registered first, so "data" was read as a delivery id and the
       request died casting it. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await receivedOrder({ co: a, orderedQty: 50, receivedQty: 10 });

    const res = await call("/deliveries/data/pending-pos", { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders).toHaveLength(1);
    expect(res.body.purchaseOrders[0].totalPending).toBe(40);
  });
});
