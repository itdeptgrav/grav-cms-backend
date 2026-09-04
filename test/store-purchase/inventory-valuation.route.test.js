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
const StockLedger = require("../../models/CMS_Models/Inventory/Operations/StockLedger");
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

// A compensating correction row (StockLedger), in a chosen application state.
const mkCorrection = (company, item, { direction = "DEBIT", quantity = 2, applicationState } = {}) =>
  StockLedger.create({
    companyId: company._id, rawItem: item._id, rawItemName: item.name, rawItemSku: item.sku,
    txnType: "COMPENSATING", direction, quantity,
    ...(applicationState ? { applicationState } : {}), // omit → undefined (legacy/unknown)
    createdAt: new Date(clock++),
  });

// ── V1 CORRECTION — only APPLIED corrections move stock ──────────────────────
describe("compensating corrections respect applicationState", () => {
  async function itemWithReceipt(storedQty) {
    const { a } = await companies();
    const it = await mkItem(a, { name: "Corrected", quantity: storedQty, stockTransactions: [receipt(10, 100)] });
    const { token } = await actor(a);
    return { a, it, token };
  }

  // 1
  test("a PENDING correction changes neither quantity nor value", async () => {
    const { a, it, token } = await itemWithReceipt(10);
    await mkCorrection(a, it, { direction: "DEBIT", quantity: 2, applicationState: "PENDING" });
    const r = await call(`/api/cms/inventory/valuation/item/${it._id}`, { token });
    expect(r.body.valuation.replayedOnHand).toBe(10); // unchanged
    expect(r.body.valuation.knownValue).toBe(1000);    // unchanged
    expect(r.body.valuation.pendingCorrections).toBe(1);
  });

  // 2
  test("a correction with no/unknown application state changes nothing", async () => {
    const { a, it, token } = await itemWithReceipt(10);
    await mkCorrection(a, it, { direction: "DEBIT", quantity: 2 }); // applicationState undefined
    const r = await call(`/api/cms/inventory/valuation/item/${it._id}`, { token });
    expect(r.body.valuation.replayedOnHand).toBe(10);
    expect(r.body.valuation.knownValue).toBe(1000);
    expect(r.body.valuation.pendingCorrections).toBe(1);
  });

  // 3
  test("an APPLIED correction participates exactly once", async () => {
    const { a, it, token } = await itemWithReceipt(8); // stored reflects the applied −2
    await mkCorrection(a, it, { direction: "DEBIT", quantity: 2, applicationState: "APPLIED" });
    const r = await call(`/api/cms/inventory/valuation/item/${it._id}`, { token });
    expect(r.body.valuation.replayedOnHand).toBe(8);  // 10 − 2, once
    expect(r.body.valuation.knownValue).toBe(800);    // 1000 − 2×100, once (not 600)
    expect(r.body.valuation.reconciled).toBe(true);
    expect(r.body.valuation.pendingCorrections).toBe(0);
  });
});

// ── V1 CORRECTION — indeterminate value in the company summary ───────────────
describe("indeterminate items in the company summary", () => {
  // 10
  test("an indeterminate item is excluded from known value and counted separately", async () => {
    const { a } = await companies();
    await mkItem(a, { name: "Clean", quantity: 5, stockTransactions: [receipt(5, 100)] }); // known 500
    // priced receipt + unpriced receipt + an outbound → indeterminate
    await mkItem(a, {
      name: "Muddy", quantity: 12,
      stockTransactions: [receipt(10, 100), noPriceIn(5), { _id: oid(), type: "REDUCE", quantity: 3, createdAt: new Date(clock++) }],
    });
    const { token } = await actor(a);
    const sum = await call("/api/cms/inventory/valuation/summary", { token });
    expect(sum.body.summary.knownInventoryValue).toBe(500); // Muddy contributes nothing
    expect(sum.body.summary.indeterminateCount).toBe(1);
    const list = await call("/api/cms/inventory/valuation?status=indeterminate", { token });
    expect(list.body.items.map((i) => i.name)).toEqual(["Muddy"]);
    const muddy = list.body.items[0];
    expect(muddy.knownValue).toBeNull(); // never ₹0
    expect(muddy.avgCost).toBeNull();
    expect(muddy.replayedOnHand).toBe(12); // quantity still known
  });
});

// ── V1 CORRECTION — overview isolation and honesty ──────────────────────────
describe("overview valuation isolation", () => {
  // 11 + 12
  test("an unresolvable company yields valuation unavailable and NO valuation query", async () => {
    await companies();
    const token = tokenFor({ id: String(new mongoose.Types.ObjectId()), email: "nobody@test.example", name: "Nobody" });
    const valuationModule = require("../../routes/CMS_Routes/Inventory/valuation/inventoryValuationRoutes");
    const spy = jest.spyOn(valuationModule, "summarizeCompany");
    try {
      const ov = await call("/api/cms/inventory/overview", { token });
      expect(ov.status).toBe(200);
      expect(ov.body.stats.rawItems.valuationAvailable).toBe(false);
      expect(ov.body.stats.rawItems.knownInventoryValue).toBeNull();
      expect(typeof ov.body.stats.rawItems.valuationMessage).toBe("string");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // 13
  test("another company's value never enters the overview", async () => {
    const { a, b } = await companies();
    await mkItem(a, { name: "A-only", quantity: 4, stockTransactions: [receipt(4, 100)] }); // 400
    await mkItem(b, { name: "B-only", quantity: 4, stockTransactions: [receipt(4, 999)] });
    const { token } = await actor(a);
    const ov = await call("/api/cms/inventory/overview", { token });
    expect(ov.body.stats.rawItems.valuationAvailable).toBe(true);
    expect(ov.body.stats.rawItems.knownInventoryValue).toBe(400); // never includes B
  });

  // 14
  test("legacy StockItem value is not combined into RawItem known value", async () => {
    const { a } = await companies();
    await mkItem(a, { name: "RawOnly", quantity: 4, stockTransactions: [receipt(4, 100)] });
    const { token } = await actor(a);
    const [ov, sum] = await Promise.all([
      call("/api/cms/inventory/overview", { token }),
      call("/api/cms/inventory/valuation/summary", { token }),
    ]);
    // RawItem known value equals the raw-only engine answer …
    expect(ov.body.stats.rawItems.knownInventoryValue).toBe(sum.body.summary.knownInventoryValue);
    // … and there is no combined "known inventory value".
    expect(ov.body.stats.overall.totalValue).toBeNull();
    expect(ov.body.stats.overall.combinedValueAvailable).toBe(false);
    expect(ov.body.stats.stockItems.valuationBasis).toBe("legacy");
  });
});
