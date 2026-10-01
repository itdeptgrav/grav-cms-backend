// test/store-purchase/inventory-stock.route.test.js
//
// The Inventory "Stock" register read model — its honesty contract:
//   · company-scoped (another company's stock is never returned);
//   · On hand = RawItem.quantity, exactly (the physical total);
//   · ownership PARTITIONS the physical total — company = physical − customer-held —
//     so customer property is labelled and is NOT folded into the company figure;
//   · reserved = Σ LocationReservation.reserved; available = Σ over USABLE
//     locations of max(0, onHand − reserved) — quarantine/receiving/unassigned are
//     never available;
//   · unassigned stock (held but not put away) is visible, not hidden;
//   · a genuine zero is "out of stock" — distinct from a dimension that could not
//     be read, which is "unavailable" and never a silent zero;
//   · unlike units are never summed — the response carries no cross-item quantity;
//   · invalid query values fail safe (fall back to "all"), never 500.
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
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationReservation = require("../../models/CMS_Models/Inventory/Operations/LocationReservation");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const Employee = require("../../models/Employee");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/overview/stock", require("../../routes/CMS_Routes/Inventory/overview/stock"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/overview/stock`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const token = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const call = (emp, qs = "") => fetch(`${base}${qs}`, { headers: { Authorization: `Bearer ${token(emp)}` } })
  .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Store", ...o });
const byId = (rows, id) => rows.find((r) => r.rawItemId === String(id));

async function seed() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Stk Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const other = await Acc_Company.create({ companyName: `Other ${n}`, booksFromDate: new Date("2026-04-01") });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `stk${n}@demo.example`, biometricId: `SK${n}` });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });

  // A warehouse with a USABLE bin and a QUARANTINE bin.
  const wh = await Warehouse.create({
    companyId: company._id, name: `WH ${n}`, shortName: `WH${n}`, status: "Active",
    locations: [
      { code: "STOCK", name: "Usable stock", type: "USABLE_STOCK", status: "Active" },
      { code: "QUAR", name: "Quarantine", type: "QUARANTINE", status: "Active" },
    ],
  });
  const usable = wh.locations.find((l) => l.type === "USABLE_STOCK");
  const quar = wh.locations.find((l) => l.type === "QUARANTINE");

  // itemA — 100 pcs physical. Placed: 60 usable + 10 quarantine (assigned 70,
  // so 30 unassigned). Reserved 20 at the usable bin. Holds 25 of customer stock.
  const itemA = await RawItem.create({ companyId: company._id, name: `Cotton ${n}`, sku: `A-${n}`, unit: "pcs", quantity: 100 });
  await LocationBalance.create([
    { companyId: company._id, itemId: itemA._id, warehouseId: wh._id, locationId: usable._id, onHand: 60 },
    { companyId: company._id, itemId: itemA._id, warehouseId: wh._id, locationId: quar._id, onHand: 10 },
    { companyId: company._id, itemId: itemA._id, warehouseId: null, locationId: null, onHand: 70 }, // assigned-total sentinel
  ]);
  await LocationReservation.create({ companyId: company._id, itemId: itemA._id, warehouseId: wh._id, locationId: usable._id, reserved: 20 });
  await CustomerMaterialLot.create({
    companyId: company._id, customerId: oid(), orderRef: `ORD-${n}`, executionFileId: oid(), expectationId: oid(),
    documentRef: `DOC-${n}`, expectationRevisionNo: 1, expectationLineRef: "L1",
    rawItemId: itemA._id, goodsReceiptId: oid(), goodsReceiptNumber: `GR-${n}`, goodsReceiptLineId: oid(),
    receiptUnit: "pcs", receiptQuantity: 25, baseUnit: "pcs", baseQuantity: 25,
    availableQuantity: 25, issuedQuantity: 0, returnedQuantity: 0, status: "HELD", receivedAt: new Date(),
  });

  // itemB — a genuine zero (out of stock), different unit.
  const itemB = await RawItem.create({ companyId: company._id, name: `Buttons ${n}`, sku: `B-${n}`, unit: "kg", quantity: 0 });

  // itemC — 50 m physical, never placed at any location (all unassigned), third unit.
  const itemC = await RawItem.create({ companyId: company._id, name: `Zipper ${n}`, sku: `C-${n}`, unit: "m", quantity: 50 });

  // Another company's item — must never appear.
  await RawItem.create({ companyId: other._id, name: `Foreign ${n}`, sku: `Z-${n}`, unit: "pcs", quantity: 999 });

  return { company, other, store, wh, itemA, itemB, itemC };
}

test("company-scoped: another company's stock is never returned", async () => {
  const s = await seed();
  const r = await call(s.store);
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  const names = r.body.rows.map((x) => x.name);
  expect(names).toEqual(expect.arrayContaining([s.itemA.name, s.itemB.name, s.itemC.name]));
  expect(names.some((x) => x.startsWith("Foreign"))).toBe(false);
  expect(r.body.pagination.total).toBe(3);   // a COUNT of items, never a summed quantity
});

test("On hand is RawItem.quantity, and ownership partitions it (company = physical − customer)", async () => {
  const s = await seed();
  const { rows } = (await call(s.store)).body;
  const a = byId(rows, s.itemA._id);
  expect(a.physicalOnHand).toBe(100);
  expect(a.ownership.available).toBe(true);
  expect(a.ownership.customerOwnedOnHand).toBe(25);
  expect(a.ownership.companyOwnedOnHand).toBe(75);        // 100 − 25, NOT 100
  expect(a.ownership.hasCustomerOwned).toBe(true);
  expect(a.ownership.label).toBe("mixed");
  // The whole physical total is never labelled company-owned.
  expect(a.ownership.companyOwnedOnHand + a.ownership.customerOwnedOnHand).toBe(a.physicalOnHand);
});

test("reserved and available follow the reservation rule; quarantine/unassigned are not available", async () => {
  const s = await seed();
  const { rows } = (await call(s.store)).body;
  const a = byId(rows, s.itemA._id);
  expect(a.reserved).toBe(20);
  expect(a.usableOnHand).toBe(60);
  expect(a.available).toBe(40);              // 60 usable − 20 reserved; the 10 in quarantine is NOT added
  expect(a.location.available).toBe(true);
  expect(a.location.quarantine).toBe(10);
  expect(a.location.unassigned).toBe(30);    // 100 physical − 70 assigned
  expect(a.location.main.code).toBe("STOCK");
  expect(a.stockState).toBe("available");
});

test("a genuine zero is out_of_stock — with every dimension still available (not 'unavailable')", async () => {
  const s = await seed();
  const { rows } = (await call(s.store)).body;
  const b = byId(rows, s.itemB._id);
  expect(b.physicalOnHand).toBe(0);
  expect(b.stockState).toBe("out_of_stock");
  expect(b.ownership.available).toBe(true);      // read succeeded; there is simply no customer stock
  expect(b.ownership.label).toBe("company");
  expect(b.available).toBe(0);                   // a measured zero, a real answer
});

test("unassigned stock (held but never put away) is visible", async () => {
  const s = await seed();
  const { rows } = (await call(s.store)).body;
  const c = byId(rows, s.itemC._id);
  expect(c.physicalOnHand).toBe(50);
  expect(c.location.unassigned).toBe(50);        // nothing placed
  expect(c.stockState).toBe("unassigned");
});

test("a failed reservation read makes reserved/available UNAVAILABLE, never a silent zero", async () => {
  const s = await seed();
  jest.spyOn(LocationReservation, "find").mockImplementation(() => { throw new Error("db down"); });
  const r = await call(s.store);
  expect(r.status).toBe(200);                    // the register still loads
  expect(r.body.dimensions.reserved.available).toBe(false);
  expect(r.body.dimensions.available.available).toBe(false);
  const a = byId(r.body.rows, s.itemA._id);
  expect(a.reserved).toBeNull();                 // NOT 0 — that would say "nothing reserved"
  expect(a.available).toBeNull();                // NOT free
  expect(a.partial).toBe(true);
  // On-hand and ownership do not depend on reservations, so they still hold.
  expect(a.physicalOnHand).toBe(100);
  expect(a.ownership.available).toBe(true);
});

test("unlike units are never summed — every row carries its own unit and there is no cross-item quantity", async () => {
  const s = await seed();
  const r = await call(s.store);
  const units = r.body.rows.map((x) => x.unit).sort();
  expect(units).toEqual(["kg", "m", "pcs"]);     // three distinct units, side by side
  // The only aggregate the response carries is a COUNT of items, never a summed
  // physical quantity across the (incompatible) units.
  expect(r.body.pagination.total).toBe(3);
  expect(r.body).not.toHaveProperty("totalOnHand");
  expect(r.body).not.toHaveProperty("onHandTotal");
});

test("ownership and state filters narrow server-side, honestly", async () => {
  const s = await seed();
  const mixed = (await call(s.store, "?ownership=mixed")).body;
  expect(mixed.rows.map((x) => x.rawItemId)).toEqual([String(s.itemA._id)]);
  const oos = (await call(s.store, "?state=out_of_stock")).body;
  expect(oos.rows.map((x) => x.rawItemId)).toEqual([String(s.itemB._id)]);
  const customerOnly = (await call(s.store, "?ownership=customer")).body;
  expect(customerOnly.rows.length).toBe(0);      // itemA is mixed, not customer-only
});

test("the attention lenses are server-driven and consistent with the register beneath them", async () => {
  const s = await seed();
  // Needs storage location → only the unassigned item (itemC).
  const storage = (await call(s.store, "?lens=needs_storage")).body;
  expect(storage.rows.map((x) => x.rawItemId)).toEqual([String(s.itemC._id)]);
  expect(storage.filters.lens).toBe("needs_storage");
  // Customer property → the item that holds customer material, INCLUDING mixed (itemA).
  const customer = (await call(s.store, "?lens=customer")).body;
  expect(customer.rows.map((x) => x.rawItemId)).toEqual([String(s.itemA._id)]);
  // Needs review → quarantine-only or ownership-indeterminate. None in this seed —
  // and out-of-stock (itemB) is NOT "needs review", so the lens is empty here.
  const review = (await call(s.store, "?lens=needs_review")).body;
  expect(review.rows.length).toBe(0);
});

test("the low-stock lens is the reorder rule the Materials catalogue used to monitor", async () => {
  const s = await seed();
  // Held but at/below its own minimum → low. Zero held → out of stock, NOT low.
  const low = await RawItem.create({ companyId: s.company._id, name: `Thread ${seq}`, sku: `L-${seq}`, unit: "pcs", quantity: 5, minStock: 20 });
  await RawItem.create({ companyId: s.company._id, name: `Elastic ${seq}`, sku: `E-${seq}`, unit: "m", quantity: 0, minStock: 20 });
  const r = (await call(s.store, "?lens=low_stock")).body;
  expect(r.filters.lens).toBe("low_stock");
  expect(r.rows.map((x) => x.rawItemId)).toEqual([String(low._id)]);
  expect(r.rows[0].reorder).toEqual({ minStock: 20, low: true });
  // No minimum set (0) is never "low" — the seed's itemA/itemC are not in the lens.
  const all = (await call(s.store)).body;
  expect(byId(all.rows, s.itemC._id).reorder.low).toBe(false);
});

test("an invalid lens falls back to 'all' (never a misleading partial view)", async () => {
  const s = await seed();
  const r = await call(s.store, "?lens=nonsense");
  expect(r.status).toBe(200);
  expect(r.body.filters.lens).toBe("all");
  expect(r.body.pagination.total).toBe(3);
});

test("invalid query values fail safe (fall back to 'all'), never 500", async () => {
  const s = await seed();
  const r = await call(s.store, "?ownership=nonsense&state=whatever&lens=bogus&page=abc&pageSize=-5");
  expect(r.status).toBe(200);
  expect(r.body.filters.ownership).toBe("all");
  expect(r.body.filters.state).toBe("all");
  expect(r.body.filters.lens).toBe("all");
  expect(r.body.pagination.page).toBe(1);
  expect(r.body.pagination.total).toBe(3);       // nothing was filtered out
});
