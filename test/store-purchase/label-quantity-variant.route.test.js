// test/store-purchase/label-quantity-variant.route.test.js
//
// INVENTORY › LABEL QUANTITY: CHANGE THE VARIANT AS WELL AS THE NUMBER
// (16 Oct 2026, owner: "I just want to change the product variant and the
// number — the variants are already registered").
//
// PATCH /api/cms/inventory/barcodes/:id/quantity takes an optional
// `variantId`. These hold it to:
//
//   · the label moves to the new variant (id, combination, SKU) and its new
//     figure in ONE write, and the edit records variantFrom / variantTo;
//   · with the stock box ticked the goods follow: the old figure leaves the
//     old variant, the new figure lands on the new one, the item total moves
//     by the difference, two ledger rows say so;
//   · unticked, only the label changes;
//   · a variant not registered on the label's raw item is refused, nothing
//     changes;
//   · when the old variant cannot cover the label, the label still moves and
//     the stock stays exactly where it was (nothing half-moved);
//   · without `variantId` (or with the label's own) the route is unchanged.
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
const Employee = require("../../models/Employee");

let server, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/barcodes", require("../../routes/CMS_Routes/Inventory/Operations/barcodes"));
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}/api/cms`;
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().catch(() => {})));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = (emp) => jwt.sign(
  { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: emp.firstName, email: emp.email },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const patch = (s, id, body) =>
  fetch(`${root}/inventory/barcodes/${id}/quantity`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(s.store)}` },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** A company, a store approver, a thread with three registered variants. */
async function seed() {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Label Variant Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const store = await Employee.create({
    isActive: true, gender: "Other", department: "Store",
    firstName: "Bikash", lastName: `V${n}`, email: `labelvar-${n}@demo.example`, biometricId: `LV${n}`,
  });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: store.firstName });
  const thread = await RawItem.create({
    name: `Coats Astra ${n}`, sku: `COA-${n}`, unit: "Meter", quantity: 12000, minStock: 0, companyId: company._id,
    variants: [
      { combination: ["5000", "Navy Blue", "100", "J D Enterprises"], sku: `COA-${n}-NB`, quantity: 5000 },
      { combination: ["5000", "Black", "100", "J D Enterprises"], sku: `COA-${n}-BK`, quantity: 7000 },
      { combination: ["5000", "Dark Grey", "100", "J D Enterprises"], sku: `COA-${n}-DG`, quantity: 0 },
    ],
  });
  const [navy, black, grey] = thread.variants;
  const label = await Barcode.create({
    companyId: company._id, rawItem: thread._id, rawItemName: thread.name, rawItemSku: thread.sku,
    variantId: navy._id, variantCombination: navy.combination, variantSku: navy.sku,
    quantity: 5000, unit: "Meter",
  });
  return { company, store, thread, navy, black, grey, label };
}
const variantQty = (item, v) => item.variants.find((x) => String(x._id) === String(v._id)).quantity;

test("1 · variant and figure change together; the goods follow from the old variant to the new", async () => {
  const s = await seed();
  const r = await patch(s, s.label._id, { quantity: 2000, variantId: String(s.grey._id), reason: "printed on the wrong colour", adjustStock: true });
  expect(r.status).toBe(200);
  expect(r.body.success).toBe(true);
  expect(r.body.message).toMatch(/Variant 5000 · Navy Blue · 100 · J D Enterprises → 5000 · Dark Grey · 100 · J D Enterprises/);

  const after = await Barcode.findById(s.label._id).lean();
  expect(String(after.variantId)).toBe(String(s.grey._id));
  expect(after.variantCombination).toEqual(s.grey.combination);
  expect(after.variantSku).toBe(s.grey.sku);
  expect(after.quantity).toBe(2000);
  const edit = after.quantityEdits.at(-1);
  expect(edit.from).toBe(5000);
  expect(edit.to).toBe(2000);
  expect(String(edit.variantFrom.variantId)).toBe(String(s.navy._id));
  expect(String(edit.variantTo.variantId)).toBe(String(s.grey._id));
  expect(edit.stock.applied).toBe(true);
  expect(edit.stock.kind).toBe("variant");

  const item = await RawItem.findById(s.thread._id).lean();
  expect(variantQty(item, s.navy)).toBe(0);        // 5000 − 5000 (the old figure left)
  expect(variantQty(item, s.grey)).toBe(2000);     // 0 + 2000 (the new figure arrived)
  expect(variantQty(item, s.black)).toBe(7000);    // untouched
  expect(item.quantity).toBe(9000);                // 12000 + (2000 − 5000)
  const rows = item.stockTransactions.filter((t) => /Label: /.test(t.notes || ""));
  expect(rows.map((t) => t.type).sort()).toEqual(["VARIANT_ADD", "VARIANT_REDUCE"]);
});

test("2 · unticked: only the label changes; the stock stays as it was", async () => {
  const s = await seed();
  const r = await patch(s, s.label._id, { quantity: 5000, variantId: String(s.black._id), adjustStock: false });
  expect(r.status).toBe(200);
  const after = await Barcode.findById(s.label._id).lean();
  expect(String(after.variantId)).toBe(String(s.black._id));
  expect(after.quantity).toBe(5000);
  expect(after.quantityEdits.at(-1).stock).toBeNull();
  const item = await RawItem.findById(s.thread._id).lean();
  expect(variantQty(item, s.navy)).toBe(5000);
  expect(variantQty(item, s.black)).toBe(7000);
  expect(item.quantity).toBe(12000);
});

test("3 · a variant not registered on the raw item is refused, and nothing changes", async () => {
  const s = await seed();
  const other = await RawItem.create({ name: "Other", sku: "OTH", unit: "Meter", quantity: 10, companyId: s.company._id, variants: [{ combination: ["Red"], quantity: 10 }] });
  const r = await patch(s, s.label._id, { quantity: 4000, variantId: String(other.variants[0]._id) });
  expect(r.status).toBe(400);
  expect(r.body.code).toBe("VARIANT_NOT_ON_ITEM");
  const bad = await patch(s, s.label._id, { quantity: 4000, variantId: "not-an-id" });
  expect(bad.status).toBe(400);
  expect(bad.body.code).toBe("VARIANT_INVALID");
  const after = await Barcode.findById(s.label._id).lean();
  expect(String(after.variantId)).toBe(String(s.navy._id));
  expect(after.quantity).toBe(5000);
  expect(after.quantityEdits || []).toHaveLength(0);
});

test("4 · the old variant cannot cover the label: the label moves, the stock is left exactly as it was", async () => {
  const s = await seed();
  await RawItem.updateOne({ _id: s.thread._id, "variants._id": s.navy._id }, { $set: { "variants.$.quantity": 100 } });
  const r = await patch(s, s.label._id, { quantity: 5000, variantId: String(s.black._id), adjustStock: true });
  expect(r.status).toBe(200);
  expect(r.body.stockAdjustment.applied).toBe(false);
  expect(r.body.warnings.length).toBe(1);
  const after = await Barcode.findById(s.label._id).lean();
  expect(String(after.variantId)).toBe(String(s.black._id));
  const item = await RawItem.findById(s.thread._id).lean();
  expect(variantQty(item, s.navy)).toBe(100);
  expect(variantQty(item, s.black)).toBe(7000);
  expect(item.quantity).toBe(12000);
});

test("5 · without a variant (or with the label's own) the figure edit is exactly as before", async () => {
  const s = await seed();
  const same = await patch(s, s.label._id, { quantity: 5000, variantId: String(s.navy._id) });
  expect(same.body.unchanged).toBe(true);
  const r = await patch(s, s.label._id, { quantity: 4500, adjustStock: true });
  expect(r.status).toBe(200);
  const after = await Barcode.findById(s.label._id).lean();
  expect(String(after.variantId)).toBe(String(s.navy._id));
  expect(after.quantity).toBe(4500);
  expect(after.quantityEdits.at(-1).variantTo).toBeNull();
  expect(after.quantityEdits.at(-1).stock.kind).toBeUndefined();
  const item = await RawItem.findById(s.thread._id).lean();
  expect(variantQty(item, s.navy)).toBe(4500);
  expect(item.quantity).toBe(11500);
});
