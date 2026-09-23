// test/store-purchase/stock-count-post.replset.test.js
//
// Warehouse Stock Count V1 — PROVES the post is one atomic correction on a
// replica set. Every reviewed non-zero variance moves the company on-hand, the
// variant balance, the location ledger and the valuation input TOGETHER; a
// failure at any boundary rolls all of it back; two concurrent posts cannot both
// apply; a replay posts once; and a posted count is immutable.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const StockCount = require("../../models/CMS_Models/Inventory/Operations/StockCount");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const locStock = require("../../services/storePurchase/locationStock.service");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
const valuation = require("../../services/inventoryValuation.service");

let rs, server, base, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "stock_count_post" });
  unitOfWork.__setTransactionSupport(null); // re-probe against the replica set

  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/stock-counts", require("../../routes/CMS_Routes/Inventory/Operations/stockCountRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
}, 180000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  jest.restoreAllMocks();
});

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
const newKey = () => `sc-${++seq}-${Math.random().toString(36).slice(2)}`;

async function actor(company) {
  const email = `p${++seq}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "P", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "P" });
  return tokenFor({ id: String(employeeRef), email });
}
const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
const warehouse = (companyId) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  locations: [{ code: "STOCK", name: "Usable stock", type: "USABLE_STOCK", status: "Active" }],
});
const rawItem = (companyId, over = {}) => RawItem.create({
  companyId, sku: `RAW-${++seq}`, name: over.name || `Item ${seq}`, unit: over.unit || "PCS",
  quantity: over.quantity != null ? over.quantity : 10, variants: over.variants || [],
});

// Place existing on-hand into a location (guarded, mirrors /assign): company
// total unchanged, LocationBalance created — exactly what the snapshot reads.
async function place(companyId, wh, loc, item, qty, variantId = null, companyOnHand) {
  const r = await locStock.applyLocationIn(null, {
    companyId, siteId: null, item, variantId, warehouse: wh, location: loc,
    quantity: qty, type: "opening_assignment", intent: "place",
    companyOnHand: companyOnHand != null ? companyOnHand : item.quantity,
    source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "",
  });
  if (!r.ok) throw new Error("seed place failed");
}

// A full setup: company, warehouse, an item on-hand 10 with `placed` at STOCK.
async function setup({ placed = 6, quantity = 10, variants } = {}) {
  const c = await company();
  const wh = await warehouse(c._id);
  const stock = wh.locations[0];
  const token = await actor(c);
  const item = await rawItem(c._id, { quantity, variants });
  const fresh = await RawItem.findById(item._id).lean();
  if (variants) {
    // place each variant's portion
    for (let i = 0; i < variants.length; i += 1) {
      await place(c._id, wh, stock, fresh, variants[i].place, fresh.variants[i]._id, fresh.variants[i].quantity);
    }
  } else if (placed > 0) {
    await place(c._id, wh, stock, fresh, placed);
  }
  return { c, wh, stock, token, item: fresh };
}

// Start → save counted figures with reasons → review → return the reviewed doc.
async function reviewed(ctx, counts) {
  const started = (await call("/api/cms/inventory/stock-counts", { method: "POST", token: ctx.token, body: {
    warehouseId: String(ctx.wh._id), locationId: String(ctx.stock._id),
  } })).body;
  const entries = started.count.lines.map((l) => {
    const spec = counts(l);
    return { lineId: l.lineId, counted: spec.counted !== false, countedQty: spec.countedQty, varianceReason: spec.reason || "" };
  });
  const rev = await call(`/api/cms/inventory/stock-counts/${started.count._id}/review`, { method: "POST", token: ctx.token, body: { entries, recordVersion: started.count.recordVersion } });
  return { id: started.count._id, started, rev };
}
const post = (ctx, id, key) => call(`/api/cms/inventory/stock-counts/${id}/post`, { method: "POST", token: ctx.token, key: key || newKey(), body: {} });

// ── Negative variance ────────────────────────────────────────────────────────
test("a negative variance moves company, location and history down together", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "two damaged" }));
  const r = await post(ctx, id);
  expect(r.status).toBe(200);
  expect(r.body.outcome.discrepanciesPosted).toBe(1);

  const item = await RawItem.findById(ctx.item._id).lean();
  expect(item.quantity).toBe(8); // company 10 → 8

  const locBal = await LocationBalance.findOne({ itemId: ctx.item._id, locationId: ctx.stock._id, variantId: null }).lean();
  expect(locBal.onHand).toBe(4); // location 6 → 4

  const mv = await LocationMovement.find({ itemId: ctx.item._id, "source.kind": "stock_count" }).lean();
  expect(mv).toHaveLength(1);
  expect(mv[0].direction).toBe("out");
  expect(mv[0].quantity).toBe(2);

  // valuation input: exactly one REDUCE stockTransaction from this count.
  const corrections = (item.stockTransactions || []).filter((t) => /Stock count/.test(t.reason || ""));
  expect(corrections).toHaveLength(1);
  expect(corrections[0].type).toBe("REDUCE");

  // before → after facts on the outcome.
  expect(r.body.outcome.lines[0]).toMatchObject({ direction: "out", quantity: 2, companyBefore: 10, companyAfter: 8, locationBefore: 6, locationAfter: 4 });
});

// ── Positive variance ────────────────────────────────────────────────────────
test("a positive variance moves everything up together", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 9, reason: "found three" }));
  const r = await post(ctx, id);
  expect(r.status).toBe(200);
  const item = await RawItem.findById(ctx.item._id).lean();
  expect(item.quantity).toBe(13); // 10 + 3
  const locBal = await LocationBalance.findOne({ itemId: ctx.item._id, locationId: ctx.stock._id, variantId: null }).lean();
  expect(locBal.onHand).toBe(9); // 6 + 3
  const mv = await LocationMovement.findOne({ itemId: ctx.item._id, "source.kind": "stock_count" }).lean();
  expect(mv.direction).toBe("in");
});

// ── Reconciliation across all three balances ─────────────────────────────────
test("company, variant and location balances reconcile after a variant post", async () => {
  const ctx = await setup({ quantity: 10, variants: [
    { combination: ["Red"], quantity: 6, sku: "V-RED", place: 6 },
    { combination: ["Blue"], quantity: 4, sku: "V-BLUE", place: 4 },
  ] });
  const redId = String(ctx.item.variants[0]._id);
  const { id } = await reviewed(ctx, (l) => (l.variantId === redId ? { countedQty: 5, reason: "one short" } : { countedQty: 4 }));
  const r = await post(ctx, id);
  expect(r.status).toBe(200);

  const item = await RawItem.findById(ctx.item._id).lean();
  const red = item.variants.find((v) => String(v._id) === redId);
  expect(red.quantity).toBe(5); // variant 6 → 5
  expect(item.quantity).toBe(9); // company 10 → 9 (only red moved)

  // Location assigned + unassigned == company on-hand, for the red variant.
  const locBal = await LocationBalance.findOne({ itemId: ctx.item._id, locationId: ctx.stock._id, variantId: red._id }).lean();
  expect(locBal.onHand).toBe(5); // red at STOCK 6 → 5
  const sentinel = await LocationBalance.findOne({ itemId: ctx.item._id, variantId: red._id, locationId: null }).lean();
  expect(sentinel.onHand).toBe(5); // assigned total == what one location holds
  // reconcile: assigned(5) + unassigned(0) == company variant on-hand(5)
  expect(red.quantity - sentinel.onHand).toBe(0);
});

// ── Zero-variance rows never move stock ──────────────────────────────────────
test("a zero-variance count posts nothing and writes no movement", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 6 }));
  const r = await post(ctx, id);
  expect(r.status).toBe(200);
  expect(r.body.outcome.discrepanciesPosted).toBe(0);
  expect((await RawItem.findById(ctx.item._id).lean()).quantity).toBe(10);
  expect(await LocationMovement.countDocuments({ itemId: ctx.item._id, "source.kind": "stock_count" })).toBe(0);
});

// ── Rollback at every write boundary ─────────────────────────────────────────
describe("a failure at any write boundary rolls everything back", () => {
  async function expectRolledBack(ctx, id) {
    expect((await RawItem.findById(ctx.item._id).lean()).quantity).toBe(10);
    expect(await LocationMovement.countDocuments({ itemId: ctx.item._id, "source.kind": "stock_count" })).toBe(0);
    expect((await StockCount.findById(id).lean()).status).toBe("REVIEWED"); // transition rolled back
    expect((await LocationBalance.findOne({ itemId: ctx.item._id, locationId: ctx.stock._id, variantId: null }).lean()).onHand).toBe(6);
  }

  test("a failure writing the location movement leaves nothing applied", async () => {
    const ctx = await setup({ placed: 6, quantity: 10 });
    const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
    jest.spyOn(LocationMovement, "create").mockRejectedValue(new Error("movement store down"));
    const r = await post(ctx, id);
    expect(r.status).toBe(500);
    jest.restoreAllMocks();
    await expectRolledBack(ctx, id);
  });

  test("a failure writing the posting receipt leaves nothing applied", async () => {
    const ctx = await setup({ placed: 6, quantity: 10 });
    const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
    const realUpdate = StockCount.updateOne.bind(StockCount);
    jest.spyOn(StockCount, "updateOne").mockImplementation((filter, update, opts) => {
      // Fail only the receipt write ($set of lines+posting), not other updates.
      if (update && update.$set && update.$set.posting) return Promise.reject(new Error("receipt write failed"));
      return realUpdate(filter, update, opts);
    });
    const r = await post(ctx, id);
    expect(r.status).toBe(500);
    jest.restoreAllMocks();
    await expectRolledBack(ctx, id);
  });
});

// ── Idempotent replay ────────────────────────────────────────────────────────
test("a replay under the same key posts once", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
  const key = newKey();
  const first = await post(ctx, id, key);
  expect(first.status).toBe(200);
  expect(first.body.replayed).toBe(false);
  // The idempotency layer replays the FIRST answer verbatim; what must hold is
  // that the stock moved exactly once.
  const again = await post(ctx, id, key);
  expect(again.status).toBe(200);
  expect(again.body.count.status).toBe("POSTED");

  expect((await RawItem.findById(ctx.item._id).lean()).quantity).toBe(8); // moved once
  expect(await LocationMovement.countDocuments({ itemId: ctx.item._id, "source.kind": "stock_count" })).toBe(1);
});

test("posting again under a DIFFERENT key is refused, not applied twice", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
  expect((await post(ctx, id, newKey())).status).toBe(200);
  const second = await post(ctx, id, newKey());
  expect(second.status).toBe(409);
  expect(second.body.error?.details?.reason).toBe("ALREADY_POSTED");
  expect((await RawItem.findById(ctx.item._id).lean()).quantity).toBe(8);
});

// ── Two concurrent posts ─────────────────────────────────────────────────────
test("two concurrent posts cannot both apply", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
  const [a, b] = await Promise.all([post(ctx, id, newKey()), post(ctx, id, newKey())]);
  const statuses = [a.status, b.status].sort();
  expect(statuses[0]).toBe(200);
  expect(statuses[1]).toBeGreaterThanOrEqual(400);
  // Applied exactly once.
  expect((await RawItem.findById(ctx.item._id).lean()).quantity).toBe(8);
  expect(await LocationMovement.countDocuments({ itemId: ctx.item._id, "source.kind": "stock_count" })).toBe(1);
  expect(await StockCount.countDocuments({ _id: id, status: "POSTED" })).toBe(1);
});

// ── Posted is immutable ──────────────────────────────────────────────────────
test("a posted count cannot be edited, reposted or deleted", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
  expect((await post(ctx, id)).status).toBe(200);

  // Edit refused at the model layer.
  const doc = await StockCount.findById(id);
  doc.cancelReason = "tampered";
  await expect(doc.save()).rejects.toThrow(/posted stock count/i);

  // Re-review / re-post refused at the route.
  const rev = await call(`/api/cms/inventory/stock-counts/${id}/review`, { method: "POST", token: ctx.token, body: { entries: [] } });
  expect(rev.status).toBe(409);

  // Delete refused.
  const posted = await StockCount.findById(id);
  await expect(posted.deleteOne()).rejects.toThrow(/posted stock count/i);
});

// ── Add item found → post a positive correction ──────────────────────────────
const addFound = (ctx, id, body) => call(`/api/cms/inventory/stock-counts/${id}/lines`, { method: "POST", token: ctx.token, body });

test("an item found in an empty location posts a positive correction end to end", async () => {
  const ctx = await setup({ placed: 0, quantity: 4 }); // ctx.item exists, none placed
  // Its own location has nothing → snapshot is empty.
  const started = (await call("/api/cms/inventory/stock-counts", { method: "POST", token: ctx.token, body: {
    warehouseId: String(ctx.wh._id), locationId: String(ctx.stock._id),
  } })).body;
  expect(started.count.lines).toHaveLength(0);

  const add = await addFound(ctx, started.count._id, { rawItemId: String(ctx.item._id), wholeItem: true });
  expect(add.status).toBe(200);
  const lineId = add.body.count.lines[0].lineId;
  expect(add.body.count.lines[0].expectedQty).toBe(0);

  await call(`/api/cms/inventory/stock-counts/${started.count._id}/review`, { method: "POST", token: ctx.token, body: {
    entries: [{ lineId, counted: true, countedQty: 3, varianceReason: "found on the floor" }], recordVersion: add.body.count.recordVersion,
  } });
  const r = await post(ctx, started.count._id);
  expect(r.status).toBe(200);
  expect(r.body.outcome.discrepanciesPosted).toBe(1);
  expect(r.body.outcome.linesAdded).toBe(1);

  const item = await RawItem.findById(ctx.item._id).lean();
  expect(item.quantity).toBe(7); // company 4 → 7 (+3 found)
  const locBal = await LocationBalance.findOne({ itemId: ctx.item._id, locationId: ctx.stock._id, variantId: null }).lean();
  expect(locBal.onHand).toBe(3); // location 0 → 3
  const mv = await LocationMovement.findOne({ itemId: ctx.item._id, "source.kind": "stock_count" }).lean();
  expect(mv.direction).toBe("in");
});

test("the outcome reports counted and not-counted rows honestly", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const extra = await rawItem(ctx.c._id, { name: "Second" });
  await place(ctx.c._id, ctx.wh, ctx.stock, await RawItem.findById(extra._id).lean(), 4);
  const started = (await call("/api/cms/inventory/stock-counts", { method: "POST", token: ctx.token, body: {
    warehouseId: String(ctx.wh._id), locationId: String(ctx.stock._id),
  } })).body;
  // Count only the first line; leave the second NOT counted.
  const first = started.count.lines.find((l) => l.rawItemId === String(ctx.item._id));
  await call(`/api/cms/inventory/stock-counts/${started.count._id}/review`, { method: "POST", token: ctx.token, body: {
    entries: [{ lineId: first.lineId, counted: true, countedQty: 5, varianceReason: "one short" }], recordVersion: started.count.recordVersion,
  } });
  const r = await post(ctx, started.count._id);
  expect(r.status).toBe(200);
  expect(r.body.outcome.totalLines).toBe(2);
  expect(r.body.outcome.linesCounted).toBe(1);
  expect(r.body.outcome.notCountedCount).toBe(1);           // the blank row is REPORTED, not dropped
  expect(r.body.outcome.notCounted[0].rawItemName).toBe("Second");
  // The not-counted item's stock is untouched.
  expect((await RawItem.findById(extra._id).lean()).quantity).toBe(10);
});

// ── Valuation receives the correction once ───────────────────────────────────
test("the valuation replay sees the correction exactly once", async () => {
  const ctx = await setup({ placed: 6, quantity: 10 });
  const { id } = await reviewed(ctx, () => ({ countedQty: 4, reason: "damaged" }));
  const key = newKey();
  await post(ctx, id, key);
  await post(ctx, id, key); // replay must not add a second correction

  const item = await RawItem.findById(ctx.item._id).lean();
  // The correction is in the valuation stream EXACTLY ONCE — a replay does not
  // write a second REDUCE, so a moving-average replay would not double-count it.
  const corrections = (item.stockTransactions || []).filter((t) => /Stock count/.test(t.reason || ""));
  expect(corrections).toHaveLength(1);
  expect(corrections[0].type).toBe("REDUCE");
  expect(corrections[0].quantity).toBe(2);
  // The valuation engine reads these transactions and applies the one correction
  // once: the replay moves the on-hand down by exactly the corrected quantity.
  const valued = valuation.valueItem(item);
  expect(valued.storedOnHand).toBe(8);
});
