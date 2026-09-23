// test/store-purchase/supplier-return-rollback.replset.test.js
//
// Warehouse Stock V1 — PROVES a warehouse-aware supplier return / replacement
// is atomic on a replica set. The PO return record, the RawItem deduction, the
// LocationBalance and the LocationMovement all commit in ONE transaction; an
// injected failure rolls back EVERY one of them, and a forced transient retry
// finishes with exactly one return / one movement.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Employee = require("../../models/Employee");
const locStock = require("../../services/storePurchase/locationStock.service");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let rs, server, base, seq = 0;
const oid = () => new mongoose.Types.ObjectId();

function transientError() {
  const e = new mongoose.mongo.MongoServerError({ message: "injected transient write conflict" });
  e.addErrorLabel("TransientTransactionError");
  return e;
}
function throwTransientOnce(Model) {
  const orig = Model.create.bind(Model);
  let calls = 0;
  jest.spyOn(Model, "create").mockImplementation((docs, opts) => {
    calls += 1;
    if (calls === 1) throw transientError();
    return orig(docs, opts);
  });
  return () => calls;
}

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "supplier_return_rollback" });
  unitOfWork.__setTransactionSupport(null);

  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/inventory/operations/purchase-orders/:poId/returns",
    require("../../routes/CMS_Routes/Inventory/Operations/returnRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/operations`;
}, 180000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  jest.restoreAllMocks();
});

const newKey = () => `srr-${++seq}`;
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor(co) {
  const n = ++seq;
  const email = `srr${n}@x.example`;
  const emp = await Employee.create({ firstName: "S", lastName: `L${n}`, email, biometricId: `SRR${n}`, isActive: true, gender: "Other", department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "S" });
  return jwt.sign({ id: String(emp._id), email, name: "S", role: "employee", employeeId: emp.biometricId }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
}

async function seed({ received = 20, locQty = 20 } = {}) {
  const co = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const token = await actor(co);
  const wh = await Warehouse.create({
    companyId: co._id, name: `WH ${++seq}`, shortName: `W${seq}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const [locA, locB] = wh.locations;
  const raw = await RawItem.create({ companyId: co._id, name: `Bolt ${++seq}`, sku: `BLT-${seq}`, unit: "pcs", quantity: 100, minStock: 0 });
  await locStock.applyLocationIn(null, {
    companyId: co._id, siteId: null, item: raw, variantId: null,
    warehouse: wh, location: locA, quantity: locQty, type: "receipt", intent: "receive",
    source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "",
  });
  const vendor = await Vendor.create({ companyName: `V ${++seq}` });
  const po = await PurchaseOrder.create({
    companyId: co._id, createdBy: oid(), poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
    vendor: vendor._id, vendorName: vendor.companyName, status: "PARTIALLY_RECEIVED",
    items: [{ rawItem: raw._id, itemName: raw.name, sku: raw.sku, unit: "pcs", quantity: 40, receivedQuantity: received, pendingQuantity: 20, unitPrice: 50, totalPrice: 2000 }],
    totalReceived: received, totalPending: 20, totalAmount: 2000,
  });
  return { co, token, wh, locA, locB, raw, po, itemId: String(po.items[0]._id) };
}

const raise = (s, over = {}, key = newKey()) =>
  call(`/purchase-orders/${s.po._id}/returns`, {
    method: "POST", token: s.token, key,
    body: { poItemId: s.itemId, damagedQuantity: 5, reason: "Bent", warehouseId: String(s.wh._id), locationId: String(s.locA._id), ...over },
  });
const receive = (s, returnId, over = {}, key = newKey()) =>
  call(`/purchase-orders/${s.po._id}/returns/${returnId}/receive`, {
    method: "POST", token: s.token, key,
    body: { quantityReceived: 4, warehouseId: String(s.wh._id), locationId: String(s.locB._id), ...over },
  });

const onHand = (s, loc) => locStock.locationOnHand(null, s.co._id, s.raw._id, null, s.wh._id, loc._id);
const rawQty = async (s) => (await RawItem.findById(s.raw._id).lean()).quantity;

test("transactional mode is active on the replica set", async () => {
  expect(await unitOfWork.transactionsAvailable()).toBe(true);
});

test("no failure — return commits PO record, company stock, location balance and movement together", async () => {
  const s = await seed({ locQty: 20 });
  const r = await raise(s, { damagedQuantity: 5 });
  expect(r.status).toBe(201);
  expect(await onHand(s, s.locA)).toBe(15);
  expect(await rawQty(s)).toBe(95);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "supplier_return" })).toBe(1);
  expect((await PurchaseOrder.findById(s.po._id).lean()).returnRequests).toHaveLength(1);
});

test("a movement-write failure rolls back PO, RawItem, LocationBalance AND LocationMovement", async () => {
  const s = await seed({ locQty: 20 });
  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("inject: hard fail"); });
  const r = await raise(s, { damagedQuantity: 5 });
  expect(r.status).toBeGreaterThanOrEqual(400);

  // Every effect rolled back together.
  expect((await PurchaseOrder.findById(s.po._id).lean()).returnRequests || []).toHaveLength(0);
  expect(await rawQty(s)).toBe(100);
  expect(await onHand(s, s.locA)).toBe(20);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "supplier_return" })).toBe(0);
  expect(await LocationBalance.findOne(locStock.locFilter(s.co._id, s.raw._id, null, s.wh._id, s.locA._id)).lean().then((b) => b.onHand)).toBe(20);
});

test("a forced transient RETRY still returns exactly once — one record, one deduction, one movement", async () => {
  const s = await seed({ locQty: 20 });
  const countCalls = throwTransientOnce(LocationMovement); // rerun the callback once
  const r = await raise(s, { damagedQuantity: 5 });
  expect(r.status).toBe(201);
  expect(countCalls()).toBeGreaterThanOrEqual(2); // the mutate callback re-ran

  expect((await PurchaseOrder.findById(s.po._id).lean()).returnRequests).toHaveLength(1);
  expect(await rawQty(s)).toBe(95);
  expect(await onHand(s, s.locA)).toBe(15);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "supplier_return" })).toBe(1);
});

test("a replacement movement failure rolls back the credit, the receipt and the movement", async () => {
  const s = await seed({ locQty: 20 });
  const raised = await raise(s, { damagedQuantity: 6 });
  const returnId = raised.body.returnRequest._id;
  const afterRaise = await rawQty(s);

  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("inject: hard fail"); });
  const r = await receive(s, returnId, { quantityReceived: 4 });
  expect(r.status).toBeGreaterThanOrEqual(400);

  expect(await rawQty(s)).toBe(afterRaise);               // company credit rolled back
  expect(await onHand(s, s.locB)).toBe(0);                // B1 not credited
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "replacement_receipt" })).toBe(0);
  const ret = (await PurchaseOrder.findById(s.po._id).lean()).returnRequests[0];
  expect(ret.receipts || []).toHaveLength(0);             // receipt rolled back
  expect(ret.returnedQuantity).toBe(0);
});

test("a forced transient RETRY on a replacement credits exactly once", async () => {
  const s = await seed({ locQty: 20 });
  const raised = await raise(s, { damagedQuantity: 6 });
  const returnId = raised.body.returnRequest._id;
  const countCalls = throwTransientOnce(LocationMovement);
  const r = await receive(s, returnId, { quantityReceived: 4 });
  expect(r.status).toBe(200);
  expect(countCalls()).toBeGreaterThanOrEqual(2);

  expect(await onHand(s, s.locB)).toBe(4);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "replacement_receipt" })).toBe(1);
  expect((await PurchaseOrder.findById(s.po._id).lean()).returnRequests[0].receipts).toHaveLength(1);
});
