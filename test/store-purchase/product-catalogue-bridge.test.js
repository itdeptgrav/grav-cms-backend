// test/store-purchase/product-catalogue-bridge.test.js
//
// STORE → FINISHED PRODUCTS & BOM (read-only bridge) — the pure derivation.
// Driven with in-memory StockItem-shaped docs: single-company safety, honest
// counts, no costing, no stock-balance claims, explicit missing-data states.
"use strict";

const {
  assessDeployment, catalogueRow, catalogueDetail, distinctBomMaterialCount, classification, LIMITATIONS,
} = require("../../services/storePurchase/productCatalogueBridge.service");

// A StockItem-shaped fixture (only the fields the bridge reads).
const stockItem = (over = {}) => ({
  _id: "si1", name: "Polo Shirt", reference: "POLO-01", category: "Tops",
  genderCategory: "Male", productType: "Goods", hsnCode: "6105", unit: "Units",
  isActive: true, status: "In Stock", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-06-01"),
  images: ["img-a.jpg"],
  operations: [
    { type: "Stitching", operationCode: "ST", machine: "SNLS", machineType: "Single Needle", minutes: 2, seconds: 30, totalSeconds: 150, operatorSalary: 999, operatorCost: 5 },
    { type: "Cutting", machineType: "Cutter", minutes: 1, seconds: 0, totalSeconds: 60 },
  ],
  variants: [
    { sku: "POLO-01-S", attributes: [{ name: "Size", value: "S" }], quantityOnHand: 12, images: ["v-s.jpg"],
      rawItems: [
        { rawItemId: "rawFab", rawItemName: "Cotton", rawItemSku: "COT", quantity: 1.2, unit: "m", requiredQuantity: 1.1, allowancePercent: 9, unitCost: 100, totalCost: 120 },
        { rawItemId: "rawBtn", rawItemName: "Button", quantity: 6, unit: "pcs", unitCost: 1, totalCost: 6 },
      ] },
    { sku: "POLO-01-M", attributes: [{ name: "Size", value: "M" }], quantityOnHand: 8, images: [],
      rawItems: [
        { rawItemId: "rawFab", rawItemName: "Cotton", quantity: 1.4, unit: "m", unitCost: 100, totalCost: 140 }, // SAME material as S
      ] },
  ],
  ...over,
});

/* ── Deployment safety (single-company premise) ────────────────────────────── */

test("1 · the bridge is available only in an unambiguously single-company deployment", () => {
  assert_(assessDeployment(1).available === true, "one company → available");
  const none = assessDeployment(0);
  assert_(none.available === false && none.code === "NO_COMPANY", "zero companies → refused");
  const many = assessDeployment(2);
  assert_(many.available === false && many.code === "MULTI_COMPANY", "multi-company → refused");
  assert_(/not company-scoped/i.test(many.reason), "refusal explains why");
});

/* ── Honest counts ─────────────────────────────────────────────────────────── */

test("2 · a register row derives variant, BOM-material and operation counts", () => {
  const r = catalogueRow(stockItem());
  assert_(r.variantCount === 2, "two variants");
  assert_(r.operationCount === 2, "two operations");
  // Cotton is shared across both variants → counted ONCE; Button once. = 2.
  assert_(r.bomMaterialCount === 2, `distinct BOM materials = 2, got ${r.bomMaterialCount}`);
  assert_(r.hasBom === true && r.hasVariants === true, "presence flags");
  assert_(r.classification === "Male", "classification from gender");
  assert_(r.lifecycle === "Active", "lifecycle from isActive");
});

test("2b · distinct BOM count never multiplies a shared material by variant count", () => {
  assert_(distinctBomMaterialCount(stockItem()) === 2, "shared Cotton counted once");
  const noBom = stockItem({ variants: [{ sku: "X", rawItems: [] }] });
  assert_(distinctBomMaterialCount(noBom) === 0, "no BOM → 0");
});

test("3 · an archived product reads lifecycle Archived, not a stock label", () => {
  const r = catalogueRow(stockItem({ isActive: false, status: "Out of Stock" }));
  assert_(r.lifecycle === "Archived", "isActive:false → Archived");
  // The stock enum is NOT surfaced as the lifecycle.
  assert_(r.lifecycle !== "Out of Stock", "stock enum is not the lifecycle");
});

/* ── No costing, no stock-balance leakage ──────────────────────────────────── */

test("4 · a register row carries NO cost and NO stock-balance fields", () => {
  const r = catalogueRow(stockItem());
  for (const k of ["totalQuantityOnHand", "quantityOnHand", "averageCost", "averageSalesPrice", "inventoryValue", "cost", "stockOnHand"]) {
    assert_(!(k in r), `row must not expose ${k}`);
  }
});

test("5 · BOM lines expose quantity/unit but NEVER cost", () => {
  const d = catalogueDetail(stockItem());
  const line = d.variants[0].bomLines[0];
  assert_(line.rawItemName === "Cotton" && line.quantity === 1.2 && line.unit === "m", "BOM qty/unit shown");
  assert_(line.requiredQuantity === 1.1 && line.allowancePercent === 9, "required/allowance shown");
  for (const k of ["unitCost", "totalCost", "cost"]) assert_(!(k in line), `BOM line must not expose ${k}`);
});

test("6 · operations expose SAM/time but NEVER operator salary or cost", () => {
  const d = catalogueDetail(stockItem());
  const op = d.operations[0];
  assert_(op.type === "Stitching" && op.totalSeconds === 150, "SAM/time shown");
  for (const k of ["operatorSalary", "operatorCost", "cost"]) assert_(!(k in op), `operation must not expose ${k}`);
});

/* ── Legacy quantity: shown per variant, never a Store balance, never summed ── */

test("7 · variant legacy quantity is per-variant only, never a combined total", () => {
  const d = catalogueDetail(stockItem());
  assert_(d.variants[0].legacyRecordedQuantity === 12, "S variant qty");
  assert_(d.variants[1].legacyRecordedQuantity === 8, "M variant qty");
  // No combined/total quantity field anywhere on the detail.
  for (const k of ["totalQuantityOnHand", "totalLegacyQuantity", "stockOnHand", "availableStock"]) {
    assert_(!(k in d), `detail must not combine quantities as ${k}`);
  }
  assert_(/legacy recorded/i.test(LIMITATIONS.legacyQuantity) && /not Store stock/i.test(LIMITATIONS.legacyQuantity), "limitation states it plainly");
});

/* ── Explicit missing-data states ──────────────────────────────────────────── */

test("8 · detail flags missing variants, BOM, operations and images honestly", () => {
  const bare = catalogueDetail({ _id: "si2", name: "Bare", reference: "B-1", category: "X", variants: [], operations: [], images: [] });
  assert_(bare.missing.variants === true, "no variants");
  assert_(bare.missing.bom === true, "no BOM");
  assert_(bare.missing.operations === true, "no operations");
  assert_(bare.missing.images === true, "no images");

  const full = catalogueDetail(stockItem());
  assert_(full.missing.variants === false && full.missing.bom === false && full.missing.operations === false && full.missing.images === false, "full product has nothing missing");
});

test("9 · detail preserves identity, additional names and classification", () => {
  const d = catalogueDetail(stockItem({ additionalNames: ["Golf Shirt", ""] }));
  assert_(d.reference === "POLO-01" && d.hsnCode === "6105" && d.unit === "Units", "identity");
  assert_(d.additionalNames.length === 1 && d.additionalNames[0] === "Golf Shirt", "blank alt names dropped");
  assert_(d.classification === "Male", "classification");
});

// Tiny assert shim (kept dependency-free like the other pure suites).
function assert_(cond, msg) { if (!cond) throw new Error(msg || "assertion failed"); }
