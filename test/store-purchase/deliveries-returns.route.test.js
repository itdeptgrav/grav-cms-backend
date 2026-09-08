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
/* The contested-boundary seam. See the note beside `at()` in the router. */
const returnHooks = require("../../routes/CMS_Routes/Inventory/Operations/returnRequests").__hooks;

/**
 * Hold a request at a boundary until the test says otherwise.
 *
 * `reached` rejects rather than hanging if the request never gets there — a
 * boundary that stops being reached is a real change in the code under test,
 * and a two-minute timeout tells you far less than a failed assertion does.
 */
const openGates = [];

function gate(name = "boundary", timeoutMs = 5000) {
  let release;
  const opened = new Promise((r) => { release = r; });
  let arrived, missed;
  const reached = new Promise((resolve, reject) => { arrived = resolve; missed = reject; });
  const timer = setTimeout(
    () => missed(new Error(`the request never reached "${name}"`)),
    timeoutMs,
  );
  const g = {
    hook: async (ctx) => { clearTimeout(timer); arrived(ctx); await opened; },
    reached,
    open: () => { clearTimeout(timer); release(); },
  };
  /* Released in afterEach whatever happens. An assertion failing between
     `reached` and `open()` would otherwise leave a request parked inside the
     router forever, and the suite would hang at teardown instead of reporting
     the assertion that actually failed. */
  openGates.push(g);
  return g;
}

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
  /* A hook left registered would hang the next test at a boundary it never
     expected to stop at. */
  for (const key of Object.keys(returnHooks)) delete returnHooks[key];
  while (openGates.length) openGates.pop().open();
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
    /* The order records the return first — that is how it wins a race against
       a simultaneous one — and the STOCK write then fails. Both orderings leave
       the two halves disagreeing; this is the one the code can now produce.
       The compensating pull is disabled so the interrupted state survives. */
    const spy = jest.spyOn(RawItem, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("stock write failed"));
    /* Leave the interrupted state standing so the reconciliation path is what
       the retry meets. */
    returnHooks["returnCreate:beforeCompensate"] = (ctx) => { ctx.skip = true; };
    const failed = await raiseReturn(po, itemId, store.token, 7, key);
    expect(failed.status).toBe(500);
    spy.mockRestore();

    const afterFailure = (await RawItem.findById(raw._id).lean()).quantity;
    expect(afterFailure).toBe(100);                   // the stock did NOT move

    const retry = await raiseReturn(po, itemId, store.token, 7, key);
    /* The order recorded a return the stock never backed. The honest,
       non-transactional answer: refuse, name the state, ask for a human —
       and above all do not now deduct, which would make the record true by
       moving stock a person never authorised twice. */
    expect(retry.status).toBe(409);
    expect(retry.body.error.details.reason).toBe("PARTIAL_RETURN_NEEDS_RECONCILIATION");

    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);
    expect((await RawItem.findById(raw._id).lean()).stockTransactions || []).toHaveLength(0);
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
    /* One refusal for one condition. This used to arrive as a bare 400 from a
       pre-check or as this structured conflict from the atomic gate, depending
       on timing; the pre-check is gone and the gate decides every time. */
    expect(res.status).toBe(409);
    expect(res.body.error.details.reason).toBe("PENDING_RETURN_QUANTITY_EXCEEDED");
    expect(res.body.error.details.pendingReturnQty).toBe(4);
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

  test("a cancellation returns the return request, not a Mongoose subdocument", async () => {
    /* ── WHAT A CORRECT STATUS WAS HIDING ────────────────────────────────────
     * The response was built by spreading the pre-image row: `{ ...beforeRow,
     * status: "CANCELLED" }`. `beforeRow` is a Mongoose array subdocument, and
     * spreading one does not give you its fields — it gives you the machinery
     * around them. `_doc`, `$__`, `$__parent` and `__parentArray` come out;
     * `_id`, `poItemId`, `damagedQuantity` and `reason` stay buried inside
     * `_doc` where no caller looks.
     *
     * Every existing test asserted `status`, which is the one field the spread
     * did put at the top level, because it was assigned afterwards. So the
     * response was malformed and the suite was satisfied. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 7);
    const returnId = created.body.returnRequest._id;

    /* A partial replacement first, so the returned figures are ones a caller
       could actually get wrong rather than all zeroes. */
    await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { quantityReceived: 3 },
    });

    const key = newKey();
    const res = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: key,
      body: { reason: "Vendor cannot supply" },
    });

    expect(res.status).toBe(200);
    const body = res.body.returnRequest;

    expect(body.status).toBe("CANCELLED");
    expect(String(body._id)).toBe(String(returnId));
    /* The business fields a screen actually renders. */
    expect(String(body.poItemId)).toBe(String(itemId));
    expect(body.damagedQuantity).toBe(7);
    expect(body.returnedQuantity).toBe(3);
    expect(body.pendingReturnQty).toBe(4);
    expect(body.reason).toBe("Bent on arrival");
    expect(body.itemName).toBeTruthy();

    /* And none of the machinery. */
    for (const internal of ["_doc", "$__", "$__parent", "__parentArray"]) {
      expect(body).not.toHaveProperty(internal);
    }

    /* A replay of the same key must hand back the same well-formed thing —
       it is served from the stored response, so a malformed original would be
       preserved and returned for as long as the record lives. */
    const replay = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: key,
      body: { reason: "Vendor cannot supply" },
    });
    expect(replay.status).toBe(200);
    expect(replay.replayed).toBe(true);
    const replayed = replay.body.returnRequest;
    expect(replayed.status).toBe("CANCELLED");
    expect(String(replayed._id)).toBe(String(returnId));
    expect(replayed.damagedQuantity).toBe(7);
    expect(replayed.pendingReturnQty).toBe(4);
    for (const internal of ["_doc", "$__", "$__parent", "__parentArray"]) {
      expect(replayed).not.toHaveProperty(internal);
    }

    /* The already-cancelled path answers a DIFFERENT key and takes a
       different branch — it hands back the loaded document rather than
       building an object, so it serialises through toJSON and was never
       affected. Asserted anyway, because "a different code path returns the
       same shape" is exactly the kind of thing that quietly stops being true. */
    const second = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(second.status).toBe(200);
    expect(second.body.returnRequest.status).toBe("CANCELLED");
    expect(String(second.body.returnRequest._id)).toBe(String(returnId));
    expect(second.body.returnRequest.damagedQuantity).toBe(7);
    for (const internal of ["_doc", "$__", "$__parent", "__parentArray"]) {
      expect(second.body.returnRequest).not.toHaveProperty(internal);
    }

    /* One real closure, whatever the responses looked like. */
    expect(await SpActionHistory.countDocuments({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCELLED",
    })).toBe(1);
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
    const spy = jest.spyOn(RawItem, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("stock write failed"));
    /* Leave the interrupted state standing so the reconciliation path is what
       the retry meets. */
    returnHooks["returnCreate:beforeCompensate"] = (ctx) => { ctx.skip = true; };
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
    /* The interrupted attempt's own row is there and unbacked; the first
       return is untouched, and no second deduction happened. */
    expect(String(stored.returnRequests[0]._id)).toBe(String(firstId));
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(95);   // only the first 5
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
    const spy = jest.spyOn(RawItem, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("stock write failed"));
    /* Leave the interrupted state standing so the reconciliation path is what
       the retry meets. */
    returnHooks["receipt:beforeCompensate"] = (ctx) => { ctx.skip = true; };
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
    /* The interrupted attempt's receipt is recorded and unbacked by stock; the
       first receipt is untouched and no second credit happened. */
    expect(stored.returnRequests[0].receipts.map((r) => r.quantityReceived)).toEqual([4, 3]);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(94);   // 100 − 10 + 4 only
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
    /* Where the deployment supports transactions, the order write, the RawItem
       write, the history entry and the effect marker share one session and
       commit together. mongodb-memory-server here is standalone, so the
       session is asserted at the seam rather than by committing one.

       The order is written through findOneAndUpdate now — that is what makes
       two simultaneous returns safe — so the session reaches it as a query
       option rather than as save() options. Both are checked. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const querySessions = [];
    const sessionSpy2 = jest.spyOn(mongoose.Query.prototype, "session")
      .mockImplementation(function (s) { querySessions.push(s); this.options.session = s; return this; });

    let rawItemSession;
    const realRawUpdate = RawItem.findOneAndUpdate.bind(RawItem);
    const rawSpy = jest.spyOn(RawItem, "findOneAndUpdate")
      .mockImplementation((...args) => {
        const query = realRawUpdate(...args);
        const setSession = query.session.bind(query);
        query.session = (sess) => { rawItemSession = sess; return setSession(sess); };
        return query;
      });

    let markerSession;
    const idem = require("../../services/storePurchase/idempotency.service");
    const markSpy = jest.spyOn(idem, "markEffectApplied")
      .mockImplementation(async (args) => { markerSession = args.session ?? null; });

    /* Force the transactional branch, with a REAL session so the queries the
       route runs are ones the driver accepts. Only the commit is skipped —
       this deployment is standalone — and what is under test is that one
       session reaches every write. */
    unitOfWork.__setTransactionSupport(true);
    const realStartSession = mongoose.startSession.bind(mongoose);
    const sessionSpy = jest.spyOn(mongoose, "startSession").mockImplementation(async () => {
      const session = await realStartSession();
      session.withTransaction = async (fn) => fn(session);
      return session;
    });

    await raiseReturn(po, itemId, store.token, 2);

    /* The order write got a session, the stock write got a session, the effect
       marker got a session — and all three are the SAME one. */
    expect(querySessions.length).toBeGreaterThan(0);
    const orderSession = querySessions.find(Boolean);
    expect(orderSession).toBeTruthy();
    expect(rawItemSession).toBe(orderSession);
    expect(markerSession).toBe(orderSession);

    sessionSpy.mockRestore(); sessionSpy2.mockRestore();
    markSpy.mockRestore(); rawSpy.mockRestore();
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

/* ═══ 4d · SIMULTANEOUS RETURNS AND RECEIPTS ═════════════════════════════ */

describe("two people acting at the same moment", () => {
  test("simultaneous returns under distinct keys cannot together exceed the line", async () => {
    /* Not an idempotency problem: two different actions, each individually
       legitimate, each with its own key. Both read "20 received, none
       returned", both concluded 15 was fine. The database now decides, in the
       same operation that writes, so exactly one wins. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({
      co: a, stockQty: 100, receivedQty: 20, orderedQty: 20,
    });

    const [first, second] = await Promise.all([
      raiseReturn(po, itemId, store.token, 15, newKey()),
      raiseReturn(po, itemId, store.token, 15, newKey()),
    ]);

    const codes = [first.status, second.status].sort();
    expect(codes).toEqual([201, 409]);

    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.details.reason).toBe("RETURNABLE_QUANTITY_EXCEEDED");

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(1);
    /* One deduction, and the shelf is short by exactly what one return took. */
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(85);
    expect((await RawItem.findById(raw._id).lean()).stockTransactions).toHaveLength(1);
  });

  test("a burst of concurrent returns settles at exactly the received quantity", async () => {
    /* Six simultaneous 5-unit returns against a line that received 20: four
       may land, two must not, and the arithmetic has to come out exactly. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({
      co: a, stockQty: 100, receivedQty: 20, orderedQty: 20,
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => raiseReturn(po, itemId, store.token, 5, newKey())),
    );
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 409);

    expect(created).toHaveLength(4);
    expect(refused).toHaveLength(2);

    const stored = await PurchaseOrder.findById(po._id).lean();
    const totalReturned = stored.returnRequests.reduce((sum, r) => sum + r.damagedQuantity, 0);
    expect(totalReturned).toBe(20);                  // never more than arrived
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(80);
  });

  test("simultaneous replacement receipts cannot together exceed what is owed", async () => {
    /* Two receipts of 6 against 10 owed would both have passed the old
       read-then-check and credited 12 for a vendor who sent 6. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;

    const receive = (qty) => call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { quantityReceived: qty },
    });
    const [first, second] = await Promise.all([receive(6), receive(6)]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const loser = first.status === 409 ? first : second;
    expect(loser.body.error.details.reason).toBe("PENDING_RETURN_QUANTITY_EXCEEDED");

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests[0].returnedQuantity).toBe(6);
    expect(stored.returnRequests[0].pendingReturnQty).toBe(4);
    expect(stored.returnRequests[0].receipts).toHaveLength(1);
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(96);   // 100 − 10 + 6
  });

  test("concurrent receipts settle the return exactly once", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 9);
    const returnId = created.body.returnRequest._id;

    const receive = (qty) => call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { quantityReceived: qty },
    });
    const results = await Promise.all([receive(3), receive(3), receive(3), receive(3)]);

    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests[0].returnedQuantity).toBe(9);
    expect(stored.returnRequests[0].pendingReturnQty).toBe(0);
    expect(stored.returnRequests[0].status).toBe("COMPLETED");
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(100);
  });

  test("a return and a receipt racing on the same line each stay correct", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 8);
    const returnId = created.body.returnRequest._id;

    const [raised, received] = await Promise.all([
      raiseReturn(po, itemId, store.token, 6, newKey()),
      call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { quantityReceived: 8 },
      }),
    ]);

    expect(raised.status).toBe(201);      // 8 + 6 ≤ 20
    expect(received.status).toBe(200);
    // 100 − 8 (first return) − 6 (second) + 8 (replacement)
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(94);
  });
});

/* ═══ 4e · CONTROLLED INTERLEAVINGS ══════════════════════════════════════ */

describe("interleavings the test dictates, not hopes for", () => {
  /* Every case below holds one request at a named boundary inside the router,
     drives the other to completion, and only then releases the first. That is
     the difference between proving a guard works and watching two requests
     that never actually overlapped. */

  test("two over-returns on one line: the loser is refused at the gate", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({
      co: a, stockQty: 100, receivedQty: 20, orderedQty: 20,
    });

    /* A is held after winning the room and before taking the stock. */
    const held = gate("returnCreate:beforeStock");
    returnHooks["returnCreate:beforeStock"] = held.hook;

    const aPromise = raiseReturn(po, itemId, store.token, 15, newKey());
    await held.reached;                       // A is parked, room claimed

    delete returnHooks["returnCreate:beforeStock"];
    const b = await raiseReturn(po, itemId, store.token, 15, newKey());
    /* B ran entirely while A sat at the boundary — the collision is certain. */
    expect(b.status).toBe(409);
    expect(b.body.error.details.reason).toBe("RETURNABLE_QUANTITY_EXCEEDED");
    expect(b.body.error.details.remainingReturnable).toBe(5);

    held.open();
    expect((await aPromise).status).toBe(201);

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(1);
    expect(stored.returnRequests[0].damagedQuantity).toBe(15);
    const item = await RawItem.findById(raw._id).lean();
    expect(item.quantity).toBe(85);
    expect(item.stockTransactions).toHaveLength(1);
  });

  test("simultaneous returns against DIFFERENT lines are both retained", async () => {
    /* The guard must be per line, not per order — two lines are two budgets. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const n = ++seq;
    const rawA = await RawItem.create({ name: `L1 ${n}`, sku: `L1-${n}`, unit: "pcs", quantity: 50, minStock: 0 });
    const rawB = await RawItem.create({ name: `L2 ${n}`, sku: `L2-${n}`, unit: "pcs", quantity: 50, minStock: 0 });
    const po = await PurchaseOrder.create({
      companyId: a._id, createdBy: new mongoose.Types.ObjectId(),
      poNumber: `PO/2026-27/${String(n).padStart(4, "0")}`,
      vendorName: "V", status: "PARTIALLY_RECEIVED",
      items: [
        { rawItem: rawA._id, itemName: rawA.name, sku: rawA.sku, unit: "pcs", quantity: 10, receivedQuantity: 10, pendingQuantity: 0, unitPrice: 1, totalPrice: 10 },
        { rawItem: rawB._id, itemName: rawB.name, sku: rawB.sku, unit: "pcs", quantity: 10, receivedQuantity: 10, pendingQuantity: 0, unitPrice: 1, totalPrice: 10 },
      ],
      totalReceived: 20, totalPending: 0, totalAmount: 20,
    });

    const held = gate("returnCreate:beforeStock");
    returnHooks["returnCreate:beforeStock"] = held.hook;
    const first = raiseReturn(po, String(po.items[0]._id), store.token, 8, newKey());
    await held.reached;

    delete returnHooks["returnCreate:beforeStock"];
    const second = await raiseReturn(po, String(po.items[1]._id), store.token, 8, newKey());
    expect(second.status).toBe(201);

    held.open();
    expect((await first).status).toBe(201);

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(2);      // neither lost
    expect((await RawItem.findById(rawA._id).lean()).quantity).toBe(42);
    expect((await RawItem.findById(rawB._id).lean()).quantity).toBe(42);
  });

  test("two over-receipts on one return: the loser is refused at the gate", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;

    const receive = (qty) => call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { quantityReceived: qty },
    });

    const held = gate("receipt:beforeStock");
    returnHooks["receipt:beforeStock"] = held.hook;
    const first = receive(6);
    await held.reached;                       // A holds 6 of the 10 owed

    delete returnHooks["receipt:beforeStock"];
    const second = await receive(6);
    expect(second.status).toBe(409);
    expect(second.body.error.details.reason).toBe("PENDING_RETURN_QUANTITY_EXCEEDED");
    expect(second.body.error.details.pendingReturnQty).toBe(4);

    held.open();
    expect((await first).status).toBe(200);

    const stored = await PurchaseOrder.findById(po._id).lean();
    const ret = stored.returnRequests[0];
    expect(ret.receipts).toHaveLength(1);
    expect(ret.returnedQuantity).toBe(6);
    expect(ret.pendingReturnQty).toBe(4);
    expect(ret.status).toBe("PARTIAL");
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(96);
  });

  test("a compensating rollback does not undo a receipt that succeeded meanwhile", async () => {
    /* The case the old rollback got wrong. Receipt A records, then fails to
       credit stock. Receipt B completes the return. A's compensation then runs
       — and must remove only A, reverse only A's quantity, and leave the
       status derived from what is actually left rather than restoring the
       "PENDING" A captured before any of this. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(90);

    const receive = (qty) => call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { quantityReceived: qty },
    });

    // ── 1 · A records its receipt, then its stock credit fails.
    const atCompensate = gate("receipt:beforeCompensate");
    returnHooks["receipt:beforeCompensate"] = atCompensate.hook;
    const stockSpy = jest.spyOn(RawItem, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("stock write failed"));

    const aPromise = receive(3);
    await atCompensate.reached;               // A is parked, its receipt written
    stockSpy.mockRestore();

    // ── 2 · B records AND credits the full remainder while A waits.
    delete returnHooks["receipt:beforeCompensate"];
    const b = await receive(7);                 // A already booked 3 of the 10
    expect(b.status).toBe(200);
    expect(b.body.returnRequest.status).toBe("COMPLETED");

    // ── 3 · A's compensation runs.
    atCompensate.open();
    expect((await aPromise).status).toBe(500);

    // ── 4 · The exact state.
    const stored = await PurchaseOrder.findById(po._id).lean();
    const ret = stored.returnRequests[0];
    expect(ret.receipts).toHaveLength(1);                        // only B's
    expect(ret.receipts[0].quantityReceived).toBe(7);
    expect(ret.returnedQuantity).toBe(7);                        // A's 3 reversed
    expect(ret.pendingReturnQty).toBe(3);
    /* Derived from the quantities that remain. The old rollback wrote back the
       "PENDING" A captured before any of this — on a return that has since
       taken a real receipt, which is neither pending nor complete. */
    expect(ret.status).toBe("PARTIAL");

    const item = await RawItem.findById(raw._id).lean();
    expect(item.quantity).toBe(97);                              // 100 − 10 + 7
    /* One deduction and one credit. A's failed credit left no ledger line. */
    expect(item.stockTransactions).toHaveLength(2);
    expect(item.stockTransactions.map((t) => t.quantity)).toEqual([10, 7]);
    expect(item.stockTransactions.map((t) => t.newQuantity)).toEqual([90, 97]);
  });

  test("a rollback does not reopen a return that was cancelled meanwhile", async () => {
    /* Compensation derived the status from quantities in every case, so
       removing a failed receipt from a CANCELLED return computed PENDING or
       PARTIAL and quietly reopened it — one receipt's rollback overturning a
       closure decision it has nothing to do with. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(90);

    // ── 1 · Receipt A records atomically, then parks before compensating.
    const atCompensate = gate("receipt:beforeCompensate");
    returnHooks["receipt:beforeCompensate"] = atCompensate.hook;
    const stockSpy = jest.spyOn(RawItem, "findOneAndUpdate")
      .mockRejectedValueOnce(new Error("stock write failed"));

    const aPromise = call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { quantityReceived: 4 },
    });
    await atCompensate.reached;               // A's receipt is written; it waits
    stockSpy.mockRestore();

    // ── 2 · The return is cancelled while A waits.
    delete returnHooks["receipt:beforeCompensate"];
    const cancelled = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(cancelled.status).toBe(200);

    // ── 3 · A's stock credit has failed; ── 4 · its compensation now runs.
    atCompensate.open();
    expect((await aPromise).status).toBe(500);

    // ── The exact state.
    const stored = await PurchaseOrder.findById(po._id).lean();
    const ret = stored.returnRequests[0];
    expect(ret.receipts).toHaveLength(0);          // A's receipt removed
    expect(ret.returnedQuantity).toBe(0);          // and its quantity reversed
    expect(ret.pendingReturnQty).toBe(10);
    /* The decision stands. Derived-from-quantities would have said PENDING. */
    expect(ret.status).toBe("CANCELLED");

    const item = await RawItem.findById(raw._id).lean();
    expect(item.quantity).toBe(90);                // only the original deduction
    expect(item.stockTransactions).toHaveLength(1);
    expect(item.stockTransactions[0].quantity).toBe(10);
  });

  test("cancel before receipt: the later receipt is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;

    const cancelled = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(cancelled.status).toBe(200);

    const late = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 4 },
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("INVALID_TRANSITION");
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(90);   // no credit
  });

  test("a cancellation lands on the return it named, not on an array position", async () => {
    /* ── WHAT THE STALE SAVE ACTUALLY DID ────────────────────────────────────
     * Mutating a loaded subdocument and calling `po.save()` does not overwrite
     * the document — Mongoose emits `$set: {"returnRequests.0.status": …}`.
     * That is worse than it looks: the path is an ARRAY INDEX, resolved when
     * the order was read. If anything removes an earlier return in between —
     * the create path's own compensation does exactly that — every later
     * return shifts down one, and the write lands on a different return or on
     * nothing at all, while the route reports success either way.
     *
     * Here the cancellation names the SECOND return, an earlier one is removed
     * while it waits, and the right return must still end up cancelled. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });

    const first = await raiseReturn(po, itemId, store.token, 4);
    const second = await raiseReturn(po, itemId, store.token, 5);
    expect(second.status).toBe(201);
    const targetId = second.body.returnRequest._id;

    const held = gate("cancel:beforeWrite");
    returnHooks["cancel:beforeWrite"] = held.hook;
    const cancelPromise = call(`/purchase-orders/${po._id}/returns/${targetId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    await held.reached;                    // read the target at index 1

    /* The earlier return goes away — the same `$pull` the create path uses to
       compensate a return whose stock never moved. */
    await PurchaseOrder.updateOne(
      { _id: po._id },
      { $pull: { returnRequests: { _id: new mongoose.Types.ObjectId(first.body.returnRequest._id) } } },
    );

    held.open();
    expect((await cancelPromise).status).toBe(200);

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests).toHaveLength(1);
    /* The one that remains is the one that was named, and it is cancelled.
       Writing by index would have addressed a position that no longer exists. */
    expect(String(stored.returnRequests[0]._id)).toBe(String(targetId));
    expect(stored.returnRequests[0].status).toBe("CANCELLED");
    expect(stored.returnRequests[0].damagedQuantity).toBe(5);
  });

  test("receipt before cancel: the partial receipt survives the cancellation", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId, raw } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;

    /* Cancel is held after it loaded the order and before it writes. */
    const held = gate("cancel:beforeWrite");
    returnHooks["cancel:beforeWrite"] = held.hook;
    const cancelPromise = call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    await held.reached;

    delete returnHooks["cancel:beforeWrite"];
    const receipt = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 4 },
    });
    expect(receipt.status).toBe(200);

    held.open();
    const cancelled = await cancelPromise;
    expect(cancelled.status).toBe(200);

    const stored = await PurchaseOrder.findById(po._id).lean();
    const ret = stored.returnRequests[0];
    /* The receipt is still there. Under the old save it vanished. */
    expect(ret.receipts).toHaveLength(1);
    expect(ret.receipts[0].quantityReceived).toBe(4);
    expect(ret.returnedQuantity).toBe(4);
    expect(ret.pendingReturnQty).toBe(6);
    expect(ret.status).toBe("CANCELLED");

    const item = await RawItem.findById(raw._id).lean();
    expect(item.quantity).toBe(94);                    // 100 − 10 + 4
    expect(item.stockTransactions).toHaveLength(2);
  });

  test("a completed return cannot be cancelled, even from a stale read", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 5);
    const returnId = created.body.returnRequest._id;

    const held = gate("cancel:beforeWrite");
    returnHooks["cancel:beforeWrite"] = held.hook;
    const cancelPromise = call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    await held.reached;                       // cancel read it as PENDING

    delete returnHooks["cancel:beforeWrite"];
    await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 5 },
    });

    held.open();
    const cancelled = await cancelPromise;
    /* It read PENDING and must still refuse, because the document says
       COMPLETED by the time it writes. */
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.error.code).toBe("INVALID_TRANSITION");

    const stored = await PurchaseOrder.findById(po._id).lean();
    expect(stored.returnRequests[0].status).toBe("COMPLETED");
    expect(stored.returnRequests[0].receipts).toHaveLength(1);
  });

  test("concurrent variant movements leave one continuous ledger chain", async () => {
    /* The variant before/after values were taken from a snapshot read before
       the update, so two concurrent movements both claimed the same "before". */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const n = ++seq;
    const raw = await RawItem.create({
      name: `Panel ${n}`, sku: `PNL-${n}`, unit: "pcs", quantity: 50, minStock: 0,
      variants: [{ combination: ["Red"], quantity: 30 }],
    });
    const fresh = await RawItem.findById(raw._id).lean();
    const variantId = fresh.variants[0]._id;

    const po = await PurchaseOrder.create({
      companyId: a._id, createdBy: new mongoose.Types.ObjectId(),
      poNumber: `PO/2026-27/${String(n).padStart(4, "0")}`,
      vendorName: "V", status: "PARTIALLY_RECEIVED",
      items: [{
        rawItem: raw._id, itemName: raw.name, sku: raw.sku, unit: "pcs",
        quantity: 20, receivedQuantity: 20, pendingQuantity: 0,
        unitPrice: 1, totalPrice: 20,
        variantId, variantCombination: ["Red"],
      }],
      totalReceived: 20, totalPending: 0, totalAmount: 20,
    });
    const poItemId = String(po.items[0]._id);

    /* Parked INSIDE the stock helper, after it has read the item and resolved
       the variant, before it writes. That is what makes the snapshot stale:
       A holds a variant quantity of 30 while B moves it to 23. Parking before
       moveStock instead would let each request read fresh, and the stale-value
       bug would not appear at all. */
    const held = gate("stock:beforeWrite");
    returnHooks["stock:beforeWrite"] = held.hook;
    const first = raiseReturn(po, poItemId, store.token, 6, newKey());
    await held.reached;

    delete returnHooks["stock:beforeWrite"];
    const second = await raiseReturn(po, poItemId, store.token, 7, newKey());
    expect(second.status).toBe(201);

    held.open();
    expect((await first).status).toBe(201);

    const item = await RawItem.findById(raw._id).lean();
    expect(item.quantity).toBe(37);                     // 50 − 7 − 6
    expect(item.variants[0].quantity).toBe(17);         // 30 − 7 − 6

    /* The chain: each line's `previous` is the one before it, at BOTH levels,
       with no two lines claiming the same starting point. */
    const ledger = item.stockTransactions;
    expect(ledger).toHaveLength(2);
    expect(ledger[0].previousQuantity).toBe(50);
    expect(ledger[0].newQuantity).toBe(ledger[1].previousQuantity);
    expect(ledger[1].newQuantity).toBe(37);
    expect(ledger[0].variantPreviousQuantity).toBe(30);
    expect(ledger[0].variantNewQuantity).toBe(ledger[1].variantPreviousQuantity);
    expect(ledger[1].variantNewQuantity).toBe(17);

    /* And every line is timestamped — a pipeline update runs no Mongoose
       timestamps, so these had to be written explicitly. */
    for (const line of ledger) {
      expect(line.createdAt instanceof Date).toBe(true);
      expect(Number.isNaN(new Date(line.createdAt).getTime())).toBe(false);
      expect(line.updatedAt instanceof Date).toBe(true);
    }
  });
});

/* ═══ 4f · WHAT THE AUDIT TRAIL SAYS HAPPENED ════════════════════════════ */

describe("cancellation history records the transition the database made", () => {
  test("a receipt before the cancellation makes it PARTIAL → CANCELLED", async () => {
    /* History took `previousState` from the read at the start of the request.
       A replacement arriving in between moved the return to PARTIAL, and the
       trail then claimed PENDING → CANCELLED — a transition that never
       happened, in the one record meant to be authoritative about it. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 10);
    const returnId = created.body.returnRequest._id;

    const held = gate("cancel:beforeWrite");
    returnHooks["cancel:beforeWrite"] = held.hook;
    const cancelPromise = call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    await held.reached;                       // read it as PENDING

    delete returnHooks["cancel:beforeWrite"];
    const receipt = await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 4 },
    });
    expect(receipt.status).toBe(200);          // the return is now PARTIAL

    held.open();
    expect((await cancelPromise).status).toBe(200);

    const entry = await SpActionHistory.findOne({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCELLED",
    }).lean();
    expect(entry.previousState).toBe("PARTIAL");
    expect(entry.resultingState).toBe("CANCELLED");
  });

  test("an ordinary cancellation records PENDING → CANCELLED", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 6);

    await call(`/purchase-orders/${po._id}/returns/${created.body.returnRequest._id}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });

    const entry = await SpActionHistory.findOne({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCELLED",
    }).lean();
    expect(entry.previousState).toBe("PENDING");
    expect(entry.resultingState).toBe("CANCELLED");
  });

  test("a refused cancellation writes no cancellation history", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 5);
    const returnId = created.body.returnRequest._id;
    await call(`/purchase-orders/${po._id}/returns/${returnId}/receive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { quantityReceived: 5 },
    });

    const refused = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(refused.status).toBe(409);

    /* Nothing happened, so nothing is recorded as having happened. */
    expect(await SpActionHistory.countDocuments({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCELLED",
    })).toBe(0);
    expect(await SpActionHistory.countDocuments({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCEL_NOOP",
    })).toBe(0);
  });

  test("a cancellation that lost the race is recorded as a no-op, not a closure", async () => {
    /* Two cancellations, one return. Only one of them closed it, and the trail
       has to be able to say which — a second CANCELLED entry would read as a
       return that was closed twice. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po, itemId } = await receivedOrder({ co: a, stockQty: 100, receivedQty: 20 });
    const created = await raiseReturn(po, itemId, store.token, 6);
    const returnId = created.body.returnRequest._id;

    const held = gate("cancel:beforeWrite");
    returnHooks["cancel:beforeWrite"] = held.hook;
    const loser = call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    await held.reached;

    delete returnHooks["cancel:beforeWrite"];
    const winner = await call(`/purchase-orders/${po._id}/returns/${returnId}/cancel`, {
      method: "PATCH", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(winner.status).toBe(200);

    held.open();
    expect((await loser).status).toBe(200);   // it wanted this outcome; it has it

    /* Exactly one real closure. */
    const closures = await SpActionHistory.find({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCELLED",
    }).lean();
    expect(closures).toHaveLength(1);
    expect(closures[0].previousState).toBe("PENDING");

    /* The attempt that changed nothing is kept, distinctly, with equal states
       so it cannot be read as a transition. */
    const noop = await SpActionHistory.findOne({
      entityId: po._id, action: "SUPPLIER_RETURN_CANCEL_NOOP",
    }).lean();
    expect(noop).toBeTruthy();
    expect(noop.previousState).toBe("CANCELLED");
    expect(noop.resultingState).toBe("CANCELLED");
    expect(noop.metadata.alreadyCancelled).toBe(true);
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

  test("search text is escaped before it reaches the database", async () => {
    /* It went into `$regex` raw. `(` was a 500, `.*` matched the whole company,
       and `(a+)+$` is the classic catastrophic-backtracking string. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 4, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: { "deliveries.0.invoiceNumber": "INV-A(1)" },
    });

    // A metacharacter is a character, not syntax: it neither 500s nor matches all.
    /* Escaped, a metacharacter is just a character. `(` therefore MATCHES,
       because the invoice really does contain one — that is the escaping
       working, not failing. The rest are literals that appear nowhere. */
    for (const probe of ["INV-A(1)", "("]) {
      const res = await call(`/deliveries?search=${encodeURIComponent(probe)}`, { token: store.token });
      expect(res.status).toBe(200);
      expect(res.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-A(1)"]);
    }

    for (const probe of [".*", "(a+)+$", "[", "\\", "^", ".+"]) {
      const res = await call(`/deliveries?search=${encodeURIComponent(probe)}`, { token: store.token });
      /* Unescaped, `[` and `(a+)+$` were a 500 and `.*` matched the company's
         whole order book. As literals they match nothing. */
      expect(res.status).toBe(200);
      expect(res.body.deliveries).toHaveLength(0);
    }
  });

  test("a date-only endDate covers the whole of that day", async () => {
    /* `2026-08-31` parsed to midnight, so `$lte` excluded every delivery that
       arrived during the day the person asked for. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 3, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: {
        "deliveries.0.deliveryDate": new Date("2026-08-31T17:45:00.000Z"),
        "deliveries.0.invoiceNumber": "INV-LATE",
      },
    });

    const res = await call(
      "/deliveries?startDate=2026-08-01&endDate=2026-08-31", { token: store.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-LATE"]);
  });

  test("an explicit time on endDate is honoured exactly", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 3, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: { "deliveries.0.deliveryDate": new Date("2026-08-31T17:45:00.000Z") },
    });

    /* Somebody who wrote a time meant it. */
    const before = await call(
      "/deliveries?endDate=2026-08-31T12:00:00.000Z", { token: store.token },
    );
    expect(before.body.deliveries).toHaveLength(0);

    const after = await call(
      "/deliveries?endDate=2026-08-31T18:00:00.000Z", { token: store.token },
    );
    expect(after.body.deliveries).toHaveLength(1);
  });

  test("an unparseable or backwards date range is refused, not answered as empty", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await receivedOrder({ co: a, receivedQty: 3, orderedQty: 10 });

    const bad = await call("/deliveries?startDate=last%20tuesday", { token: store.token });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("VALIDATION");
    expect(bad.body.error.details.field).toBe("startDate");

    const badEnd = await call("/deliveries?endDate=2026-13-45", { token: store.token });
    expect(badEnd.status).toBe(400);
    expect(badEnd.body.error.details.field).toBe("endDate");

    /* Backwards used to return an empty list, which reads as "no deliveries"
       rather than "that window cannot exist". */
    const backwards = await call(
      "/deliveries?startDate=2026-09-01&endDate=2026-08-01", { token: store.token },
    );
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.message).toMatch(/before its start/i);
  });

  test("the database and the per-delivery pass agree on the same boundary", async () => {
    /* They parsed the caller's strings separately, so a delivery could satisfy
       one and not the other — the order was selected and then its delivery
       silently dropped, or vice versa. One parse now feeds both. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 2, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: {
        "deliveries.0.deliveryDate": new Date("2026-08-31T23:30:00.000Z"),
        "deliveries.0.invoiceNumber": "INV-EDGE",
      },
    });

    const res = await call("/deliveries?endDate=2026-08-31", { token: store.token });
    expect(res.status).toBe(200);
    /* The order matched the query AND the delivery survived the second pass —
       an empty list here would mean the two boundaries disagreed. */
    expect(res.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-EDGE"]);
    expect(res.body.stats.totalDeliveries).toBe(1);
  });

  test("a date that is not on the calendar is refused", async () => {
    /* `new Date("2026-02-31")` does not throw — it rolls over to March 3rd,
       and the filter then silently covers a day nobody asked about. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await receivedOrder({ co: a, receivedQty: 3, orderedQty: 10 });

    for (const impossible of ["2026-02-31", "2026-02-29", "2026-13-01", "2026-04-31", "2026-00-10"]) {
      const res = await call(`/deliveries?startDate=${impossible}`, { token: store.token });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(res.body.error.details.field).toBe("startDate");
    }
  });

  test("a real leap day is accepted", async () => {
    /* 2028 is a leap year; 2026 is not. The check must know the difference
       rather than rejecting every 29th of February. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 3, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: {
        "deliveries.0.deliveryDate": new Date("2028-02-29T09:00:00.000Z"),
        "deliveries.0.invoiceNumber": "INV-LEAP",
      },
    });

    const res = await call(
      "/deliveries?startDate=2028-02-29&endDate=2028-02-29", { token: store.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-LEAP"]);
  });

  test("a date-only range is the UTC calendar day, both ends", async () => {
    /* Stated once and tested at both edges: 00:00:00.000Z to 23:59:59.999Z,
       whatever the server's own timezone happens to be. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 1, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: { "deliveries.0.deliveryDate": new Date("2026-08-31T00:00:00.000Z"), "deliveries.0.invoiceNumber": "INV-FIRST" },
    });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $push: { deliveries: { deliveryDate: new Date("2026-08-31T23:59:59.999Z"), quantityReceived: 1, invoiceNumber: "INV-LAST" } },
    });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $push: { deliveries: { deliveryDate: new Date("2026-09-01T00:00:00.000Z"), quantityReceived: 1, invoiceNumber: "INV-NEXTDAY" } },
    });

    const res = await call(
      "/deliveries?startDate=2026-08-31&endDate=2026-08-31", { token: store.token },
    );
    expect(res.status).toBe(200);
    expect(res.body.deliveries.map((d) => d.invoiceNumber).sort())
      .toEqual(["INV-FIRST", "INV-LAST"]);       // the first and last millisecond
  });

  test("a datetime must state its zone; an offset is honoured as written", async () => {
    /* `2026-08-31T17:45` names no instant on its own — reading it as the
       server's local time makes the same saved report mean different things
       on different machines. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 1, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: { "deliveries.0.deliveryDate": new Date("2026-08-31T12:00:00.000Z") },
    });

    const naive = await call("/deliveries?endDate=2026-08-31T17:45", { token: store.token });
    expect(naive.status).toBe(400);
    expect(naive.body.error.message).toMatch(/zone/i);

    // Explicit Z.
    expect((await call("/deliveries?endDate=2026-08-31T18:00:00.000Z", { token: store.token }))
      .body.deliveries).toHaveLength(1);
    expect((await call("/deliveries?endDate=2026-08-31T06:00:00.000Z", { token: store.token }))
      .body.deliveries).toHaveLength(0);

    /* An explicit offset means the instant it names: 16:00+05:30 is 10:30Z,
       which is before the delivery; 19:00+05:30 is 13:30Z, which is after. */
    expect((await call(`/deliveries?endDate=${encodeURIComponent("2026-08-31T16:00:00+05:30")}`, { token: store.token }))
      .body.deliveries).toHaveLength(0);
    expect((await call(`/deliveries?endDate=${encodeURIComponent("2026-08-31T19:00:00+05:30")}`, { token: store.token }))
      .body.deliveries).toHaveLength(1);
  });

  test("a zoned datetime is held to the calendar too", async () => {
    /* The regex proves the shape, not that the day exists. `new Date()` is as
       forgiving with a time attached as without: `2026-02-31T17:45:00Z` was
       becoming March 3rd and filtering by a day nobody asked for. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await receivedOrder({ co: a, receivedQty: 2, orderedQty: 10 });

    const impossible = [
      "2026-02-31T17:45:00Z",            // no 31st of February
      "2026-04-31T17:45:00+05:30",       // April has 30 days — and an offset
      "2026-02-29T09:00:00Z",            // 2026 is not a leap year
      "2026-13-01T00:00:00Z",
      "2026-08-31T25:00:00Z",            // nor is there a 25th hour
    ];
    for (const value of impossible) {
      const res = await call(`/deliveries?endDate=${encodeURIComponent(value)}`, { token: store.token });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION");
      expect(res.body.error.details.field).toBe("endDate");
    }
  });

  test("a valid leap-day datetime is accepted, offset and all", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const { po } = await receivedOrder({ co: a, receivedQty: 2, orderedQty: 10 });
    await PurchaseOrder.updateOne({ _id: po._id }, {
      $set: {
        "deliveries.0.deliveryDate": new Date("2028-02-29T09:00:00.000Z"),
        "deliveries.0.invoiceNumber": "INV-LEAPTIME",
      },
    });

    const utc = await call(
      `/deliveries?startDate=${encodeURIComponent("2028-02-29T00:00:00Z")}`
      + `&endDate=${encodeURIComponent("2028-02-29T23:59:59Z")}`,
      { token: store.token },
    );
    expect(utc.status).toBe(200);
    expect(utc.body.deliveries.map((d) => d.invoiceNumber)).toEqual(["INV-LEAPTIME"]);

    /* The same leap day named with an offset: 14:45+05:30 is 09:15Z, just
       after the delivery, so it is still inside the range. */
    const offset = await call(
      `/deliveries?endDate=${encodeURIComponent("2028-02-29T14:45:00+05:30")}`,
      { token: store.token },
    );
    expect(offset.status).toBe(200);
    expect(offset.body.deliveries).toHaveLength(1);
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
