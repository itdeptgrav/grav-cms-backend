// test/store-purchase/stock-exceptions.route.test.js
//
// CHUNK 10B — the Stock exceptions read model. Proves the integrity contract:
//   · item / variant / location negative balances are distinct rows;
//   · unassigned positive stock is put-away, NOT a mismatch;
//   · placed > company on-hand IS a mismatch;
//   · a movement uncertainty is never presented as a confirmed balance change;
//   · a reservation shortage is a shortage, not negative stock;
//   · open vs reviewed counts get different next actions;
//   · one failed source family becomes unavailable, not zero;
//   · repeated reads mutate nothing;
//   · pagination is database-backed and bounded;
//   · tenant scope cannot widen (other company / legacy-global excluded);
//   · destination links use params the target pages actually read.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);
jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const oid = () => new mongoose.Types.ObjectId();

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const StockLedger = require("../../models/CMS_Models/Inventory/Operations/StockLedger");
const StockCount = require("../../models/CMS_Models/Inventory/Operations/StockCount");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const Employee = require("../../models/Employee");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/overview/stock-exceptions", require("../../routes/CMS_Routes/Inventory/overview/stockExceptions"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/overview/stock-exceptions`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const call = (emp, qs = "") => fetch(`${base}${qs}`, {
  headers: { Authorization: `Bearer ${jwt.sign({ id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: "St", email: emp.email }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" })}` },
}).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Store", ...o });

// Raw inserts bypass schema validation — needed to seed the corrupted/negative
// records that the guards normally prevent (which is exactly what the page flags).
const rawItem = (doc) => RawItem.collection.insertOne(doc);
const locBal = (doc) => LocationBalance.collection.insertOne(doc);

async function seed() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Ex Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const other = await Acc_Company.create({ companyName: `Other ${n}`, booksFromDate: new Date("2026-04-01") });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`, biometricId: `ST${n}` });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });
  return { company, other, store };
}

test("negative item / variant / location balances are distinct rows; scope never widens", async () => {
  const s = await seed();
  const cid = s.company._id;
  await rawItem({ companyId: cid, name: "Cotton", sku: `COT-${seq}`, unit: "kg", quantity: -3, variants: [] });
  await rawItem({ companyId: cid, name: "Thread", sku: `THR-${seq}`, unit: "cone", quantity: 5, variants: [{ _id: oid(), combination: ["Red"], quantity: -2 }] });
  const negItem = oid();
  await locBal({ companyId: cid, itemId: negItem, variantId: null, warehouseId: oid(), locationId: oid(), onHand: -1 });
  await rawItem({ _id: negItem, companyId: cid, name: "Zip", sku: `ZIP-${seq}`, unit: "pcs", quantity: 10, variants: [] });
  // Another company + a legacy-global (companyId null) negative — must NOT count.
  await rawItem({ companyId: s.other._id, name: "OtherNeg", sku: `OTH-${seq}`, unit: "kg", quantity: -9, variants: [] });
  await rawItem({ companyId: null, name: "LegacyNeg", sku: `LEG-${seq}`, unit: "kg", quantity: -9, variants: [] });

  const r = await call(s.store, "?family=NEGATIVE_BALANCE");
  expect(r.status).toBe(200);
  expect(r.body.families.NEGATIVE_BALANCE.count).toBe(3);           // item + variant + location; NOT the other-company/legacy ones
  const sources = r.body.rows.map((x) => x.source).sort();
  expect(sources).toEqual(["LocationBalance.onHand", "RawItem.quantity", "RawItem.variants.quantity"]);
  // Each links to the movement history with a real ?item filter.
  expect(r.body.rows.every((x) => /\/stock-ledger\?item=/.test(x.resolutionHref))).toBe(true);
});

test("unassigned positive stock is put-away, not a mismatch; placed > company IS a mismatch", async () => {
  const s = await seed();
  const cid = s.company._id;
  // Item A: company 10, placed 6 → 4 unassigned (put-away, NOT mismatch).
  const a = oid();
  await rawItem({ _id: a, companyId: cid, name: "ItemA", sku: `A-${seq}`, unit: "kg", quantity: 10, variants: [] });
  await locBal({ companyId: cid, itemId: a, variantId: null, warehouseId: oid(), locationId: oid(), onHand: 6 });
  // Item B: company 10, placed 15 → over-assigned (mismatch).
  const b = oid();
  await rawItem({ _id: b, companyId: cid, name: "ItemB", sku: `B-${seq}`, unit: "kg", quantity: 10, variants: [] });
  await locBal({ companyId: cid, itemId: b, variantId: null, warehouseId: oid(), locationId: oid(), onHand: 15 });

  const r = await call(s.store);
  expect(r.body.families.UNASSIGNED_PUTAWAY.count).toBe(1);
  expect(r.body.families.BALANCE_MISMATCH.count).toBe(1);
  // The unassigned row is not a mismatch, and its figures stay in one unit.
  const un = await call(s.store, "?family=UNASSIGNED_PUTAWAY");
  expect(un.body.rows[0].family).toBe("UNASSIGNED_PUTAWAY");
  expect(un.body.rows[0].figures.every((f) => f.unit === "kg")).toBe(true);
  expect(un.body.rows[0].resolutionHref).toMatch(/stock-transfer\?itemId=/);
  const mm = await call(s.store, "?family=BALANCE_MISMATCH");
  expect(mm.body.rows[0].explanation).toMatch(/locations total/i);
});

test("a movement uncertainty is never a confirmed balance change; and it is read-only", async () => {
  const s = await seed();
  const cid = s.company._id;
  const item = oid();
  await rawItem({ _id: item, companyId: cid, name: "Item", sku: `I-${seq}`, unit: "kg", quantity: 5, variants: [] });
  await StockLedger.collection.insertOne({ companyId: cid, rawItem: item, direction: "CREDIT", txnType: "COMPENSATING", isVoided: false, applicationState: "PENDING", correctionReason: "x", createdAt: new Date() });
  const r = await call(s.store, "?family=MOVEMENT_UNCERTAIN");
  expect(r.body.families.MOVEMENT_UNCERTAIN.count).toBe(1);
  const row = r.body.rows[0];
  expect(row.explanation).toMatch(/could not be confirmed/i);
  expect(row.figures).toEqual([]);              // NO asserted quantity change
  expect(row.actionability).toBe("read_only");  // preserve the movement; no edit/delete
});

test("a reservation shortage is a shortage, not negative stock; picked>reserved is a distinct inconsistency", async () => {
  const s = await seed();
  const cid = s.company._id;
  const bres = { companyId: cid, mrfId: oid(), mrfLineId: oid(), rawItemId: oid(), unit: "m", requestedQty: 10, mrfNumber: "MRF/1", itemName: "Fabric" };
  await StockReservation.create({ ...bres, status: "PARTIALLY_RESERVED", active: true, reservedQty: 6, backorderedQty: 4 });
  await StockReservation.create({ ...bres, status: "RESERVED", active: true, reservedQty: 10, issuedQty: 0, releasedQty: 0, pickedQty: 12 }); // picked > active reserved

  const r = await call(s.store);
  expect(r.body.families.SHORTAGE.count).toBe(1);
  expect(r.body.families.RESERVATION_INCONSISTENCY.count).toBe(1);
  const sh = await call(s.store, "?family=SHORTAGE");
  expect(sh.body.rows[0].explanation).toMatch(/purchasing signal, not a balance error/i);
  expect(sh.body.rows[0].explanation).not.toMatch(/negative/i);
});

test("open vs reviewed counts get different next actions", async () => {
  const s = await seed();
  const cid = s.company._id;
  await StockCount.collection.insertOne({ companyId: cid, countNumber: `SC-${seq}-A`, seq: seq * 100 + 1, status: "IN_PROGRESS", createdAt: new Date() });
  await StockCount.collection.insertOne({ companyId: cid, countNumber: `SC-${seq}-B`, seq: seq * 100 + 2, status: "REVIEWED", createdAt: new Date(Date.now() + 1000) });
  const r = await call(s.store, "?family=COUNT_PENDING");
  expect(r.body.families.COUNT_PENDING.count).toBe(2);
  const labels = r.body.rows.map((x) => x.resolutionLabel).sort();
  expect(labels).toEqual(["Continue count", "Review & post count"]);
});

test("valuation coverage is a link (reused workspace), never a competing calc, and separate from physical families", async () => {
  const s = await seed();
  const r = await call(s.store);
  expect(r.body.families.VALUATION_COVERAGE.linkOnly).toBe(true);
  expect(r.body.families.VALUATION_COVERAGE.href).toMatch(/inventory-valuation/);
  expect(r.body.families.VALUATION_COVERAGE.count).toBeUndefined();  // no fabricated number
});

test("one failed source family becomes unavailable, not zero; the rest still load; reads mutate nothing", async () => {
  const s = await seed();
  const cid = s.company._id;
  await rawItem({ companyId: cid, name: "Neg", sku: `N-${seq}`, unit: "kg", quantity: -1, variants: [] });
  const before = await StockLedger.countDocuments({});
  jest.spyOn(StockLedger, "countDocuments").mockRejectedValue(new Error("db down"));
  const r = await call(s.store);
  expect(r.status).toBe(200);
  expect(r.body.families.MOVEMENT_UNCERTAIN.available).toBe(false);      // NOT count 0
  expect(r.body.families.MOVEMENT_UNCERTAIN.count).toBeUndefined();
  expect(r.body.families.MOVEMENT_UNCERTAIN.unavailableReason).toMatch(/could not be read/i);
  expect(r.body.families.NEGATIVE_BALANCE.count).toBe(1);                // others fine
  jest.restoreAllMocks();
  // A GET wrote nothing.
  expect(await StockLedger.countDocuments({})).toBe(before);
});

test("pagination is database-backed and bounded", async () => {
  const s = await seed();
  const cid = s.company._id;
  const item = oid();
  await rawItem({ _id: item, companyId: cid, name: "Item", sku: `P-${seq}`, unit: "kg", quantity: 5, variants: [] });
  const docs = Array.from({ length: 30 }, (_, i) => ({ companyId: cid, rawItem: item, direction: "CREDIT", txnType: "COMPENSATING", isVoided: false, applicationState: "PENDING", correctionReason: `c${i}`, createdAt: new Date(Date.now() + i * 1000) }));
  await StockLedger.collection.insertMany(docs);
  const p1 = await call(s.store, "?family=MOVEMENT_UNCERTAIN&pageSize=25&page=1");
  expect(p1.body.pagination.total).toBe(30);
  expect(p1.body.rows.length).toBe(25);
  expect(p1.body.pagination.totalPages).toBe(2);
  const p2 = await call(s.store, "?family=MOVEMENT_UNCERTAIN&pageSize=25&page=2");
  expect(p2.body.rows.length).toBe(5);
});
