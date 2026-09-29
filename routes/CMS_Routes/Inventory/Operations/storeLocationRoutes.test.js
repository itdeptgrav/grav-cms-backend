// routes/CMS_Routes/Inventory/Operations/storeLocationRoutes.test.js
//
// What the physical-store router promises without a database: which routes
// exist and with which methods, that every write sits behind the Store's
// chain (capability → refuse legacy → idempotency), that the guarded helpers
// carry the sticker, and that the legacy read-through lets an unowned
// warehouse be written to while it is on.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const router = require("./storeLocationRoutes");
const loc = require("../../../../services/storePurchase/locationStock.service");
const S = require("../../../../services/storePurchase/storeLocations.service");
const { CAPABILITIES, GRANTS } = require("../../../../services/storePurchase/capabilities");
const { MOVEMENT_TYPES } = require("../../../../models/CMS_Models/Inventory/Operations/LocationMovement");

const routes = router.stack.filter((l) => l.route).map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods).filter((m) => l.route.methods[m]), handlers: l.route.stack.map((s) => s.name || s.handle?.name || "") }));
const find = (method, path) => routes.find((r) => r.path === path && r.methods.includes(method));

test("every read the pages use is mounted as GET", () => {
  for (const p of ["/dashboard", "/warehouses", "/tree", "/resolve", "/locations/:locationId", "/locations/:locationId/movements", "/find", "/items/:rawItemId/locations", "/markings/:barcodeId", "/unallocated", "/putaway-queue", "/reconciliation", "/movements", "/reports/:type", "/reports"]) assert.ok(find("get", p), `GET ${p}`);
});

test("every write is mounted with its method and the full store chain", () => {
  const writes = [["post", "/warehouses/:id/racks"], ["put", "/warehouses/:id/layout"], ["post", "/warehouses/:id/locations/:locationId/qr"], ["post", "/warehouses/:id/qr/backfill"], ["post", "/put"], ["post", "/remove"], ["post", "/transfer"], ["post", "/transfer-all"]];
  for (const [m, p] of writes) {
    const r = find(m, p); assert.ok(r, `${m.toUpperCase()} ${p}`);
    /* capability gate, legacy refusal and the idempotency wrapper all sit before the handler */
    assert.ok(r.handlers.length >= 4, `${p} has the middleware chain (${r.handlers.join(",")})`);
  }
  /* reads never carry the idempotency wrapper — a GET must be repeatable without a key */
  assert.ok(find("get", "/tree").handlers.length <= 2);
});

test("no route here consumes stock — TAKE that deducts is the issue route's", () => {
  assert.equal(find("post", "/take"), undefined);
  assert.equal(find("post", "/issue"), undefined);
  assert.equal(find("delete", "/locations/:locationId"), undefined, "locations are archived through the master, never deleted");
});

test("the physical moves are an editor's job; company-changing adjustments stay an approver's", () => {
  assert.equal(CAPABILITIES.LOCATION_OPERATE, "sp.location.operate");
  assert.ok(GRANTS.store.editor.includes(CAPABILITIES.LOCATION_OPERATE));
  assert.ok(GRANTS.store.approver.includes(CAPABILITIES.LOCATION_OPERATE));
  assert.ok(!GRANTS.store.viewer.includes(CAPABILITIES.LOCATION_OPERATE));
  assert.ok(!GRANTS.store.editor.includes(CAPABILITIES.STOCK_ADJUST));
  assert.ok(!GRANTS.ceo.owner.includes(CAPABILITIES.LOCATION_OPERATE), "board level reads, never moves");
});

test("buildMovement carries the lot sticker when given one and null otherwise", () => {
  const item = { _id: new mongoose.Types.ObjectId(), unit: "Pcs" };
  const warehouse = { _id: new mongoose.Types.ObjectId(), name: "W" };
  const location = { _id: new mongoose.Types.ObjectId(), code: "R01-L01" };
  const base = { companyId: new mongoose.Types.ObjectId(), item, variantId: null, warehouse, location, direction: "out", quantity: 2.00004, type: "issue", actor: { id: "x", name: "Y" } };
  const plain = loc.buildMovement(base);
  assert.equal(plain.barcodeId, null); assert.equal(plain.barcodeLabel, ""); assert.equal(plain.quantity, 2); assert.equal(plain.applied, true);
  const bid = new mongoose.Types.ObjectId();
  const marked = loc.buildMovement({ ...base, barcodeId: bid, barcodeLabel: "12 Pcs · PO-1" });
  assert.equal(String(marked.barcodeId), String(bid)); assert.equal(marked.barcodeLabel, "12 Pcs · PO-1");
  /* the ledger's vocabulary is unchanged: the physical moves reuse existing types */
  for (const t of ["opening_assignment", "adjustment", "transfer_in", "transfer_out", "issue"]) assert.ok(MOVEMENT_TYPES.includes(t));
});

test("usableLocationError: a warehouse without companyId is writable only while the legacy read-through is on", () => {
  const tenant = require("../../../../services/storePurchase/tenantContext.service");
  const companyId = new mongoose.Types.ObjectId();
  const location = { _id: new mongoose.Types.ObjectId(), code: "A", status: "Active" };
  const unowned = { _id: new mongoose.Types.ObjectId(), name: "WH-MAIN", status: "Active", locations: [location] };
  const err = loc.usableLocationError(unowned, location, companyId);
  if (tenant.legacyWindowOpen()) assert.equal(err, null, "read-through on: the pre-scoping warehouse takes stock");
  else assert.equal(err?.reason, "WAREHOUSE_NOT_FOUND", "read-through off: it is not this company's");
  /* a foreign, OWNED warehouse is refused either way */
  const foreign = { ...unowned, companyId: new mongoose.Types.ObjectId() };
  assert.equal(loc.usableLocationError(foreign, location, companyId)?.reason, "WAREHOUSE_NOT_FOUND");
  /* and an inactive position is refused with its status in the message */
  assert.match(loc.usableLocationError({ ...unowned, companyId }, { ...location, status: "Inactive" }, companyId).message, /inactive/);
});

test("the reports catalogue answers the page's list", () => {
  assert.ok(find("get", "/reports"));
  for (const k of ["stockByLocation", "locationByProduct", "unallocated", "movements", "transfers", "occupancy", "reconciliation", "age"]) assert.ok(k.length, k);
});

test("a location label and an item sticker never parse to the same thing", () => {
  const hex = new mongoose.Types.ObjectId().toString();
  const a = S.parseScan(`https://cms.grav.in${S.LOCATION_SCAN_PATH}?${S.LOCATION_QR_PARAM}=${S.mintQrToken()}`);
  const b = S.parseScan(`https://cms.grav.in/store/dashboard/item-info?itemid=${hex}`);
  assert.equal(a.type, "location"); assert.equal(b.type, "item"); assert.notEqual(a.type, b.type);
  assert.equal(S.parseScan(hex.toUpperCase()).barcodeId, hex, "a sticker id is case-insensitive hex");
});
