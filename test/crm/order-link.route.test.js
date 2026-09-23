// test/crm/order-link.route.test.js
//
// G02 — A PO IS LINKED TO THE EXACT ORDER, OR REPORTED AS NOT LINKED.
//
// Recording a PO used to pin the enquiry to the NEWEST CustomerRequest of the
// account's portal customer. A customer with two open orders got the wrong one
// silently, and every post-PO screen trusted it. The quotation screen's
// link-request did the same with whatever row a name search listed first, and
// accepted any request id at all.
//
// Now an order is linked only on proof — raised from this enquiry, or chosen
// by an authorised salesperson from this company's own candidates — and the PO
// is recorded either way. Every test drives the real routes over HTTP against
// isolated in-memory data. Nothing touches Atlas.
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
const { recordChange } = require("../../services/changeLog");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };
const STRANGER = { id: new mongoose.Types.ObjectId().toString(), name: "Someone Else", role: "sales" };

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
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  recordChange.mockClear();
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
const po = (journeyId, number = "PO-7781", user = OWNER) => call(`/${journeyId}/po`, {
  method: "PATCH", user, body: { number, amount: 250000 },
});
const getLink = (journeyId, user = OWNER) => call(`/${journeyId}/order-link`, { user });
const choose = (journeyId, body, user = OWNER) => call(`/${journeyId}/order-link`, { method: "POST", user, body });
const enquiryOf = (enquiryId) => Enquiry.collection.findOne({ _id: enquiryId });

/**
 * A deal: an account (optionally linked to a portal customer), a journey
 * created through the real route, and its active enquiry.
 */
async function deal(opt = {}) {
  const customerId = opt.customerId || oid();
  const account = await Account.create({
    companyName: "MetroCare Hospitals", status: "active",
    ...(opt.accountCompanyId ? { companyId: opt.accountCompanyId } : {}),
    ...(opt.accountLinked === false ? {} : { linkedCustomer: customerId }),
  });
  const { body } = await call("", {
    method: "POST",
    body: { accountId: String(account._id), name: "MetroCare Uniform Program", businessType: "uniform" },
  });
  const journeyId = body.journey.id;
  const journey = await SalesJourney.findOne({ journeyId }).lean();
  const enquiryId = oid();
  await Enquiry.collection.insertOne({
    _id: enquiryId, enquiryId: `ENQ-${journeyId}`, journeyId: journey._id, isActive: true, companyId: journey.companyId,
    accountId: account._id, customerRequestId: opt.storedLink || null,
  });
  return { journeyId, journey, enquiryId, customerId, account };
}

let seq = 0;
/** An order record, inserted directly: fixtures for a READ path. */
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
    items: [{ stockItemName: "Housekeeping shirt", totalQuantity: 400 }],
    ...(origin || supersedes ? {
      salesOrigin: { ...(origin ? { enquiryId: origin } : {}), ...(supersedes ? { supersedesRequestId: supersedes } : {}) },
    } : {}),
    ...rest,
  });
  return _id;
}

/* ══ THE GUESS IS GONE ═════════════════════════════════════════════════════ */

test("same customer, two orders, none raised from the enquiry: PO recorded, order NOT linked, nothing guessed", async () => {
  const d = await deal();
  const older = await order({ customerId: d.customerId, createdAt: new Date(Date.now() - 5 * DAY) });
  const newer = await order({ customerId: d.customerId });

  const res = await po(d.journeyId);

  expect(res.status).toBe(200);
  expect(res.body.journey.po?.number || (await SalesJourney.findOne({ journeyId: d.journeyId }).lean()).po.number)
    .toBe("PO-7781");
  expect(res.body.orderLink.status).toBe("not_linked");
  expect(res.body.orderLink.message).toMatch(/Order not linked/);
  expect(res.body.orderLink.needsChoice).toBe(true);
  expect(res.body.orderLink.candidateCount).toBe(2);
  expect(res.body.orderLink.customerRequestId).toBeNull();
  // The newest-request guess would have written `newer` here.
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();

  const got = await getLink(d.journeyId);
  expect(got.body.candidates.map((c) => c.customerRequestId).sort()).toEqual([String(older), String(newer)].sort());
  expect(got.body.candidates.every((c) => c.source === "portal" && !c.isCurrentLink)).toBe(true);
});

test("a Sales-created order is linked exactly, even when a newer order exists for the same customer", async () => {
  const d = await deal();
  const mine = await order({ customerId: d.customerId, origin: d.enquiryId, createdAt: new Date(Date.now() - 3 * DAY) });
  await order({ customerId: d.customerId }); // newer portal order: the old guess's pick

  const res = await po(d.journeyId);

  expect(res.body.orderLink).toMatchObject({ status: "linked", method: "sales_origin", customerRequestId: String(mine) });
  const e = await enquiryOf(d.enquiryId);
  expect(String(e.customerRequestId)).toBe(String(mine));
  expect(e.orderLink.method).toBe("sales_origin");
  expect(String(e.orderLink.customerRequestId)).toBe(String(mine));
});

test("an order raised from ANOTHER enquiry of the same customer is never this deal's", async () => {
  const d = await deal();
  const other = await order({ customerId: d.customerId, origin: oid() });

  const res = await po(d.journeyId);
  expect(res.body.orderLink.status).toBe("not_linked");
  expect(res.body.orderLink.candidateCount).toBe(0);
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();

  const refused = await choose(d.journeyId, { customerRequestId: String(other), expectedCustomerRequestId: null });
  expect(refused.status).toBe(422);
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
});

test("a superseded proforma resolves to its successor", async () => {
  const d = await deal();
  const first = await order({ customerId: d.customerId, origin: d.enquiryId, createdAt: new Date(Date.now() - DAY) });
  const second = await order({ customerId: d.customerId, origin: d.enquiryId, supersedes: first });

  const res = await po(d.journeyId);
  expect(res.body.orderLink).toMatchObject({ status: "linked", customerRequestId: String(second) });
});

test("two current orders raised from one enquiry are ambiguous: reported, not picked", async () => {
  const d = await deal();
  const a = await order({ customerId: d.customerId, origin: d.enquiryId });
  await order({ customerId: d.customerId, origin: d.enquiryId });

  const res = await po(d.journeyId);
  expect(res.body.orderLink.status).toBe("ambiguous");
  expect(res.body.orderLink.candidateCount).toBe(2);
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();

  const ok = await choose(d.journeyId, { customerRequestId: String(a), expectedCustomerRequestId: null });
  expect(ok.status).toBe(200);
  expect(ok.body.orderLink).toMatchObject({ status: "linked", method: "sales_origin", customerRequestId: String(a) });
});

/* ══ MISSING LINKS ═════════════════════════════════════════════════════════ */

test("an account with no portal customer: the PO is recorded and the order is reported not linked", async () => {
  const d = await deal({ accountLinked: false });
  const res = await po(d.journeyId);

  expect(res.status).toBe(200);
  expect((await SalesJourney.findOne({ journeyId: d.journeyId }).lean()).po.number).toBe("PO-7781");
  expect(res.body.orderLink).toMatchObject({ status: "not_linked", candidateCount: 0 });

  const got = await getLink(d.journeyId);
  expect(got.body.candidates).toEqual([]);
});

test("a journey with no enquiry: the PO is recorded, the link unavailable", async () => {
  const d = await deal();
  await Enquiry.collection.deleteMany({});
  const res = await po(d.journeyId);
  expect(res.status).toBe(200);
  expect(res.body.orderLink.status).toBe("unavailable");
});

test("a failing order lookup never fails the PO", async () => {
  const d = await deal();
  const spy = jest.spyOn(CustomerRequest, "find").mockImplementation(() => { throw new Error("replica set unreachable"); });
  let res;
  try { res = await po(d.journeyId); } finally { spy.mockRestore(); }
  expect(res.status).toBe(200);
  expect(res.body.orderLink.status).toBe("unavailable");
  expect((await SalesJourney.findOne({ journeyId: d.journeyId }).lean()).po.number).toBe("PO-7781");
});

/* ══ RETRIES AND CORRECTIONS ═══════════════════════════════════════════════ */

test("a PO retry and a PO correction resolve to the same link and write it once", async () => {
  const d = await deal();
  const mine = await order({ customerId: d.customerId, origin: d.enquiryId });

  const first = await po(d.journeyId, "PO-7781");
  const stamp = (await enquiryOf(d.enquiryId)).orderLink.confirmedAt;
  const retry = await po(d.journeyId, "PO-7781");
  const corrected = await po(d.journeyId, "PO-7781-A");

  for (const r of [first, retry, corrected]) {
    expect(r.status).toBe(200);
    expect(r.body.orderLink).toMatchObject({ status: "linked", customerRequestId: String(mine) });
  }
  const e = await enquiryOf(d.enquiryId);
  expect(e.orderLink.confirmedAt.getTime()).toBe(stamp.getTime());
  expect((await SalesJourney.findOne({ journeyId: d.journeyId }).lean()).po.number).toBe("PO-7781-A");
});

test("a PO correction never replaces a link a salesperson chose", async () => {
  const d = await deal();
  const chosen = await order({ customerId: d.customerId, createdAt: new Date(Date.now() - DAY) });
  await order({ customerId: d.customerId });
  await choose(d.journeyId, { customerRequestId: String(chosen), expectedCustomerRequestId: null });

  const res = await po(d.journeyId, "PO-7781-B");
  expect(res.body.orderLink).toMatchObject({ status: "linked", method: "manual", customerRequestId: String(chosen) });
  expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(chosen));
});

/* ══ AN AUTHORISED SALESPERSON CHOOSES ═════════════════════════════════════ */

test("a measurement order is offered and can be chosen; re-sending the choice changes nothing", async () => {
  const d = await deal();
  const measured = await order({
    customerId: d.customerId, requestType: "measurement_conversion", measurementName: "Ward staff Sept",
  });
  await po(d.journeyId);

  const got = await getLink(d.journeyId);
  expect(got.body.candidates).toHaveLength(1);
  expect(got.body.candidates[0]).toMatchObject({ source: "measurement", measurementName: "Ward staff Sept" });
  // Recognisable, but no money on the chooser.
  expect(JSON.stringify(got.body.candidates)).not.toMatch(/grandTotal|price/i);

  recordChange.mockClear();
  const first = await choose(d.journeyId, { customerRequestId: String(measured), expectedCustomerRequestId: null });
  expect(first.status).toBe(200);
  expect(first.body.changed).toBe(true);
  expect(first.body.orderLink).toMatchObject({ status: "linked", method: "manual", confirmedBy: OWNER.name });
  expect(recordChange).toHaveBeenCalledTimes(1);

  const again = await choose(d.journeyId, { customerRequestId: String(measured), expectedCustomerRequestId: null });
  expect(again.status).toBe(200);
  expect(again.body.changed).toBe(false);
  expect(recordChange).toHaveBeenCalledTimes(1);

  const e = await enquiryOf(d.enquiryId);
  expect(e.orderLink).toMatchObject({ method: "manual" });
  expect(e.orderLink.confirmedBy.name).toBe(OWNER.name);
});

test("replacing a link needs the link you saw and a reason", async () => {
  const d = await deal();
  const a = await order({ customerId: d.customerId, createdAt: new Date(Date.now() - DAY) });
  const b = await order({ customerId: d.customerId });
  await choose(d.journeyId, { customerRequestId: String(a), expectedCustomerRequestId: null });

  const stale = await choose(d.journeyId, { customerRequestId: String(b), expectedCustomerRequestId: null, reason: "Wrong programme" });
  expect(stale.status).toBe(409);
  expect(stale.body.code).toBe("link_changed");

  const noReason = await choose(d.journeyId, { customerRequestId: String(b), expectedCustomerRequestId: String(a) });
  expect(noReason.status).toBe(400);
  expect(noReason.body.code).toBe("reason_required");
  expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(a));

  const ok = await choose(d.journeyId, {
    customerRequestId: String(b), expectedCustomerRequestId: String(a), reason: "PO is for the reorder, not the pilot",
  });
  expect(ok.status).toBe(200);
  const e = await enquiryOf(d.enquiryId);
  expect(String(e.customerRequestId)).toBe(String(b));
  expect(String(e.orderLink.replacedCustomerRequestId)).toBe(String(a));
  expect(e.orderLink.reason).toMatch(/reorder/);
});

test("the expected link is required, so a blind POST cannot overwrite", async () => {
  const d = await deal();
  const a = await order({ customerId: d.customerId });
  const res = await choose(d.journeyId, { customerRequestId: String(a) });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("expected_required");
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
});

test("only the owner or a Sales manager may choose or list", async () => {
  const d = await deal();
  const a = await order({ customerId: d.customerId });
  expect((await getLink(d.journeyId, STRANGER)).status).toBe(403);
  const res = await choose(d.journeyId, { customerRequestId: String(a), expectedCustomerRequestId: null }, STRANGER);
  expect(res.status).toBe(403);
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();

  const manager = { ...STRANGER, departmentRole: "approver" };
  const ok = await choose(d.journeyId, { customerRequestId: String(a), expectedCustomerRequestId: null }, manager);
  expect(ok.status).toBe(200);
});

test("cancelled, sampling, superseded and already-held orders are not offered and cannot be chosen", async () => {
  const d = await deal();
  const cancelled = await order({ customerId: d.customerId, status: "cancelled" });
  const sampling = await order({ customerId: d.customerId, orderOrigin: "sampling" });
  const replaced = await order({ customerId: d.customerId });
  await order({ customerId: d.customerId, origin: oid(), supersedes: replaced });
  const held = await order({ customerId: d.customerId });
  await Enquiry.collection.insertOne({
    _id: oid(), enquiryId: "ENQ-OTHER", journeyId: oid(), isActive: true,
    companyId: d.journey.companyId, customerRequestId: held,
  });
  const good = await order({ customerId: d.customerId });

  const got = await getLink(d.journeyId);
  expect(got.body.candidates.map((c) => c.customerRequestId)).toEqual([String(good)]);

  for (const bad of [cancelled, sampling, replaced, held, oid()]) {
    const res = await choose(d.journeyId, { customerRequestId: String(bad), expectedCustomerRequestId: null });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe("not_a_candidate");
  }
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
});

/* ══ LINKS WRITTEN BEFORE G02 ═════════════════════════════════════════════ */

test("a link written by the old guess is reported unverified, kept, and can be confirmed", async () => {
  const customerId = oid();
  const guessed = await order({ customerId });
  const d = await deal({ customerId, storedLink: guessed });

  const res = await po(d.journeyId);
  expect(res.body.orderLink).toMatchObject({ status: "unverified", customerRequestId: String(guessed), needsChoice: true });
  expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(guessed));

  const ok = await choose(d.journeyId, { customerRequestId: String(guessed), expectedCustomerRequestId: String(guessed) });
  expect(ok.status).toBe(200);
  expect(ok.body.orderLink).toMatchObject({ status: "linked", method: "manual" });
});

test("a stored guess that disagrees with the order raised from this enquiry is a conflict, not silently changed", async () => {
  const customerId = oid();
  const guessed = await order({ customerId });
  const d = await deal({ customerId, storedLink: guessed });
  const mine = await order({ customerId, origin: d.enquiryId });

  const res = await po(d.journeyId);
  expect(res.body.orderLink.status).toBe("conflict");
  expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(guessed));

  const got = await getLink(d.journeyId);
  expect(got.body.candidates.map((c) => c.customerRequestId)).toEqual([String(mine)]);

  const ok = await choose(d.journeyId, {
    customerRequestId: String(mine), expectedCustomerRequestId: String(guessed), reason: "Raised from this enquiry",
  });
  expect(ok.body.orderLink).toMatchObject({ status: "linked", method: "sales_origin", customerRequestId: String(mine) });
});

test("a stored link to another customer's order is unverified and never named", async () => {
  const foreign = await order({ customerId: oid() });
  const d = await deal({ storedLink: foreign });

  const res = await po(d.journeyId);
  expect(res.body.orderLink.status).toBe("unverified");
  expect(res.body.orderLink.customerRequestId).toBeNull();
  expect(JSON.stringify(res.body.orderLink)).not.toMatch(/REQ-2026/);
});

/* ══ THE QUOTATION SCREEN'S LINK ══════════════════════════════════════════ */

test("opening a portal proforma no longer links it; opening this enquiry's own does", async () => {
  const d = await deal();
  const portal = await order({ customerId: d.customerId });
  const linkReq = (requestId) => call(`/${d.enquiryId}/link-request`, {
    method: "PATCH", root: enquiriesBase, body: { requestId: String(requestId) },
  });

  const res = await linkReq(portal);
  expect(res.status).toBe(200);
  expect(res.body.orderLink.status).toBe("not_linked");
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();

  const foreign = await order({ customerId: oid() });
  const res2 = await linkReq(foreign);
  expect(res2.body.orderLink.status).toBe("not_linked");
  expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();

  const mine = await order({ customerId: d.customerId, origin: d.enquiryId });
  const res3 = await linkReq(portal); // whatever the browser sends, the proved one wins
  expect(res3.body.orderLink).toMatchObject({ status: "linked", customerRequestId: String(mine) });
  expect(String((await enquiryOf(d.enquiryId)).customerRequestId)).toBe(String(mine));
});

/* ══ TWO COMPANIES ═════════════════════════════════════════════════════════ */
describe("with two companies", () => {
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  let CO_B;

  beforeEach(async () => {
    const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
    CO_B = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
    await SpCompanyMembership.deleteMany({});
    await SpCompanyMembership.create({ companyId: CO._id, employeeRef: OWNER.id, personName: OWNER.name });
  });

  test("a portal customer also linked by company B offers no candidates and cannot be chosen", async () => {
    const shared = oid();
    await Account.collection.insertOne({
      companyId: CO_B._id, companyName: "MetroCare (B's account)", status: "active", linkedCustomer: shared,
    });
    const d = await deal({ accountCompanyId: CO._id, customerId: shared });
    const theirs = await order({ customerId: shared });

    const res = await po(d.journeyId);
    expect(res.status).toBe(200);
    expect(res.body.orderLink).toMatchObject({ status: "not_linked", candidateCount: 0 });

    const got = await getLink(d.journeyId);
    expect(got.body.candidates).toEqual([]);
    expect(JSON.stringify(got.body)).not.toMatch(/REQ-2026|Other Co|B's account/);

    const refused = await choose(d.journeyId, { customerRequestId: String(theirs), expectedCustomerRequestId: null });
    expect(refused.status).toBe(422);
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });

  test("an order raised from this enquiry is still proved when the customer is shared", async () => {
    const shared = oid();
    await Account.collection.insertOne({ companyId: CO_B._id, companyName: "B", status: "active", linkedCustomer: shared });
    const d = await deal({ accountCompanyId: CO._id, customerId: shared });
    const mine = await order({ customerId: shared, origin: d.enquiryId });

    const res = await po(d.journeyId);
    expect(res.body.orderLink).toMatchObject({ status: "linked", method: "sales_origin", customerRequestId: String(mine) });
  });

  test("company B's journey is not reachable from company A's order-link routes", async () => {
    const d = await deal({ accountCompanyId: CO._id });
    await SalesJourney.collection.updateOne({ _id: d.journey._id }, { $set: { companyId: CO_B._id } });
    const a = await order({ customerId: d.customerId });

    expect((await getLink(d.journeyId)).status).toBe(404);
    const res = await choose(d.journeyId, { customerRequestId: String(a), expectedCustomerRequestId: null });
    expect(res.status).toBe(404);
    expect((await enquiryOf(d.enquiryId)).customerRequestId).toBeNull();
  });

  test("an enquiry stamped to company B is invisible to company A's PO link", async () => {
    const d = await deal({ accountCompanyId: CO._id });
    const theirs = await order({ customerId: d.customerId, origin: d.enquiryId });
    // Company B's enquiry, already linked to B's order: nothing of it may surface.
    await Enquiry.collection.updateOne({ _id: d.enquiryId }, { $set: { companyId: CO_B._id, customerRequestId: theirs } });

    const res = await po(d.journeyId);
    expect(res.status).toBe(200);
    expect(res.body.orderLink.status).toBe("unavailable");
    expect(JSON.stringify(res.body.orderLink)).not.toMatch(/REQ-2026|linked"/);

    const got = await getLink(d.journeyId);
    expect(got.body.orderLink.status).toBe("unavailable");
    expect(got.body.candidates).toEqual([]);
  });
});
