// test/store-purchase/goods-receipt.route.test.js
//
// GOODS RECEIPT V1 — authoritative, line-level receiving. Proves one atomic
// call records a numbered GRN, moves stock through the established RawItem +
// location authority, updates PO line state, is idempotent on retry, refuses
// invalid conversions and over-receipt before any write, keeps two lines of the
// same RawItem separate by poItemId, and feeds Purchase Reconciliation without
// double-counting. It never calls a quantity "accepted".
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
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
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
const call = (path, { method = "GET", body, token, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => { const t = await r.text(); let b = null; try { b = JSON.parse(t || "null"); } catch { b = t; } return { status: r.status, body: b, replayed: r.headers.get("Idempotency-Replayed") === "true" }; });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
async function actor(co) {
  const n = ++seq; const email = `gr${n}@x.example`; const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", name: "GR", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "GR" });
  return tokenFor({ id: String(employeeRef), email });
}
const rawItem = (over = {}) => { const n = ++seq; return RawItem.create({ name: over.name || `Item ${n}`, sku: over.sku || `RAW-${n}`, unit: over.unit || "pcs", quantity: over.quantity || 0, minStock: 0, ...(over.extra || {}) }); };
const warehouse = (companyId) => Warehouse.create({
  companyId, name: `WH ${++seq}`, shortName: `W${seq}`, status: "Active",
  locations: [{ code: "RECV", name: "Receiving", type: "RECEIVING", status: "Active" }],
});
const key = () => `grn-${++seq}-${Math.random().toString(36).slice(2)}`;

// A PurchaseOrder created directly in an ISSUED state (avoids the issue-flow
// ceremony), with line _ids we control so tests can address poItemId.
async function makePO(co, lines, over = {}) {
  const items = lines.map((l) => ({
    _id: l.poItemId || new mongoose.Types.ObjectId(),
    rawItem: l.rawItemId, spendLineId: l.spendLineId || null, itemName: l.itemName || "Item", sku: l.sku || "SKU",
    unit: l.unit || "pcs", quantity: l.quantity, unitPrice: l.unitPrice || 10, totalPrice: l.quantity * (l.unitPrice || 10),
    receivedQuantity: l.receivedQuantity || 0, pendingQuantity: l.quantity - (l.receivedQuantity || 0), status: l.status || "PENDING",
    ...(l.variantId ? { variantId: l.variantId } : {}),
  }));
  return PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${++seq}`, status: over.status || "ISSUED", createdBy: new mongoose.Types.ObjectId(),
    vendorName: over.vendorName || "Acme", vendor: over.vendorId || new mongoose.Types.ObjectId(),
    subtotal: 0, taxAmount: 0, totalAmount: 0, items,
    totalReceived: over.totalReceived || 0, totalPending: items.reduce((s, i) => s + i.pendingQuantity, 0),
    ...(over.deliveries ? { deliveries: over.deliveries } : {}),
  });
}
const grnUrl = (poId) => `/api/cms/purchase-orders/${poId}/goods-receipts`;

test("1 · a multi-line partial receipt records a GRN and advances PO line state", async () => {
  const co = await company(); const token = await actor(co);
  const [r1, r2] = [await rawItem(), await rawItem()];
  const po = await makePO(co, [
    { rawItemId: r1._id, poItemId: new mongoose.Types.ObjectId(), quantity: 10, itemName: "Bolt" },
    { rawItemId: r2._id, poItemId: new mongoose.Types.ObjectId(), quantity: 20, itemName: "Nut" },
  ]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 4 }, { poItemId: String(po.items[1]._id), quantity: 5 }],
    invoiceNumber: "INV-1",
  } });
  expect(res.status).toBe(201);
  const grn = res.body.goodsReceipt;
  expect(grn.receiptNumber).toMatch(/^GRN\//);
  expect(grn.lines).toHaveLength(2);
  const l0 = grn.lines.find((x) => x.itemName === "Bolt");
  expect(l0.receivedQuantity).toBe(4);
  expect(l0.quantityOrdered).toBe(10);
  expect(l0.previouslyReceived).toBe(0);
  expect(l0.receivedAfter).toBe(4);
  expect(l0.pendingAfter).toBe(6);
  const after = await PurchaseOrder.findById(po._id).lean();
  expect(after.items[0].receivedQuantity).toBe(4);
  expect(after.items[0].status).toBe("PARTIALLY_RECEIVED");
  expect(after.status).toBe("PARTIALLY_RECEIVED");
  expect((await RawItem.findById(r1._id)).quantity).toBe(4);
});

test("2 · two receipts against one PO line accumulate; each is its own GRN", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const pid = String(po.items[0]._id);
  const a = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: pid, quantity: 4 }] } });
  const b = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: pid, quantity: 3 }] } });
  expect(a.status).toBe(201); expect(b.status).toBe(201);
  expect(a.body.goodsReceipt.receiptNumber).not.toBe(b.body.goodsReceipt.receiptNumber);
  expect(b.body.goodsReceipt.lines[0].previouslyReceived).toBe(4);
  expect(b.body.goodsReceipt.lines[0].receivedAfter).toBe(7);
  expect((await RawItem.findById(r1._id)).quantity).toBe(7);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(2);
});

test("3 · two PO lines for the SAME RawItem stay separate by poItemId; stock is the sum", async () => {
  const co = await company(); const token = await actor(co);
  const shared = await rawItem({ name: "Fabric" });
  const po = await makePO(co, [
    { rawItemId: shared._id, quantity: 100, itemName: "Fabric A" },
    { rawItemId: shared._id, quantity: 40, itemName: "Fabric B" },
  ]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 100 }, { poItemId: String(po.items[1]._id), quantity: 40 }],
  } });
  expect(res.status).toBe(201);
  const byLine = Object.fromEntries(res.body.goodsReceipt.lines.map((l) => [l.poItemId, l.receivedQuantity]));
  expect(byLine[String(po.items[0]._id)]).toBe(100);
  expect(byLine[String(po.items[1]._id)]).toBe(40);
  expect((await RawItem.findById(shared._id)).quantity).toBe(140);   // accumulated, not clobbered
});

test("4 · a variant line preserves variant identity on the GRN and in stock", async () => {
  const co = await company(); const token = await actor(co);
  const variantId = new mongoose.Types.ObjectId();
  const r1 = await rawItem({ name: "Tee", extra: { variants: [{ _id: variantId, combination: ["Red", "M"], quantity: 0, sku: "TEE-R-M" }] } });
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Tee", variantId }]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 6, variantId: String(variantId) }] } });
  expect(res.status).toBe(201);
  expect(String(res.body.goodsReceipt.lines[0].variantId)).toBe(String(variantId));
  const raw = await RawItem.findById(r1._id);
  expect(raw.variants.id(variantId).quantity).toBe(6);
});

test("5 · an invalid unit conversion refuses BEFORE any write", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem({ unit: "pcs" });
  // PO line unit "box" with no configured box→pcs conversion.
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, unit: "box", itemName: "Boxed" }]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 2 }] } });
  expect(res.status).toBe(400);
  expect(res.body.error?.details?.reason || res.body.reason).toBe("UOM_CONVERSION_MISSING");
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(0);
  expect((await RawItem.findById(r1._id)).quantity).toBe(0);   // nothing moved
});

test("6 · a disallowed over-receipt refuses BEFORE any write (V1 policy)", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 11 }] } });
  expect(res.status).toBe(400);
  expect(res.body.error?.details?.reason || res.body.reason).toBe("OVER_RECEIPT");
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(0);
  expect((await RawItem.findById(r1._id)).quantity).toBe(0);
});

test("7 & 8 · an idempotent retry returns the SAME GRN and never doubles stock", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  const body = { method: "POST", token, idempotencyKey: k, body: { items: [{ poItemId: String(po.items[0]._id), quantity: 5 }] } };
  const first = await call(grnUrl(po._id), body);
  const retry = await call(grnUrl(po._id), body);
  expect(first.status).toBe(201);
  expect(retry.body.goodsReceipt.receiptNumber).toBe(first.body.goodsReceipt.receiptNumber);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);
  expect((await RawItem.findById(r1._id)).quantity).toBe(5);   // added once, not twice
  expect((await PurchaseOrder.findById(po._id)).items[0].receivedQuantity).toBe(5);
});

test("9 · PO, RawItem, StockLedger and location movement all reconcile", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const wh = await warehouse(co._id);
  const loc = wh.locations[0];
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 8 }], warehouseId: String(wh._id), locationId: String(loc._id), invoiceNumber: "INV-9",
  } });
  expect(res.status).toBe(201);
  const line = res.body.goodsReceipt.lines[0];
  // PO received == GRN line qty
  expect((await PurchaseOrder.findById(po._id)).items[0].receivedQuantity).toBe(8);
  // RawItem quantity == base qty; a stock ledger transaction exists and is linked
  const raw = await RawItem.findById(r1._id);
  expect(raw.quantity).toBe(8);
  expect(String(raw.stockTransactions[0]._id)).toBe(String(line.stockLedgerRef.transactionId));
  // A location movement exists and is linked
  expect(line.locationMovementId).toBeTruthy();
  const mv = await LocationMovement.findById(line.locationMovementId).lean();
  expect(mv).toBeTruthy();
  expect(mv.quantity).toBe(8);
  // GRN header carries the destination snapshot
  expect(res.body.goodsReceipt.warehouseName).toBe(wh.name);
});

test("11 & 12 · reconciliation uses GRN lines (not double-counted) and keeps legacy deliveries readable", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  // A PO that already carries a LEGACY order-level delivery (no goodsReceiptId).
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }], {
    deliveries: [{ deliveryDate: new Date("2026-01-01"), quantityReceived: 2, invoiceNumber: "OLD", notes: "legacy" }],
    totalReceived: 2,
  });
  // Its line already shows 2 received from the legacy era.
  await PurchaseOrder.updateOne({ _id: po._id, "items._id": po.items[0]._id }, { $set: { "items.$.receivedQuantity": 2, "items.$.pendingQuantity": 8 } });
  // Now record an authoritative GRN for 5 more.
  await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 5 }] } });

  const rec = (await call(`/api/cms/purchase-orders/${po._id}/reconciliation`, { token })).body.reconciliation;
  const line = rec.lines[0];
  // Authoritative per-line evidence is the GRN line (5), NOT stored(7) + GRN(5).
  expect(line.receivedSource).toBe("goods_receipt");
  expect(line.receivedQty).toBe(5);
  expect(line.grnNumbers.length).toBe(1);
  expect(rec.goodsReceiptNumbers.length).toBe(1);
  // The legacy order-level delivery stays readable, flagged as legacy, not itemised.
  const legacy = rec.receipts.find((x) => x.isLegacy);
  expect(legacy).toBeTruthy();
  expect(legacy.invoiceNumber).toBe("OLD");
  // The GRN-backed delivery is a compatibility summary, not legacy.
  expect(rec.receipts.some((x) => !x.isLegacy && x.goodsReceiptNumber)).toBe(true);
  expect(rec.limitations.some((l) => /legacy receipt records/i.test(l))).toBe(true);
});

test("13-adjacent · unknown, cancelled and foreign lines refuse", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [
    { rawItemId: r1._id, quantity: 10, itemName: "Bolt" },
    { rawItemId: r1._id, quantity: 5, itemName: "Cancelled", status: "CANCELLED" },
  ]);
  // Unknown line id
  expect((await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(new mongoose.Types.ObjectId()), quantity: 1 }] } })).status).toBe(400);
  // Cancelled line
  const canc = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[1]._id), quantity: 1 }] } });
  expect(canc.status).toBe(400);
  expect(canc.body.error?.details?.reason || canc.body.reason).toBe("CANCELLED_LINE");
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(0);
});

test("14 · nothing in the receipt claims 'accepted' or 'inspection passed'", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 5 }] } });
  const blob = JSON.stringify(res.body).toLowerCase();
  expect(blob).not.toMatch(/accepted|inspection passed|inspected|quality passed/);
  expect(res.body.goodsReceipt.status).toBe("RECORDED");
  // The register/detail views also avoid the word.
  const reg = await call(`/api/cms/store/goods-receipts`, { token });
  expect(JSON.stringify(reg.body).toLowerCase()).not.toMatch(/accepted|inspection passed/);
});

test("register + detail expose the new documents company-scoped", async () => {
  const co = await company(); const other = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const created = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(po.items[0]._id), quantity: 5 }], invoiceNumber: "INV-R" } });
  const grnId = created.body.goodsReceipt._id;
  // A GRN in ANOTHER company must not appear.
  const pOther = await makePO(other, [{ rawItemId: r1._id, quantity: 5, itemName: "X" }]);
  const tOther = await actor(other);
  await call(grnUrl(pOther._id), { method: "POST", token: tOther, idempotencyKey: key(), body: { items: [{ poItemId: String(pOther.items[0]._id), quantity: 1 }] } });

  const reg = await call(`/api/cms/store/goods-receipts`, { token });
  expect(reg.status).toBe(200);
  expect(reg.body.goodsReceipts.every((g) => g.poNumber === po.poNumber)).toBe(true);
  expect(reg.body.goodsReceipts[0].lineCount).toBe(1);
  expect(reg.body.goodsReceipts[0].invoiceNumber).toBe("INV-R");

  const detail = await call(`/api/cms/store/goods-receipts/${grnId}`, { token });
  expect(detail.status).toBe(200);
  expect(detail.body.goodsReceipt.lines[0].receivedQuantity).toBe(5);
  // Foreign detail is a 404 under this company.
  const foreignDetail = await call(`/api/cms/store/goods-receipts/${grnId}`, { token: tOther });
  expect(foreignDetail.status).toBe(404);
});

/* ═══ AUTHORITY CORRECTION — one implementation behind both URLs ═══════════ */

const receiveUrl = (poId) => `/api/cms/purchase-orders/${poId}/receive`;
const fs = require("fs");
const path = require("path");

test("C1 · legacy /receive now creates a numbered GoodsReceipt (delegates to the service)", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const res = await call(receiveUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: {
    items: [{ itemId: String(po.items[0]._id), quantity: 4 }], invoiceNumber: "INV-L", deliveryDate: "2026-05-02",
  } });
  expect(res.status).toBe(200);                         // legacy status preserved
  expect(res.body.goodsReceipt.receiptNumber).toMatch(/^GRN\//);  // authoritative GRN returned
  expect(res.body.goodsReceipt._id).toBeTruthy();
  expect(res.body.purchaseOrder).toBeTruthy();          // legacy envelope preserved
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);
  expect((await RawItem.findById(r1._id)).quantity).toBe(4);
});

test("C2 · both endpoints apply the SAME over-receipt refusal and the SAME missing-conversion refusal", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem({ unit: "pcs" });
  const poA = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const poB = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  // Over-receipt: refused identically.
  const overCanon = await call(grnUrl(poA._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(poA.items[0]._id), quantity: 11 }] } });
  const overLegacy = await call(receiveUrl(poB._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ itemId: String(poB.items[0]._id), quantity: 11 }] } });
  expect(overCanon.status).toBe(400);
  expect(overLegacy.status).toBe(400);
  expect(overCanon.body.error?.details?.reason || overCanon.body.reason).toBe("OVER_RECEIPT");
  expect(overLegacy.body.error?.details?.reason || overLegacy.body.reason).toBe("OVER_RECEIPT");
  // Missing conversion: refused identically (no box→pcs path).
  const poC = await makePO(co, [{ rawItemId: r1._id, quantity: 10, unit: "box", itemName: "Boxed" }]);
  const poD = await makePO(co, [{ rawItemId: r1._id, quantity: 10, unit: "box", itemName: "Boxed" }]);
  const convCanon = await call(grnUrl(poC._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ poItemId: String(poC.items[0]._id), quantity: 2 }] } });
  const convLegacy = await call(receiveUrl(poD._id), { method: "POST", token, idempotencyKey: key(), body: { items: [{ itemId: String(poD.items[0]._id), quantity: 2 }] } });
  expect(convCanon.status).toBe(400);
  expect(convLegacy.status).toBe(400);
  expect(convCanon.body.error?.details?.reason || convCanon.body.reason).toBe("UOM_CONVERSION_MISSING");
  expect(convLegacy.body.error?.details?.reason || convLegacy.body.reason).toBe("UOM_CONVERSION_MISSING");
  // The legacy route booked nothing (no silent surplus, no stock).
  expect(await GoodsReceipt.countDocuments({ companyId: co._id })).toBe(0);
});

test("C3 · retry through the SAME legacy endpoint creates no duplicate", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  const body = { method: "POST", token, idempotencyKey: k, body: { items: [{ itemId: String(po.items[0]._id), quantity: 5 }] } };
  const a = await call(receiveUrl(po._id), body);
  const b = await call(receiveUrl(po._id), body);
  expect(a.status).toBe(200);
  expect(b.body.goodsReceipt.receiptNumber).toBe(a.body.goodsReceipt.receiptNumber);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);
  expect((await RawItem.findById(r1._id)).quantity).toBe(5);
});

test("C4 · retry through the OTHER endpoint with the SAME key records ONE GRN and ONE stock effect", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  const payload = { items: [{ poItemId: String(po.items[0]._id), quantity: 6 }] };  // same body both ways
  const canon = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: k, body: payload });
  const legacy = await call(receiveUrl(po._id), { method: "POST", token, idempotencyKey: k, body: payload });
  expect(canon.status).toBe(201);
  // The cross-endpoint retry is a replay of the SAME physical receipt.
  expect(legacy.body.goodsReceipt.receiptNumber).toBe(canon.body.goodsReceipt.receiptNumber);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);   // one GRN
  expect((await RawItem.findById(r1._id)).quantity).toBe(6);                        // one stock increase
});

test("C5 · a mixed-unit GRN exposes quantities per line with their units, and no receipt-level summed quantity", async () => {
  const co = await company(); const token = await actor(co);
  const wire = await rawItem({ name: "Wire", unit: "m" });
  const dye = await rawItem({ name: "Dye", unit: "kg" });
  const po = await makePO(co, [
    { rawItemId: wire._id, quantity: 100, unit: "m", itemName: "Wire" },
    { rawItemId: dye._id, quantity: 10, unit: "kg", itemName: "Dye" },
  ]);
  const res = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: key(), body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 50 }, { poItemId: String(po.items[1]._id), quantity: 4 }],
  } });
  expect(res.status).toBe(201);
  const grn = res.body.goodsReceipt;
  // Per-line quantities carry their own units…
  const byItem = Object.fromEntries(grn.lines.map((l) => [l.itemName, l]));
  expect(byItem.Wire.receivedQuantity).toBe(50); expect(byItem.Wire.poUnit).toBe("m");
  expect(byItem.Dye.receivedQuantity).toBe(4); expect(byItem.Dye.poUnit).toBe("kg");
  // …and there is NO receipt-level summed quantity anywhere on the GRN.
  for (const k of ["totalQuantity", "totalReceived", "quantityReceived", "receiptQuantity"]) {
    expect(k in grn).toBe(false);
  }
});

test("C6 · the route file no longer contains an independent RawItem receipt mutation loop", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../routes/CMS_Routes/Inventory/Operations/purchaseOrders.js"), "utf8");
  expect(src).not.toMatch(/applyReceiptLineToDoc/);      // the old inline engine is gone
  expect(src).not.toMatch(/stockTransactions\.unshift/); // no inline ledger write
  expect(src).not.toMatch(/locStock\.applyLocationIn/);  // no inline location write
  expect(src).not.toMatch(/async function convertQuantity/); // no inline conversion
  // Both receiving routes delegate to the single orchestrator.
  expect((src.match(/handleGoodsReceipt\(req, res/g) || []).length).toBeGreaterThanOrEqual(2);
});

/* ═══ IDEMPOTENCY CORRECTION — PO-bound target + legacy alias canonicalisation ═ */

test("D1 · a key reused with the same body against ANOTHER PO refuses — never replays the first PO", async () => {
  const co = await company(); const token = await actor(co);
  const rA = await rawItem(); const rB = await rawItem();
  const poA = await makePO(co, [{ rawItemId: rA._id, quantity: 10, itemName: "Bolt" }]);
  const poB = await makePO(co, [{ rawItemId: rB._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  // Record against PO-A.
  const first = await call(grnUrl(poA._id), { method: "POST", token, idempotencyKey: k, body: { items: [{ poItemId: String(poA.items[0]._id), quantity: 4 }] } });
  expect(first.status).toBe(201);
  // The SAME key + SAME body (PO-A's line) sent against PO-B: the fingerprint is
  // now bound to the PO, so this is key reuse — refused, not a replay of PO-A.
  const cross = await call(grnUrl(poB._id), { method: "POST", token, idempotencyKey: k, body: { items: [{ poItemId: String(poA.items[0]._id), quantity: 4 }] } });
  expect(cross.status).toBe(409);
  expect(cross.replayed).toBe(false);
  // PO-B, its stock and its GRN count are untouched.
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: poB._id })).toBe(0);
  expect((await RawItem.findById(rB._id)).quantity).toBe(0);
  expect((await PurchaseOrder.findById(poB._id)).items[0].receivedQuantity).toBe(0);
  // PO-A recorded exactly one receipt.
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: poA._id })).toBe(1);
});

const deliveryRefs = async (poId) =>
  ((await PurchaseOrder.findById(poId).lean()).deliveries || []).filter((d) => d.goodsReceiptId).length;

test("D2a · canonical first, then a LEGACY-alias retry with the same key replays (no 409)", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const wh = await warehouse(co._id); const loc = wh.locations[0];
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  const canon = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 6 }], warehouseId: String(wh._id), locationId: String(loc._id), receiptDate: "2026-05-02",
  } });
  expect(canon.status).toBe(201);
  // A REAL legacy retry: itemId + deliveryDate, quantity as a numeric string.
  const legacy = await call(receiveUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ itemId: String(po.items[0]._id), quantity: "6" }], warehouseId: String(wh._id), locationId: String(loc._id), deliveryDate: "2026-05-02",
  } });
  expect(legacy.status).not.toBe(409);
  expect(legacy.replayed).toBe(true);
  expect(String(legacy.body.goodsReceipt._id)).toBe(String(canon.body.goodsReceipt._id));
  expect(legacy.body.goodsReceipt.receiptNumber).toBe(canon.body.goodsReceipt.receiptNumber);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);   // one GRN
  expect(await deliveryRefs(po._id)).toBe(1);                                        // one PO delivery ref
  expect((await RawItem.findById(r1._id)).quantity).toBe(6);                         // stock once
  expect(await LocationMovement.countDocuments({ itemId: r1._id, type: "receipt" })).toBe(1); // location once
});

test("D2b · legacy first, then a CANONICAL retry with the same key replays (no 409)", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const wh = await warehouse(co._id); const loc = wh.locations[0];
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  const legacy = await call(receiveUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ itemId: String(po.items[0]._id), quantity: 6 }], warehouseId: String(wh._id), locationId: String(loc._id), deliveryDate: "2026-05-02",
  } });
  expect(legacy.status).toBe(200);
  const canon = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 6 }], warehouseId: String(wh._id), locationId: String(loc._id), receiptDate: "2026-05-02",
  } });
  expect(canon.status).not.toBe(409);
  expect(canon.replayed).toBe(true);
  expect(String(canon.body.goodsReceipt._id)).toBe(String(legacy.body.goodsReceipt._id));
  expect(canon.body.goodsReceipt.receiptNumber).toBe(legacy.body.goodsReceipt.receiptNumber);
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);
  expect(await deliveryRefs(po._id)).toBe(1);
  expect((await RawItem.findById(r1._id)).quantity).toBe(6);
  expect(await LocationMovement.countDocuments({ itemId: r1._id, type: "receipt" })).toBe(1);
});

test("D3 · changing a real business field under the same key is still refused (normalisation does not weaken conflict detection)", async () => {
  const co = await company(); const token = await actor(co);
  const r1 = await rawItem();
  const wh = await warehouse(co._id); const loc = wh.locations[0];
  const po = await makePO(co, [{ rawItemId: r1._id, quantity: 10, itemName: "Bolt" }]);
  const k = key();
  const first = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 5 }], warehouseId: String(wh._id), locationId: String(loc._id), invoiceNumber: "INV-1",
  } });
  expect(first.status).toBe(201);
  // Same key, changed QUANTITY → refused.
  const diffQty = await call(receiveUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ itemId: String(po.items[0]._id), quantity: 6 }], warehouseId: String(wh._id), locationId: String(loc._id), invoiceNumber: "INV-1",
  } });
  expect(diffQty.status).toBe(409);
  // Same key, changed INVOICE → refused.
  const diffInv = await call(grnUrl(po._id), { method: "POST", token, idempotencyKey: k, body: {
    items: [{ poItemId: String(po.items[0]._id), quantity: 5 }], warehouseId: String(wh._id), locationId: String(loc._id), invoiceNumber: "INV-CHANGED",
  } });
  expect(diffInv.status).toBe(409);
  // Nothing doubled.
  expect(await GoodsReceipt.countDocuments({ purchaseOrderId: po._id })).toBe(1);
  expect((await RawItem.findById(r1._id)).quantity).toBe(5);
});
