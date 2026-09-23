// test/sales/order-book-ownership.route.test.js
//
// G02 (Order Book) — AN ORDER IS SHOWN OR CHANGED ONLY WHEN IT IS PROVED TO BE
// THE CALLER'S COMPANY'S.
//
// Every route in routes/CMS_Routes/Sales/customerRequests.js used to read or
// change a CustomerRequest by `_id` alone, and the list, export and dashboard
// covered every company's orders. These drive the real router over HTTP
// against in-memory data, as two companies. Nothing touches Atlas.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/EmployeeAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
jest.mock("../../services/CustomerEmailService", () => ({
  sendEditRequestNotificationEmail: jest.fn(async () => ({ success: true })),
}));

const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const CustomerEmailService = require("../../services/CustomerEmailService");
/* Registered by the server at boot; the edit-requests route populates through it. */
require("../../models/SalesDepartment");

const oid = () => new mongoose.Types.ObjectId();
const USER_A = { id: oid().toString(), name: "Anita Rao", role: "sales" };
const USER_B = { id: oid().toString(), name: "Bala Iyer", role: "sales" };
const MANAGER_A = { ...USER_A, isAdmin: true };

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/sales", require("../../routes/CMS_Routes/Sales/customerRequests"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/sales`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(path, { method = "GET", body, user = USER_A, raw = false } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: raw ? await res.text() : await res.json() };
}

let CO_A;
let CO_B;
let O; // the fixture orders, by name
let seq = 0;

async function order(name, fields = {}) {
  seq += 1;
  const _id = oid();
  await CustomerRequest.collection.insertOne({
    _id,
    requestId: `REQ-T-${String(seq).padStart(4, "0")}`,
    customerId: oid(),
    status: "pending",
    priority: "medium",
    requestType: "customer_request",
    customerInfo: { name: `Buyer ${name}`, email: `${name}@example.test`, phone: "9000000000" },
    items: [{ stockItemName: "Housekeeping shirt", totalQuantity: 10, variants: [] }],
    notes: [{ text: `note on ${name}`, addedByModel: "SalesDepartment", createdAt: new Date() }],
    editRequests: [],
    grandTotal: 123456,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...fields,
  });
  await WorkOrder.collection.insertOne({
    customerRequestId: _id, workOrderNumber: `WO-${name}`, stockItemName: "Housekeeping shirt", quantity: 10,
  });
  O[name] = _id;
  return _id;
}

let accounts = 0;
const linkCustomer = (companyId, customerId) => Account.collection.insertOne({
  accountId: `ACC-T-${++accounts}`,
  companyId, companyName: `Acct ${String(customerId).slice(-4)}`, status: "active", linkedCustomer: customerId,
});

beforeEach(async () => {
  await Promise.all([
    CustomerRequest.collection.deleteMany({}), Account.collection.deleteMany({}),
    Enquiry.collection.deleteMany({}), SalesJourney.collection.deleteMany({}),
    SampleStyle.collection.deleteMany({}), WorkOrder.collection.deleteMany({}),
    SpCompanyMembership.deleteMany({}),
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO_A = await Acc_Company.create({ companyName: "Company A", booksFromDate: new Date("2026-04-01") });
  CO_B = await Acc_Company.create({ companyName: "Company B", booksFromDate: new Date("2026-04-01") });
  await SpCompanyMembership.create({ companyId: CO_A._id, employeeRef: USER_A.id, personName: USER_A.name });
  await SpCompanyMembership.create({ companyId: CO_B._id, employeeRef: USER_B.id, personName: USER_B.name });
  O = {};

  /* ── A's orders, one per kind of proof ─────────────────────────────── */
  const custA = oid();
  await linkCustomer(CO_A._id, custA);
  await order("portalA", { customerId: custA });
  await order("measurementA", {
    customerId: custA, requestType: "measurement_conversion", measurementId: oid(), measurementName: "Ward staff",
    items: [{
      stockItemName: "Scrub top", totalQuantity: 2,
      variants: [{ persons: [{ employeeName: "Ramesh", employeeUIN: "EMP-0042", quantity: 2 }] }],
    }],
  });
  const enquiryA = oid();
  await Enquiry.collection.insertOne({ _id: enquiryA, journeyId: oid(), enquiryId: "ENQ-A", companyId: CO_A._id, isActive: true });
  await order("originA", { salesOrigin: { enquiryId: enquiryA } });
  const journeyA = oid();
  await SalesJourney.collection.insertOne({ _id: journeyA, journeyId: "SJ-A", companyId: CO_A._id });
  const styleA = oid();
  await SampleStyle.collection.insertOne({ _id: styleA, sampleStyleId: "SS-A", productName: "Shirt", journeyId: journeyA });
  await order("styleA", { items: [{ stockItemName: "Shirt", totalQuantity: 5, sampleStyleId: styleA }] });

  /* ── B's orders ─────────────────────────────────────────────────────── */
  const custB = oid();
  await linkCustomer(CO_B._id, custB);
  await order("portalB", { customerId: custB });
  const enquiryB = oid();
  await Enquiry.collection.insertOne({ _id: enquiryB, journeyId: oid(), enquiryId: "ENQ-B", companyId: CO_B._id, isActive: true });
  // An A customer, but raised from B's enquiry: origin is decisive.
  await order("originB", { customerId: custA, salesOrigin: { enquiryId: enquiryB } });
  const journeyB = oid();
  await SalesJourney.collection.insertOne({ _id: journeyB, journeyId: "SJ-B", companyId: CO_B._id });
  const styleB = oid();
  await SampleStyle.collection.insertOne({ _id: styleB, sampleStyleId: "SS-B", productName: "Shirt", journeyId: journeyB });
  // One A style and one B style: "partly yours" is not yours.
  await order("mixedStyles", {
    customerId: custA,
    items: [
      { stockItemName: "Shirt", totalQuantity: 5, sampleStyleId: styleA },
      { stockItemName: "Shirt", totalQuantity: 5, sampleStyleId: styleB },
    ],
  });

  /* ── Orders nobody can attribute ────────────────────────────────────── */
  const shared = oid();
  await linkCustomer(CO_A._id, shared);
  await linkCustomer(CO_B._id, shared);
  await order("contested", { customerId: shared });
  await order("unknownPortal", {});
  await order("unknownMeasurement", { requestType: "measurement_conversion", measurementId: oid() });
  // An A enquiry POINTS at this order (the old guesses wrote such links), and the
  // buyer name matches A's account name — neither is evidence.
  const guessed = await order("guessedLink", { customerInfo: { name: "Acct " + String(custA).slice(-4) } });
  await Enquiry.collection.insertOne({
    _id: oid(), journeyId: oid(), enquiryId: "ENQ-A2", companyId: CO_A._id, isActive: true, customerRequestId: guessed,
  });
});

const A_OWNS = ["portalA", "measurementA", "originA", "styleA"];
const NOT_A = ["portalB", "originB", "mixedStyles", "contested", "unknownPortal", "unknownMeasurement", "guessedLink"];
const idOf = (name) => String(O[name]);

/* ══ READS ═════════════════════════════════════════════════════════════════ */

const READS = [
  ["detail", (id) => `/requests/${id}`],
  ["people", (id) => `/${id}/persons`],
  ["notes", (id) => `/requests/${id}/notes`],
  ["edit requests", (id) => `/${id}/edit-requests`],
  ["production", (id) => `/requests/${id}/production`],
  ["shipment", (id) => `/requests/${id}/shipment`],
  ["closing report", (id) => `/requests/${id}/closing-report`],
];

describe.each(READS)("GET %s", (_label, path) => {
  test.each(A_OWNS)("company A reads its own %s order", async (name) => {
    const res = await call(path(idOf(name)));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test.each(NOT_A)("company A is refused %s, and learns nothing about it", async (name) => {
    const res = await call(path(idOf(name)));
    expect(res.status).toBe(404);
    expect(res.body.message).toBe("Order not found.");
    expect(JSON.stringify(res.body)).not.toMatch(/REQ-T-|WO-|123456|Buyer|note on/);
  });
});

test("a missing order and a foreign order get the identical refusal", async () => {
  const foreign = await call(`/requests/${idOf("portalB")}`);
  const missing = await call(`/requests/${oid()}`);
  expect(foreign).toEqual(missing);
});

test("a portal order's detail carries its money; a measurement order's people are listed", async () => {
  const detail = await call(`/requests/${idOf("portalA")}`);
  expect(detail.body.request.grandTotal).toBe(123456);
  const people = await call(`/${idOf("measurementA")}/persons`);
  expect(people.body.isMeasurementOrder).toBe(true);
  expect(people.body.persons.map((p) => p.employeeUIN)).toContain("EMP-0042");
});

test("company B reads its own orders and is refused A's", async () => {
  expect((await call(`/requests/${idOf("portalB")}`, { user: USER_B })).status).toBe(200);
  expect((await call(`/requests/${idOf("originB")}`, { user: USER_B })).status).toBe(200);
  for (const name of A_OWNS) expect((await call(`/requests/${idOf(name)}`, { user: USER_B })).status).toBe(404);
});

/* ══ LISTS: the same rule as a filter ══════════════════════════════════════ */

describe("lists, export and dashboard", () => {
  test("the Order Book lists exactly the orders its own pages would open", async () => {
    const res = await call("/requests?limit=100");
    expect(res.status).toBe(200);
    const listed = res.body.requests.map((r) => r.requestId);
    const expected = A_OWNS.map((n) => res.body.requests.find((r) => String(r._id) === idOf(n))?.requestId);
    expect(expected.every(Boolean)).toBe(true);
    expect(listed.sort()).toEqual(expected.sort());
    expect(res.body.pagination.total).toBe(A_OWNS.length);
    expect(res.body.stats.total).toBe(A_OWNS.length);

    /* Agreement, order by order: listed ⇔ openable. */
    const listedIds = new Set(res.body.requests.map((r) => String(r._id)));
    for (const name of [...A_OWNS, ...NOT_A]) {
      const open = (await call(`/requests/${idOf(name)}`)).status === 200;
      expect({ name, listed: listedIds.has(idOf(name)) }).toEqual({ name, listed: open });
    }
  });

  test("a search cannot widen the list past the company", async () => {
    const res = await call("/requests?search=Buyer&limit=100");
    expect(res.body.requests.map((r) => String(r._id)).sort()).toEqual(A_OWNS.map(idOf).sort());
  });

  test("the CSV export holds only this company's orders", async () => {
    const res = await call("/requests/export", { raw: true });
    expect(res.status).toBe(200);
    const rows = res.body.trim().split("\n").slice(1);
    expect(rows).toHaveLength(A_OWNS.length);
    expect(res.body).not.toMatch(/Buyer portalB|Buyer contested|Buyer unknownPortal|Buyer guessedLink/);
  });

  test("dashboard, recent and top customers count only this company's orders", async () => {
    await CustomerRequest.collection.updateMany({}, { $set: { status: "completed", quotationAmount: 1000 } });
    const dash = await call("/dashboard");
    expect(dash.body.stats.totalRequests).toBe(A_OWNS.length);
    expect(dash.body.stats.completedRequests).toBe(A_OWNS.length);

    const recent = await call("/dashboard/recent-requests");
    expect(recent.body.requests.map((r) => String(r._id)).sort()).toEqual(A_OWNS.map(idOf).sort());

    const top = await call("/dashboard/top-customers");
    expect(top.status).toBe(200);
    const spent = top.body.customers.reduce((n, c) => n + c.totalSpent, 0);
    expect(spent).toBeLessThanOrEqual(A_OWNS.length * 1000);
  });
});

/* ══ WRITES: refused before anything is written ════════════════════════════ */

const snapshot = async (name) => JSON.stringify(await CustomerRequest.collection.findOne({ _id: O[name] }));

/** Put an order into the state each edit-approval route needs, so a missing
 *  guard WOULD have changed it. */
async function awaitingEditApproval(name) {
  const editId = oid();
  await CustomerRequest.collection.updateOne({ _id: O[name] }, {
    $set: {
      status: "pending_edit_approval",
      pendingEditRequest: editId,
      editRequests: [{ _id: editId, requestId: "EDIT-X-1", status: "pending_approval", reason: "r", changes: [] }],
    },
  });
}

const WRITES = [
  ["status", "PATCH", (id) => `/requests/${id}/status`, { status: "completed", notes: "closing it" }],
  ["assignment", "PATCH", (id) => `/requests/${id}/assign`, { salesPersonId: oid().toString() }],
  ["priority", "PATCH", (id) => `/requests/${id}/priority`, { priority: "urgent" }],
  ["note", "POST", (id) => `/requests/${id}/notes`, { text: "a note that must not land" }],
  ["edit request", "POST", (id) => `/${id}/edit-request`,
    { reason: "Address change", changes: [{ field: "address" }], customerInfo: { address: "New street" } }],
  ["edit approval", "POST", (id) => `/${id}/approve-edit`, { action: "approve_and_proceed" }, true],
  ["edit rejection", "POST", (id) => `/${id}/reject-edit`, { reason: "No" }, true],
];

describe.each(WRITES)("%s", (_label, method, path, body, needsPendingEdit) => {
  test.each(["portalB", "originB", "contested", "unknownPortal", "unknownMeasurement", "guessedLink", "mixedStyles"])(
    "on %s is refused and writes nothing",
    async (name) => {
      if (needsPendingEdit) await awaitingEditApproval(name);
      const before = await snapshot(name);
      const res = await call(path(idOf(name)), { method, body });
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Order not found.");
      expect(await snapshot(name)).toBe(before);
    },
  );

  test("on this company's own order is applied", async () => {
    if (needsPendingEdit) await awaitingEditApproval("portalA");
    const before = await snapshot("portalA");
    const res = await call(path(idOf("portalA")), { method, body });
    expect(res.status).toBe(200);
    expect(await snapshot("portalA")).not.toBe(before);
  });
});

test("a refused edit request sends the customer no email", async () => {
  CustomerEmailService.sendEditRequestNotificationEmail.mockClear();
  await call(`/${idOf("portalB")}/edit-request`, {
    method: "POST", body: { reason: "x", changes: [{ field: "a" }], customerInfo: {} },
  });
  expect(CustomerEmailService.sendEditRequestNotificationEmail).not.toHaveBeenCalled();
});

test("company B cannot change A's order either", async () => {
  const before = await snapshot("portalA");
  const res = await call(`/requests/${idOf("portalA")}/status`, { method: "PATCH", user: USER_B, body: { status: "cancelled" } });
  expect(res.status).toBe(404);
  expect(await snapshot("portalA")).toBe(before);
});

/* ══ OWNERSHIP EVIDENCE THAT CHANGES ═══════════════════════════════════════ */

test("a legacy order becomes readable the moment its customer is linked to this company alone", async () => {
  const order = await CustomerRequest.collection.findOne({ _id: O.unknownPortal });
  expect((await call(`/requests/${idOf("unknownPortal")}`)).status).toBe(404);
  await linkCustomer(CO_A._id, order.customerId);
  expect((await call(`/requests/${idOf("unknownPortal")}`)).status).toBe(200);
  // …and stops being readable when another company links the same customer.
  await linkCustomer(CO_B._id, order.customerId);
  expect((await call(`/requests/${idOf("unknownPortal")}`)).status).toBe(404);
});

test("in a sole-company deployment every order is that company's", async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteOne({ _id: CO_B._id });
  await SpCompanyMembership.deleteMany({ companyId: CO_B._id });

  expect((await call(`/requests/${idOf("unknownMeasurement")}`)).status).toBe(200);
  const list = await call("/requests?limit=100");
  expect(list.body.pagination.total).toBe(A_OWNS.length + NOT_A.length);
  const manager = await call(`/requests/${idOf("unknownPortal")}/closing-report`, { user: MANAGER_A });
  expect(manager.status).toBe(200);
});
