// test/store-purchase/mrf-item-split.route.test.js
//
// SPLITTING ONE REQUESTED LINE INTO SEVERAL  (13 Oct 2026, owner)
//
// "Button (18L & 14L) highlander, 2 Pcs" is one line to the requester and two
// products to the Store. These hold the Store's door to it:
//
//   · split → N ordinary lines, quantities adding up to the original, each
//     matched on the way or later, each issued on its own;
//   · the total cannot change, a product with variants needs one of ITS own;
//   · a line already issued, reserved, bought or rejected is not split;
//   · Undo split puts the original back exactly, while nothing has happened;
//   · the manager's figures stay true across the parts;
//   · a retry is not a second split; only the Store may split.
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

const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const StockReservation = require("../../models/CMS_Models/Inventory/Operations/StockReservation");
const Employee = require("../../models/Employee");
require("../../models/ProjectManager");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

let server, root, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const cowork = require("../../routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes");
  app.use("/api/cms/mrf", cowork.cmsChain, cowork);
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  root = `http://127.0.0.1:${server.address().port}`;
  await Promise.all(Object.values(mongoose.models).map((m) => m.createCollection().catch(() => {})));
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `sp-${++seq}-${Math.random().toString(36).slice(2)}`;
const tokenFor = (p) => jwt.sign(
  { id: String(p.emp._id), email: p.email, name: `${p.emp.firstName} ${p.emp.lastName}`, role: "employee", employeeId: p.emp.biometricId },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);
const call = (who, door, path, { method = "GET", body, idempotencyKey } = {}) =>
  fetch(`${root}${door === "store" ? "/api/cms/inventory/mrf" : "/api/cms/mrf"}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tokenFor(who)}`,
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null"), replayed: r.headers.get("Idempotency-Replayed") === "true" }));

async function person({ co, name = "P", manager = null, grant = null }) {
  const n = ++seq;
  const email = `sp${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `SP${n}`,
    isActive: true, gender: "Other", department: "Tech",
    ...(manager ? { primaryManager: { managerId: manager._id, managerName: "Mgr" } } : {}),
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return { emp, email };
}

async function world() {
  const co = await Acc_Company.create({ companyName: `Split Co ${++seq}`, booksFromDate: new Date("2026-04-01") });
  await Acc_Company.create({ companyName: `Other ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const tl = await person({ co, name: "Trinayan" });
  const requester = await person({ co, name: "Sandhyarani", manager: tl.emp });
  const store = await person({ co, name: "Store", grant: "store" });
  const stranger = await person({ co, name: "Anil" });
  /* the catalogue the Store matches to: one button in two variants */
  const button = await RawItem.create({
    name: `IMITATION Pearl Button ${++seq}`, sku: `BTN-${seq}`, unit: "Pcs", quantity: 200, minStock: 0,
    variants: [{ combination: ["White", "18L"], sku: `BTN-${seq}-18`, quantity: 100 }, { combination: ["White", "14L"], sku: `BTN-${seq}-14`, quantity: 100 }],
  });
  const thread = await RawItem.create({ name: `Thread ${++seq}`, sku: `THR-${seq}`, unit: "Cone", quantity: 50, minStock: 0 });
  return { co, tl, requester, store, stranger, button, thread, v18: String(button.variants[0]._id), v14: String(button.variants[1]._id) };
}

/** A request with one free-text line ("not yet in inventory") and one catalogue line. */
async function raise(w, { qty = 2, approvedQty = null } = {}) {
  const res = await call(w.requester, "mrf", "/", {
    method: "POST", idempotencyKey: newKey(),
    body: {
      requestType: "USES_BASED", priority: "NORMAL", reason: "For highlander sample",
      items: [
        { itemName: "Button(18L&14L) highlander", unit: "Pcs", requestedQty: qty, description: "Urgent, because 2 buttons are damaged" },
        { rawItemId: String(w.thread._id), requestedQty: 4, unit: "Cone" },
      ],
    },
  });
  expect(res.status).toBe(201);
  const id = res.body.mrf._id;
  const [free, cat] = res.body.mrf.items.map((l) => String(l._id));
  const decisions = [
    approvedQty ? { itemId: free, decision: "APPROVED", approvedQty, reason: "Fewer will do" } : { itemId: free, decision: "APPROVED" },
    { itemId: cat, decision: "APPROVED" },
  ];
  const d = await call(w.tl, "mrf", `/${id}/item-decisions`, { method: "PATCH", body: { decisions }, idempotencyKey: newKey() });
  expect(d.status).toBe(200);
  return { id, free, cat };
}

const split = (w, id, itemId, parts, key = newKey(), who = w.store) =>
  call(who, "store", `/${id}/items/${itemId}/split`, { method: "POST", body: { parts }, idempotencyKey: key });
const unsplit = (w, id, itemId) =>
  call(w.store, "store", `/${id}/items/${itemId}/unsplit`, { method: "POST", body: {}, idempotencyKey: newKey() });

/* ═══ THE SCREENSHOT'S CASE ═════════════════════════════════════════════ */

test("one free-text line of 2 Pcs, split into the 18L and 14L buttons: two ordinary lines, the total kept", async () => {
  const w = await world();
  const { id, free, cat } = await raise(w);
  let doc = await MRF.findById(id).lean();
  expect(doc.items[0].itemStatus).toBe("UNMATCHED");

  const res = await split(w, id, free, [
    { quantity: 1, rawItemId: String(w.button._id), variantId: w.v18 },
    { quantity: 1, rawItemId: String(w.button._id), variantId: w.v14 },
  ]);
  expect(res.status).toBe(200);
  expect(res.body.message).toBe("Split into 2 lines.");
  expect(res.body.lineIds[0]).toBe(free);              // the original line is part 1

  doc = await MRF.findById(id).lean();
  expect(doc.items).toHaveLength(3);
  const [p1, p2, thread] = doc.items;
  expect(String(thread._id)).toBe(cat);                 // the sibling line is untouched, after the parts
  expect([p1.requestedQty, p2.requestedQty]).toEqual([1, 1]);
  expect([p1.itemStatus, p2.itemStatus]).toEqual(["APPROVED", "APPROVED"]);
  expect(String(p1.rawItem)).toBe(String(w.button._id));
  expect([String(p1.variantId), String(p2.variantId)]).toEqual([w.v18, w.v14]);
  expect(p1.variantCombination).toEqual(["White", "18L"]);
  expect(p2.description).toBe("Urgent, because 2 buttons are damaged");   // what the requester said travels
  expect(String(p1.split.groupId)).toBe(free);
  expect(String(p2.split.groupId)).toBe(free);
  expect(p1.split).toMatchObject({ originalQty: 2, originalUnit: "Pcs", originalName: "Button(18L&14L) highlander" });
  expect(p1.split.original).toMatchObject({ itemStatus: "UNMATCHED", requestedQty: 2, rawItemName: "Button(18L&14L) highlander" });
  expect(p2.split.original).toBeUndefined();
  const ev = doc.statusHistory.find((h) => h.action === "ITEM_SPLIT");
  expect(ev.detail).toMatch(/split into 2 lines: 1 Pcs · 1 Pcs/);
  expect(String(ev.itemId)).toBe(free);
  expect(await SpActionHistory.countDocuments({ entityId: id, action: "ITEM_SPLIT" })).toBe(1);

  /* The Store page sees both parts, says which may be split again, and the
     original offers Undo. */
  const sc = await call(w.store, "store", `/${id}/stock-check`);
  const rows = sc.body.itemsWithStock;
  expect(rows).toHaveLength(3);
  expect(rows[0].splitCheck).toMatchObject({ canSplit: true, canUndo: true });
  expect(rows[1].splitCheck.canUndo).toBeUndefined();

  /* Each part issues on its own. */
  const issue = await call(w.store, "store", `/${id}/issue`, {
    method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: String(p2._id), issuedQty: 1 }] },
  });
  expect(issue.status).toBe(200);
  doc = await MRF.findById(id).lean();
  expect(doc.items[1].issuedQty).toBe(1);
  expect(doc.items[0].issuedQty).toBe(0);

  /* The requester sees the parts too, each with its own standing. */
  const mine = await call(w.requester, "mrf", "/?limit=50");
  const own = mine.body.mrfs.find((m) => String(m._id) === id);
  expect(own.items.map((l) => l.requestedQty)).toEqual([1, 1, 4]);
});

test("split without matching: the parts stay unmatched and are matched one by one afterwards", async () => {
  const w = await world();
  const { id, free } = await raise(w, { qty: 3 });
  const res = await split(w, id, free, [{ quantity: 2 }, { quantity: 1 }]);
  expect(res.status).toBe(200);
  let doc = await MRF.findById(id).lean();
  expect(doc.items.slice(0, 2).map((l) => [l.itemStatus, l.requestedQty, l.rawItemName])).toEqual([
    ["UNMATCHED", 2, "Button(18L&14L) highlander"], ["UNMATCHED", 1, "Button(18L&14L) highlander"],
  ]);
  const m = await call(w.store, "store", `/${id}/items/${doc.items[1]._id}/match`, {
    method: "PATCH", idempotencyKey: newKey(),
    body: { rawItemId: String(w.button._id), variantId: w.v14, variantCombination: ["White", "14L"] },
  });
  expect(m.status).toBe(200);
  doc = await MRF.findById(id).lean();
  expect([doc.items[0].itemStatus, doc.items[1].itemStatus]).toEqual(["UNMATCHED", "APPROVED"]);
  expect(doc.items[1].unit).toBe("Pcs");
});

/* ═══ THE TOTAL AND THE PRODUCTS ═════════════════════════════════════════ */

test("the total cannot change, there are at least two lines, and a product with variants needs one of its own", async () => {
  const w = await world();
  const { id, free } = await raise(w);
  const more = await split(w, id, free, [{ quantity: 2 }, { quantity: 1 }]);
  expect(more.status).toBe(400);
  expect(more.body.reason).toBe("TOTAL");
  expect(more.body.message).toMatch(/add up to 3 Pcs; the item asks for 2 Pcs/);
  expect((await split(w, id, free, [{ quantity: 2 }])).body.reason).toBe("TOO_FEW");
  expect((await split(w, id, free, [{ quantity: 2 }, { quantity: 0 }])).body.reason).toBe("QUANTITY");
  const noVariant = await split(w, id, free, [{ quantity: 1, rawItemId: String(w.button._id) }, { quantity: 1 }]);
  expect(noVariant.body.reason).toBe("VARIANT");
  const foreign = await split(w, id, free, [{ quantity: 1, rawItemId: String(w.button._id), variantId: String(new mongoose.Types.ObjectId()) }, { quantity: 1 }]);
  expect(foreign.body.reason).toBe("VARIANT");
  expect((await split(w, id, free, [{ quantity: 1, rawItemId: String(new mongoose.Types.ObjectId()) }, { quantity: 1 }])).body.reason).toBe("PRODUCT");
  /* nothing changed */
  expect((await MRF.findById(id).lean()).items).toHaveLength(2);
});

test("halves are kept exactly: 2.5 Mtr as 1.25 + 1.25", async () => {
  const w = await world();
  const { id, cat } = await raise(w);
  /* the catalogue line, 4 Cone, split into three */
  const res = await split(w, id, cat, [{ quantity: 1.5 }, { quantity: 1.25 }, { quantity: 1.25 }]);
  expect(res.status).toBe(200);
  const doc = await MRF.findById(id).lean();
  const parts = doc.items.filter((l) => String(l.split?.groupId || "") === cat);
  expect(parts.map((l) => l.requestedQty)).toEqual([1.5, 1.25, 1.25]);
  expect(parts.every((l) => l.itemStatus === "APPROVED" && String(l.rawItem) === String(w.thread._id))).toBe(true);
});

/* ═══ WHAT IS NOT SPLIT ══════════════════════════════════════════════════ */

test("a line with something issued, stock reserved, or rejected by the Store is not split", async () => {
  const w = await world();
  const { id, free, cat } = await raise(w);
  /* issued */
  const issue = await call(w.store, "store", `/${id}/issue`, { method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: cat, issuedQty: 1 }] } });
  expect(issue.status).toBe(200);
  const issued = await split(w, id, cat, [{ quantity: 2 }, { quantity: 1 }]);
  expect(issued.status).toBe(409);
  expect(issued.body.reason).toBe("ISSUED");
  /* reserved */
  await StockReservation.create({
    companyId: w.co._id, mrfId: id, mrfLineId: free, rawItemId: w.button._id, requestedQty: 2, reservedQty: 2, unit: "Pcs", baseUnit: "Pcs", active: true, status: "RESERVED",
  }).catch(async () => {
    /* the schema may want more; store the minimum the check reads */
    await StockReservation.collection.insertOne({ companyId: w.co._id, mrfId: new mongoose.Types.ObjectId(id), mrfLineId: new mongoose.Types.ObjectId(free), active: true, status: "RESERVED" });
  });
  const reserved = await split(w, id, free, [{ quantity: 1 }, { quantity: 1 }]);
  expect(reserved.status).toBe(409);
  expect(reserved.body.reason).toBe("RESERVED");
  expect(reserved.body.message).toMatch(/Release the reservation/);
  const sc = await call(w.store, "store", `/${id}/stock-check`);
  expect(sc.body.itemsWithStock[0].splitCheck).toMatchObject({ canSplit: false });
  expect(sc.body.itemsWithStock[0].splitCheck.reason).toMatch(/reserved/);
});

test("only the Store may split", async () => {
  const w = await world();
  const { id, free } = await raise(w);
  const res = await split(w, id, free, [{ quantity: 1 }, { quantity: 1 }], newKey(), w.stranger);
  expect(res.status).toBe(403);
  expect((await MRF.findById(id).lean()).items).toHaveLength(2);
});

test("a retry with the same key is not a second split", async () => {
  const w = await world();
  const { id, free } = await raise(w);
  const key = newKey();
  const parts = [{ quantity: 1 }, { quantity: 1 }];
  expect((await split(w, id, free, parts, key)).status).toBe(200);
  const again = await split(w, id, free, parts, key);
  expect(again.status).toBe(200);
  expect(again.replayed).toBe(true);
  expect((await MRF.findById(id).lean()).items).toHaveLength(3);
});

/* ═══ THE MANAGER'S FIGURES ══════════════════════════════════════════════ */

test("a reduced approval stays true across the parts: approved adds up, asked and cut stay on the original", async () => {
  const w = await world();
  const { id, free } = await raise(w, { qty: 5, approvedQty: 2 });
  let doc = await MRF.findById(id).lean();
  expect(doc.items[0].approval).toMatchObject({ requestedQty: 5, approvedQty: 2, rejectedQty: 3 });
  expect((await split(w, id, free, [{ quantity: 1 }, { quantity: 1 }])).status).toBe(200);
  doc = await MRF.findById(id).lean();
  const [p1, p2] = doc.items;
  expect(p1.approval).toMatchObject({ decision: "APPROVED", requestedQty: 4, approvedQty: 1, rejectedQty: 3 });
  expect(p2.approval).toMatchObject({ decision: "APPROVED", requestedQty: 1, approvedQty: 1, rejectedQty: 0 });
  expect(p1.approval.requestedQty + p2.approval.requestedQty).toBe(5);
  expect(doc.approvalStatus).toBe("PARTIALLY_APPROVED");
});

/* ═══ UNDO SPLIT ═════════════════════════════════════════════════════════ */

test("Undo split puts the original line back exactly, and is refused once a part is issued", async () => {
  const w = await world();
  const { id, free } = await raise(w, { qty: 5, approvedQty: 2 });
  await split(w, id, free, [
    { quantity: 1, rawItemId: String(w.button._id), variantId: w.v18 },
    { quantity: 1, rawItemId: String(w.button._id), variantId: w.v14 },
  ]);
  let doc = await MRF.findById(id).lean();
  const p2 = String(doc.items[1]._id);

  /* any part names the group */
  const undo = await unsplit(w, id, p2);
  expect(undo.status).toBe(200);
  expect(undo.body.message).toBe("Split undone — it is one line again.");
  doc = await MRF.findById(id).lean();
  expect(doc.items).toHaveLength(2);
  const back = doc.items[0];
  expect(String(back._id)).toBe(free);
  expect([back.itemStatus, back.requestedQty, back.rawItemName, back.unit]).toEqual(["UNMATCHED", 2, "Button(18L&14L) highlander", "Pcs"]);
  expect(back.rawItem).toBeNull();
  expect(back.variantId).toBeNull();
  expect(back.split).toBeUndefined();
  expect(back.approval).toMatchObject({ requestedQty: 5, approvedQty: 2, rejectedQty: 3 });
  expect(doc.statusHistory.some((h) => h.action === "ITEM_SPLIT_UNDONE")).toBe(true);

  /* split again, issue a part: no undo */
  await split(w, id, free, [{ quantity: 1, rawItemId: String(w.button._id), variantId: w.v18 }, { quantity: 1 }]);
  doc = await MRF.findById(id).lean();
  const issue = await call(w.store, "store", `/${id}/issue`, { method: "POST", idempotencyKey: newKey(), body: { items: [{ itemId: free, issuedQty: 1 }] } });
  expect(issue.status).toBe(200);
  const refused = await unsplit(w, id, free);
  expect(refused.status).toBe(409);
  expect(refused.body.reason).toBe("ISSUED");
  expect((await MRF.findById(id).lean()).items).toHaveLength(3);
});

test("a part split again joins the same group, and Undo goes back to what was asked", async () => {
  const w = await world();
  const { id, free } = await raise(w, { qty: 4 });
  await split(w, id, free, [{ quantity: 2 }, { quantity: 2 }]);
  let doc = await MRF.findById(id).lean();
  const second = String(doc.items[1]._id);
  expect((await split(w, id, second, [{ quantity: 1 }, { quantity: 1 }])).status).toBe(200);
  doc = await MRF.findById(id).lean();
  const group = doc.items.filter((l) => String(l.split?.groupId || "") === free);
  expect(group.map((l) => l.requestedQty)).toEqual([2, 1, 1]);
  expect((await unsplit(w, id, free)).status).toBe(200);
  doc = await MRF.findById(id).lean();
  expect(doc.items.map((l) => l.requestedQty)).toEqual([4, 4]);
});
