// test/store-purchase/po-receipt-rollback.replset.test.js
//
// Warehouse Stock V1 — PROVES the PO receipt is truly atomic on a replica set.
// The RawItem stock effect, its stock transaction, the LocationBalance, the
// LocationMovement and the PurchaseOrder received/delivery record all commit in
// ONE transaction. When the location write fails mid-transaction, EVERY one of
// them must roll back — nothing half-applied.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let rs, server, base, seq = 0;

beforeAll(async () => {
  // The shared harness connected a standalone; swap for a replica set so real
  // transactions (and real rollback) are available.
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "po_rollback" });
  unitOfWork.__setTransactionSupport(null); // re-probe against the replica set

  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/operations/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
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

const oid = () => new mongoose.Types.ObjectId();
const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor(company) {
  const n = ++seq;
  const email = `po${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "PO", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "PO" });
  return tokenFor({ id: String(employeeRef), email });
}

async function seed() {
  const company = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const wh = await Warehouse.create({
    companyId: company._id, name: "Main", shortName: `MW${seq}`, status: "Active",
    locations: [{ code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" }],
  });
  const recv = wh.locations[0];
  const raw = await RawItem.create({
    companyId: company._id, sku: `RAW-${seq}`, name: "Bolt", unit: "PCS", quantity: 0,
    variants: [{ _id: oid(), sku: "BOLT-A", combination: ["A"], quantity: 0 }],
  });
  const variant = raw.variants[0];
  const po = await PurchaseOrder.create({
    companyId: company._id, poNumber: `PO/2026-27/${String(seq).padStart(4, "0")}`,
    vendorName: "V", status: "ISSUED", subtotal: 1000, totalAmount: 1000, totalReceived: 0,
    createdBy: oid(),
    items: [{
      itemName: "Bolt", sku: raw.sku, unit: "PCS", quantity: 10, unitPrice: 100, totalPrice: 1000,
      rawItem: raw._id, variantId: variant._id, receivedQuantity: 0, pendingQuantity: 10, status: "PENDING",
    }],
  });
  const token = await actor(company);
  return { company, wh, recv, raw, variant, po, token };
}

test("transactional mode is actually active on the replica set", async () => {
  expect(await unitOfWork.transactionsAvailable()).toBe(true);
});

test("a location-write failure rolls back the ENTIRE receipt", async () => {
  const s = await seed();
  // Inject the failure: the location movement write throws mid-transaction.
  const spy = jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => {
    throw new Error("injected location-write failure");
  });

  const res = await call(`/api/cms/inventory/operations/purchase-orders/${s.po._id}/receive`, {
    method: "POST", token: s.token, key: `k-${seq}`,
    body: { warehouseId: String(s.wh._id), locationId: String(s.recv._id), items: [{ itemId: s.po.items[0]._id, quantity: 10 }], invoiceNumber: "INV-RB" },
  });
  expect(res.status).toBeGreaterThanOrEqual(400); // the receipt failed
  expect(spy).toHaveBeenCalled();

  // EVERY effect must be unchanged — nothing half-applied.
  const raw = await RawItem.findById(s.raw._id).lean();
  expect(raw.quantity).toBe(0); // RawItem quantity
  expect(raw.variants[0].quantity).toBe(0); // variant quantity
  expect(raw.stockTransactions.length).toBe(0); // stockTransactions

  expect(await LocationBalance.countDocuments({ itemId: s.raw._id })).toBe(0); // LocationBalance
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id })).toBe(0); // LocationMovement

  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect(po.items[0].receivedQuantity).toBe(0); // PO received
  expect(po.items[0].pendingQuantity).toBe(10); // PO pending
  expect((po.deliveries || []).length).toBe(0); // PO delivery history
  expect(po.totalReceived).toBe(0);
});

/** A PO with TWO lines pointing at the SAME (non-variant) raw item. */
async function seedTwoLines() {
  const company = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const wh = await Warehouse.create({
    companyId: company._id, name: "Main", shortName: `MW${seq}`, status: "Active",
    locations: [{ code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" }],
  });
  const recv = wh.locations[0];
  const raw = await RawItem.create({
    companyId: company._id, sku: `RAW2-${seq}`, name: "Bolt2", unit: "PCS", quantity: 0,
  });
  const po = await PurchaseOrder.create({
    companyId: company._id, poNumber: `PO/2026-27/${String(seq).padStart(4, "0")}`,
    vendorName: "V", status: "ISSUED", subtotal: 5000, totalAmount: 5000, totalReceived: 0,
    createdBy: oid(),
    items: [
      { itemName: "Bolt2", sku: raw.sku, unit: "PCS", quantity: 30, unitPrice: 100, totalPrice: 3000, rawItem: raw._id, receivedQuantity: 0, pendingQuantity: 30, status: "PENDING" },
      { itemName: "Bolt2", sku: raw.sku, unit: "PCS", quantity: 20, unitPrice: 100, totalPrice: 2000, rawItem: raw._id, receivedQuantity: 0, pendingQuantity: 20, status: "PENDING" },
    ],
  });
  const token = await actor(company);
  return { company, wh, recv, raw, po, token };
}

test("a two-line receipt where the SECOND line fails rolls back the first line too", async () => {
  const s = await seedTwoLines();

  // Both lines are the same item, so the fix applies BOTH to one live document,
  // saves it once, then writes a movement PER line. Let the first movement
  // commit inside the transaction and the SECOND throw — the whole receipt,
  // including the first line's already-applied stock, must roll back.
  const orig = LocationMovement.create.bind(LocationMovement);
  let calls = 0;
  const spy = jest.spyOn(LocationMovement, "create").mockImplementation((docs, opts) => {
    calls += 1;
    if (calls >= 2) throw new Error("injected failure on the second line's movement");
    return orig(docs, opts);
  });

  const res = await call(`/api/cms/inventory/operations/purchase-orders/${s.po._id}/receive`, {
    method: "POST", token: s.token, key: `k-2l-${seq}`,
    body: {
      warehouseId: String(s.wh._id), locationId: String(s.recv._id),
      items: [
        { itemId: s.po.items[0]._id, quantity: 30 },
        { itemId: s.po.items[1]._id, quantity: 20 },
      ],
      invoiceNumber: "INV-2RB",
    },
  });
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2); // both lines attempted

  // Nothing half-applied — not even the first line that "succeeded".
  const raw = await RawItem.findById(s.raw._id).lean();
  expect(raw.quantity).toBe(0);
  expect(raw.stockTransactions.length).toBe(0);
  expect(await LocationBalance.countDocuments({ itemId: s.raw._id })).toBe(0);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id })).toBe(0);

  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect(po.items[0].receivedQuantity).toBe(0);
  expect(po.items[1].receivedQuantity).toBe(0);
  expect(po.items[0].pendingQuantity).toBe(30);
  expect(po.items[1].pendingQuantity).toBe(20);
  expect((po.deliveries || []).length).toBe(0);
  expect(po.totalReceived).toBe(0);
});

test("a two-line receipt with no failure commits BOTH lines to one item", async () => {
  const s = await seedTwoLines();
  const res = await call(`/api/cms/inventory/operations/purchase-orders/${s.po._id}/receive`, {
    method: "POST", token: s.token, key: `k-2l-ok-${seq}`,
    body: {
      warehouseId: String(s.wh._id), locationId: String(s.recv._id),
      items: [
        { itemId: s.po.items[0]._id, quantity: 30 },
        { itemId: s.po.items[1]._id, quantity: 20 },
      ],
      invoiceNumber: "INV-2OK",
    },
  });
  expect(res.status).toBe(200);

  const raw = await RawItem.findById(s.raw._id).lean();
  expect(raw.quantity).toBe(50); // both lines accumulated on the one document
  expect(raw.stockTransactions.length).toBe(2);

  const mvs = await LocationMovement.find({ itemId: s.raw._id, type: "receipt" }).lean();
  expect(mvs.length).toBe(2); // two movements, distinguished by per-line key
  expect(new Set(mvs.map((m) => m.idempotencyKey)).size).toBe(2);
  expect(new Set(mvs.map((m) => m.operationKey)).size).toBe(1);
  expect(await LocationBalance.findOne({ itemId: s.raw._id, locationId: s.recv._id }).lean().then((b) => b.onHand)).toBe(50);

  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect(po.items[0].receivedQuantity).toBe(30);
  expect(po.items[1].receivedQuantity).toBe(20);
});

test("with no injected failure the same receipt commits everything together", async () => {
  const s = await seed();
  const res = await call(`/api/cms/inventory/operations/purchase-orders/${s.po._id}/receive`, {
    method: "POST", token: s.token, key: `k-ok-${seq}`,
    body: { warehouseId: String(s.wh._id), locationId: String(s.recv._id), items: [{ itemId: s.po.items[0]._id, quantity: 10 }], invoiceNumber: "INV-OK" },
  });
  expect(res.status).toBe(200);
  const raw = await RawItem.findById(s.raw._id).lean();
  expect(raw.quantity).toBe(10);
  expect(raw.stockTransactions.length).toBe(1);
  expect(String(raw.stockTransactions[0].locationCode)).toBe("RECV");
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "receipt" })).toBe(1);
  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect(po.items[0].receivedQuantity).toBe(10);
});
