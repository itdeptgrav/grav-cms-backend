// test/store-purchase/supplier-return-location.route.test.js
//
// Warehouse Stock V1 — supplier returns and replacement receipts now move stock
// AT A LOCATION. This suite proves the location half of that flow:
//   · a return reduces ONLY the chosen item/variant location;
//   · an insufficient source refuses and changes nothing;
//   · a tracked return with no source is refused with LOCATION_REQUIRED;
//   · a replacement credits ONLY its chosen destination;
//   · partial replacements may enter different locations;
//   · a duplicate return / replacement replay moves location stock once;
//   · cancellation makes no stock or location change;
//   · a legacy (untracked) return keeps company-level behaviour, no movement;
//   · source and destination snapshots persist on the record.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Employee = require("../../models/Employee");
const locStock = require("../../services/storePurchase/locationStock.service");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

let server, base, seq = 0;
const oid = () => new mongoose.Types.ObjectId();

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/inventory/operations/purchase-orders/:poId/returns",
    require("../../routes/CMS_Routes/Inventory/Operations/returnRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/operations`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); unitOfWork.__setTransactionSupport(null); });

const newKey = () => `sr-${++seq}-${Math.random().toString(36).slice(2)}`;
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function actor(co) {
  const n = ++seq;
  const email = `sr${n}@test.example`;
  const emp = await Employee.create({ firstName: "S", lastName: `L${n}`, email, biometricId: `SR${n}`, isActive: true, gender: "Other", department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "S" });
  return jwt.sign({ id: String(emp._id), email, name: "S", role: "employee", employeeId: emp.biometricId }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
}

async function seedLoc(co, wh, loc, raw, qty, variantId = null) {
  await locStock.applyLocationIn(null, {
    companyId: co._id, siteId: null, item: raw, variantId,
    warehouse: wh, location: loc, quantity: qty, type: "receipt", intent: "receive",
    source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "",
  });
}

/**
 * A company with a store actor, a warehouse (A1, B1), a received PO line and
 * location stock. `tracked=false` seeds NO location stock (legacy path).
 * `variant=true` splits Red@A1 / Blue@B1; the PO line is the Red variant.
 */
async function seed({ received = 20, locQty = 20, variant = false, tracked = true } = {}) {
  const co = await Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const token = await actor(co);
  const wh = await Warehouse.create({
    companyId: co._id, name: `WH ${++seq}`, shortName: `W${seq}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const [locA, locB] = wh.locations;

  const companyQty = variant ? 2 * locQty : 100;
  const raw = await RawItem.create({
    companyId: co._id, name: `Bolt ${++seq}`, sku: `BLT-${seq}`, unit: "pcs", quantity: companyQty, minStock: 0,
    ...(variant ? { variants: [
      { combination: ["Red"], quantity: locQty, sku: "R", status: "In Stock" },
      { combination: ["Blue"], quantity: locQty, sku: "B", status: "In Stock" },
    ] } : {}),
  });
  const fresh = await RawItem.findById(raw._id).lean();
  const redId = fresh.variants?.[0]?._id || null;
  const blueId = fresh.variants?.[1]?._id || null;

  if (tracked) {
    if (variant) {
      await seedLoc(co, wh, locA, raw, locQty, redId);
      await seedLoc(co, wh, locB, raw, locQty, blueId);
    } else {
      await seedLoc(co, wh, locA, raw, locQty);
    }
  }

  const vendor = await Vendor.create({ companyName: `V ${++seq}` });
  const po = await PurchaseOrder.create({
    companyId: co._id, createdBy: oid(), poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
    vendor: vendor._id, vendorName: vendor.companyName, status: "PARTIALLY_RECEIVED",
    items: [{
      rawItem: raw._id, itemName: raw.name, sku: raw.sku, unit: "pcs",
      quantity: 40, receivedQuantity: received, pendingQuantity: 20, unitPrice: 50, totalPrice: 2000,
      ...(variant ? { variantId: redId, variantCombination: ["Red"] } : {}),
    }],
    totalReceived: received, totalPending: 20, totalAmount: 2000,
  });
  return { co, token, wh, locA, locB, raw, redId, blueId, po, itemId: String(po.items[0]._id) };
}

const raise = (s, over = {}, key = newKey()) =>
  call(`/purchase-orders/${s.po._id}/returns`, {
    method: "POST", token: s.token, key,
    body: { poItemId: s.itemId, damagedQuantity: 5, reason: "Bent", warehouseId: String(s.wh._id), locationId: String(s.locA._id), ...over },
  });
const receive = (s, returnId, over = {}, key = newKey()) =>
  call(`/purchase-orders/${s.po._id}/returns/${returnId}/receive`, {
    method: "POST", token: s.token, key,
    body: { quantityReceived: 5, notes: "", warehouseId: String(s.wh._id), locationId: String(s.locB._id), ...over },
  });
const cancel = (s, returnId, key = newKey()) =>
  call(`/purchase-orders/${s.po._id}/returns/${returnId}/cancel`, { method: "PATCH", token: s.token, key, body: { reason: "not chasing" } });

const onHand = (s, loc, variantId = null) =>
  locStock.locationOnHand(null, s.co._id, s.raw._id, variantId, s.wh._id, loc._id);
const rawQty = async (s) => (await RawItem.findById(s.raw._id).lean()).quantity;
const outMovements = (s) => LocationMovement.find({ itemId: s.raw._id, type: "supplier_return" }).lean();
const inMovements = (s) => LocationMovement.find({ itemId: s.raw._id, type: "replacement_receipt" }).lean();

/* ═══ 1 · RETURN REDUCES ONLY THE CHOSEN VARIANT/LOCATION ═════════════════ */

describe("raising a supplier return from a location", () => {
  test("reduces ONLY the chosen variant at the chosen location, writes one OUT movement", async () => {
    const s = await seed({ variant: true, locQty: 20 });
    const r = await raise(s, { locationId: String(s.locA._id) }); // Red @ A1, qty 5
    expect(r.status).toBe(201);

    expect(await onHand(s, s.locA, s.redId)).toBe(15); // Red @ A1: 20 − 5
    expect(await onHand(s, s.locB, s.blueId)).toBe(20); // Blue @ B1 untouched

    const mvs = await outMovements(s);
    expect(mvs).toHaveLength(1);
    expect(mvs[0].direction).toBe("out");
    expect(mvs[0].quantity).toBe(5);
    expect(String(mvs[0].variantId)).toBe(String(s.redId));
    expect(String(mvs[0].locationId)).toBe(String(s.locA._id));
    expect(mvs[0].source.kind).toBe("supplier_return");
    expect(String(mvs[0].source.id)).toBe(String(s.po._id));
    expect(String(mvs[0].source.poLineId)).toBe(String(s.itemId));
    expect(mvs[0].source.returnId).toBeTruthy();
    expect(mvs[0].idempotencyKey).toBeTruthy();
    expect(mvs[0].operationKey).toBeTruthy();
  });

  test("an insufficient source refuses and changes nothing", async () => {
    const s = await seed({ locQty: 3 }); // A1 holds only 3
    const before = await rawQty(s);
    const r = await raise(s, { damagedQuantity: 5, locationId: String(s.locA._id) });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("INSUFFICIENT_AT_LOCATION");

    expect(await onHand(s, s.locA)).toBe(3);     // location untouched
    expect(await rawQty(s)).toBe(before);        // company untouched
    expect(await outMovements(s)).toHaveLength(0); // no ledger row
    const po = await PurchaseOrder.findById(s.po._id).lean();
    expect(po.returnRequests || []).toHaveLength(0); // no return recorded
  });

  test("a tracked return with NO source is refused with LOCATION_REQUIRED", async () => {
    const s = await seed({ locQty: 20 });
    const before = await rawQty(s);
    const r = await raise(s, { warehouseId: undefined, locationId: undefined });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("LOCATION_REQUIRED");
    expect(await rawQty(s)).toBe(before);
    expect(await onHand(s, s.locA)).toBe(20);
    expect(await outMovements(s)).toHaveLength(0);
  });

  test("source snapshots persist on the return record", async () => {
    const s = await seed({ locQty: 20 });
    const r = await raise(s, { locationId: String(s.locA._id) });
    expect(r.status).toBe(201);
    const po = await PurchaseOrder.findById(s.po._id).lean();
    const ret = po.returnRequests[0];
    expect(String(ret.sourceWarehouseId)).toBe(String(s.wh._id));
    expect(String(ret.sourceLocationId)).toBe(String(s.locA._id));
    expect(ret.sourceLocationCode).toBe("A1");
    expect(ret.sourceLocationName).toBe("Rack A");
    expect(ret.sourceWarehouseName).toBe(s.wh.name);
  });

  test("a legacy untracked item keeps company-level behaviour — no location required, no movement", async () => {
    const s = await seed({ tracked: false });
    const before = await rawQty(s);
    const r = await raise(s, { warehouseId: undefined, locationId: undefined, damagedQuantity: 5 });
    expect(r.status).toBe(201); // company-level return still works
    expect(await rawQty(s)).toBe(before - 5); // company stock deducted
    expect(await outMovements(s)).toHaveLength(0); // no location movement
    const po = await PurchaseOrder.findById(s.po._id).lean();
    expect(po.returnRequests[0].sourceLocationId).toBeFalsy(); // "Location not recorded"
  });
});

/* ═══ 2 · REPLACEMENT INTO AN EXPLICIT DESTINATION ════════════════════════ */

describe("receiving a replacement into a location", () => {
  async function returned(over) {
    const s = await seed(over);
    const r = await raise(s, { damagedQuantity: 6, locationId: String(s.locA._id) });
    expect(r.status).toBe(201);
    return { s, returnId: r.body.returnRequest._id };
  }

  test("credits ONLY the selected destination, writes one IN movement", async () => {
    const { s, returnId } = await returned({ locQty: 20 });
    const before = await rawQty(s);
    const r = await receive(s, returnId, { quantityReceived: 4, locationId: String(s.locB._id) });
    expect(r.status).toBe(200);

    expect(await onHand(s, s.locB)).toBe(4);   // B1 credited
    expect(await onHand(s, s.locA)).toBe(14);  // A1 (20−6) unchanged by the receipt
    expect(await rawQty(s)).toBe(before + 4);  // company credited

    const mvs = await inMovements(s);
    expect(mvs).toHaveLength(1);
    expect(mvs[0].direction).toBe("in");
    expect(String(mvs[0].locationId)).toBe(String(s.locB._id));
    expect(mvs[0].source.kind).toBe("replacement_receipt");
    expect(String(mvs[0].source.returnId)).toBe(String(returnId));
    expect(mvs[0].source.receiptId).toBeTruthy();
  });

  test("a tracked replacement with NO destination is refused with LOCATION_REQUIRED", async () => {
    const { s, returnId } = await returned({ locQty: 20 });
    const r = await receive(s, returnId, { quantityReceived: 4, warehouseId: undefined, locationId: undefined });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("LOCATION_REQUIRED");
    expect(await inMovements(s)).toHaveLength(0);
  });

  test("partial replacements may enter DIFFERENT destinations", async () => {
    const { s, returnId } = await returned({ locQty: 20 });
    const r1 = await receive(s, returnId, { quantityReceived: 3, locationId: String(s.locA._id) });
    expect(r1.status).toBe(200);
    const r2 = await receive(s, returnId, { quantityReceived: 3, locationId: String(s.locB._id) });
    expect(r2.status).toBe(200);

    expect(await onHand(s, s.locA)).toBe(17); // 20 − 6 + 3
    expect(await onHand(s, s.locB)).toBe(3);  // 0 + 3
    const mvs = await inMovements(s);
    expect(mvs).toHaveLength(2);
    expect(new Set(mvs.map((m) => String(m.locationId))).size).toBe(2);

    // destination snapshots persist per receipt
    const po = await PurchaseOrder.findById(s.po._id).lean();
    const receipts = po.returnRequests[0].receipts;
    expect(receipts).toHaveLength(2);
    const codes = receipts.map((rc) => rc.destLocationCode).sort();
    expect(codes).toEqual(["A1", "B1"]);
  });
});

/* ═══ 3 · REPLAY MOVES LOCATION STOCK ONCE ════════════════════════════════ */

describe("idempotent replay", () => {
  test("a duplicate return replay moves the location stock exactly once", async () => {
    const s = await seed({ locQty: 20 });
    const key = newKey();
    const first = await raise(s, { locationId: String(s.locA._id) }, key);
    const second = await raise(s, { locationId: String(s.locA._id) }, key);
    expect(first.status).toBe(201);
    expect([200, 201]).toContain(second.status);

    expect(await onHand(s, s.locA)).toBe(15);       // fell by 5 once
    expect(await outMovements(s)).toHaveLength(1);   // one OUT movement
  });

  test("a duplicate replacement replay credits the location once", async () => {
    const s = await seed({ locQty: 20 });
    const raised = await raise(s, { damagedQuantity: 6, locationId: String(s.locA._id) });
    const returnId = raised.body.returnRequest._id;
    const key = newKey();
    const first = await receive(s, returnId, { quantityReceived: 4, locationId: String(s.locB._id) }, key);
    const second = await receive(s, returnId, { quantityReceived: 4, locationId: String(s.locB._id) }, key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await onHand(s, s.locB)).toBe(4);        // credited once
    expect(await inMovements(s)).toHaveLength(1);    // one IN movement
  });
});

/* ═══ 4 · CANCELLATION MAKES NO STOCK/LOCATION CHANGE ═════════════════════ */

describe("cancellation", () => {
  test("cancelling a return does NOT restore stock and writes no location movement", async () => {
    const s = await seed({ locQty: 20 });
    const raised = await raise(s, { locationId: String(s.locA._id) });
    const returnId = raised.body.returnRequest._id;
    expect(await onHand(s, s.locA)).toBe(15);
    const companyAfterRaise = await rawQty(s);

    const c = await cancel(s, returnId);
    expect(c.status).toBe(200);
    expect(c.body.returnRequest.status).toBe("CANCELLED");

    expect(await onHand(s, s.locA)).toBe(15);          // NOT restored
    expect(await rawQty(s)).toBe(companyAfterRaise);   // company unchanged
    expect(await outMovements(s)).toHaveLength(1);      // still the ONE raise movement, no new one
    expect(await inMovements(s)).toHaveLength(0);
  });
});
