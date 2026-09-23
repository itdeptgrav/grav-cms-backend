// test/store-purchase/goods-receipt-control-rollback.replset.test.js
//
// GOODS RECEIPT INSPECTION (V1) — proves the inspection is ATOMIC on a replica
// set. A failure mid-inspection rolls back the inspection record AND both legs
// of every location move already applied — no partial quarantine, no stranded
// balance, and company-wide on-hand untouched.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let rs, server, base, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "grn_control_rollback" });
  unitOfWork.__setTransactionSupport(null);

  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  app.use("/api/cms/store/goods-receipts", require("../../routes/CMS_Routes/StorePurchase/goodsReceipts"));
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
const tokenFor = (over = {}) => jwt.sign({ id: String(oid()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
const kkey = () => `gcr-${++seq}`;
const locId = (wh, code) => String(wh.locations.find((l) => l.code === code)._id);
const bal = async (rawId, whId, locationId) => { const row = await LocationBalance.findOne({ itemId: rawId, warehouseId: whId, locationId }).lean(); return row ? row.onHand : 0; };

async function seed() {
  const company = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const wh = await Warehouse.create({ companyId: company._id, name: "Main", shortName: `MW${seq}`, status: "Active",
    locations: [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "STOCK", name: "Usable", type: "USABLE_STOCK", status: "Active" },
      { code: "QUAR", name: "Quarantine", type: "QUARANTINE", status: "Active" },
      { code: "RETN", name: "Returns", type: "RETURNS", status: "Active" },
    ] });
  const raw = await RawItem.create({ companyId: company._id, sku: `RAW-${seq}`, name: "Bolt", unit: "PCS", quantity: 0 });
  const po = await PurchaseOrder.create({ companyId: company._id, poNumber: `PO/${seq}`, status: "ISSUED", createdBy: oid(), vendorName: "V",
    subtotal: 0, totalAmount: 0, totalReceived: 0, items: [{ _id: oid(), rawItem: raw._id, itemName: "Bolt", sku: "B", unit: "PCS", quantity: 10, unitPrice: 10, totalPrice: 100, receivedQuantity: 0, pendingQuantity: 10, status: "PENDING" }] });
  const email = `gcr${++seq}@x.example`; const employeeRef = oid();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "GCR", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "GCR" });
  const token = tokenFor({ id: String(employeeRef), email });
  // Receive 10 into Receiving.
  const rec = await call(`/api/cms/purchase-orders/${po._id}/goods-receipts`, { method: "POST", token, key: kkey(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 10 }], warehouseId: String(wh._id), locationId: locId(wh, "RECV") } });
  return { company, wh, raw, po, token, grnId: rec.body.goodsReceipt._id, grnLineId: String(rec.body.goodsReceipt.lines[0]._id) };
}

test("transactional mode is active on the replica set", async () => {
  expect(await unitOfWork.transactionsAvailable()).toBe(true);
});

test("a movement-write failure rolls back the ENTIRE inspection (record + both legs)", async () => {
  const s = await seed();
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RECV"))).toBe(10);

  // Inspection posts a quarantine transfer THEN a reject transfer (two create
  // calls). Fail the SECOND, so a leg has already been applied in-transaction.
  let calls = 0;
  const orig = LocationMovement.create.bind(LocationMovement);
  jest.spyOn(LocationMovement, "create").mockImplementation((docs, opts) => {
    calls += 1;
    if (calls >= 2) throw new Error("injected movement-write failure");
    return orig(docs, opts);
  });

  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 4, quarantinedQuantity: 3, rejectedQuantity: 3 }], quarantineLocationId: locId(s.wh, "QUAR"), returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(res.status).toBeGreaterThanOrEqual(500);

  // Nothing half-applied.
  expect(await GoodsReceiptInspection.countDocuments({ goodsReceiptId: s.grnId })).toBe(0);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: { $in: ["transfer_in", "transfer_out"] } })).toBe(0);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RECV"))).toBe(10);   // quarantine leg rolled back
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "QUAR"))).toBe(0);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(0);
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(10);          // company on-hand untouched
});

test("a clean inspection commits the record and all legs together", async () => {
  const s = await seed();
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 4, quarantinedQuantity: 3, rejectedQuantity: 3 }], quarantineLocationId: locId(s.wh, "QUAR"), returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(res.status).toBe(201);
  expect(await GoodsReceiptInspection.countDocuments({ goodsReceiptId: s.grnId })).toBe(1);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RECV"))).toBe(4);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "QUAR"))).toBe(3);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(3);
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(10);
});

const GoodsReceiptPutawayPosition = require("../../models/CMS_Models/StorePurchase/GoodsReceiptPutawayPosition");

test("a failed put-away rolls back its reservation increment AND leaves no movement/record", async () => {
  const s = await seed();
  // Inspect all-accepted so there is 10 to put away.
  const ins = await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }],
  } });
  expect(ins.status).toBe(201);
  const before = await GoodsReceiptPutawayPosition.findOne({ goodsReceiptLineId: s.grnLineId }).lean();
  expect(before.posted).toBe(0);

  // Fail the put-away's location move mid-transaction (its single create call).
  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("injected put-away movement failure"); });
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/putaways`, { method: "POST", token: s.token, key: kkey(), body: { goodsReceiptLineId: s.grnLineId, quantity: 6, toLocationId: locId(s.wh, "STOCK") } });
  expect(res.status).toBeGreaterThanOrEqual(500);

  // The reservation increment rolled back with the transaction.
  const after = await GoodsReceiptPutawayPosition.findOne({ goodsReceiptLineId: s.grnLineId }).lean();
  expect(after.posted).toBe(0);
  expect(await require("../../models/CMS_Models/StorePurchase/GoodsReceiptPutaway").countDocuments({ goodsReceiptId: s.grnId })).toBe(0);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "STOCK"))).toBe(0);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RECV"))).toBe(10);   // still all in receiving
});

const GoodsReceiptDisposition = require("../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");

test("a failed disposition rolls back its reservation, both movement legs and the record", async () => {
  const s = await seed();
  const ins = await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 6, quarantinedQuantity: 4, rejectedQuantity: 0 }], quarantineLocationId: locId(s.wh, "QUAR"),
  } });
  expect(ins.status).toBe(201);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "QUAR"))).toBe(4);

  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("injected disposition movement failure"); });
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/dispositions`, { method: "POST", token: s.token, key: kkey(), body: {
    goodsReceiptLineId: s.grnLineId, dispositionType: "RELEASE", quantity: 3, reason: "ok", quarantineLocationId: locId(s.wh, "QUAR"),
  } });
  expect(res.status).toBeGreaterThanOrEqual(500);

  const pos = await GoodsReceiptPutawayPosition.findOne({ goodsReceiptLineId: s.grnLineId }).lean();
  expect(pos.quarantineResolved).toBe(0);   // reservation rolled back
  expect(pos.accepted).toBe(6);             // capacity increase rolled back
  expect(await GoodsReceiptDisposition.countDocuments({ goodsReceiptId: s.grnId })).toBe(0);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "QUAR"))).toBe(4);   // unchanged
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RECV"))).toBe(6);
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(10);
});

test("a failed supplier return rolls back the returned reservation, the return push and both stock legs", async () => {
  const s = await seed();
  const ins = await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 6, quarantinedQuantity: 0, rejectedQuantity: 4 }], returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(ins.status).toBe(201);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(4);

  // Fail the supplier_return location-out movement mid-transaction.
  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("injected supplier-return movement failure"); });
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/supplier-returns`, { method: "POST", token: s.token, key: kkey(), body: {
    goodsReceiptLineId: s.grnLineId, quantity: 3, reason: "faulty", returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(res.status).toBeGreaterThanOrEqual(500);

  const pos = await GoodsReceiptPutawayPosition.findOne({ goodsReceiptLineId: s.grnLineId }).lean();
  expect(pos.returned).toBe(0);   // reservation rolled back
  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect((po.returnRequests || []).length).toBe(0);                      // return push rolled back
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(4);   // returns balance intact
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(10);         // company on-hand intact
});

const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");

// Factor-10 seed: business unit cartons, stock unit pieces, 1 carton = 10 pieces.
async function convSeed() {
  const company = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const wh = await Warehouse.create({ companyId: company._id, name: "Main", shortName: `MW${seq}`, status: "Active",
    locations: [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "STOCK", name: "Usable", type: "USABLE_STOCK", status: "Active" },
      { code: "QUAR", name: "Quarantine", type: "QUARANTINE", status: "Active" },
      { code: "RETN", name: "Returns", type: "RETURNS", status: "Active" },
    ] });
  const pc = `PC${seq}`, ctn = `CTN${seq}`;
  const pieces = await Unit.create({ companyId: company._id, name: pc });
  await Unit.create({ companyId: company._id, name: ctn, conversions: [{ toUnit: pieces._id, quantity: 10 }] });
  const raw = await RawItem.create({ companyId: company._id, sku: `RAW-${seq}`, name: "Bolt", unit: pc, quantity: 0 });
  const po = await PurchaseOrder.create({ companyId: company._id, poNumber: `PO/${seq}`, status: "ISSUED", createdBy: oid(), vendorName: "V",
    subtotal: 0, totalAmount: 0, totalReceived: 0, items: [{ _id: oid(), rawItem: raw._id, itemName: "Bolt", sku: "B", unit: ctn, quantity: 2, unitPrice: 10, totalPrice: 20, receivedQuantity: 0, pendingQuantity: 2, status: "PENDING" }] });
  const email = `gcr${++seq}@x.example`; const employeeRef = oid();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "GCR", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "GCR" });
  const token = tokenFor({ id: String(employeeRef), email });
  const rec = await call(`/api/cms/purchase-orders/${po._id}/goods-receipts`, { method: "POST", token, key: kkey(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 2 }], warehouseId: String(wh._id), locationId: locId(wh, "RECV") } });
  return { company, wh, raw, po, token, grnId: rec.body.goodsReceipt._id, grnLineId: String(rec.body.goodsReceipt.lines[0]._id) };
}

test("a failed CONVERTED supplier return rolls back the BASE movement, the return + allocations, and the projection", async () => {
  const s = await convSeed();
  // Reject 2 cartons → 20 pieces move to Returns.
  const ins = await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 0, quarantinedQuantity: 0, rejectedQuantity: 2 }], returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(ins.status).toBe(201);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(20);
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(20);

  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("injected converted supplier-return movement failure"); });
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/supplier-returns`, { method: "POST", token: s.token, key: kkey(), body: {
    goodsReceiptLineId: s.grnLineId, quantity: 2, reason: "faulty", returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(res.status).toBeGreaterThanOrEqual(500);

  const pos = await GoodsReceiptPutawayPosition.findOne({ goodsReceiptLineId: s.grnLineId }).lean();
  expect(pos.returned).toBe(0);                                        // reservation rolled back
  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect((po.returnRequests || []).length).toBe(0);                   // return + allocations rolled back
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(20); // BASE 20 intact
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(20);        // company on-hand intact
});

test("a clean CONVERTED supplier return removes exactly the base quantity and freezes the basis", async () => {
  const s = await convSeed();
  await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 0, quarantinedQuantity: 0, rejectedQuantity: 2 }], returnsLocationId: locId(s.wh, "RETN"),
  } });
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/supplier-returns`, { method: "POST", token: s.token, key: kkey(), body: {
    goodsReceiptLineId: s.grnLineId, quantity: 2, reason: "faulty", returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(res.status).toBe(201);
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(0);   // 20 − 20
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(0);          // 20 − 20 once
  const po = await PurchaseOrder.findById(s.po._id).lean();
  const rr = po.returnRequests[0];
  expect(rr.damagedQuantity).toBe(2);
  expect(rr.baseQuantity).toBe(20);
  expect(rr.conversionFactor).toBe(10);
  expect(rr.rejectionAllocations[0].baseQuantity).toBe(20);
});

test("a clean supplier return commits the return, the location-out and the company deduction together", async () => {
  const s = await seed();
  await call(`/api/cms/store/goods-receipts/${s.grnId}/inspection`, { method: "POST", token: s.token, key: kkey(), body: {
    lines: [{ goodsReceiptLineId: s.grnLineId, acceptedQuantity: 6, quarantinedQuantity: 0, rejectedQuantity: 4 }], returnsLocationId: locId(s.wh, "RETN"),
  } });
  const res = await call(`/api/cms/store/goods-receipts/${s.grnId}/supplier-returns`, { method: "POST", token: s.token, key: kkey(), body: {
    goodsReceiptLineId: s.grnLineId, quantity: 3, reason: "faulty", returnsLocationId: locId(s.wh, "RETN"),
  } });
  expect(res.status).toBe(201);
  const po = await PurchaseOrder.findById(s.po._id).lean();
  expect((po.returnRequests || []).length).toBe(1);
  expect(String(po.returnRequests[0].goodsReceiptId)).toBe(String(s.grnId));
  expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(1);   // 4 − 3
  expect((await RawItem.findById(s.raw._id)).quantity).toBe(7);          // 10 − 3 once
});
