// test/store-purchase/mrf-location-stock.route.test.js
//
// Warehouse Stock V1 — MRF material ISSUE and department RETURN now move stock
// AT A LOCATION, not just company-wide. This suite proves the location half:
//   · an explicit issue reduces the CHOSEN location (and writes one location-out
//     movement sharing the MRF's identity);
//   · auto-fulfilment cannot bypass the location — a tracked item with no source
//     is refused with LOCATION_REQUIRED, never issued from Unassigned;
//   · an over-issue at a location leaves every stock record untouched;
//   · two variants stay separate;
//   · a department return credits ONLY the chosen destination;
//   · an over-return is refused;
//   · issue and return each replay exactly once.
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
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const Employee = require("../../models/Employee");
const locStock = require("../../services/storePurchase/locationStock.service");

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
const newKey = () => `ml-${++idemSeq}-${Math.random().toString(36).slice(2)}`;

const call = (emp, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      Authorization: `Bearer ${jwt.sign(
        { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
          name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });

/** Establish location-tracked stock for one (item[, variant]) at a location. */
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
 * A company, a store actor (grant + membership), a warehouse with one location,
 * a catalogue item whose stock lives AT that location, and a TL-approved MRF the
 * store may issue against.
 */
async function seed({ stockQty = 50, requestedQty = 10, variants = null } = {}) {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Loc Co ${n}`, booksFromDate: new Date("2026-04-01") });

  const tl = await person({ firstName: "Meera", lastName: `L${n}`, email: `tl${n}@demo.example`, biometricId: `TL${n}` });
  const emp = await person({ firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`, biometricId: `TC${n}`, primaryManager: { managerId: tl._id } });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`, biometricId: `ST${n}`, department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });

  const wh = await Warehouse.create({
    companyId: company._id, name: `WH ${n}`, shortName: `W${n}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const [locA, locB] = wh.locations;

  const raw = await RawItem.create({
    name: `Blade ${n}`, sku: `BLD-${n}`, unit: "pcs", quantity: stockQty, minStock: 0,
    ...(variants ? { variants: variants.map((v, i) => ({ combination: v.combination, quantity: v.qty, sku: `BLD-${n}-v${i}`, status: "In Stock" })) } : {}),
  });

  // Seed the LOCATION ledger so the item is location-tracked.
  if (variants) {
    const fresh = await RawItem.findById(raw._id).lean();
    for (let i = 0; i < variants.length; i++) {
      await seedLocationStock(company, wh, locA, raw, variants[i].qty, fresh.variants[i]._id);
    }
  } else {
    await seedLocationStock(company, wh, locA, raw, stockQty);
  }

  const mrfItem = variants
    ? {
        rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
        requestedQty, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED", availability: "UNREVIEWED",
      }
    : {
        rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
        requestedQty, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED", availability: "UNREVIEWED",
      };

  const mrf = await MRF.create({
    mrfNumber: `MRF/2026-27/${String(++seq).padStart(4, "0")}`,
    companyId: company._id,
    requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech",
    requestedForId: emp.biometricId, requestType: "USES_BASED", status: "APPROVED",
    createdByRef: emp._id, createdByModel: "Employee", createdByName: "Rutu",
    reason: "The old ones failed inspection",
    approverEmployee: tl._id, approverName: "Meera", approverBiometricId: tl.biometricId,
    tlApproved: true, tlApprovedBy: tl._id, tlApprovedByName: "Meera", tlApprovedAt: new Date(),
    items: [mrfItem],
  });

  const freshRaw = await RawItem.findById(raw._id).lean();
  return {
    company, tl, emp, store, wh, locA, locB, raw, mrf,
    itemId: String(mrf.items[0]._id),
    variantIds: freshRaw.variants?.map((v) => String(v._id)) || [],
  };
}

const issue = (s, items, key = newKey()) =>
  call(s.store, `/${s.mrf._id}/issue`, { method: "POST", body: { items }, idempotencyKey: key });

const doReturn = (s, itemId, body, key = newKey()) =>
  call(s.store, `/${s.mrf._id}/items/${itemId}/return`, { method: "POST", body, idempotencyKey: key });

const locOnHand = (s, loc, variantId = null) =>
  locStock.locationOnHand(null, s.company._id, s.raw._id, variantId, s.wh._id, loc._id);

/* ═══ 3 · EXPLICIT ISSUE REDUCES THE CHOSEN LOCATION ══════════════════════ */

describe("explicit MRF issue at a location", () => {
  test("reduces the selected location and writes ONE location-out movement with MRF identity", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    expect(await locOnHand(s, s.locA)).toBe(40);

    const r = await issue(s, [{ itemId: s.itemId, issuedQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }]);
    expect(r.status).toBe(200);

    // company on-hand and the chosen location both fell by 10
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(30);
    expect(await locOnHand(s, s.locA)).toBe(30);

    const mvs = await LocationMovement.find({ itemId: s.raw._id, type: "issue" }).lean();
    expect(mvs).toHaveLength(1);
    expect(mvs[0].direction).toBe("out");
    expect(mvs[0].quantity).toBe(10);
    expect(mvs[0].source.kind).toBe("mrf_issue");
    expect(String(mvs[0].source.id)).toBe(String(s.mrf._id));
    expect(String(mvs[0].locationId)).toBe(String(s.locA._id));
    expect(mvs[0].idempotencyKey).toBeTruthy();   // per-line movement key
    expect(mvs[0].operationKey).toBeTruthy();      // operation key kept for audit
  });

  test("a tracked item with NO location is refused with LOCATION_REQUIRED — nothing moves", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const r = await issue(s, [{ itemId: s.itemId, issuedQty: 10 }]);
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("LOCATION_REQUIRED");
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(40); // unchanged
    expect(await locOnHand(s, s.locA)).toBe(40);
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(0);
  });

  test("an inactive / foreign location is refused, not guessed", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const otherWh = await Warehouse.create({
      companyId: (await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") }))._id,
      name: "Foreign", shortName: `F${seq}`, status: "Active",
      locations: [{ code: "X", name: "X", type: "USABLE_STOCK", status: "Active" }],
    });
    const r = await issue(s, [{ itemId: s.itemId, issuedQty: 5, warehouseId: String(otherWh._id), locationId: String(otherWh.locations[0]._id) }]);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(40); // untouched
  });
});

/* ═══ 4 · AUTO-FULFILMENT CANNOT BYPASS LOCATION ══════════════════════════ */

describe("auto-fulfilment", () => {
  test("issue_from_stock on a tracked item with no source is blocked with LOCATION_REQUIRED", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const r = await call(s.store, `/${s.mrf._id}/fulfilment-decision`, {
      method: "POST", body: { decision: "issue_from_stock" }, idempotencyKey: newKey(),
    });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("LOCATION_REQUIRED");
    // nothing issued, nothing moved
    expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty || 0).toBe(0);
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(0);
    expect(await locOnHand(s, s.locA)).toBe(40);
  });

  test("issue_from_stock WITH a source location in the confirmation step reduces that location", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const r = await call(s.store, `/${s.mrf._id}/fulfilment-decision`, {
      method: "POST",
      body: { decision: "issue_from_stock", lines: [{ itemId: s.itemId, issueQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }] },
      idempotencyKey: newKey(),
    });
    expect(r.status).toBe(200);
    expect(await locOnHand(s, s.locA)).toBe(30);
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(1);
  });
});

/* ═══ 5 · INSUFFICIENT SOURCE LEAVES EVERYTHING UNCHANGED ═════════════════ */

describe("insufficient source-location stock", () => {
  test("refuses before any canonical change — RawItem, location balance and ledger all untouched", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 30 });
    // Only 40 at A1; ask to issue more than the location holds (company recheck
    // would pass, the LOCATION check must not).
    // Move most of A1 away first so the location holds less than requested.
    await LocationBalance.updateOne(
      locStock.locFilter(s.company._id, s.raw._id, null, s.wh._id, s.locA._id),
      { $set: { onHand: 5 } },
    );
    const before = await LocationMovement.countDocuments({ itemId: s.raw._id });

    const r = await issue(s, [{ itemId: s.itemId, issuedQty: 20, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }]);
    expect(r.status).toBe(409);

    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(40); // company unchanged
    expect(await locOnHand(s, s.locA)).toBe(5);                            // location unchanged
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id })).toBe(before); // no new ledger row
    expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty || 0).toBe(0);
  });
});

/* ═══ 6 · TWO VARIANTS STAY SEPARATE ══════════════════════════════════════ */

describe("variants", () => {
  test("issuing one variant reduces only that variant's location balance", async () => {
    const s = await seed({
      stockQty: 0, requestedQty: 4,
      variants: [{ combination: ["Red"], qty: 10 }, { combination: ["Blue"], qty: 8 }],
    });
    const [redId, blueId] = s.variantIds;

    // Point the MRF line at the Red variant.
    await MRF.updateOne(
      { _id: s.mrf._id, "items._id": s.itemId },
      { $set: { "items.$.variantId": redId, "items.$.variantCombination": ["Red"] } },
    );

    const r = await issue(s, [{ itemId: s.itemId, issuedQty: 4, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }]);
    expect(r.status).toBe(200);

    expect(await locOnHand(s, s.locA, redId)).toBe(6);  // 10 − 4
    expect(await locOnHand(s, s.locA, blueId)).toBe(8); // untouched
    const mvs = await LocationMovement.find({ itemId: s.raw._id, type: "issue" }).lean();
    expect(mvs).toHaveLength(1);
    expect(String(mvs[0].variantId)).toBe(String(redId));
  });
});

/* ═══ 7 · DEPARTMENT RETURN CREDITS ONLY THE CHOSEN DESTINATION ═══════════ */

describe("department return", () => {
  async function issuedState() {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const r = await issue(s, [{ itemId: s.itemId, issuedQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }]);
    expect(r.status).toBe(200);
    return s; // A1 now holds 30, company 30, 10 issued
  }

  test("returning to a chosen destination increases only that location", async () => {
    const s = await issuedState();
    expect(await locOnHand(s, s.locB)).toBe(0);

    const r = await doReturn(s, s.itemId, { returnedQty: 4, notes: "spare", warehouseId: String(s.wh._id), locationId: String(s.locB._id) });
    expect(r.status).toBe(200);

    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(34); // 30 + 4 back
    expect(await locOnHand(s, s.locB)).toBe(4);  // only B1 credited
    expect(await locOnHand(s, s.locA)).toBe(30); // A1 unchanged

    const mvs = await LocationMovement.find({ itemId: s.raw._id, type: "return" }).lean();
    expect(mvs).toHaveLength(1);
    expect(mvs[0].direction).toBe("in");
    expect(mvs[0].source.kind).toBe("mrf_return");
    expect(String(mvs[0].source.id)).toBe(String(s.mrf._id));
    expect(String(mvs[0].locationId)).toBe(String(s.locB._id));
  });

  test("an over-return is refused", async () => {
    const s = await issuedState(); // 10 issued, 0 returned
    const r = await doReturn(s, s.itemId, { returnedQty: 15, warehouseId: String(s.wh._id), locationId: String(s.locB._id) });
    expect(r.status).toBe(400);
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "return" })).toBe(0);
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(30); // unchanged
  });
});

/* ═══ 9 · REPLAY IS EXACTLY ONCE ══════════════════════════════════════════ */

describe("idempotent replay", () => {
  test("a re-posted issue moves stock and writes the location-out movement exactly once", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const key = newKey();
    const body = [{ itemId: s.itemId, issuedQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }];

    const first = await issue(s, body, key);
    const second = await issue(s, body, key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await locOnHand(s, s.locA)).toBe(30); // fell by 10 once, not twice
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(1);
    expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(30);
  });

  test("a re-posted return credits stock and writes the location-in movement exactly once", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    await issue(s, [{ itemId: s.itemId, issuedQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }]);

    const key = newKey();
    const body = { returnedQty: 4, warehouseId: String(s.wh._id), locationId: String(s.locB._id) };
    const first = await doReturn(s, s.itemId, body, key);
    const second = await doReturn(s, s.itemId, body, key);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await locOnHand(s, s.locB)).toBe(4); // credited once
    expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "return" })).toBe(1);
  });

  // Standalone (no transactions) recovery is UNCHANGED: the marker is stamped
  // before the ledger writes, so a failure part-way makes the deduction
  // at-most-once — a retry recovers (reconciliation) and NEVER re-moves stock.
  test("standalone: a mid-issue failure marks the effect; the retry recovers and does not re-issue", async () => {
    const s = await seed({ stockQty: 40, requestedQty: 10 });
    const key = newKey();
    const body = [{ itemId: s.itemId, issuedQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }];

    // The movement write throws AFTER the RawItem deduction has (non-transactionally) landed.
    const spy = jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("inject: movement"); });
    const first = await issue(s, body, key);
    expect(first.status).toBeGreaterThanOrEqual(400);
    spy.mockRestore();

    const afterFail = (await RawItem.findById(s.raw._id).lean()).quantity;

    const retry = await issue(s, body, key);
    // Recovery, not a fresh re-issue: it must not deduct a SECOND time.
    expect(retry.status).toBeGreaterThanOrEqual(400);
    const afterRetry = (await RawItem.findById(s.raw._id).lean()).quantity;
    expect(afterRetry).toBe(afterFail);            // no further deduction
    expect(afterRetry).toBeGreaterThanOrEqual(30); // moved at most once (never 20)
    expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty || 0).toBe(0);
  });
});
