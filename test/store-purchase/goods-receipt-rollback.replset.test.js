// test/store-purchase/goods-receipt-rollback.replset.test.js
//
// GOODS RECEIPT V1 — proves the receipt is truly ATOMIC on a replica set. The
// GRN document, the RawItem stock effect + its ledger transaction, the location
// balance/movement and the PO received/delivery state all commit in ONE
// transaction. A failure mid-transaction rolls back EVERY one of them — no
// partial GRN, no stock mutation left behind.
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
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let rs, server, base, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "grn_rollback" });
  unitOfWork.__setTransactionSupport(null); // re-probe against the replica set

  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
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
  jwt.sign({ id: String(oid()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed() {
  const company = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const wh = await Warehouse.create({
    companyId: company._id, name: "Main", shortName: `MW${seq}`, status: "Active",
    locations: [{ code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" }],
  });
  const recv = wh.locations[0];
  const raw = await RawItem.create({ companyId: company._id, sku: `RAW-${seq}`, name: "Bolt", unit: "PCS", quantity: 0 });
  const po = await PurchaseOrder.create({
    companyId: company._id, poNumber: `PO/2026-27/${String(seq).padStart(4, "0")}`, vendorName: "V", status: "ISSUED",
    subtotal: 1000, totalAmount: 1000, totalReceived: 0, createdBy: oid(),
    items: [{ itemName: "Bolt", sku: raw.sku, unit: "PCS", quantity: 10, unitPrice: 100, totalPrice: 1000, rawItem: raw._id, receivedQuantity: 0, pendingQuantity: 10, status: "PENDING" }],
  });
  const n = ++seq; const email = `grn${n}@x.example`; const employeeRef = oid();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "GR", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "GR" });
  const token = tokenFor({ id: String(employeeRef), email });
  return { company, wh, recv, raw, po, token };
}
const grnUrl = (poId) => `/api/cms/purchase-orders/${poId}/goods-receipts`;

test("transactional mode is actually active on the replica set", async () => {
  expect(await unitOfWork.transactionsAvailable()).toBe(true);
});

test("a mid-transaction failure rolls back the ENTIRE goods receipt", async () => {
  const s = await seed();
  // Inject: the location movement write throws inside the transaction.
  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("injected location-write failure"); });

  const res = await call(grnUrl(s.po._id), { method: "POST", token: s.token, key: `k-${++seq}`, body: {
    items: [{ poItemId: String(s.po.items[0]._id), quantity: 8 }], warehouseId: String(s.wh._id), locationId: String(s.recv._id),
  } });
  expect(res.status).toBeGreaterThanOrEqual(500);

  // Nothing half-applied.
  const raw = await RawItem.findById(s.raw._id);
  expect(raw.quantity).toBe(0);
  expect(raw.stockTransactions.length).toBe(0);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id })).toBe(0);
  expect(await LocationBalance.countDocuments({ itemId: s.raw._id })).toBe(0);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: s.po._id })).toBe(0);   // no partial GRN
  const po = await PurchaseOrder.findById(s.po._id);
  expect(po.items[0].receivedQuantity).toBe(0);
  expect((po.deliveries || []).length).toBe(0);
  expect(po.totalReceived).toBe(0);
});

test("a clean receipt commits every effect together", async () => {
  const s = await seed();
  const res = await call(grnUrl(s.po._id), { method: "POST", token: s.token, key: `k-${++seq}`, body: {
    items: [{ poItemId: String(s.po.items[0]._id), quantity: 8 }], warehouseId: String(s.wh._id), locationId: String(s.recv._id),
  } });
  expect(res.status).toBe(201);
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(8);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "receipt" })).toBe(1);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: s.po._id })).toBe(1);
  expect((await PurchaseOrder.findById(s.po._id)).items[0].receivedQuantity).toBe(8);
});
