// test/crm/commercial-defaults.route.test.js
//
// ACCOUNT-LEVEL COMMERCIAL DEFAULTS, AND AN ENQUIRY THAT MAY DEPART FROM THEM.
//
// The customer's usual terms live on the Account. Each enquiry is OFFERED
// them, may change them for that deal, and stores what it was given. The one
// thing that must never happen: the Account moving and, with it, what an
// existing enquiry — or a costing built on it — says was agreed.
//
// Every test drives the real routers over HTTP against in-memory data.
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
const Address = require("../../models/CMS_Models/Sales/Address");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Warehouse = require("../../models/CMS_Models/Inventory/Configurations/Warehouse");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const paymentTermsResolution = require("../../services/sales/paymentTermsResolution.service");
const deliveryTermsResolution = require("../../services/sales/deliveryTermsResolution.service");

const oid = () => new mongoose.Types.ObjectId();
const USER = { id: oid().toString(), name: "Anita Rao", role: "sales" };

let server;
let accountsBase;
let enquiriesBase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/accounts", require("../../routes/CMS_Routes/Sales/accounts"));
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const root = `http://127.0.0.1:${server.address().port}/api/cms/crm`;
  accountsBase = `${root}/accounts`;
  enquiriesBase = `${root}/enquiries`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(root, path, { method = "GET", body, user = USER } = {}) {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
const onAccount = (path, opt) => call(accountsBase, path, opt);
const onEnquiry = (path, opt) => call(enquiriesBase, path, opt);

let CO;
let CO_B;
let seq = 0;

beforeEach(async () => {
  await Promise.all([
    Account.collection.deleteMany({}), Address.collection.deleteMany({}),
    Enquiry.collection.deleteMany({}), Warehouse.collection.deleteMany({}),
    SpCompanyMembership.deleteMany({}),
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Company A", booksFromDate: new Date("2026-04-01") });
  CO_B = await Acc_Company.create({ companyName: "Company B", booksFromDate: new Date("2026-04-01") });
  await SpCompanyMembership.create({ companyId: CO._id, employeeRef: USER.id, personName: USER.name });
});

/** An account of this company, plus a shipping address on it. */
async function customer(defaults = {}, { companyId = null } = {}) {
  seq += 1;
  const account = await Account.create({
    companyId: companyId || CO._id, companyName: `MetroCare ${seq}`, status: "active", ...defaults,
  });
  const shipping = await Address.create({
    accountId: account._id, addressType: "shipping", recipient: "Gate 3",
    addressLine1: "Plot 14", city: "Bengaluru", isPrimaryForType: true,
  });
  const billing = await Address.create({
    accountId: account._id, addressType: "billing", addressLine1: "Finance office", city: "Bengaluru",
  });
  return { account, shipping, billing };
}

async function enquiryFor(account, freight = undefined) {
  const _id = oid();
  seq += 1;
  await Enquiry.collection.insertOne({
    _id, enquiryId: `ENQ-T-${seq}`, journeyId: oid(), isActive: true,
    companyId: account.companyId, accountId: account._id, title: "Uniform programme",
    ...(freight ? { freight } : {}),
  });
  return _id;
}

const storedEnquiry = (id) => Enquiry.collection.findOne({ _id: id });
const storedAccount = (id) => Account.collection.findOne({ _id: id });

/* ══ 1 · THE ACCOUNT'S OWN DEFAULTS ════════════════════════════════════════ */

describe("the customer's usual terms, on the Account", () => {
  test("payment and delivery defaults save, reload and clear", async () => {
    const { account, shipping } = await customer();

    const saved = await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: {
        advancePercent: 30, creditDays: 45, creditDaysFrom: "BILL_OF_LADING", paymentTermsCode: "NET45",
        freightArrangement: "prepaid", defaultPrepaidTreatment: "RECOVERED_SEPARATELY",
        defaultShippingAddressId: String(shipping._id), defaultTransportMode: "SEA",
        deliveryInstructions: "Gate pass 24h in advance.",
      },
    });
    expect(saved.status).toBe(200);

    const reloaded = await onAccount(`/${account._id}`);
    const a = reloaded.body.account;
    expect(a.advancePercent).toBe(30);
    expect(a.creditDaysFrom).toBe("BILL_OF_LADING");
    expect(a.freightArrangement).toBe("prepaid");
    expect(a.defaultPrepaidTreatment).toBe("RECOVERED_SEPARATELY");
    expect(String(a.defaultShippingAddressId)).toBe(String(shipping._id));
    expect(a.defaultTransportMode).toBe("SEA");
    expect(a.deliveryInstructions).toMatch(/Gate pass/);

    /* Clearing is a real act — "we have no standing advance any more" — and
       must not be stored as a zero or an empty enum. */
    const cleared = await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: {
        advancePercent: "", creditDays: "", creditDaysFrom: "", defaultTransportMode: "",
        defaultShippingAddressId: "", deliveryInstructions: "",
      },
    });
    expect(cleared.status).toBe(200);
    const after = await storedAccount(account._id);
    for (const k of ["advancePercent", "creditDays", "creditDaysFrom", "defaultTransportMode", "defaultShippingAddressId"]) {
      expect(after[k] ?? null).toBeNull();
    }
  });

  test("an account saved before these fields existed still loads and answers nothing", async () => {
    const legacy = await Account.collection.insertOne({
      companyId: CO._id, companyName: "Legacy Buyer", status: "active",
      advancePercent: 20, creditDays: 30, isActive: true,
    });
    const res = await onAccount(`/${legacy.insertedId}`);
    expect(res.status).toBe(200);
    expect(res.body.account.creditDaysFrom ?? null).toBeNull();
    expect(res.body.account.defaultTransportMode ?? null).toBeNull();
    /* And its suggestion is honest about the anchor nobody recorded. */
    expect(paymentTermsResolution.suggestionFor(res.body.account).creditDaysFrom).toBeNull();
  });

  test("defaults are refused by the same rules the enquiry applies", async () => {
    const { account, billing } = await customer();
    const refuse = (body) => onAccount(`/${account._id}`, { method: "PATCH", body });

    expect((await refuse({ advancePercent: 140 })).body.field).toBe("advancePercent");
    expect((await refuse({ creditDays: -5 })).body.field).toBe("creditDays");
    /* A duration with no anchor could never be applied to an enquiry. */
    expect((await refuse({ creditDays: 30 })).body.field).toBe("creditDaysFrom");
    /* A full advance leaves no balance to run a credit period against. */
    expect((await refuse({ advancePercent: 100, creditDays: 30, creditDaysFrom: "INVOICE" })).body.field)
      .toBe("creditDays");
    /* Prepaid without its price treatment is the question the codes cannot answer. */
    expect((await refuse({ freightArrangement: "prepaid" })).body.field).toBe("defaultPrepaidTreatment");
    /* A billing address is not a delivery destination. */
    const wrongType = await refuse({ defaultShippingAddressId: String(billing._id) });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.message).toMatch(/billing address/i);

    /* Nothing above was stored. */
    const after = await storedAccount(account._id);
    expect(after.advancePercent ?? null).toBeNull();
    expect(after.freightArrangement ?? null).toBeNull();
  });

  test("a shipping address on another company's account is refused", async () => {
    const mine = await customer();
    const theirs = await customer({}, { companyId: CO_B._id });
    const res = await onAccount(`/${mine.account._id}`, {
      method: "PATCH", body: { defaultShippingAddressId: String(theirs.shipping._id) },
    });
    expect(res.status).toBe(400);
    expect(res.body.field).toBe("defaultShippingAddressId");
    expect((await storedAccount(mine.account._id)).defaultShippingAddressId ?? null).toBeNull();
  });

  test("the prepaid treatment is dropped when the usual arrangement stops being prepaid", async () => {
    const { account } = await customer();
    await onAccount(`/${account._id}`, {
      method: "PATCH", body: { freightArrangement: "prepaid", defaultPrepaidTreatment: "IN_PRICE" },
    });
    await onAccount(`/${account._id}`, { method: "PATCH", body: { freightArrangement: "to_pay" } });
    const after = await storedAccount(account._id);
    expect(after.freightArrangement).toBe("to_pay");
    expect(after.defaultPrepaidTreatment ?? null).toBeNull();
  });
});

/* ══ 2 · OFFERED TO THE ENQUIRY, NEVER APPLIED BY OPENING IT ═══════════════ */

describe("the enquiry is offered the customer's terms", () => {
  const withDefaults = (shipping) => ({
    advancePercent: 30, creditDays: 45, creditDaysFrom: "DISPATCH", paymentTermsCode: "NET45",
    freightArrangement: "delivered", defaultTransportMode: "ROAD",
    defaultShippingAddressId: shipping._id, deliveryInstructions: "Gate pass 24h in advance.",
    defaultIncoterm: "DAP",
  });

  test("payment and delivery defaults are both suggested, counted-from included", async () => {
    const { account, shipping } = await customer();
    await Account.updateOne({ _id: account._id }, { $set: withDefaults(shipping) });
    const enquiryId = await enquiryFor(account);

    const res = await onEnquiry(`/${enquiryId}/commercial-defaults`);
    expect(res.status).toBe(200);
    expect(res.body.payment).toMatchObject({
      available: true, advancePercent: 30, creditDays: 45, creditDaysFrom: "DISPATCH", paymentTermsCode: "NET45",
    });
    expect(res.body.delivery).toMatchObject({
      available: true, arrangement: "delivered", mode: "ROAD", shippingAddressId: String(shipping._id),
    });
    expect(res.body.delivery.instructions).toMatch(/Gate pass/);
  });

  test("opening the enquiry records nothing at all", async () => {
    const { account, shipping } = await customer();
    await Account.updateOne({ _id: account._id }, { $set: withDefaults(shipping) });
    const enquiryId = await enquiryFor(account);
    const before = JSON.stringify(await storedEnquiry(enquiryId));

    await onEnquiry(`/${enquiryId}/commercial-defaults`);
    await onEnquiry(`/${enquiryId}/commercial-defaults`);

    expect(JSON.stringify(await storedEnquiry(enquiryId))).toBe(before);
    const stored = await storedEnquiry(enquiryId);
    expect(stored.freight ?? null).toBeNull();
    expect(stored.paymentTerms ?? null).toBeNull();
  });

  test("a customer with no standing terms offers none, and says so", async () => {
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    const res = await onEnquiry(`/${enquiryId}/commercial-defaults`);
    expect(res.body.payment.available).toBe(false);
    expect(res.body.delivery.available).toBe(false);
    expect(res.body.delivery.label).toBeNull();
  });

  test("applying the defaults copies them onto the enquiry, recorded as the customer's", async () => {
    const { account, shipping } = await customer();
    await Account.updateOne({ _id: account._id }, { $set: withDefaults(shipping) });
    const enquiryId = await enquiryFor(account);
    const offered = (await onEnquiry(`/${enquiryId}/commercial-defaults`)).body;

    const saved = await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: {
        freight: {
          arrangement: offered.delivery.arrangement,
          mode: offered.delivery.mode,
          shippingAddressId: offered.delivery.shippingAddressId,
        },
      },
    });
    expect(saved.status).toBe(200);

    const stored = await storedEnquiry(enquiryId);
    expect(stored.freight.arrangement).toBe("delivered");
    expect(stored.freight.mode).toBe("ROAD");
    expect(String(stored.freight.shippingAddressId)).toBe(String(shipping._id));
    /* Provenance: the customer's terms, applied — not a deviation. */
    expect(stored.freight.source).toBe("ACCOUNT");
    expect(stored.freight.accountDefaultAtSave.arrangement).toBe("delivered");
    expect(stored.freight.incoterm).toBe("DAP");
    expect(stored.freight.savedAt).toBeTruthy();
    expect(stored.freight.savedBy.name).toBe(USER.name);
  });

  test("changing a value for this deal is recorded as an override, and the Account is untouched", async () => {
    const { account, shipping } = await customer();
    await Account.updateOne({ _id: account._id }, { $set: withDefaults(shipping) });
    const accountBefore = JSON.stringify(await storedAccount(account._id));
    const enquiryId = await enquiryFor(account);

    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { freight: { arrangement: "delivered", mode: "AIR", shippingAddressId: String(shipping._id) } },
    });

    const stored = await storedEnquiry(enquiryId);
    expect(stored.freight.mode).toBe("AIR");
    expect(stored.freight.source).toBe("ENQUIRY");
    /* Legible as a DIFFERENCE from what the customer usually does. */
    expect(stored.freight.accountDefaultAtSave.mode).toBe("ROAD");
    /* And the customer's standing terms are exactly as they were. */
    expect(JSON.stringify(await storedAccount(account._id))).toBe(accountBefore);
  });

  test("a later change to the Account cannot restate what an enquiry already agreed", async () => {
    const { account, shipping } = await customer();
    await Account.updateOne({ _id: account._id }, { $set: withDefaults(shipping) });
    const enquiryId = await enquiryFor(account);
    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { freight: { arrangement: "delivered", mode: "ROAD", shippingAddressId: String(shipping._id) } },
    });
    /* Confirmed payment terms, taken from the same standing terms. */
    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { paymentTerms: { advancePercent: 30, creditDays: 45, creditDaysFrom: "DISPATCH", confirm: true } },
    });

    /* The customer renegotiates everything, months later. */
    await onAccount(`/${account._id}`, {
      method: "PATCH",
      body: {
        advancePercent: 0, creditDays: 90, creditDaysFrom: "INVOICE",
        freightArrangement: "ex_works", defaultTransportMode: "SEA",
      },
    });

    const stored = await storedEnquiry(enquiryId);
    expect(stored.freight.arrangement).toBe("delivered");
    expect(stored.freight.mode).toBe("ROAD");
    expect(stored.paymentTerms.advancePercent).toBe(30);
    expect(stored.paymentTerms.creditDays).toBe(45);
    expect(stored.paymentTerms.source).toBe("ACCOUNT");
    /* What the account said THEN, kept beside what it says now. */
    expect(stored.paymentTerms.accountDefaultAtConfirmation.creditDays).toBe(45);
  });
});

/* ══ 2b · PARTIAL DEFAULTS, ISOLATION AND REPEATED SAVES ═══════════════════ */

describe("partial defaults, isolation and repeated saves", () => {
  test("a customer with only some terms offers those, and says nothing about the rest", async () => {
    /* Half an agreement is still an agreement about that half. What the
       customer has never settled stays blank rather than being filled in
       with a plausible-looking guess. */
    const { account } = await customer();
    await Account.updateOne({ _id: account._id }, { $set: { advancePercent: 50, freightArrangement: "to_pay" } });
    const enquiryId = await enquiryFor(account);

    const res = await onEnquiry(`/${enquiryId}/commercial-defaults`);
    expect(res.body.payment).toMatchObject({ available: true, advancePercent: 50 });
    expect(res.body.payment.creditDays).toBeNull();
    expect(res.body.payment.creditDaysFrom).toBeNull();
    expect(res.body.delivery).toMatchObject({ available: true, arrangement: "to_pay" });
    expect(res.body.delivery.mode).toBeNull();
    expect(res.body.delivery.shippingAddressId).toBeNull();
    /* A to-pay customer is never asked how prepaid freight is treated. */
    expect(res.body.delivery.prepaidTreatment).toBeNull();
  });

  test("another company's enquiry and account are not reachable at all", async () => {
    const theirs = await customer({}, { companyId: CO_B._id });
    const theirEnquiry = await enquiryFor(theirs.account);

    expect((await onEnquiry(`/${theirEnquiry}/commercial-defaults`)).status).toBe(404);
    expect((await onEnquiry(`/${theirEnquiry}`, {
      method: "PATCH", body: { freight: { arrangement: "delivered" } },
    })).status).toBe(404);

    const patched = await onAccount(`/${theirs.account._id}`, {
      method: "PATCH", body: { advancePercent: 90 },
    });
    expect(patched.status).toBe(404);
    expect((await storedAccount(theirs.account._id)).advancePercent ?? null).toBeNull();
  });

  test("an unauthenticated caller reaches none of it", async () => {
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    const bare = (root, path, opt = {}) => fetch(`${root}${path}`, {
      method: opt.method || "GET",
      headers: { "Content-Type": "application/json" },
      ...(opt.body ? { body: JSON.stringify(opt.body) } : {}),
    }).then((r) => r.status);

    expect(await bare(enquiriesBase, `/${enquiryId}/commercial-defaults`)).toBe(401);
    expect(await bare(accountsBase, `/${account._id}`, { method: "PATCH", body: { advancePercent: 10 } })).toBe(401);
  });

  test("saving the same terms twice changes nothing but the timestamp", async () => {
    /* A double click, or a person pressing save again to be sure. It must not
       produce a second, different answer. */
    const { account, shipping } = await customer();
    const enquiryId = await enquiryFor(account);
    const body = {
      freight: { arrangement: "delivered", mode: "ROAD", shippingAddressId: String(shipping._id) },
    };

    const [first, second] = await Promise.all([
      onEnquiry(`/${enquiryId}`, { method: "PATCH", body }),
      onEnquiry(`/${enquiryId}`, { method: "PATCH", body }),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);

    const stored = (await storedEnquiry(enquiryId)).freight;
    expect(stored.arrangement).toBe("delivered");
    expect(stored.mode).toBe("ROAD");
    expect(String(stored.shippingAddressId)).toBe(String(shipping._id));
    expect(stored.source).toBe("ENQUIRY");
  });

  test("a refused save writes nothing and leaves the previous terms standing", async () => {
    const { account, shipping } = await customer();
    const enquiryId = await enquiryFor(account);
    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { freight: { arrangement: "delivered", mode: "ROAD", shippingAddressId: String(shipping._id) } },
    });
    const before = JSON.stringify((await storedEnquiry(enquiryId)).freight);

    const refused = await onEnquiry(`/${enquiryId}`, {
      method: "PATCH", body: { freight: { arrangement: "delivered", mode: "TELEPORT" } },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe("mode");
    expect(JSON.stringify((await storedEnquiry(enquiryId)).freight)).toBe(before);

    /* And the same for payment terms. */
    const badPayment = await onEnquiry(`/${enquiryId}`, {
      method: "PATCH", body: { paymentTerms: { advancePercent: 250 } },
    });
    expect(badPayment.status).toBe(400);
    /* No figure was recorded. (The empty shell `{notApplicable:false}` is a
       schema default materialised by the earlier save, and still reads as
       nobody having answered.) */
    const afterBad = (await storedEnquiry(enquiryId)).paymentTerms || {};
    expect(afterBad.advancePercent ?? null).toBeNull();
    expect(paymentTermsResolution.stateOf(afterBad)).toBe("NOT_STARTED");
  });
});

/* ══ 2c · THE SHAPE OF WHAT WAS AGREED ═════════════════════════════════════ */

describe("payment terms keep the shape they were agreed in", () => {
  const save = (enquiryId, paymentTerms) => onEnquiry(`/${enquiryId}`, { method: "PATCH", body: { paymentTerms } });

  test("each agreement stores its own name beside the figures costing reads", async () => {
    const { account } = await customer();
    const cases = [
      ["FULL_ADVANCE", { advancePercent: 100, creditDays: 0 }],
      ["PART_ON_DISPATCH", { advancePercent: 40, creditDays: 0 }],
      ["PART_ON_DELIVERY", { advancePercent: 0, creditDays: 0 }],
      ["CREDIT_INVOICE", { advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE" }],
      ["CREDIT_BILL_OF_LADING", { advancePercent: 0, creditDays: 60, creditDaysFrom: "BILL_OF_LADING" }],
      ["CUSTOM", { advancePercent: 20, creditDays: 30, creditDaysFrom: "INVOICE", note: "20% with the order" }],
    ];
    for (const [shape, figures] of cases) {
      const enquiryId = await enquiryFor(account);
      const res = await save(enquiryId, { ...figures, shape, confirm: true });
      expect(res.status).toBe(200);
      const stored = (await storedEnquiry(enquiryId)).paymentTerms;
      expect(stored.shape).toBe(shape);
      /* The figures are unchanged in name and meaning — they are what a
         financing cost is worked out from. */
      expect(stored.advancePercent).toBe(figures.advancePercent);
      expect(stored.creditDays).toBe(figures.creditDays);
      const projection = paymentTermsResolution.projectionFor({ paymentTerms: stored });
      expect(projection.state).toBe("CONFIRMED");
      expect(projection.advancePercent).toBe(figures.advancePercent);
      expect(projection.creditDays).toBe(figures.creditDays);
      expect(projection.shape).toBe(shape);
    }
  });

  test("balance before dispatch and balance on dispatch stay different agreements", async () => {
    /* Identical as figures — zero days from dispatch — and not the same thing
       to a customer. The shape is the only thing that can tell them apart. */
    const { account } = await customer();
    const before = await enquiryFor(account);
    const on = await enquiryFor(account);
    await save(before, { advancePercent: 50, creditDays: 0, shape: "PART_BEFORE_DISPATCH", confirm: true });
    await save(on, { advancePercent: 50, creditDays: 0, shape: "PART_ON_DISPATCH", confirm: true });

    const a = (await storedEnquiry(before)).paymentTerms;
    const b = (await storedEnquiry(on)).paymentTerms;
    expect(a.advancePercent).toBe(b.advancePercent);
    expect(a.shape).toBe("PART_BEFORE_DISPATCH");
    expect(b.shape).toBe("PART_ON_DISPATCH");
  });

  test("an older record keeps its confirmation and reads as the agreement it is", async () => {
    /* Saved before shapes existed: confirmed, with no shape stored. */
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    await Enquiry.collection.updateOne({ _id: enquiryId }, {
      $set: {
        paymentTerms: {
          advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE",
          source: "ENQUIRY", confirmedAt: new Date("2026-03-01"), confirmedBy: { name: "R. Menon" },
        },
      },
    });
    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.shape).toBeUndefined();

    const projection = paymentTermsResolution.projectionFor({ paymentTerms: stored });
    /* Still confirmed, still feeding costing the same figures… */
    expect(projection.state).toBe("CONFIRMED");
    expect(projection.advancePercent).toBe(30);
    expect(projection.creditDays).toBe(45);
    /* …and it reads as a named agreement rather than as nothing. A part
       advance that also runs a credit period has no short name, so it is
       Custom rather than a shape that flatters it. */
    expect(projection.shape).toBe("CUSTOM");
  });

  test("a shape is never invented from a neighbouring field", async () => {
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    /* Nothing agreed: nothing named. */
    await save(enquiryId, { note: "Customer is still deciding." });
    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.shape ?? null).toBeNull();
    expect(paymentTermsResolution.stateOf(stored)).toBe("DRAFT");

    /* ── AND A CODE THIS SYSTEM DOES NOT SPEAK IS REFUSED BY NAME ─────
       Not repaired into the nearest agreement the figures suggest: whoever
       sent "pay when you can" meant something, and quietly storing "custom"
       instead would record an agreement nobody made and report success while
       doing it. The person, or the caller, is told which field is wrong. */
    const bad = await save(enquiryId, { advancePercent: 50, creditDays: 0, shape: "PAY_WHEN_YOU_CAN" });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("shape");
    expect(bad.body.message).toMatch(/not a payment term this system recognises/i);
    /* Nothing was written: the figures it arrived with are not there either. */
    const after = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(after.shape ?? null).toBeNull();
    expect(after.advancePercent ?? null).toBeNull();

    /* A MISSING shape is a different thing entirely — every record written
       before the shapes existed has none — and is derived, never refused. */
    const legacy = await save(enquiryId, { advancePercent: 0, creditDays: 45, creditDaysFrom: "DISPATCH" });
    expect(legacy.status).toBe(200);
    expect((await storedEnquiry(enquiryId)).paymentTerms.shape).toBe("CREDIT_DISPATCH");
  });

  test("the exception is still available, still needs a reason, and still removes financing", async () => {
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    const refused = await save(enquiryId, { notApplicable: true });
    expect(refused.status).toBe(400);
    expect(refused.body.field).toBe("notApplicableReason");

    const ok = await save(enquiryId, {
      notApplicable: true, notApplicableReason: "Intercompany transfer, billed at cost.", confirm: true,
    });
    expect(ok.status).toBe(200);
    const projection = paymentTermsResolution.projectionFor({
      paymentTerms: (await storedEnquiry(enquiryId)).paymentTerms,
    });
    expect(projection.state).toBe("NOT_APPLICABLE");
    expect(projection.notApplicable).toBe(true);
    expect(projection.advancePercent).toBeNull();
  });
});

/* ══ 3 · THE LANE, AND WHAT STOPS APPLYING ═════════════════════════════════ */

/* ══ 2d · THE SAME AGREEMENT, RECORDED ON THE CUSTOMER ═════════════════════ */

describe("the customer's usual agreement, in the same words", () => {
  const setDefaults = (account, body) => onAccount(`/${account._id}`, { method: "PATCH", body });
  const saveTerms = (enquiryId, paymentTerms) => onEnquiry(`/${enquiryId}`, { method: "PATCH", body: { paymentTerms } });

  test("every agreement the enquiry offers can be recorded as the customer's usual one", async () => {
    /* One vocabulary, not two. A default in a vocabulary the enquiry cannot
       speak is a default nobody can apply. */
    const cases = [
      ["FULL_ADVANCE", { advancePercent: 100 }],
      ["PART_BEFORE_DISPATCH", { advancePercent: 40 }],
      ["PART_ON_DISPATCH", { advancePercent: 40 }],
      ["PART_ON_DELIVERY", { advancePercent: 25 }],
      ["CREDIT_INVOICE", { creditDays: 45, creditDaysFrom: "INVOICE" }],
      ["CREDIT_DISPATCH", { creditDays: 30, creditDaysFrom: "DISPATCH" }],
      ["CREDIT_BILL_OF_LADING", { creditDays: 60, creditDaysFrom: "BILL_OF_LADING" }],
      ["CUSTOM", { advancePercent: 20, creditDays: 30, creditDaysFrom: "INVOICE", negotiatedTerms: "20% with the order, 5% retention" }],
    ];
    for (const [shape, figures] of cases) {
      const { account } = await customer();
      const res = await setDefaults(account, { paymentTermsShape: shape, ...figures });
      expect(res.status).toBe(200);
      const stored = await storedAccount(account._id);
      expect(stored.paymentTermsShape).toBe(shape);
      /* The figures are untouched in name and meaning — they are what an
         enquiry inherits and what a financing cost is worked out from. */
      if (figures.advancePercent !== undefined) expect(stored.advancePercent).toBe(figures.advancePercent);
      if (figures.creditDays !== undefined) expect(stored.creditDays).toBe(figures.creditDays);
      /* And it comes back out as the same agreement it went in as. */
      expect((await onAccount(`/${account._id}`)).body.account.paymentTermsShape).toBe(shape);
      expect(paymentTermsResolution.suggestionFor(stored).shape).toBe(shape);
    }
  });

  test("before dispatch and on dispatch stay different standing terms", async () => {
    /* 40% and nothing outstanding either way. The figures cannot tell these
       apart; the customer certainly can. */
    const a = (await customer()).account;
    const b = (await customer()).account;
    await setDefaults(a, { paymentTermsShape: "PART_BEFORE_DISPATCH", advancePercent: 40 });
    await setDefaults(b, { paymentTermsShape: "PART_ON_DISPATCH", advancePercent: 40 });
    const [sa, sb] = [await storedAccount(a._id), await storedAccount(b._id)];
    expect(sa.advancePercent).toBe(sb.advancePercent);
    expect(sa.paymentTermsShape).toBe("PART_BEFORE_DISPATCH");
    expect(sb.paymentTermsShape).toBe("PART_ON_DISPATCH");
  });

  test("an unknown agreement is refused by name here too, and nothing is stored", async () => {
    const { account } = await customer();
    await setDefaults(account, { paymentTermsShape: "CREDIT_INVOICE", creditDays: 45, creditDaysFrom: "INVOICE" });

    const bad = await setDefaults(account, { paymentTermsShape: "PAY_WHEN_YOU_CAN", creditDays: 60 });
    expect(bad.status).toBe(400);
    expect(bad.body.field).toBe("paymentTermsShape");
    expect(bad.body.message).toMatch(/not a payment term this system recognises/i);
    /* Refused whole: the 60 days it arrived with are not there either, and the
       agreement that WAS recorded still stands. */
    const after = await storedAccount(account._id);
    expect(after.paymentTermsShape).toBe("CREDIT_INVOICE");
    expect(after.creditDays).toBe(45);
  });

  test("clearing the standing agreement is a real act, not a zero", async () => {
    const { account } = await customer();
    await setDefaults(account, { paymentTermsShape: "PART_ON_DISPATCH", advancePercent: 40 });
    const cleared = await setDefaults(account, { paymentTermsShape: "", advancePercent: "" });
    expect(cleared.status).toBe(200);
    const after = await storedAccount(account._id);
    expect(after.paymentTermsShape ?? null).toBeNull();
    expect(after.advancePercent ?? null).toBeNull();
    /* "We have no standing terms any more" — so nothing is offered. */
    expect(paymentTermsResolution.suggestionFor(after).available).toBe(false);
  });

  test("an account recorded before shapes existed derives a compatible one, with no migration", async () => {
    /* Inserted straight, exactly as it sits in the database today: figures and
       no agreement name anywhere. */
    const legacy = await Account.collection.insertOne({
      companyId: CO._id, companyName: "Legacy Buyer", status: "active", isActive: true,
      advancePercent: 0, creditDays: 45, creditDaysFrom: "DISPATCH",
    });
    const stored = await storedAccount(legacy.insertedId);
    expect(stored.paymentTermsShape).toBeUndefined();

    /* Nothing is written to it, and it still reads as an agreement a person
       recognises — derived from its own figures, never invented. */
    const suggestion = paymentTermsResolution.suggestionFor(stored);
    expect(suggestion.shape).toBe("CREDIT_DISPATCH");
    expect(await storedAccount(legacy.insertedId)).toEqual(stored);

    /* A part advance that ALSO runs a credit period has no short name and is
       not given one that flatters it. */
    expect(paymentTermsResolution.suggestionFor({ advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" }).shape)
      .toBe("CUSTOM");
  });

  test("an enquiry inherits the agreement as its own snapshot, and a later account change cannot rewrite it", async () => {
    const { account } = await customer();
    await setDefaults(account, { paymentTermsShape: "PART_BEFORE_DISPATCH", advancePercent: 40, creditDays: 0 });
    const enquiryId = await enquiryFor(account);

    /* What the screen is offered. */
    const offered = (await onEnquiry(`/${enquiryId}/commercial-defaults`)).body.payment;
    expect(offered).toMatchObject({ available: true, shape: "PART_BEFORE_DISPATCH", advancePercent: 40 });

    /* Applied and confirmed as it was offered. */
    const saved = await saveTerms(enquiryId, {
      shape: offered.shape, advancePercent: offered.advancePercent, creditDays: offered.creditDays, confirm: true,
    });
    expect(saved.status).toBe(200);
    let stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.shape).toBe("PART_BEFORE_DISPATCH");
    expect(stored.source).toBe("ACCOUNT");
    /* What the customer's terms said AT THE TIME, kept beside the deal. */
    expect(stored.accountDefaultAtConfirmation.shape).toBe("PART_BEFORE_DISPATCH");

    /* The customer renegotiates, months later — a different agreement entirely. */
    const changed = await setDefaults(account, {
      paymentTermsShape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 60, creditDaysFrom: "INVOICE",
    });
    expect(changed.status).toBe(200);

    /* The deal already agreed says exactly what it said. */
    stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.shape).toBe("PART_BEFORE_DISPATCH");
    expect(stored.advancePercent).toBe(40);
    expect(stored.accountDefaultAtConfirmation.shape).toBe("PART_BEFORE_DISPATCH");
    /* Including to costing, which reads the enquiry's snapshot and nothing else. */
    const projection = paymentTermsResolution.projectionFor({ paymentTerms: stored });
    expect(projection.state).toBe("CONFIRMED");
    expect(projection.shape).toBe("PART_BEFORE_DISPATCH");
    expect(projection.advancePercent).toBe(40);
  });

  test("overriding the inherited agreement for one deal leaves the customer's own untouched", async () => {
    const { account } = await customer();
    await setDefaults(account, { paymentTermsShape: "CREDIT_INVOICE", advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE" });
    const before = JSON.stringify(await storedAccount(account._id));
    const enquiryId = await enquiryFor(account);

    /* This buyer pays up front, this once. */
    const saved = await saveTerms(enquiryId, { shape: "FULL_ADVANCE", advancePercent: 100, creditDays: 0, confirm: true });
    expect(saved.status).toBe(200);
    const stored = (await storedEnquiry(enquiryId)).paymentTerms;
    expect(stored.shape).toBe("FULL_ADVANCE");
    /* Legible as a DIFFERENCE from what the customer usually agrees. */
    expect(stored.source).toBe("ENQUIRY");
    expect(stored.accountDefaultAtConfirmation.shape).toBe("CREDIT_INVOICE");
    expect(stored.accountDefaultAtConfirmation.creditDays).toBe(45);
    /* And the customer's standing terms are exactly as they were. */
    expect(JSON.stringify(await storedAccount(account._id))).toBe(before);
  });

  test("a custom agreement has to say what is custom about it", async () => {
    const { account } = await customer();

    /* On the account: neither wording nor figures that mean anything. */
    const empty = await setDefaults(account, { paymentTermsShape: "CUSTOM" });
    expect(empty.status).toBe(400);
    expect(empty.body.field).toBe("negotiatedTerms");

    /* Either way of saying it is enough. */
    expect((await setDefaults(account, {
      paymentTermsShape: "CUSTOM", negotiatedTerms: "50% LC at sight, balance against retention release",
    })).status).toBe(200);
    expect((await setDefaults(account, {
      paymentTermsShape: "CUSTOM", negotiatedTerms: "", advancePercent: 20, creditDays: 30, creditDaysFrom: "INVOICE",
    })).status).toBe(200);

    /* On the enquiry, the same rule, in the same words: figures that describe
       a NAMED agreement are asked what is custom about them. */
    const enquiryId = await enquiryFor(account);
    const named = await saveTerms(enquiryId, {
      shape: "CUSTOM", advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE", confirm: true,
    });
    expect(named.status).toBe(400);
    expect(named.body.field).toBe("note");
    expect(named.body.message).toMatch(/what makes this agreement custom/i);
    /* A bare 0% / 0 days is the same objection. */
    expect((await saveTerms(enquiryId, { shape: "CUSTOM", advancePercent: 0, creditDays: 0, confirm: true })).body.field)
      .toBe("note");
    /* Nothing was confirmed by either attempt. */
    expect((await storedEnquiry(enquiryId)).paymentTerms?.confirmedAt ?? null).toBeNull();

    /* With the wording, it confirms. */
    const worded = await saveTerms(enquiryId, {
      shape: "CUSTOM", advancePercent: 0, creditDays: 45, creditDaysFrom: "INVOICE",
      note: "45 days after invoice, less 5% retention released after the first wash test.", confirm: true,
    });
    expect(worded.status).toBe(200);
    expect((await storedEnquiry(enquiryId)).paymentTerms.confirmedAt).toBeTruthy();
  });

  test("a confirmed custom record from before the wording rule stays confirmed and readable", async () => {
    const { account } = await customer();
    const _id = oid();
    seq += 1;
    /* A part advance that also runs a credit period: no named term describes
       it, which is exactly why it derives as Custom — and why it is never
       asked for a sentence. */
    await Enquiry.collection.insertOne({
      _id, enquiryId: `ENQ-OLD-${seq}`, journeyId: oid(), isActive: true,
      companyId: account.companyId, accountId: account._id, title: "Uniform programme",
      paymentTerms: {
        advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE",
        source: "ENQUIRY", confirmedAt: new Date("2026-03-01"), confirmedBy: { name: "R. Menon" },
      },
    });
    const stored = (await storedEnquiry(_id)).paymentTerms;
    expect(paymentTermsResolution.stateOf(stored)).toBe("CONFIRMED");
    expect(paymentTermsResolution.gaps(stored)).toEqual([]);
    const projection = paymentTermsResolution.projectionFor({ paymentTerms: stored });
    expect(projection.state).toBe("CONFIRMED");
    expect(projection.shape).toBe("CUSTOM");
    expect(projection.creditDays).toBe(45);
    /* Re-confirming it, untouched, is still allowed — no sentence demanded. */
    const again = await saveTerms(_id, {
      advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE", shape: "CUSTOM", confirm: true,
    });
    expect(again.status).toBe(200);
  });
});


describe("delivery terms answer only what their arrangement asks", () => {
  test("switching to ex-works clears the lane fields it no longer has", async () => {
    const { account, shipping } = await customer();
    const warehouse = await Warehouse.create({
      companyId: CO._id, name: "Ludhiana Unit", shortName: "LDH", status: "Active",
    });
    const enquiryId = await enquiryFor(account);

    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: {
        freight: {
          arrangement: "delivered", mode: "ROAD", shippingAddressId: String(shipping._id),
          originWarehouseId: String(warehouse._id), deliveryCount: 3,
        },
      },
    });
    expect((await storedEnquiry(enquiryId)).freight.mode).toBe("ROAD");

    /* The customer decides to collect. Nothing about our lane applies any
       more, and stale facts would be read as current ones. */
    const res = await onEnquiry(`/${enquiryId}`, { method: "PATCH", body: { freight: { arrangement: "ex_works" } } });
    expect(res.status).toBe(200);
    const after = (await storedEnquiry(enquiryId)).freight;
    expect(after.arrangement).toBe("ex_works");
    for (const k of ["mode", "shippingAddressId", "originWarehouseId", "deliveryCount", "prepaidTreatment"]) {
      expect(after[k] ?? null).toBeNull();
    }
  });

  test("lane fields sent with a to-pay arrangement are dropped, not stored", async () => {
    /* The screen clears them, but the screen is not the boundary: a payload
       that names a destination beside "the customer pays the carrier" is two
       statements that contradict each other, and the second one would be read
       later as current. */
    const { account, shipping } = await customer();
    const warehouse = await Warehouse.create({
      companyId: CO._id, name: "Ludhiana Unit", shortName: "LDH", status: "Active",
    });
    const enquiryId = await enquiryFor(account);

    const res = await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: {
        freight: {
          arrangement: "to_pay", mode: "AIR", shippingAddressId: String(shipping._id),
          originWarehouseId: String(warehouse._id), deliveryCount: 2, prepaidTreatment: "IN_PRICE",
        },
      },
    });
    expect(res.status).toBe(200);
    const stored = (await storedEnquiry(enquiryId)).freight;
    expect(stored.arrangement).toBe("to_pay");
    for (const k of ["mode", "shippingAddressId", "originWarehouseId", "deliveryCount", "prepaidTreatment"]) {
      expect(stored[k] ?? null).toBeNull();
    }
  });

  test("a prepaid order must say how the freight is treated", async () => {
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    const res = await onEnquiry(`/${enquiryId}`, { method: "PATCH", body: { freight: { arrangement: "prepaid" } } });
    /* Saving an incomplete agreement is allowed — the costing names the gap —
       but the treatment is never invented. */
    expect(res.status).toBe(200);
    const stored = (await storedEnquiry(enquiryId)).freight;
    expect(stored.prepaidTreatment ?? null).toBeNull();
    expect(deliveryTermsResolution.gaps(stored).map((g) => g.field)).toContain("prepaidTreatment");
  });

  test("another company's warehouse and another account's address are refused", async () => {
    const mine = await customer();
    const theirs = await customer({}, { companyId: CO_B._id });
    const foreignWarehouse = await Warehouse.create({
      companyId: CO_B._id, name: "Their Unit", shortName: "THR", status: "Active",
    });
    const enquiryId = await enquiryFor(mine.account);

    const badAddress = await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { freight: { arrangement: "delivered", mode: "ROAD", shippingAddressId: String(theirs.shipping._id) } },
    });
    expect(badAddress.status).toBe(400);

    const badWarehouse = await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: {
        freight: {
          arrangement: "delivered", mode: "ROAD", shippingAddressId: String(mine.shipping._id),
          originWarehouseId: String(foreignWarehouse._id),
        },
      },
    });
    expect(badWarehouse.status).toBe(400);
    expect(badWarehouse.body.message).toMatch(/not an active warehouse in this company/i);

    expect((await storedEnquiry(enquiryId)).freight ?? null).toBeNull();
  });
});

/* ══ 4 · WHAT COSTING MAY READ ════════════════════════════════════════════ */

describe("costing reads the enquiry's own snapshot", () => {
  test("payment terms saved but never confirmed publish no duration", async () => {
    const { account } = await customer();
    const enquiryId = await enquiryFor(account);
    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH", body: { paymentTerms: { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE" } },
    });

    const stored = await storedEnquiry(enquiryId);
    const projection = paymentTermsResolution.projectionFor(stored);
    expect(projection.state).toBe("DRAFT");
    /* Never a zero-cost financing: unanswered is not a cash sale. */
    expect(projection.advancePercent).toBeNull();
    expect(projection.creditDays).toBeNull();
  });

  test("confirmed payment terms and saved delivery terms are both readable facts", async () => {
    const { account, shipping } = await customer();
    const enquiryId = await enquiryFor(account);
    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { paymentTerms: { advancePercent: 30, creditDays: 45, creditDaysFrom: "INVOICE", confirm: true } },
    });
    await onEnquiry(`/${enquiryId}`, {
      method: "PATCH",
      body: { freight: { arrangement: "delivered", mode: "ROAD", shippingAddressId: String(shipping._id) } },
    });

    const stored = await storedEnquiry(enquiryId);
    const payment = paymentTermsResolution.projectionFor(stored);
    expect(payment.state).toBe("CONFIRMED");
    expect(payment.creditDays).toBe(45);
    expect(payment.creditDaysFromLabel).toBe("Invoice date");

    const delivery = deliveryTermsResolution.projectionFor(stored);
    expect(delivery.state).toBe("SAVED");
    expect(delivery.arrangement).toBe("delivered");
    expect(delivery.gaps).toEqual([]);
  });

  test("an enquiry recorded before any of this still reads exactly as it did", async () => {
    /* No source, no snapshot, no savedAt — the shape every existing enquiry
       has today. */
    const { account } = await customer();
    const enquiryId = await enquiryFor(account, { arrangement: "to_pay", notes: "Buyer's own transporter" });
    const stored = await storedEnquiry(enquiryId);

    const delivery = deliveryTermsResolution.projectionFor(stored);
    expect(delivery.arrangement).toBe("to_pay");
    expect(delivery.state).toBe("SAVED");
    expect(delivery.source).toBeNull();
    expect(delivery.overridden).toBe(false);
    expect(paymentTermsResolution.projectionFor(stored).state).toBe("NOT_STARTED");
  });
});
