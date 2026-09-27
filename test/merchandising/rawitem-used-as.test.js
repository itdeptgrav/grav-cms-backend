// test/merchandising/rawitem-used-as.test.js
//
// "USED AS" — the Store-owned classification that decides where a raw item may
// be selected in a product BOM. Proves the security-critical guarantees:
//   · electrical goods, machine spares, dies and factory consumables can never
//     appear in ANY product BOM picker;
//   · Materials & Trims shows only its four permitted classes;
//   · Sample Packaging / Packaging shows only sample packaging;
//   · "All" is restricted to the active section, not the whole catalogue;
//   · a forged category or section cannot widen the set, and search cannot
//     discover an excluded record;
//   · company isolation holds;
//   · the migration classifies the obvious and leaves the ambiguous.
"use strict";

const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const catalogue = require("../../services/merchandising/materialCatalogue.service");
const packagingItems = require("../../services/merchandising/packagingItems.service");
const usedAs = require("../../models/CMS_Models/Inventory/Products/usedAs");
const migration = require("../../scripts/migrations/rawitem-used-as-classification");

let seq = 0;
const mkItem = (companyId, over = {}) => {
  const n = ++seq;
  return RawItem.create({
    companyId, name: over.name || `Item ${n}`, sku: over.sku || `SKU-${n}`,
    category: over.category || "", customCategory: over.customCategory || "",
    unit: "pcs", minStock: 0, maxStock: 10,
    ...(over.usedAs !== undefined ? { usedAs: over.usedAs } : {}),
  });
};
const codes = (rows) => rows.map((r) => r.usedAs).sort();

/* ═══ THE CLASSIFIER ═══════════════════════════════════════════════════════ */

describe("classifyByCategory", () => {
  test("classifies the obvious cases and refuses to guess the ambiguous", () => {
    expect(usedAs.classifyByCategory("Zippers")).toBe(usedAs.USED_AS.TRIM);
    expect(usedAs.classifyByCategory("Woven Fabric")).toBe(usedAs.USED_AS.FABRIC);
    expect(usedAs.classifyByCategory("Main Label")).toBe(usedAs.USED_AS.LABEL);
    expect(usedAs.classifyByCategory("Polybags")).toBe(usedAs.USED_AS.SAMPLE_PACKAGING);
    expect(usedAs.classifyByCategory("MCB Board")).toBe(usedAs.USED_AS.ELECTRICAL_ITEM);
    expect(usedAs.classifyByCategory("Electrical Cable")).toBe(usedAs.USED_AS.ELECTRICAL_ITEM);
    expect(usedAs.classifyByCategory("Machine Parts")).toBe(usedAs.USED_AS.MACHINE_SPARE);
    expect(usedAs.classifyByCategory("Cutting Dies")).toBe(usedAs.USED_AS.TOOL_OR_EQUIPMENT);
    expect(usedAs.classifyByCategory("Maintenance Consumable")).toBe(usedAs.USED_AS.FACTORY_CONSUMABLE);
    /* Ambiguous → left for a person. */
    expect(usedAs.classifyByCategory("Accessories")).toBe(usedAs.USED_AS.NOT_CLASSIFIED);
    expect(usedAs.classifyByCategory("")).toBe(usedAs.USED_AS.NOT_CLASSIFIED);
    /* "electrical tape" must NOT read as a trim. */
    expect(usedAs.classifyByCategory("Electrical Tape")).toBe(usedAs.USED_AS.ELECTRICAL_ITEM);
  });
});

/* ═══ MATERIALS & TRIMS PICKER ═════════════════════════════════════════════ */

async function seedCatalogue(companyId) {
  await mkItem(companyId, { name: "Cotton Fabric", sku: "F1", usedAs: "FABRIC" });
  await mkItem(companyId, { name: "Metal Zip", sku: "T1", usedAs: "TRIM" });
  await mkItem(companyId, { name: "Woven Label", sku: "L1", usedAs: "LABEL" });
  await mkItem(companyId, { name: "Metal Buckle", sku: "A1", usedAs: "GARMENT_ACCESSORY" });
  await mkItem(companyId, { name: "MCB Board 32A", sku: "E1", usedAs: "ELECTRICAL_ITEM" });
  await mkItem(companyId, { name: "Gear Grease", sku: "C1", usedAs: "FACTORY_CONSUMABLE" });
  await mkItem(companyId, { name: "Sewing Machine Foot", sku: "M1", usedAs: "MACHINE_SPARE" });
  await mkItem(companyId, { name: "Poly Bag 12x15", sku: "P1", usedAs: "SAMPLE_PACKAGING" });
  await mkItem(companyId, { name: "Mystery Widget", sku: "N1", usedAs: "NOT_CLASSIFIED" });
}

describe("Materials & Trims section", () => {
  test("shows only the four garment-component classes; excludes everything else", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "MATERIALS" });
    expect(codes(out.rows)).toEqual(["FABRIC", "GARMENT_ACCESSORY", "LABEL", "TRIM"]);
    expect(out.usedAsAllowed).toEqual(["FABRIC", "TRIM", "LABEL", "GARMENT_ACCESSORY"]);
    /* Every excluded class is absent — proved by name, so a rename can't hide it. */
    const names = out.rows.map((r) => r.name);
    for (const banned of ["MCB Board 32A", "Gear Grease", "Sewing Machine Foot", "Poly Bag 12x15", "Mystery Widget"]) {
      expect(names).not.toContain(banned);
    }
    expect(out.rows.every((r) => r.usedAsLabel)).toBe(true);
  });

  test("\"All\" (no category) is the four, never the whole catalogue or sample packaging", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "MATERIALS", category: "" });
    expect(out.rows).toHaveLength(4);
    expect(codes(out.rows)).not.toContain("SAMPLE_PACKAGING");
  });

  test("a forged category cannot widen the section (SAMPLE_PACKAGING within MATERIALS stays the four)", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "MATERIALS", category: "SAMPLE_PACKAGING" });
    expect(codes(out.rows)).toEqual(["FABRIC", "GARMENT_ACCESSORY", "LABEL", "TRIM"]);
  });

  test("a garbage section falls back to the safe MATERIALS set, never the whole catalogue", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "MACHINE_SPARE" });
    expect(out.rows.map((r) => r.usedAs).every((u) => usedAs.SECTION_USED_AS.MATERIALS.includes(u))).toBe(true);
  });

  test("search cannot discover an excluded record by name", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "MATERIALS", q: "MCB" });
    expect(out.rows).toHaveLength(0);
  });

  test("a single category narrows to exactly that class", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "MATERIALS", category: "TRIM" });
    expect(codes(out.rows)).toEqual(["TRIM"]);
  });
});

/* ═══ SAMPLE PACKAGING SECTION ═════════════════════════════════════════════ */

describe("Sample Packaging section", () => {
  test("shows only sample packaging; excludes fabrics, electrical and the rest", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedCatalogue(companyId);
    const out = await catalogue.search({ companyId }, { section: "PACKAGING" });
    expect(codes(out.rows)).toEqual(["SAMPLE_PACKAGING"]);
    expect(out.usedAsAllowed).toEqual(["SAMPLE_PACKAGING"]);
  });
});

/* ═══ THE PACKAGING PICKER (the tab that used to load the whole catalogue) ══ */

describe("packagingItems.searchPackagingItems", () => {
  test("returns only sample packaging — MCB boards and cables never appear", async () => {
    const companyId = new mongoose.Types.ObjectId();
    const journey = await SalesJourney.create({ companyId, journeyId: `SJ-${++seq}`, name: "J", accountId: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(), ownerName: "O" });
    const style = await SampleStyle.create({ sampleStyleId: `SS-${++seq}`, styleCode: `SC-${seq}`, productName: "Tee", journeyId: journey._id });
    await mkItem(companyId, { name: "Poly Bag Small", sku: "PP1", usedAs: "SAMPLE_PACKAGING" });
    await mkItem(companyId, { name: "Poly cable duct", sku: "PP2", usedAs: "ELECTRICAL_ITEM" });   // 'poly' matches the term
    await mkItem(companyId, { name: "Poly machine cover", sku: "PP3", usedAs: "MACHINE_SPARE" });
    const out = await packagingItems.searchPackagingItems({ companyId }, { styleId: style._id, q: "poly" });
    expect(out.items.map((i) => i.name)).toEqual(["Poly Bag Small"]);
    expect(out.items[0].usedAs).toBe("SAMPLE_PACKAGING");
  });
});

/* ═══ COMPANY ISOLATION ════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("one company's picker never sees another company's items", async () => {
    const coA = new mongoose.Types.ObjectId();
    const coB = new mongoose.Types.ObjectId();
    await mkItem(coA, { name: "A Fabric", sku: "AF1", usedAs: "FABRIC" });
    await mkItem(coB, { name: "B Fabric", sku: "BF1", usedAs: "FABRIC" });
    const out = await catalogue.search({ companyId: coA }, { section: "MATERIALS" });
    expect(out.rows.map((r) => r.name)).toEqual(["A Fabric"]);
  });
});

/* ═══ THE MIGRATION ════════════════════════════════════════════════════════ */

describe("classification migration", () => {
  async function seedForMigration(companyId) {
    await mkItem(companyId, { name: "Nylon Zip", sku: "MZ", category: "Zippers" });        // → TRIM
    await mkItem(companyId, { name: "MCB 6A", sku: "MM", category: "MCB Board" });          // → ELECTRICAL_ITEM
    await mkItem(companyId, { name: "Poly 10x14", sku: "MP", category: "Polybags" });       // → SAMPLE_PACKAGING
    await mkItem(companyId, { name: "Generic bits", sku: "MA", category: "Accessories" });  // → NOT_CLASSIFIED
  }

  test("dry run classifies the obvious, leaves the ambiguous, writes nothing", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedForMigration(companyId);
    const { report } = await migration.run({ companyId, apply: false });
    expect(report.applied).toBe(false);
    expect(report.before.wouldClassify).toBe(3);
    expect(report.before.stayUnclassified).toBe(1);
    expect(report.before.leftUnclassified[0].name).toBe("Generic bits");
    expect(report.before.projected.TRIM).toBe(1);
    expect(report.before.projected.ELECTRICAL_ITEM).toBe(1);
    expect(report.before.projected.SAMPLE_PACKAGING).toBe(1);
    expect(report.before.tabVisible.materialsAndTrims).toBe(1);   // just the zip
    expect(report.before.tabVisible.samplePackaging).toBe(1);
    /* Nothing written. */
    const still = await RawItem.countDocuments({ companyId, usedAs: usedAs.USED_AS.NOT_CLASSIFIED });
    expect(still).toBe(4);
  });

  test("apply writes the classifications, never overwrites a set value, and is idempotent", async () => {
    const companyId = new mongoose.Types.ObjectId();
    await seedForMigration(companyId);
    /* A value a person already set is protected. */
    await mkItem(companyId, { name: "Hand-set Fabric", sku: "HS", category: "Zippers", usedAs: "FABRIC" });

    const first = await migration.run({ companyId, apply: true, jsonPath: null });
    expect(first.report.applied).toBe(true);
    expect(first.report.result.modifiedCount).toBe(3);
    expect((await RawItem.findOne({ companyId, sku: "MZ" })).usedAs).toBe("TRIM");
    expect((await RawItem.findOne({ companyId, sku: "MM" })).usedAs).toBe("ELECTRICAL_ITEM");
    /* The hand-set one kept its FABRIC despite a "Zippers" category. */
    expect((await RawItem.findOne({ companyId, sku: "HS" })).usedAs).toBe("FABRIC");
    /* Ambiguous stays for review. */
    expect((await RawItem.findOne({ companyId, sku: "MA" })).usedAs).toBe("NOT_CLASSIFIED");

    /* Re-running changes nothing more. */
    const second = await migration.run({ companyId, apply: true, jsonPath: null });
    expect(second.report.result.modifiedCount).toBe(0);
  });
});
