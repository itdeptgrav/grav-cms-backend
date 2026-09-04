// test/store-purchase/location-stock.route.test.js
//
// Warehouse Stock V1 — the location ledger and its operations. Proves location
// balances derive from immutable movements, reconcile exactly to RawItem's
// company-wide on-hand, and that assign/transfer never change the company total
// while issue changes it atomically with the location write.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/locations", require("../../routes/CMS_Routes/Inventory/Operations/locationStockRoutes"));
  // The CANONICAL manual stock in/out — now location-aware. Location tests use
  // it to prove issues go through real stock history, not a standalone path.
  app.use("/api/cms/inventory/stock-adjustments", require("../../routes/CMS_Routes/Inventory/Products/stockAdjustments"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const oid = () => new mongoose.Types.ObjectId();
const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const newKey = () => `k-${++seq}-${Math.random().toString(36).slice(2)}`;

async function actor(company) {
  const n = ++seq;
  const email = `loc${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "Loc", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef, personName: "Loc" });
  return tokenFor({ id: String(employeeRef), email });
}

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

const warehouse = (companyId, over = {}) =>
  Warehouse.create({
    companyId, name: over.name || `WH ${++seq}`, shortName: over.shortName || `W${seq}`,
    status: over.status || "Active",
    locations: over.locations || [
      { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
      { code: "STOCK", name: "Usable stock", type: "USABLE_STOCK", status: "Active" },
    ],
  });

const rawItem = (companyId, over = {}) =>
  RawItem.create({
    companyId, sku: over.sku || `RAW-${++seq}`, name: over.name || `Item ${seq}`,
    unit: over.unit || "PCS", quantity: over.quantity != null ? over.quantity : 10,
    variants: over.variants || [],
  });

// A ready scenario: company, active warehouse with RECV+STOCK, an item on-hand 10.
async function scene({ quantity = 10, variants } = {}) {
  const c = await company();
  const wh = await warehouse(c._id);
  const [recv, stock] = wh.locations;
  const item = await rawItem(c._id, { quantity, variants });
  const token = await actor(c);
  return { c, wh, recv, stock, item, token };
}

// ── Legacy / derivation ──────────────────────────────────────────────────────
describe("legacy stock and derivation", () => {
  // 10 + 11
  test("legacy stock with no movements reads as Unassigned, never zero or guessed", async () => {
    const s = await scene({ quantity: 10 });
    const r = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(r.status).toBe(200);
    expect(r.body.item.onHand).toBe(10);
    expect(r.body.item.assigned).toBe(0);
    expect(r.body.item.unassigned).toBe(10); // all unassigned, not zero, not a guessed warehouse
    expect(r.body.item.balances).toEqual([]);
    // reconcile: assigned + unassigned === onHand
    expect(r.body.item.assigned + r.body.item.unassigned).toBe(r.body.item.onHand);
  });
});

// ── Assign ───────────────────────────────────────────────────────────────────
describe("assign existing stock", () => {
  const assign = (s, qty, key, over = {}) =>
    call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: key || newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: qty, ...over,
    } });

  // 3
  test("assignment cannot exceed current on-hand", async () => {
    const s = await scene({ quantity: 10 });
    const r = await assign(s, 11);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("EXCEEDS_ON_HAND");
  });

  // 1 (via assign) + 4 + 11
  test("a partial assignment leaves the correct Unassigned amount and preserves the total", async () => {
    const s = await scene({ quantity: 10 });
    const before = (await RawItem.findById(s.item._id).lean()).quantity;
    const r = await assign(s, 6);
    expect([200, 201]).toContain(r.status);
    const after = (await RawItem.findById(s.item._id).lean()).quantity;
    expect(after).toBe(before); // company total unchanged by placement
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.assigned).toBe(6);
    expect(view.body.item.unassigned).toBe(4);
    expect(view.body.item.assigned + view.body.item.unassigned).toBe(10); // reconcile
    expect(view.body.item.balances[0].onHand).toBe(6);
  });
});

// ── Receipt ──────────────────────────────────────────────────────────────────
describe("receipt to a location", () => {
  // 1
  test("a receipt records the selected destination and preserves the company total", async () => {
    const s = await scene({ quantity: 10 });
    const before = (await RawItem.findById(s.item._id).lean()).quantity;
    const r = await call("/api/cms/inventory/locations/receipt", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.recv._id), quantity: 4, reference: "GRN-1",
    } });
    expect([200, 201]).toContain(r.status);
    const after = (await RawItem.findById(s.item._id).lean()).quantity;
    expect(after).toBe(before); // preserved
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    const recvBal = view.body.item.balances.find((b) => b.locationId === String(s.recv._id));
    expect(recvBal.onHand).toBe(4);
    expect(recvBal.locationCode).toBe("RECV");
  });
});

// ── Issue ────────────────────────────────────────────────────────────────────
describe("issue from a location", () => {
  // 2
  test("issue refuses more than the selected location holds", async () => {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 5,
    } });
    const r = await call("/api/cms/inventory/locations/issue", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 6, reason: "over-issue",
    } });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("INSUFFICIENT_AT_LOCATION");
  });

  test("issue reduces the company total and the location together", async () => {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 8,
    } });
    const r = await call("/api/cms/inventory/locations/issue", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 3, reason: "issued to floor",
    } });
    expect([200, 201]).toContain(r.status);
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(7); // 10 − 3
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    const bal = view.body.item.balances.find((b) => b.locationId === String(s.stock._id));
    expect(bal.onHand).toBe(5); // 8 − 3
    expect(view.body.item.assigned + view.body.item.unassigned).toBe(7); // reconcile to new total
  });

  // 9
  test("a refused issue leaves no orphan location entry", async () => {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 5,
    } });
    // Company on-hand quietly drops to 3 (as if depleted by another flow), while
    // the location still shows 5. An issue of 5 passes the location soft-check
    // but the atomic company guard refuses — and must write NO location entry.
    await RawItem.updateOne({ _id: s.item._id }, { $set: { quantity: 3 } });
    const r = await call("/api/cms/inventory/locations/issue", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 5, reason: "x",
    } });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("INSUFFICIENT_ON_HAND");
    expect(await LocationMovement.countDocuments({ itemId: s.item._id, type: "issue" })).toBe(0);
  });
});

// ── Transfer ─────────────────────────────────────────────────────────────────
describe("internal transfer", () => {
  async function assignedScene() {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 10,
    } });
    return s;
  }
  const transferBody = (s, qty) => ({
    rawItemId: String(s.item._id),
    fromWarehouseId: String(s.wh._id), fromLocationId: String(s.stock._id),
    toWarehouseId: String(s.wh._id), toLocationId: String(s.recv._id),
    quantity: qty,
  });

  // 6
  test("a transfer writes equal out/in legs and leaves the company total unchanged", async () => {
    const s = await assignedScene();
    const before = (await RawItem.findById(s.item._id).lean()).quantity;
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 4) });
    expect([200, 201]).toContain(r.status);
    expect((await RawItem.findById(s.item._id).lean()).quantity).toBe(before); // unchanged
    const legs = await LocationMovement.find({ transferId: new mongoose.Types.ObjectId(r.body.transfer.transferId) }).lean();
    expect(legs).toHaveLength(2);
    const out = legs.find((l) => l.type === "transfer_out");
    const inn = legs.find((l) => l.type === "transfer_in");
    expect(out.quantity).toBe(4);
    expect(inn.quantity).toBe(4);
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.balances.find((b) => b.locationId === String(s.stock._id)).onHand).toBe(6);
    expect(view.body.item.balances.find((b) => b.locationId === String(s.recv._id)).onHand).toBe(4);
  });

  test("a transfer refuses more than the source holds", async () => {
    const s = await assignedScene();
    // move 10 → stock now 0 at recv... actually stock holds 10; ask for 11
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: transferBody(s, 11) });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("INSUFFICIENT_AT_SOURCE");
  });

  test("same source and destination is refused", async () => {
    const s = await assignedScene();
    const r = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key: newKey(), body: {
      ...transferBody(s, 1), toLocationId: String(s.stock._id),
    } });
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("SAME_LOCATION");
  });

  // 7
  test("replaying the same transfer key does not duplicate either leg", async () => {
    const s = await assignedScene();
    const key = newKey();
    const first = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key, body: transferBody(s, 4) });
    expect([200, 201]).toContain(first.status);
    const second = await call("/api/cms/inventory/locations/transfer", { method: "POST", token: s.token, key, body: transferBody(s, 4) });
    expect([200, 201]).toContain(second.status); // replayed, not a new transfer
    expect(await LocationMovement.countDocuments({ itemId: s.item._id, type: { $in: ["transfer_in", "transfer_out"] } })).toBe(2);
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    expect(view.body.item.balances.find((b) => b.locationId === String(s.stock._id)).onHand).toBe(6); // not 2
  });
});

// ── Variants ─────────────────────────────────────────────────────────────────
describe("variant separation", () => {
  // 5
  test("variant balances remain separate", async () => {
    const vA = oid(); const vB = oid();
    const s = await scene({ variants: [{ _id: vA, sku: "V-A", combination: ["A"], quantity: 6 }, { _id: vB, sku: "V-B", combination: ["B"], quantity: 4 }], quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), variantId: String(vA), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 5,
    } });
    const view = await call(`/api/cms/inventory/locations/item/${s.item._id}`, { token: s.token });
    const a = view.body.variants.find((v) => v.variantId === String(vA));
    const b = view.body.variants.find((v) => v.variantId === String(vB));
    expect(a.assigned).toBe(5); expect(a.unassigned).toBe(1); // on-hand 6
    expect(b.assigned).toBe(0); expect(b.unassigned).toBe(4); // untouched
  });
});

// ── Boundary refusals ────────────────────────────────────────────────────────
describe("location boundary refusals", () => {
  const assignTo = (s, wid, lid) =>
    call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(wid), locationId: String(lid), quantity: 1,
    } });

  // 8
  test("an inactive location is refused", async () => {
    const s = await scene();
    const wh = await warehouse(s.c._id, { locations: [{ code: "OLD", name: "Old", type: "USABLE_STOCK", status: "Inactive" }] });
    const r = await assignTo(s, wh._id, wh.locations[0]._id);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("LOCATION_INACTIVE");
  });
  test("an archived warehouse is refused", async () => {
    const s = await scene();
    const wh = await warehouse(s.c._id, { status: "Archived" });
    const r = await assignTo(s, wh._id, wh.locations[0]._id);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("WAREHOUSE_INACTIVE");
  });
  test("a cross-company warehouse is not found", async () => {
    const s = await scene();
    const other = await company();
    const wh = await warehouse(other._id);
    const r = await assignTo(s, wh._id, wh.locations[0]._id);
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("WAREHOUSE_NOT_FOUND");
  });
  test("a location from the wrong warehouse is not found", async () => {
    const s = await scene();
    const otherWh = await warehouse(s.c._id);
    const r = await assignTo(s, s.wh._id, otherWh.locations[0]._id); // location belongs to otherWh
    expect(r.status).toBe(400);
    expect(r.body.error?.details?.reason).toBe("LOCATION_NOT_FOUND");
  });
});

// ── Warehouse view ───────────────────────────────────────────────────────────
describe("warehouse stock view", () => {
  test("warehouse detail lists items held per location", async () => {
    const s = await scene({ quantity: 10 });
    await call("/api/cms/inventory/locations/assign", { method: "POST", token: s.token, key: newKey(), body: {
      rawItemId: String(s.item._id), warehouseId: String(s.wh._id), locationId: String(s.stock._id), quantity: 7,
    } });
    const r = await call(`/api/cms/inventory/locations/warehouse/${s.wh._id}`, { token: s.token });
    expect(r.status).toBe(200);
    const stockLoc = r.body.locations.find((l) => l.locationId === String(s.stock._id));
    expect(stockLoc.items).toHaveLength(1);
    expect(stockLoc.items[0].onHand).toBe(7);
    expect(String(stockLoc.items[0].itemId)).toBe(String(s.item._id));
  });
});
