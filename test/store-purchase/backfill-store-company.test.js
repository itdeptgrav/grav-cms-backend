// test/store-purchase/backfill-store-company.test.js
//
// THE ONE-OFF THAT GIVES LEGACY STORE RECORDS THEIR COMPANY.
//
// The Item Master shows "0 items" over a database holding 259, because Store
// reads are tenant-scoped and none of those rows carries a `companyId`. This
// proves the migration that fixes it — and, far more importantly, the four
// things it refuses to do.
//
// The script is run AS A SCRIPT, in a child process against a throwaway
// database. Importing its internals and calling them would test a rearrangement
// of the migration rather than the migration: the dry-run default, the
// `--apply` flag and the exit codes are the safety features, and they only
// exist at the command line.
"use strict";

const path = require("path");
const { execFile } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const SCRIPT = path.resolve(__dirname, "../../scripts/migrations/backfill-store-company.js");

let mongod, uri;
let Acc_Company, RawItem, Vendor, Unit, StockItem;

jest.setTimeout(120000);

beforeAll(async () => {
  await mongoose.disconnect();
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri("backfill_test");
  await mongoose.connect(uri);

  ({ Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels"));
  RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
  Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
  Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
  StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
  /* The tenant-scoped unique indexes are the thing collision detection reads,
     so they have to exist for these tests to mean anything. */
  await RawItem.syncIndexes();
  /* Vendor's tenant indexes are PARTIAL, and the partial filter is the thing
     that decides whether 80 unowned suppliers look like a collision. */
  await Vendor.syncIndexes();
});

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

afterEach(async () => {
  for (const M of [Acc_Company, RawItem, Vendor, Unit, StockItem]) await M.deleteMany({});
  /* ── THE SUITE CLEANS UP AFTER ITSELF ──────────────────────────────────
     Every `--apply` here writes a real manifest beside the migration, because
     that is what the migration does. Left alone, one run of this file drops
     ~15 files into scripts/migrations and a day's iteration buries the one
     manifest that documents an actual production run. */
  const dir = path.resolve(__dirname, "../../scripts/migrations");
  for (const f of require("fs").readdirSync(dir)) {
    if (!f.startsWith("store-company-backfill-")) continue;
    const full = path.join(dir, f);
    try {
      const m = JSON.parse(require("fs").readFileSync(full, "utf8"));
      /* Only this suite's throwaway database — never a real run's record. */
      if (m.database === "backfill_test") require("fs").unlinkSync(full);
    } catch { /* mid-write or unreadable; leave it */ }
  }
});

/** Run the migration exactly as an operator would. */
const run = (args = []) => new Promise((resolve) => {
  execFile(
    process.execPath, [SCRIPT, ...args],
    { env: { ...process.env, MONGODB_URI: uri }, cwd: path.resolve(__dirname, "../..") },
    (err, stdout, stderr) => resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr }),
  );
});

const company = (name = "GRAV CLOTHING PVT LTD") =>
  Acc_Company.create({ companyName: name, booksFromDate: new Date("2026-04-01") });

/* Written through the driver: these are LEGACY rows, and the application has
   no path that produces one any more — current code stamps on write. */
const legacyItem = (sku, over = {}) =>
  RawItem.collection.insertOne({ name: `Item ${sku}`, sku, unit: "Metre", ...over });

const unowned = (M) => M.countDocuments({ $or: [{ companyId: null }, { companyId: { $exists: false } }] });


describe("the legacy Store company backfill", () => {
  test("a dry run reports the work and writes nothing", async () => {
    const co = await company();
    await legacyItem("RAW-1");
    await legacyItem("RAW-2");

    const r = await run();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/DRY RUN/);
    expect(r.stdout).toMatch(/would stamp 2 records/);
    expect(r.stdout).toMatch(/Nothing has been written/);

    /* The claim that matters: the database is exactly as it was. */
    expect(await unowned(RawItem)).toBe(2);
    expect(await RawItem.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("--apply stamps the sole company onto every unowned record", async () => {
    const co = await company();
    await legacyItem("RAW-1");
    await legacyItem("RAW-2");
    await Vendor.collection.insertOne({ vendorName: "Mill Textiles" });
    await Unit.collection.insertOne({ name: "Metre" });

    const r = await run(["--apply"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Stamped 4 records/);

    expect(await unowned(RawItem)).toBe(0);
    expect(await RawItem.countDocuments({ companyId: co._id })).toBe(2);
    expect(await Vendor.countDocuments({ companyId: co._id })).toBe(1);
    expect(await Unit.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("two companies is a refusal, not a choice", async () => {
    await company("GRAV CLOTHING PVT LTD");
    await company("GRAV EXPORTS PVT LTD");
    await legacyItem("RAW-1");

    const r = await run(["--apply"]);
    /* Nothing in the data says which company owns a 2024 purchase order, and
       picking the first or the busiest would be inventing ownership for
       commercial records. */
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/REFUSED: 2 companies exist/);
    expect(r.stdout).toMatch(/inventing ownership/);
    expect(await unowned(RawItem)).toBe(1);
  });

  test("no company at all is refused too", async () => {
    await legacyItem("RAW-1");
    const r = await run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/no company to assign/);
    expect(await unowned(RawItem)).toBe(1);
  });

  test("a record that already has an owner is never re-owned", async () => {
    const co = await company();
    const other = new mongoose.Types.ObjectId();
    /* As if a second company's record were already present — the migration
       must not drag it across. */
    await RawItem.collection.insertOne({ name: "Theirs", sku: "RAW-THEIRS", companyId: other });
    await legacyItem("RAW-MINE");

    const r = await run(["--apply"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Stamped 1 records/);

    const theirs = await RawItem.findOne({ sku: "RAW-THEIRS" }).lean();
    expect(String(theirs.companyId)).toBe(String(other));
    const mine = await RawItem.findOne({ sku: "RAW-MINE" }).lean();
    expect(String(mine.companyId)).toBe(String(co._id));
  });

  test("a second run changes nothing", async () => {
    await company();
    await legacyItem("RAW-1");
    await legacyItem("RAW-2");

    const first = await run(["--apply"]);
    expect(first.stdout).toMatch(/Stamped 2 records/);
    const after = await RawItem.find({}).lean();

    const second = await run(["--apply"]);
    expect(second.code).toBe(0);
    /* The filter IS the idempotency: an owned record is outside it. */
    expect(second.stdout).toMatch(/Nothing to do/);
    expect(second.stdout).not.toMatch(/Stamped [1-9]/);
    expect(await RawItem.find({}).lean()).toEqual(after);
  });

  test("a duplicate that the tenant index would reject stops the whole run", async () => {
    await company();
    /* ── THE COLLISION THAT IS ACTUALLY REACHABLE ────────────────────────
       Not two unowned rows sharing a SKU: `{companyId, sku}` is not partial,
       Mongo indexes null as a value, and that pair was rejected on insert
       years ago. The reachable one is a legacy row colliding with a row the
       company registered LAST WEEK — apart they are legal, stamped they are
       one company with one SKU twice. */
    const co2 = await Acc_Company.findOne({});
    await RawItem.collection.insertOne({ name: "Registered recently", sku: "RAW-DUP", companyId: co2._id });
    await legacyItem("RAW-DUP");
    await legacyItem("RAW-FINE");

    const r = await run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/REFUSED: stamping would create duplicates/);
    expect(r.stdout).toMatch(/RAW-DUP/);
    /* ── AND IT STOPS EVERYTHING, NOT JUST THE BAD ROW ──────────────────
       A partial migration is the worst outcome: half the Item Master
       visible, half not, and nothing on screen saying which half. */
    expect(await unowned(RawItem)).toBe(2);
  });

  test("rows a partial index does not cover are not collisions", async () => {
    await company();
    /* Vendor's unique indexes are partial — `{supplierCode: {$gt: ""}}` and
       `{gstNormalised: {$gt: ""}}`. These three share a null supplierCode, so
       a check that reads the index KEY alone sees one group of three and
       refuses the migration. */
    await Vendor.collection.insertOne({ vendorName: "Mill A" });
    await Vendor.collection.insertOne({ vendorName: "Mill B" });
    await Vendor.collection.insertOne({ vendorName: "Mill C" });

    const r = await run(["--apply"]);
    /* A document the filter excludes is not IN the index and cannot collide
       on it, however its key fields compare. On the live database this is the
       difference between migrating 80 suppliers and refusing to. */
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/REFUSED/);
    expect(await unowned(Vendor)).toBe(0);
  });

  test("a genuine collision inside a partial index is still caught", async () => {
    const co = await company();
    /* Both carry a supplierCode, so both ARE in the index — one already owned,
       one legacy. Stamping makes them one company with one code twice. */
    await Vendor.collection.insertOne({ vendorName: "Owned", supplierCode: "SUP-1", companyId: co._id });
    await Vendor.collection.insertOne({ vendorName: "Legacy", supplierCode: "SUP-1" });

    const r = await run(["--apply"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/REFUSED: stamping would create duplicates/);
    expect(r.stdout).toMatch(/SUP-1/);
    expect(await unowned(Vendor)).toBe(1);
  });

  test("a model with no companyId is never touched", async () => {
    const co = await company();
    await legacyItem("RAW-1");
    await StockItem.collection.insertOne({ name: "Finished shirt", reference: "FG-1" });

    const r = await run(["--apply"]);
    expect(r.code).toBe(0);

    const fg = await StockItem.findOne({ reference: "FG-1" }).lean();
    /* Stamping a deliberately global master would invent a tenancy its
       screens do not have, and would then hide it from them. */
    expect(fg.companyId).toBeUndefined();
    expect(await RawItem.countDocuments({ companyId: co._id })).toBe(1);
  });

  test("the excluded collections are named in the report, not silently absent", async () => {
    await company();
    await legacyItem("RAW-1");
    const r = await run();
    /* A reader must be able to see what was considered and passed over. */
    expect(r.stdout).toMatch(/Excluded from this migration/);
    expect(r.stdout).toMatch(/StockItem\s+GLOBAL/);
    expect(r.stdout).toMatch(/SpIdempotencyRecord\s+CURRENT_CODE_ONLY/);
  });

  test("--apply writes a manifest naming every document it touched", async () => {
    await company();
    await legacyItem("RAW-1");

    const r = await run(["--apply"]);
    const line = r.stdout.split("\n").find((l) => l.startsWith("Manifest:"));
    expect(line).toBeTruthy();

    const manifestPath = line.replace("Manifest:", "").trim();
    const manifest = JSON.parse(require("fs").readFileSync(manifestPath, "utf8"));
    const item = await RawItem.findOne({ sku: "RAW-1" }).lean();
    /* The reverse of this migration is `$unset: {companyId}` over exactly
       these ids and nothing else — which is only possible if they were
       written down. */
    expect(manifest.collections.RawItem).toEqual([String(item._id)]);
    expect(manifest.companyName).toBe("GRAV CLOTHING PVT LTD");
  });

  test("the update re-states the unowned filter, belt and braces", () => {
    /* ── A STRUCTURAL PROPERTY, PINNED AS ONE ──────────────────────────
       The manifest already holds only unowned ids, so restricting the update
       to those ids is what actually protects owned rows — and no behavioural
       test can tell the two apart. The extra `UNOWNED` clause guards the
       window between building the manifest and writing: a row stamped by
       somebody else in between is left alone. That race cannot happen in a
       single-company run, which is exactly why it would be easy to delete
       when this script is reused for a deployment where it can. */
    const src = require("fs").readFileSync(SCRIPT, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    expect(src).toMatch(/\{ _id: \{ \$in: slice \}, \.\.\.UNOWNED \}/);
  });

  test("--only limits the run to one collection", async () => {
    const co = await company();
    await legacyItem("RAW-1");
    await Vendor.collection.insertOne({ vendorName: "Mill Textiles" });

    const r = await run(["--only=RawItem", "--apply"]);
    expect(r.code).toBe(0);
    expect(await RawItem.countDocuments({ companyId: co._id })).toBe(1);
    expect(await unowned(Vendor)).toBe(1);

    const bad = await run(["--only=Nonsense"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toMatch(/not one of this migration's collections/);
  });
});
