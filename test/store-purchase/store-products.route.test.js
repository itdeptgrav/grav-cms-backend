// test/store-purchase/store-products.route.test.js
//
// STORE → FINISHED PRODUCTS & BOM (read-only bridge) — the route.
// Proves it reads StockItem (not RawItem / Acc_StockItem), is read-only,
// server-paginates and searches, derives variant/BOM/operation counts, refuses
// a multi-company deployment, and never leaks cost or stock-balance figures.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/store/products",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/StorePurchase/storeProducts"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const req = (path, token, opts = {}) =>
  fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...opts })
    .then(async (r) => { const t = await r.text(); let body = null; try { body = JSON.parse(t || "null"); } catch { body = null; } return { status: r.status, body }; });

async function actor(company, over = {}) {
  const n = ++seq;
  const email = `pc${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "PC", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "PC" });
  return tokenFor({ id: String(employeeRef), email, ...over });
}
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

// A raw material keeps a STABLE id across variants (as real BOM data does), so
// a material shared by two variants is genuinely the same rawItemId.
const variant = (sku, qty, rawItems = []) => ({
  sku, attributes: [{ name: "Size", value: sku.slice(-1) }], quantityOnHand: qty, cost: 100, salesPrice: 200,
  rawItems: rawItems.map((ri) => ({ rawItemId: ri.id || new mongoose.Types.ObjectId(), rawItemName: ri.name, quantity: ri.qty, unit: ri.unit, unitCost: 10, totalCost: 20 })),
});

async function seedProduct(over = {}) {
  const n = ++seq;
  return StockItem.create({
    name: over.name || `Product ${n}`, reference: over.reference || `REF-${n}`,
    category: over.category || "Tops", unit: "Units", genderCategory: over.gender || "Male", productType: "Goods",
    createdBy: new mongoose.Types.ObjectId(), isActive: over.isActive !== false, status: over.status || "In Stock",
    variants: over.variants || [], operations: over.operations || [],
    images: over.images || [],
  });
}

test("lists StockItem products with derived counts and server pagination", async () => {
  const co = await company();
  const token = await actor(co);
  const fab = { id: new mongoose.Types.ObjectId(), name: "Cotton", qty: 1.2, unit: "m" };
  await seedProduct({ name: "Polo", reference: "POLO", variants: [variant("POLO-S", 5, [fab, { name: "Btn", qty: 6, unit: "pcs" }]), variant("POLO-M", 3, [fab])],
    operations: [{ type: "Stitch", totalSeconds: 150 }, { type: "Cut", totalSeconds: 60 }] });
  for (let i = 0; i < 4; i++) await seedProduct({ name: `Tee ${i}`, reference: `TEE-${i}`, variants: [variant(`TEE-${i}-S`, 1, [])] });

  const r = await req(`/api/cms/store/products?pageSize=3&page=1`, token);
  expect(r.status).toBe(200);
  expect(r.body.available).toBe(true);
  expect(r.body.pagination.totalItems).toBe(5);            // full backend count, not the page
  expect(r.body.pagination.totalPages).toBe(2);
  expect(r.body.products).toHaveLength(3);
  expect(r.body.companyScoped).toBe(false);

  const polo = (await req(`/api/cms/store/products?search=Polo`, token)).body.products[0];
  expect(polo.variantCount).toBe(2);
  expect(polo.operationCount).toBe(2);
  expect(polo.bomMaterialCount).toBe(2);   // Cotton shared across variants → once; Btn once
});

test("search matches name / reference / variant sku, server-side", async () => {
  const co = await company();
  const token = await actor(co);
  await seedProduct({ name: "Alpha Shirt", reference: "ALP-1", variants: [variant("ALP-1-S", 1, [])] });
  await seedProduct({ name: "Beta Pant", reference: "BET-1", variants: [variant("ZZZSKU-9", 1, [])] });

  expect((await req(`/api/cms/store/products?search=alpha`, token)).body.products.map((p) => p.reference)).toEqual(["ALP-1"]);
  expect((await req(`/api/cms/store/products?search=BET-1`, token)).body.products.map((p) => p.name)).toEqual(["Beta Pant"]);
  expect((await req(`/api/cms/store/products?search=ZZZSKU`, token)).body.products.map((p) => p.reference)).toEqual(["BET-1"]);
});

test("the data source is StockItem — every listed id resolves to a StockItem", async () => {
  const co = await company();
  const token = await actor(co);
  await seedProduct({ name: "Src Check", reference: "SRC-1", variants: [variant("SRC-1-S", 1, [])] });
  const r = await req(`/api/cms/store/products`, token);
  const ids = r.body.products.map((p) => p.id);
  const found = await StockItem.countDocuments({ _id: { $in: ids } });
  expect(found).toBe(ids.length);
  expect(r.body.pagination.totalItems).toBe(await StockItem.countDocuments({ isActive: { $ne: false } }));
});

test("hasBom and hasVariants filters narrow the result honestly", async () => {
  const co = await company();
  const token = await actor(co);
  await seedProduct({ name: "WithBom", reference: "WB-1", variants: [variant("WB-1-S", 1, [{ name: "Cotton", qty: 1, unit: "m" }])] });
  await seedProduct({ name: "NoBom", reference: "NB-1", variants: [variant("NB-1-S", 1, [])] });
  await seedProduct({ name: "NoVariant", reference: "NV-1", variants: [] });

  expect((await req(`/api/cms/store/products?hasBom=true`, token)).body.products.map((p) => p.reference)).toEqual(["WB-1"]);
  const withVariants = (await req(`/api/cms/store/products?hasVariants=true`, token)).body.products.map((p) => p.reference).sort();
  expect(withVariants).toEqual(["NB-1", "WB-1"]);
});

test("refuses a multi-company deployment with a clear unavailable state, not a product list", async () => {
  const co = await company();
  await company();                 // a second company → deployment no longer single-company
  const token = await actor(co);
  await seedProduct({ name: "Hidden", reference: "HID-1", variants: [variant("HID-1-S", 1, [])] });
  const r = await req(`/api/cms/store/products`, token);
  expect(r.status).toBe(200);
  expect(r.body.available).toBe(false);
  expect(r.body.unavailable.code).toBe("MULTI_COMPANY");
  expect(r.body.products).toBeUndefined();
});

test("is read-only — no create/update/delete route exists", async () => {
  const co = await company();
  const token = await actor(co);
  const p = await seedProduct({ name: "RO", reference: "RO-1", variants: [variant("RO-1-S", 1, [])] });
  expect((await req(`/api/cms/store/products`, token, { method: "POST", body: "{}" })).status).toBe(404);
  expect((await req(`/api/cms/store/products/${p._id}`, token, { method: "PUT", body: "{}" })).status).toBe(404);
  expect((await req(`/api/cms/store/products/${p._id}`, token, { method: "DELETE" })).status).toBe(404);
});

test("detail returns identity, variants with BOM, operations, missing states — and no cost/stock leakage", async () => {
  const co = await company();
  const token = await actor(co);
  const p = await seedProduct({ name: "Detail", reference: "DET-1",
    variants: [variant("DET-1-S", 7, [{ name: "Cotton", qty: 1.2, unit: "m" }])],
    operations: [{ type: "Stitch", machineType: "SNLS", minutes: 2, seconds: 30, totalSeconds: 150, operatorSalary: 999, operatorCost: 5 }] });

  const r = await req(`/api/cms/store/products/${p._id}`, token);
  expect(r.status).toBe(200);
  const d = r.body.product;
  expect(d.reference).toBe("DET-1");
  expect(d.variants[0].legacyRecordedQuantity).toBe(7);
  expect(d.variants[0].bomLines[0].rawItemName).toBe("Cotton");
  expect(d.operations[0].totalSeconds).toBe(150);
  expect(d.missing.bom).toBe(false);
  // No costing anywhere.
  expect("unitCost" in d.variants[0].bomLines[0]).toBe(false);
  expect("operatorSalary" in d.operations[0]).toBe(false);
  expect(JSON.stringify(d)).not.toMatch(/totalQuantityOnHand|averageCost|inventoryValue/);
  // A store role gets NO editor link.
  expect(r.body.editor.accessible).toBe(false);
});

test("an owning-app role is offered a Products & BOM editor deep link; a store role is not", async () => {
  const co = await company();
  const pmToken = await actor(co, { role: "project_manager" });
  const p = await seedProduct({ name: "Edit", reference: "ED-1", variants: [variant("ED-1-S", 1, [])] });
  const r = await req(`/api/cms/store/products/${p._id}`, pmToken);
  expect(r.body.editor.accessible).toBe(true);
  expect(r.body.editor.href).toContain(String(p._id));
});

test("a missing product is a 404, and an archived one still resolves for reference", async () => {
  const co = await company();
  const token = await actor(co);
  expect((await req(`/api/cms/store/products/${new mongoose.Types.ObjectId()}`, token)).status).toBe(404);
  const archived = await seedProduct({ name: "Old", reference: "OLD-1", isActive: false, variants: [variant("OLD-1-S", 1, [])] });
  const r = await req(`/api/cms/store/products/${archived._id}`, token);
  expect(r.status).toBe(200);
  expect(r.body.product.lifecycle).toBe("Archived");
});
