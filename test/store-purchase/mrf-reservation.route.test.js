// test/store-purchase/mrf-reservation.route.test.js
//
// CHUNK 9A — Stock reservations, picking & controlled issue. Proves the core:
// reserving is a live record that never changes on-hand or LocationBalance;
// availability = usable on-hand − reserved; only USABLE_STOCK+Active locations
// count; partial reservation backorders the remainder; the controlled issue posts
// ONE movement + ONE location deduction through the existing engine and reduces
// the reservation; release restores availability with on-hand unchanged; services
// and exact item/variant identity are enforced.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return { submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop, tlApproved: noop, tlRejected: noop, issued: noop, unfulfilled: noop, returned: noop, productRequestChatMessage: noop, productRequestTlApproved: noop, productRequestTlRejected: noop };
});
jest.mock("../../services/mrfChat.service", () => ({ systemMessage: () => Promise.resolve(null), postMessage: () => Promise.resolve(null), listMessages: () => Promise.resolve([]), markRead: () => Promise.resolve({ unread: 0 }), describeSubject: () => ({ label: "" }) }));

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
const LocationReservation = require("../../models/CMS_Models/Inventory/Operations/LocationReservation");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const Employee = require("../../models/Employee");
const locStock = require("../../services/storePurchase/locationStock.service");

let server, base, seq = 0, idemSeq = 0;
const newKey = () => `rv-${++idemSeq}-${Math.random().toString(36).slice(2)}`;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/mrf`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      Authorization: `Bearer ${jwt.sign({ id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: `${emp.firstName} ${emp.lastName}`, email: emp.email }, process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" })}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });
async function seedLoc(company, wh, loc, raw, qty, variantId = null) {
  await locStock.applyLocationIn(null, { companyId: company._id, siteId: null, item: raw, variantId, warehouse: wh, location: loc, quantity: qty, type: "receipt", intent: "receive", source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "" });
}

async function seed({ stockQty = 50, requestedQty = 10, unit = "pcs", baseUnit = "pcs", variants = null, extraLocations = [], service = false, locAQty = null } = {}) {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Res Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const emp = await person({ firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`, biometricId: `TC${n}` });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`, biometricId: `ST${n}`, department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });

  const wh = await Warehouse.create({
    companyId: company._id, name: `WH ${n}`, shortName: `W${n}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
      ...extraLocations,
    ],
  });
  const [locA, locB] = wh.locations;

  const raw = await RawItem.create({ name: `Blade ${n}`, sku: `BLD-${n}`, unit: baseUnit, quantity: stockQty, minStock: 0,
    ...(variants ? { variants: variants.map((v, i) => ({ combination: v.combination, quantity: v.qty, sku: `BLD-${n}-v${i}`, status: "In Stock" })) } : {}) });
  const freshRaw = await RawItem.findById(raw._id).lean();
  if (variants) { for (let i = 0; i < variants.length; i++) await seedLoc(company, wh, locA, raw, variants[i].qty, freshRaw.variants[i]._id); }
  else await seedLoc(company, wh, locA, raw, locAQty == null ? stockQty : locAQty);

  const mrfItem = service
    ? { rawItemName: `Repair ${n}`, requestedQty, unit, baseUnit, itemStatus: "PENDING", availability: "UNREVIEWED" }
    : { rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku, requestedQty, unit, baseUnit, itemStatus: "APPROVED", availability: "UNREVIEWED",
        ...(variants ? { variantId: freshRaw.variants[0]._id, variantCombination: variants[0].combination } : {}) };

  const mrf = await MRF.create({
    mrfNumber: `MRF/2026-27/${String(++seq).padStart(4, "0")}`, companyId: company._id,
    requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech", requestedForId: emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED", createdByRef: emp._id, createdByModel: "Employee", createdByName: "Rutu",
    reason: "x", tlApproved: true, ...(service ? { fulfilmentDecision: "buy_or_service" } : {}), items: [mrfItem],
  });
  return { company, emp, store, wh, locA, locB, raw, mrf, itemId: String(mrf.items[0]._id), variantIds: freshRaw.variants?.map((v) => String(v._id)) || [] };
}

const avail = (s, itemId = s.itemId) => call(s.store, `/${s.mrf._id}/items/${itemId}/availability`);
const reserve = (s, allocations, key = newKey(), itemId = s.itemId) => call(s.store, `/${s.mrf._id}/items/${itemId}/reserve`, { method: "POST", body: { allocations }, idempotencyKey: key });
const doIssue = (s, reservationId, body = {}, key = newKey()) => call(s.store, `/${s.mrf._id}/reservations/${reservationId}/issue`, { method: "POST", body, idempotencyKey: key });
const doRelease = (s, reservationId, body = {}, key = newKey()) => call(s.store, `/${s.mrf._id}/reservations/${reservationId}/release`, { method: "POST", body, idempotencyKey: key });
const onHand = (s, loc, variantId = null) => locStock.locationOnHand(null, s.company._id, s.raw._id, variantId, s.wh._id, loc._id);
const alloc = (s, loc, qty) => ({ warehouseId: String(s.wh._id), locationId: String(loc._id), qty });

/* ═══ Availability ═══ */

test("1 · availability = usable on-hand − reserved; reserving leaves on-hand unchanged", async () => {
  const s = await seed({ stockQty: 50, requestedQty: 10 });
  const a0 = await avail(s);
  expect(a0.status).toBe(200);
  const rowA = a0.body.locations.find((l) => l.locationCode === "A1");
  expect(rowA.onHand).toBe(50); expect(rowA.reserved).toBe(0); expect(rowA.available).toBe(50);

  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  expect(r.status).toBe(201);
  expect(r.body.reservation.reservedQty).toBe(10);
  // ON-HAND and LocationBalance are UNCHANGED by reserving.
  expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(50);
  expect(await onHand(s, s.locA)).toBe(50);
  // Available fell by the reserved amount.
  const a1 = await avail(s);
  expect(a1.body.locations.find((l) => l.locationCode === "A1").available).toBe(40);
  expect(a1.body.locations.find((l) => l.locationCode === "A1").reserved).toBe(10);
});

test("2 · a reservation records NO stock movement", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 5 });
  await reserve(s, [alloc(s, s.locA, 5)]);
  const movements = await LocationMovement.find({ itemId: s.raw._id, type: { $in: ["issue", "return", "adjustment"] } }).lean();
  expect(movements).toHaveLength(0);   // reserving is never a movement
  const proj = await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean();
  expect(proj.reserved).toBe(5);       // it lives only in the reservation projection
});

test("3 · full vs partial reservation; the shortfall is backordered", async () => {
  const s = await seed({ stockQty: 6, requestedQty: 10 });   // only 6 on hand, want 10
  const r = await reserve(s, [alloc(s, s.locA, 6)]);
  expect(r.status).toBe(201);
  expect(r.body.reservation.reservedQty).toBe(6);
  expect(r.body.reservation.backorderedQty).toBe(4);
  expect(r.body.reservation.status).toBe("PARTIALLY_RESERVED");
});

test("4 · reserving MORE than a location's availability is refused, nothing reserved", async () => {
  const s = await seed({ stockQty: 5, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 8)]);   // only 5 available
  expect(r.status).toBe(400);
  expect(r.body.error.details.reason).toBe("INSUFFICIENT_AVAILABILITY");
  expect(await StockReservation.countDocuments({ companyId: s.company._id })).toBe(0);
  // Nothing was actually reserved. (A refused reserve may leave a reserved:0
  // projection row in this non-transactional test env; production rolls the
  // guard's upsert back with the transaction — the invariant is reserved === 0.)
  const projs = await LocationReservation.find({ itemId: s.raw._id }).lean();
  expect(projs.reduce((t, p) => t + p.reserved, 0)).toBe(0);
});

test("5 · a same-key reserve replays without reserving twice", async () => {
  const s = await seed({ stockQty: 50, requestedQty: 10 });
  const k = newKey();
  const r1 = await reserve(s, [alloc(s, s.locA, 10)], k);
  const r2 = await reserve(s, [alloc(s, s.locA, 10)], k);
  expect(r1.status).toBe(201);
  expect([200, 201]).toContain(r2.status);
  expect(String(r2.body.reservation.id)).toBe(String(r1.body.reservation.id));
  expect((await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean()).reserved).toBe(10);
});

test("6 · another demand may reserve only the REMAINING availability", async () => {
  const s = await seed({ stockQty: 10, requestedQty: 10 });
  expect((await reserve(s, [alloc(s, s.locA, 7)])).status).toBe(201);
  // A second MRF line/demand on the same stock — build a second MRF.
  const s2mrf = await MRF.create({ mrfNumber: `MRF/2026-27/${String(++seq).padStart(4, "0")}`, companyId: s.company._id, requestedFor: s.emp._id, requestedForName: "Rutu", requestedForDept: "Tech", requestType: "USES_BASED", status: "APPROVED", createdByRef: s.emp._id, createdByModel: "Employee", tlApproved: true, items: [{ rawItem: s.raw._id, rawItemName: s.raw.name, requestedQty: 10, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED" }] });
  const s2 = { ...s, mrf: s2mrf, itemId: String(s2mrf.items[0]._id) };
  const over = await reserve(s2, [alloc(s2, s.locA, 5)]);   // only 3 left
  expect(over.status).toBe(400);
  expect((await reserve(s2, [alloc(s2, s.locA, 3)])).status).toBe(201);   // exactly the remainder
});

test("7 · Receiving / Quarantine / Returns / inactive locations are never available", async () => {
  const s = await seed({ stockQty: 30, requestedQty: 5, extraLocations: [
    { code: "RECV", name: "Recv", type: "RECEIVING", status: "Active" },
    { code: "QUAR", name: "Quar", type: "QUARANTINE", status: "Active" },
    { code: "RETN", name: "Retn", type: "RETURNS", status: "Active" },
    { code: "DEAD", name: "Dead", type: "USABLE_STOCK", status: "Inactive" },
  ] });
  // Put stock into a receiving location — it must not appear as available.
  const recv = s.wh.locations.find((l) => l.code === "RECV");
  await seedLoc(s.company, s.wh, recv, s.raw, 100);
  const a = await avail(s);
  const codes = a.body.locations.map((l) => l.locationCode);
  expect(codes).toContain("A1");
  expect(codes).not.toEqual(expect.arrayContaining(["RECV", "QUAR", "RETN", "DEAD"]));
});

test("8 · exact item/variant identity is enforced; variants stay separate", async () => {
  const s = await seed({ requestedQty: 4, variants: [{ combination: ["Red"], qty: 10 }, { combination: ["Blue"], qty: 3 }] });
  const a = await avail(s);   // the MRF line is the Red variant
  expect(a.body.locations[0].available).toBe(10);   // only Red's 10, never Blue's 3
  const r = await reserve(s, [alloc(s, s.locA, 4)]);
  expect(r.status).toBe(201);
  const proj = await LocationReservation.findOne({ itemId: s.raw._id, variantId: s.variantIds[0], locationId: s.locA._id }).lean();
  expect(proj.reserved).toBe(4);
  // Blue's availability is untouched.
  const blueProj = await LocationReservation.findOne({ itemId: s.raw._id, variantId: s.variantIds[1] }).lean();
  expect(blueProj).toBeNull();
});

test("9 · a missing unit conversion refuses safely, never treating units as equal", async () => {
  const s = await seed({ stockQty: 50, requestedQty: 2, unit: "box", baseUnit: "pcs" });   // no box→pcs conversion configured
  const a = await avail(s);
  expect(a.status).toBe(400);
  expect(a.body.reason || a.body.error?.details?.reason).toBe("UOM_CONVERSION_MISSING");
});

test("10 · one demand allocated across TWO locations", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10, locAQty: 6 });
  await seedLoc(s.company, s.wh, s.locB, s.raw, 8);   // A1=6, B1=8
  const r = await reserve(s, [alloc(s, s.locA, 6), alloc(s, s.locB, 4)]);
  expect(r.status).toBe(201);
  expect(r.body.reservation.reservedQty).toBe(10);
  expect(r.body.reservation.allocations).toHaveLength(2);
  expect((await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean()).reserved).toBe(6);
  expect((await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locB._id }).lean()).reserved).toBe(4);
});

test("11 · a service line cannot be reserved — it follows the Service Order workflow", async () => {
  const s = await seed({ service: true, requestedQty: 1 });
  const a = await avail(s);
  expect(a.status).toBe(400);
  expect(a.body.code).toBe("SERVICE_NOT_RESERVABLE");
  const r = await reserve(s, [{ warehouseId: String(s.wh._id), locationId: String(s.locA._id), qty: 1 }]);
  expect(r.status).toBe(400);
  expect(r.body.code).toBe("SERVICE_NOT_RESERVABLE");
});

/* ═══ Controlled issue + release ═══ */

test("12 · partial issue consumes only part of the reservation; ONE movement + ONE deduction", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  const resId = r.body.reservation.id;
  const iss = await doIssue(s, resId, { qty: 6 });
  expect(iss.status).toBe(201);
  // company + location on-hand each fell by 6 exactly once.
  expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(14);
  expect(await onHand(s, s.locA)).toBe(14);
  const mvs = await LocationMovement.find({ itemId: s.raw._id, type: "issue" }).lean();
  expect(mvs).toHaveLength(1);
  expect(mvs[0].quantity).toBe(6);
  expect(mvs[0].source.kind).toBe("mrf_issue");
  // reservation active reserved fell to 4; MRF line issuedQty rose to 6.
  expect(iss.body.reservation.activeReservedQty).toBe(4);
  expect(iss.body.reservation.issuedQty).toBe(6);
  const mrf = await MRF.findById(s.mrf._id).lean();
  expect(mrf.items[0].issuedQty).toBe(6);
  expect(mrf.items[0].itemStatus).toBe("PARTIALLY_ISSUED");
  // Reserved projection dropped by the issued amount (4 left).
  expect((await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean()).reserved).toBe(4);
});

test("13 · full issue closes the reservation", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  const iss = await doIssue(s, r.body.reservation.id, {});   // issue all reserved
  expect(iss.status).toBe(201);
  expect(iss.body.reservation.status).toBe("ISSUED");
  expect(iss.body.reservation.activeReservedQty).toBe(0);
  expect((await MRF.findById(s.mrf._id).lean()).items[0].itemStatus).toBe("ISSUED");
});

test("14 · release restores availability WITHOUT changing on-hand; the record is preserved", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  const before = await onHand(s, s.locA);
  const rel = await doRelease(s, r.body.reservation.id, { qty: 4 });
  expect(rel.status).toBe(200);
  expect(await onHand(s, s.locA)).toBe(before);   // on-hand UNCHANGED
  expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(20);
  expect(rel.body.reservation.activeReservedQty).toBe(6);   // 10 − 4 released
  expect((await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean()).reserved).toBe(6);
  // The record is never deleted.
  expect(await StockReservation.countDocuments({ companyId: s.company._id })).toBe(1);
  // Availability recovered by 4 (on-hand 20 − reserved 6 = 14, up from 10).
  expect((await avail(s)).body.locations.find((l) => l.locationCode === "A1").available).toBe(14);
});

test("15 · releasing more than the unissued reserved balance is refused", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  await doIssue(s, r.body.reservation.id, { qty: 6 });
  const rel = await doRelease(s, r.body.reservation.id, { qty: 8 });   // only 4 left unissued
  expect(rel.status).toBe(400);
  expect(rel.body.reason).toBe("OVER_RELEASE");
});

test("17 · picking records the gathered quantity WITHOUT moving stock; the pick list says lot-level is unavailable", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  const resId = r.body.reservation.id;
  const before = await onHand(s, s.locA);
  const pick = await call(s.store, `/${s.mrf._id}/reservations/${resId}/pick`, { method: "POST", body: { qty: 7 } });
  expect(pick.status).toBe(200);
  expect(pick.body.reservation.pickedQty).toBe(7);
  // Picking is a soft counter — no movement, on-hand unchanged.
  expect(await onHand(s, s.locA)).toBe(before);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id, type: "issue" })).toBe(0);
  // Over-pick beyond the reserved is refused.
  const over = await call(s.store, `/${s.mrf._id}/reservations/${resId}/pick`, { method: "POST", body: { qty: 99 } });
  expect(over.status).toBe(400);
  expect(over.body.reason).toBe("OVER_PICK");
  // The pick list is honest about lot-level picking.
  const pl = await call(s.store, `/${s.mrf._id}/reservations/${resId}/pick-list`);
  expect(pl.status).toBe(200);
  expect(pl.body.pickList.lotPicking.available).toBe(false);
  expect(pl.body.pickList.lotPicking.note).toMatch(/not available/i);
  expect(pl.body.pickList.lines.length).toBe(1);
});

test("18 · a client-supplied replacement item is never accepted at issue time", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  const r = await reserve(s, [alloc(s, s.locA, 10)]);
  // The issue endpoint takes NO item — even if the MRF line's match were changed
  // to a different item, the reserved item/variant is what governs. Simulate a
  // provenance drift by mutating the line's rawItem, then issuing.
  const otherRaw = await RawItem.create({ name: `Other ${Date.now()}`, sku: `OTH-${Date.now()}`, unit: "pcs", quantity: 5, minStock: 0 });
  await MRF.updateOne({ _id: s.mrf._id, "items._id": s.mrf.items[0]._id }, { $set: { "items.$.rawItem": otherRaw._id } });
  const iss = await doIssue(s, r.body.reservation.id, { qty: 5 });
  expect(iss.status).toBe(409);
  expect(iss.body.reason).toBe("SUBSTITUTION_REQUIRES_RELEASE");
});

test("16 · the queue groups reservations and unreserved approved lines", async () => {
  const s = await seed({ stockQty: 20, requestedQty: 10 });
  // Before reserving, the approved stock line is "Ready to reserve".
  const q0 = await call(s.store, `/reservations/queue`);
  expect(q0.status).toBe(200);
  expect(q0.body.queue.rows.some((row) => row.mrfLineId === s.itemId && row.group === "READY_TO_RESERVE")).toBe(true);
  // After a full reservation it becomes "Ready to pick".
  await reserve(s, [alloc(s, s.locA, 10)]);
  const q1 = await call(s.store, `/reservations/queue?group=READY_TO_PICK`);
  expect(q1.body.queue.rows.some((row) => row.mrfLineId === s.itemId)).toBe(true);
  expect(q1.body.queue.counts.READY_TO_PICK).toBeGreaterThanOrEqual(1);
});
