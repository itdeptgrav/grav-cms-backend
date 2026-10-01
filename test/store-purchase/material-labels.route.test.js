// test/store-purchase/material-labels.route.test.js
//
// MATERIAL LABELS — one identity per physical roll, and nothing else.
//
// A label is a claim about one physical thing. Two of the three ways that claim
// can go wrong are invisible until somebody is standing at a rack holding a
// sticker:
//
//   · two labels carrying the same id, so the rolls cannot be told apart;
//   · a second press of Print minting a second set of identities for the same
//     rolls, so the shelf has ten stickers for five rolls;
//   · a label carrying another company's supplier, order and unit price.
//
// Those are what this file is about. The fourth thing it asserts is the one the
// screen promises out loud: printing a label changes no stock, anywhere.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationReservation = require("../../models/CMS_Models/Inventory/Operations/LocationReservation");
const Employee = require("../../models/Employee");
/* Registered because the scan route populates them — an unregistered model is a
   500 from mongoose, not a route defect. */
require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/barcodes", require("../../routes/CMS_Routes/Inventory/Operations/barcodes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/barcodes`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign(
        { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: emp.firstName, email: emp.email },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** One company, one store user who may act in it, one material, one unit. */
async function seed() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Label Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const store = await Employee.create({
    isActive: true, gender: "Other", department: "Store",
    firstName: "Bikash", lastName: `L${n}`, email: `label${n}@demo.example`, biometricId: `LB${n}`,
  });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "Bikash" });

  const unit = await Unit.create({ name: `metre-${n}`, companyId: company._id });
  const raw = await RawItem.create({
    name: `Cotton poplin ${n}`, sku: `FAB-${n}`, unit: unit.name, quantity: 100, minStock: 0,
    companyId: company._id,
  });
  return { company, store, unit, raw };
}

/** A purchase receipt for one material, satisfying the document's own contract. */
async function receiptFor(s, item) {
  const po = await PurchaseOrder.create({
    companyId: s.company._id, poNumber: `PO/R/${++seq}`, vendorName: "A Supplier",
    createdBy: s.store._id,
    items: [{ rawItem: item._id, quantity: 10, unitPrice: 1, unit: s.unit.name }],
  });
  return GoodsReceipt.create({
    companyId: s.company._id, receiptNumber: `GRN/R/${seq}`,
    sourceType: "PURCHASE_ORDER", purchaseOrderId: po._id, poNumber: po.poNumber,
    sourceDocumentId: po._id, sourceDocumentNumber: po.poNumber,
    supplierName: "A Supplier",
    lines: [{
      rawItemId: item._id, itemName: item.name, receivedQuantity: 10,
      poUnit: s.unit.name, poItemId: po.items[0]._id,
    }],
  });
}

const create = (s, over = {}) => call(s.store, "/", {
  method: "POST",
  body: { rawItemId: String(s.raw._id), quantity: 20, unitId: String(s.unit._id), ...over },
});

/* ═══════════════════════════════════════════════════════════════════════════
   1. ONE IDENTITY PER PHYSICAL ROLL
   ═══════════════════════════════════════════════════════════════════════════ */

test("1 · five rolls get five unique label identities, each naming its own quantity", async () => {
  const s = await seed();
  const r = await create(s, { labelCount: 5, quantity: 20 });

  expect(r.status).toBe(200);
  expect(r.body.barcodes).toHaveLength(5);
  const ids = r.body.barcodes.map((b) => String(b._id));
  expect(new Set(ids).size).toBe(5);               // five, not one printed five times
  for (const b of r.body.barcodes) {
    expect(b.quantity).toBe(20);                   // each label IS 20 metres
    expect(String(b.rawItem)).toBe(String(s.raw._id));
  }
  /* The whole run represents 100 — but no single label claims 100, which is the
     distinction the screen exists to make. */
  expect(r.body.barcodes.reduce((t, b) => t + b.quantity, 0)).toBe(100);
});

test("2 · a label is never reused across lots merely because the material matches", async () => {
  const s = await seed();
  const first = await create(s, { labelCount: 2, printBatchKey: `run-${seq}-a` });
  const second = await create(s, { labelCount: 2, printBatchKey: `run-${seq}-b` });

  const a = first.body.barcodes.map((b) => String(b._id));
  const b = second.body.barcodes.map((x) => String(x._id));
  expect(a.filter((id) => b.includes(id))).toHaveLength(0);
  expect(new Set([...a, ...b]).size).toBe(4);
});

/* ═══════════════════════════════════════════════════════════════════════════
   2. A SECOND PRESS OF PRINT IS NOT A SECOND BATCH
   ═══════════════════════════════════════════════════════════════════════════ */

test("3 · the same print run sent twice returns the SAME labels, and mints none", async () => {
  const s = await seed();
  const key = `run-${seq}-retry`;
  const first = await create(s, { labelCount: 3, printBatchKey: key });
  const again = await create(s, { labelCount: 3, printBatchKey: key });

  expect(again.body.reused).toBe(true);
  expect(again.body.barcodes.map((b) => String(b._id)))
    .toEqual(first.body.barcodes.map((b) => String(b._id)));
  // Three labels exist in total, not six.
  expect(await Barcode.countDocuments({ printBatchKey: key })).toBe(3);
});

test("4 · two simultaneous presses cannot both mint — one wins, both get the same labels", async () => {
  const s = await seed();
  const key = `run-${seq}-race`;
  const [a, b] = await Promise.all([
    create(s, { labelCount: 4, printBatchKey: key }),
    create(s, { labelCount: 4, printBatchKey: key }),
  ]);

  expect(a.status).toBe(200);
  expect(b.status).toBe(200);
  /* Whichever order they landed in, the shelf ends up with four labels for four
     rolls — never eight for four. */
  expect(await Barcode.countDocuments({ printBatchKey: key })).toBe(4);
  expect(a.body.barcodes.map((x) => String(x._id)).sort())
    .toEqual(b.body.barcodes.map((x) => String(x._id)).sort());
});

test("5 · a run with no key is not treated as a retry of another keyless run", async () => {
  /* Keyless is the legacy shape and must keep working — it simply gets no
     idempotency, which is what it had before. */
  const s = await seed();
  const a = await create(s, { labelCount: 2 });
  const b = await create(s, { labelCount: 2 });
  expect(a.body.barcodes.map((x) => String(x._id)))
    .not.toEqual(b.body.barcodes.map((x) => String(x._id)));
  expect(await Barcode.countDocuments({ rawItem: s.raw._id })).toBe(4);
});

/* ═══════════════════════════════════════════════════════════════════════════
   3. REPRINT READS; IT DOES NOT MINT
   ═══════════════════════════════════════════════════════════════════════════ */

test("6 · reprinting reads the existing labels and creates no new identity", async () => {
  const s = await seed();
  const made = await create(s, { labelCount: 3, printBatchKey: `run-${seq}-rp` });
  const before = await Barcode.countDocuments({ rawItem: s.raw._id });

  /* A reprint is the LIST — the same ids, read back. There is no write, not
     even a print counter: the same label printed twice is one label, and a
     counter reading "2" would invite somebody to wonder whether two rolls
     exist. */
  const listed = await call(s.store, `/?rawItemId=${s.raw._id}`);
  expect(listed.status).toBe(200);
  expect(listed.body.barcodes.map((b) => String(b._id)).sort())
    .toEqual(made.body.barcodes.map((b) => String(b._id)).sort());
  expect(await Barcode.countDocuments({ rawItem: s.raw._id })).toBe(before);
});

/* ═══════════════════════════════════════════════════════════════════════════
   4. PROVENANCE, AND WHOSE IT IS
   ═══════════════════════════════════════════════════════════════════════════ */

test("7 · a label printed from a receipt carries the receipt, its line and the order", async () => {
  const s = await seed();
  const po = await PurchaseOrder.create({
    companyId: s.company._id, poNumber: `PO/LBL/${seq}`, vendorName: "Northwind Textiles",
    createdBy: s.store._id,
    items: [{ rawItem: s.raw._id, quantity: 100, unitPrice: 42, unit: s.unit.name }],
  });
  const gr = await GoodsReceipt.create({
    companyId: s.company._id, receiptNumber: `GRN/LBL/${seq}`,
    sourceType: "PURCHASE_ORDER", purchaseOrderId: po._id, poNumber: po.poNumber,
    sourceDocumentId: po._id, sourceDocumentNumber: po.poNumber,
    supplierName: "Northwind Textiles",
    /* A purchase receipt line must name its PO line — the receipt exists to be
       reconciled against the order. */
    lines: [{
      rawItemId: s.raw._id, itemName: s.raw.name, receivedQuantity: 100,
      poUnit: s.unit.name, poItemId: po.items[0]._id,
    }],
  });

  const r = await create(s, {
    labelCount: 2, quantity: 50,
    purchaseOrderId: String(po._id),
    goodsReceiptId: String(gr._id),
  });

  expect(r.status).toBe(200);
  for (const b of r.body.barcodes) {
    expect(String(b.goodsReceiptId)).toBe(String(gr._id));
    expect(b.goodsReceiptNumber).toBe(gr.receiptNumber);
    expect(String(b.goodsReceiptLineId)).toBe(String(gr.lines[0]._id));
    expect(b.purchaseOrderNumber).toBe(po.poNumber);
    expect(b.vendorName).toBe("Northwind Textiles");
  }
});

test("8 · a receipt that never contained this material cannot be claimed by its label", async () => {
  const s = await seed();
  const other = await RawItem.create({
    name: `Elsewhere ${seq}`, sku: `ELS-${seq}`, unit: s.unit.name, quantity: 10, companyId: s.company._id,
  });
  const gr = await receiptFor(s, other);

  const r = await create(s, { goodsReceiptId: String(gr._id) });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/does not have a line for this material/i);
  expect(await Barcode.countDocuments({ rawItem: s.raw._id })).toBe(0);
});

/* ═══════════════════════════════════════════════════════════════════════════
   5. ACROSS COMPANIES, NOTHING
   ═══════════════════════════════════════════════════════════════════════════ */

test("9 · another company's material cannot be labelled", async () => {
  const mine = await seed();
  const theirs = await seed();

  const r = await call(mine.store, "/", {
    method: "POST",
    body: { rawItemId: String(theirs.raw._id), quantity: 5, unitId: String(mine.unit._id) },
  });
  expect(r.status).toBe(404);
  expect(await Barcode.countDocuments({ rawItem: theirs.raw._id })).toBe(0);
});

test("10 · another company's purchase order cannot reach our label", async () => {
  const mine = await seed();
  const theirs = await seed();
  const theirPo = await PurchaseOrder.create({
    companyId: theirs.company._id, poNumber: `PO/SECRET/${seq}`, vendorName: "Their Supplier Ltd",
    createdBy: theirs.store._id,
    items: [{ rawItem: theirs.raw._id, quantity: 10, unitPrice: 999, unit: theirs.unit.name }],
  });

  const r = await create(mine, { purchaseOrderId: String(theirPo._id) });
  expect(r.status).toBe(200);
  /* The label is created — the PO is optional provenance — but it carries NONE
     of their commercial terms. Their supplier and their price are the things
     that must not end up printed on our sticker. */
  const b = r.body.barcodes[0];
  expect(b.purchaseOrderNumber).toBe("");
  expect(b.vendorName).toBe("");
  expect(b.unitPrice).toBeNull();
});

test("11 · another company's receipt cannot reach our label", async () => {
  const mine = await seed();
  const theirs = await seed();
  const theirGr = await receiptFor(theirs, theirs.raw);

  const r = await create(mine, { goodsReceiptId: String(theirGr._id) });
  expect(r.status).toBe(404);
});

test("12 · a scan of another company's label is refused", async () => {
  const mine = await seed();
  const theirs = await seed();
  const made = await create(theirs, { labelCount: 1 });
  const id = String(made.body.barcodes[0]._id);

  const scan = await call(mine.store, `/${id}`);
  expect(scan.status).toBe(404);
  // And their own scan of it still works.
  expect((await call(theirs.store, `/${id}`)).status).toBe(200);
});

test("13 · the list returns only this company's labels", async () => {
  const mine = await seed();
  const theirs = await seed();
  await create(mine, { labelCount: 2 });
  await create(theirs, { labelCount: 3 });

  const listed = await call(mine.store, "/");
  const companies = new Set(listed.body.barcodes.map((b) => String(b.companyId || "")));
  expect(companies.has(String(theirs.company._id))).toBe(false);
});

test("14 · labels printed before company stamping still scan and still list", async () => {
  const s = await seed();
  /* Every sticker already on a shelf has no companyId. Refusing those would be
     a worse failure than the one the scoping fixes. */
  const legacy = await Barcode.create({
    rawItem: s.raw._id, rawItemName: s.raw.name, quantity: 12, unit: s.unit.name,
  });
  expect((await call(s.store, `/${legacy._id}`)).status).toBe(200);
  const listed = await call(s.store, `/?rawItemId=${s.raw._id}`);
  expect(listed.body.barcodes.map((b) => String(b._id))).toContain(String(legacy._id));
});

/* ═══════════════════════════════════════════════════════════════════════════
   6. PRINTING A LABEL CHANGES NO STOCK
   ═══════════════════════════════════════════════════════════════════════════ */

test("15 · creating labels changes no quantity, no balance, no movement, no reservation", async () => {
  const s = await seed();
  const before = {
    itemQty: (await RawItem.findById(s.raw._id).lean()).quantity,
    balances: await LocationBalance.countDocuments({}),
    movements: await LocationMovement.countDocuments({}),
    reservations: await LocationReservation.countDocuments({}),
  };

  const r = await create(s, { labelCount: 5, quantity: 20 });
  expect(r.body.barcodes).toHaveLength(5);

  /* 100 metres' worth of labels, and the company still holds exactly what it
     held. This is the promise the screen makes out loud. */
  expect((await RawItem.findById(s.raw._id).lean()).quantity).toBe(before.itemQty);
  expect(await LocationBalance.countDocuments({})).toBe(before.balances);
  expect(await LocationMovement.countDocuments({})).toBe(before.movements);
  expect(await LocationReservation.countDocuments({})).toBe(before.reservations);
  // And no label claims a storage position.
  for (const b of r.body.barcodes) expect(b.locationId).toBeUndefined();
});

test("16 · a label count outside the allowed range is refused before anything is written", async () => {
  const s = await seed();
  for (const labelCount of [0, -3, 2.5, 101]) {
    const r = await create(s, { labelCount });
    expect(r.status).toBe(400);
  }
  expect(await Barcode.countDocuments({ rawItem: s.raw._id })).toBe(0);
});
