// test/store-purchase/mrf-location-rollback.replset.test.js
//
// Warehouse Stock V1 — PROVES an MRF issue is truly atomic on a replica set.
// The guarded LocationBalance decrement, the assigned-total change, the RawItem
// save, the LocationMovement and the MRF issue figures now all commit in ONE
// transaction (the session is threaded through every write). A failure at ANY
// step — after the location decrement, after the RawItem save, while writing the
// movement, or on the second line of a multi-line issue — must roll back EVERY
// one of them, leaving nothing half-applied.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {} }));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return {
    submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop,
    tlApproved: noop, tlRejected: noop, issued: noop, unfulfilled: noop, returned: noop,
    productRequestChatMessage: noop, productRequestTlApproved: noop, productRequestTlRejected: noop,
  };
});
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve(null),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const LocationMovement = require("../../models/CMS_Models/Inventory/Operations/LocationMovement");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const Employee = require("../../models/Employee");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const locStock = require("../../services/storePurchase/locationStock.service");
const unitOfWork = require("../../services/storePurchase/unitOfWork.service");

// A MongoError the driver's withTransaction will treat as transient — so it
// RERUNS the whole mutate callback, exactly as a real write conflict / election
// would. Thrown once, then the spy delegates to the real create.
function transientError() {
  const e = new mongoose.mongo.MongoServerError({ message: "injected transient write conflict" });
  e.addErrorLabel("TransientTransactionError");
  return e;
}
function throwTransientOnce(Model) {
  const orig = Model.create.bind(Model);
  let calls = 0;
  jest.spyOn(Model, "create").mockImplementation((docs, opts) => {
    calls += 1;
    if (calls === 1) throw transientError();
    return orig(docs, opts);
  });
  return () => calls;
}

let rs, server, base, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "mrf_rollback" });
  unitOfWork.__setTransactionSupport(null); // re-probe against the replica set

  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/mrf", require("../../routes/CMS_Routes/Inventory/Operations/mrfRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/mrf`;
}, 180000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
  jest.restoreAllMocks();
});

let idemSeq = 0;
const newKey = () => `mr-${++idemSeq}`;
const call = (emp, path, { method = "GET", body, key } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json", ...(key ? { "Idempotency-Key": key } : {}),
      Authorization: `Bearer ${jwt.sign(
        { id: String(emp._id), role: "employee", employeeId: emp.biometricId, name: "St", email: emp.email },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const person = (o) => Employee.create({ isActive: true, gender: "Other", department: "Tech", ...o });

async function seedLoc(company, wh, loc, raw, qty, variantId = null) {
  await locStock.applyLocationIn(null, {
    companyId: company._id, siteId: null, item: raw, variantId,
    warehouse: wh, location: loc, quantity: qty, type: "receipt", intent: "receive",
    source: { kind: "seed" }, actor: {}, note: "seed", idempotencyKey: "",
  });
}

/** MRF (APPROVED, TL-approved) for a store actor, with `lines` PO-style items. */
async function seed({ lines }) {
  const n = ++seq;
  const company = await Acc_Company.create({ companyName: `Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const tl = await person({ firstName: "Meera", lastName: `L${n}`, email: `tl${n}@x.example`, biometricId: `TL${n}` });
  const emp = await person({ firstName: "Rutu", lastName: `T${n}`, email: `tc${n}@x.example`, biometricId: `TC${n}`, primaryManager: { managerId: tl._id } });
  const store = await person({ firstName: "Bikash", lastName: `S${n}`, email: `st${n}@x.example`, biometricId: `ST${n}`, department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email: store.email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email: store.email, employeeRef: store._id, personName: "B" });

  const wh = await Warehouse.create({
    companyId: company._id, name: `WH ${n}`, shortName: `W${n}${Date.now() % 1000}`, status: "Active",
    locations: [
      { code: "A1", name: "Rack A", type: "USABLE_STOCK", status: "Active" },
      { code: "B1", name: "Rack B", type: "USABLE_STOCK", status: "Active" },
    ],
  });
  const [locA, locB] = wh.locations;

  const raws = [];
  const mrfItems = [];
  for (const ln of lines) {
    const raw = await RawItem.create({ name: `Item ${n}-${raws.length}`, sku: `IT-${n}-${raws.length}`, unit: "pcs", quantity: ln.stock, minStock: 0 });
    await seedLoc(company, wh, locA, raw, ln.stock);
    raws.push(raw);
    mrfItems.push({ rawItem: raw._id, rawItemName: raw.name, rawItemSku: raw.sku, requestedQty: ln.req, unit: "pcs", baseUnit: "pcs", itemStatus: "APPROVED", availability: "UNREVIEWED" });
  }

  const mrf = await MRF.create({
    mrfNumber: `MRF/2026-27/${String(++seq).padStart(4, "0")}`, companyId: company._id,
    requestedFor: emp._id, requestedForName: "Rutu", requestedForDept: "Tech", requestedForId: emp.biometricId,
    requestType: "USES_BASED", status: "APPROVED", createdByRef: emp._id, createdByModel: "Employee", createdByName: "Rutu",
    reason: "r", approverEmployee: tl._id, approverName: "Meera", approverBiometricId: tl.biometricId,
    tlApproved: true, tlApprovedBy: tl._id, tlApprovedByName: "Meera", tlApprovedAt: new Date(),
    items: mrfItems,
  });
  return { company, store, wh, locA, locB, raws, mrf };
}

const onHand = (s, raw) => locStock.locationOnHand(null, s.company._id, raw._id, null, s.wh._id, s.locA._id);

const issue = (s, items, key = newKey()) =>
  call(s.store, `/${s.mrf._id}/issue`, {
    method: "POST", key,
    body: { items: items.map((it, i) => ({ itemId: String(s.mrf.items[i]._id), issuedQty: it.qty, warehouseId: String(s.wh._id), locationId: String(s.locA._id) })) },
  });

async function assertUntouched(s) {
  for (const raw of s.raws) {
    expect((await RawItem.findById(raw._id).lean()).quantity).toBe(40);
    expect(await onHand(s, raw)).toBe(40);
    expect(await LocationMovement.countDocuments({ itemId: raw._id, type: "issue" })).toBe(0);
    expect(await LocationBalance.findOne(locStock.locFilter(s.company._id, raw._id, null, s.wh._id, s.locA._id)).lean().then((b) => b.onHand)).toBe(40);
  }
  const mrf = await MRF.findById(s.mrf._id).lean();
  for (const it of mrf.items) expect(it.issuedQty || 0).toBe(0);
  expect(["APPROVED"]).toContain(mrf.status);
}

test("transactional mode is active on the replica set", async () => {
  expect(await unitOfWork.transactionsAvailable()).toBe(true);
});

test("no failure — the issue commits location, company stock, movement and MRF together", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  const r = await issue(s, [{ qty: 10 }]);
  expect(r.status).toBe(200);
  expect(await onHand(s, s.raws[0])).toBe(30);
  expect((await RawItem.findById(s.raws[0]._id).lean()).quantity).toBe(30);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "issue" })).toBe(1);
  expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty).toBe(10);
});

test("failure while writing the LocationMovement rolls back everything", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("inject: movement write"); });
  const r = await issue(s, [{ qty: 10 }]);
  expect(r.status).toBeGreaterThanOrEqual(400);
  await assertUntouched(s);
});

test("failure after the location decrement (RawItem save throws) rolls back everything", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  jest.spyOn(RawItem.prototype, "save").mockImplementationOnce(function () { throw new Error("inject: rawitem save"); });
  const r = await issue(s, [{ qty: 10 }]);
  expect(r.status).toBeGreaterThanOrEqual(400);
  await assertUntouched(s);
});

test("failure changing the assigned-total (after RawItem save) rolls back everything", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  jest.spyOn(locStock, "incAssignedTotal").mockImplementationOnce(() => { throw new Error("inject: assigned total"); });
  const r = await issue(s, [{ qty: 10 }]);
  expect(r.status).toBeGreaterThanOrEqual(400);
  await assertUntouched(s);
});

test("a two-line issue that fails on the SECOND line rolls back the first line too", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }, { stock: 40, req: 10 }] });
  const orig = LocationMovement.create.bind(LocationMovement);
  let calls = 0;
  jest.spyOn(LocationMovement, "create").mockImplementation((docs, opts) => {
    calls += 1;
    if (calls >= 2) throw new Error("inject: second line movement");
    return orig(docs, opts);
  });
  const r = await issue(s, [{ qty: 10 }, { qty: 10 }]);
  expect(r.status).toBeGreaterThanOrEqual(400);
  await assertUntouched(s); // BOTH lines, including the one that "succeeded"
});

// ── the RETURN path is atomic too ────────────────────────────────────────────

const bOnHand = (s) => locStock.locationOnHand(null, s.company._id, s.raws[0]._id, null, s.wh._id, s.locB._id);
const doReturn = (s, qty, key = newKey()) =>
  call(s.store, `/${s.mrf._id}/items/${s.mrf.items[0]._id}/return`, {
    method: "POST", key,
    body: { returnedQty: qty, warehouseId: String(s.wh._id), locationId: String(s.locB._id) },
  });

async function issuedState() {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  expect((await issue(s, [{ qty: 10 }])).status).toBe(200); // A1 → 30, 10 issued
  return s;
}

test("no failure — a return credits the chosen destination and the MRF once", async () => {
  const s = await issuedState();
  const r = await doReturn(s, 4);
  expect(r.status).toBe(200);
  expect(await bOnHand(s)).toBe(4); // exactly once (not doubled by a retry)
  expect((await RawItem.findById(s.raws[0]._id).lean()).quantity).toBe(34);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "return" })).toBe(1);
  expect((await MRF.findById(s.mrf._id).lean()).items[0].returnedQty).toBe(4);
});

test("a return whose movement write fails rolls back the credit and the MRF", async () => {
  const s = await issuedState();
  jest.spyOn(LocationMovement, "create").mockImplementationOnce(() => { throw new Error("inject: return movement"); });
  const r = await doReturn(s, 4);
  expect(r.status).toBeGreaterThanOrEqual(400);
  // credit rolled back: company back to 30, B1 still empty, no return movement/qty
  expect((await RawItem.findById(s.raws[0]._id).lean()).quantity).toBe(30);
  expect(await bOnHand(s)).toBe(0);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "return" })).toBe(0);
  expect((await MRF.findById(s.mrf._id).lean()).items[0].returnedQty).toBe(0);
});

// ── the marker/transaction boundary ──────────────────────────────────────────

const decide = (s, body, key = newKey()) =>
  call(s.store, `/${s.mrf._id}/fulfilment-decision`, { method: "POST", key, body });

test("a forced transaction failure rolls back the MARKER too, and retrying the key then issues normally", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  const key = newKey();

  // A hard (non-transient) failure: withTransaction does NOT retry it, the whole
  // request fails, everything — INCLUDING the effect marker — rolls back.
  const spy = jest.spyOn(LocationMovement, "create").mockImplementation(() => { throw new Error("inject: hard fail"); });
  const first = await issue(s, [{ qty: 10 }], key);
  expect(first.status).toBeGreaterThanOrEqual(400);
  await assertUntouched(s);

  // The marker did not survive the rollback — the record is not EFFECT_APPLIED.
  const rec = await SpIdempotencyRecord.findOne({ key });
  if (rec) {
    expect(rec.status).not.toBe("EFFECT_APPLIED");
    expect(rec.effectAppliedAt).toBeFalsy();
  }

  // Retrying the SAME key is a clean first attempt — a normal issue, NOT a false
  // "stock moved — reconciliation required" refusal.
  spy.mockRestore();
  const retry = await issue(s, [{ qty: 10 }], key);
  expect(retry.status).toBe(200);
  expect(retry.body.message).toMatch(/issued/i);
  expect(await onHand(s, s.raws[0])).toBe(30);
  expect((await RawItem.findById(s.raws[0]._id).lean()).quantity).toBe(30);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "issue" })).toBe(1);
  expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty).toBe(10);
});

test("a forced transient transaction RETRY finishes with exactly one issue, one movement, correct MRF", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  const countCalls = throwTransientOnce(LocationMovement); // rerun the callback once

  const r = await issue(s, [{ qty: 10 }]);
  expect(r.status).toBe(200);
  expect(countCalls()).toBeGreaterThanOrEqual(2); // the mutate callback re-ran

  // Fresh-load + absolute targets → exactly once, never doubled.
  expect(await onHand(s, s.raws[0])).toBe(30);
  expect((await RawItem.findById(s.raws[0]._id).lean()).quantity).toBe(30);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "issue" })).toBe(1);
  const mrf = await MRF.findById(s.mrf._id).lean();
  expect(mrf.items[0].issuedQty).toBe(10);          // one quantity, not 20
  expect(mrf.items[0].issueHistory).toHaveLength(1); // one history entry, not two
  expect(mrf.status).toBe("ISSUED");
});

test("a forced transient transaction RETRY on a RETURN finishes with exactly one credit and movement", async () => {
  const s = await issuedState(); // 10 issued, A1 → 30
  const countCalls = throwTransientOnce(LocationMovement);

  const r = await doReturn(s, 4);
  expect(r.status).toBe(200);
  expect(countCalls()).toBeGreaterThanOrEqual(2);

  expect(await bOnHand(s)).toBe(4); // credited exactly once
  expect((await RawItem.findById(s.raws[0]._id).lean()).quantity).toBe(34);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "return" })).toBe(1);
  const mrf = await MRF.findById(s.mrf._id).lean();
  expect(mrf.items[0].returnedQty).toBe(4);
  expect(mrf.items[0].returnHistory).toHaveLength(1);
});

test("AUTO-FULFILMENT: a forced transient retry issues exactly once", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  const countCalls = throwTransientOnce(LocationMovement);

  const r = await decide(s, {
    decision: "issue_from_stock",
    lines: [{ itemId: String(s.mrf.items[0]._id), issueQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }],
  });
  expect(r.status).toBe(200);
  expect(countCalls()).toBeGreaterThanOrEqual(2);

  expect(await onHand(s, s.raws[0])).toBe(30);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "issue" })).toBe(1);
  const mrf = await MRF.findById(s.mrf._id).lean();
  expect(mrf.items[0].issuedQty).toBe(10);
  expect(mrf.items[0].issueHistory).toHaveLength(1);
});

test("AUTO-FULFILMENT: a forced hard failure rolls back the marker, and a retry succeeds normally", async () => {
  const s = await seed({ lines: [{ stock: 40, req: 10 }] });
  const key = newKey();
  const body = {
    decision: "issue_from_stock",
    lines: [{ itemId: String(s.mrf.items[0]._id), issueQty: 10, warehouseId: String(s.wh._id), locationId: String(s.locA._id) }],
  };
  const spy = jest.spyOn(LocationMovement, "create").mockImplementation(() => { throw new Error("inject: hard fail"); });
  const first = await decide(s, body, key);
  expect(first.status).toBeGreaterThanOrEqual(400);
  await assertUntouched(s);
  const rec = await SpIdempotencyRecord.findOne({ key });
  if (rec) expect(rec.status).not.toBe("EFFECT_APPLIED");

  spy.mockRestore();
  const retry = await decide(s, body, key);
  expect(retry.status).toBe(200);
  expect(await onHand(s, s.raws[0])).toBe(30);
  expect(await LocationMovement.countDocuments({ itemId: s.raws[0]._id, type: "issue" })).toBe(1);
  expect((await MRF.findById(s.mrf._id).lean()).items[0].issuedQty).toBe(10);
});
