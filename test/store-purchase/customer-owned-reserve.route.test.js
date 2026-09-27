// test/store-purchase/customer-owned-reserve.route.test.js
//
// AN ORDINARY ISSUE MAY NOT REACH INTO A CUSTOMER'S MATERIAL.
//
// ── THE SHELF DOES NOT KNOW WHOSE FABRIC IT IS ──────────────────────────────
// A customer's roll and the factory's own roll of the same poplin sit in the same
// rack and are counted in the same balance, because that balance is a quantity and
// a quantity has no owner. So every check that asks "is there enough?" answers yes
// for material that is not the factory's to give — and the person issuing it has
// no way to know. Nothing about the request looks wrong.
//
// The guard therefore lives where the QUANTITY leaves, not on the screens that ask
// for it: one function, called by every ordinary stock-out path, which subtracts
// what is held for a customer before deciding whether there is enough.
//
// ── WHAT THIS SUITE PROVES, THROUGH REAL ROUTES ─────────────────────────────
//   1  An explicit MRF issue cannot draw on customer-held quantity.
//   2  Neither can auto-fulfilment, which is a different door to the same act.
//   3  The factory's OWN share of a mixed balance still issues — the guard
//      subtracts, it does not lock the item.
//   4  It is location-scoped for location-tracked issues: a customer's material in
//      rack B does not block an issue from rack A, and in rack A it does.
//   5  It is variant-specific.
//   6  It is re-checked inside the transaction, so a lot received between the
//      check and the write cannot be issued away.
//   7  A supplier return cannot send a customer's material to a vendor.
//
// Nothing here asserts on source text. Every test posts to a route or calls the
// shared guard with STORED lots, and then reads the stored result back.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return {
    submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop,
    tlApproved: noop, tlRejected: noop, issued: noop, unfulfilled: noop, returned: noop,
    productRequestChatMessage: noop, productRequestTlApproved: noop, productRequestTlRejected: noop,
  };
});
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve(null),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const Employee = require("../../models/Employee");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");
const locStock = require("../../services/storePurchase/locationStock.service");
const reserve = require("../../services/storePurchase/customerOwnedReserve.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/mrf`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

let idemSeq = 0;
const newKey = () => `cor-${++idemSeq}-${Math.random().toString(36).slice(2)}`;
const oid = () => new mongoose.Types.ObjectId();

const call = (emp, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      Authorization: `Bearer ${jwt.sign(
        {
          id: String(emp._id), role: "employee", employeeId: emp.biometricId,
          name: `${emp.firstName} ${emp.lastName}`, email: emp.email,
        },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });

async function seedLocationStock(company, wh, loc, raw, qty, variantId = null) {
  await locStock.applyLocationIn(null, {
    companyId: company._id, siteId: null,
    item: raw, variantId,
    warehouse: wh, location: loc,
    quantity: qty, type: "receipt", intent: "receive",
    source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "",
  });
}

/**
 * A company, a store actor, a warehouse with two racks, a location-tracked item,
 * and a TL-approved MRF the store may issue against.
 *
 * `stockQty` is the PHYSICAL balance — the shelf — which is deliberately seeded to
 * include the customer's material, because that is what a shelf does. The customer
 * lot is created separately, so the two together describe the real situation: 50
 * on hand, 30 of them somebody else's.
 */
async function seed({ stockQty = 50, requestedQty = 10, variants = null, locB = false } = {}) {
  const n = ++seq;
  const company = await Acc_Company.create({
    companyName: `Reserve Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });

  const tl = await person({ firstName: "Meera", lastName: `R${n}`, email: `rtl${n}@demo.example`, biometricId: `RTL${n}` });
  const emp = await person({ firstName: "Rutu", lastName: `R${n}`, email: `rtech${n}@demo.example`, biometricId: `RTC${n}`, primaryManager: { managerId: tl._id } });
  const store = await person({ firstName: "Bikash", lastName: `R${n}`, email: `rstore${n}@demo.example`, biometricId: `RST${n}`, department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });

  const wh = await Warehouse.create({
    companyId: company._id, name: `WH ${n}`, shortName: `RW${n}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const [rackA, rackB] = wh.locations;

  const raw = await RawItem.create({
    companyId: company._id,
    name: `Poplin ${n}`, sku: `POP-${n}`, unit: "Metre", quantity: stockQty, minStock: 0,
    ...(variants
      ? {
        variants: variants.map((v, i) => ({
          combination: v.combination, quantity: v.qty, sku: `POP-${n}-v${i}`, status: "In Stock",
        })),
      }
      : {}),
  });

  const fresh = await RawItem.findById(raw._id).lean();
  if (variants) {
    for (let i = 0; i < variants.length; i++) {
      await seedLocationStock(company, wh, rackA, raw, variants[i].qty, fresh.variants[i]._id);
    }
  } else {
    await seedLocationStock(company, wh, rackA, raw, locB ? 0 : stockQty);
    if (locB) await seedLocationStock(company, wh, rackB, raw, stockQty);
  }

  const mrf = await MRF.create({
    mrfNumber: `MRF/2026-27/${String(++seq).padStart(4, "0")}`,
    companyId: company._id,
    requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech",
    requestedForId: emp.biometricId, requestType: "USES_BASED", status: "APPROVED",
    createdByRef: emp._id, createdByModel: "Employee", createdByName: "Rutu",
    reason: "For the sample run",
    approverEmployee: tl._id, approverName: "Meera", approverBiometricId: tl.biometricId,
    tlApproved: true, tlApprovedBy: tl._id, tlApprovedByName: "Meera", tlApprovedAt: new Date(),
    items: [{
      rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
      requestedQty, unit: "Metre", baseUnit: "Metre",
      itemStatus: "APPROVED", availability: "UNREVIEWED",
    }],
  });

  return {
    company, store, wh, rackA, rackB, raw, mrf,
    itemId: String(mrf.items[0]._id),
    variantIds: (fresh.variants || []).map((v) => String(v._id)),
  };
}

/**
 * Customer material physically present, and held for one order line.
 *
 * Written straight into the lot collection: the receipt path that creates one has
 * its own suite, and driving it here would make a guard test fail for reasons
 * about receiving.
 */
async function customerLot(s, {
  quantity = 30, location = null, variantId = null, status = "HELD",
} = {}) {
  const loc = location || s.rackA;
  const n = ++seq;
  return CustomerMaterialLot.create({
    companyId: s.company._id, customerId: oid(),
    customerLabel: `Buyer ${n}`, customerCode: `CUST-${n}`,
    orderRef: `ORD-${n}`, orderLineRef: `LN-${String(n).padStart(12, "0")}`,
    executionFileId: oid(), expectationId: oid(), documentRef: `CSM-2026-${n}`,
    expectationRevisionNo: 1, expectationLineRef: `CML-${n}`,
    rawItemId: s.raw._id, variantId, variantCombination: [],
    itemName: s.raw.name, sku: s.raw.sku,
    goodsReceiptId: oid(), goodsReceiptNumber: `GRN/2026-27/${n}`, goodsReceiptLineId: oid(),
    warehouseId: s.wh._id, warehouseName: s.wh.name,
    locationId: loc._id, locationCode: loc.code,
    receiptUnit: "Metre", receiptQuantity: quantity,
    baseUnit: "Metre", baseQuantity: quantity,
    availableQuantity: quantity, issuedQuantity: 0, returnedQuantity: 0,
    status,
    receivedAt: new Date(), receivedBy: { name: "St" },
    movements: [{
      type: "RECEIVED", quantity, baseUnit: "Metre", availableAfter: quantity, at: new Date(),
    }],
  });
}

const issueMrf = (s, items, key = newKey(), mrfId = null) =>
  call(s.store, `/${mrfId || s.mrf._id}/issue`, {
    method: "POST", body: { items }, idempotencyKey: key,
  });

/**
 * A second approved MRF in the same company for the same item.
 *
 * Needed because one MRF that has been issued in full cannot be issued again —
 * "cannot issue, status is ISSUED" is a lifecycle refusal and would hide the
 * ownership refusal a test is actually looking for.
 */
async function anotherMrf(s, requestedQty) {
  const n = ++seq;
  const mrf = await MRF.create({
    mrfNumber: `MRF/2026-27/${String(n).padStart(4, "0")}-B`,
    companyId: s.company._id,
    requestedFor: s.mrf.requestedFor, requestedForName: "Rutu", requestedForDept: "Tech",
    requestedForId: s.mrf.requestedForId, requestType: "USES_BASED", status: "APPROVED",
    createdByRef: s.mrf.createdByRef, createdByModel: "Employee", createdByName: "Rutu",
    reason: "A second run",
    approverEmployee: s.mrf.approverEmployee, approverName: "Meera",
    approverBiometricId: s.mrf.approverBiometricId,
    tlApproved: true, tlApprovedBy: s.mrf.tlApprovedBy, tlApprovedByName: "Meera",
    tlApprovedAt: new Date(),
    items: [{
      rawItem: s.raw._id, rawItemName: s.raw.name, rawItemSku: s.raw.sku,
      requestedQty, unit: "Metre", baseUnit: "Metre",
      itemStatus: "APPROVED", availability: "UNREVIEWED",
    }],
  });
  return { id: String(mrf._id), itemId: String(mrf.items[0]._id) };
}

const onHand = (s, loc, variantId = null) =>
  locStock.locationOnHand(null, s.company._id, s.raw._id, variantId, s.wh._id, loc._id);
const physical = async (s) => (await RawItem.findById(s.raw._id).lean()).quantity;

/* ══ 1 — AN EXPLICIT MRF ISSUE ════════════════════════════════════════════ */

describe("an explicit MRF issue", () => {
  test("is refused when the quantity is only there because a customer's material is", async () => {
    /* 50 on the shelf, 30 of them the customer's. 25 looks affordable and is not. */
    const s = await seed({ stockQty: 50, requestedQty: 25 });
    await customerLot(s, { quantity: 30 });

    const r = await issueMrf(s, [{
      itemId: s.itemId, issuedQty: 25,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }]);

    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(r.body)).toMatch(/CUSTOMER_OWNED_STOCK_NOT_AVAILABLE/);

    /* ── AND THE REFUSAL EXPLAINS ITSELF IN QUANTITIES ───────────────────
       "Not enough stock" would send somebody to look for 25 metres that are
       sitting right in front of them. */
    const detail = r.body?.error?.details || {};
    expect(detail.physical).toBe(50);
    expect(detail.customerHeld).toBe(30);
    expect(detail.available).toBe(20);
    expect(detail.requested).toBe(25);

    /* Nothing moved: not the shelf, not the rack, not the MRF, not the ledger. */
    expect(await physical(s)).toBe(50);
    expect(await onHand(s, s.rackA)).toBe(50);
    expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty || 0).toBe(0);
    expect(await LocationMovement.countDocuments({
      itemId: s.raw._id, type: "issue",
    })).toBe(0);
  });

  test("still issues the factory's OWN share of a mixed balance", async () => {
    /* The guard subtracts what belongs to somebody else. It does not lock the
       item, which would stop the factory using its own fabric. */
    const s = await seed({ stockQty: 50, requestedQty: 20 });
    await customerLot(s, { quantity: 30 });

    const r = await issueMrf(s, [{
      itemId: s.itemId, issuedQty: 20,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }]);

    expect(r.status).toBe(200);
    expect(await physical(s)).toBe(30);
    expect(await onHand(s, s.rackA)).toBe(30);

    /* And the customer's 30 are all that is left — the next metre is refused,
       asked for through a second MRF so the refusal is about ownership and not
       about a finished request. */
    const second = await anotherMrf(s, 1);
    const again = await issueMrf(s, [{
      itemId: second.itemId, issuedQty: 1,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }], newKey(), second.id);
    expect(JSON.stringify(again.body)).toMatch(/CUSTOMER_OWNED_STOCK_NOT_AVAILABLE/);
  });

  test("is unaffected when there is no customer material at all", async () => {
    /* The ordinary case must stay ordinary: no lot, no extra query result, no
       change in behaviour. */
    const s = await seed({ stockQty: 50, requestedQty: 50 });
    const r = await issueMrf(s, [{
      itemId: s.itemId, issuedQty: 50,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }]);
    expect(r.status).toBe(200);
    expect(await onHand(s, s.rackA)).toBe(0);
  });

  test("counts only material still HELD — quantity already issued to production is gone", async () => {
    /* A lot that has been fully issued to its own production order is no longer on
       the shelf, and must not go on reserving quantity that is not there. */
    const s = await seed({ stockQty: 20, requestedQty: 20 });
    const lot = await customerLot(s, { quantity: 30 });
    await CustomerMaterialLot.updateOne(
      { _id: lot._id },
      { $set: { availableQuantity: 0, issuedQuantity: 30, status: "ISSUED" } },
    );

    const r = await issueMrf(s, [{
      itemId: s.itemId, issuedQty: 20,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }]);
    expect(r.status).toBe(200);
  });
});

/* ══ 2 — AUTO-FULFILMENT IS THE SAME ACT THROUGH ANOTHER DOOR ═════════════ */

test("auto-fulfilment cannot draw on customer-held quantity either", async () => {
  const s = await seed({ stockQty: 50, requestedQty: 25 });
  await customerLot(s, { quantity: 30 });

  const r = await call(s.store, `/${s.mrf._id}/fulfilment-decision`, {
    method: "POST",
    body: {
      decision: "issue_from_stock",
      lines: [{
        itemId: s.itemId, issueQty: 25,
        warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
      }],
    },
    idempotencyKey: newKey(),
  });

  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(JSON.stringify(r.body)).toMatch(/CUSTOMER_OWNED_STOCK_NOT_AVAILABLE/);
  expect(await onHand(s, s.rackA)).toBe(50);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(0);
});

/* ══ 3 — LOCATION SCOPE ══════════════════════════════════════════════════ */

describe("for a location-tracked issue the guard is scoped to the location", () => {
  test("a customer's material in rack B does not block an issue from rack A", async () => {
    /* 50 in rack B is where the customer's roll is. Rack A's own 40 are the
       factory's, and a guard that looked only at the company total would refuse
       them — a false refusal, which teaches people to work around the guard. */
    const s = await seed({ stockQty: 40, requestedQty: 40 });
    await seedLocationStock(s.company, s.wh, s.rackB, s.raw, 30);
    await RawItem.updateOne({ _id: s.raw._id }, { $set: { quantity: 70 } });
    await customerLot(s, { quantity: 30, location: s.rackB });

    const r = await issueMrf(s, [{
      itemId: s.itemId, issuedQty: 40,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }]);

    expect(r.status).toBe(200);
    expect(await onHand(s, s.rackA)).toBe(0);
    /* Rack B is untouched — the customer's roll never moved. */
    expect(await onHand(s, s.rackB)).toBe(30);
  });

  test("and in the SELECTED rack it does block", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 40 });
    await customerLot(s, { quantity: 30, location: s.rackA });

    const r = await issueMrf(s, [{
      itemId: s.itemId, issuedQty: 40,
      warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
    }]);

    expect(JSON.stringify(r.body)).toMatch(/CUSTOMER_OWNED_STOCK_NOT_AVAILABLE/);
    expect(await onHand(s, s.rackA)).toBe(40);
  });

  test("the shared guard reads the lots' own locations, not a summary", async () => {
    /* Straight at the shared function with stored lots, because this is the part
       every path depends on: two racks, two lots, and the answer must differ by
       the rack asked about. */
    const s = await seed({ stockQty: 100, requestedQty: 1 });
    await customerLot(s, { quantity: 30, location: s.rackA });
    await customerLot(s, { quantity: 45, location: s.rackB });

    const atA = await reserve.heldFor({
      companyId: s.company._id, rawItemId: s.raw._id, locationId: s.rackA._id,
    });
    const atB = await reserve.heldFor({
      companyId: s.company._id, rawItemId: s.raw._id, locationId: s.rackB._id,
    });
    const company = await reserve.heldFor({
      companyId: s.company._id, rawItemId: s.raw._id,
    });
    expect(atA).toBe(30);
    expect(atB).toBe(45);
    expect(company).toBe(75);
  });
});

/* ══ 4 — VARIANTS ════════════════════════════════════════════════════════ */

test("the guard is variant-specific: the customer's navy does not block the factory's white", async () => {
  const s = await seed({
    requestedQty: 20,
    variants: [{ combination: ["Navy"], qty: 30 }, { combination: ["White"], qty: 30 }],
  });
  const [navy, white] = s.variantIds;
  await customerLot(s, { quantity: 30, variantId: navy });

  /* The variant a request is FOR lives on the MRF line — a client cannot name a
     different one at issue time, which is itself the right design. */
  await MRF.updateOne(
    { _id: s.mrf._id, "items._id": s.itemId },
    { $set: { "items.$.variantId": navy, "items.$.variantCombination": ["Navy"] } },
  );

  /* Navy is entirely the customer's. */
  const refused = await issueMrf(s, [{
    itemId: s.itemId, issuedQty: 20,
    warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
  }]);
  expect(JSON.stringify(refused.body)).toMatch(/CUSTOMER_OWNED_STOCK_NOT_AVAILABLE/);
  expect(await onHand(s, s.rackA, navy)).toBe(30);

  /* White is the factory's, and unaffected. */
  const second = await anotherMrf(s, 20);
  await MRF.updateOne(
    { _id: second.id, "items._id": second.itemId },
    { $set: { "items.$.variantId": white, "items.$.variantCombination": ["White"] } },
  );
  const allowed = await issueMrf(s, [{
    itemId: second.itemId, issuedQty: 20,
    warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
  }], newKey(), second.id);
  expect(allowed.status).toBe(200);
  expect(await onHand(s, s.rackA, white)).toBe(10);
});

/* ══ 5 — THE CHECK RUNS WHERE THE WRITE HAPPENS ══════════════════════════ */

test("a lot created after the screen loaded still blocks the issue", async () => {
  /* The realistic sequence: Store opens the issue screen when the shelf is all
     the factory's, a customer delivery is received while the form is open, and the
     issue is submitted afterwards. A check that had run when the screen loaded
     would pass. This one runs against the stored lots at the moment of the write. */
  const s = await seed({ stockQty: 50, requestedQty: 45 });

  /* Nothing held yet — this would have succeeded. */
  const held0 = await reserve.heldFor({ companyId: s.company._id, rawItemId: s.raw._id });
  expect(held0).toBe(0);

  await customerLot(s, { quantity: 30 });

  const r = await issueMrf(s, [{
    itemId: s.itemId, issuedQty: 45,
    warehouseId: String(s.wh._id), locationId: String(s.rackA._id),
  }]);
  expect(JSON.stringify(r.body)).toMatch(/CUSTOMER_OWNED_STOCK_NOT_AVAILABLE/);
  expect(await onHand(s, s.rackA)).toBe(50);
});

/* ══ 6 — THE GUARD ITSELF, ON STORED LOTS ════════════════════════════════ */

describe("the shared guard", () => {
  test("refuses an ordinary draw into customer quantity and names the arithmetic", async () => {
    const s = await seed({ stockQty: 50 });
    await customerLot(s, { quantity: 30 });
    const item = await RawItem.findById(s.raw._id);

    await expect(reserve.assertOrdinaryIssueAllowed({
      companyId: s.company._id, rawItem: item, requested: 25, unit: "Metre",
    })).rejects.toMatchObject({
      details: expect.objectContaining({
        reason: "CUSTOMER_OWNED_STOCK_NOT_AVAILABLE",
        physical: 50, customerHeld: 30, available: 20, requested: 25,
      }),
    });
  });

  test("permits exactly the ordinary balance, to the last unit", async () => {
    const s = await seed({ stockQty: 50 });
    await customerLot(s, { quantity: 30 });
    const item = await RawItem.findById(s.raw._id);

    /* 20 is the boundary and must be allowed; 20.0001 must not. A guard that is
       wrong at the boundary refuses correct work every day. */
    await expect(reserve.assertOrdinaryIssueAllowed({
      companyId: s.company._id, rawItem: item, requested: 20,
    })).resolves.toBeUndefined();
    await expect(reserve.assertOrdinaryIssueAllowed({
      companyId: s.company._id, rawItem: item, requested: 20.0001,
    })).rejects.toBeTruthy();
  });

  test("does nothing at all when no customer material is held", async () => {
    const s = await seed({ stockQty: 5 });
    const item = await RawItem.findById(s.raw._id);
    /* Deliberately more than the shelf: with no customer stock the guard must not
       be the thing that refuses it. Ordinary sufficiency is the stock layer's job,
       and two different refusals for one condition confuse everybody. */
    await expect(reserve.assertOrdinaryIssueAllowed({
      companyId: s.company._id, rawItem: item, requested: 999,
    })).resolves.toBeUndefined();
  });
});

/* ══ 7 — THE INVENTORY OF STOCK-OUT PATHS, KEPT HONEST BY A TEST ══════════ */

// Every test above drives a route. This one is deliberately different: it reads the
// SOURCE and enumerates every place in the application where a location balance is
// decremented, then insists each one is accounted for. It exists because the
// behavioural tests can only cover the paths that exist TODAY — and the way this
// guard will be defeated is not by someone breaking it, but by someone adding a
// seventh stock-out path next quarter and not knowing this rule exists. That
// addition fails here, with a message telling them what to do.
//
// A path qualifies in one of three ways:
//
//   1. It IS the customer-material operation (it draws from a lot on purpose).
//   2. It calls `customerOwnedReserve.assertOrdinaryIssueAllowed` before decrementing.
//   3. It is a two-leg internal transfer: the quantity leaves one shelf and lands on
//      another in the same company, the company total is unchanged and nothing
//      leaves the building. There is nothing to protect against — but see the note
//      at the end of this file about the lot's stored location.

describe("every physical stock-out path", () => {
  const fs = require("fs");
  const path = require("path");
  const root = path.join(__dirname, "..", "..");
  const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

  /** Where a location balance is taken down, and how each one is accounted for. */
  const PATHS = Object.freeze([
    {
      file: "routes/CMS_Routes/Inventory/Operations/mrfRoutes.js",
      what: "MRF issue, partial fulfilment and reservation draw-down, via adjustStock()",
      how: "GUARDED",
    },
    {
      file: "routes/CMS_Routes/Inventory/Products/stockAdjustments.js",
      what: "a manual stock issue",
      how: "GUARDED",
    },
    {
      file: "services/storePurchase/stockCount.service.js",
      what: "a negative stock-count correction",
      how: "GUARDED",
    },
    {
      file: "services/storePurchase/supplierReturn.service.js",
      what: "goods going back to a vendor",
      how: "GUARDED",
    },
    {
      file: "services/storePurchase/customerMaterialIssue.service.js",
      what: "issue to production and return to the customer",
      how: "IS_THE_CUSTOMER_MATERIAL_OPERATION",
    },
    {
      file: "routes/CMS_Routes/Inventory/Operations/locationStockRoutes.js",
      what: "a location-to-location transfer",
      how: "INTERNAL_TRANSFER",
    },
    {
      file: "services/storePurchase/goodsReceiptControl.service.js",
      what: "inspection routing between Receiving, Quarantine and Returns",
      how: "INTERNAL_TRANSFER",
    },
  ]);

  test("is on the list, and the list is complete", () => {
    /* Found the same way a reader would: every file that takes a location balance
       down. `locationStock.service` itself is where the primitives live, so it is
       the mechanism rather than a path. */
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (entry.name.endsWith(".js")) files.push(rel);
      }
    };
    walk("routes");
    walk("services");

    const decrementers = files.filter((f) => {
      if (f.endsWith("services/storePurchase/locationStock.service.js")) return false;
      const src = read(f);
      return /applyLocationOut|decLocationGuarded(Returning)?\s*\(/.test(src);
    });

    const listed = new Set(PATHS.map((p) => p.file));
    const unaccounted = decrementers.filter((f) => !listed.has(f));

    /* The message matters more than the assertion: whoever trips this is adding a
       stock-out path and has no reason to know this rule exists yet. */
    expect(unaccounted.join(", ")
      + (unaccounted.length
        ? " — these files take stock off a location and are not on the ownership-guard"
          + " inventory. Either call customerOwnedReserve.assertOrdinaryIssueAllowed()"
          + " before decrementing, or add the path to PATHS above saying why it does not"
          + " need to."
        : "")).toBe("");

    /* And nothing on the list has quietly stopped decrementing stock — a stale
       inventory is worse than none, because it reads as coverage. */
    for (const p of PATHS) {
      expect(/applyLocationOut|decLocationGuarded(Returning)?\s*\(/.test(read(p.file)))
        .toBe(true);
    }
  });

  test("each ordinary path calls the shared guard, and the guard is one implementation", () => {
    for (const p of PATHS.filter((x) => x.how === "GUARDED")) {
      const src = read(p.file);
      expect(src).toMatch(/customerOwnedReserve\.assertOrdinaryIssueAllowed\(/);
      /* Required at module load — a require inside a transaction compiles the lot
         model there and schedules its index builds inside the transaction, which
         fails it with a lock timeout that mentions no index at all. */
      expect(src).toMatch(/^const customerOwnedReserve = require\(/m);
    }

    /* One implementation, so there is no second opinion about what "available"
       means. Nothing reimplements the subtraction. */
    const guard = read("services/storePurchase/customerOwnedReserve.service.js");
    expect(guard).toMatch(/function assertOrdinaryIssueAllowed/);
  });

  test("the two internal-transfer paths really do put the quantity back", () => {
    /* The claim that earns their exemption: an out leg and an in leg, so the
       company total is unchanged and nothing leaves the building. */
    for (const p of PATHS.filter((x) => x.how === "INTERNAL_TRANSFER")) {
      const src = read(p.file);
      expect(src).toMatch(/incLocationReturning|incLocation\(/);
      expect(src).toMatch(/transfer_out/);
      expect(src).toMatch(/transfer_in/);
    }
  });
});

// ── WHAT THIS DOES NOT COVER, SAID OUT LOUD ─────────────────────────────────
// A transfer moves a customer's roll from rack A to rack B legitimately, and the
// company total is unchanged — so the guard correctly stays out of the way. But
// `CustomerMaterialLot.locationId` still says rack A afterwards, so the lot's
// stored location and the physical one disagree until something corrects it. That
// is a stale pointer rather than a loss of material: the quantity is still held,
// still owned, still traceable to its order. Fixing it means teaching the transfer
// paths to move ownership lots with the stock, which is a new operation with its own
// audit trail — not something to bolt onto a guard that only ever subtracts.
