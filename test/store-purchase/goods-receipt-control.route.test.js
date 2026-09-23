// test/store-purchase/goods-receipt-control.route.test.js
//
// GOODS RECEIPT INSPECTION / QUARANTINE / PUT-AWAY (V1) — the routes end to end.
// Proves inspection classifies received stock into location moves (quarantine →
// Quarantine, rejected → Returns, accepted stays in Receiving), put-away moves
// only accepted stock to Usable Stock, everything is idempotent, and company-
// wide on-hand (RawItem) NEVER changes.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptPutaway = require("../../models/CMS_Models/StorePurchase/GoodsReceiptPutaway");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  app.use("/api/cms/store/goods-receipts", require("../../routes/CMS_Routes/StorePurchase/goodsReceipts"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (over = {}) =>
  jwt.sign({ id: String(new mongoose.Types.ObjectId()), role: "store_manager", employeeId: `ST${seq}`, name: "St", email: "s@x.example", ...over },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });
const call = (path, { method = "GET", body, token, key } = {}) =>
  fetch(`${base}${path}`, {
    method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(key ? { "Idempotency-Key": key } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b, replayed: r.headers.get("Idempotency-Replayed") === "true" }; });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
async function actor(co) {
  const n = ++seq; const email = `gc${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "GC", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "GC" });
  return tokenFor({ id: String(employeeRef), email });
}
const rawItem = (over = {}) => { const n = ++seq; return RawItem.create({ name: over.name || `Item ${n}`, sku: over.sku || `RAW-${n}`, unit: over.unit || "pcs", quantity: 0, minStock: 0 }); };
const warehouse = (companyId, over = {}) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  locations: [
    { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
    { code: "STOCK", name: "Usable", type: "USABLE_STOCK", status: over.usableStatus || "Active" },
    { code: "QUAR", name: "Quarantine", type: "QUARANTINE", status: "Active" },
    { code: "RETN", name: "Returns", type: "RETURNS", status: "Active" },
  ],
});
const key = () => `gc-${++seq}-${Math.random().toString(36).slice(2)}`;
const locId = (wh, code) => String(wh.locations.find((l) => l.code === code)._id);
const bal = async (rawId, whId, locationId) => {
  const b = await LocationBalance.findOne({ companyId: undefined, itemId: rawId, warehouseId: whId, locationId }).lean().catch(() => null);
  const row = await LocationBalance.findOne({ itemId: rawId, warehouseId: whId, locationId }).lean();
  return row ? row.onHand : 0;
};

async function makePO(co, lines) {
  const items = lines.map((l) => ({
    _id: new mongoose.Types.ObjectId(), rawItem: l.rawItemId, itemName: l.itemName || "Bolt", sku: "SKU",
    unit: l.unit || "pcs", quantity: l.quantity, unitPrice: 10, totalPrice: l.quantity * 10,
    receivedQuantity: 0, pendingQuantity: l.quantity, status: "PENDING",
  }));
  return PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${++seq}`, status: "ISSUED", createdBy: new mongoose.Types.ObjectId(),
    vendorName: "Acme", vendor: new mongoose.Types.ObjectId(), subtotal: 0, taxAmount: 0, totalAmount: 0,
    items, totalReceived: 0, totalPending: items.reduce((s, i) => s + i.pendingQuantity, 0),
  });
}
// Create a GRN into the RECEIVING location and return { grnId, grnLineId, poItemId }.
async function receive(co, token, wh, po, lineIdx = 0, qty = 10) {
  const res = await call(`/api/cms/purchase-orders/${po._id}/goods-receipts`, { method: "POST", token, key: key(), body: {
    items: [{ poItemId: String(po.items[lineIdx]._id), quantity: qty }], warehouseId: String(wh._id), locationId: locId(wh, "RECV"), invoiceNumber: "INV",
  } });
  expect(res.status).toBe(201);
  return { grnId: res.body.goodsReceipt._id, grnLineId: String(res.body.goodsReceipt.lines[0]._id), poItemId: String(po.items[lineIdx]._id) };
}
const CTRL = (grnId) => `/api/cms/store/goods-receipts/${grnId}`;

test("1 · inspection splits received stock: quarantine→Quarantine, rejected→Returns, accepted stays in Receiving; on-hand unchanged", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);

  // After receipt: 10 in Receiving, company on-hand 10.
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(10);
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);

  const ins = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 6, quarantinedQuantity: 3, rejectedQuantity: 1 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  expect(ins.status).toBe(201);

  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(6);   // accepted stays
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR"))).toBe(3);   // quarantined moved
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(1);   // rejected moved
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);     // company on-hand UNCHANGED
});

test("2 · inspection is recorded once; a same-key replay creates no extra movement", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  const k = key();
  const body = { method: "POST", token, key: k, body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 6, quarantinedQuantity: 4, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } };
  const a = await call(`${CTRL(grnId)}/inspection`, body);
  const b = await call(`${CTRL(grnId)}/inspection`, body);
  expect(a.status).toBe(201);
  expect(b.replayed).toBe(true);
  expect(await GoodsReceiptInspection.countDocuments({ goodsReceiptId: grnId })).toBe(1);
  // Only the quarantine transfer legs (2) exist besides the receipt movement — no duplicate.
  expect(await LocationMovement.countDocuments({ itemId: raw._id, type: { $in: ["transfer_in", "transfer_out"] } })).toBe(2);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR"))).toBe(4);   // added once
});

test("3 · a second inspection of the same receipt is refused (immutable, once only)", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  const second = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 5, quarantinedQuantity: 5, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  expect(second.status).toBe(409);
  expect(second.body.reason).toBe("ALREADY_INSPECTED");
});

test("4 · put-away moves only accepted stock to Usable Stock; on-hand unchanged; partial leaves the remainder", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 8, quarantinedQuantity: 2, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });

  const p1 = await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 5, toLocationId: locId(wh, "STOCK") } });
  expect(p1.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(3);   // 8 accepted - 5 put away
  expect(await bal(raw._id, wh._id, locId(wh, "STOCK"))).toBe(5);
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);     // unchanged

  const ctrl = await call(`${CTRL(grnId)}/control`, { token });
  expect(ctrl.body.lines[0].remainingToPutAway).toBe(3);

  const p2 = await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 3, toLocationId: locId(wh, "STOCK") } });
  expect(p2.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "STOCK"))).toBe(8);
  const done = await call(`${CTRL(grnId)}/control`, { token });
  // All ACCEPTED stock is now put away, but 2 remain quarantined awaiting a
  // decision — so the receipt is NOT complete and reads "Quarantine decision required".
  expect(done.body.flags.awaitingPutaway).toBe(false);
  expect(done.body.flags.complete).toBe(false);
  expect(done.body.stage).toBe("Quarantine decision required");
});

test("5 · over-put-away is refused with no write", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 4, quarantinedQuantity: 6, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  const over = await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 5, toLocationId: locId(wh, "STOCK") } });
  expect(over.status).toBe(400);
  expect(over.body.reason).toBe("OVER_PUTAWAY");
  expect(await GoodsReceiptPutaway.countDocuments({ goodsReceiptId: grnId })).toBe(0);
  expect(await bal(raw._id, wh._id, locId(wh, "STOCK"))).toBe(0);
});

test("6 · put-away refuses a non-usable / wrong-type destination", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  // Quarantine is not a usable-stock destination.
  const bad = await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 1, toLocationId: locId(wh, "QUAR") } });
  expect(bad.status).toBe(400);
  expect(bad.body.reason).toBe("INVALID_USABLE_LOCATION");
});

test("7 · put-away before inspection is refused", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  const early = await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 1, toLocationId: locId(wh, "STOCK") } });
  expect(early.status).toBe(400);
  expect(early.body.reason).toBe("NOT_INSPECTED");
});

test("8 · mixed units reconcile independently and are never summed", async () => {
  const co = await company(); const token = await actor(co);
  const wire = await rawItem({ unit: "m" }); const dye = await rawItem({ unit: "kg" });
  const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: wire._id, quantity: 100, unit: "m", itemName: "Wire" }, { rawItemId: dye._id, quantity: 10, unit: "kg", itemName: "Dye" }]);
  const res = await call(`/api/cms/purchase-orders/${po._id}/goods-receipts`, { method: "POST", token, key: key(), body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 100 }, { poItemId: String(po.items[1]._id), quantity: 10 }], warehouseId: String(wh._id), locationId: locId(wh, "RECV"),
  } });
  const grnId = res.body.goodsReceipt._id;
  const lines = res.body.goodsReceipt.lines;
  const ins = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [
    { goodsReceiptLineId: String(lines.find((l) => l.itemName === "Wire")._id), acceptedQuantity: 60, quarantinedQuantity: 40, rejectedQuantity: 0 },
    { goodsReceiptLineId: String(lines.find((l) => l.itemName === "Dye")._id), acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 },
  ], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  expect(ins.status).toBe(201);
  expect(await bal(wire._id, wh._id, locId(wh, "QUAR"))).toBe(40);  // metres only
  expect(await bal(dye._id, wh._id, locId(wh, "QUAR"))).toBe(0);    // kilograms untouched
  const ctrl = await call(`${CTRL(grnId)}/control`, { token });
  expect(ctrl.body.lines.map((l) => l.unit).sort()).toEqual(["kg", "m"]);
});

test("9 · a receipt with NO Receiving location is readable but cannot post inspection", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem();
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  // Receive WITHOUT a destination → GRN has no Receiving location.
  const res = await call(`/api/cms/purchase-orders/${po._id}/goods-receipts`, { method: "POST", token, key: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 10 }] } });
  expect(res.status).toBe(201);
  const grnId = res.body.goodsReceipt._id;
  const grnLineId = String(res.body.goodsReceipt.lines[0]._id);

  const ctrl = await call(`${CTRL(grnId)}/control`, { token });   // still readable
  expect(ctrl.status).toBe(200);
  expect(ctrl.body.actions.canInspect).toBe(false);
  expect(ctrl.body.blockers.some((b) => b.code === "NO_RECEIVING_LOCATION")).toBe(true);

  const ins = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }] } });
  expect(ins.status).toBe(400);
  expect(ins.body.reason).toBe("NO_RECEIVING_LOCATION");
});

test("10 · put-away replay with the same key creates no duplicate move", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });
  const k = key();
  const body = { method: "POST", token, key: k, body: { goodsReceiptLineId: grnLineId, quantity: 4, toLocationId: locId(wh, "STOCK") } };
  const a = await call(`${CTRL(grnId)}/putaways`, body);
  const b = await call(`${CTRL(grnId)}/putaways`, body);
  expect(a.status).toBe(201);
  expect(b.replayed).toBe(true);
  expect(await GoodsReceiptPutaway.countDocuments({ goodsReceiptId: grnId })).toBe(1);
  expect(await bal(raw._id, wh._id, locId(wh, "STOCK"))).toBe(4);   // moved once
});

test("11 · register filters by operational stage with per-line counts", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  // GRN-A: awaiting inspection. GRN-B: inspected with quarantine, awaiting put-away.
  const poA = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  await receive(co, token, wh, poA, 0, 10);
  const poB = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const b = await receive(co, token, wh, poB, 0, 10);
  await call(`${CTRL(b.grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: b.grnLineId, acceptedQuantity: 7, quarantinedQuantity: 3, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") } });

  const awaiting = await call(`/api/cms/store/goods-receipts?stage=awaiting_inspection`, { token });
  expect(awaiting.body.goodsReceipts.every((r) => r.flags.awaitingInspection)).toBe(true);
  const quar = await call(`/api/cms/store/goods-receipts?stage=quarantined`, { token });
  expect(quar.body.goodsReceipts.length).toBe(1);
  expect(quar.body.goodsReceipts[0].counts.linesNeedingQuarantineDecision).toBe(1);
  const putaway = await call(`/api/cms/store/goods-receipts?stage=awaiting_putaway`, { token });
  expect(putaway.body.goodsReceipts.length).toBe(1);
});

/* ═══ CORRECTION-PASS REGRESSIONS ═════════════════════════════════════════ */

const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");

// Inspect helper that always supplies the warehouse's destinations.
const inspectAllAccepted = (grnId, grnLineId, token, wh, qty = 10) =>
  call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: qty, quarantinedQuantity: 0, rejectedQuantity: 0 }] } });

test("12 · two concurrent put-aways against one accepted balance — exactly one wins when both cannot fit", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspectAllAccepted(grnId, grnLineId, token, wh, 10);   // accepted 10

  // Two DIFFERENT keys (not a replay), each for 6 — together 12 > 10.
  const body = () => ({ method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 6, toLocationId: locId(wh, "STOCK") } });
  const [a, b] = await Promise.all([call(`${CTRL(grnId)}/putaways`, body()), call(`${CTRL(grnId)}/putaways`, body())]);
  const statuses = [a.status, b.status].sort();
  expect(statuses).toEqual([201, 400]);                        // exactly one wins
  const loser = a.status === 400 ? a : b;
  expect(loser.body.error?.details?.reason || loser.body.reason).toBe("OVER_PUTAWAY");
  expect(await GoodsReceiptPutaway.countDocuments({ goodsReceiptId: grnId })).toBe(1);  // one record
  expect(await bal(raw._id, wh._id, locId(wh, "STOCK"))).toBe(6);                        // one move
});

test("13 · missing/invalid conversion evidence writes nothing", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem({ unit: "pcs" }); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  // Corrupt the stored conversion evidence: a differing unit with no factor.
  await GoodsReceipt.updateOne({ _id: grnId, "lines._id": grnLineId }, { $set: { "lines.$.baseUnit": "kg", "lines.$.conversionFactor": null } });
  const ins = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }] } });
  expect(ins.status).toBe(400);
  expect(ins.body.error?.details?.reason || ins.body.reason).toBe("UOM_CONVERSION_MISSING");
  expect(await GoodsReceiptInspection.countDocuments({ goodsReceiptId: grnId })).toBe(0);   // nothing written
});

test("14 · with multiple quarantine locations an explicit valid choice is required; wrong/foreign/inactive refused", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem();
  // Two active QUARANTINE locations — array order must not decide.
  const wh = await Warehouse.create({ companyId: co._id, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active", locations: [
    { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
    { code: "STOCK", name: "Usable", type: "USABLE_STOCK", status: "Active" },
    { code: "QUAR1", name: "Quarantine 1", type: "QUARANTINE", status: "Active" },
    { code: "QUAR2", name: "Quarantine 2", type: "QUARANTINE", status: "Active" },
    { code: "OLDQ", name: "Old quarantine", type: "QUARANTINE", status: "Archived" },
    { code: "RETN", name: "Returns", type: "RETURNS", status: "Active" },
  ] });
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  const ln = { goodsReceiptLineId: grnLineId, acceptedQuantity: 6, quarantinedQuantity: 4, rejectedQuantity: 0 };

  // Control API exposes BOTH active quarantine locations, not one guessed.
  const ctrl = await call(`${CTRL(grnId)}/control`, { token });
  expect(ctrl.body.quarantineLocations.map((l) => l.code).sort()).toEqual(["QUAR1", "QUAR2"]);

  // No choice → refused.
  expect((await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [ln] } })).body.reason).toBe("INVALID_QUARANTINE_LOCATION");
  // Wrong type (a usable location) → refused.
  expect((await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [ln], quarantineLocationId: locId(wh, "STOCK") } })).body.reason).toBe("INVALID_QUARANTINE_LOCATION");
  // Inactive quarantine → refused.
  expect((await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [ln], quarantineLocationId: locId(wh, "OLDQ") } })).body.reason).toBe("INVALID_QUARANTINE_LOCATION");
  // Foreign location id → refused.
  expect((await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [ln], quarantineLocationId: String(new mongoose.Types.ObjectId()) } })).body.reason).toBe("INVALID_QUARANTINE_LOCATION");
  expect(await GoodsReceiptInspection.countDocuments({ goodsReceiptId: grnId })).toBe(0);
  // An explicit valid choice (QUAR2, not the first) works and moves there.
  const ok = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: { lines: [ln], quarantineLocationId: locId(wh, "QUAR2") } });
  expect(ok.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR2"))).toBe(4);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR1"))).toBe(0);
});

test("15 · the register states its scope honestly when the scan cap truncates", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  for (let i = 0; i < 3; i++) { const po = await makePO(co, [{ rawItemId: raw._id, quantity: 5 }]); await receive(co, token, wh, po, 0, 5); }
  process.env.GR_REGISTER_SCAN_CAP = "2";
  try {
    const r = await call(`/api/cms/store/goods-receipts`, { token });
    expect(r.body.coverage.truncated).toBe(true);
    expect(r.body.coverage.scanCap).toBe(2);
    expect(r.body.coverage.storedMatchCount).toBe(3);
    expect(r.body.coverage.note).toMatch(/newest 2 matching receipts.*older matching receipts may exist/i);
    expect(r.body.pagination.scope).toBe("inspectedSet");
  } finally { delete process.env.GR_REGISTER_SCAN_CAP; }
});

test("16 · same-key + different payload is refused; same-key replay returns the same inspection", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  const k = key();
  const first = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: k, body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }] } });
  expect(first.status).toBe(201);
  // Same key, DIFFERENT payload → conflict.
  const conflict = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: k, body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 8, quarantinedQuantity: 2, rejectedQuantity: 0 }], quarantineLocationId: locId(wh, "QUAR") } });
  expect(conflict.status).toBe(409);
  // Same key, SAME payload → replay of the same inspection.
  const replay = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: k, body: { lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: 10, quarantinedQuantity: 0, rejectedQuantity: 0 }] } });
  expect(replay.replayed).toBe(true);
  expect(String(replay.body.inspection._id)).toBe(String(first.body.inspection._id));
  expect(await GoodsReceiptInspection.countDocuments({ goodsReceiptId: grnId })).toBe(1);
});
