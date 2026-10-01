// test/store-purchase/mrf-reservation.replset.test.js
//
// CHUNK 9A — reservations are CONCURRENCY-SAFE and the controlled issue is ATOMIC.
// On a real replica set:
//   · two demands racing for the same last stock cannot both win — the guarded
//     LocationReservation projection serialises them; exactly one reserves, the
//     other is refused, and reserved never exceeds on-hand;
//   · the same idempotency key fired twice concurrently reserves exactly once;
//   · an issue that fails mid-flight (a movement write throws) rolls back EVERY
//     write — on-hand, the reservation projection and the record are untouched.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return { submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop, tlApproved: noop, tlRejected: noop, issued: noop, unfulfilled: noop, returned: noop, productRequestChatMessage: noop, productRequestTlApproved: noop, productRequestTlRejected: noop };
});
jest.mock("../../services/mrfChat.service", () => ({ systemMessage: () => Promise.resolve(null), postMessage: () => Promise.resolve(null), listMessages: () => Promise.resolve([]), markRead: () => Promise.resolve({ unread: 0 }), describeSubject: () => ({ label: "" }) }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationReservation = require("../../models/CMS_Models/Inventory/Operations/LocationReservation");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const Employee = require("../../models/Employee");
const locStock = require("../../services/storePurchase/locationStock.service");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let rs, server, base, seq = 0, idemSeq = 0;
const newKey = () => `rr-${++idemSeq}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "mrf_reservation" });
  unitOfWork.__setTransactionSupport(null);   // re-probe against the replica set
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/mrf`;
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

const call = (emp, path, { method = "GET", body, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
      Authorization: `Bearer ${jwt.sign({ id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: "St", email: emp.email }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" })}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });
async function seedLoc(company, wh, loc, raw, qty) {
  await locStock.applyLocationIn(null, { companyId: company._id, siteId: null, item: raw, variantId: null, warehouse: wh, location: loc, quantity: qty, type: "receipt", intent: "receive", source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "" });
}

// One company + store actor + warehouse (A1 usable) + one stocked item, plus
// `demands` separate approved MRFs all pointing at that item.
async function seed({ stock = 10, demands = [10] }) {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const emp = await person({ firstName: "Rutu", lastName: `T${n}`, email: `tc${n}@x.example`, biometricId: `TC${n}` });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `st${n}@x.example`, biometricId: `ST${n}`, department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "B" });

  const wh = await Warehouse.create({ companyId: company._id, name: `WH ${n}`, shortName: `W${n}${Date.now() % 1000}`, status: "Active", locations: [{ code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" }] });
  const locA = wh.locations[0];
  const raw = await RawItem.create({ name: `Item ${n}`, sku: `IT-${n}`, unit: "pcs", quantity: stock, minStock: 0 });
  await seedLoc(company, wh, locA, raw, stock);

  const mrfs = [];
  for (const req of demands) {
    const mrf = await MRF.create({ mrfNumber: `MRF/2026-27/${String(++seq).padStart(4, "0")}`, companyId: company._id, requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech", requestType: "USES_BASED", status: "APPROVED", createdByRef: emp._id, createdByModel: "Employee", tlApproved: true, items: [{ rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku, requestedQty: req, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED" }] });
    mrfs.push(mrf);
  }
  return { company, store, wh, locA, raw, mrfs };
}

const reserve = (s, mrf, qty, key = newKey()) =>
  call(s.store, `/${mrf._id}/items/${mrf.items[0]._id}/reserve`, { method: "POST", key, body: { allocations: [{ warehouseId: String(s.wh._id), locationId: String(s.locA._id), qty }] } });
const onHand = (s) => locStock.locationOnHand(null, s.company._id, s.raw._id, null, s.wh._id, s.locA._id);
const projReserved = async (s) => ((await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean())?.reserved) || 0;

test("two demands racing for the same last stock — exactly one reserves, reserved never exceeds on-hand", async () => {
  const s = await seed({ stock: 10, demands: [7, 7] });   // 10 on hand; each wants 7 → they conflict
  const [a, b] = await Promise.all([reserve(s, s.mrfs[0], 7), reserve(s, s.mrfs[1], 7)]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([201, 400]);                   // one wins, one refused
  expect(await projReserved(s)).toBe(7);                  // only the winner's hold
  expect(await projReserved(s)).toBeLessThanOrEqual(10);  // never oversubscribed
  expect(await onHand(s)).toBe(10);                        // reserving never touched on-hand
  expect(await StockReservation.countDocuments({ companyId: s.company._id })).toBe(1);
});

test("the same idempotency key fired twice concurrently reserves exactly once", async () => {
  const s = await seed({ stock: 20, demands: [10] });
  const k = newKey();
  const [a, b] = await Promise.all([reserve(s, s.mrfs[0], 10, k), reserve(s, s.mrfs[0], 10, k)]);
  expect([a.status, b.status].every((st) => st === 200 || st === 201 || st === 409)).toBe(true);
  // Whatever the race, the ledger reflects exactly one reservation of 10.
  expect(await projReserved(s)).toBe(10);
  expect(await StockReservation.countDocuments({ companyId: s.company._id })).toBe(1);
});

test("an issue that fails mid-flight rolls back everything — nothing consumed", async () => {
  const s = await seed({ stock: 20, demands: [10] });
  const r = await reserve(s, s.mrfs[0], 10);
  expect(r.status).toBe(201);
  const resId = r.body.reservation.id;

  // A movement write throws a NON-transient error → the whole issue transaction aborts.
  jest.spyOn(LocationMovement, "create").mockImplementation(() => { throw new Error("boom writing movement"); });
  const iss = await call(s.store, `/${s.mrfs[0]._id}/reservations/${resId}/issue`, { method: "POST", key: newKey(), body: { qty: 10 } });
  expect(iss.status).toBeGreaterThanOrEqual(500);
  jest.restoreAllMocks();

  // Everything is exactly as it was before the failed issue.
  expect(await onHand(s)).toBe(20);                        // on-hand untouched
  expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(20);
  expect(await projReserved(s)).toBe(10);                  // still fully reserved
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(0);
  const rec = await StockReservation.findById(resId).lean();
  expect(rec.issuedQty).toBe(0);                           // nothing recorded as issued
  expect(rec.status).toBe("RESERVED");
  expect((await MRF.findById(s.mrfs[0]._id).lean()).items[0].issuedQty || 0).toBe(0);
});
