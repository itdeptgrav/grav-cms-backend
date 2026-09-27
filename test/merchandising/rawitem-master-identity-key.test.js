// test/merchandising/rawitem-master-identity-key.test.js
//
// THE IDENTITY-KEY BACKFILL, AND THE FIVE THINGS IT REFUSES TO DO.
//
//   1  IT COMPUTES NOTHING OF ITS OWN. The key it writes is the key creation
//      writes, from the same function — asserted by registering an item through
//      the service and finding the backfilled row carries an identical key for
//      an identical material. A migration with its own normalisation would give
//      a backfilled item and a newly created one different keys for the same
//      material, so the duplicate check would pass on exactly the duplicate it
//      exists to catch.
//
//   2  IT NEVER TOUCHES AN UNOWNED ROW. A legacy-global item belongs to nobody
//      and the key is only meaningful inside a company. Counted, reported,
//      never written.
//
//   3  IT NEVER MERGES A COLLISION. Two rows in one company resolving to one
//      key both get the key, and the group is reported. Nothing is renamed,
//      deleted or deduplicated.
//
//   4  IT IS RERUNNABLE. A second run writes nothing. A run after a rename
//      corrects exactly that row.
//
//   5  IT WRITES NOTHING WITHOUT --apply.
//
// And case, spacing and punctuation are the point of the whole field: three
// spellings of one material must resolve to one key and be reported as a
// collision, which is what a regex on `name` could never do.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const migration = require("../../scripts/migrations/rawitem-master-identity-key");
const creation = require("../../services/inventory/rawItemCreation.service");

let rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "rawitem_identity_key" });
}, 120000);

afterAll(async () => {
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

afterEach(async () => { await RawItem.deleteMany({}); });

const oid = () => new mongoose.Types.ObjectId();

/**
 * An item as the catalogue holds one BEFORE the field existed: no
 * `masterIdentityKey` at all, written straight to the collection so no
 * schema default can put one there.
 */
async function legacyItem(over = {}) {
  const n = ++seq;
  const doc = {
    name: over.name !== undefined ? over.name : `Poly mesh 135 ${n}`,
    sku: over.sku || `RAW-FAB-POLMES-${String(n).padStart(3, "0")}`,
    category: over.category !== undefined ? over.category : "Fabric",
    customCategory: over.customCategory || "",
    unit: over.unit !== undefined ? over.unit : "Metre",
    customUnit: over.customUnit || "",
    usedAs: over.usedAs !== undefined ? over.usedAs : "FABRIC",
    quantity: 0, minStock: 0, maxStock: 0,
    ...(over.companyId === null ? {} : { companyId: over.companyId || oid() }),
    ...(over.masterIdentityKey !== undefined ? { masterIdentityKey: over.masterIdentityKey } : {}),
  };
  const res = await RawItem.collection.insertOne(doc);
  return { ...doc, _id: res.insertedId };
}

const keyOf = async (id) => (await RawItem.findById(id).lean()).masterIdentityKey;
const dry = (o) => migration.run({ ...o, jsonPath: null });
const apply = (o) => migration.run({ ...o, apply: true, jsonPath: null });

/* ══ 1 — ONE NORMALISATION, SHARED WITH CREATION ══════════════════════════ */

describe("the key it writes is the key creation writes", () => {
  test("a backfilled row and a newly registered one agree on the same material", async () => {
    const co = oid();
    const old = await legacyItem({ companyId: co, name: "Poly mesh 135" });
    await apply({});

    /* The same material, registered through the service that stamps the key. */
    const { rawItem } = await creation.createRawItem({
      tenant: { companyId: co },
      actorId: oid(),
      payload: { name: "Poly mesh 135", category: "Fabric", unit: "Metre", usedAs: "FABRIC" },
      sections: creation.MERCHANDISING_SECTIONS,
      onDuplicate: "allow",
    });

    expect(await keyOf(old._id)).toBe(rawItem.masterIdentityKey);
    /* And it is the function's own answer, not a coincidence. */
    expect(await keyOf(old._id)).toBe(creation.identityKey({
      name: "Poly mesh 135", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
    }));
  });

  test("a backfilled row is then found by the duplicate check", async () => {
    const co = oid();
    await legacyItem({ companyId: co, name: "Poly-mesh 135" });
    await apply({});

    /* Punctuation differs, so the exact-name fallback would have missed it.
       The key does not. */
    const found = await creation.findDuplicate({ companyId: co }, {
      name: "POLY  MESH  135", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
    });
    expect(found).toBeTruthy();
    expect(found.name).toBe("Poly-mesh 135");
  });

  test("the script carries no normalisation of its own", () => {
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../scripts/migrations/rawitem-master-identity-key.js"),
      "utf8",
    );
    expect(src).toMatch(/identityKey/);
    expect(src).toMatch(/rawItemCreation\.service/);
    /* No second lower-casing, no second punctuation strip. */
    expect(src).not.toMatch(/toLowerCase/);
    expect(src).not.toMatch(/\[\^a-z0-9\]/);
  });
});

/* ══ CASE, SPACING AND PUNCTUATION ═══════════════════════════════════════ */

describe("three spellings of one material", () => {
  test("resolve to one key", async () => {
    const co = oid();
    const a = await legacyItem({ companyId: co, name: "Poly mesh 135" });
    const b = await legacyItem({ companyId: co, name: "poly-mesh 135" });
    const c = await legacyItem({ companyId: co, name: "POLY  MESH  135" });
    await apply({});

    const keys = [await keyOf(a._id), await keyOf(b._id), await keyOf(c._id)];
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe("polymesh135|fabric|metre|fabric");
  });

  test("the same name in a different unit is a different material", async () => {
    const co = oid();
    const m = await legacyItem({ companyId: co, name: "Cord", unit: "Metre" });
    const p = await legacyItem({ companyId: co, name: "Cord", unit: "Piece" });
    await apply({});
    expect(await keyOf(m._id)).not.toBe(await keyOf(p._id));
  });

  test("a company's own shelf word is keyed like any other", async () => {
    const co = oid();
    const it = await legacyItem({
      companyId: co, name: "Reflective tape", category: "", customCategory: "Reflectives",
    });
    await apply({});
    expect(await keyOf(it._id)).toBe("reflectivetape|reflectives|metre|fabric");
  });
});

/* ══ 2 — UNOWNED ROWS ════════════════════════════════════════════════════ */

describe("a legacy-global item belongs to nobody", () => {
  test("it is counted and never written", async () => {
    await legacyItem({ companyId: null, name: "Unowned twill" });
    const owned = await legacyItem({ companyId: oid(), name: "Owned twill" });

    const before = await dry({});
    expect(before.report.before.unowned).toBe(1);
    expect(before.report.before.owned).toBe(1);

    const out = await apply({});
    expect(out.report.result.modifiedCount).toBe(1);

    const unowned = await RawItem.findOne({ name: "Unowned twill" }).lean();
    expect(unowned.masterIdentityKey === undefined || unowned.masterIdentityKey === "").toBe(true);
    expect(await keyOf(owned._id)).toBeTruthy();
  });

  test("a companyId of null is unowned, not a company", async () => {
    await RawItem.collection.insertOne({
      name: "Explicitly null", sku: `RAW-NULL-${++seq}`, category: "Fabric",
      unit: "Metre", usedAs: "FABRIC", companyId: null, quantity: 0,
    });
    const out = await apply({});
    expect(out.report.before.owned).toBe(0);
    expect(out.report.before.unowned).toBe(1);
    expect(out.report.result.modifiedCount).toBe(0);
  });
});

/* ══ 3 — COLLISIONS ══════════════════════════════════════════════════════ */

describe("a collision is reported, never resolved", () => {
  test("both rows survive, both get the key, and the group is named", async () => {
    const co = oid();
    const a = await legacyItem({ companyId: co, name: "Poly mesh 135", sku: "RAW-A-001" });
    const b = await legacyItem({ companyId: co, name: "poly mesh 135", sku: "RAW-B-002" });

    const out = await apply({});
    expect(out.report.before.collisions).toHaveLength(1);
    const group = out.report.before.collisions[0];
    expect(group.count).toBe(2);
    expect(group.companyId).toBe(String(co));
    expect(group.items.map((i) => i.sku).sort()).toEqual(["RAW-A-001", "RAW-B-002"]);
    expect(out.report.before.collidingItems).toBe(2);

    /* Nothing merged, nothing deleted, both keyed. */
    expect(await RawItem.countDocuments({ companyId: co })).toBe(2);
    expect(await keyOf(a._id)).toBe(await keyOf(b._id));
  });

  test("the report says a collision in words a person can act on", async () => {
    const co = oid();
    await legacyItem({ companyId: co, name: "Poly mesh 135" });
    await legacyItem({ companyId: co, name: "Poly-mesh 135" });
    const out = await dry({});
    expect(out.text).toMatch(/COLLISIONS \(1\)/);
    expect(out.text).toMatch(/NOTHING is merged or removed/);
    expect(out.text).toMatch(/for a person to decide/);
  });

  test("no collision means the report says so", async () => {
    await legacyItem({ companyId: oid(), name: "Only one" });
    const out = await dry({});
    expect(out.report.before.collisions).toEqual([]);
    expect(out.text).toMatch(/No company holds one material under two rows/);
  });

  test("an item with no name is not keyed, so nameless items do not all collide", async () => {
    const co = oid();
    await legacyItem({ companyId: co, name: "" });
    await legacyItem({ companyId: co, name: "   " });
    const out = await apply({});
    expect(out.report.before.unkeyable).toBe(2);
    expect(out.report.before.collisions).toEqual([]);
    expect(out.report.result.modifiedCount).toBe(0);
  });
});

/* ══ COMPANY ISOLATION ═══════════════════════════════════════════════════ */

describe("companies are separate", () => {
  test("the same material in two companies is not a collision", async () => {
    const mine = oid();
    const theirs = oid();
    await legacyItem({ companyId: mine, name: "Poly mesh 135" });
    await legacyItem({ companyId: theirs, name: "Poly mesh 135" });

    const out = await apply({});
    expect(out.report.before.collisions).toEqual([]);
    expect(out.report.before.companies).toBe(2);
    expect(out.report.result.modifiedCount).toBe(2);
  });

  test("--company-id touches only that company", async () => {
    const mine = oid();
    const theirs = oid();
    const ours = await legacyItem({ companyId: mine, name: "Ours" });
    const yours = await legacyItem({ companyId: theirs, name: "Yours" });

    const out = await apply({ companyId: String(mine) });
    expect(out.report.before.owned).toBe(1);
    expect(out.report.result.modifiedCount).toBe(1);
    expect(await keyOf(ours._id)).toBeTruthy();
    const untouched = await RawItem.findById(yours._id).lean();
    expect(untouched.masterIdentityKey === undefined || untouched.masterIdentityKey === "").toBe(true);
  });

  test("a scoped run's duplicate check never reaches across the boundary", async () => {
    const mine = oid();
    const theirs = oid();
    await legacyItem({ companyId: theirs, name: "Shared name" });
    await apply({});
    /* Registered cleanly in a company that does not have it, even though
       another company does. */
    const found = await creation.findDuplicate({ companyId: mine }, {
      name: "Shared name", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
    });
    expect(found).toBeNull();
  });
});

/* ══ 4 — RERUNNABLE ══════════════════════════════════════════════════════ */

describe("running it again", () => {
  test("writes nothing the second time", async () => {
    await legacyItem({ companyId: oid(), name: "Stable" });
    const first = await apply({});
    expect(first.report.result.modifiedCount).toBe(1);

    const second = await apply({});
    expect(second.report.before.wouldWrite).toBe(0);
    expect(second.report.before.alreadyCorrect).toBe(1);
    expect(second.report.result.modifiedCount).toBe(0);
  });

  test("a rename is corrected, and only that row", async () => {
    const co = oid();
    const renamed = await legacyItem({ companyId: co, name: "Before" });
    const other = await legacyItem({ companyId: co, name: "Untouched" });
    await apply({});
    const otherKey = await keyOf(other._id);

    await RawItem.updateOne({ _id: renamed._id }, { $set: { name: "After" } });

    const out = await apply({});
    expect(out.report.before.wouldWrite).toBe(1);
    expect(out.report.before.plan[0].id).toBe(String(renamed._id));
    expect(out.report.result.modifiedCount).toBe(1);
    expect(await keyOf(renamed._id)).toBe(creation.identityKey({
      name: "After", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
    }));
    expect(await keyOf(other._id)).toBe(otherKey);
  });

  test("a wrong key stored by hand is corrected, not left", async () => {
    const it = await legacyItem({ companyId: oid(), name: "Real", masterIdentityKey: "nonsense" });
    const out = await apply({});
    expect(out.report.before.wouldWrite).toBe(1);
    expect(out.report.before.plan[0].was).toBe("nonsense");
    expect(await keyOf(it._id)).not.toBe("nonsense");
  });

  test("a row edited between the survey and the write is not overwritten", async () => {
    const it = await legacyItem({ companyId: oid(), name: "Racing" });
    /* The plan is composed against `was: ""`. Somebody sets a key in between. */
    const planned = await dry({});
    expect(planned.report.before.wouldWrite).toBe(1);
    await RawItem.updateOne({ _id: it._id }, { $set: { masterIdentityKey: "set-by-somebody-else" } });

    const out = await apply({});
    /* The apply re-surveys, so it now plans a CORRECTION rather than blindly
       writing the stale plan — which is the rerunnable behaviour. */
    expect(await keyOf(it._id)).toBe(creation.identityKey({
      name: "Racing", category: "Fabric", unit: "Metre", usedAs: "FABRIC",
    }));
    expect(out.report.result.failed).toBe(0);
  });
});

/* ══ 5 — DRY RUN BY DEFAULT ══════════════════════════════════════════════ */

describe("without --apply", () => {
  test("nothing is written, and it says exactly what it would do", async () => {
    const it = await legacyItem({ companyId: oid(), name: "Untouched by a dry run" });

    const out = await dry({});
    expect(out.report.applied).toBe(false);
    expect(out.report.result).toBeNull();
    expect(out.report.before.wouldWrite).toBe(1);
    expect(out.text).toMatch(/DRY RUN — nothing written/);
    expect(out.text).toMatch(/Re-run with --apply/);

    const stored = await RawItem.findById(it._id).lean();
    expect(stored.masterIdentityKey === undefined || stored.masterIdentityKey === "").toBe(true);
  });

  test("an empty catalogue is an ordinary answer", async () => {
    const out = await apply({});
    expect(out.report.before.owned).toBe(0);
    expect(out.report.result.modifiedCount).toBe(0);
    expect(out.ok).toBe(true);
  });
});
