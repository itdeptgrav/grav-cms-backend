// test/merchandising/rawitem-company-ownership.test.js
//
// THE OWNERSHIP MIGRATION, AND THE FOUR THINGS IT REFUSES TO DO.
//
//   1  IT NEVER GUESSES THE COMPANY. Both the id and the company's own name
//      must be given, and the name must match what the company master holds —
//      so a typo in a 24-character hex string is a refusal rather than a
//      silent transfer of somebody else's catalogue.
//
//   2  IT NEVER TOUCHES AN OWNED ROW. Not the target's, and above all not
//      another company's. The filter cannot select one.
//
//   3  IT NEVER WRITES INTO A COLLISION. `{ companyId, sku }` is unique, and
//      `updateMany` against a unique index stops where it fails having already
//      written everything before it. Half a migrated catalogue is worse than
//      none of one, so the check is BEFORE the write.
//
//   4  IT WRITES NOTHING WITHOUT --apply, and says exactly what it would do.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const migration = require("../../scripts/migrations/rawitem-company-ownership");

let rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "rawitem_ownership" });
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

afterEach(async () => {
  await RawItem.deleteMany({});
  await Acc_Company.deleteMany({});
  /* Indexes outlive documents, so a test that builds one would otherwise
     change the world every later test runs in. */
  await RawItem.collection.dropIndex("companyId_1_sku_1").catch(() => {});
});

const company = (name) => Acc_Company.create({
  companyName: name, booksFromDate: new Date("2026-04-01"),
});

/* An item as the legacy data holds one: no companyId at all. */
const unowned = (over = {}) => RawItem.collection.insertOne({
  name: over.name || `Legacy item ${++seq}`,
  sku: over.sku === undefined ? `LEG-${seq}` : over.sku,
  category: over.category || "Fabric",
  variants: [], attributes: [],
  createdAt: new Date(), updatedAt: new Date(),
});

const owned = (co, over = {}) => RawItem.create({
  companyId: co._id,
  name: over.name || `Owned item ${++seq}`,
  sku: over.sku || `OWN-${seq}`,
  category: "Fabric",
});

/* ── THE INDEX IS PART OF THE FIXTURE, NOT AN ACCIDENT OF TEST ORDER ──────
   `{ companyId: 1, sku: 1 }` is declared unique, and Mongo treats a missing
   companyId as null — so WHERE THE INDEX HAS BEEN BUILT, two unowned items
   cannot already share a code. The duplicate cases below are reachable only
   on a collection where it never was, which is exactly the kind of database
   this migration is aimed at. Each test therefore says which world it is in
   rather than inheriting one from whatever ran before it. */
const dropUniqueIndex = async () => {
  await RawItem.collection.dropIndex("companyId_1_sku_1").catch(() => {});
};

const go = (co, over = {}) => migration.run({
  companyId: String(co._id), companyName: co.companyName, jsonPath: null, ...over,
});

/* ══ 1 — IT NEVER GUESSES THE COMPANY ═════════════════════════════════════ */

describe("the operator has to say which company, and be right", () => {
  test("a name that is not that id's name is refused, and says what the id is", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    await unowned();

    const out = await migration.run({
      companyId: String(grav._id), companyName: "GRAV Clothing Ltd", jsonPath: null, apply: true,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/is "GRAV CLOTHING PVT LTD", not "GRAV Clothing Ltd"/);
    /* And nothing moved. */
    expect(await RawItem.countDocuments({ companyId: grav._id })).toBe(0);
  });

  test("an id no company holds is refused", async () => {
    await company("GRAV CLOTHING PVT LTD");
    const out = await migration.run({
      companyId: String(new mongoose.Types.ObjectId()), companyName: "GRAV CLOTHING PVT LTD",
      jsonPath: null, apply: true,
    });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/No company has the id/);
  });

  test("an id alone is not enough", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    const out = await migration.run({ companyId: String(grav._id), companyName: "", jsonPath: null });
    expect(out.ok).toBe(false);
    expect(out.reason).toMatch(/Name the company as well as its id/);
  });

  test("spacing pasted from a screen is forgiven; a different name is not", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    await unowned();
    const spaced = await go(grav, { companyName: "  GRAV   CLOTHING PVT LTD " });
    expect(spaced.ok).toBe(true);
    const cased = await go(grav, { companyName: "grav clothing pvt ltd" });
    expect(cased.ok).toBe(false);
  });
});

/* ══ 2 — IT NEVER TOUCHES AN OWNED ROW ════════════════════════════════════ */

describe("what it will not touch", () => {
  test("another company's items are reported and left exactly as they are", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    const other = await company("Northstar Apparel Pvt Ltd");
    const theirs = await owned(other, { name: "Their fabric", sku: "THEIR-1" });
    await unowned({ sku: "LEG-A" });
    await unowned({ sku: "LEG-B" });

    const out = await go(grav, { apply: true });
    expect(out.ok).toBe(true);
    expect(out.report.before.ownedByOthers).toBe(1);
    expect(out.report.result.modifiedCount).toBe(2);

    const after = await RawItem.findById(theirs._id).lean();
    expect(String(after.companyId)).toBe(String(other._id));
    expect(await RawItem.countDocuments({ companyId: grav._id })).toBe(2);
  });

  test("items the target already owns are counted, not rewritten", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    const held = await owned(grav, { sku: "MINE-1" });
    await unowned({ sku: "LEG-A" });

    const out = await go(grav, { apply: true });
    expect(out.report.before.ownedByTarget).toBe(1);
    expect(out.report.result.modifiedCount).toBe(1);
    const after = await RawItem.findById(held._id).lean();
    expect(after.updatedAt.getTime()).toBe(held.updatedAt.getTime());
  });

  test("the selector cannot match a row that has a company", async () => {
    /* Stated against the exported filter itself, because this is the one
       property the whole script rests on. */
    const grav = await company("GRAV CLOTHING PVT LTD");
    await owned(grav);
    await unowned();
    expect(await RawItem.countDocuments(migration.UNOWNED)).toBe(1);
  });
});

/* ══ 3 — IT NEVER WRITES INTO A COLLISION ═════════════════════════════════ */

describe("a code the company already uses", () => {
  test("is refused, named, and nothing is written", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    await owned(grav, { name: "Held mesh", sku: "FAB-MESH-135" });
    await unowned({ name: "Legacy mesh", sku: "FAB-MESH-135" });
    await unowned({ name: "Harmless cord", sku: "TRM-CORD-04" });

    const out = await go(grav, { apply: true });
    expect(out.ok).toBe(false);
    expect(out.refused).toBe(true);
    expect(out.report.before.collidesWithTarget).toHaveLength(1);
    expect(out.report.before.collidesWithTarget[0].sku).toBe("FAB-MESH-135");
    expect(out.report.before.collidesWithTarget[0].heldBy.name).toBe("Held mesh");
    expect(out.text).toMatch(/REFUSED/);

    /* Not even the harmless one moved — a half-migrated catalogue is the
       outcome this refusal exists to prevent. */
    expect(await RawItem.countDocuments(migration.UNOWNED)).toBe(2);
    expect(await RawItem.countDocuments({ companyId: grav._id })).toBe(1);
  });

  test("two unowned items sharing a code collide with each other, and are refused", async () => {
    await dropUniqueIndex();
    const grav = await company("GRAV CLOTHING PVT LTD");
    await unowned({ name: "Mesh, entered twice (a)", sku: "FAB-DUP" });
    await unowned({ name: "Mesh, entered twice (b)", sku: "FAB-DUP" });

    const out = await go(grav, { apply: true });
    expect(out.ok).toBe(false);
    expect(out.report.before.duplicatesWithinUnowned).toHaveLength(1);
    expect(out.report.before.duplicatesWithinUnowned[0].rows).toHaveLength(2);
    expect(await RawItem.countDocuments(migration.UNOWNED)).toBe(2);
  });

  test("two unowned items with no code at all are a collision too", async () => {
    await dropUniqueIndex();
    const grav = await company("GRAV CLOTHING PVT LTD");
    await unowned({ sku: "" });
    await unowned({ sku: "" });
    const out = await go(grav, { apply: true });
    expect(out.ok).toBe(false);
    expect(out.report.before.withoutCode).toHaveLength(2);
  });

  test("the unique index is real, so the refusal is not theoretical", async () => {
    /* If this ever stops throwing, the refusal above has become ceremony
       and the reason for it has to be re-examined. */
    await RawItem.collection.createIndex({ companyId: 1, sku: 1 }, { unique: true });
    const grav = await company("GRAV CLOTHING PVT LTD");
    await owned(grav, { sku: "SAME" });
    await expect(owned(grav, { sku: "SAME" })).rejects.toThrow(/duplicate key/i);
  });
});

/* ══ 4 — DRY RUN BY DEFAULT ═══════════════════════════════════════════════ */

describe("it writes nothing until it is told to", () => {
  test("the default run reports exactly what it would do, and does none of it", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    const other = await company("Northstar Apparel Pvt Ltd");
    await owned(grav); await owned(grav);
    await owned(other);
    for (let i = 0; i < 5; i += 1) await unowned();

    const out = await go(grav);
    expect(out.ok).toBe(true);
    expect(out.report.applied).toBe(false);
    expect(out.report.result).toBeNull();
    expect(out.report.before).toMatchObject({
      total: 8, unowned: 5, ownedByTarget: 2, ownedByOthers: 1, wouldUpdate: 5, safe: true,
    });
    expect(out.text).toMatch(/DRY RUN — nothing written/);
    expect(out.text).toMatch(/SAFE TO APPLY/);

    /* The database is untouched. */
    expect(await RawItem.countDocuments(migration.UNOWNED)).toBe(5);
  });

  test("applying moves exactly the number the dry run promised, and re-counts after", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    for (let i = 0; i < 4; i += 1) await unowned();

    const dry = await go(grav);
    expect(dry.report.before.wouldUpdate).toBe(4);

    const wet = await go(grav, { apply: true });
    expect(wet.report.result.modifiedCount).toBe(4);
    expect(wet.report.after).toMatchObject({ unowned: 0, ownedByTarget: 4, ownedByOthers: 0 });
    expect(wet.text).toMatch(/WRITTEN/);
  });

  test("running it twice is not an error; the second finds nothing to do", async () => {
    const grav = await company("GRAV CLOTHING PVT LTD");
    await unowned();
    await go(grav, { apply: true });
    const again = await go(grav, { apply: true });
    expect(again.ok).toBe(true);
    expect(again.report.result.modifiedCount).toBe(0);
  });
});

/* ══ AND THE READ THAT WAS BROKEN IS THE ONE THAT IS FIXED ════════════════ */

describe("after it runs, the catalogue keyhole can see the items", () => {
  test("Merchandising's catalogue and the tenant filter agree on the count", async () => {
    const catalogue = require("../../services/merchandising/materialCatalogue.service");
    const tenant = require("../../services/storePurchase/tenantContext.service");
    const grav = await company("GRAV CLOTHING PVT LTD");
    for (let i = 0; i < 6; i += 1) await unowned();

    /* Before: the rows exist and the keyhole sees none of them, which is the
       symptom this migration was written for. */
    const before = await catalogue.search({ companyId: grav._id }, { limit: 50 });
    expect(before.rows).toHaveLength(0);
    expect(await RawItem.countDocuments({})).toBe(6);

    await go(grav, { apply: true });

    const after = await catalogue.search({ companyId: grav._id }, { limit: 50 });
    expect(after.rows).toHaveLength(6);
    expect(after.total).toBe(6);
    /* Store's own tenant-scoped read counts the same six. */
    const storeFilter = tenant.tenantFilter({ companyId: grav._id, legacyMode: false });
    expect(await RawItem.countDocuments(storeFilter)).toBe(6);
  });

  test("paging reaches the last item, and search finds one beyond the first page", async () => {
    const catalogue = require("../../services/merchandising/materialCatalogue.service");
    const grav = await company("GRAV CLOTHING PVT LTD");
    for (let i = 0; i < 23; i += 1) {
      await unowned({ name: `Item ${String(i).padStart(2, "0")}`, sku: `PAGE-${i}` });
    }
    await go(grav, { apply: true });

    const seen = [];
    let cursor = "";
    let guard = 0;
    do {
      const page = await catalogue.search({ companyId: grav._id }, { limit: 5, cursor });
      seen.push(...page.rows.map((r) => r.rawItemId));
      cursor = page.nextCursor || "";
      guard += 1;
    } while (cursor && guard < 20);

    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);

    /* "Item 22" sorts last and is nowhere near the first page. */
    const late = await catalogue.search({ companyId: grav._id }, { q: "Item 22" });
    expect(late.rows.map((r) => r.name)).toEqual(["Item 22"]);
  });

  test("a migrated item still resolves server-side, inside the company", async () => {
    const catalogue = require("../../services/merchandising/materialCatalogue.service");
    const grav = await company("GRAV CLOTHING PVT LTD");
    const other = await company("Northstar Apparel Pvt Ltd");
    await RawItem.collection.insertOne({
      name: "Legacy mesh", sku: "FAB-LEG-1", category: "Fabric", attributes: [],
      variants: [{ _id: new mongoose.Types.ObjectId(), combination: ["Slate"], sku: "FAB-LEG-1-SL" }],
      createdAt: new Date(), updatedAt: new Date(),
    });
    await go(grav, { apply: true });

    const item = await RawItem.findOne({ sku: "FAB-LEG-1" }).lean();
    const resolved = await catalogue.resolve(
      { companyId: grav._id },
      { rawItemId: String(item._id), variantId: String(item.variants[0]._id) },
    );
    expect(resolved.rawItemName).toBe("Legacy mesh");
    expect(resolved.rawItemSku).toBe("FAB-LEG-1-SL");

    /* And it is GRAV's now — the other company cannot resolve it. */
    await expect(catalogue.resolve(
      { companyId: other._id }, { rawItemId: String(item._id) },
    )).rejects.toMatchObject({ code: "DEVELOPMENT_CATALOGUE_ITEM_NOT_FOUND" });
  });
});
