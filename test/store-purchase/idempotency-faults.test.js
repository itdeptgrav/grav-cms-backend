// test/store-purchase/idempotency-faults.test.js
//
// Store & Purchase — Chunk 1. WHAT HAPPENS WHEN IT BREAKS MID-WAY.
//
// Entry-level idempotency (one key, one claim) is the easy half. The half
// that actually protects the business is what happens when the request dies
// AFTER the mutation has committed:
//
//     stock moves → history write fails → HTTP 500
//     → idempotency record marked FAILED → retry re-runs the receipt
//     → stock moves a SECOND time for one delivery
//
// Every test here injects a failure at a different point and then retries the
// exact request a client would retry, and asserts the same four things:
// ONE order, ONE receipt, ONE stock effect, ONE history event.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../services/VendorEmailService", () => ({
  sendPurchaseOrderEmail: jest.fn(() => Promise.resolve()),
}));
jest.mock("../../services/NotificationService", () => ({
  sendToRole: jest.fn(() => Promise.resolve()),
  sendToUser: jest.fn(() => Promise.resolve()),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
const SpApprovalPolicy = require("../../models/CMS_Models/StorePurchase/SpApprovalPolicy");
const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
const actionHistory = require("../../services/storePurchase/actionHistory.service");
const idempotency = require("../../services/storePurchase/idempotency.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cms/inventory/operations/purchase-orders",
    require("../../routes/CMS_Routes/Inventory/Operations/purchaseOrders"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const OPS = "/api/cms/inventory/operations/purchase-orders";

const call = (path, { method = "GET", body, token, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({
    status: r.status,
    body: JSON.parse((await r.text()) || "null"),
    replayed: r.headers.get("Idempotency-Replayed") === "true",
    recovered: r.headers.get("Idempotency-Recovered") === "true",
  }));

/** A company with an approval policy, a member who may do everything, stock. */
async function world({ stockQty = 0 } = {}) {
  const n = ++seq;
  const company = await Acc_Company.create({
    companyName: `Fault Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  await SpApprovalPolicy.create({
    companyId: company._id, documentType: "PURCHASE_ORDER", minAmount: 0, maxAmount: null,
    levels: [{ level: 1, requiredCapability: "sp.po.issue" }],
  });
  const email = `fault${n}@test.example`;
  const employeeRef = new mongoose.Types.ObjectId();
  await DepartmentRole.create({ departmentSlug: "store", email, role: "owner", isActive: true });
  await SpCompanyMembership.create({ companyId: company._id, email, employeeRef });
  const token = jwt.sign(
    { id: String(employeeRef), email, name: "Fault Tester", role: "store_manager" },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );
  const vendor = await Vendor.create({
    companyName: `V${n}`, contactPerson: "V", phone: "9", status: "Active",
  });
  const raw = await RawItem.create({
    name: `Canvas ${n}`, sku: `CNV-F${n}`, unit: "pcs", quantity: stockQty, minStock: 0,
  });
  return { company, token, vendor, raw };
}

const poBody = ({ vendor, raw }) => ({
  vendor: String(vendor._id),
  vendorName: vendor.companyName,
  items: [{ rawItem: String(raw._id), itemName: raw.name, quantity: 100, unitPrice: 5, unit: "pcs" }],
});

const key = () => `fault-${++seq}-${Math.random().toString(36).slice(2)}`;

/** Create and issue an order, ready to receive against. */
async function issuedOrder(w) {
  const created = await call(OPS, {
    method: "POST", body: poBody(w), token: w.token, idempotencyKey: key(),
  });
  expect(created.status).toBe(201);
  const id = created.body.purchaseOrder._id;
  const issued = await call(`${OPS}/${id}/status`, {
    method: "PATCH", body: { status: "ISSUED" }, token: w.token, idempotencyKey: key(),
  });
  expect(issued.status).toBe(200);
  const read = await call(`${OPS}/${id}`, { token: w.token });
  return read.body.purchaseOrder;
}

/* ═══ 1 · FAILURE AFTER THE MUTATION, BEFORE HISTORY ═════════════════════ */

test("receipt: a failure after stock moves does not let the retry move it again", async () => {
  const w = await world({ stockQty: 0 });
  const po = await issuedOrder(w);
  const k = key();
  const body = { items: [{ itemId: po.items[0]._id, quantity: 100 }], invoiceNumber: "INV-1" };

  /* Break the history write — the exact gap the old code left open: the
     stock had already moved and the PO had already saved. */
  const spy = jest.spyOn(actionHistory, "record").mockImplementation(async (ctx, entry) => {
    if (entry.action === "RECEIVED") throw new Error("history unavailable");
    return null;
  });

  const first = await call(`${OPS}/${po._id}/receive`, {
    method: "POST", body, token: w.token, idempotencyKey: k,
  });
  expect(first.status).toBe(500);
  spy.mockRestore();

  // The stock DID move — that is the premise, not a defect.
  expect((await RawItem.findById(w.raw._id).lean()).quantity).toBe(100);
  // …and the claim was NOT released, because the effect had landed.
  const record = await SpIdempotencyRecord.findOne({ key: k }).lean();
  expect(record.status).toBe("EFFECT_APPLIED");

  // The retry a client would make.
  const retry = await call(`${OPS}/${po._id}/receive`, {
    method: "POST", body, token: w.token, idempotencyKey: k,
  });
  expect(retry.status).toBe(200);
  expect(retry.recovered).toBe(true);

  // ONE of everything.
  const raw = await RawItem.findById(w.raw._id).lean();
  expect(raw.quantity).toBe(100);                    // not 200
  expect(raw.stockTransactions).toHaveLength(1);     // one movement
  const after = await PurchaseOrder.findById(po._id).lean();
  expect(after.deliveries).toHaveLength(1);          // one receipt
  expect(after.totalReceived).toBe(100);
  expect(await SpActionHistory.countDocuments({ entityId: po._id, action: "RECEIVED" })).toBe(1);
});

/* ═══ 2 · FAILURE AFTER STOCK MOVED, BEFORE THE PO SAVED ════════════════ */

test("receipt: a failure between the stock movement and the order save cannot double the stock", async () => {
  const w = await world({ stockQty: 0 });
  const po = await issuedOrder(w);
  const k = key();
  const body = { items: [{ itemId: po.items[0]._id, quantity: 60 }] };

  /* Fail the ORDER save, after the RawItem writes have already committed —
     the interrupted-receive shape Chunk 0 documented. */
  const realSave = PurchaseOrder.prototype.save;
  let broke = false;
  jest.spyOn(PurchaseOrder.prototype, "save").mockImplementation(async function (...args) {
    if (!broke && this.deliveries?.length) { broke = true; throw new Error("order save failed"); }
    return realSave.apply(this, args);
  });

  const first = await call(`${OPS}/${po._id}/receive`, {
    method: "POST", body, token: w.token, idempotencyKey: k,
  });
  expect(first.status).toBe(500);
  jest.restoreAllMocks();

  const stockAfterFailure = (await RawItem.findById(w.raw._id).lean()).quantity;

  const retry = await call(`${OPS}/${po._id}/receive`, {
    method: "POST", body, token: w.token, idempotencyKey: k,
  });

  /* The retry must NOT move stock again. Where the order never recorded the
     delivery, the honest answer is a refusal naming the inconsistency — not
     a silent repeat and not a false success. */
  expect(retry.status).toBe(409);
  expect(retry.body.error.details.reason).toBe("PARTIAL_RECEIPT_NEEDS_RECONCILIATION");

  const raw = await RawItem.findById(w.raw._id).lean();
  expect(raw.quantity).toBe(stockAfterFailure);      // never doubled
  expect(raw.stockTransactions).toHaveLength(1);     // one movement only

  /* And the inconsistency is recorded for somebody to act on, rather than
     living only in a log line. */
  expect(await SpActionHistory.countDocuments({
    entityId: po._id, action: "RECEIPT_RECONCILIATION_REQUIRED",
  })).toBe(1);
});

/* ═══ 3 · FAILURE AFTER HISTORY, BEFORE THE RESPONSE PERSISTED ══════════ */

test("create: a failure after history does not create a second order on retry", async () => {
  const w = await world();
  const k = key();
  const body = poBody(w);

  /* Break the idempotency COMPLETION — history is written, the order exists,
     and the response never gets recorded. */
  const spy = jest.spyOn(idempotency, "complete").mockRejectedValueOnce(new Error("completion failed"));

  const first = await call(OPS, { method: "POST", body, token: w.token, idempotencyKey: k });
  expect(first.status).toBe(500);
  spy.mockRestore();

  expect(await PurchaseOrder.countDocuments({ companyId: w.company._id })).toBe(1);

  const retry = await call(OPS, { method: "POST", body, token: w.token, idempotencyKey: k });
  expect([200, 201]).toContain(retry.status);

  // Still exactly one order and one CREATED event.
  expect(await PurchaseOrder.countDocuments({ companyId: w.company._id })).toBe(1);
  expect(await SpActionHistory.countDocuments({
    companyId: w.company._id, action: "CREATED",
  })).toBe(1);
});

/* ═══ 4 · A CRASHED REQUEST MUST NOT LOCK THE ACTION ════════════════════ */

test("a stale IN_PROGRESS claim with no effect is reclaimed, not locked for 30 days", async () => {
  const w = await world();
  const k = key();
  const body = poBody(w);

  /* A crashed process leaves this behind: claimed, nothing done. */
  await SpIdempotencyRecord.create({
    companyId: w.company._id,
    actorId: String((await SpCompanyMembership.findOne({ companyId: w.company._id }).lean()).employeeRef),
    operation: "PO_CREATE",
    key: k,
    requestHash: idempotency.hashRequest(body),
    status: "IN_PROGRESS",
    heartbeatAt: new Date(Date.now() - (idempotency.STALE_CLAIM_MS + 60_000)),
    effectAppliedAt: null,
  });

  const res = await call(OPS, { method: "POST", body, token: w.token, idempotencyKey: k });
  expect(res.status).toBe(201);
  expect(await PurchaseOrder.countDocuments({ companyId: w.company._id })).toBe(1);
});

test("a FRESH IN_PROGRESS claim is still refused — a slow request is not stolen from", async () => {
  const w = await world();
  const k = key();
  const body = poBody(w);
  await SpIdempotencyRecord.create({
    companyId: w.company._id,
    actorId: String((await SpCompanyMembership.findOne({ companyId: w.company._id }).lean()).employeeRef),
    operation: "PO_CREATE",
    key: k,
    requestHash: idempotency.hashRequest(body),
    status: "IN_PROGRESS",
    heartbeatAt: new Date(),
  });
  const res = await call(OPS, { method: "POST", body, token: w.token, idempotencyKey: k });
  expect(res.status).toBe(409);
  expect(res.body.error.code).toBe("IDEMPOTENCY_IN_PROGRESS");
  expect(await PurchaseOrder.countDocuments({ companyId: w.company._id })).toBe(0);
});

/* ═══ 5 · THE CONTRACT STILL HOLDS AROUND RECOVERY ══════════════════════ */

test("a different payload still conflicts, even after a post-mutation failure", async () => {
  const w = await world();
  const po = await issuedOrder(w);
  const k = key();
  const body = { items: [{ itemId: po.items[0]._id, quantity: 10 }] };

  const spy = jest.spyOn(actionHistory, "record").mockImplementation(async (ctx, entry) => {
    if (entry.action === "RECEIVED") throw new Error("history unavailable");
    return null;
  });
  await call(`${OPS}/${po._id}/receive`, { method: "POST", body, token: w.token, idempotencyKey: k });
  spy.mockRestore();

  /* The effect landed. A DIFFERENT payload under the same key is still a
     client bug and is still refused — recovery is not a licence to reuse. */
  const different = await call(`${OPS}/${po._id}/receive`, {
    method: "POST", body: { items: [{ itemId: po.items[0]._id, quantity: 25 }] },
    token: w.token, idempotencyKey: k,
  });
  expect(different.status).toBe(409);
  expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
});

test("an effect-applied record is never released back to FAILED", async () => {
  const w = await world();
  const po = await issuedOrder(w);
  const k = key();
  const spy = jest.spyOn(actionHistory, "record").mockImplementation(async (ctx, entry) => {
    if (entry.action === "RECEIVED") throw new Error("history unavailable");
    return null;
  });
  await call(`${OPS}/${po._id}/receive`, {
    method: "POST", body: { items: [{ itemId: po.items[0]._id, quantity: 5 }] },
    token: w.token, idempotencyKey: k,
  });
  spy.mockRestore();

  /* The 500 handler releases claims. It must NOT release this one — the
     filter in abandon() enforces that, so a route that forgets cannot cause
     a double effect. */
  const record = await SpIdempotencyRecord.findOne({ key: k }).lean();
  expect(record.status).toBe("EFFECT_APPLIED");
  expect(record.effectAppliedAt).toBeTruthy();
});
