// test/crm/order-link-safety.route.test.js
//
// G02 (continued) — NO READER ACTS ON A GUESSED ORDER, AND ONE ORDER BELONGS
// TO ONE DEAL.
//
// G02 removed the PO path's "newest order for this customer" guess. What was
// left:
//   • `resolveRequestId` in the enquiry routes — customer NAME, then the newest
//     order, WRITTEN onto the enquiry — behind Production, Shipment,
//     early-dispatch and the commercial ladder;
//   • the advance-payment gate, reading "received" off whatever order the
//     enquiry pointed at, with no company;
//   • the Order Book's reverse lookups, trusting any enquiry that pointed at
//     the order;
//   • the closing gate accepting any order of the right customer;
//   • a proforma raised from the enquiry leaving an older guess in place;
//   • two enquiries able to link one order at the same time.
//
// Every route test drives the real routers over HTTP against in-memory data.
// Nothing touches Atlas.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
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
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const OrderLinkClaim = require("../../models/CMS_Models/Sales/OrderLinkClaim");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const { createServiceContext } = require("../../services/companyContext/serviceScope.service");
const orderBookLink = require("../../services/orderBookLink");
const { recordProforma } = require("../../services/sales/proformaRequest.service");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server;
let base;
let enquiriesBase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sales-journeys", require("../../routes/CMS_Routes/Sales/salesJourneys"));
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
    Account.collection.deleteMany({}), SalesJourney.collection.deleteMany({}),
    Enquiry.collection.deleteMany({}), CustomerRequest.collection.deleteMany({}),
    OrderLinkClaim.collection.deleteMany({}), WorkOrder.collection.deleteMany({}),
    mongoose.connection.collection("customers").deleteMany({}),
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
const DAY = 24 * 60 * 60 * 1000;
const enquiryOf = (enquiryId) => Enquiry.collection.findOne({ _id: enquiryId });
const onEnquiry = (d, path, opt = {}) => call(`/${d.enquiryId}${path}`, { root: enquiriesBase, ...opt });
const choose = (d, body) => call(`/${d.journeyId}/order-link`, { method: "POST", body });
const svcCtx = () => createServiceContext({ companyId: CO._id, reason: "test", legacyAware: true });

let deals = 0;
/** A deal whose account is linked to a portal customer that is ALSO findable
 *  by name — exactly what the old name-match fallback needed to guess. */
async function deal(opt = {}) {
  deals += 1;
  const customerId = opt.customerId || oid();
  if (!opt.customerId) {
    await mongoose.connection.collection("customers").insertOne({ _id: customerId, name: `MetroCare Hospitals ${deals}` });
  }
  const account = await Account.create({
    companyName: `MetroCare Hospitals ${deals}`, status: "active",
    ...(opt.accountCompanyId ? { companyId: opt.accountCompanyId } : {}),
    ...(opt.advancePercent !== undefined ? { advancePercent: opt.advancePercent } : {}),
    linkedCustomer: customerId,
  });
  const { body } = await call("", {
    method: "POST",
    body: { accountId: String(account._id), name: "MetroCare Uniform Program", businessType: "uniform" },
  });
  const journeyId = body.journey.id;
  const journey = await SalesJourney.findOne({ journeyId }).lean();
  const enquiryId = oid();
  await Enquiry.collection.insertOne({
    _id: enquiryId, enquiryId: `ENQ-${journeyId}`, journeyId: journey._id, isActive: true,
    companyId: journey.companyId, accountId: account._id, customerRequestId: opt.storedLink || null,
    ...(opt.confirmed && opt.storedLink ? {
      orderLink: {
        customerRequestId: opt.storedLink, method: "manual", confirmedAt: new Date(),
        confirmedBy: { id: OWNER.id, name: OWNER.name },
      },
    } : {}),
  });
  return { journeyId, journey, enquiryId, customerId, account };
}

let seq = 0;
async function order({ customerId, createdAt = new Date(), origin, supersedes, ...rest } = {}) {
  const _id = oid();
  seq += 1;
  await CustomerRequest.collection.insertOne({
    _id,
    requestId: `REQ-2026-${String(seq).padStart(4, "0")}`,
    customerId,
    status: "pending",
    requestType: "customer_request",
    orderOrigin: "customer",
    createdAt,
    grandTotal: 777777,
    totalPaidAmount: 0,
    items: [{ stockItemName: "Housekeeping shirt", totalQuantity: 400 }],
    ...(origin || supersedes ? {
      salesOrigin: { ...(origin ? { enquiryId: origin } : {}), ...(supersedes ? { supersedesRequestId: supersedes } : {}) },
    } : {}),
    ...rest,
  });
  return _id;
}

const workOrderOn = (customerRequestId) => WorkOrder.collection.insertOne({
  customerRequestId, workOrderNumber: `WO-${String(customerRequestId).slice(-4)}`, stockItemName: "Housekeeping shirt",
  quantity: 400, dispatchedQuantity: 0, productionCompletion: { operationCompletion: [] },
});

/* ══ THE OLD NAME/NEWEST FALLBACK, ROUTE BY ROUTE ══════════════════════════
 * Each of these used to find the portal customer by NAME, take the NEWEST
 * order, and WRITE it onto the enquiry.
 * ═════════════════════════════════════════════════════════════════════════ */
describe("the name-match fallback is gone", () => {
  test("Production: no link → 'not linked', nothing guessed, nothing written", async () => {
    const d = await deal();
    const newest = await order({ customerId: d.customerId });
    await workOrderOn(newest);

    const res = await onEnquiry(d, "/production");
    expect(res.status).toBe(200);
    expect(res.body.linked).toBe(false);
    expect(res.body.orderLink.status).toBe("not_linked");
    expect(res.body.reason).toMatch(/Order not linked/);
    expect(JSON.stringify(res.body)).not.toMatch(/WO-|REQ-2026/);
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });

  test("Shipment: no link → 'not linked', nothing written", async () => {
    const d = await deal();
    await workOrderOn(await order({ customerId: d.customerId }));
    const res = await onEnquiry(d, "/shipment");
    expect(res.body.linked).toBe(false);
    expect(res.body.orderLink.status).toBe("not_linked");
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });

  test("Early dispatch: no proved order → refused, no ask recorded, nothing written", async () => {
    const d = await deal();
    await order({ customerId: d.customerId });
    const res = await onEnquiry(d, "/early-dispatch", {
      method: "POST", body: { pieces: 10, reason: "Site opening moved forward a week" },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("order_not_linked");
    expect(res.body.message).toMatch(/confirmed order/);
    const e = await enquiryOf(d.enquiryId);
    expect(e.customerRequestId).toBeNull();
    expect(e.earlyDispatchRequests || []).toHaveLength(0);
  });

  test("Early dispatch against a PROVED order gets past the link and is checked against its own stock", async () => {
    const d = await deal();
    const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
    await Enquiry.collection.updateOne({ _id: d.enquiryId }, { $set: { customerRequestId: mine } });
    await workOrderOn(mine);
    const res = await onEnquiry(d, "/early-dispatch", {
      method: "POST", body: { pieces: 10, reason: "Site opening moved forward a week" },
    });
    // Nothing is packed on the proved order, so the ask is refused for THAT reason.
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/packed and still here/);
  });

  test("Commercial ladder: no order rung from a guess, and nothing written", async () => {
    const d = await deal();
    await order({ customerId: d.customerId, quotations: [{ grandTotal: 777777 }] });
    const res = await onEnquiry(d, "/commercial-ladder");
    expect(res.status).toBe(200);
    expect(res.body.orderLink.status).toBe("not_linked");
    expect(JSON.stringify(res.body)).not.toMatch(/777777|REQ-2026/);
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });

  test("an order raised from this enquiry is read without being written by the read", async () => {
    const d = await deal();
    const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
    await workOrderOn(mine);
    const res = await onEnquiry(d, "/production");
    expect(res.body.linked).toBe(true);
    expect(res.body.requestId).toBe(String(mine));
    // A read never writes the link; the PO / proforma / chooser do.
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });
});

/* ══ LINKS WRITTEN BY THE OLD GUESSES ══════════════════════════════════════ */
describe("an unverified legacy link is never acted on", () => {
  test("Production, Shipment and the ladder refuse it and disclose nothing of that order", async () => {
    const customerId = oid();
    const guessed = await order({ customerId, quotations: [{ grandTotal: 777777 }] });
    await workOrderOn(guessed);
    const d = await deal({ customerId, storedLink: guessed });

    for (const path of ["/production", "/shipment"]) {
      const res = await onEnquiry(d, path);
      expect(res.body.linked).toBe(false);
      expect(res.body.orderLink.status).toBe("unverified");
      expect(JSON.stringify(res.body.view || {})).toBe("{}");
    }
    const ladder = await onEnquiry(d, "/commercial-ladder");
    expect(JSON.stringify(ladder.body)).not.toMatch(/777777/);
    // Kept, not silently changed.
    expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(guessed));
  });

  test("the same link, once a salesperson confirms it, is acted on", async () => {
    const customerId = oid();
    const guessed = await order({ customerId });
    await workOrderOn(guessed);
    const d = await deal({ customerId, storedLink: guessed });

    const ok = await choose(d, { customerRequestId: String(guessed), expectedCustomerRequestId: String(guessed) });
    expect(ok.status).toBe(200);
    const res = await onEnquiry(d, "/production");
    expect(res.body.linked).toBe(true);
    expect(res.body.requestId).toBe(String(guessed));
  });

  test("the advance gate never counts a guessed order's payment as this deal's", async () => {
    const customerId = oid();
    const guessed = await order({ customerId, totalPaidAmount: 500000 });
    const d = await deal({ customerId, storedLink: guessed, advancePercent: 50 });
    await call(`/${d.journeyId}/po`, { method: "PATCH", body: { number: "PO-1", amount: 200000 } });

    const before = await call(`/${d.journeyId}`);
    expect(before.body.journey.paymentGate.required).toBe(true);
    expect(before.body.journey.paymentGate.cleared).toBe(false);

    // Confirmed, the same payment is this deal's and clears the gate.
    await choose(d, { customerRequestId: String(guessed), expectedCustomerRequestId: String(guessed) });
    const after = await call(`/${d.journeyId}`);
    expect(after.body.journey.paymentGate.cleared).toBe(true);
  });

  test("the Order Book finds an order's enquiry only through an exact link", async () => {
    const customerId = oid();
    const guessed = await order({ customerId });
    const d = await deal({ customerId, storedLink: guessed });
    const ctx = await svcCtx();

    expect(await orderBookLink.provedEnquiryForOrder(ctx, guessed)).toBeNull();
    await choose(d, { customerRequestId: String(guessed), expectedCustomerRequestId: String(guessed) });
    const found = await orderBookLink.provedEnquiryForOrder(ctx, guessed);
    expect(String(found._id)).toBe(String(d.enquiryId));
  });

  test("two enquiries pointing at one order: the Order Book trusts neither", async () => {
    const customerId = oid();
    const x = await order({ customerId });
    const d = await deal({ customerId, storedLink: x, confirmed: true });
    await Enquiry.collection.insertOne({
      _id: oid(), enquiryId: "ENQ-DUP", journeyId: oid(), isActive: true, companyId: d.journey.companyId,
      accountId: d.account._id, customerRequestId: x,
    });
    expect(await orderBookLink.provedEnquiryForOrder(await svcCtx(), x)).toBeNull();
  });
});

/* ══ WRONG-COMPANY ORDERS ══════════════════════════════════════════════════ */
describe("orders that are not this company's", () => {
  test("a link to another customer's order is refused everywhere, even if 'confirmed'", async () => {
    const foreign = await order({ customerId: oid() });
    await workOrderOn(foreign);
    const d = await deal({ storedLink: foreign, confirmed: true });

    const res = await onEnquiry(d, "/production");
    expect(res.body.linked).toBe(false);
    expect(res.body.orderLink.status).toBe("unverified");
    expect(res.body.orderLink.customerRequestId).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/REQ-2026|WO-/);
    expect(await orderBookLink.provedEnquiryForOrder(await svcCtx(), foreign)).toBeNull();
  });

  describe("with two companies", () => {
    const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
    let CO_B;
    beforeEach(async () => {
      const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
      CO_B = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
      await SpCompanyMembership.deleteMany({});
      await SpCompanyMembership.create({ companyId: CO._id, employeeRef: OWNER.id, personName: OWNER.name });
    });

    test("a confirmed link to a customer company B also links is not proved", async () => {
      const shared = oid();
      await Account.collection.insertOne({ companyId: CO_B._id, companyName: "B", status: "active", linkedCustomer: shared });
      const x = await order({ customerId: shared });
      await workOrderOn(x);
      const d = await deal({ accountCompanyId: CO._id, customerId: shared, storedLink: x, confirmed: true });

      const res = await onEnquiry(d, "/production");
      expect(res.body.linked).toBe(false);
      expect(JSON.stringify(res.body)).not.toMatch(/REQ-2026|WO-|Other Co/);
    });

    test("company B's context never finds company A's enquiry for an order", async () => {
      const d = await deal({ accountCompanyId: CO._id });
      const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
      await Enquiry.collection.updateOne({ _id: d.enquiryId }, { $set: { customerRequestId: mine } });
      const ctxA = await createServiceContext({ companyId: CO._id, reason: "test", legacyAware: true });
      const ctxB = await createServiceContext({ companyId: CO_B._id, reason: "test", legacyAware: true });
      expect(await orderBookLink.provedEnquiryForOrder(ctxA, mine)).not.toBeNull();
      expect(await orderBookLink.provedEnquiryForOrder(ctxB, mine)).toBeNull();
    });
  });
});

/* ══ A PROFORMA RAISED FROM THE ENQUIRY ═════════════════════════════════════
 * Driven through the real `recordProforma`, which every proforma creation,
 * replay and lost race calls.
 * ═════════════════════════════════════════════════════════════════════════ */
describe("the proforma supersession path", () => {
  const raise = async (d, requestId, opt) => recordProforma(
    { companyId: CO._id }, await Enquiry.findOne({ _id: d.enquiryId }), { _id: requestId }, opt,
  );

  test("an order raised from the enquiry replaces a guessed link, which no longer looks authoritative", async () => {
    const customerId = oid();
    const guessed = await order({ customerId });
    const d = await deal({ customerId, storedLink: guessed });
    const mine = await order({ customerId, origin: d.enquiryId });

    await raise(d, mine);

    const e = await enquiryOf(d.enquiryId);
    expect(String(e.customerRequestId)).toBe(String(mine));
    expect(e.orderLink.method).toBe("sales_origin");
    expect(String(e.orderLink.replacedCustomerRequestId)).toBe(String(guessed));
    expect(String((await OrderLinkClaim.findById(mine).lean()).enquiryId)).toBe(String(d.enquiryId));
    const link = await call(`/${d.journeyId}/order-link`);
    expect(link.body.orderLink).toMatchObject({ status: "linked", method: "sales_origin", customerRequestId: String(mine) });
  });

  test("a link a salesperson confirmed is kept, and reported as a conflict for a person to settle", async () => {
    const customerId = oid();
    const chosen = await order({ customerId });
    const d = await deal({ customerId, storedLink: chosen, confirmed: true });
    const mine = await order({ customerId, origin: d.enquiryId });

    await raise(d, mine);

    expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(chosen));
    const link = await call(`/${d.journeyId}/order-link`);
    expect(link.body.orderLink.status).toBe("conflict");
  });

  test("a successor replaces its predecessor and moves the claim with it", async () => {
    const d = await deal();
    const first = await order({ customerId: d.customerId, origin: d.enquiryId, createdAt: new Date(Date.now() - DAY) });
    await raise(d, first);
    expect(await OrderLinkClaim.exists({ _id: first })).toBeTruthy();

    const second = await order({ customerId: d.customerId, origin: d.enquiryId, supersedes: first });
    await raise(d, second, { superseding: true });

    const e = await enquiryOf(d.enquiryId);
    expect(String(e.customerRequestId)).toBe(String(second));
    expect(String(e.orderLink.replacedCustomerRequestId)).toBe(String(first));
    expect(await OrderLinkClaim.exists({ _id: first })).toBeNull();
    expect(String((await OrderLinkClaim.findById(second).lean()).enquiryId)).toBe(String(d.enquiryId));
  });

  test("a superseded predecessor replayed late never takes the link back", async () => {
    const d = await deal();
    const first = await order({ customerId: d.customerId, origin: d.enquiryId, createdAt: new Date(Date.now() - DAY) });
    const second = await order({ customerId: d.customerId, origin: d.enquiryId, supersedes: first });
    await raise(d, second);
    await raise(d, first);
    expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(second));
  });

  test("an order raised from ANOTHER enquiry is never written, whatever the caller passes", async () => {
    const d = await deal();
    const theirs = await order({ customerId: d.customerId, origin: oid() });
    await raise(d, theirs);
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
    expect(await OrderLinkClaim.exists({ _id: theirs })).toBeNull();
  });

  test("two current orders from one enquiry: nothing is written", async () => {
    const d = await deal();
    const a = await order({ customerId: d.customerId, origin: d.enquiryId });
    await order({ customerId: d.customerId, origin: d.enquiryId });
    await raise(d, a);
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });

  test("a replay is idempotent: one link, one claim, no rewrite", async () => {
    const d = await deal();
    const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
    await raise(d, mine);
    const stamp = (await enquiryOf(d.enquiryId)).orderLink.confirmedAt;
    await raise(d, mine);
    await raise(d, mine);
    expect((await enquiryOf(d.enquiryId)).orderLink.confirmedAt.getTime()).toBe(stamp.getTime());
    expect(await OrderLinkClaim.countDocuments({})).toBe(1);
  });

  test("a link recorded before claims existed gets its claim on the next replay", async () => {
    const d = await deal();
    const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
    await Enquiry.collection.updateOne({ _id: d.enquiryId }, {
      $set: { customerRequestId: mine, orderLink: { customerRequestId: mine, method: "sales_origin", confirmedAt: new Date() } },
    });
    await raise(d, mine);
    expect(String((await OrderLinkClaim.findById(mine).lean()).enquiryId)).toBe(String(d.enquiryId));
  });
});

/* ══ ONE ORDER, ONE ENQUIRY ════════════════════════════════════════════════ */
describe("concurrent claims", () => {
  /** Two deals of one company, both for the same portal customer. */
  async function twoDeals() {
    const a = await deal();
    const b = await deal({ customerId: a.customerId });
    const x = await order({ customerId: a.customerId });
    return { a, b, x };
  }
  const linkers = async (x) => (await Enquiry.collection.find({ customerRequestId: x }).toArray()).map((e) => String(e._id));

  test("two salespeople choosing one order at once: exactly one wins, the other is refused", async () => {
    const { a, b, x } = await twoDeals();
    const [ra, rb] = await Promise.all([
      choose(a, { customerRequestId: String(x), expectedCustomerRequestId: null }),
      choose(b, { customerRequestId: String(x), expectedCustomerRequestId: null }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 422]);
    expect(await linkers(x)).toHaveLength(1);
    const winner = ra.status === 200 ? a : b;
    expect(String((await OrderLinkClaim.findById(x).lean()).enquiryId)).toBe(String(winner.enquiryId));
  });

  test("the database claim, not the pre-check, is what stops the second enquiry", async () => {
    const { a, b, x } = await twoDeals();
    expect((await choose(a, { customerRequestId: String(x), expectedCustomerRequestId: null })).status).toBe(200);

    /* Blind the candidate pre-check entirely — as if B read before A wrote. */
    const claimSpy = jest.spyOn(OrderLinkClaim, "find").mockImplementation(() => ({ lean: async () => [] }));
    const enqFind = Enquiry.find.bind(Enquiry);
    const enqSpy = jest.spyOn(Enquiry, "find").mockImplementation((filter, ...rest) => (
      JSON.stringify(filter).includes("\"$in\"")
        ? { select: () => ({ lean: async () => [] }) }
        : enqFind(filter, ...rest)));
    let res;
    try {
      res = await choose(b, { customerRequestId: String(x), expectedCustomerRequestId: null });
    } finally {
      claimSpy.mockRestore();
      enqSpy.mockRestore();
    }
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("not_a_candidate");
    expect(await linkers(x)).toEqual([String(a.enquiryId)]);
  });

  test("a claim for a write still in flight blocks another enquiry", async () => {
    const { a, b, x } = await twoDeals();
    await OrderLinkClaim.collection.insertOne({ _id: x, enquiryId: b.enquiryId, method: "manual", claimedAt: new Date() });
    const res = await choose(a, { customerRequestId: String(x), expectedCustomerRequestId: null });
    expect(res.status).toBe(422);
    expect((await enquiryOf(a.enquiryId)).customerRequestId).toBeNull();
  });

  test("a dead claim (crash between claim and link) is taken over after the grace period", async () => {
    const { a, b, x } = await twoDeals();
    await OrderLinkClaim.collection.insertOne({
      _id: x, enquiryId: b.enquiryId, method: "manual", claimedAt: new Date(Date.now() - 10 * 60 * 1000),
    });
    const res = await choose(a, { customerRequestId: String(x), expectedCustomerRequestId: null });
    expect(res.status).toBe(200);
    expect(String((await OrderLinkClaim.findById(x).lean()).enquiryId)).toBe(String(a.enquiryId));
  });

  test("replacing a link releases the old order for other deals", async () => {
    const { a, b, x } = await twoDeals();
    const y = await order({ customerId: a.customerId });
    await choose(a, { customerRequestId: String(x), expectedCustomerRequestId: null });
    await choose(a, { customerRequestId: String(y), expectedCustomerRequestId: String(x), reason: "Wrong programme picked" });

    expect(await OrderLinkClaim.exists({ _id: x })).toBeNull();
    const res = await choose(b, { customerRequestId: String(x), expectedCustomerRequestId: null });
    expect(res.status).toBe(200);
  });

  test("a failed conditional write releases the claim it just made", async () => {
    const { a, x } = await twoDeals();
    const ctx = await svcCtx();
    const enquiry = await Enquiry.findOne({ _id: a.enquiryId });
    // The link moves underneath the chooser after it read the enquiry.
    await Enquiry.collection.updateOne({ _id: a.enquiryId }, { $set: { customerRequestId: oid() } });
    await expect(orderBookLink.chooseOrderLink(ctx, enquiry, {
      customerRequestId: String(x), expectedCustomerRequestId: null, actor: OWNER,
    })).rejects.toMatchObject({ code: "link_changed" });
    expect(await OrderLinkClaim.exists({ _id: x })).toBeNull();
  });
});

/* ══ RETRIES ═══════════════════════════════════════════════════════════════ */
describe("retries", () => {
  test("PO retries on an origin order leave one link and one claim", async () => {
    const d = await deal();
    const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
    for (const n of ["PO-1", "PO-1", "PO-1-A"]) {
      const r = await call(`/${d.journeyId}/po`, { method: "PATCH", body: { number: n } });
      expect(r.body.orderLink).toMatchObject({ status: "linked", customerRequestId: String(mine) });
    }
    expect(await OrderLinkClaim.countDocuments({})).toBe(1);
  });

  test("a repeated choice is a no-op and keeps the single claim", async () => {
    const d = await deal();
    const x = await order({ customerId: d.customerId });
    await choose(d, { customerRequestId: String(x), expectedCustomerRequestId: null });
    const again = await choose(d, { customerRequestId: String(x), expectedCustomerRequestId: null });
    expect(again.body.changed).toBe(false);
    expect(await OrderLinkClaim.countDocuments({})).toBe(1);
  });

  test("the quotation screen re-opening the same proforma is a no-op", async () => {
    const d = await deal();
    const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
    const open = () => onEnquiry(d, "/link-request", { method: "PATCH", body: { requestId: String(mine) } });
    await open();
    const stamp = (await enquiryOf(d.enquiryId)).orderLink.confirmedAt;
    await open();
    expect((await enquiryOf(d.enquiryId)).orderLink.confirmedAt.getTime()).toBe(stamp.getTime());
    expect(await OrderLinkClaim.countDocuments({})).toBe(1);
  });
});
