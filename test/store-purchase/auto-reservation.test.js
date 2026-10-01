// test/store-purchase/auto-reservation.test.js
//
// AUTOMATIC RESERVATION — approval holds the stock, and every case that is not
// the happy path.
//
// The happy path is one test here. The rest are the cases that decide whether
// this feature is safe to turn on: partial availability, customer-owned stock,
// ownership that cannot be proven, a missing unit conversion, a named warehouse
// that cannot answer, concurrency, retries, and an approval that must survive a
// failed attempt.
//
// Two distinctions are asserted repeatedly because collapsing either is the way
// this feature goes wrong:
//   · SHORT ("we looked, the shelf is empty") vs ATTENTION ("we could not
//     safely tell") — one is a purchasing instruction, the other is a data
//     problem, and dressing the second as the first raises purchases nobody
//     asked for.
//   · reserving vs moving — a hold is a live record; on-hand, LocationBalance,
//     LocationMovement and the ledger are untouched, and that is counted.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return { submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop, tlApproved: noop, tlRejected: noop, issued: noop, unfulfilled: noop, returned: noop, productRequestChatMessage: noop, productRequestTlApproved: noop, productRequestTlRejected: noop };
});
jest.mock("../../services/mrfChat.service", () => ({ systemMessage: () => Promise.resolve(null), postMessage: () => Promise.resolve(null), listMessages: () => Promise.resolve([]), markRead: () => Promise.resolve({ unread: 0 }), describeSubject: () => ({ label: "" }) }));

const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const Employee = require("../../models/Employee");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationReservation = require("../../models/CMS_Models/Inventory/Operations/LocationReservation");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const { CustomerMaterialLot } = require("../../models/CMS_Models/StorePurchase/CustomerMaterialLot");

const locStock = require("../../services/storePurchase/locationStock.service");
const auto = require("../../services/storePurchase/autoReservation.service");

let seq = 0;

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });

async function seedLoc(company, wh, loc, raw, qty, variantId = null) {
  await locStock.applyLocationIn(null, {
    companyId: company._id, siteId: null, item: raw, variantId, warehouse: wh, location: loc,
    quantity: qty, type: "receipt", intent: "receive", source: { kind: "seed" }, actor: {},
    note: "seed", idempotencyKey: "",
  });
}

/**
 * One approved request against one material, with stock placed where the test
 * asks for it. Deliberately the same shape the manual-reservation suite seeds,
 * so a difference in behaviour between the two paths is a difference in the
 * code and not in the fixture.
 */
async function seed({
  requestedQty = 10, unit = "pcs", baseUnit = "pcs",
  locAQty = 50, locBQty = 0,
  extraLocations = [], service = false, unmatched = false,
  preferredWarehouse = false, itemStatus = "APPROVED",
  approved = true,
} = {}) {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Auto Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const emp = await person({ firstName: "Rutu", lastName: `A${n}`, email: `auto${n}@demo.example`, biometricId: `AT${n}` });

  const wh = await Warehouse.create({
    companyId: company._id, name: `WH ${n}`, shortName: `AW${n}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
      ...extraLocations,
    ],
  });
  const [locA, locB] = wh.locations;

  const raw = await RawItem.create({
    name: `Blade ${n}`, sku: `ABL-${n}`, unit: baseUnit, quantity: locAQty + locBQty, minStock: 0,
  });
  if (locAQty > 0) await seedLoc(company, wh, locA, raw, locAQty);
  if (locBQty > 0) await seedLoc(company, wh, locB, raw, locBQty);

  const item = service
    ? { rawItemName: `Repair ${n}`, requestedQty, unit, baseUnit, itemStatus: "PENDING", availability: "UNREVIEWED" }
    : unmatched
      ? { rawItemName: `Described ${n}`, requestedQty, unit, baseUnit, itemStatus: "UNMATCHED", availability: "UNREVIEWED" }
      : {
        rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku,
        requestedQty, unit, baseUnit, itemStatus, availability: "UNREVIEWED",
        ...(preferredWarehouse ? { warehouseId: wh._id } : {}),
      };

  const mrf = await MRF.create({
    mrfNumber: `MRF/AUTO/${String(++seq).padStart(4, "0")}`, companyId: company._id,
    requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech", requestedForId: emp.biometricId,
    requestType: "USES_BASED", status: approved ? "APPROVED" : "PENDING",
    createdByRef: emp._id, createdByModel: "Employee", createdByName: "Rutu",
    reason: "x", tlApproved: approved,
    ...(service ? { fulfilmentDecision: "buy_or_service" } : {}),
    items: [item],
  });

  return {
    company, emp, wh, locA, locB, raw, mrf,
    tenant: { companyId: company._id, siteId: null },
    lineId: String(mrf.items[0]._id),
  };
}

const run = (s, over = {}) => auto.attemptForRequest({
  tenant: s.tenant, mrfId: s.mrf._id,
  trigger: auto.TRIGGERS.TL_APPROVED, actorName: "Bikash", ...over,
});
const onHand = (s, loc) => locStock.locationOnHand(null, s.company._id, s.raw._id, null, s.wh._id, loc._id);
const lineOf = async (s) => (await MRF.findById(s.mrf._id).lean()).items[0];

/* ═══════════════════════════════════════════════════════════════════════════
   1. THE HOLD ITSELF
   ═══════════════════════════════════════════════════════════════════════════ */

test("1 · approval holds the whole quantity and the line becomes ready to pick", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 50 });
  const r = await run(s);

  expect(r.attempted).toBe(true);
  expect(r.lines).toHaveLength(1);
  expect(r.lines[0].outcome).toBe("RESERVED");
  expect(r.lines[0].reservedQty).toBe(10);
  expect(r.lines[0].shortQty).toBe(0);

  const held = await StockReservation.findOne({ mrfLineId: s.mrf.items[0]._id, active: true }).lean();
  expect(held.reservedQty).toBe(10);
  expect(held.status).toBe("RESERVED");
  // The stage a picker sees.
  expect(auto.stageOfGroup(require("../../services/storePurchase/reservation.service").queueGroup(held)))
    .toBe("READY_TO_PICK");
});

test("2 · reserving changes NO on-hand and writes NO stock movement", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 50 });
  const before = await LocationMovement.countDocuments({ itemId: s.raw._id });

  await run(s);

  // The three places a movement would show up, all unchanged.
  expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(50);
  expect(await onHand(s, s.locA)).toBe(50);
  expect(await LocationMovement.countDocuments({ itemId: s.raw._id })).toBe(before);
  // It lives only in the reservation projection.
  const proj = await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean();
  expect(proj.reserved).toBe(10);
});

test("3 · the attempt is recorded on the line, with which trigger and who", async () => {
  const s = await seed({ requestedQty: 4, locAQty: 10 });
  await run(s, { trigger: auto.TRIGGERS.AUTO_FORWARDED, actorName: "Auto Forwarder" });

  const line = await lineOf(s);
  expect(line.autoReserve.outcome).toBe("RESERVED");
  expect(line.autoReserve.trigger).toBe("AUTO_FORWARDED");
  expect(line.autoReserve.actorName).toBe("Auto Forwarder");
  expect(line.autoReserve.attemptedAt).toBeTruthy();
  expect(line.autoReserve.attempts).toBe(1);
  expect(line.autoReserve.reservedQty).toBe(4);
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. PARTIAL, SHORT, AND THE DIFFERENCE BETWEEN THEM
   ═══════════════════════════════════════════════════════════════════════════ */

test("4 · partial availability holds what there is and states the exact shortfall", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 6 });
  const r = await run(s);

  expect(r.lines[0].outcome).toBe("PARTIAL");
  expect(r.lines[0].reservedQty).toBe(6);
  expect(r.lines[0].shortQty).toBe(4);          // exact, not "some"
  // The hold that was made is PRESERVED — a partial answer is not a failure.
  const held = await StockReservation.findOne({ mrfLineId: s.mrf.items[0]._id, active: true }).lean();
  expect(held.reservedQty).toBe(6);
  expect(held.backorderedQty).toBe(4);
  expect(held.status).toBe("PARTIALLY_RESERVED");
});

test("5 · it allocates across locations, and never more than the request needs", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 4, locBQty: 30 });
  const r = await run(s);

  expect(r.lines[0].outcome).toBe("RESERVED");
  expect(r.lines[0].reservedQty).toBe(10);
  const held = await StockReservation.findOne({ mrfLineId: s.mrf.items[0]._id, active: true }).lean();
  expect(held.allocations).toHaveLength(2);
  expect(held.allocations.reduce((t, a) => t + a.reservedQty, 0)).toBe(10);
  // 30 were free at B1; only the remaining 6 were taken.
  const b = held.allocations.find((a) => a.locationCode === "B1");
  expect(b.reservedQty).toBe(6);
});

test("6 · zero eligible stock is SHORT, holds nothing, and writes no empty record", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 0 });
  const r = await run(s);

  expect(r.lines[0].outcome).toBe("SHORT");
  expect(r.lines[0].reservedQty).toBe(0);
  expect(r.lines[0].shortQty).toBe(10);
  expect(r.lines[0].reason).toBe("NO_ELIGIBLE_STOCK");
  /* No record at all — an empty reservation would occupy the one-active-per-line
     slot and make the retry look like a duplicate. */
  expect(await StockReservation.countDocuments({ mrfLineId: s.mrf.items[0]._id })).toBe(0);
  // And the approval is untouched.
  expect((await MRF.findById(s.mrf._id).lean()).status).toBe("APPROVED");
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. WHICH STOCK IS ELIGIBLE
   ═══════════════════════════════════════════════════════════════════════════ */

test.each([
  ["RECEIVING", "Receiving"],
  ["INSPECTION", "Inspection"],
  ["QUARANTINE", "Quarantine"],
  ["RETURNS", "Returns"],
  ["SCRAP", "Scrap"],
])("7 · %s stock is never reserved", async (type, name) => {
  const s = await seed({
    requestedQty: 10, locAQty: 0,
    extraLocations: [{ code: "X1", name, type, status: "Active" }],
  });
  const wh = await Warehouse.findById(s.wh._id);
  const x = wh.locations.find((l) => l.code === "X1");
  await seedLoc(s.company, wh, x, s.raw, 100);

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("SHORT");     // 100 sit there and none is eligible
  expect(r.lines[0].reservedQty).toBe(0);
});

test("8 · an INACTIVE usable location is not reserved from", async () => {
  const s = await seed({
    requestedQty: 5, locAQty: 0,
    extraLocations: [{ code: "C1", name: "Closed rack", type: "USABLE_STOCK", status: "Inactive" }],
  });
  const wh = await Warehouse.findById(s.wh._id);
  const c = wh.locations.find((l) => l.code === "C1");
  await seedLoc(s.company, wh, c, s.raw, 100);

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("SHORT");
});

test("9 · an INACTIVE warehouse is not reserved from", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 40 });
  await Warehouse.updateOne({ _id: s.wh._id }, { $set: { status: "Inactive" } });

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("SHORT");
});

test("10 · another company's stock is never reserved (tenant isolation)", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 40 });
  const other = await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") });

  const r = await auto.attemptForRequest({
    tenant: { companyId: other._id, siteId: null },
    mrfId: s.mrf._id, trigger: auto.TRIGGERS.TL_APPROVED,
  });
  expect(r.attempted).toBe(false);
  expect(r.reason).toBe("TENANT_MISMATCH");
  expect(await StockReservation.countDocuments({ mrfLineId: s.mrf.items[0]._id })).toBe(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. OWNERSHIP — the safeguard that must fail closed
   ═══════════════════════════════════════════════════════════════════════════ */

/** A customer lot holding `qty` of the seeded material, optionally placed. */
async function customerLot(s, qty, { placed = true } = {}) {
  return CustomerMaterialLot.create({
    companyId: s.company._id,
    customerId: new mongoose.Types.ObjectId(),
    customerLabel: "Northwind",
    orderRef: `ORD-${++seq}`,
    executionFileId: new mongoose.Types.ObjectId(),
    expectationId: new mongoose.Types.ObjectId(),
    documentRef: `DOC-${seq}`,
    expectationRevisionNo: 1,
    expectationLineRef: `L${seq}`,
    rawItemId: s.raw._id,
    baseQuantity: qty,
    availableQuantity: qty,
    baseUnit: "pcs",
    /* The lot's own provenance: a customer lot exists because goods were
       received against a document, and the model requires that trail. */
    goodsReceiptId: new mongoose.Types.ObjectId(),
    goodsReceiptLineId: new mongoose.Types.ObjectId(),
    goodsReceiptNumber: `GRN-${seq}`,
    receiptQuantity: qty,
    receiptUnit: "pcs",
    receivedAt: new Date("2026-09-01"),
    ...(placed ? { warehouseId: s.wh._id, locationId: s.locA._id, locationCode: "A1" } : {}),
  });
}

test("11 · customer-owned stock at a location is not reserved for an ordinary request", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 10 });
  // All ten on the rack belong to a customer.
  await customerLot(s, 10);

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("SHORT");
  expect(r.lines[0].reservedQty).toBe(0);
});

test("12 · only the customer's share is withheld — the rest is still ours to hold", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 10 });
  await customerLot(s, 4);                       // 4 theirs, 6 ours

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("PARTIAL");
  expect(r.lines[0].reservedQty).toBe(6);
  expect(r.lines[0].shortQty).toBe(4);
});

test("13 · ownership that cannot be placed FAILS CLOSED — attention, never short", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 50 });
  // A lot with stock available and NO location: nothing says which shelf.
  await customerLot(s, 8, { placed: false });

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("ATTENTION");
  expect(r.lines[0].reason).toBe("OWNERSHIP_UNPROVEN");
  /* The distinction this whole test exists for: it did NOT reserve the stock it
     could not vouch for, and it did NOT call it short either — calling it short
     would raise a purchase for material that is sitting on the shelf. */
  expect(r.lines[0].reservedQty).toBe(0);
  expect(await StockReservation.countDocuments({ mrfLineId: s.mrf.items[0]._id })).toBe(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. UNSAFE AND AMBIGUOUS
   ═══════════════════════════════════════════════════════════════════════════ */

test("14 · a missing unit conversion is attention, never a hold computed from a guess", async () => {
  // The line is requested in "box"; the material is kept in "pcs" and no
  // conversion exists between them.
  const s = await seed({ requestedQty: 5, unit: "box", baseUnit: "pcs", locAQty: 100 });

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("ATTENTION");
  expect(r.lines[0].reason).toBe("CONVERSION_UNPROVEN");
  expect(await StockReservation.countDocuments({ mrfLineId: s.mrf.items[0]._id })).toBe(0);
});

test("15 · a named warehouse that is not usable is attention, not a quiet switch elsewhere", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 40, preferredWarehouse: true });
  await Warehouse.updateOne({ _id: s.wh._id }, { $set: { status: "Inactive" } });

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("ATTENTION");
  expect(r.lines[0].reason).toBe("PREFERRED_WAREHOUSE_UNAVAILABLE");
});

test("16 · a named warehouse is a REQUIREMENT — stock elsewhere is not silently used", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 0, preferredWarehouse: true });
  // A second, alphabetically-earlier warehouse with plenty of stock.
  const other = await Warehouse.create({
    companyId: s.company._id, name: "AAA Other", shortName: `AA${seq}`, status: "Active",
    locations: [{ code: "Z1", name: "Rack Z", type: "USABLE_STOCK", status: "Active" }],
  });
  await seedLoc(s.company, other, other.locations[0], s.raw, 100);

  const r = await run(s);
  /* Ordering alone would have put AAA first and reserved from it. The request
     named a warehouse, so a shortfall there is a shortfall. */
  expect(r.lines[0].outcome).toBe("SHORT");
  expect(r.lines[0].reservedQty).toBe(0);
});

test("17 · the missing catalogue item is attention", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 20 });
  await RawItem.deleteOne({ _id: s.raw._id });

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("ATTENTION");
  expect(r.lines[0].reason).toBe("ITEM_MISSING");
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. LINES AUTOMATIC RESERVATION IS NOT FOR
   ═══════════════════════════════════════════════════════════════════════════ */

test("18 · a service / buy request is skipped, not held and not called short", async () => {
  const s = await seed({ requestedQty: 5, service: true, locAQty: 50 });
  const r = await run(s);

  expect(r.lines[0].outcome).toBe("SKIPPED");
  expect(r.lines[0].reason).toBe("SERVICE_OR_BUY");
  expect(await StockReservation.countDocuments({ mrfId: s.mrf._id })).toBe(0);
  // A skipped line is not queue work at all.
  expect(auto.lineStage(await lineOf(s))).toBeNull();
});

test("19 · an unmatched line is skipped with the matching step named", async () => {
  const s = await seed({ requestedQty: 5, unmatched: true, locAQty: 50 });
  const r = await run(s);

  expect(r.lines[0].outcome).toBe("SKIPPED");
  expect(r.lines[0].reason).toBe("NOT_MATCHED");
});

test("20 · a request that is not approved is not attempted at all", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 50, approved: false });
  const r = await run(s);

  expect(r.attempted).toBe(false);
  expect(r.reason).toBe("NOT_APPROVED");
  expect(await StockReservation.countDocuments({ mrfId: s.mrf._id })).toBe(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   7. RETRIES AND CONCURRENCY
   ═══════════════════════════════════════════════════════════════════════════ */

test("21 · a retry returns the existing hold — never a second active reservation", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 50 });
  const first = await run(s);
  expect(first.lines[0].outcome).toBe("RESERVED");

  const again = await run(s, { trigger: auto.TRIGGERS.MANUAL_RETRY });
  expect(again.lines[0].outcome).toBe("RESERVED");
  expect(again.lines[0].idempotent).toBe(true);
  expect(again.lines[0].reason).toBe("ALREADY_RESERVED");

  // One active record, and the projection was not incremented twice.
  expect(await StockReservation.countDocuments({ mrfLineId: s.mrf.items[0]._id, active: true })).toBe(1);
  const proj = await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean();
  expect(proj.reserved).toBe(10);

  // The attempt count rises, so a repeatedly-tried line is visibly that.
  expect((await lineOf(s)).autoReserve.attempts).toBe(2);
});

test("22 · two concurrent attempts cannot reserve the same last stock twice", async () => {
  // Exactly enough for ONE of the two requests.
  const s = await seed({ requestedQty: 10, locAQty: 10 });
  const other = await MRF.create({
    mrfNumber: `MRF/AUTO/${String(++seq).padStart(4, "0")}`, companyId: s.company._id,
    requestedFor: s.emp._id, requestedForName: "Rutu", requestedForDept: "Tech", requestedForId: s.emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED", createdByRef: s.emp._id, createdByModel: "Employee",
    createdByName: "Rutu", reason: "x", tlApproved: true,
    items: [{ rawItem: s.raw._id, rawItemName: s.raw.name, requestedQty: 10, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED", availability: "UNREVIEWED" }],
  });

  const [a, b] = await Promise.all([
    run(s),
    auto.attemptForRequest({ tenant: s.tenant, mrfId: other._id, trigger: auto.TRIGGERS.TL_APPROVED }),
  ]);

  const held = [a.lines[0].reservedQty, b.lines[0].reservedQty];
  // Between them they may hold at most what exists.
  expect(held[0] + held[1]).toBeLessThanOrEqual(10);
  // The projection is the proof: it can never exceed on-hand.
  const proj = await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean();
  expect(proj.reserved).toBeLessThanOrEqual(10);
  // And on-hand never moved.
  expect(await onHand(s, s.locA)).toBe(10);
});

test("23 · losing the race to a manual reservation yields LESS, not an error", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 10 });
  /* Someone reserves 7 of the 10 by hand first — through the same guard the
     automatic path uses, which is the point. */
  const reservationSvc = require("../../services/storePurchase/reservation.service");
  await reservationSvc.reserveAtLocation({
    companyId: s.company._id, itemId: s.raw._id, variantId: null,
    warehouseId: s.wh._id, locationId: s.locA._id, requestedBase: 7, onHand: 10,
  });

  const r = await run(s);
  expect(r.lines[0].outcome).toBe("PARTIAL");
  expect(r.lines[0].reservedQty).toBe(3);
  expect(r.lines[0].shortQty).toBe(7);
});

test("24 · a stale plan cannot hold more than the shelf — the atomic guard decides", async () => {
  /* ── WHY THIS IS NOT THE SAME TEST AS 22 ──────────────────────────────────
     Two parallel attempts serialise at PLANNING: the second reads the first's
     committed hold and simply plans less, so the guard inside the write loop is
     never reached. The dangerous case is the one where the plan is already
     stale when the write happens — the classic read-then-write race — and it
     has to be forced to be tested.

     So the availability read is made to lie: it reports nothing reserved while
     7 of the 10 are in fact already held. The plan therefore proposes all 10,
     and the ONLY thing standing between that and a reservation claiming stock
     that is not there is the atomic guard. */
  const s = await seed({ requestedQty: 10, locAQty: 10 });
  const reservationSvc = require("../../services/storePurchase/reservation.service");
  await reservationSvc.reserveAtLocation({
    companyId: s.company._id, itemId: s.raw._id, variantId: null,
    warehouseId: s.wh._id, locationId: s.locA._id, requestedBase: 7, onHand: 10,
  });
  const stale = jest.spyOn(reservationSvc, "reservedBaseAt").mockResolvedValue(0);

  const r = await run(s);
  stale.mockRestore();

  /* The guard refused the over-large increment, so nothing was recorded for it.
     The outcome is an honest shortfall, not a hold that over-claims. */
  expect(r.lines[0].reservedQty).toBeLessThanOrEqual(3);
  const held = await StockReservation.findOne({ mrfLineId: s.mrf.items[0]._id, active: true }).lean();
  const claimed = held ? held.reservedQty : 0;
  const proj = await LocationReservation.findOne({ itemId: s.raw._id, locationId: s.locA._id }).lean();
  // The record never claims more than the projection actually holds for it,
  // and the projection never exceeds what is on the shelf.
  expect(claimed).toBeLessThanOrEqual(proj.reserved - 7 + 0.0001);
  expect(proj.reserved).toBeLessThanOrEqual(10);
  expect(await onHand(s, s.locA)).toBe(10);
});

/* ═══════════════════════════════════════════════════════════════════════════
   8. FAILURE MUST NOT REACH THE APPROVAL
   ═══════════════════════════════════════════════════════════════════════════ */

test("24 · a thrown failure inside the attempt leaves the approval standing", async () => {
  const s = await seed({ requestedQty: 5, locAQty: 50 });
  const spy = jest.spyOn(locStock, "locationOnHand").mockRejectedValue(new Error("shelf read timed out"));

  const r = await run(s);
  spy.mockRestore();

  // It resolved — it did not throw into the caller.
  expect(r.attempted).toBe(true);
  expect(r.lines[0].outcome).toBe("ATTENTION");
  expect(r.lines[0].reason).toBe("ATTEMPT_FAILED");
  // The approval is exactly as it was.
  const after = await MRF.findById(s.mrf._id).lean();
  expect(after.status).toBe("APPROVED");
  expect(after.tlApproved).toBe(true);
  // And the line says what to do about it.
  expect(auto.lineStage(after.items[0]).stage).toBe("NEEDS_ATTENTION");
  expect(auto.lineStage(after.items[0]).retryable).toBe(true);
});

test("25 · attemptForRequest never rejects, whatever happens beneath it", async () => {
  const spy = jest.spyOn(MRF, "findOne").mockImplementation(() => { throw new Error("db gone"); });
  await expect(auto.attemptForRequest({
    tenant: { companyId: new mongoose.Types.ObjectId() },
    mrfId: new mongoose.Types.ObjectId(),
    trigger: auto.TRIGGERS.TL_APPROVED,
  })).resolves.toMatchObject({ attempted: false, reason: "ATTEMPT_FAILED" });
  spy.mockRestore();
});

/* ═══════════════════════════════════════════════════════════════════════════
   9. THE STAGE A LINE IS SHOWN IN
   ═══════════════════════════════════════════════════════════════════════════ */

test("26 · a line nobody has attempted is NEEDS ATTENTION with a retry — never Short", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 50 });
  const line = (await MRF.findById(s.mrf._id).lean()).items[0];

  // Approved before this feature existed: no attempt record at all.
  expect(line.autoReserve?.attemptedAt).toBeFalsy();
  const stage = auto.lineStage(line);
  expect(stage.stage).toBe("NEEDS_ATTENTION");
  expect(stage.retryable).toBe(true);
  expect(stage.reason).toBe("NEVER_ATTEMPTED");
  /* The whole point: it is NOT reported as short. The shelf has 50 on it, and
     filing this under Short would raise a purchase nobody needs. */
  expect(stage.stage).not.toBe("SHORT");
});

test("27 · 'Ready to reserve' is not one of the daily stages", () => {
  expect(Object.keys(auto.STAGES)).toEqual([
    "READY_TO_PICK", "PARTLY_RESERVED", "SHORT", "PARTLY_ISSUED", "NEEDS_ATTENTION", "COMPLETED",
  ]);
  expect(auto.STAGES.READY_TO_RESERVE).toBeUndefined();
  // The old reservation group, if one ever arrives, is shown as something to look at.
  expect(auto.stageOfGroup("READY_TO_RESERVE")).toBe("NEEDS_ATTENTION");
});

test("28 · an attempted-and-empty line is SHORT, and carries the purchase quantity", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 0 });
  await run(s);
  const line = await lineOf(s);

  const stage = auto.lineStage(line);
  expect(stage.stage).toBe("SHORT");
  expect(line.autoReserve.shortQty).toBe(10);
  /* The MRF stays the source of the need — the shortfall is a quantity ON the
     approved request, not a new document. */
  expect((await MRF.findById(s.mrf._id).lean()).status).toBe("APPROVED");
});

/* ═══════════════════════════════════════════════════════════════════════════
   10. THE PURCHASE BOUNDARY
   ═══════════════════════════════════════════════════════════════════════════ */

test("29 · a shortfall raises no purchase document of any kind", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 3 });
  const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
  const Requisition = require("../../models/CMS_Models/Inventory/Operations/Requisition");
  const before = {
    po: await PurchaseOrder.countDocuments({}),
    rq: await Requisition.countDocuments({}),
  };

  const r = await run(s);
  expect(r.lines[0].shortQty).toBe(7);

  // Automatic reservation commits nothing and buys nothing.
  expect(await PurchaseOrder.countDocuments({})).toBe(before.po);
  expect(await Requisition.countDocuments({})).toBe(before.rq);
  const line = await lineOf(s);
  expect(line.purchaseFormRaised).toBeFalsy();
  expect(line.purchaseRequisitionId).toBeFalsy();
});

test("30 · reserving does not pick, does not issue and does not hand anything over", async () => {
  const s = await seed({ requestedQty: 10, locAQty: 50 });
  await run(s);

  const held = await StockReservation.findOne({ mrfLineId: s.mrf.items[0]._id, active: true }).lean();
  expect(held.pickedQty).toBe(0);      // picking is a claim about the physical world
  expect(held.issuedQty).toBe(0);      // so is issuing
  expect((await lineOf(s)).issuedQty).toBe(0);
  expect(await onHand(s, s.locA)).toBe(50);
});
