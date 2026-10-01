// test/store-purchase/goods-receipt-exception.route.test.js
//
// GOODS RECEIPT — EXCEPTION RESOLUTION (V1) — the routes end to end.
// Quarantined stock is RELEASED (→ Receiving, becoming accepted put-away
// capacity) or REJECTED (→ Returns, becoming returnable); rejected stock is
// handed to the CANONICAL supplier-return operation (→ decreases the Returns
// location AND company-wide RawItem on-hand exactly once). Internal dispositions
// never change RawItem on-hand; nothing is ever totalled across units.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const GoodsReceiptDisposition = require("../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  app.use("/api/cms/store/goods-receipts", require("../../routes/CMS_Routes/StorePurchase/goodsReceipts"));
  app.use("/api/cms/inventory/operations/purchase-orders/:poId/returns", require("../../routes/CMS_Routes/Inventory/Operations/returnRequests"));
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
  }).then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b }; });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
async function actor(co) {
  const n = ++seq; const email = `ge${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "GE", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "GE" });
  return tokenFor({ id: String(employeeRef), email });
}
const rawItem = (over = {}) => { const n = ++seq; return RawItem.create({ name: over.name || `Item ${n}`, sku: over.sku || `RAW-${n}`, unit: over.unit || "pcs", quantity: 0, minStock: 0 }); };
const warehouse = (companyId, over = {}) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  locations: [
    { code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" },
    { code: "STOCK", name: "Usable", type: "USABLE_STOCK", status: "Active" },
    { code: "QUAR", name: "Quarantine", type: "QUARANTINE", status: "Active" },
    { code: "RETN", name: "Returns", type: "RETURNS", status: over.returnsStatus || "Active" },
  ],
});
const key = () => `ge-${++seq}-${Math.random().toString(36).slice(2)}`;
const locId = (wh, code) => String(wh.locations.find((l) => l.code === code)._id);
const bal = async (rawId, whId, locationId) => {
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
async function receive(co, token, wh, po, lineIdx = 0, qty = 10) {
  const res = await call(`/api/cms/purchase-orders/${po._id}/goods-receipts`, { method: "POST", token, key: key(), body: {
    items: [{ poItemId: String(po.items[lineIdx]._id), quantity: qty }], warehouseId: String(wh._id), locationId: locId(wh, "RECV"), invoiceNumber: "INV",
  } });
  expect(res.status).toBe(201);
  return { grnId: res.body.goodsReceipt._id, grnLineId: String(res.body.goodsReceipt.lines[0]._id), poItemId: String(po.items[lineIdx]._id) };
}
const CTRL = (grnId) => `/api/cms/store/goods-receipts/${grnId}`;
// Inspect a single-line receipt with a given split.
async function inspect(grnId, grnLineId, wh, token, { a, q, r }) {
  const res = await call(`${CTRL(grnId)}/inspection`, { method: "POST", token, key: key(), body: {
    lines: [{ goodsReceiptLineId: grnLineId, acceptedQuantity: a, quarantinedQuantity: q, rejectedQuantity: r }],
    quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN"),
  } });
  expect(res.status).toBe(201);
}
const disp = (grnId, grnLineId, wh, token, body, k) =>
  call(`${CTRL(grnId)}/dispositions`, { method: "POST", token, key: k || key(), body: { goodsReceiptLineId: grnLineId, ...body } });
const ret = (grnId, grnLineId, wh, token, body, k) =>
  call(`${CTRL(grnId)}/supplier-returns`, { method: "POST", token, key: k || key(), body: { goodsReceiptLineId: grnLineId, ...body } });

/* ── Release ────────────────────────────────────────────────────────────────── */

test("1 · release moves ONLY Quarantine → Receiving, adds put-away capacity, leaves RawItem on-hand", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(6);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR"))).toBe(4);

  // Partial release of 3.
  const d = await disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 3, reason: "usable after check", quarantineLocationId: locId(wh, "QUAR") });
  expect(d.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR"))).toBe(1);   // 4 − 3
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(9);   // 6 + 3 back to receiving
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(0);   // returns untouched
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);     // company on-hand UNCHANGED

  const c = await call(`${CTRL(grnId)}/control`, { token });
  const line = c.body.lines[0];
  expect(line.acceptedCapacity).toBe(9);            // 6 + 3 released
  expect(line.remainingToPutAway).toBe(9);          // capacity grew — released stock is put-awayable
  expect(line.unresolvedQuarantine).toBe(1);
  expect(c.body.stage).toBe("Quarantine decision required");

  // The released quantity can now be put away up to 9 (proves the capacity is real).
  const p = await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 9, toLocationId: locId(wh, "STOCK") } });
  expect(p.status).toBe(201);
});

test("2 · reject moves ONLY Quarantine → Returns, adds to the returnable pool, leaves RawItem on-hand", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });

  const d = await disp(grnId, grnLineId, wh, token, { dispositionType: "REJECT", quantity: 4, reason: "unusable", quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") });
  expect(d.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR"))).toBe(0);   // all quarantine gone
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(4);   // now in returns
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(6);   // receiving untouched
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);     // company on-hand UNCHANGED

  const c = await call(`${CTRL(grnId)}/control`, { token });
  expect(c.body.lines[0].rejectedAwaitingReturn).toBe(4);          // 0 inspection + 4 rejected
  expect(c.body.stage).toBe("Supplier return required");
});

test("3 · cumulative dispositions cannot exceed the quarantined quantity", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });
  const ok = await disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 3, reason: "ok", quarantineLocationId: locId(wh, "QUAR") });
  expect(ok.status).toBe(201);
  const over = await disp(grnId, grnLineId, wh, token, { dispositionType: "REJECT", quantity: 2, reason: "no", quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") });
  expect(over.status).toBe(400);
  expect(over.body.reason).toBe("OVER_DISPOSITION");
  const dispositions = await GoodsReceiptDisposition.find({ goodsReceiptId: grnId }).lean();
  expect(dispositions.length).toBe(1);   // only the winner
});

test("4 · two concurrent dispositions: only the valid winner resolves; loser writes nothing", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });

  const [d1, d2] = await Promise.all([
    disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 3, reason: "a", quarantineLocationId: locId(wh, "QUAR") }),
    disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 3, reason: "b", quarantineLocationId: locId(wh, "QUAR") }),
  ]);
  const statuses = [d1.status, d2.status].sort();
  expect(statuses).toEqual([201, 400]);
  const loser = d1.status === 400 ? d1 : d2;
  expect(loser.body.error?.details?.reason || loser.body.reason).toBe("OVER_DISPOSITION");
  const dispositions = await GoodsReceiptDisposition.find({ goodsReceiptId: grnId }).lean();
  expect(dispositions.length).toBe(1);
  expect(await bal(raw._id, wh._id, locId(wh, "QUAR"))).toBe(1);   // exactly one release of 3
});

test("5 · a disposition requires a reason and an explicit, correct-type location", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });

  const noReason = await disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 1, reason: "", quarantineLocationId: locId(wh, "QUAR") });
  expect(noReason.status).toBe(400); expect(noReason.body.reason).toBe("REASON_REQUIRED");
  const wrongSource = await disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 1, reason: "x", quarantineLocationId: locId(wh, "STOCK") });
  expect(wrongSource.status).toBe(400); expect(wrongSource.body.reason).toBe("INVALID_QUARANTINE_LOCATION");
  const wrongDest = await disp(grnId, grnLineId, wh, token, { dispositionType: "REJECT", quantity: 1, reason: "x", quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "STOCK") });
  expect(wrongDest.status).toBe(400); expect(wrongDest.body.reason).toBe("INVALID_RETURNS_LOCATION");
  // Nothing was written by any refusal.
  expect((await GoodsReceiptDisposition.find({ goodsReceiptId: grnId }).lean()).length).toBe(0);
});

test("6 · a disposition is idempotent: same key + payload replays, one movement pair", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });
  const k = key();
  const body = { dispositionType: "RELEASE", quantity: 3, reason: "ok", quarantineLocationId: locId(wh, "QUAR") };
  const first = await disp(grnId, grnLineId, wh, token, body, k);
  const replay = await disp(grnId, grnLineId, wh, token, body, k);
  expect(first.status).toBe(201);
  expect([200, 201]).toContain(replay.status);
  expect(String(replay.body.disposition._id)).toBe(String(first.body.disposition._id));
  expect((await GoodsReceiptDisposition.find({ goodsReceiptId: grnId }).lean()).length).toBe(1);
  // Two movement legs total (one transfer), not four.
  const moves = await LocationMovement.find({ "source.kind": "grn_disposition_release" }).lean();
  expect(moves.length).toBe(2);
  // Same key, DIFFERENT payload → refused.
  const conflict = await disp(grnId, grnLineId, wh, token, { ...body, quantity: 1 }, k);
  expect(conflict.status).toBe(409);
});

/* ── Supplier-return handoff ─────────────────────────────────────────────────── */

test("7 · supplier return decreases Returns AND company on-hand exactly once, with GRN provenance", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId, poItemId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 0, r: 4 });
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(4);   // rejected sits in returns
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);

  const r = await ret(grnId, grnLineId, wh, token, { quantity: 3, reason: "faulty", returnsLocationId: locId(wh, "RETN") });
  expect(r.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(1);   // 4 − 3 left in returns
  expect((await RawItem.findById(raw._id)).quantity).toBe(7);      // company on-hand −3 EXACTLY once

  // The return is the CANONICAL PO returnRequest, carrying GRN provenance.
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  const rr = (poDoc.returnRequests || []).find((x) => String(x._id) === String(r.body.returnRequest._id));
  expect(rr).toBeTruthy();
  expect(String(rr.goodsReceiptId)).toBe(String(grnId));
  expect(String(rr.goodsReceiptLineId)).toBe(String(grnLineId));
  expect(String(rr.poItemId)).toBe(String(poItemId));
  expect(rr.damagedQuantity).toBe(3);

  const c = await call(`${CTRL(grnId)}/control`, { token });
  expect(c.body.lines[0].rejectedAwaitingReturn).toBe(1);          // 4 − 3 returned
  expect(c.body.supplierReturns.length).toBe(1);
  expect(c.body.supplierReturns[0].href).toContain("/delivery/");
});

test("8 · a supplier return cannot exceed the rejected quantity awaiting return", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 7, q: 0, r: 3 });
  const over = await ret(grnId, grnLineId, wh, token, { quantity: 5, reason: "x", returnsLocationId: locId(wh, "RETN") });
  expect(over.status).toBe(400);
  expect(over.body.reason).toBe("OVER_SUPPLIER_RETURN");
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);     // nothing moved
});

test("8b · two concurrent supplier returns cannot together exceed the rejected quantity", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 0, r: 4 });
  // Two returns of 3 each read "4 awaiting" before either commits; only one fits.
  const [r1, r2] = await Promise.all([
    ret(grnId, grnLineId, wh, token, { quantity: 3, reason: "a", returnsLocationId: locId(wh, "RETN") }),
    ret(grnId, grnLineId, wh, token, { quantity: 3, reason: "b", returnsLocationId: locId(wh, "RETN") }),
  ]);
  expect([r1.status, r2.status].sort()).toEqual([201, 400]);
  const loser = r1.status === 400 ? r1 : r2;
  expect(loser.body.error?.details?.reason || loser.body.reason).toBe("OVER_SUPPLIER_RETURN");
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  expect((poDoc.returnRequests || []).length).toBe(1);            // only the winner
  expect((await RawItem.findById(raw._id)).quantity).toBe(7);     // exactly one −3
});

test("9 · rejected-out-of-quarantine feeds the returnable pool; a return then draws it down", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 4, q: 6, r: 0 });
  // Reject 6 out of quarantine → returnable pool becomes 6, all in Returns.
  const d = await disp(grnId, grnLineId, wh, token, { dispositionType: "REJECT", quantity: 6, reason: "no", quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") });
  expect(d.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(6);
  const r = await ret(grnId, grnLineId, wh, token, { quantity: 6, reason: "faulty", returnsLocationId: locId(wh, "RETN") });
  expect(r.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(0);
  expect((await RawItem.findById(raw._id)).quantity).toBe(4);      // 10 − 6 returned
  const c = await call(`${CTRL(grnId)}/control`, { token });
  expect(c.body.lines[0].rejectedAwaitingReturn).toBe(0);
});

test("10 · completion is false until quarantine, supplier return AND put-away are all resolved", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 2, r: 2 });

  // Resolve quarantine by releasing both, so capacity is 8; return the 2 rejected; put away 8.
  expect((await disp(grnId, grnLineId, wh, token, { dispositionType: "RELEASE", quantity: 2, reason: "ok", quarantineLocationId: locId(wh, "QUAR") })).status).toBe(201);
  let c = await call(`${CTRL(grnId)}/control`, { token });
  expect(c.body.flags.complete).toBe(false);                       // rejected still awaits return, put-away pending
  expect((await ret(grnId, grnLineId, wh, token, { quantity: 2, reason: "x", returnsLocationId: locId(wh, "RETN") })).status).toBe(201);
  c = await call(`${CTRL(grnId)}/control`, { token });
  expect(c.body.flags.complete).toBe(false);                       // put-away still pending
  expect((await call(`${CTRL(grnId)}/putaways`, { method: "POST", token, key: key(), body: { goodsReceiptLineId: grnLineId, quantity: 8, toLocationId: locId(wh, "STOCK") } })).status).toBe(201);
  c = await call(`${CTRL(grnId)}/control`, { token });
  expect(c.body.flags.complete).toBe(true);
  expect(c.body.stage).toBe("Complete");
});

test("11 · a cross-company receipt is a 404, never a foreign disposition", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 4, r: 0 });
  const other = await company(); const otherToken = await actor(other);
  const foreign = await disp(grnId, grnLineId, wh, otherToken, { dispositionType: "RELEASE", quantity: 1, reason: "x", quarantineLocationId: locId(wh, "QUAR") });
  expect(foreign.status).toBe(404);
});

/* ── Correction pass: business vs base units, provenance, allocations, reason ─── */

// A factor-10 setup: PO/GRN business unit is cartons, stock (RawItem) unit is
// pieces, 1 carton = 10 pieces. Receive converts to base on the way in.
async function convSetup(co, token, wh, cartons = 2) {
  const n = ++seq; const pc = `PC${n}`; const ctn = `CTN${n}`;
  const pieces = await Unit.create({ companyId: co._id, name: pc });
  await Unit.create({ companyId: co._id, name: ctn, conversions: [{ toUnit: pieces._id, quantity: 10 }] });
  const raw = await rawItem({ unit: pc });
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: cartons, unit: ctn }]);
  const g = await receive(co, token, wh, po, 0, cartons);
  return { raw, po, ctn, pc, ...g };
}

test("12 · converted-unit supplier return removes the BASE quantity from Returns + RawItem, records business qty", async () => {
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);
  const { raw, po, grnId, grnLineId, poItemId } = await convSetup(co, token, wh, 2);
  // Receive placed 20 pieces (base) in Receiving; RawItem holds 20.
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(20);
  expect((await RawItem.findById(raw._id)).quantity).toBe(20);

  // Reject 2 cartons at inspection → 20 pieces move to Returns; on-hand unchanged.
  await inspect(grnId, grnLineId, wh, token, { a: 0, q: 0, r: 2 });
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(20);
  expect((await RawItem.findById(raw._id)).quantity).toBe(20);

  // Return 2 cartons → removes 2 from the returnable pool but 20 pieces from stock.
  const r = await ret(grnId, grnLineId, wh, token, { quantity: 2, reason: "faulty", returnsLocationId: locId(wh, "RETN") });
  expect(r.status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(0);   // 20 − 20
  expect((await RawItem.findById(raw._id)).quantity).toBe(0);      // 20 − 20 EXACTLY once

  const poDoc = await PurchaseOrder.findById(po._id).lean();
  const rr = (poDoc.returnRequests || []).find((x) => String(x._id) === String(r.body.returnRequest._id));
  expect(rr.damagedQuantity).toBe(2);          // BUSINESS quantity (cartons)
  expect(rr.baseQuantity).toBe(20);            // frozen STOCK quantity (pieces)
  expect(rr.conversionFactor).toBe(10);
  expect(String(rr.poItemId)).toBe(String(poItemId));
  // Allocation: wholly from the inspection rejection.
  expect(rr.rejectionAllocations.length).toBe(1);
  expect(rr.rejectionAllocations[0].sourceType).toBe("INSPECTION_REJECTION");
  expect(rr.rejectionAllocations[0].quantity).toBe(2);
  expect(rr.rejectionAllocations[0].baseQuantity).toBe(20);

  // Replacement of 1 carton restores EXACTLY 10 pieces on the same basis.
  const rec = await call(`/api/cms/inventory/operations/purchase-orders/${po._id}/returns/${rr._id}/receive`, { method: "POST", token, key: key(), body: { quantityReceived: 1, warehouseId: String(wh._id), locationId: locId(wh, "STOCK") } });
  expect(rec.status).toBe(200);
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);     // 0 + 10 pieces
  expect(await bal(raw._id, wh._id, locId(wh, "STOCK"))).toBe(10);
  const after = await PurchaseOrder.findById(po._id).lean();
  const rr2 = after.returnRequests.find((x) => String(x._id) === String(rr._id));
  expect(rr2.returnedQuantity).toBe(1);        // business unit honestly (1 carton)
  expect(rr2.pendingReturnQty).toBe(1);
  expect(rr2.receipts[0].quantityReceived).toBe(1);
});

test("13 · a return spanning inspection rejection + reject dispositions records the true allocation", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  // 2 rejected at inspection, 8 quarantined.
  await inspect(grnId, grnLineId, wh, token, { a: 0, q: 8, r: 2 });
  // Two reject dispositions (2 then 2) → pool = 2 + 2 + 2 = 6.
  expect((await disp(grnId, grnLineId, wh, token, { dispositionType: "REJECT", quantity: 2, reason: "a", quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") })).status).toBe(201);
  expect((await disp(grnId, grnLineId, wh, token, { dispositionType: "REJECT", quantity: 2, reason: "b", quarantineLocationId: locId(wh, "QUAR"), returnsLocationId: locId(wh, "RETN") })).status).toBe(201);

  const r = await ret(grnId, grnLineId, wh, token, { quantity: 5, reason: "faulty", returnsLocationId: locId(wh, "RETN") });
  expect(r.status).toBe(201);
  const rr = r.body.returnRequest;
  const kinds = rr.rejectionAllocations.map((a) => [a.sourceType, a.quantity]);
  expect(kinds).toEqual([["INSPECTION_REJECTION", 2], ["QUARANTINE_DISPOSITION", 2], ["QUARANTINE_DISPOSITION", 1]]);
  expect(rr.rejectionAllocations.reduce((s, a) => s + a.quantity, 0)).toBe(5);
});

test("14 · replay returns the identical allocation; nothing is re-consumed", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 0, r: 4 });
  const k = key();
  const body = { quantity: 3, reason: "faulty", returnsLocationId: locId(wh, "RETN") };
  const first = await ret(grnId, grnLineId, wh, token, body, k);
  const replay = await ret(grnId, grnLineId, wh, token, body, k);
  expect(first.status).toBe(201);
  expect([200, 201]).toContain(replay.status);
  expect(String(replay.body.returnRequest._id)).toBe(String(first.body.returnRequest._id));
  expect(replay.body.returnRequest.rejectionAllocations).toEqual(first.body.returnRequest.rejectionAllocations);
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  expect((poDoc.returnRequests || []).length).toBe(1);   // no duplicate
});

test("15 · two concurrent returns allocate DISJOINT windows of the rejected pool", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 2, q: 0, r: 8 });
  const [a, b] = await Promise.all([
    ret(grnId, grnLineId, wh, token, { quantity: 4, reason: "a", returnsLocationId: locId(wh, "RETN") }),
    ret(grnId, grnLineId, wh, token, { quantity: 4, reason: "b", returnsLocationId: locId(wh, "RETN") }),
  ]);
  expect([a.status, b.status].sort()).toEqual([201, 201]);   // 4 + 4 ≤ 8, both fit
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  const grnReturns = poDoc.returnRequests.filter((x) => String(x.goodsReceiptId) === String(grnId));
  const allAlloc = grnReturns.flatMap((x) => x.rejectionAllocations);
  // Combined allocation is exactly the pool (8), all from the single inspection source, no overlap/double-count.
  expect(allAlloc.reduce((s, x) => s + x.quantity, 0)).toBe(8);
  expect((await RawItem.findById(raw._id)).quantity).toBe(2);   // 10 − 8 total, exactly once
});

test("16 · a blank or whitespace-only reason is refused with NO write", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
  await inspect(grnId, grnLineId, wh, token, { a: 6, q: 0, r: 4 });
  for (const reason of ["", "   "]) {
    const r = await ret(grnId, grnLineId, wh, token, { quantity: 2, reason, returnsLocationId: locId(wh, "RETN") });
    expect(r.status).toBe(400);
    expect(r.body.reason).toBe("REASON_REQUIRED");
  }
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  expect((poDoc.returnRequests || []).length).toBe(0);          // nothing reserved/written
  expect(await bal(raw._id, wh._id, locId(wh, "RETN"))).toBe(4);
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);
});

test("17 · a corrupted item/variant/PO-line identity is a provenance conflict with zero writes", async () => {
  const mk = async () => {
    const co = await company(); const token = await actor(co);
    const raw = await rawItem(); const wh = await warehouse(co._id);
    const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
    const { grnId, grnLineId } = await receive(co, token, wh, po, 0, 10);
    await inspect(grnId, grnLineId, wh, token, { a: 6, q: 0, r: 4 });
    return { co, token, raw, po, wh, grnId, grnLineId };
  };
  const assertRefused = async (s, detail) => {
    const r = await ret(s.grnId, s.grnLineId, s.wh, s.token, { quantity: 2, reason: "x", returnsLocationId: locId(s.wh, "RETN") });
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("PROVENANCE_CONFLICT");
    if (detail) expect(r.body.detail).toBe(detail);
    const poDoc = await PurchaseOrder.findById(s.po._id).lean();
    expect((poDoc.returnRequests || []).length).toBe(0);
    expect(await bal(s.raw._id, s.wh._id, locId(s.wh, "RETN"))).toBe(4);
    expect((await RawItem.findById(s.raw._id)).quantity).toBe(10);
  };

  // Corrupt the inspection line's RawItem id.
  const s1 = await mk();
  await GoodsReceiptInspection.updateOne({ goodsReceiptId: s1.grnId }, { $set: { "lines.0.rawItemId": new mongoose.Types.ObjectId() } });
  await assertRefused(s1, "RAW_ITEM_MISMATCH");

  // Corrupt the inspection line's variant id (null → non-null).
  const s2 = await mk();
  await GoodsReceiptInspection.updateOne({ goodsReceiptId: s2.grnId }, { $set: { "lines.0.variantId": new mongoose.Types.ObjectId() } });
  await assertRefused(s2, "VARIANT_MISMATCH");

  // Corrupt the inspection line's PO-line link to a non-existent PO line.
  const s3 = await mk();
  await GoodsReceiptInspection.updateOne({ goodsReceiptId: s3.grnId }, { $set: { "lines.0.poItemId": new mongoose.Types.ObjectId() } });
  await assertRefused(s3, "PO_LINE_MISSING");
});

/* ── Final unit-contract: ordinary PO returns + legacy replacements ──────────── */

// Raise an ordinary PO return (the canonical route the GRN handoff shares).
const ordReturn = (poId, token, body, k) =>
  call(`/api/cms/inventory/operations/purchase-orders/${poId}/returns`, { method: "POST", token, key: k || key(), body });
const ordReceive = (poId, returnId, token, body, k) =>
  call(`/api/cms/inventory/operations/purchase-orders/${poId}/returns/${returnId}/receive`, { method: "POST", token, key: k || key(), body });

test("18 · ordinary PO return of 2 cartons (factor 10) removes exactly 20 pieces; returnable falls by 2 cartons", async () => {
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);
  const { raw, po } = await convSetup(co, token, wh, 2);           // 2 cartons received → 20 pieces in RECV
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(20);
  expect((await RawItem.findById(raw._id)).quantity).toBe(20);
  const poItemId = String(po.items[0]._id);

  // Return 1 carton from Receiving → 10 pieces off RawItem + location; business qty 1.
  const r1 = await ordReturn(po._id, token, { poItemId, damagedQuantity: 1, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(r1.status).toBe(201);
  expect(r1.body.returnRequest.damagedQuantity).toBe(1);
  expect(r1.body.returnRequest.baseQuantity).toBe(10);
  expect(r1.body.returnRequest.baseUnit).toBe(raw.unit);
  expect(r1.body.returnRequest.conversionFactor).toBe(10);
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(10);  // 20 − 10
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);

  // Returnable is tracked in CARTONS: a second 1-carton return still fits (2 received − 1).
  // Were the cumulative counted in pieces (10 already), this would exceed received=2 and refuse.
  const r2 = await ordReturn(po._id, token, { poItemId, damagedQuantity: 1, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(r2.status).toBe(201);
  expect((await RawItem.findById(raw._id)).quantity).toBe(0);      // 10 − 10 → exactly 20 pieces total
  // The PO line records 2 cartons returned (business), not 20.
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  expect(poDoc.returnRequests.reduce((s, r) => s + r.damagedQuantity, 0)).toBe(2);
});

test("19 · ordinary return location sufficiency compares BASE quantity; insufficient refuses with no write", async () => {
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);
  const { raw, po } = await convSetup(co, token, wh, 2);           // 20 pieces in RECV
  const poItemId = String(po.items[0]._id);

  // Draw RECV down to 15 pieces by returning 0.5 cartons (5 pieces).
  expect((await ordReturn(po._id, token, { poItemId, damagedQuantity: 0.5, warehouseId: String(wh._id), locationId: locId(wh, "RECV") })).status).toBe(201);
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(15);

  // Now return 2 cartons: business 2 ≤ 15, but BASE 20 > 15 → must refuse on base.
  const r = await ordReturn(po._id, token, { poItemId, damagedQuantity: 2, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(r.status).toBe(409);
  expect(r.body.reason).toBe("INSUFFICIENT_AT_LOCATION");
  expect(r.body.message).toMatch(/requires 20 .* but only 15/);   // states BOTH representations
  // Nothing further written; RECV and RawItem unchanged by the refused attempt.
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  expect((poDoc.returnRequests || []).length).toBe(1);            // only the 0.5-carton return
  expect(await bal(raw._id, wh._id, locId(wh, "RECV"))).toBe(15);
  expect((await RawItem.findById(raw._id)).quantity).toBe(15);
});

test("20 · ordinary return with a missing conversion refuses before any write", async () => {
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);
  const { raw, po, ctn } = await convSetup(co, token, wh, 2);
  const poItemId = String(po.items[0]._id);
  // Remove the carton→pieces conversion AFTER receiving, so the return cannot convert.
  await Unit.updateOne({ companyId: co._id, name: ctn }, { $set: { conversions: [] } });

  const r = await ordReturn(po._id, token, { poItemId, damagedQuantity: 2, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.body.error?.details?.reason || r.body.reason).toBe("UOM_CONVERSION_MISSING");
  const poDoc = await PurchaseOrder.findById(po._id).lean();
  expect((poDoc.returnRequests || []).length).toBe(0);
  expect((await RawItem.findById(raw._id)).quantity).toBe(20);    // nothing moved
});

test("21 · a same-unit ordinary return uses factor 1 explicitly", async () => {
  const co = await company(); const token = await actor(co);
  const raw = await rawItem(); const wh = await warehouse(co._id);     // unit pcs == base pcs
  const po = await makePO(co, [{ rawItemId: raw._id, quantity: 10 }]);
  await receive(co, token, wh, po, 0, 10);
  const r = await ordReturn(po._id, token, { poItemId: String(po.items[0]._id), damagedQuantity: 3, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(r.status).toBe(201);
  expect(r.body.returnRequest.conversionFactor).toBe(1);
  expect(r.body.returnRequest.baseQuantity).toBe(3);
  expect((await RawItem.findById(raw._id)).quantity).toBe(7);
});

test("22 · a partial replacement receipt freezes BOTH representations; replay repeats neither", async () => {
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);
  const { raw, po } = await convSetup(co, token, wh, 2);
  const poItemId = String(po.items[0]._id);
  const rr = await ordReturn(po._id, token, { poItemId, damagedQuantity: 2, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(rr.status).toBe(201);
  expect((await RawItem.findById(raw._id)).quantity).toBe(0);     // 20 − 20 out

  const k = key();
  const body = { quantityReceived: 1, warehouseId: String(wh._id), locationId: locId(wh, "STOCK") };
  const rec = await ordReceive(po._id, rr.body.returnRequest._id, token, body, k);
  expect(rec.status).toBe(200);
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);    // +10 pieces for 1 carton
  let poDoc = await PurchaseOrder.findById(po._id).lean();
  let receipt = poDoc.returnRequests[0].receipts[0];
  expect(receipt.quantityReceived).toBe(1);                       // business (carton)
  expect(receipt.unit).toBe(poDoc.returnRequests[0].unit);
  expect(receipt.baseQuantityReceived).toBe(10);                  // stock (pieces)
  expect(receipt.baseUnit).toBe(raw.unit);
  expect(receipt.conversionFactor).toBe(10);

  // Replay: neither the stock nor a second receipt.
  const replay = await ordReceive(po._id, rr.body.returnRequest._id, token, body, k);
  expect(replay.status).toBe(200);
  expect((await RawItem.findById(raw._id)).quantity).toBe(10);    // unchanged
  poDoc = await PurchaseOrder.findById(po._id).lean();
  expect(poDoc.returnRequests[0].receipts.length).toBe(1);        // no duplicate receipt
});

test("23 · legacy same-unit return remains receivable; legacy differing-unit return is blocked, not guessed", async () => {
  // Legacy = a stored return with NO frozen conversion evidence.
  const co = await company(); const token = await actor(co);
  const wh = await warehouse(co._id);

  // (a) same-unit legacy: unit pcs, RawItem base pcs → factor 1, receivable.
  const rawA = await rawItem(); const poA = await makePO(co, [{ rawItemId: rawA._id, quantity: 10 }]);
  await receive(co, token, wh, poA, 0, 10);
  const rA = await ordReturn(poA._id, token, { poItemId: String(poA.items[0]._id), damagedQuantity: 4, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(rA.status).toBe(201);
  // Strip the frozen evidence to simulate a pre-conversion legacy record.
  await PurchaseOrder.updateOne({ _id: poA._id, "returnRequests._id": rA.body.returnRequest._id }, { $set: { "returnRequests.$.baseUnit": "", "returnRequests.$.baseQuantity": 0, "returnRequests.$.conversionFactor": 1 } });
  const recA = await ordReceive(poA._id, rA.body.returnRequest._id, token, { quantityReceived: 2, warehouseId: String(wh._id), locationId: locId(wh, "STOCK") });
  expect(recA.status).toBe(200);
  expect((await RawItem.findById(rawA._id)).quantity).toBe(8);    // 10 − 4 + 2, factor 1

  // (b) differing-unit legacy: a converted return with its frozen evidence removed.
  const { raw: rawB, po: poB } = await convSetup(co, token, wh, 2);
  const rB = await ordReturn(poB._id, token, { poItemId: String(poB.items[0]._id), damagedQuantity: 2, warehouseId: String(wh._id), locationId: locId(wh, "RECV") });
  expect(rB.status).toBe(201);
  await PurchaseOrder.updateOne({ _id: poB._id, "returnRequests._id": rB.body.returnRequest._id }, { $unset: { "returnRequests.$.baseUnit": "", "returnRequests.$.baseQuantity": "", "returnRequests.$.conversionFactor": "" } });
  const before = (await RawItem.findById(rawB._id)).quantity;
  const recB = await ordReceive(poB._id, rB.body.returnRequest._id, token, { quantityReceived: 1, warehouseId: String(wh._id), locationId: locId(wh, "STOCK") });
  expect(recB.status).toBeGreaterThanOrEqual(400);
  expect(recB.body.error?.details?.reason || recB.body.reason).toBe("LEGACY_CONVERSION_REQUIRED");
  expect((await RawItem.findById(rawB._id)).quantity).toBe(before);   // nothing guessed/credited
});
