// test/store-purchase/stock-count.route.test.js
//
// Warehouse Stock Count V1 — the count workflow up to (not including) the
// transactional post. Runs on the default STANDALONE harness, where posting is
// deliberately refused (503) because it cannot be made atomic — the post itself
// is proven on a replica set in stock-count-post.replset.test.js.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const StockCount = require("../../models/CMS_Models/Inventory/Operations/StockCount");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/locations", require("../../routes/CMS_Routes/Inventory/Operations/locationStockRoutes"));
  app.use("/api/cms/inventory/stock-counts", require("../../routes/CMS_Routes/Inventory/Operations/stockCountRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const newKey = () => `k-${++seq}-${Math.random().toString(36).slice(2)}`;

async function actor(company) {
  const email = `sc${++seq}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "SC", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "SC" });
  return tokenFor({ id: String(employeeRef), email });
}

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
const warehouse = (companyId, over = {}) =>
  Warehouse.create({
    companyId, name: over.name || `WH ${++seq}`, shortName: over.shortName || `W${seq}`, status: over.status || "Active",
    locations: over.locations || [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "STOCK", name: "Usable stock", type: "USABLE_STOCK", status: "Active" },
    ],
  });
const rawItem = (companyId, over = {}) =>
  RawItem.create({
    companyId, sku: over.sku || `RAW-${++seq}`, name: over.name || `Item ${seq}`,
    unit: over.unit || "PCS", quantity: over.quantity != null ? over.quantity : 10,
    category: over.category || "", variants: over.variants || [],
  });

const assign = (token, wh, loc, item, qty, variantId) =>
  call("/api/cms/inventory/locations/assign", { method: "POST", token, key: newKey(), body: {
    rawItemId: String(item._id), warehouseId: String(wh._id), locationId: String(loc._id), quantity: qty,
    ...(variantId ? { variantId: String(variantId) } : {}),
  } });

const start = (token, wh, loc, over = {}) =>
  call("/api/cms/inventory/stock-counts", { method: "POST", token, body: {
    warehouseId: String(wh._id), locationId: String(loc._id), ...over,
  } });

const saveEntries = (token, id, entries, recordVersion) =>
  call(`/api/cms/inventory/stock-counts/${id}`, { method: "PUT", token, body: { entries, recordVersion } });
const review = (token, id, entries, recordVersion) =>
  call(`/api/cms/inventory/stock-counts/${id}/review`, { method: "POST", token, body: { entries, recordVersion } });
const getCount = (token, id) => call(`/api/cms/inventory/stock-counts/${id}`, { token });

// A location holding a whole-item scope (6 of an item on-hand 10) at STOCK.
async function scene({ quantity = 10, place = 6, unit = "PCS", category = "" } = {}) {
  const c = await company();
  const wh = await warehouse(c._id);
  const [recv, stock] = wh.locations;
  const token = await actor(c);
  const item = await rawItem(c._id, { quantity, unit, category });
  if (place > 0) {
    const a = await assign(token, wh, stock, item, place);
    if (![200, 201].includes(a.status)) throw new Error(`assign failed: ${JSON.stringify(a.body)}`);
  }
  return { c, wh, recv, stock, item, token };
}

const lineFor = (body, itemId, variantId = null) =>
  body.count.lines.find((l) => l.rawItemId === String(itemId) && (variantId ? l.variantId === String(variantId) : !l.variantId));

// ── 1 · Start & snapshot ─────────────────────────────────────────────────────
describe("starting a count freezes the expected snapshot", () => {
  test("start creates a DRAFT with one frozen line per located scope", async () => {
    const s = await scene({ place: 6 });
    const r = await start(s.token, s.wh, s.stock);
    expect(r.status).toBe(201);
    expect(r.body.count.status).toBe("DRAFT");
    expect(r.body.count.countNumber).toMatch(/^SC-\d{5}$/);
    const line = lineFor(r.body, s.item._id);
    expect(line.expectedQty).toBe(6);
    expect(line.counted).toBe(false);
    expect(line.countedQty).toBeNull();
  });

  test("an empty location is a valid count with no lines", async () => {
    const c = await company(); const wh = await warehouse(c._id); const token = await actor(c);
    const r = await start(token, wh, wh.locations[1]);
    expect(r.status).toBe(201);
    expect(r.body.count.lines).toHaveLength(0);
    expect(r.body.count.progress.total).toBe(0);
  });

  test("an inactive location is refused before any snapshot", async () => {
    const c = await company();
    const wh = await warehouse(c._id, { locations: [{ code: "STOCK", name: "S", type: "USABLE_STOCK", status: "Inactive" }] });
    const token = await actor(c);
    const r = await start(token, wh, wh.locations[0]);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("LOCATION_INACTIVE");
  });

  test("a foreign warehouse is not found, never forbidden", async () => {
    const s = await scene();
    const other = await company();
    const foreignWh = await warehouse(other._id);
    const r = await start(s.token, foreignWh, foreignWh.locations[1]);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("WAREHOUSE_NOT_FOUND");
  });

  test("only one open count per location", async () => {
    const s = await scene();
    const a = await start(s.token, s.wh, s.stock);
    expect(a.status).toBe(201);
    const b = await start(s.token, s.wh, s.stock);
    expect(b.status).toBe(409);
    expect(b.body.error?.details?.reason).toBe("OPEN_COUNT_EXISTS");
  });
});

// ── 2 · Item and variants counted separately ─────────────────────────────────
describe("item and variants are separate rows", () => {
  test("each variant placed at a location is its own line", async () => {
    const c = await company(); const wh = await warehouse(c._id); const [, stock] = wh.locations;
    const token = await actor(c);
    const item = await rawItem(c._id, { quantity: 10, variants: [
      { combination: ["Red"], quantity: 5, sku: "V-RED" },
      { combination: ["Blue"], quantity: 5, sku: "V-BLUE" },
    ] });
    const fresh = await RawItem.findById(item._id).lean();
    await assign(token, wh, stock, item, 4, fresh.variants[0]._id);
    await assign(token, wh, stock, item, 3, fresh.variants[1]._id);
    const r = await start(token, wh, stock);
    expect(r.status).toBe(201);
    const red = lineFor(r.body, item._id, fresh.variants[0]._id);
    const blue = lineFor(r.body, item._id, fresh.variants[1]._id);
    expect(red.expectedQty).toBe(4);
    expect(blue.expectedQty).toBe(3);
    expect(red.variantSku).toBe("V-RED");
    // No aggregated whole-item line — the variants stand alone.
    expect(r.body.count.lines.filter((l) => l.rawItemId === String(item._id) && !l.variantId)).toHaveLength(0);
  });
});

// ── 3 · Zero counted differs from not counted ────────────────────────────────
describe("a recorded zero is not the same as not counted", () => {
  test("counted:true qty 0 is a variance; counted:false is not", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body;
    const line = started.count.lines[0];

    // Recorded zero → variance of −6.
    const zero = await saveEntries(s.token, started.count._id, [{ lineId: line.lineId, counted: true, countedQty: 0 }], started.count.recordVersion);
    const zeroLine = zero.body.count.lines[0];
    expect(zeroLine.counted).toBe(true);
    expect(zeroLine.countedQty).toBe(0);
    expect(zeroLine.variance).toBe(-6);
    expect(zeroLine.hasVariance).toBe(true);

    // Now clear it back to "not counted" → no variance, no number.
    const not = await saveEntries(s.token, started.count._id, [{ lineId: line.lineId, counted: false }], zero.body.count.recordVersion);
    const notLine = not.body.count.lines[0];
    expect(notLine.counted).toBe(false);
    expect(notLine.countedQty).toBeNull();
    expect(notLine.hasVariance).toBe(false);
    expect(not.body.count.progress.remaining).toBe(1);
  });
});

// ── 4 · Mixed units are never summed ─────────────────────────────────────────
describe("mixed units are grouped, never summed", () => {
  test("the review summary keeps PCS and KG in separate groups", async () => {
    const c = await company(); const wh = await warehouse(c._id); const [, stock] = wh.locations;
    const token = await actor(c);
    const pcs = await rawItem(c._id, { quantity: 10, unit: "PCS" });
    const kg = await rawItem(c._id, { quantity: 10, unit: "KG" });
    await assign(token, wh, stock, pcs, 6);
    await assign(token, wh, stock, kg, 5);
    const started = (await start(token, wh, stock)).body;
    const entries = started.count.lines.map((l) => ({ lineId: l.lineId, counted: true, countedQty: l.rawItemId === String(pcs._id) ? 7 : 5, varianceReason: "recount" }));
    const rev = await review(token, started.count._id, entries, started.count.recordVersion);
    expect(rev.status).toBe(200);
    const groups = rev.body.count.summary.groups;
    const units = groups.map((g) => g.unit).sort();
    expect(units).toEqual(["KG", "PCS"]);
    // There is no field anywhere that totals across units.
    expect(rev.body.count.summary).not.toHaveProperty("varianceTotal");
  });
});

// ── 5 · Blind count hides expected until review ──────────────────────────────
describe("a blind count hides the expected quantity", () => {
  test("expected is withheld while counting and revealed at review", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock, { mode: "BLIND" })).body;
    expect(started.count.expectedHidden).toBe(true);
    expect(started.count.lines[0]).not.toHaveProperty("expectedQty");
    expect(started.count.summary).toBeUndefined();

    const reload = await getCount(s.token, started.count._id);
    expect(reload.body.count.lines[0]).not.toHaveProperty("expectedQty");

    const entries = [{ lineId: started.count.lines[0].lineId, counted: true, countedQty: 5, varianceReason: "short by one" }];
    const rev = await review(s.token, started.count._id, entries, started.count.recordVersion);
    expect(rev.status).toBe(200);
    expect(rev.body.count.expectedHidden).toBe(false);
    expect(rev.body.count.lines[0].expectedQty).toBe(6);
    expect(rev.body.count.lines[0].variance).toBe(-1);
  });
});

// ── 6 · Review requires a reason for every non-zero variance ──────────────────
describe("review demands a reason for every discrepancy", () => {
  test("a discrepancy with no reason is refused; with a reason it passes", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body;
    const lineId = started.count.lines[0].lineId;

    const bad = await review(s.token, started.count._id, [{ lineId, counted: true, countedQty: 4 }], started.count.recordVersion);
    expect(bad.status).toBe(400);
    expect(bad.body.error?.details?.reason).toBe("REASON_REQUIRED");

    const ok = await review(s.token, started.count._id, [{ lineId, counted: true, countedQty: 4, varianceReason: "two damaged" }], started.count.recordVersion);
    expect(ok.status).toBe(200);
    expect(ok.body.count.status).toBe("REVIEWED");
  });

  test("a zero-variance count needs no reason", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body;
    const ok = await review(s.token, started.count._id, [{ lineId: started.count.lines[0].lineId, counted: true, countedQty: 6 }], started.count.recordVersion);
    expect(ok.status).toBe(200);
    expect(ok.body.count.lines[0].hasVariance).toBe(false);
  });
});

// ── 7 · Frozen snapshot + conflict ───────────────────────────────────────────
describe("the expected snapshot stays frozen and a later movement is a conflict", () => {
  test("assigning more after start does not change the frozen expected, and review flags a conflict", async () => {
    const s = await scene({ quantity: 10, place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body;
    expect(started.count.lines[0].expectedQty).toBe(6);

    // Something moves the location AFTER the snapshot: assign 2 more (6 → 8).
    await assign(s.token, s.wh, s.stock, s.item, 2);

    // The frozen expected is unchanged.
    const reload = await getCount(s.token, started.count._id);
    expect(reload.body.count.lines[0].expectedQty).toBe(6);

    // Review surfaces it as a conflict rather than absorbing it.
    const entries = [{ lineId: started.count.lines[0].lineId, counted: true, countedQty: 5, varianceReason: "recount" }];
    const rev = await review(s.token, started.count._id, entries, started.count.recordVersion);
    expect(rev.status).toBe(200);
    expect(rev.body.count.conflicts).toHaveLength(1);
    expect(rev.body.count.conflicts[0].expected).toBe(6);
    expect(rev.body.count.conflicts[0].current).toBe(8);
  });
});

// ── 8 · Cancel ───────────────────────────────────────────────────────────────
describe("cancelling an open count", () => {
  test("cancel needs a reason and then frees the location for a new count", async () => {
    const s = await scene();
    const started = (await start(s.token, s.wh, s.stock)).body;

    const noReason = await call(`/api/cms/inventory/stock-counts/${started.count._id}/cancel`, { method: "POST", token: s.token, body: {} });
    expect(noReason.status).toBe(400);

    const cancelled = await call(`/api/cms/inventory/stock-counts/${started.count._id}/cancel`, { method: "POST", token: s.token, body: { reason: "duplicate count" } });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.count.status).toBe("CANCELLED");

    // The location is open again.
    const again = await start(s.token, s.wh, s.stock);
    expect(again.status).toBe(201);
  });
});

// ── 9 · Stale save is refused ────────────────────────────────────────────────
describe("a stale entry save cannot clobber a newer one", () => {
  test("saving against an old recordVersion is refused", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body;
    const lineId = started.count.lines[0].lineId;
    const first = await saveEntries(s.token, started.count._id, [{ lineId, counted: true, countedQty: 5 }], started.count.recordVersion);
    expect(first.status).toBe(200);
    // Reuse the ORIGINAL version — now stale.
    const stale = await saveEntries(s.token, started.count._id, [{ lineId, counted: true, countedQty: 4 }], started.count.recordVersion);
    expect(stale.status).toBe(409);
    expect(stale.body.error?.details?.reason).toBe("STALE_ENTRY");
  });
});

// ── 11 · Add item found ──────────────────────────────────────────────────────
const addFound = (token, id, body) => call(`/api/cms/inventory/stock-counts/${id}/lines`, { method: "POST", token, body });
const itemSearch = (token, q) => call(`/api/cms/inventory/stock-counts/item-search?q=${encodeURIComponent(q)}`, { token });

describe("adding items found during a count", () => {
  test("an empty location can add a found item, count it and review it", async () => {
    const c = await company(); const wh = await warehouse(c._id); const token = await actor(c);
    const found = await rawItem(c._id, { name: "Found Cotton", unit: "M" });
    const started = (await start(token, wh, wh.locations[1])).body;
    expect(started.count.lines).toHaveLength(0);
    expect(started.count.scope.type).toBe("COMPLETE_LOCATION");

    const added = await addFound(token, started.count._id, { rawItemId: String(found._id), wholeItem: true });
    expect(added.status).toBe(200);
    const line = added.body.count.lines[0];
    expect(line.rawItemId).toBe(String(found._id));
    expect(line.expectedQty).toBe(0);           // no location balance → frozen 0
    expect(line.addedDuringCount).toBe(true);
    expect(added.body.count.scope.type).toBe("SNAPSHOT_PLUS_ADDED");

    const counted = await review(token, started.count._id,
      [{ lineId: line.lineId, counted: true, countedQty: 5, varianceReason: "found on the floor" }], added.body.count.recordVersion);
    expect(counted.status).toBe(200);
    expect(counted.body.count.status).toBe("REVIEWED");
    expect(counted.body.count.lines[0].variance).toBe(5); // positive variance from expected 0
  });

  test("expected zero (no balance) vs the actual current quantity (balance omitted by a filter)", async () => {
    const s = await scene({ place: 6 });
    // A second item with NO balance at the location.
    const empty = await rawItem(s.c._id, { name: "Nowhere Item" });
    // Start with a filter that matches neither item → 0 lines.
    const started = (await start(s.token, s.wh, s.stock, { search: "Zzz-no-match" })).body;
    expect(started.count.lines).toHaveLength(0);
    expect(started.count.scope.type).toBe("FILTERED");

    // The item WITH a balance, omitted by the filter → freezes its ACTUAL qty (6).
    const withBal = await addFound(s.token, started.count._id, { rawItemId: String(s.item._id), wholeItem: true });
    expect(withBal.body.count.lines.find((l) => l.rawItemId === String(s.item._id)).expectedQty).toBe(6);
    // The item with NO balance → freezes 0.
    const noBal = await addFound(s.token, started.count._id, { rawItemId: String(empty._id), wholeItem: true });
    expect(noBal.body.count.lines.find((l) => l.rawItemId === String(empty._id)).expectedQty).toBe(0);
    expect(noBal.body.count.scope.type).toBe("FILTERED_PLUS_ADDED");
  });

  test("an exact variant can be added and freezes that variant's location quantity", async () => {
    const c = await company(); const wh = await warehouse(c._id); const [, stock] = wh.locations;
    const token = await actor(c);
    const item = await rawItem(c._id, { quantity: 10, variants: [
      { combination: ["Red"], quantity: 5, sku: "V-RED" }, { combination: ["Blue"], quantity: 5, sku: "V-BLUE" },
    ] });
    const fresh = await RawItem.findById(item._id).lean();
    await assign(token, wh, stock, item, 4, fresh.variants[0]._id); // Red placed 4
    const started = (await start(token, wh, stock, { search: "Zzz" })).body; // filter excludes it
    const add = await addFound(token, started.count._id, { rawItemId: String(item._id), variantId: String(fresh.variants[0]._id) });
    expect(add.status).toBe(200);
    const line = add.body.count.lines[0];
    expect(line.variantId).toBe(String(fresh.variants[0]._id));
    expect(line.expectedQty).toBe(4);
  });

  test("a foreign item and an invalid variant are refused", async () => {
    const s = await scene();
    const other = await company();
    const foreign = await rawItem(other._id, { name: "Theirs" });
    const started = (await start(s.token, s.wh, s.stock)).body;
    const foreignAdd = await addFound(s.token, started.count._id, { rawItemId: String(foreign._id), wholeItem: true });
    expect(foreignAdd.status).toBe(404); // not found, never forbidden

    const varItem = await rawItem(s.c._id, { variants: [{ combination: ["X"], quantity: 1, sku: "VX" }] });
    const noScope = await addFound(s.token, started.count._id, { rawItemId: String(varItem._id) });
    expect(noScope.status).toBe(400);
    expect(noScope.body.error?.details?.reason).toBe("SCOPE_REQUIRED");
    const badVar = await addFound(s.token, started.count._id, { rawItemId: String(varItem._id), variantId: String(new mongoose.Types.ObjectId()) });
    expect(badVar.status).toBe(400);
    expect(badVar.body.error?.details?.reason).toBe("INVALID_VARIANT");
  });

  test("a duplicate item/variant line is refused", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body; // s.item already a snapshot line
    const dup = await addFound(s.token, started.count._id, { rawItemId: String(s.item._id), wholeItem: true });
    expect(dup.status).toBe(409);
    expect(dup.body.error?.details?.reason).toBe("DUPLICATE_LINE");
  });

  test("items cannot be added once the count is reviewed or cancelled", async () => {
    const s = await scene({ place: 6 });
    const found = await rawItem(s.c._id, { name: "Late" });
    const started = (await start(s.token, s.wh, s.stock)).body;
    await review(s.token, started.count._id, [{ lineId: started.count.lines[0].lineId, counted: true, countedQty: 6 }], started.count.recordVersion);
    const afterReview = await addFound(s.token, started.count._id, { rawItemId: String(found._id), wholeItem: true });
    expect(afterReview.status).toBe(409);
    expect(afterReview.body.error?.details?.reason).toBe("NOT_EDITABLE");
  });

  test("a blind count hides an added line's expected quantity until review", async () => {
    const c = await company(); const wh = await warehouse(c._id); const token = await actor(c);
    const found = await rawItem(c._id, { name: "Blind Add" });
    const started = (await start(token, wh, wh.locations[1], { mode: "BLIND" })).body;
    const add = await addFound(token, started.count._id, { rawItemId: String(found._id), wholeItem: true });
    expect(add.body.count.lines[0]).not.toHaveProperty("expectedQty");
    const rev = await review(token, started.count._id,
      [{ lineId: add.body.count.lines[0].lineId, counted: true, countedQty: 2, varianceReason: "found two" }], add.body.count.recordVersion);
    expect(rev.body.count.lines[0].expectedQty).toBe(0);
  });

  test("a movement after an added line freezes its expected is a conflict at review", async () => {
    const c = await company(); const wh = await warehouse(c._id); const [, stock] = wh.locations;
    const token = await actor(c);
    const item = await rawItem(c._id, { quantity: 10 });
    const started = (await start(token, wh, stock)).body; // empty location, 0 lines
    const add = await addFound(token, started.count._id, { rawItemId: String(item._id), wholeItem: true });
    const lineId = add.body.count.lines[0].lineId; // expected frozen at 0
    // Something places stock at this location AFTER the line froze expected 0.
    await assign(token, wh, stock, item, 3);
    const rev = await review(token, started.count._id,
      [{ lineId, counted: true, countedQty: 5, varianceReason: "found five" }], add.body.count.recordVersion);
    expect(rev.status).toBe(200);
    expect(rev.body.count.conflicts).toHaveLength(1);
    expect(rev.body.count.conflicts[0].expected).toBe(0);
    expect(rev.body.count.conflicts[0].current).toBe(3);
  });

  test("item search is company-scoped and never returns a foreign item", async () => {
    const s = await scene();
    await rawItem(s.c._id, { name: "Searchable Widget", sku: "SW-1" });
    const other = await company();
    await rawItem(other._id, { name: "Searchable Widget", sku: "SW-2" });
    const r = await itemSearch(s.token, "Searchable");
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(1);
    expect(r.body.items[0].sku).toBe("SW-1");
    // A short term returns nothing rather than the whole master.
    expect((await itemSearch(s.token, "a")).body.items).toHaveLength(0);
  });
});

// ── 10 · Posting is refused without transactions ─────────────────────────────
describe("posting fails closed where transactions are unavailable", () => {
  test("a reviewed count refuses to post on standalone Mongo, changing nothing", async () => {
    const s = await scene({ place: 6 });
    const started = (await start(s.token, s.wh, s.stock)).body;
    const entries = [{ lineId: started.count.lines[0].lineId, counted: true, countedQty: 4, varianceReason: "two damaged" }];
    await review(s.token, started.count._id, entries, started.count.recordVersion);

    const posted = await call(`/api/cms/inventory/stock-counts/${started.count._id}/post`, { method: "POST", token: s.token, key: newKey(), body: {} });
    expect(posted.status).toBe(503);
    expect(posted.body.error?.code).toBe("STOCK_COUNT_TRANSACTION_REQUIRED");

    // Nothing changed: the item's on-hand is intact and the count is still REVIEWED.
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(10);
    expect((await StockCount.findById(started.count._id).lean()).status).toBe("REVIEWED");
  });
});
