// test/crm/account-linked-customer.route.test.js
//
// "WHICH ACCOUNT IS THIS CUSTOMER?" — THE BRIDGE, AND ITS FAILURE MODES.
//
// The sales customer profile edits payment terms that live on the CRM Account,
// and finds that Account by `linkedCustomer`. A lookup that answers the wrong
// row here is not a display bug: it puts one customer's standing terms on
// another customer's account, and an enquiry then inherits them.
//
// So the route is held to three things:
//
//   · A malformed reference is REFUSED, never ignored. Dropping an unparseable
//     filter would answer with every account the caller can see, and a caller
//     asking "which account is this customer" reads row one as the answer.
//   · A foreign reference finds nothing. It never leaks the existence of a
//     record in another company.
//   · Ambiguity is visible. Two accounts linked to one customer come back as
//     two, so the screen can refuse to choose rather than silently picking.
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
jest.mock("../../services/changeLog", () => ({
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../../models/CMS_Models/Sales/Account");

const SALES = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Anita Rao",
  email: "anita@grav.test",
  role: "sales",
};

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/accounts", require("../../routes/CMS_Routes/Sales/accounts"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/accounts`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

let CO;
let seq = 0;
beforeEach(async () => {
  await Account.deleteMany({});
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
});

const call = (path, { method = "GET", body, user = SALES } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

const lookup = (customerId, extra = "") =>
  call(`?linkedCustomer=${encodeURIComponent(customerId)}&limit=2${extra}`);

const makeAccount = (patch = {}) => Account.create({
  companyId: CO._id, companyName: `Buyer ${++seq}`, status: "active", ...patch,
});

/* ══ THE HAPPY PATH ═══════════════════════════════════════════════════════ */

test("a customer with one linked account resolves to exactly that account", async () => {
  const customerId = new mongoose.Types.ObjectId();
  const mine = await makeAccount({ linkedCustomer: customerId, creditDays: 30 });
  await makeAccount(); // another account, linked to nobody

  const res = await lookup(customerId);
  expect(res.status).toBe(200);
  expect(res.body.accounts).toHaveLength(1);
  expect(String(res.body.accounts[0]._id)).toBe(String(mine._id));
  expect(res.body.accounts[0].creditDays).toBe(30);
});

/* ══ AMBIGUITY IS VISIBLE, NEVER RESOLVED BY LUCK ═════════════════════════ */

test("two accounts linked to one customer both come back", async () => {
  const customerId = new mongoose.Types.ObjectId();
  await makeAccount({ linkedCustomer: customerId, creditDays: 30 });
  await makeAccount({ linkedCustomer: customerId, creditDays: 90 });

  const res = await lookup(customerId);
  expect(res.body.accounts).toHaveLength(2);
  // The two carry DIFFERENT terms, which is exactly why picking one silently
  // would be wrong rather than merely arbitrary.
  const days = res.body.accounts.map((a) => a.creditDays).sort((x, y) => x - y);
  expect(days).toEqual([30, 90]);
  expect(res.body.pagination.total).toBe(2);
});

/* ══ NOTHING LINKED, AND NOTHING INVENTED ═════════════════════════════════ */

test("a customer with no linked account resolves to nothing at all", async () => {
  await makeAccount();
  await makeAccount();
  const res = await lookup(new mongoose.Types.ObjectId());
  expect(res.status).toBe(200);
  // Not "the first account on the list".
  expect(res.body.accounts).toHaveLength(0);
  expect(res.body.pagination.total).toBe(0);
});

test("an archived linked account is hidden by default and findable on request", async () => {
  const customerId = new mongoose.Types.ObjectId();
  await makeAccount({ linkedCustomer: customerId, isActive: false, creditDays: 45 });

  const live = await lookup(customerId);
  expect(live.body.accounts).toHaveLength(0);

  // So the screen can tell "never linked" from "linked to something retired",
  // and stop somebody recording the same terms twice.
  const all = await lookup(customerId, "&includeArchived=true");
  expect(all.body.accounts).toHaveLength(1);
  expect(all.body.accounts[0].creditDays).toBe(45);
});

/* ══ A BAD REFERENCE IS REFUSED, NOT IGNORED ══════════════════════════════ */

test("a malformed customer reference is refused rather than dropped", async () => {
  await makeAccount();
  await makeAccount();

  for (const bad of ["not-an-id", "12345", "null", "undefined", "%20"]) {
    const res = await lookup(bad);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("LINKED_CUSTOMER_INVALID");
    // The decisive part: it did NOT fall through to an unfiltered list.
    expect(res.body.accounts).toBeUndefined();
  }
});

test("an injection-shaped value is refused, not interpreted", async () => {
  const res = await call(`?linkedCustomer=${encodeURIComponent('{"$ne":null}')}&limit=2`);
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("LINKED_CUSTOMER_INVALID");
});

test("an empty value is not a lookup and does not become an unfiltered answer", async () => {
  // A caller that forgot the id gets the ordinary list, which is honest — but
  // the screen asks with an id, and an id it cannot parse is refused above.
  await makeAccount({ linkedCustomer: new mongoose.Types.ObjectId() });
  const res = await call("?linkedCustomer=&limit=2");
  expect(res.status).toBe(200);
});

/* ══ COMPANY ISOLATION ════════════════════════════════════════════════════ */

test("an account in another company is not found, even by its real customer id", async () => {
  /* A second company means the single-company fallback no longer applies, so
     the caller needs a stated membership — which is the point: the lookup is
     answered inside ONE company's boundary, never across both. */
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  await SpCompanyMembership.create({
    companyId: CO._id, email: SALES.email, employeeRef: new mongoose.Types.ObjectId(SALES.id), personName: SALES.name,
  });

  const customerId = new mongoose.Types.ObjectId();
  const mine = await makeAccount({ linkedCustomer: customerId, creditDays: 30 });
  await Account.create({
    companyId: other._id, companyName: "Foreign buyer", status: "active",
    linkedCustomer: customerId, creditDays: 120,
  });

  const res = await lookup(customerId);
  expect(res.status).toBe(200);
  // The caller's own company answers; the other company's account carrying the
  // SAME customer id is invisible — not merely sorted second.
  expect(res.body.accounts).toHaveLength(1);
  expect(String(res.body.accounts[0]._id)).toBe(String(mine._id));
  expect(res.body.accounts[0].creditDays).toBe(30);
  expect(res.body.accounts.some((a) => a.creditDays === 120)).toBe(false);
});

test("a caller whose company cannot be established is refused, not given a guess", async () => {
  /* Two companies and no membership: the scope resolver fails closed rather
     than picking one, so no account from either company is returned. */
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  const customerId = new mongoose.Types.ObjectId();
  await makeAccount({ linkedCustomer: customerId });

  const res = await lookup(customerId);
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(res.body.accounts).toBeUndefined();
});

test("an unauthenticated lookup is refused", async () => {
  const customerId = new mongoose.Types.ObjectId();
  await makeAccount({ linkedCustomer: customerId });
  const res = await call(`?linkedCustomer=${customerId}`, { user: null });
  expect(res.status).toBe(401);
  expect(res.body.accounts).toBeUndefined();
});

/* ══ SAVING THE TERMS ═════════════════════════════════════════════════════ */

test("payment terms save onto the resolved account and read back", async () => {
  const customerId = new mongoose.Types.ObjectId();
  const account = await makeAccount({ linkedCustomer: customerId });

  const res = await call(`/${account._id}`, {
    method: "PATCH",
    body: {
      paymentTermsShape: "CREDIT_INVOICE", advancePercent: "0", creditDays: "30",
      creditDaysFrom: "INVOICE", negotiatedTerms: "30 days from invoice",
    },
  });
  expect(res.status).toBe(200);

  const again = await lookup(customerId);
  const saved = again.body.accounts[0];
  expect(saved.paymentTermsShape).toBe("CREDIT_INVOICE");
  expect(saved.creditDays).toBe(30);
  expect(saved.creditDaysFrom).toBe("INVOICE");
  expect(saved.negotiatedTerms).toBe("30 days from invoice");
});

test("an invalid agreement is refused by field, and nothing is written", async () => {
  const customerId = new mongoose.Types.ObjectId();
  const account = await makeAccount({ linkedCustomer: customerId });

  // A duration with no starting event: the same rule the enquiry applies.
  const res = await call(`/${account._id}`, {
    method: "PATCH",
    body: { paymentTermsShape: "CUSTOM", advancePercent: "40", creditDays: "30", creditDaysFrom: "" },
  });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("COMMERCIAL_DEFAULTS_INVALID");
  expect(res.body.field).toBeTruthy();

  const after = await Account.findById(account._id).lean();
  expect(after.creditDays).toBeUndefined();
  expect(after.paymentTermsShape).toBeUndefined();
});

test("saving the same terms twice leaves one account in one state", async () => {
  const customerId = new mongoose.Types.ObjectId();
  const account = await makeAccount({ linkedCustomer: customerId });
  const body = {
    method: "PATCH",
    body: { paymentTermsShape: "FULL_ADVANCE", advancePercent: "100", creditDays: "0", creditDaysFrom: "" },
  };

  // What a double click sends.
  const [a, b] = await Promise.all([call(`/${account._id}`, body), call(`/${account._id}`, body)]);
  expect([a.status, b.status]).toEqual([200, 200]);

  const found = await lookup(customerId);
  expect(found.body.accounts).toHaveLength(1);
  expect(found.body.accounts[0].advancePercent).toBe(100);
  expect(found.body.accounts[0].paymentTermsShape).toBe("FULL_ADVANCE");
});

test("clearing the terms unsets them rather than storing a zero nobody agreed", async () => {
  const customerId = new mongoose.Types.ObjectId();
  const account = await makeAccount({
    linkedCustomer: customerId, paymentTermsShape: "CREDIT_INVOICE", creditDays: 30, creditDaysFrom: "INVOICE",
  });

  await call(`/${account._id}`, {
    method: "PATCH",
    body: { paymentTermsShape: "", advancePercent: "", creditDays: "", creditDaysFrom: "", negotiatedTerms: "" },
  });

  const after = await Account.findById(account._id).lean();
  expect(after.creditDays).toBeUndefined();
  expect(after.creditDays).not.toBe(0);
  expect(after.paymentTermsShape).toBeUndefined();
});
