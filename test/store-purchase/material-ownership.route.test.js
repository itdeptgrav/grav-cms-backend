// test/store-purchase/material-ownership.route.test.js
//
// CUSTOMER OWNERSHIP ON THE MATERIAL CATALOGUE — AT THE WIRE.
//
// What is held: the item form's switch is persisted and enforced on the
// server; only the two words are accepted; a client that says nothing gets
// company owned; editing the default touches nothing that owns stock; the
// reads the receiving screens use carry the default; and the valuation
// engine ignores the default entirely, because ownership of stock is a fact
// of each movement.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const materialOwnership = require("../../services/inventory/materialOwnership.service");
const materialCatalogue = require("../../services/merchandising/materialCatalogue.service");
const { valueItem } = require("../../services/inventoryValuation.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/raw-items", require("../../routes/CMS_Routes/Inventory/Products/rawItems"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/raw-items`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Own Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const other = await Acc_Company.create({ companyName: `Own Other ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `own${n}@test.example`;
  const emp = await Employee.create({ firstName: "O", lastName: `L${n}`, email, biometricId: `OWN${n}`, isActive: true, gender: "Other", department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "O" });
  const token = jwt.sign({ id: String(emp._id), email, name: "O", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
  return { co, other, token };
}

const material = (over = {}) => ({
  name: `Poplin ${++seq}`, category: "Fabric", unit: "Metre", usedAs: "FABRIC",
  minStock: 0, maxStock: 10, ...over,
});

test("1 · 5 · the switch off, or absent, creates a company-owned material", async () => {
  const s = await seed();
  const off = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "COMPANY_OWNED" }) });
  expect(off.status).toBe(201);
  expect(off.body.rawItem.defaultOwnership).toBe("COMPANY_OWNED");
  /* An existing client that never heard of the field. */
  const silent = await call("/", { method: "POST", token: s.token, body: material() });
  expect(silent.status).toBe(201);
  expect(silent.body.rawItem.defaultOwnership).toBe("COMPANY_OWNED");
});

test("2 · the switch on is persisted as customer property, and creates no stock", async () => {
  const s = await seed();
  const r = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "CUSTOMER_OWNED" }) });
  expect(r.status).toBe(201);
  expect(r.body.rawItem.defaultOwnership).toBe("CUSTOMER_OWNED");
  const stored = await RawItem.findById(r.body.rawItem._id).lean();
  expect(stored.defaultOwnership).toBe("CUSTOMER_OWNED");
  expect(stored.quantity).toBe(0);
  expect(stored.stockTransactions).toEqual([]);
  expect(stored.variants.every((v) => v.quantity === 0)).toBe(true);

  /* 9 · the detail and the list carry the saved classification. */
  const one = await call(`/${stored._id}`, { token: s.token });
  expect(one.body.rawItem.defaultOwnership).toBe("CUSTOMER_OWNED");
  const list = await call("/?limit=50", { token: s.token });
  expect(list.body.rawItems.find((x) => String(x._id) === String(stored._id)).defaultOwnership).toBe("CUSTOMER_OWNED");
});

test("3 · 4 · anything but the two words is refused and nothing is saved", async () => {
  const s = await seed();
  for (const defaultOwnership of ["LEASED", "", "yes", 1]) {
    const r = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership }) });
    expect(r.status).toBe(400);
    expect(r.body.success).toBe(false);
  }
  expect(await RawItem.countDocuments({ companyId: s.co._id })).toBe(0);
  /* The words are matched without regard to case. */
  const lower = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "customer_owned" }) });
  expect(lower.status).toBe(201);
  expect(lower.body.rawItem.defaultOwnership).toBe("CUSTOMER_OWNED");
});

test("7 · 8 · editing the default changes the default only — no stock, lot or movement is touched", async () => {
  const s = await seed();
  const item = await RawItem.create({
    companyId: s.co._id, name: "Held", sku: `HD-${++seq}`, unit: "Metre", category: "Fabric", usedAs: "FABRIC",
    quantity: 30,
    variants: [{ combination: ["Default"], quantity: 30 }],
    stockTransactions: [
      { type: "ADD", quantity: 20, ownership: "COMPANY", previousQuantity: 0, newQuantity: 20, unitPrice: 5 },
      { type: "ADD", quantity: 10, ownership: "CUSTOMER", previousQuantity: 20, newQuantity: 30 },
    ],
  });
  const before = await RawItem.findById(item._id).lean();

  const on = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { defaultOwnership: "CUSTOMER_OWNED" } });
  expect(on.status).toBe(200);
  const after = await RawItem.findById(item._id).lean();
  expect(after.defaultOwnership).toBe("CUSTOMER_OWNED");
  /* Everything that owns stock is byte-for-byte what it was. */
  expect(after.quantity).toBe(before.quantity);
  expect(after.variants.map((v) => v.quantity)).toEqual(before.variants.map((v) => v.quantity));
  expect(after.stockTransactions.map((m) => [String(m._id), m.type, m.quantity, m.ownership]))
    .toEqual(before.stockTransactions.map((m) => [String(m._id), m.type, m.quantity, m.ownership]));

  /* Back off; and an edit that says nothing leaves it exactly as it stands. */
  const off = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { defaultOwnership: "COMPANY_OWNED" } });
  expect(off.status).toBe(200);
  expect((await RawItem.findById(item._id).lean()).defaultOwnership).toBe("COMPANY_OWNED");
  const rename = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { name: "Held, renamed", defaultOwnership: "CUSTOMER_OWNED" } });
  expect(rename.status).toBe(200);
  const kept = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { name: "Held, renamed again" } });
  expect(kept.status).toBe(200);
  expect((await RawItem.findById(item._id).lean()).defaultOwnership).toBe("CUSTOMER_OWNED");
  const bad = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { defaultOwnership: "LEASED" } });
  expect(bad.status).toBe(400);
});

test("10 · the reads a receiving screen uses carry the material's default", async () => {
  const s = await seed();
  const owned = await RawItem.create({ companyId: s.co._id, name: "Customer poplin", sku: `CP-${++seq}`, unit: "Metre", category: "Fabric", usedAs: "FABRIC", defaultOwnership: "CUSTOMER_OWNED" });
  const plain = await RawItem.create({ companyId: s.co._id, name: "Own thread", sku: `OT-${++seq}`, unit: "Cone", category: "Thread", usedAs: "TRIM" });
  const foreignItem = await RawItem.create({ companyId: s.other._id, name: "Elsewhere", sku: `EL-${++seq}`, unit: "m", category: "Fabric" });

  const defaults = await materialOwnership.materialDefaultsFor({ companyId: s.co._id }, [owned._id, plain._id, foreignItem._id, "junk"]);
  expect(defaults.get(String(owned._id))).toEqual({ defaultOwnership: "CUSTOMER_OWNED", label: "Customer property" });
  expect(defaults.get(String(plain._id))).toEqual({ defaultOwnership: "COMPANY_OWNED", label: "Company owned" });
  expect(defaults.has(String(foreignItem._id))).toBe(false);

  /* The Merchandising catalogue picker — where a material is chosen for a
     customer-supplied document — carries the same view on every row. */
  const picked = await materialCatalogue.search({ companyId: s.co._id }, { q: "poplin", category: "FABRIC" });
  const row = picked.rows.find((r) => r.rawItemId === String(owned._id));
  expect(row.ownership).toEqual({ defaultOwnership: "CUSTOMER_OWNED", label: "Customer property" });
});

test("11 · the valuation engine values company movements only, whatever the catalogue default says", () => {
  const item = {
    name: "Poplin", unit: "Metre", quantity: 30, defaultOwnership: "CUSTOMER_OWNED",
    stockTransactions: [
      { _id: new mongoose.Types.ObjectId(), type: "ADD", quantity: 20, ownership: "COMPANY", previousQuantity: 0, newQuantity: 20, unitPrice: 5, createdAt: new Date("2026-09-01") },
      { _id: new mongoose.Types.ObjectId(), type: "ADD", quantity: 10, ownership: "CUSTOMER", previousQuantity: 20, newQuantity: 30, createdAt: new Date("2026-09-02") },
    ],
  };
  const v = valueItem(item);
  expect([v.physicalOnHand, v.companyOwnedOnHand, v.customerOwnedOnHand, v.knownValue]).toEqual([30, 20, 10, 100]);
  const w = valueItem({ ...item, defaultOwnership: "COMPANY_OWNED" });
  expect([w.companyOwnedOnHand, w.customerOwnedOnHand, w.knownValue]).toEqual([20, 10, 100]);
});
