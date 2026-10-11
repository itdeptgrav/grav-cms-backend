// test/store-purchase/label-grn-link.route.test.js
//
// LINKING PRINTED LABELS TO A RECORDED GOODS RECEIPT  (11 Oct 2026, owner)
//
// Receive › Link labels to a GRN: scan labels printed from Material labels,
// pick the receipt they arrived on, link them. What this file holds the routes
// to, in the order a store person meets it:
//
//   · the check names each label and offers ONLY receipts carrying its
//     material (never a customer-owned delivery, never another company's);
//   · the link stamps the receipt — and on a purchase receipt the order,
//     line, supplier and price — exactly as on a label printed AT the receipt,
//     moves no stock, and leaves a history entry on the receipt;
//   · a scan of the label then names the receipt and says it was linked later;
//   · every label that cannot go is refused with its reason and left as it was;
//   · a link made here can be taken back — until QC has checked the label.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const QCRawItemInspection = require("../../models/CMS_Models/Manufacturing/QC/QCRawItemInspection");
const Employee = require("../../models/Employee");
require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

let server, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/store/goods-receipts", require("../../routes/CMS_Routes/StorePurchase/goodsReceipts"));
  app.use("/api/cms/inventory/barcodes", require("../../routes/CMS_Routes/Inventory/Operations/barcodes"));
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}/api/cms`;
  /* A collection created lazily inside the first write is the flake this
     suite must not have. */
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().catch(() => {})));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: emp.firstName, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${root}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const check = (s, barcodeIds, extra = {}) => call(s.store, "/store/goods-receipts/label-links/check", { method: "POST", body: { barcodeIds, ...extra } });
const link = (s, goodsReceiptId, barcodeIds, who = s.store) => call(who, "/store/goods-receipts/label-links", { method: "POST", body: { goodsReceiptId, barcodeIds } });
const unlink = (s, barcodeId) => call(s.store, "/store/goods-receipts/label-links/unlink", { method: "POST", body: { barcodeId } });
const scan = (s, id) => call(s.store, `/inventory/barcodes/${id}`);

async function person(company, n, role) {
  const emp = await Employee.create({
    isActive: true, gender: "Other", department: "Store",
    firstName: role === "viewer" ? "Viewer" : "Bikash", lastName: `G${n}`,
    email: `grnlink-${role}-${n}@demo.example`, biometricId: `GL${role[0]}${n}`,
  });
  await DepartmentRole.create({ departmentSlug: "store", email: emp.email, role, isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: emp.email, employeeRef: emp._id, personName: emp.firstName });
  return emp;
}

/** A company, its store people, two materials (one with two variants). */
async function seed() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `GRN Link Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const store = await person(company, n, "approver");
  const viewer = await person(company, n, "viewer");
  const fabric = await RawItem.create({ name: `Poplin ${n}`, sku: `POP-${n}`, unit: "Mtr", quantity: 500, minStock: 0, companyId: company._id });
  const button = await RawItem.create({
    name: `Button ${n}`, sku: `BTN-${n}`, unit: "Pcs", quantity: 1000, minStock: 0, companyId: company._id,
    variants: [{ combination: ["Red"], sku: `BTN-${n}-R`, quantity: 400 }, { combination: ["Blue"], sku: `BTN-${n}-B`, quantity: 600 }],
  });
  return { n, company, store, viewer, fabric, button, red: button.variants[0], blue: button.variants[1] };
}

/** A recorded purchase receipt: lines = [{ item, variant?, qty, unit, price }]. */
async function purchaseReceipt(s, lines, over = {}) {
  const po = await PurchaseOrder.create({
    companyId: s.company._id, poNumber: `PO/GL/${++seq}`, vendorName: "Odisha Mills",
    createdBy: s.store._id,
    items: lines.map((l) => ({ rawItem: l.item._id, variantId: l.variant?._id || null, quantity: l.qty, unitPrice: l.price ?? 50, unit: l.unit })),
  });
  return GoodsReceipt.create({
    companyId: s.company._id, receiptNumber: `GRN/GL/${seq}`,
    sourceType: "PURCHASE_ORDER", purchaseOrderId: po._id, poNumber: po.poNumber,
    sourceDocumentId: po._id, sourceDocumentNumber: po.poNumber, supplierName: "Odisha Mills",
    receiptDate: new Date("2026-10-05"),
    lines: lines.map((l, i) => ({
      rawItemId: l.item._id, variantId: l.variant?._id || null, variantCombination: l.variant?.combination || [],
      itemName: l.item.name, receivedQuantity: l.qty, poUnit: l.unit, baseUnit: l.unit, poItemId: po.items[i]._id,
    })),
    ...over,
  });
}

/** A recorded material-request receipt for one material. */
async function materialRequestReceipt(s, item, qty, unit) {
  return GoodsReceipt.create({
    companyId: s.company._id, receiptNumber: `GRN/MR/${++seq}`,
    sourceType: "MATERIAL_REQUEST", sourceDocumentId: new mongoose.Types.ObjectId(), sourceDocumentNumber: `MR-REQ-${seq}`,
    materialRequest: { customerRequestId: new mongoose.Types.ObjectId(), requestId: new mongoose.Types.ObjectId(), requestNumber: `MR-REQ-${seq}`, orderRef: `REQ-${seq}` },
    lines: [{ rawItemId: item._id, itemName: item.name, receivedQuantity: qty, poUnit: unit, baseUnit: unit, sourceLineId: new mongoose.Types.ObjectId() }],
  });
}

/** A label as Material labels prints it: stock on hand, no receipt. */
const label = (s, item, over = {}) => Barcode.create({
  companyId: s.company._id, rawItem: item._id, rawItemName: item.name, rawItemSku: item.sku,
  quantity: 20, unit: item.unit, ...over,
});
const ids = (...docs) => docs.map((d) => String(d._id));

/* ═══ 1. STEP 1 + STEP 2: WHAT EACH LABEL IS, AND WHICH RECEIPTS TAKE IT ═══ */

test("1 · the check names each label and offers only recorded receipts that carry its material", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const other = await purchaseReceipt(s, [{ item: s.button, variant: s.red, qty: 50, unit: "Pcs" }]);
  const a = await label(s, s.fabric);
  const b = await label(s, s.fabric, { quantity: 35.5 });

  const r = await check(s, ids(a, b));
  expect(r.status).toBe(200);
  expect(r.body.counts).toEqual({ scanned: 2, ready: 2, alreadyLinked: 0, refused: 0 });
  expect(r.body.labels[0].label.rawItemName).toBe(s.fabric.name);
  const offered = r.body.choices.map((c) => c.receiptNumber);
  expect(offered).toContain(grn.receiptNumber);
  expect(offered).not.toContain(other.receiptNumber);       // no button on it

  const choice = r.body.choices.find((c) => c.receiptNumber === grn.receiptNumber);
  expect(choice.matching).toBe(2);
  expect(choice.kind).toBe("purchase");
  expect(choice.poNumber).toMatch(/^PO\/GL\//);
  expect(choice.plan.lines).toEqual([expect.objectContaining({ received: 100, labelledQty: 0, addingCount: 2, addingQty: 55.5, overBy: 0 })]);
  expect(choice.plan.cautions).toEqual([]);
});

test("2 · a customer-owned delivery, a voided receipt and another company's receipt are never offered", async () => {
  const s = await seed();
  const t = await seed();
  const theirs = await purchaseReceipt(t, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const voided = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }], { status: "VOID" });
  await GoodsReceipt.collection.insertOne({
    companyId: s.company._id, receiptNumber: `GRN/CM/${++seq}`, sourceType: "CUSTOMER_MATERIAL", status: "RECORDED",
    sourceDocumentId: new mongoose.Types.ObjectId(), lines: [{ _id: new mongoose.Types.ObjectId(), rawItemId: s.fabric._id, itemName: s.fabric.name, receivedQuantity: 40, poUnit: "Mtr" }],
    receiptDate: new Date(), createdAt: new Date(),
  });
  const a = await label(s, s.fabric);

  const r = await check(s, ids(a));
  const offered = r.body.choices.map((c) => c.receiptNumber);
  expect(offered).not.toContain(theirs.receiptNumber);
  expect(offered).not.toContain(voided.receiptNumber);
  expect(r.body.choices.every((c) => c.kind !== "customer-material")).toBe(true);
});

test("3 · a receipt asked for by id is offered even when nothing scanned is on it — with the reason", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.button, variant: s.red, qty: 50, unit: "Pcs" }]);
  const a = await label(s, s.fabric);

  const r = await check(s, ids(a), { goodsReceiptId: String(grn._id) });
  const choice = r.body.choices.find((c) => c.receiptNumber === grn.receiptNumber);
  expect(choice).toBeTruthy();
  expect(choice.matching).toBe(0);
  expect(choice.plan.rows[0]).toEqual(expect.objectContaining({ lineId: null, reason: "MATERIAL_NOT_ON_RECEIPT" }));
});

/* ═══ 2. THE LINK ═════════════════════════════════════════════════════════ */

test("4 · linking stamps the receipt, its line, the order, supplier and price — and moves no stock", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr", price: 82.5 }]);
  const a = await label(s, s.fabric);
  const b = await label(s, s.fabric, { quantity: 30 });
  const before = await RawItem.findById(s.fabric._id).lean();

  const r = await link(s, String(grn._id), ids(a, b));
  expect(r.status).toBe(200);
  expect(r.body.linked).toBe(2);
  expect(r.body.message).toBe(`2 labels linked to ${grn.receiptNumber}.`);
  expect(r.body.results.map((x) => x.outcome)).toEqual(["linked", "linked"]);

  const after = await Barcode.findById(a._id).lean();
  expect(String(after.goodsReceiptId)).toBe(String(grn._id));
  expect(after.goodsReceiptNumber).toBe(grn.receiptNumber);
  expect(String(after.goodsReceiptLineId)).toBe(String(grn.lines[0]._id));
  expect(String(after.purchaseOrder)).toBe(String(grn.purchaseOrderId));
  expect(after.purchaseOrderNumber).toBe(grn.poNumber);
  expect(String(after.purchaseOrderItemId)).toBe(String(grn.lines[0].poItemId));
  expect(after.vendorName).toBe("Odisha Mills");
  expect(after.unitPrice).toBe(82.5);
  expect(after.grnLink.linkedByName).toBe("Bikash");
  expect(after.grnLink.previous.purchaseOrderNumber).toBe("");
  expect(after.identityState).toBe("ACTIVATED");            // still the live label it was

  const stock = await RawItem.findById(s.fabric._id).lean();
  expect(stock.quantity).toBe(before.quantity);               // nothing moved

  const history = await SpActionHistory.find({ entityId: grn._id, action: "LABELS_LINKED" }).lean();
  expect(history).toHaveLength(1);
  expect(history[0].metadata.labels).toBe(2);
  expect(history[0].documentNumber).toBe(grn.receiptNumber);
});

test("5 · a scan of a linked label names the receipt, its line, and that it was linked later", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const a = await label(s, s.fabric);
  const plain = await scan(s, a._id);
  expect(plain.body.goodsReceipt).toBeNull();                 // printed from stock: no receipt yet

  await link(s, String(grn._id), ids(a));
  const r = await scan(s, a._id);
  expect(r.status).toBe(200);
  expect(r.body.goodsReceipt).toEqual(expect.objectContaining({
    receiptNumber: grn.receiptNumber, kind: "purchase", supplierName: "Odisha Mills",
    href: `/store/dashboard/operations/goods-receipts/${grn._id}/document`,
  }));
  expect(r.body.goodsReceipt.line).toEqual(expect.objectContaining({ received: 100, unit: "Mtr" }));
  expect(r.body.goodsReceipt.linkedLater.byName).toBe("Bikash");
});

test("6 · a material-request receipt is linked without inventing a supplier or an order", async () => {
  const s = await seed();
  const grn = await materialRequestReceipt(s, s.fabric, 60, "Mtr");
  const a = await label(s, s.fabric);

  const r = await link(s, String(grn._id), ids(a));
  expect(r.body.linked).toBe(1);
  const after = await Barcode.findById(a._id).lean();
  expect(String(after.goodsReceiptId)).toBe(String(grn._id));
  expect(after.purchaseOrder).toBeNull();
  expect(after.vendorName).toBe("");
  expect(after.unitPrice).toBeNull();

  const seen = await scan(s, a._id);
  expect(seen.body.goodsReceipt).toEqual(expect.objectContaining({ kind: "material-request", requestNumber: grn.materialRequest.requestNumber, orderRef: grn.materialRequest.orderRef }));
});

test("7 · the variant decides the line: a matching variant links, another variant and an unclear one do not", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [
    { item: s.button, variant: s.red, qty: 100, unit: "Pcs" },
    { item: s.button, variant: s.blue, qty: 100, unit: "Pcs" },
  ]);
  const redOnly = await purchaseReceipt(s, [{ item: s.button, variant: s.red, qty: 100, unit: "Pcs" }]);
  const blue = await label(s, s.button, { variantId: s.blue._id, variantCombination: ["Blue"] });
  const none = await label(s, s.button);

  const r = await link(s, String(grn._id), ids(blue, none));
  const [first, second] = r.body.results;
  expect(first.outcome).toBe("linked");
  expect(first.line.variant).toBe("Blue");
  expect(second).toEqual(expect.objectContaining({ outcome: "refused", reason: "VARIANT_UNCLEAR" }));

  const another = await label(s, s.button, { variantId: s.blue._id, variantCombination: ["Blue"] });
  const r2 = await link(s, String(redOnly._id), ids(another));
  expect(r2.body.results[0]).toEqual(expect.objectContaining({ outcome: "refused", reason: "VARIANT_NOT_ON_RECEIPT" }));
  expect((await Barcode.findById(another._id).lean()).goodsReceiptId).toBeNull();
});

test("8 · more on labels than the line received is said, not refused", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 30, unit: "Mtr" }]);
  const a = await label(s, s.fabric, { quantity: 20 });
  const b = await label(s, s.fabric, { quantity: 20 });

  const preview = await check(s, ids(a, b));
  const plan = preview.body.choices[0].plan;
  expect(plan.lines[0].overBy).toBe(10);
  expect(plan.cautions[0]).toMatch(/come to 40 Mtr; the receipt received 30 Mtr \(10 Mtr more\)/);

  const r = await link(s, String(grn._id), ids(a, b));
  expect(r.body.linked).toBe(2);
  expect(r.body.cautions).toHaveLength(1);
});

/* ═══ 3. WHAT IS REFUSED, AND STAYS AS IT WAS ═════════════════════════════ */

test("9 · already linked, voided, in a count, customer-owned, unknown and another company's labels are refused", async () => {
  const s = await seed();
  const t = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const second = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const linked = await label(s, s.fabric);
  await link(s, String(grn._id), ids(linked));
  const voided = await label(s, s.fabric, { identityState: "VOIDED", voidedAt: new Date(), voidReason: "torn" });
  const counting = await label(s, s.fabric, { identityState: "PRINTED", receivingSessionId: new mongoose.Types.ObjectId(), purchaseOrderNumber: "PO/OPEN/1" });
  const { insertedId: owned } = await Barcode.collection.insertOne({
    companyId: s.company._id, rawItem: s.fabric._id, rawItemName: s.fabric.name, quantity: 10, unit: "Mtr", identityState: "ACTIVATED",
    customerMaterial: { lotId: new mongoose.Types.ObjectId(), goodsReceiptNumber: "GRN/CM/9" },
  });
  const theirs = await label(t, t.fabric);

  const r = await check(s, [...ids(linked, voided, counting), String(owned), String(theirs._id), "not-a-label"]);
  expect(r.body.labels.map((l) => l.reason)).toEqual(["ALREADY_LINKED", "LABEL_VOIDED", "LABEL_IN_COUNT", "CUSTOMER_OWNED", "LABEL_UNKNOWN", "NOT_A_LABEL"]);
  expect(r.body.labels[0].linkedTo).toEqual({ goodsReceiptId: String(grn._id), receiptNumber: grn.receiptNumber, linkedHere: true });
  expect(r.body.labels[4].message).toMatch(/not in this company's register/);   // another company's label
  expect(r.body.counts).toEqual({ scanned: 6, ready: 0, alreadyLinked: 1, refused: 5 });

  const w = await link(s, String(second._id), [...ids(linked, voided, counting), String(owned)]);
  expect(w.body.linked).toBe(0);
  expect(w.body.results.map((x) => x.reason)).toEqual(["ALREADY_LINKED", "LABEL_VOIDED", "LABEL_IN_COUNT", "CUSTOMER_OWNED"]);
  expect(String((await Barcode.findById(linked._id).lean()).goodsReceiptId)).toBe(String(grn._id));   // not moved
  expect((await Barcode.findById(counting._id).lean()).goodsReceiptId).toBeNull();
});

test("10 · linking a label to the receipt it is already on answers 'already', changing nothing", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const a = await label(s, s.fabric);
  await link(s, String(grn._id), ids(a));
  const stamp = (await Barcode.findById(a._id).lean()).grnLink.linkedAt;

  const again = await link(s, String(grn._id), ids(a));
  expect(again.body.results[0]).toEqual(expect.objectContaining({ outcome: "already", reason: "ALREADY_ON_THIS_RECEIPT" }));
  expect((await Barcode.findById(a._id).lean()).grnLink.linkedAt).toEqual(stamp);
});

test("11 · a voided receipt, a customer-owned receipt and another company's receipt refuse the link outright", async () => {
  const s = await seed();
  const t = await seed();
  const voided = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }], { status: "VOID" });
  const theirs = await purchaseReceipt(t, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const { insertedId: customer } = await GoodsReceipt.collection.insertOne({
    companyId: s.company._id, receiptNumber: `GRN/CM/${++seq}`, sourceType: "CUSTOMER_MATERIAL", status: "RECORDED",
    sourceDocumentId: new mongoose.Types.ObjectId(), lines: [], receiptDate: new Date(),
  });
  const a = await label(s, s.fabric);

  expect((await link(s, String(voided._id), ids(a))).body.error.details.reason).toBe("RECEIPT_VOID");
  expect((await link(s, String(customer), ids(a))).body.error.details.reason).toBe("CUSTOMER_RECEIPT");
  expect((await link(s, String(theirs._id), ids(a))).status).toBe(404);
  expect((await Barcode.findById(a._id).lean()).goodsReceiptId).toBeNull();
});

test("12 · a viewer may check but not link", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const a = await label(s, s.fabric);
  expect((await call(s.viewer, "/store/goods-receipts/label-links/check", { method: "POST", body: { barcodeIds: ids(a) } })).status).toBe(200);
  expect((await link(s, String(grn._id), ids(a), s.viewer)).status).toBe(403);
  expect((await Barcode.findById(a._id).lean()).goodsReceiptId).toBeNull();
});

/* ═══ 4. TAKING A LINK BACK ═══════════════════════════════════════════════ */

test("13 · unlinking puts the label back exactly as it was and records it on the receipt", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr", price: 90 }]);
  const a = await label(s, s.fabric, { purchaseOrderNumber: "PO/OLD/1", vendorName: "Old Supplier", unitPrice: 70 });
  await link(s, String(grn._id), ids(a));
  expect((await Barcode.findById(a._id).lean()).vendorName).toBe("Odisha Mills");

  const r = await unlink(s, String(a._id));
  expect(r.status).toBe(200);
  expect(r.body.message).toBe(`Label taken off ${grn.receiptNumber}.`);
  const back = await Barcode.findById(a._id).lean();
  expect(back.goodsReceiptId).toBeNull();
  expect(back.goodsReceiptNumber).toBe("");
  expect(back.purchaseOrderNumber).toBe("PO/OLD/1");
  expect(back.vendorName).toBe("Old Supplier");
  expect(back.unitPrice).toBe(70);
  expect(back.grnLink).toBeNull();
  expect(await SpActionHistory.countDocuments({ entityId: grn._id, action: "LABEL_UNLINKED" })).toBe(1);
  expect((await scan(s, a._id)).body.goodsReceipt).toBeNull();
});

test("14 · a label received at its receipt, or one QC has checked, is not unlinked here", async () => {
  const s = await seed();
  const grn = await purchaseReceipt(s, [{ item: s.fabric, qty: 100, unit: "Mtr" }]);
  const atReceipt = await label(s, s.fabric, { goodsReceiptId: grn._id, goodsReceiptNumber: grn.receiptNumber, goodsReceiptLineId: grn.lines[0]._id });
  const r1 = await unlink(s, String(atReceipt._id));
  expect(r1.status).toBe(409);
  expect(r1.body.error.details.reason).toBe("NOT_LINKED_HERE");

  const checked = await label(s, s.fabric);
  await link(s, String(grn._id), ids(checked));
  await QCRawItemInspection.collection.insertOne({ barcodeId: checked._id, goodsReceiptId: grn._id, superseded: false, status: "PASSED" });
  const r2 = await unlink(s, String(checked._id));
  expect(r2.status).toBe(409);
  expect(r2.body.error.details.reason).toBe("QC_CHECKED");
  expect(String((await Barcode.findById(checked._id).lean()).goodsReceiptId)).toBe(String(grn._id));
});
