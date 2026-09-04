// test/store-purchase/inventory-valuation.route.test.js
//
// Inventory Valuation V1 — the read-only, company-scoped API. The moving-average
// arithmetic is pinned by inventory-valuation.engine.test.js; this suite pins
// the API contract: company isolation, server-side pagination/filter/sort, that
// the overview and the report return the SAME answer, and that valuing mutates
// nothing.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/valuation", require("../../routes/CMS_Routes/Inventory/valuation/inventoryValuationRoutes"));
  app.use("/api/cms/inventory/overview", require("../../routes/CMS_Routes/Inventory/overview/overview"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign(
    { id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "Test Store", email: "store@test.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );

const call = (path, { token } = {}) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

// An actor with exactly one company membership — requireTenant auto-resolves it.
async function actor(company) {
  const n = ++seq;
  const email = `val${n}@test.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "Val", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "Val" });
  return { email, token: tokenFor({ id: String(employeeRef), email, name: "Val" }) };
}

const oid = () => new mongoose.Types.ObjectId();
let clock = 1_700_000_000_000;
const receipt = (qty, price) => ({ _id: oid(), type: "ADD", quantity: qty, unitPrice: price, purchaseOrderId: oid(), createdAt: new Date(clock++) });
const noPriceIn = (qty) => ({ _id: oid(), type: "ADD", quantity: qty, createdAt: new Date(clock++) });

const mkItem = (company, over = {}) =>
  RawItem.create({
    companyId: company._id,
    sku: over.sku || `RAW-${++seq}`,
    name: over.name || `Item ${seq}`,
    unit: over.unit || "KG",
    category: over.category || "Fabric",
    quantity: over.quantity != null ? over.quantity : 0,
    variants: over.variants || [],
    stockTransactions: over.stockTransactions || [],
  });

async function companies() {
  const a = await Acc_Company.create({ companyName: `Acme ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const b = await Acc_Company.create({ companyName: `Borealis ${++seq}`, booksFromDate: new Date("2026-04-01") });
  return { a, b };
}

// ── 15 — company isolation ──────────────────────────────────────────────────
describe("company isolation", () => {
  test("another company's items are excluded from list and summary", async () => {
    const { a, b } = await companies();
    await mkItem(a, { name: "A-cotton", quantity: 10, stockTransactions: [receipt(10, 100)] }); // known 1000
    await mkItem(b, { name: "B-silk", quantity: 10, stockTransactions: [receipt(10, 500)] });    // known 5000
    const { token } = await actor(a);

    const list = await call("/api/cms/inventory/valuation", { token });
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe("A-cotton");

    const sum = await call("/api/cms/inventory/valuation/summary", { token });
    expect(sum.body.summary.knownInventoryValue).toBe(1000); // never 6000
  });
});

// ── 16 — server-side pagination, filter, sort ───────────────────────────────
describe("server-side pagination, filter and sort", () => {
  async function threeItems() {
    const { a } = await companies();
    await mkItem(a, { name: "Alpha", category: "X", quantity: 3, stockTransactions: [receipt(3, 100)] }); // 300
    await mkItem(a, { name: "Bravo", category: "Y", quantity: 2, stockTransactions: [receipt(2, 50)] });  // 100
    await mkItem(a, { name: "Charlie", category: "X", quantity: 2, stockTransactions: [receipt(2, 100)] }); // 200
    const { token } = await actor(a);
    return { a, token };
  }

  test("pagination returns one page and a true total", async () => {
    const { token } = await threeItems();
    const p1 = await call("/api/cms/inventory/valuation?limit=2&page=1&sort=item&dir=asc", { token });
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.pagination.total).toBe(3);
    expect(p1.body.pagination.pages).toBe(2);
    const p2 = await call("/api/cms/inventory/valuation?limit=2&page=2&sort=item&dir=asc", { token });
    expect(p2.body.items).toHaveLength(1);
  });

  test("search filters by name/sku on the server", async () => {
    const { token } = await threeItems();
    const r = await call("/api/cms/inventory/valuation?search=Brav", { token });
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].name).toBe("Bravo");
  });

  test("category filters on the server", async () => {
    const { token } = await threeItems();
    const r = await call("/api/cms/inventory/valuation?category=X", { token });
    expect(r.body.items.map((i) => i.name).sort()).toEqual(["Alpha", "Charlie"]);
  });

  test("sort by known value orders highest first", async () => {
    const { token } = await threeItems();
    const r = await call("/api/cms/inventory/valuation?sort=value&dir=desc", { token });
    expect(r.body.items.map((i) => i.name)).toEqual(["Alpha", "Charlie", "Bravo"]);
  });

  test("status filter selects incomplete items", async () => {
    const { a } = await companies();
    await mkItem(a, { name: "Priced", quantity: 5, stockTransactions: [receipt(5, 100)] });
    await mkItem(a, { name: "Unpriced", quantity: 5, stockTransactions: [noPriceIn(5)] });
    const { token } = await actor(a);
    const inc = await call("/api/cms/inventory/valuation?status=incomplete", { token });
    expect(inc.body.items.map((i) => i.name)).toEqual(["Unpriced"]);
    const comp = await call("/api/cms/inventory/valuation?status=complete", { token });
    expect(comp.body.items.map((i) => i.name)).toEqual(["Priced"]);
  });
});

// ── 17 — overview and report agree ──────────────────────────────────────────
describe("overview and report use the same valuation answer", () => {
  test("overview knownInventoryValue equals the report summary", async () => {
    const { a } = await companies();
    await mkItem(a, { name: "One", quantity: 4, stockTransactions: [receipt(4, 100), receipt(4, 200)] }); // avg 150, qty replay 8? stored 4 → unreconciled but value from valued pool
    await mkItem(a, { name: "Two", quantity: 3, stockTransactions: [receipt(3, 100)] });
    const { token } = await actor(a);
    const rep = await call("/api/cms/inventory/valuation/summary", { token });
    const ov = await call("/api/cms/inventory/overview", { token });
    expect(ov.status).toBe(200);
    expect(ov.body.stats.rawItems.knownInventoryValue).toBe(rep.body.summary.knownInventoryValue);
    // The overview must not label an incomplete figure a plain "total".
    expect(ov.body.stats.rawItems).toHaveProperty("incompleteItems");
  });
});

// ── 18 (route half) — valuing mutates nothing ───────────────────────────────
describe("read-only", () => {
  test("valuing does not mutate the item, its transactions or its balance", async () => {
    const { a } = await companies();
    const it = await mkItem(a, { name: "Immutable", quantity: 7, stockTransactions: [receipt(10, 100), { _id: oid(), type: "REDUCE", quantity: 3, createdAt: new Date(clock++) }] });
    const { token } = await actor(a);
    const before = await RawItem.findById(it._id).lean();

    await call("/api/cms/inventory/valuation", { token });
    await call("/api/cms/inventory/valuation/summary", { token });
    await call(`/api/cms/inventory/valuation/item/${it._id}`, { token });

    const after = await RawItem.findById(it._id).lean();
    expect(after.quantity).toBe(before.quantity);
    expect(after.stockTransactions).toHaveLength(before.stockTransactions.length);
    expect(JSON.stringify(after.stockTransactions)).toBe(JSON.stringify(before.stockTransactions));
  });

  test("item detail returns a valuation with variant evidence", async () => {
    const { a } = await companies();
    const vId = oid();
    const it = await mkItem(a, {
      name: "WithVariant", quantity: 10,
      variants: [{ _id: vId, sku: "V-RED", quantity: 10, combination: ["Red"] }],
      stockTransactions: [{ _id: oid(), type: "VARIANT_ADD", quantity: 10, unitPrice: 100, purchaseOrderId: oid(), variantId: vId, createdAt: new Date(clock++) }],
    });
    const { token } = await actor(a);
    const r = await call(`/api/cms/inventory/valuation/item/${it._id}`, { token });
    expect(r.status).toBe(200);
    expect(r.body.valuation.knownValue).toBe(1000);
    expect(Array.isArray(r.body.valuation.variants)).toBe(true);
    expect(r.body.valuation.variants[0].knownValue).toBe(1000);
    expect(r.body.note).toMatch(/freight/i);
  });
});
