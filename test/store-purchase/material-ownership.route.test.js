// test/store-purchase/material-ownership.route.test.js
//
// CUSTOMER OWNERSHIP ON THE MATERIAL CATALOGUE — AT THE WIRE.
//
// What is held: the item form's switch is persisted and enforced on the
// server; a customer-owned material must name a customer this company can
// reach; company-owned never keeps a stale customer; a client that says
// nothing gets company owned; editing the default touches nothing that owns
// stock; the reads the receiving screens use carry the default; and the
// valuation engine ignores the default entirely, because ownership of stock
// is a fact of each movement.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Customer = require("../../models/Customer_Models/Customer");
const Account = require("../../models/CMS_Models/Sales/Account");
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

/** A Store approver in one company; a second company makes the deployment
    multi-company, so reach is decided by Accounts and not by the allowance. */
async function seed({ soleCompany = false } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Own Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const other = soleCompany ? null
    : await Acc_Company.create({ companyName: `Own Other ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `own${n}@test.example`;
  const emp = await Employee.create({ firstName: "O", lastName: `L${n}`, email, biometricId: `OWN${n}`, isActive: true, gender: "Other", department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "O" });
  const token = jwt.sign({ id: String(emp._id), email, name: "O", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

  const mine = await Customer.create({ name: `Northwind ${n}`, email: `nw${n}@buyer.com`, profile: { companyName: `Northwind Ltd ${n}` } });
  await Account.create({ companyId: co._id, companyName: `Northwind account ${n}`, status: "active", linkedCustomer: mine._id });
  const foreign = await Customer.create({ name: `Foreign ${n}`, email: `fo${n}@buyer.com` });
  if (other) await Account.create({ companyId: other._id, companyName: `Foreign account ${n}`, status: "active", linkedCustomer: foreign._id });
  const inactive = await Customer.create({ name: `Retired ${n}`, email: `re${n}@buyer.com`, isActive: false });
  await Account.create({ companyId: co._id, companyName: `Retired account ${n}`, status: "active", linkedCustomer: inactive._id });

  return { co, other, token, mine, foreign, inactive };
}

const material = (over = {}) => ({
  name: `Poplin ${++seq}`, category: "Fabric", unit: "Metre", usedAs: "FABRIC",
  minStock: 0, maxStock: 10, ...over,
});

test("1 · the switch off, or absent, creates a company-owned material with no customer", async () => {
  const s = await seed();
  const off = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "COMPANY_OWNED" }) });
  expect(off.status).toBe(201);
  expect(off.body.rawItem).toMatchObject({ defaultOwnership: "COMPANY_OWNED", owningCustomerId: null });

  /* 5 · an existing client that never heard of the field. */
  const silent = await call("/", { method: "POST", token: s.token, body: material() });
  expect(silent.status).toBe(201);
  expect(silent.body.rawItem).toMatchObject({ defaultOwnership: "COMPANY_OWNED", owningCustomerId: null });
  expect(silent.body.rawItem.owningCustomer).toEqual({ customerCode: "", customerLabel: "", customerName: "" });
});

test("2 · customer owned with a reachable customer is persisted with its snapshot, and creates no stock", async () => {
  const s = await seed();
  const r = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(s.mine._id) }) });
  expect(r.status).toBe(201);
  expect(r.body.rawItem.defaultOwnership).toBe("CUSTOMER_OWNED");
  expect(String(r.body.rawItem.owningCustomerId)).toBe(String(s.mine._id));
  expect(r.body.rawItem.owningCustomer).toMatchObject({ customerLabel: s.mine.profile.companyName, customerName: s.mine.name });
  expect(r.body.rawItem.owningCustomer.customerCode).toBe(s.mine.customerId);
  const stored = await RawItem.findById(r.body.rawItem._id).lean();
  expect(stored.quantity).toBe(0);
  expect(stored.stockTransactions).toEqual([]);
  expect(stored.variants.every((v) => v.quantity === 0)).toBe(true);

  /* 9 · the detail and the list carry the saved classification. */
  const one = await call(`/${stored._id}`, { token: s.token });
  expect(one.body.rawItem).toMatchObject({ defaultOwnership: "CUSTOMER_OWNED", owningCustomer: { customerName: s.mine.name } });
  const list = await call("/?limit=50", { token: s.token });
  const row = list.body.rawItems.find((x) => String(x._id) === String(stored._id));
  expect(row).toMatchObject({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(s.mine._id) });
});

test("3 · customer owned without a customer is refused and nothing is saved", async () => {
  const s = await seed();
  const before = await RawItem.countDocuments({ companyId: s.co._id });
  for (const body of [
    material({ defaultOwnership: "CUSTOMER_OWNED" }),
    material({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: "" }),
    material({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: null }),
  ]) {
    const r = await call("/", { method: "POST", token: s.token, body });
    expect(r.status).toBe(400);
    expect(r.body.reason || r.body.details?.reason).toBe("OWNING_CUSTOMER_REQUIRED");
  }
  expect(await RawItem.countDocuments({ companyId: s.co._id })).toBe(before);
});

test("4 · an invalid, foreign, inactive or unknown customer is one refusal, and an unknown word is another", async () => {
  const s = await seed();
  for (const owningCustomerId of ["nope", String(s.foreign._id), String(s.inactive._id), String(new mongoose.Types.ObjectId())]) {
    const r = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId }) });
    expect([400, 404]).toContain(r.status);
    expect(r.body.success).toBe(false);
    if (r.status === 404) expect(r.body.message).toBe(materialOwnership.CUSTOMER_NOT_AVAILABLE);
  }
  const word = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "LEASED" }) });
  expect(word.status).toBe(400);
  expect(await RawItem.countDocuments({ companyId: s.co._id })).toBe(0);
});

test("6 · a company-owned save clears a stale customer id, on create and on edit", async () => {
  const s = await seed();
  const created = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "COMPANY_OWNED", owningCustomerId: String(s.mine._id) }) });
  expect(created.status).toBe(201);
  expect(created.body.rawItem.owningCustomerId).toBeNull();

  const item = await RawItem.create({
    companyId: s.co._id, name: "Stale", sku: `ST-${++seq}`, unit: "Metre", category: "Fabric", usedAs: "FABRIC",
    defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: s.mine._id, owningCustomer: { customerLabel: "Northwind Ltd" },
  });
  const edited = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { defaultOwnership: "COMPANY_OWNED", owningCustomerId: String(s.mine._id) } });
  expect(edited.status).toBe(200);
  const after = await RawItem.findById(item._id).lean();
  expect(after.defaultOwnership).toBe("COMPANY_OWNED");
  expect(after.owningCustomerId).toBeNull();
  expect(after.owningCustomer).toEqual({ customerCode: "", customerLabel: "", customerName: "" });
});

test("7 · 8 · editing the default requires the customer when switching on, and touches no stock, lot or movement", async () => {
  const s = await seed();
  const txId = new mongoose.Types.ObjectId();
  const item = await RawItem.create({
    companyId: s.co._id, name: "Held", sku: `HD-${++seq}`, unit: "Metre", category: "Fabric", usedAs: "FABRIC",
    quantity: 30,
    variants: [{ combination: ["Default"], quantity: 30 }],
    stockTransactions: [
      { type: "ADD", quantity: 20, ownership: "COMPANY", previousQuantity: 0, newQuantity: 20, unitPrice: 5 },
      { _id: txId, type: "ADD", quantity: 10, ownership: "CUSTOMER", previousQuantity: 20, newQuantity: 30 },
    ],
  });
  const before = await RawItem.findById(item._id).lean();

  const noCustomer = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { defaultOwnership: "CUSTOMER_OWNED" } });
  expect(noCustomer.status).toBe(400);

  const on = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(s.mine._id) } });
  expect(on.status).toBe(200);
  const after = await RawItem.findById(item._id).lean();
  expect(after.defaultOwnership).toBe("CUSTOMER_OWNED");
  expect(String(after.owningCustomerId)).toBe(String(s.mine._id));
  /* Everything that owns stock is byte-for-byte what it was. */
  expect(after.quantity).toBe(before.quantity);
  expect(after.variants.map((v) => v.quantity)).toEqual(before.variants.map((v) => v.quantity));
  expect(after.stockTransactions.map((m) => [String(m._id), m.type, m.quantity, m.ownership]))
    .toEqual(before.stockTransactions.map((m) => [String(m._id), m.type, m.quantity, m.ownership]));

  /* An edit that says nothing about ownership leaves it exactly as it stands. */
  const rename = await call(`/${item._id}`, { method: "PUT", token: s.token, body: { name: "Held, renamed" } });
  expect(rename.status).toBe(200);
  const kept = await RawItem.findById(item._id).lean();
  expect(kept.defaultOwnership).toBe("CUSTOMER_OWNED");
  expect(String(kept.owningCustomerId)).toBe(String(s.mine._id));
});

test("10 · the reads a receiving screen uses carry the material's default and its customer", async () => {
  const s = await seed();
  const owned = await RawItem.create({
    companyId: s.co._id, name: "Customer poplin", sku: `CP-${++seq}`, unit: "Metre", category: "Fabric", usedAs: "FABRIC",
    defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: s.mine._id,
    owningCustomer: { customerCode: "CUST-0001", customerLabel: "Northwind Ltd", customerName: "Northwind" },
  });
  const plain = await RawItem.create({ companyId: s.co._id, name: "Own thread", sku: `OT-${++seq}`, unit: "Cone", category: "Thread", usedAs: "TRIM" });
  const foreignItem = await RawItem.create({ companyId: s.other._id, name: "Elsewhere", sku: `EL-${++seq}`, unit: "m", category: "Fabric" });

  const defaults = await materialOwnership.materialDefaultsFor({ companyId: s.co._id }, [owned._id, plain._id, foreignItem._id, "junk"]);
  expect(defaults.get(String(owned._id))).toEqual({
    defaultOwnership: "CUSTOMER_OWNED", label: "Customer property",
    customer: { id: String(s.mine._id), label: "Northwind Ltd", name: "Northwind", code: "CUST-0001" },
  });
  expect(defaults.get(String(plain._id))).toEqual({ defaultOwnership: "COMPANY_OWNED", label: "Company owned", customer: null });
  expect(defaults.has(String(foreignItem._id))).toBe(false);

  /* The Merchandising catalogue picker — where a material is chosen for a
     customer-supplied document — carries the same view on every row. */
  const picked = await materialCatalogue.search({ companyId: s.co._id }, { q: "poplin", category: "FABRIC" });
  const row = picked.rows.find((r) => r.rawItemId === String(owned._id));
  expect(row.ownership).toEqual(defaults.get(String(owned._id)));
});

test("11 · the valuation engine values company movements only, whatever the catalogue default says", () => {
  const item = {
    name: "Poplin", unit: "Metre", quantity: 30,
    defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: new mongoose.Types.ObjectId(),
    stockTransactions: [
      { _id: new mongoose.Types.ObjectId(), type: "ADD", quantity: 20, ownership: "COMPANY", previousQuantity: 0, newQuantity: 20, unitPrice: 5, createdAt: new Date("2026-09-01") },
      { _id: new mongoose.Types.ObjectId(), type: "ADD", quantity: 10, ownership: "CUSTOMER", previousQuantity: 20, newQuantity: 30, createdAt: new Date("2026-09-02") },
    ],
  };
  const v = valueItem(item);
  expect(v.physicalOnHand).toBe(30);
  expect(v.companyOwnedOnHand).toBe(20);
  expect(v.customerOwnedOnHand).toBe(10);
  expect(v.knownValue).toBe(100);
  /* And a company-owned default cannot pull customer stock into company value. */
  const w = valueItem({ ...item, defaultOwnership: "COMPANY_OWNED", owningCustomerId: null });
  expect([w.companyOwnedOnHand, w.customerOwnedOnHand, w.knownValue]).toEqual([20, 10, 100]);
});

test("the customer search offers exactly the customers a save would accept", async () => {
  const s = await seed();
  const r = await call("/data/customers?search=", { token: s.token });
  expect(r.status).toBe(200);
  const ids = r.body.customers.map((c) => c.id);
  expect(ids).toContain(String(s.mine._id));
  expect(ids).not.toContain(String(s.foreign._id));
  expect(ids).not.toContain(String(s.inactive._id));
  expect(r.body.customers.find((c) => c.id === String(s.mine._id))).toMatchObject({ label: s.mine.profile.companyName, name: s.mine.name });
});

test("in a sole-company deployment any active customer may own a material", async () => {
  const s = await seed({ soleCompany: true });
  const r = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(s.foreign._id) }) });
  expect(r.status).toBe(201);
  const inactive = await call("/", { method: "POST", token: s.token, body: material({ defaultOwnership: "CUSTOMER_OWNED", owningCustomerId: String(s.inactive._id) }) });
  expect(inactive.status).toBe(404);
});
