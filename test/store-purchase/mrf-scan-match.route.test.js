// test/store-purchase/mrf-scan-match.route.test.js
//
// SCAN A BARCODE IN "MATCH TO INVENTORY"  (14 Oct 2026, owner)
//
// GET /api/cms/inventory/mrf/data/raw-items/scan?code= turns whatever the
// scanner read into the product (and variant) the popup selects:
//
//   · our raw-item label, in every form a scanner or camera delivers →
//     the label's material AND its variant;
//   · a VOIDED label names nothing, and says so;
//   · an exact item or variant SKU (case and spaces ignored) → that product;
//     a SKU several products carry → the candidates, never a guess;
//   · a shelf label, an unknown code, another company's label → not found,
//     said in words; nothing here writes.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () =>
  new Proxy({}, { get: () => () => Promise.resolve() }));
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve({ message: { _id: "m1" }, created: true }),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Barcode = require("../../models/CMS_Models/Inventory/Operations/Barcode");
const Employee = require("../../models/Employee");
require("../../models/ProjectManager");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { classifyScan } = require("../../services/mrfScanMatch.service");

let server, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}`;
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().catch(() => {})));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const tokenFor = (p) => jwt.sign(
  { id: String(p.emp._id), email: p.email, name: `${p.emp.firstName} ${p.emp.lastName}`, role: "employee", employeeId: p.emp.biometricId },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const scan = (who, code) =>
  fetch(`${root}/api/cms/inventory/mrf/data/raw-items/scan?code=${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${tokenFor(who)}` },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function world() {
  const co = await Acc_Company.create({ companyName: `Scan Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const other = await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const n = ++seq;
  const email = `scan${n}@test.example`;
  const emp = await Employee.create({ firstName: "Store", lastName: `L${n}`, email, biometricId: `SC${n}`, isActive: true, gender: "Other", department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Store" });
  const store = { emp, email };

  const button = await RawItem.create({
    name: `IMITATION Pearl Button ${n}`, sku: `BTN-${n}`, unit: "Pcs", quantity: 200, minStock: 0,
    variants: [{ combination: ["White", "18L"], sku: `BTN-${n}-18`, quantity: 100 }, { combination: ["White", "14L"], sku: `BTN-${n}-14`, quantity: 100 }],
  });
  const thread = await RawItem.create({ name: `Thread ${n}`, sku: `THR-${n}`, unit: "Cone", quantity: 50, minStock: 0 });
  /* two products whose variants were given one SKU — it happens (20 such on 14 Oct 2026) */
  const zipA = await RawItem.create({ name: `Zipper A ${n}`, sku: `ZPA-${n}`, unit: "Pcs", quantity: 5, minStock: 0, variants: [{ combination: ["Black"], sku: `ZIP-BLK-${n}`, quantity: 5 }] });
  const zipB = await RawItem.create({ name: `Zipper B ${n}`, sku: `ZPB-${n}`, unit: "Pcs", quantity: 5, minStock: 0, variants: [{ combination: ["Black"], sku: `zip-blk-${n}`, quantity: 5 }] });

  const v18 = button.variants[0];
  const label = await Barcode.create({
    rawItem: button._id, rawItemName: button.name, rawItemSku: button.sku,
    variantId: v18._id, variantCombination: v18.combination, variantSku: v18.sku, quantity: 24, unit: "Pcs",
  });
  const voided = await Barcode.create({
    rawItem: thread._id, rawItemName: thread.name, quantity: 3, unit: "Cone",
    identityState: "VOIDED", voidReason: "Printed twice",
  });
  const foreignItem = await RawItem.create({ name: `Foreign ${n}`, sku: `FRN-${n}`, unit: "Pcs", quantity: 1, minStock: 0, companyId: other._id });
  const foreignLabel = await Barcode.create({ rawItem: foreignItem._id, rawItemName: foreignItem.name, quantity: 1, unit: "Pcs", companyId: other._id });
  return { store, button, thread, zipA, zipB, label, voided, foreignItem, foreignLabel, v18: String(v18._id), n };
}

test("our raw-item label selects its material and its variant, in every form a scanner delivers", async () => {
  const w = await world();
  for (const code of [
    `itemid=${w.label._id}`,
    `RawItem=${w.label._id}`,
    `https://cms.grav.in/store/dashboard/item-info?itemid=${w.label._id}`,
    String(w.label._id).toUpperCase(),
  ]) {
    const res = await scan(w.store, code);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, found: true, via: "label", variantId: w.v18 });
    expect(String(res.body.rawItem._id)).toBe(String(w.button._id));
    expect(res.body.rawItem).toMatchObject({ name: w.button.name, baseUnit: "Pcs" });
    expect(res.body.rawItem.variants).toHaveLength(2);
    expect(res.body.label).toMatchObject({ quantity: 24, unit: "Pcs" });
  }
});

test("a voided label names nothing, and says why", async () => {
  const w = await world();
  const res = await scan(w.store, `itemid=${w.voided._id}`);
  expect(res.body).toMatchObject({ success: true, found: false, reason: "LABEL_VOIDED" });
  expect(res.body.message).toMatch(/voided — Printed twice/);
});

test("a raw item's own id selects it", async () => {
  const w = await world();
  const res = await scan(w.store, String(w.thread._id));
  expect(res.body).toMatchObject({ found: true, via: "item-id", variantId: null });
  expect(String(res.body.rawItem._id)).toBe(String(w.thread._id));
});

test("an exact item or variant SKU, case and spaces ignored", async () => {
  const w = await world();
  const item = await scan(w.store, `  thr-${w.n} `);
  expect(item.body).toMatchObject({ found: true, via: "item-sku", variantId: null });
  expect(String(item.body.rawItem._id)).toBe(String(w.thread._id));

  const variant = await scan(w.store, `btn-${w.n}-14`);
  expect(variant.body).toMatchObject({ found: true, via: "variant-sku", variantId: String(w.button.variants[1]._id) });

  /* a SKU is matched whole, never as part of a longer one */
  const partial = await scan(w.store, `BTN-${w.n}-1`);
  expect(partial.body).toMatchObject({ found: false, reason: "NOT_FOUND" });
});

test("a SKU two products carry is answered with both, never a guess", async () => {
  const w = await world();
  const res = await scan(w.store, `ZIP-BLK-${w.n}`);
  expect(res.body).toMatchObject({ success: true, found: false, reason: "AMBIGUOUS" });
  expect(res.body.candidates.map((c) => String(c.rawItem._id)).sort())
    .toEqual([String(w.zipA._id), String(w.zipB._id)].sort());
  expect(res.body.candidates.every((c) => c.variantId)).toBe(true);
  expect(res.body.message).toMatch(/SKU of 2 products/);
});

test("a shelf label, an unknown code and another company's label are not found, in words", async () => {
  const w = await world();
  const shelf = await scan(w.store, "loc=LOC-AB12CD34");
  expect(shelf.body).toMatchObject({ found: false, reason: "LOCATION_LABEL" });

  const unknown = await scan(w.store, "8901234567890");
  expect(unknown.body).toMatchObject({ found: false, reason: "NOT_FOUND" });
  expect(unknown.body.message).toMatch(/“8901234567890”/);

  const foreign = await scan(w.store, `itemid=${w.foreignLabel._id}`);
  expect(foreign.body).toMatchObject({ found: false, reason: "NOT_FOUND" });
  const foreignSku = await scan(w.store, `FRN-${w.n}`);
  expect(foreignSku.body).toMatchObject({ found: false, reason: "NOT_FOUND" });
});

test("an empty or odd code is refused cleanly, never a server error", async () => {
  const w = await world();
  expect((await scan(w.store, "  ")).status).toBe(400);
  const odd = await scan(w.store, "BTN(1*[");
  expect(odd.status).toBe(200);
  expect(odd.body).toMatchObject({ found: false, reason: "NOT_FOUND" });
});

test("classifyScan tells the kinds apart before anything is read", () => {
  expect(classifyScan("").kind).toBe("empty");
  expect(classifyScan("loc=LOC-1234ABCD").kind).toBe("location");
  expect(classifyScan("itemid=6a0c940189349d511bc8b65d")).toMatchObject({ kind: "label", id: "6a0c940189349d511bc8b65d" });
  expect(classifyScan("RAW-FAB-POP100COTWHICOT-HI-753")).toMatchObject({ kind: "code", code: "RAW-FAB-POP100COTWHICOT-HI-753" });
});
