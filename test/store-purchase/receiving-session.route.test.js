// test/store-purchase/receiving-session.route.test.js
//
// COUNT AND LABEL — AT THE WIRE.
//
// What is held here is the thing the whole design exists for: a label printed
// while the goods are still being counted is a real identity, it is NOT stock
// until the receipt is recorded, and the number on the receipt is the number on
// the stickers or there is no receipt.
//
// Specifically:
//   · a count opens once per line, and a second opener RESUMES the same one;
//   · identities are reserved with real sequence numbers, bounded by what the
//     line still owes, and a retried reservation replays rather than minting;
//   · applying a label is what increments the count, once, whatever the client
//     does — and a package carries the quantity that was measured in it;
//   · a scan of another delivery's label is a blocking mismatch;
//   · voiding keeps the identity in the record with its reason, and a
//     replacement is linked to what it replaced;
//   · finalising activates ONLY the applied labels, voids the rest, and is
//     refused when the count and the receipt disagree;
//   · cancelling voids everything and leaves no live identity behind.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const GoodsReceiptSession = require("../../models/CMS_Models/StorePurchase/GoodsReceiptSession");
const storeLocations = require("../../services/storePurchase/storeLocations.service");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/purchase-orders", require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  /* The unique partial indexes ARE the concurrency guarantee, and they are
     built by a migration rather than lazily (see the model comments). The
     in-memory database starts empty, so the suite builds them itself — the
     duplicate-key cases below are testing the index, not the service. */
  await GoodsReceiptSession.collection.createIndex(
    { companyId: 1, poItemId: 1 }, { unique: true, partialFilterExpression: { status: "OPEN" } },
  );
  await Barcode.collection.createIndex(
    { companyId: 1, receivingSessionId: 1, sessionSequence: 1 },
    { unique: true, partialFilterExpression: { receivingSessionId: { $type: "objectId" } } },
  );
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const t = await r.text();
    let b = null;
    try { b = JSON.parse(t || "null"); } catch { b = t; }
    return { status: r.status, body: b, replayed: r.headers.get("Idempotency-Replayed") === "true" };
  });

const company = () => Acc_Company.create({ companyName: `Co ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(co, { role = "approver" } = {}) {
  const n = ++seq;
  const email = `rs${n}@x.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role, name: "RS", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef, personName: "RS" });
  return jwt.sign(
    { id: String(employeeRef), role: "store_manager", employeeId: `ST${n}`, name: "RS", email },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );
}

const rawItem = (co, over = {}) => {
  const n = ++seq;
  return RawItem.create({
    companyId: co._id, name: over.name || `Item ${n}`, sku: over.sku || `RAW-${n}`,
    unit: over.unit || "m", quantity: 0, minStock: 0, ...over,
  });
};

async function makePO(co, lines) {
  const items = lines.map((l) => ({
    _id: new mongoose.Types.ObjectId(),
    rawItem: l.rawItemId, itemName: l.itemName || "Item", sku: l.sku || "SKU",
    unit: l.unit || "m", quantity: l.quantity, unitPrice: l.unitPrice || 10,
    totalPrice: l.quantity * (l.unitPrice || 10),
    receivedQuantity: l.receivedQuantity || 0,
    pendingQuantity: l.quantity - (l.receivedQuantity || 0),
    status: "PENDING",
  }));
  return PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${++seq}`, status: "ISSUED",
    createdBy: new mongoose.Types.ObjectId(),
    vendorName: "Acme", vendor: new mongoose.Types.ObjectId(),
    subtotal: 0, taxAmount: 0, totalAmount: 0, items,
    totalReceived: 0, totalPending: items.reduce((s, i) => s + i.pendingQuantity, 0),
  });
}

const key = () => `rs-${++seq}-${Math.random().toString(36).slice(2)}`;
const U = (po) => `/api/cms/purchase-orders/${po._id}`;

/** Open a count, set its tracking level, and hand back the session id. */
async function openCount(po, token, { level = "PACKAGE", lineIndex = 0 } = {}) {
  const open = await call(`${U(po)}/lines/${po.items[lineIndex]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "COUNT_AND_LABEL", trackingLevel: level },
  });
  expect([200, 201]).toContain(open.status);
  return open.body.session.id;
}

const reserve = (po, token, sid, body) =>
  call(`${U(po)}/receiving-sessions/${sid}/labels`, { method: "POST", token, idempotencyKey: key(), body });

const apply = (po, token, sid, barcodeId, quantity) =>
  call(`${U(po)}/receiving-sessions/${sid}/labels/${barcodeId}/apply`, { method: "POST", token, body: { quantity } });

/* ══════════════════════════════════════════════════════════════════════════
 * OPENING
 * ═════════════════════════════════════════════════════════════════════════ */

test("1 · a count opens once per line; a second opener resumes the same one", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100, itemName: "Poplin" }]);

  const first = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "COUNT_AND_LABEL", trackingLevel: "PACKAGE" },
  });
  expect(first.status).toBe(201);
  expect(first.body.resumed).toBe(false);
  expect(first.body.session.status).toBe("OPEN");
  expect(first.body.outstanding).toBe(100);

  /* A colleague on another terminal presses the same button. */
  const second = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "COUNT_AND_LABEL", trackingLevel: "PACKAGE" },
  });
  expect(second.status).toBe(200);
  expect(second.body.resumed).toBe(true);
  expect(second.body.session.id).toBe(first.body.session.id);
  expect(await GoodsReceiptSession.countDocuments({ purchaseOrderId: po._id })).toBe(1);
});

test("2 · two simultaneous openers still produce one count, and one counter", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 50 }]);
  const url = `${U(po)}/lines/${po.items[0]._id}/receiving-session`;
  const body = { receivingMode: "COUNT_AND_LABEL", trackingLevel: "PACKAGE" };

  const [a, b, c] = await Promise.all([
    call(url, { method: "POST", token, body }),
    call(url, { method: "POST", token, body }),
    call(url, { method: "POST", token, body }),
  ]);
  for (const r of [a, b, c]) expect([200, 201]).toContain(r.status);
  const ids = new Set([a, b, c].map((r) => r.body.session.id));
  expect(ids.size).toBe(1);
  expect(await GoodsReceiptSession.countDocuments({ purchaseOrderId: po._id, status: "OPEN" })).toBe(1);
});

test("3 · a line with no material link cannot be counted — a label would name nothing", async () => {
  const co = await company();
  const token = await actor(co);
  const po = await PurchaseOrder.create({
    companyId: co._id, poNumber: `PO/${++seq}`, status: "ISSUED",
    createdBy: new mongoose.Types.ObjectId(), vendorName: "Acme", vendor: new mongoose.Types.ObjectId(),
    subtotal: 0, taxAmount: 0, totalAmount: 0, totalReceived: 0, totalPending: 10,
    items: [{ _id: new mongoose.Types.ObjectId(), itemName: "Legacy", sku: "L", unit: "m", quantity: 10, unitPrice: 1, totalPrice: 10, receivedQuantity: 0, pendingQuantity: 10, status: "PENDING" }],
  });
  const r = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "COUNT_AND_LABEL", trackingLevel: "PACKAGE" },
  });
  expect(r.status).toBe(400);
  expect(r.body.error.details.reason).toBe("MATERIAL_NOT_LINKED");
});

/* ══════════════════════════════════════════════════════════════════════════
 * RESERVING IDENTITIES
 * ═════════════════════════════════════════════════════════════════════════ */

test("4 · reserved identities are real, numbered, and not stock", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100, itemName: "Poplin" }]);
  const sid = await openCount(po, token);

  const r = await reserve(po, token, sid, { count: 3, quantityPerLabel: 20 });
  expect(r.status).toBe(201);
  expect(r.body.labels).toHaveLength(3);
  expect(r.body.sequenceFrom).toBe(1);
  expect(r.body.sequenceTo).toBe(3);
  expect(r.body.labels.map((l) => l.sessionSequence)).toEqual([1, 2, 3]);
  for (const l of r.body.labels) {
    expect(l.identityState).toBe("RESERVED");
    expect(l.quantity).toBe(20);
    expect(l.unit).toBe("m");
  }
  /* They exist in the register, carry the count, and NOTHING is active. */
  const rows = await Barcode.find({ receivingSessionId: sid }).lean();
  expect(rows).toHaveLength(3);
  expect(rows.every((b) => b.identityState === "RESERVED")).toBe(true);
  expect(await Barcode.countDocuments({ receivingSessionId: sid, identityState: "ACTIVATED" })).toBe(0);
  /* And no stock moved. */
  expect((await RawItem.findById(item._id)).quantity).toBe(0);

  /* A second batch continues the sequence rather than restarting it. */
  const r2 = await reserve(po, token, sid, { count: 2, quantityPerLabel: 20 });
  expect(r2.body.labels.map((l) => l.sessionSequence)).toEqual([4, 5]);
});

test("5 · a retried reservation replays; it never mints a second set for one roll", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const k = key();
  const url = `${U(po)}/receiving-sessions/${sid}/labels`;

  const a = await call(url, { method: "POST", token, idempotencyKey: k, body: { count: 2, quantityPerLabel: 10 } });
  const b = await call(url, { method: "POST", token, idempotencyKey: k, body: { count: 2, quantityPerLabel: 10 } });
  expect(a.status).toBe(201);
  expect(b.status).toBe(201);
  expect(b.body.labels.map((l) => l.id)).toEqual(a.body.labels.map((l) => l.id));
  expect(await Barcode.countDocuments({ receivingSessionId: sid })).toBe(2);
});

test("6 · a batch may not exceed what the line still owes", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);

  const over = await reserve(po, token, sid, { count: 6, quantityPerLabel: 20 });
  expect(over.status).toBe(400);
  expect(over.body.error.details.reason).toBe("BATCH_OVER_OUTSTANDING");
  expect(over.body.message).toMatch(/over-receipt approval/i);
  expect(await Barcode.countDocuments({ receivingSessionId: sid })).toBe(0);

  /* Reserved-but-unapplied labels consume the headroom: reserving the line
     twice over is the failure this prevents. */
  const ok = await reserve(po, token, sid, { count: 5, quantityPerLabel: 20 });
  expect(ok.status).toBe(201);
  const again = await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 });
  expect(again.status).toBe(400);
});

test("7 · one label per piece for individual tracking; one label only for a lot", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co, { unit: "pcs" });
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 12, unit: "pcs" }, { rawItemId: item._id, quantity: 12, unit: "pcs" }]);

  const ind = await openCount(po, token, { level: "INDIVIDUAL", lineIndex: 0 });
  const r = await reserve(po, token, ind, { count: 3, quantityPerLabel: 50 });
  expect(r.status).toBe(201);
  /* The 50 is ignored: one label is one piece, and never editable. */
  expect(r.body.labels.every((l) => l.quantity === 1)).toBe(true);
  expect(r.body.labels.every((l) => l.quantityMeasured === true)).toBe(true);

  const lot = await openCount(po, token, { level: "LOT", lineIndex: 1 });
  expect((await reserve(po, token, lot, { count: 1, quantityPerLabel: 12 })).status).toBe(201);
  const second = await reserve(po, token, lot, { count: 1, quantityPerLabel: 1 });
  expect(second.status).toBe(400);
  expect(second.body.error.details.reason).toBe("LOT_IS_ONE_LABEL");
});

test("8 · nothing may be reserved before the tracking level is chosen", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 20 }]);
  const open = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "COUNT_AND_LABEL" },
  });
  expect(open.body.session.trackingLevel).toBeNull();

  const r = await reserve(po, token, open.body.session.id, { count: 1, quantityPerLabel: 5 });
  expect(r.status).toBe(400);
  expect(r.body.error.details.reason).toBe("TRACKING_LEVEL_REQUIRED");

  const set = await call(`${U(po)}/receiving-sessions/${open.body.session.id}/tracking`, {
    method: "PATCH", token, body: { trackingLevel: "PACKAGE" },
  });
  expect(set.status).toBe(200);
  expect(set.body.session.trackingLevel).toBe("PACKAGE");
  expect((await reserve(po, token, open.body.session.id, { count: 1, quantityPerLabel: 5 })).status).toBe(201);
});

/* ══════════════════════════════════════════════════════════════════════════
 * COUNTING
 * ═════════════════════════════════════════════════════════════════════════ */

test("9 · applying a label is what counts, and each package carries what was measured in it", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100, itemName: "Poplin" }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 2, quantityPerLabel: 40 });
  const [a, b] = r.body.labels;

  /* Two rolls off one pallet are not the same length. */
  const one = await apply(po, token, sid, a.id, 42.5);
  expect(one.status).toBe(200);
  expect(one.body.label.identityState).toBe("APPLIED");
  expect(one.body.label.quantity).toBe(42.5);
  expect(one.body.totals.counted).toBe(42.5);
  expect(one.body.totals.applied).toBe(1);

  const two = await apply(po, token, sid, b.id, 39.8);
  expect(two.body.totals.counted).toBe(82.3);
  expect(two.body.totals.applied).toBe(2);
  expect(two.body.totals.unresolved).toBe(0);
});

test("10 · a package confirmed with no measurement is refused; a piece needs none", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }, { rawItemId: item._id, quantity: 5, unit: "pcs" }]);

  const pkg = await openCount(po, token, { level: "PACKAGE", lineIndex: 0 });
  const pr = await reserve(po, token, pkg, { count: 1, quantityPerLabel: 20 });
  const none = await apply(po, token, pkg, pr.body.labels[0].id, null);
  expect(none.status).toBe(400);
  expect(none.body.error.details.reason).toBe("MEASURED_QUANTITY_REQUIRED");

  const ind = await openCount(po, token, { level: "INDIVIDUAL", lineIndex: 1 });
  const ir = await reserve(po, token, ind, { count: 1 });
  const piece = await apply(po, token, ind, ir.body.labels[0].id, null);
  expect(piece.status).toBe(200);
  expect(piece.body.label.quantity).toBe(1);
});

test("11 · one label counts once, however many times it is confirmed", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 });
  const id = r.body.labels[0].id;

  expect((await apply(po, token, sid, id, 20)).status).toBe(200);
  const again = await apply(po, token, sid, id, 20);
  expect(again.status).toBe(409);
  expect(again.body.error.details.reason).toBe("LABEL_ALREADY_COUNTED");

  /* Two simultaneous confirmations of one label — a double scan — settle once. */
  const r2 = await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 });
  const id2 = r2.body.labels[0].id;
  const [p, q] = await Promise.all([apply(po, token, sid, id2, 20), apply(po, token, sid, id2, 20)]);
  expect([p.status, q.status].sort()).toEqual([200, 409]);
  const counted = await Barcode.find({ receivingSessionId: sid, identityState: "APPLIED" }).lean();
  expect(counted).toHaveLength(2);
});

test("12 · a scan of another delivery's label is a blocking mismatch, not a near miss", async () => {
  const co = await company();
  const token = await actor(co);
  const [i1, i2] = [await rawItem(co, { name: "Poplin" }), await rawItem(co, { name: "Twill" })];
  const po = await makePO(co, [{ rawItemId: i1._id, quantity: 50, itemName: "Poplin" }, { rawItemId: i2._id, quantity: 50, itemName: "Twill" }]);
  const s1 = await openCount(po, token, { lineIndex: 0 });
  const s2 = await openCount(po, token, { lineIndex: 1 });
  const mine = (await reserve(po, token, s1, { count: 1, quantityPerLabel: 10 })).body.labels[0];
  const theirs = (await reserve(po, token, s2, { count: 1, quantityPerLabel: 10 })).body.labels[0];

  const scan = await call(`${U(po)}/receiving-sessions/${s1}/scan`, { method: "POST", token, body: { barcodeId: theirs.id } });
  expect(scan.status).toBe(200);
  expect(scan.body.outcome).toBe("OTHER_SESSION");
  expect(scan.body.itemName).toBe("Twill");

  /* And confirming it outright is refused, not silently counted. */
  const wrong = await apply(po, token, s1, theirs.id, 10);
  expect(wrong.status).toBe(409);
  expect(wrong.body.error.details.reason).toBe("LABEL_FROM_ANOTHER_SESSION");

  const ok = await call(`${U(po)}/receiving-sessions/${s1}/scan`, { method: "POST", token, body: { barcodeId: mine.id } });
  expect(ok.body.outcome).toBe("APPLY");
  await apply(po, token, s1, mine.id, 10);
  const twice = await call(`${U(po)}/receiving-sessions/${s1}/scan`, { method: "POST", token, body: { barcodeId: mine.id } });
  expect(twice.body.outcome).toBe("ALREADY");
});

test("13 · undo takes the last confirmation back without destroying the identity", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 2, quantityPerLabel: 20 });
  await apply(po, token, sid, r.body.labels[0].id, 20);
  await apply(po, token, sid, r.body.labels[1].id, 21);

  const undo = await call(`${U(po)}/receiving-sessions/${sid}/undo`, { method: "POST", token });
  expect(undo.status).toBe(200);
  expect(undo.body.label.identityState).toBe("PRINTED");
  expect(undo.body.totals.counted).toBe(20);
  expect(undo.body.totals.unresolved).toBe(1);
  expect(await Barcode.countDocuments({ receivingSessionId: sid })).toBe(2);
});

/* ══════════════════════════════════════════════════════════════════════════
 * VOIDING AND REPLACING
 * ═════════════════════════════════════════════════════════════════════════ */

test("14 · a voided label keeps its place in the record, with a reason, and is never reused", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 });
  const id = r.body.labels[0].id;

  const noReason = await call(`${U(po)}/receiving-sessions/${sid}/labels/${id}/void`, { method: "POST", token, body: {} });
  expect(noReason.status).toBe(400);

  const voided = await call(`${U(po)}/receiving-sessions/${sid}/labels/${id}/void`, {
    method: "POST", token, body: { reason: "Damaged in the printer", replace: true },
  });
  expect(voided.status).toBe(200);
  expect(voided.body.label.identityState).toBe("VOIDED");
  expect(voided.body.label.voidReason).toBe("Damaged in the printer");
  /* The replacement is a NEW identity, linked both ways — not a second sticker
     for the same roll under the same code. */
  expect(voided.body.replacement.id).not.toBe(id);
  expect(voided.body.replacement.sessionSequence).toBe(2);
  expect(voided.body.replacement.replacesBarcodeId).toBe(id);
  const back = await Barcode.findById(id).lean();
  expect(String(back.replacedByBarcodeId)).toBe(voided.body.replacement.id);
  /* The voided one is still there — the gap in the sequence has an explanation. */
  expect(await Barcode.countDocuments({ receivingSessionId: sid })).toBe(2);

  const counted = await apply(po, token, sid, id, 20);
  expect(counted.status).toBe(409);
  expect(counted.body.error.details.reason).toBe("LABEL_VOIDED");
});

test("15 · cancelling voids every identity the count reserved, applied ones included", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 3, quantityPerLabel: 20 });
  await apply(po, token, sid, r.body.labels[0].id, 20);

  const cancelled = await call(`${U(po)}/receiving-sessions/${sid}/cancel`, {
    method: "POST", token, body: { reason: "Lorry sent back" },
  });
  expect(cancelled.status).toBe(200);
  expect(cancelled.body.session.status).toBe("CANCELLED");
  const rows = await Barcode.find({ receivingSessionId: sid }).lean();
  expect(rows).toHaveLength(3);
  expect(rows.every((b) => b.identityState === "VOIDED")).toBe(true);
  /* Nothing live is left behind, and the line can be counted again. */
  expect(await Barcode.countDocuments({ receivingSessionId: sid, identityState: "ACTIVATED" })).toBe(0);
  const reopened = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "COUNT_AND_LABEL", trackingLevel: "PACKAGE" },
  });
  expect(reopened.status).toBe(201);
});

/* ══════════════════════════════════════════════════════════════════════════
 * FINALISING
 * ═════════════════════════════════════════════════════════════════════════ */

const grnUrl = (po) => `${U(po)}/goods-receipts`;

test("16 · finalising activates the applied labels, voids the rest, and moves the stock once", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100, itemName: "Poplin" }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 3, quantityPerLabel: 20 });
  await apply(po, token, sid, r.body.labels[0].id, 42.5);
  await apply(po, token, sid, r.body.labels[1].id, 39.8);
  /* The third was reserved for a roll that never came off the lorry. */

  const grn = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 82.3 }] },
  });
  expect(grn.status).toBe(201);
  expect(grn.body.goodsReceipt.lines[0].receivedQuantity).toBe(82.3);

  const rows = await Barcode.find({ receivingSessionId: sid }).sort({ sessionSequence: 1 }).lean();
  expect(rows.map((b) => b.identityState)).toEqual(["ACTIVATED", "ACTIVATED", "VOIDED"]);
  /* An activated label names the receipt that made it real. */
  expect(rows[0].goodsReceiptNumber).toBe(grn.body.goodsReceipt.receiptNumber);
  expect(rows[0].activatedAt).toBeTruthy();
  expect(rows[2].voidReason).toMatch(/never applied/i);

  const session = await GoodsReceiptSession.findById(sid).lean();
  expect(session.status).toBe("FINALIZED");
  expect(session.goodsReceiptNumber).toBe(grn.body.goodsReceipt.receiptNumber);
  /* The stock moved exactly once, for exactly what the labels hold. */
  expect((await RawItem.findById(item._id)).quantity).toBe(82.3);
});

test("17 · a receipt whose quantity is not the labels' quantity is refused, and nothing is written", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 2, quantityPerLabel: 20 });
  await apply(po, token, sid, r.body.labels[0].id, 20);
  await apply(po, token, sid, r.body.labels[1].id, 20);

  const wrong = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 60 }] },
  });
  expect(wrong.status).toBe(400);
  expect(wrong.body.error.details.reason).toBe("COUNT_NOT_SETTLED");
  expect(wrong.body.error.details.blockers.map((b) => b.code)).toContain("QUANTITY_MISMATCH");
  /* Nothing moved, and the count is still open so it can be finished. */
  expect((await RawItem.findById(item._id)).quantity).toBe(0);
  expect((await GoodsReceiptSession.findById(sid)).status).toBe("OPEN");
  expect(await Barcode.countDocuments({ receivingSessionId: sid, identityState: "ACTIVATED" })).toBe(0);

  const right = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 40 }] },
  });
  expect(right.status).toBe(201);
});

test("18 · an unsettled printed label blocks the receipt until it is confirmed or voided", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 2, quantityPerLabel: 20 });
  await apply(po, token, sid, r.body.labels[0].id, 20);
  await call(`${U(po)}/receiving-sessions/${sid}/labels/printed`, {
    method: "POST", token, body: { barcodeIds: [r.body.labels[1].id] },
  });

  const blocked = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 20 }] },
  });
  expect(blocked.status).toBe(400);
  expect(blocked.body.error.details.blockers.map((b) => b.code)).toContain("UNRESOLVED_LABELS");

  await call(`${U(po)}/receiving-sessions/${sid}/labels/${r.body.labels[1].id}/void`, {
    method: "POST", token, body: { reason: "Not needed — fewer rolls than expected" },
  });
  const ok = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 20 }] },
  });
  expect(ok.status).toBe(201);
});

test("19 · a line with no count is received exactly as it always was", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 30, itemName: "Bulk" }]);

  const grn = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 12 }] },
  });
  expect(grn.status).toBe(201);
  expect(grn.body.goodsReceipt.lines[0].receivedQuantity).toBe(12);
  expect((await RawItem.findById(item._id)).quantity).toBe(12);
});

test("20 · a TOTAL_ONLY line records a quantity and refuses to print labels", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 30 }]);
  const open = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token, body: { receivingMode: "TOTAL_ONLY" },
  });
  expect(open.status).toBe(201);

  const r = await reserve(po, token, open.body.session.id, { count: 1, quantityPerLabel: 5 });
  expect(r.status).toBe(400);
  expect(r.body.error.details.reason).toBe("MODE_IS_TOTAL_ONLY");

  const grn = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 30 }] },
  });
  expect(grn.status).toBe(201);
  expect((await GoodsReceiptSession.findById(open.body.session.id)).status).toBe("FINALIZED");
});

test("21 · an activated label is live stock and can no longer be voided here", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const r = await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 });
  await apply(po, token, sid, r.body.labels[0].id, 20);
  await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 20 }] },
  });

  /* The count is closed, so the whole workspace refuses — which is the honest
     answer: correcting live stock is a stock adjustment, not a void. */
  const v = await call(`${U(po)}/receiving-sessions/${sid}/labels/${r.body.labels[0].id}/void`, {
    method: "POST", token, body: { reason: "Changed my mind" },
  });
  expect(v.status).toBe(409);
  expect((await Barcode.findById(r.body.labels[0].id)).identityState).toBe("ACTIVATED");
});

test("22 · counting is receiving work: a viewer may read an order but not count it", async () => {
  const co = await company();
  const viewer = await actor(co, { role: "viewer" });
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 10 }]);

  const read = await call(`${U(po)}/receiving-sessions`, { token: viewer });
  expect(read.status).toBe(200);
  const open = await call(`${U(po)}/lines/${po.items[0]._id}/receiving-session`, {
    method: "POST", token: viewer, body: { receivingMode: "COUNT_AND_LABEL", trackingLevel: "PACKAGE" },
  });
  expect(open.status).toBe(403);
});

test("23 · one company's count is invisible and unusable to another", async () => {
  const [a, b] = [await company(), await company()];
  const tokenA = await actor(a);
  const tokenB = await actor(b);
  const item = await rawItem(a);
  const po = await makePO(a, [{ rawItemId: item._id, quantity: 50 }]);
  const sid = await openCount(po, tokenA);
  const label = (await reserve(po, tokenA, sid, { count: 1, quantityPerLabel: 10 })).body.labels[0];

  const seen = await call(`${U(po)}/receiving-sessions`, { token: tokenB });
  expect(seen.status).toBe(404);
  const stolen = await apply(po, tokenB, sid, label.id, 10);
  expect([403, 404]).toContain(stolen.status);
  expect((await Barcode.findById(label.id)).identityState).toBe("RESERVED");
});


/* ══════════════════════════════════════════════════════════════════════════
 * A RESERVED LABEL IS NOT STOCK — THE GATE EVERY OTHER SCREEN READS THROUGH
 * ═════════════════════════════════════════════════════════════════════════
 * The whole design rests on this. Between the printer and the recorded receipt
 * the collection holds real, scannable identities for material the company has
 * not received. If the stock readers treat those as stock, the feature has
 * invented inventory.
 */

const scopeOf = (co) => ({ $or: [{ companyId: co._id }, { companyId: null }, { companyId: { $exists: false } }] });

test("24 · a label from an unfinished count cannot be put on a shelf, and says why", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const label = (await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 })).body.labels[0];

  /* The chokepoint every stock-moving path goes through — put, transfer,
     remove, the scan resolve and the marking read all resolve here first. */
  await expect(storeLocations.resolveStock(scopeOf(co), { barcodeId: label.id }))
    .rejects.toMatchObject({ details: { reason: "LABEL_NOT_RECEIVED" } });

  /* Applied but not yet received is refused for the same reason, in its own
     words: the count is done, the receipt is not. */
  await apply(po, token, sid, label.id, 20);
  await expect(storeLocations.resolveStock(scopeOf(co), { barcodeId: label.id }))
    .rejects.toMatchObject({ details: { reason: "LABEL_NOT_RECEIVED" } });

  /* Recording the receipt is what makes it stock — and then it resolves. */
  const grn = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 20 }] },
  });
  expect(grn.status).toBe(201);
  const resolved = await storeLocations.resolveStock(scopeOf(co), { barcodeId: label.id });
  expect(String(resolved.barcode._id)).toBe(label.id);
  expect(resolved.barcode.identityState).toBe("ACTIVATED");
});

test("25 · a voided label is refused with its reason, and never becomes stock", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100 }]);
  const sid = await openCount(po, token);
  const label = (await reserve(po, token, sid, { count: 1, quantityPerLabel: 20 })).body.labels[0];
  await call(`${U(po)}/receiving-sessions/${sid}/labels/${label.id}/void`, {
    method: "POST", token, body: { reason: "Damaged in the printer" },
  });
  await expect(storeLocations.resolveStock(scopeOf(co), { barcodeId: label.id }))
    .rejects.toMatchObject({ details: { reason: "LABEL_VOIDED" } });
});

test("26 · every label printed before this field existed is still stock", async () => {
  const co = await company();
  const item = await rawItem(co);
  /* Written the way the label register has always written one, with no
     identityState at all — which is what every existing row looks like, and
     what `.lean()` reads back, since a schema default is not applied to a
     lean read. */
  const legacy = await Barcode.collection.insertOne({
    companyId: co._id, rawItem: item._id, rawItemName: "Legacy", rawItemSku: "L-1",
    variantCombination: [], quantity: 15, unit: "m", createdAt: new Date(), updatedAt: new Date(),
  });
  const resolved = await storeLocations.resolveStock(scopeOf(co), { barcodeId: String(legacy.insertedId) });
  expect(String(resolved.barcode._id)).toBe(String(legacy.insertedId));
  expect(resolved.barcode.identityState).toBeUndefined();
});

test("27 · the locator and the put-away queue ignore a count in progress", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co, { name: "Countme Poplin", sku: "CNT-1" });
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 100, itemName: "Countme Poplin" }]);
  const sid = await openCount(po, token);
  const labels = (await reserve(po, token, sid, { count: 2, quantityPerLabel: 20 })).body.labels;
  await apply(po, token, sid, labels[0].id, 20);

  const app2 = express();
  app2.use(express.json());
  app2.use("/api/cms/inventory/store-locations", require("../../routes/CMS_Routes/Inventory/Operations/storeLocationRoutes"));
  const srv = await new Promise((r) => { const s2 = app2.listen(0, () => r(s2)); });
  const locBase = `http://127.0.0.1:${srv.address().port}/api/cms/inventory/store-locations`;
  const locCall = (path) => fetch(`${locBase}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

  try {
    const find = await locCall("/find?q=Countme");
    expect(find.status).toBe(200);
    /* The material itself is found — it is in the catalogue. Its in-count
       stickers are not offered as things to go and look for. */
    expect((find.body.markings || []).map((m) => m.barcodeId)).not.toContain(labels[0].id);
    expect((find.body.markings || []).map((m) => m.barcodeId)).not.toContain(labels[1].id);

    const queue = await locCall("/putaway-queue");
    expect(queue.status).toBe(200);
    const queued = (queue.body.markings || queue.body.pending || []).map((m) => m.barcodeId);
    expect(queued).not.toContain(labels[0].id);
    expect(queued).not.toContain(labels[1].id);

    /* Once the receipt is recorded, the applied one IS work owed. */
    await call(grnUrl(po), {
      method: "POST", token, idempotencyKey: key(),
      body: { items: [{ poItemId: String(po.items[0]._id), quantity: 20 }] },
    });
    const after = await locCall("/putaway-queue");
    const now = (after.body.markings || after.body.pending || []).map((m) => m.barcodeId);
    expect(now).toContain(labels[0].id);
    /* And the one that was never applied stays out: it was voided. */
    expect(now).not.toContain(labels[1].id);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});


test("28 · a roll is recorded at what it actually holds; the surplus surfaces at finalisation", async () => {
  const co = await company();
  const token = await actor(co);
  const item = await rawItem(co);
  const po = await makePO(co, [{ rawItemId: item._id, quantity: 40 }]);
  const sid = await openCount(po, token);
  const labels = (await reserve(po, token, sid, { count: 2, quantityPerLabel: 20 })).body.labels;

  /* The rolls are fatter than the order assumed. Refusing the measurement here
     would teach the receiver to type 20 — so it is recorded, and the count is
     honestly over. */
  expect((await apply(po, token, sid, labels[0].id, 21)).status).toBe(200);
  const second = await apply(po, token, sid, labels[1].id, 22);
  expect(second.status).toBe(200);
  expect(second.body.totals.counted).toBe(43);

  const blocked = await call(grnUrl(po), {
    method: "POST", token, idempotencyKey: key(),
    body: { items: [{ poItemId: String(po.items[0]._id), quantity: 43 }] },
  });
  expect(blocked.status).toBe(400);
  /* The receipt engine's OWN over-receipt guard answers first, which is right:
     it has refused this since long before counting existed, and the count did
     not need to re-litigate it. The measurement is still on the label. */
  expect(blocked.body.error.details.reason).toBe("OVER_RECEIPT");
  expect(blocked.body.message).toMatch(/only 40 m remain outstanding/);
  const stillMeasured = await Barcode.find({ receivingSessionId: sid, identityState: "APPLIED" }).sort({ sessionSequence: 1 }).lean();
  expect(stillMeasured.map((b) => b.quantity)).toEqual([21, 22]);
  /* And nothing was received: the goods are here, the order does not cover
     them, and somebody has to amend it. */
  expect((await RawItem.findById(item._id)).quantity).toBe(0);
});
