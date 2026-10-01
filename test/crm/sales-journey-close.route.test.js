// test/crm/sales-journey-close.route.test.js
//
// G03 — CLOSING AN ORDER FAILS CLOSED.
//
// Closing is the moment money and delivery are declared settled. Until G03 the
// close command asked the closing verdict for permission and then IGNORED the
// answer whenever there wasn't one: the verdict returned `null` for a missing
// enquiry, a missing order link, an order with no work order, or any thrown
// error, the route dropped the null, and the planner — which only refused an
// explicit `canClose: false` — closed the order. A direct API call could close
// anything the verdict failed to look at.
//
// It also passed checks it had no evidence for: "paid" from a quotation total,
// "actual cost recorded" from a positive issued quantity.
//
// Every test here drives the real route over HTTP against isolated in-memory
// data. Nothing touches Atlas or a live order.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
/* The enquiries router pulls in push notifications and the CoWork sheet
   services, which need a Firebase service account and ESM-only dependencies
   this test has no business holding. The same stubs the costing route tests
   use (test/costing/sales-commercial-review.test.js). */
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

/* Pass-through wrappers — the real implementations run unless a single test
   overrides one call. Needed because both are destructured at require time. */
jest.mock("../../services/closingReport", () => {
  const actual = jest.requireActual("../../services/closingReport");
  return { ...actual, buildClosingReport: jest.fn(actual.buildClosingReport) };
});
jest.mock("../../services/companyContext/serviceScope.service", () => {
  const actual = jest.requireActual("../../services/companyContext/serviceScope.service");
  return { ...actual, createServiceContext: jest.fn(actual.createServiceContext) };
});

const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const DispatchChallan = require("../../models/CMS_Models/Manufacturing/Dispatch/DispatchChallan");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server;
let base;
let enquiriesBase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sales-journeys", require("../../routes/CMS_Routes/Sales/salesJourneys"));
  /* The closing SCREEN reads this route. It must agree with the gate on which
     order it is looking at, and disclose nothing the gate could not prove. */
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const root = `http://127.0.0.1:${server.address().port}/api/cms/crm`;
  base = `${root}/sales-journeys`;
  enquiriesBase = `${root}/enquiries`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

let CO;
beforeEach(async () => {
  await Promise.all([
    Account.deleteMany({}), SalesJourney.deleteMany({}), Enquiry.collection.deleteMany({}),
    CustomerRequest.collection.deleteMany({}), WorkOrder.collection.deleteMany({}),
    DispatchChallan.collection.deleteMany({}),
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
});

async function call(path = "", { method = "GET", body, user = OWNER, root = base } = {}) {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

const oid = () => new mongoose.Types.ObjectId();
const close = (journeyId) => call(`/${journeyId}/stage`, { method: "POST", body: { action: "close" } });
const stored = (journeyId) => SalesJourney.findOne({ journeyId }).lean();

/**
 * An order that is COMPLETE by every measure the old gate knew: every piece
 * dispatched, the quotation "paid" on its schedule, every material issued.
 * Each test removes or forges exactly one thing.
 *
 * Downstream records are inserted through the driver: these are fixtures for a
 * READ path, and none of their own write-time rules are under test.
 */
async function orderAtClosing(opt = {}) {
  const customerId = oid();
  const account = await Account.create({
    companyName: "MetroCare Hospitals", status: "active",
    ...(opt.accountCompanyId ? { companyId: opt.accountCompanyId } : {}),
    ...(opt.accountLinked === false ? {} : { linkedCustomer: opt.customerId || customerId }),
  });
  const { body } = await call("", {
    method: "POST",
    body: { accountId: String(account._id), name: "MetroCare Uniform Program", businessType: "uniform" },
  });
  // The DTO's `id` is the human reference (SJ-…), which is what the routes key on.
  const journeyId = body.journey.id;
  const journey = await SalesJourney.findOne({ journeyId }).lean();

  // Park it on the final stage, in progress — the only state `close` accepts.
  await SalesJourney.collection.updateOne(
    { _id: journey._id },
    { $set: { currentStage: "retention", "stageStates.retention": "inProgress" } },
  );

  const requestId = oid();
  const enquiryId = oid();
  if (opt.request !== false) {
    await CustomerRequest.collection.insertOne({
      _id: requestId,
      requestId: "REQ-2026-0042",
      customerId: opt.requestCustomerId || opt.customerId || customerId,
      /* `"self"` = raised from this journey's own enquiry through Cost &
         Invoicing; an id = raised from some other enquiry. */
      ...(opt.origin ? { salesOrigin: { enquiryId: opt.origin === "self" ? enquiryId : opt.origin } } : {}),
      grandTotal: 500000,
      quotations: [{ grandTotal: 500000 }],
      // Fully "paid" on its own schedule — the case the old gate certified.
      paymentSchedule: [{ status: "paid", paidAmount: 500000, remainingAmount: 0 }],
    });
  }

  if (opt.enquiry !== false) {
    await Enquiry.collection.insertOne({
      _id: enquiryId,
      journeyId: journey._id,
      isActive: true,
      companyId: opt.enquiryCompanyId || journey.companyId,
      // Required on the real schema: the enquiry is always for an account.
      accountId: account._id,
      customerRequestId: opt.linked === false ? null : requestId,
      /* G02: ownership is not enough — the link must be this deal's EXACT
         order. By default a salesperson confirmed it (the only way a portal
         order is ever exact); `confirmed: false` leaves it as the old guesses
         wrote it, with no confirmation. An origin-raised order needs none. */
      ...(opt.linked !== false && opt.confirmed !== false && opt.origin !== "self" ? {
        orderLink: {
          customerRequestId: requestId, method: "manual", confirmedAt: new Date(),
          confirmedBy: { id: OWNER.id, name: OWNER.name },
        },
      } : {}),
    });
  }

  if (opt.workOrder !== false && opt.request !== false) {
    const qty = 400;
    await WorkOrder.collection.insertOne({
      customerRequestId: requestId,
      workOrderNumber: "WO-0042",
      stockItemName: "Housekeeping shirt",
      quantity: qty,
      dispatchedQuantity: opt.shortBy ? qty - opt.shortBy : qty,
      productionCompletion: { operationCompletion: [{ operationNumber: 1, completedQuantity: qty }] },
      // Every material has something issued — the old "actual cost complete".
      rawMaterials: [{ quantityIssued: 120, unitCost: 180 }],
    });
  }

  return { journeyId, journey, requestId, enquiryId, customerId: opt.customerId || customerId, account };
}

/* ══ THE FAIL-OPEN REGRESSION ══════════════════════════════════════════════
 * Each of these was a CLOSED order before G03, reached by a direct API call.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a journey with no enquiry at all cannot be closed", async () => {
  const { journeyId } = await orderAtClosing({ enquiry: false });

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/enquiry/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
  expect((await stored(journeyId)).closedAt).toBeFalsy();
});

test("an enquiry with no order link cannot be closed", async () => {
  const { journeyId } = await orderAtClosing({ linked: false });

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/not linked to a customer order/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
});

test("an order with no work order cannot be closed", async () => {
  const { journeyId } = await orderAtClosing({ workOrder: false });

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/work order/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
});

test("a dependency that throws refuses the close instead of permitting it", async () => {
  const { journeyId } = await orderAtClosing();

  const spy = jest.spyOn(WorkOrder, "find").mockImplementation(() => { throw new Error("replica set unreachable"); });
  let res;
  try { res = await close(journeyId); } finally { spy.mockRestore(); }

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/could not be checked/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
});

/* ══ OWNERSHIP ═════════════════════════════════════════════════════════════
 * CustomerRequest, WorkOrder and DispatchChallan carry no company. The only
 * provable chain is: this company's Account → its linked portal customer →
 * the request's customer. A link that breaks that chain is refused, and
 * nothing about the foreign order is disclosed.
 * ═════════════════════════════════════════════════════════════════════════ */

test("an order link to another customer's request is refused and discloses nothing", async () => {
  const foreignCustomer = oid();
  const { journeyId } = await orderAtClosing({ requestCustomerId: foreignCustomer });

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cannot be proved/i);
  // The refusal names the gap, never the foreign order's facts.
  const text = JSON.stringify(res.body);
  expect(text).not.toMatch(/REQ-2026-0042|500000|WO-0042/);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
});

test("an account with no linked customer cannot prove the order is ours", async () => {
  const { journeyId } = await orderAtClosing({ accountLinked: false });

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/cannot be proved/i);
});

/* ══ HONEST STATUS ═════════════════════════════════════════════════════════ */

test("a short dispatch refuses the close", async () => {
  const { journeyId } = await orderAtClosing({ shortBy: 40 });

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/Not met: Everything ordered has been dispatched/);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
});

/* The order is fully dispatched, every material issued, and the quotation is
   "paid" on its own schedule. The old gate certified all three. A quotation is
   not an invoice and an issued quantity is not an actual cost — so this order
   is refused, and the refusal says which evidence is missing. */
test("a quotation marked paid is not an invoice: the close is refused", async () => {
  const { journeyId } = await orderAtClosing();

  const res = await close(journeyId);

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/evidence not available/i);
  expect(res.body.message).toMatch(/paid in full/i);
  expect(res.body.message).toMatch(/actual cost/i);
  // Delivery WAS complete, so it is not listed as unmet.
  expect(res.body.message).not.toMatch(/Not met/);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
  expect((await stored(journeyId)).closedAt).toBeFalsy();
});

/* The side door: `setState complete` on the final stage wrote the same
   closed state as `close`, with no verdict at all. */
test("setting the final stage to complete is not a way round the close gate", async () => {
  const { journeyId } = await orderAtClosing();

  const res = await call(`/${journeyId}/stage`, { method: "POST", body: { action: "setState", toState: "complete" } });

  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/close the order/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
});

/* ══ HISTORY STAYS READABLE ════════════════════════════════════════════════
 * A stricter gate on NEW closes must not strand orders closed before it.
 * ═════════════════════════════════════════════════════════════════════════ */

test("an order closed before G03 stays readable and stays closed", async () => {
  const { journeyId, journey } = await orderAtClosing({ linked: false });
  const closedAt = new Date("2026-06-30T10:00:00Z");
  await SalesJourney.collection.updateOne(
    { _id: journey._id },
    { $set: { "stageStates.retention": "complete", closedAt } },
  );

  const read = await call(`/${journeyId}`);
  expect(read.status).toBe(200);
  expect(read.body.success).toBe(true);

  const after = await stored(journeyId);
  expect(after.stageStates.retention).toBe("complete");
  expect(new Date(after.closedAt).toISOString()).toBe(closedAt.toISOString());

  // Re-closing is refused as "already closed", not as a missing verdict.
  const again = await close(journeyId);
  expect(again.status).toBe(400);
  expect(again.body.message).toMatch(/already closed/i);
});

/* ══ THE CLOSING SCREEN ════════════════════════════════════════════════════
 * GET /enquiries/:id/closing-report used to resolve the order by customer
 * NAME, write the match back, and read that order's facts with no ownership
 * proof. It now uses the gate's own proof.
 * ═════════════════════════════════════════════════════════════════════════ */

const closingReportFor = async (journey) => {
  const enquiry = await Enquiry.collection.findOne({ journeyId: journey._id });
  return call(`/${enquiry._id}/closing-report`, { root: enquiriesBase });
};

test("the closing screen discloses nothing about a foreign customer's order", async () => {
  const { journey } = await orderAtClosing({ requestCustomerId: oid() });

  const res = await closingReportFor(journey);

  expect(res.status).toBe(200);
  expect(res.body.linked).toBe(false);
  expect(res.body.blockedBy).toBe("unproved_link");
  expect(res.body.report).toBeUndefined();
  expect(JSON.stringify(res.body)).not.toMatch(/REQ-2026-0042|500000|WO-0042|Housekeeping/);
});

test("the closing screen shows payment and cost as unavailable, never as passed", async () => {
  const { journey } = await orderAtClosing();

  const res = await closingReportFor(journey);

  expect(res.status).toBe(200);
  expect(res.body.linked).toBe(true);
  const { report } = res.body;
  const status = Object.fromEntries(report.checklist.map((c) => [c.id, c.status]));
  expect(status).toEqual({ delivered: "met", paid: "unavailable", cost: "unavailable" });
  expect(report.canClose).toBe(false);
  expect(report.unavailable).toEqual(["paid", "cost"]);

  // The quoted figure is shown under its real name and never certified.
  expect(report.money.basis).toBe("quotation");
  expect(report.money.quoted).toBe(500000);
  expect(report.money.invoiceConnected).toBe(false);
  expect(report.money.settled).toBeNull();
});

test("the screen and the gate agree: what the screen cannot prove, the gate refuses", async () => {
  const { journey, journeyId } = await orderAtClosing({ linked: false });

  const screen = await closingReportFor(journey);
  const gate = await close(journeyId);

  expect(screen.body.linked).toBe(false);
  expect(screen.body.blockedBy).toBe("not_linked");
  expect(gate.status).toBe(400);
  expect(gate.body.message).toBe(screen.body.reason);
});

/* ══ A QUOTATION HAS NO INVOICED AMOUNT ════════════════════════════════════
 * The report carried the quotation total in `money.invoiced` "for
 * compatibility" — so any reader of `invoiced` still got a quote labelled as
 * an invoice, which is the claim G03 removes. `invoiced` is now null until an
 * authoritative issued invoice is linked; the quote lives in `quoted` only.
 * ═════════════════════════════════════════════════════════════════════════ */

const { buildClosingReport } = require("../../services/closingReport");

test("the report builder gives a quotation-only order no invoiced amount", () => {
  /* The same builder feeds the journey closing screen AND the Order Book, so
     asserting it here covers both routes' money. A fully-paid schedule is the
     strongest case the old rule would have certified. */
  const report = buildClosingReport({
    workOrders: [{
      quantity: 400, dispatchedQuantity: 400,
      productionCompletion: { operationCompletion: [{ operationNumber: 1, completedQuantity: 400 }] },
      rawMaterials: [{ quantityIssued: 120, unitCost: 180 }],
    }],
    request: {
      requestId: "REQ-Q-1", grandTotal: 500000, quotations: [{ grandTotal: 500000 }],
      paymentSchedule: [{ status: "paid", paidAmount: 500000, remainingAmount: 0 }],
    },
  });

  expect(report.money.quoted).toBe(500000);
  expect(report.money.invoiced).toBeNull();
  expect(report.money.invoiceConnected).toBe(false);
  expect(report.money.settled).toBeNull();
  expect(report.canClose).toBe(false);
  expect(report.checklist.find((c) => c.id === "paid").status).toBe("unavailable");
});

test("a quotation-only order shows no invoiced amount and cannot be closed", async () => {
  const { journey, journeyId } = await orderAtClosing();

  const shown = await closingReportFor(journey);
  expect(shown.body.report.money.quoted).toBe(500000);
  expect(shown.body.report.money.invoiced).toBeNull();
  // Nothing in the payload presents the quote as an invoiced figure.
  expect(shown.body.report.money).not.toHaveProperty("invoiced", 500000);

  const res = await close(journeyId);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/evidence not available/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
  expect((await stored(journeyId)).closedAt).toBeFalsy();
});

/* ══ A CHECK THAT RETURNS NO ANSWER, AND A COMPANY THAT CANNOT BE READ ═════ */

// `buildClosingReport` (required above) is the pass-through jest.fn from the mock.
const serviceScope = require("../../services/companyContext/serviceScope.service");

test("a closing report with no verdict refuses the close", async () => {
  const { journeyId } = await orderAtClosing();
  buildClosingReport.mockReturnValueOnce({ checklist: [] }); // no boolean canClose
  const res = await close(journeyId);
  expect(res.status).toBe(400);
  expect(res.body.message).toMatch(/could not be completed/i);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
  expect((await stored(journeyId)).closedAt).toBeFalsy();
});

test("when the company master cannot be read, the close is refused and nothing is written", async () => {
  const { journeyId } = await orderAtClosing();
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const actual = jest.requireActual("../../services/companyContext/serviceScope.service").createServiceContext;
  // Only the close path's own context fails: the journey itself loads normally.
  serviceScope.createServiceContext.mockImplementationOnce(async (args) => {
    const spy = jest.spyOn(Acc_Company, "find").mockImplementation(() => { throw new Error("company master unreachable"); });
    try { return await actual(args); } finally { spy.mockRestore(); }
  });
  const res = await close(journeyId);
  expect(serviceScope.createServiceContext).toHaveBeenCalled();
  expect(res.status).toBe(503);
  expect(res.body.success).toBe(false);
  expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");
  expect((await stored(journeyId)).closedAt).toBeFalsy();
});

/* ══ TWO COMPANIES, ONE PORTAL CUSTOMER ════════════════════════════════════
 * A portal customer belongs to no company. When both companies' accounts link
 * the same one, "the request is that customer's" says nothing about whose
 * order it is. Only the request's recorded origin can settle it.
 * ═════════════════════════════════════════════════════════════════════════ */
describe("with two companies", () => {
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  let CO_B;

  beforeEach(async () => {
    const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
    CO_B = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
    await SpCompanyMembership.deleteMany({});
    // The Sales actor works for company A (CO) only.
    await SpCompanyMembership.create({ companyId: CO._id, employeeRef: OWNER.id, personName: OWNER.name });
  });

  /** Company B's CRM account, linked to the given portal customer. */
  const foreignAccountLinking = (customerId) => Account.collection.insertOne({
    companyId: CO_B._id, companyName: "MetroCare (B's account)", status: "active", linkedCustomer: customerId,
  });

  test("one portal customer linked in both companies: a request with no origin is refused, nothing disclosed", async () => {
    const shared = oid();
    await foreignAccountLinking(shared);
    const { journeyId, journey } = await orderAtClosing({ accountCompanyId: CO._id, customerId: shared });
    expect(String(journey.companyId)).toBe(String(CO._id));

    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be proved to belong to this company/i);
    // The refusal says nothing about the other company or the order.
    expect(JSON.stringify(res.body)).not.toMatch(/REQ-2026-0042|500000|WO-0042|Other Co|B's account/);
    expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");

    const screen = await closingReportFor(journey);
    expect(screen.body.linked).toBe(false);
    expect(screen.body.blockedBy).toBe("unproved_link");
    expect(screen.body.report).toBeUndefined();
    expect(JSON.stringify(screen.body)).not.toMatch(/REQ-2026-0042|500000|WO-0042|Other Co|B's account/);
  });

  test("the same shared customer, but the request was raised from THIS enquiry: ownership is proved", async () => {
    const shared = oid();
    await foreignAccountLinking(shared);
    const { journeyId, journey } = await orderAtClosing({ accountCompanyId: CO._id, customerId: shared, origin: "self" });

    const res = await close(journeyId);
    // Refused only because payment and cost evidence is not connected.
    expect(res.status).toBe(400);
    expect(res.body.message).not.toMatch(/cannot be proved/i);
    expect(res.body.message).toMatch(/evidence not available/i);

    const screen = await closingReportFor(journey);
    expect(screen.body.linked).toBe(true);
    expect(screen.body.report.closingAvailable).toBe(false);
  });

  test("a request raised from another enquiry is refused even when the customer matches", async () => {
    const { journeyId } = await orderAtClosing({ accountCompanyId: CO._id, origin: oid() });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be proved to belong to this company/i);
  });

  test("a customer linked only by this company's account, confirmed by a salesperson, is proved without an origin", async () => {
    const { journeyId } = await orderAtClosing({ accountCompanyId: CO._id });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).not.toMatch(/cannot be proved|not been confirmed/i);
    expect(res.body.message).toMatch(/evidence not available/i);
  });

  /* G02 — ownership alone used to pass. A link to one of this company's
     customer's orders that nobody confirmed is exactly what the old
     "newest order for this customer" guess wrote. */
  test("the same customer chain with NO confirmation is refused as unverified, on the gate and the screen", async () => {
    const { journeyId, journey } = await orderAtClosing({ accountCompanyId: CO._id, confirmed: false });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not been confirmed as this deal's order/i);
    expect((await stored(journeyId)).stageStates.retention).toBe("inProgress");

    const screen = await closingReportFor(journey);
    expect(screen.body.linked).toBe(false);
    expect(screen.body.blockedBy).toBe("unverified_link");
    expect(JSON.stringify(screen.body)).not.toMatch(/500000|WO-0042/);
  });

  test("a confirmation recorded against a DIFFERENT order does not make this link exact", async () => {
    const { journeyId, enquiryId } = await orderAtClosing({ accountCompanyId: CO._id });
    await Enquiry.collection.updateOne({ _id: enquiryId }, { $set: { "orderLink.customerRequestId": oid() } });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not been confirmed as this deal's order/i);
  });

  test("a confirmed portal order is no longer this deal's once an order is raised from the enquiry", async () => {
    const { journeyId, enquiryId, customerId } = await orderAtClosing({ accountCompanyId: CO._id });
    await CustomerRequest.collection.insertOne({
      _id: oid(), requestId: "REQ-2026-0099", customerId, status: "pending", salesOrigin: { enquiryId },
    });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not been confirmed as this deal's order/i);
  });

  test("a superseded origin order is not this deal's order", async () => {
    const { journeyId, requestId, customerId, enquiryId } = await orderAtClosing({ accountCompanyId: CO._id, origin: "self" });
    await CustomerRequest.collection.insertOne({
      _id: oid(), requestId: "REQ-2026-0100", customerId, status: "pending",
      salesOrigin: { enquiryId, supersedesRequestId: requestId },
    });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not been confirmed as this deal's order/i);
  });

  test("an enquiry stamped to company B is invisible to company A's close", async () => {
    const { journeyId } = await orderAtClosing({ accountCompanyId: CO._id, enquiryCompanyId: CO_B._id });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no active enquiry/i);
    expect(JSON.stringify(res.body)).not.toMatch(/REQ-2026-0042|500000|WO-0042/);
  });

  test("an unowned legacy account linking the customer makes it ambiguous once there are two companies", async () => {
    const shared = oid();
    await Account.collection.insertOne({ companyName: "Legacy MetroCare", status: "active", linkedCustomer: shared });
    const { journeyId } = await orderAtClosing({ accountCompanyId: CO._id, customerId: shared });
    const res = await close(journeyId);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot be proved to belong to this company/i);
  });
});

/* ══ THE PLANNER'S GATE, ON ITS OWN ════════════════════════════════════════
 * Every route case above refuses — no order can meet the payment and cost
 * checks yet — so without these a gate that ALWAYS refused would pass them
 * all. This proves a genuine yes closes and a malformed one does not.
 * ═════════════════════════════════════════════════════════════════════════ */
describe("planStageTransition close", () => {
  const { planStageTransition, JourneyTransitionError, STAGE_ORDER } = require("../../services/salesJourneyProgress");
  const last = STAGE_ORDER[STAGE_ORDER.length - 1];
  const atFinal = () => ({
    currentStage: last,
    stageStates: Object.fromEntries(STAGE_ORDER.map((s) => [s, s === last ? "inProgress" : "complete"])),
    outcome: "active",
  });
  const plan = (closing) => planStageTransition(atFinal(), { action: "close", context: { closing } });
  const YES = { canClose: true, available: true, blockers: 0, checklistCount: 3, blocking: [] };

  test("a well-formed canClose:true verdict closes the order", () => {
    const out = plan(YES);
    expect(out.set[`stageStates.${last}`]).toBe("complete");
    expect(out.set.closedAt).toBeInstanceOf(Date);
  });

  test.each([
    ["absent", undefined],
    ["null", null],
    ["canClose as a string", { ...YES, canClose: "true" }],
    ["canClose true while unavailable", { ...YES, available: false }],
    ["canClose true with blockers", { ...YES, blockers: 1 }],
    ["canClose true with a blocking item", { ...YES, blocking: [{ id: "paid", status: "unavailable" }] }],
    ["no blocking list", { canClose: true, available: true, blockers: 0 }],
    ["non-integer blockers", { ...YES, blockers: "0" }],
  ])("a malformed verdict (%s) cannot close", (_label, closing) => {
    expect(() => plan(closing)).toThrow(JourneyTransitionError);
    expect(() => plan(closing)).toThrow(/could not be run/);
  });

  test("a well-formed canClose:false verdict refuses and names the gap", () => {
    expect(() => plan({
      canClose: false, available: true, blockers: 1, checklistCount: 3,
      blocking: [{ id: "delivered", status: "unmet", label: "Everything ordered has been dispatched" }],
    })).toThrow(/Not met: Everything ordered has been dispatched/);
  });
});
