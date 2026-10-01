// test/crm/customer-account-link.route.test.js
//
// ONE CUSTOMER, AS FAR AS A SALESPERSON IS CONCERNED.
//
// ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
// `POST /api/cms/sales/customers` created the portal customer and nothing
// else. Their commercial terms live on a sales account, so every customer
// Sales ever created that way had nowhere to put them — and the terms screen
// said "this customer is not linked to a sales account yet" and sent the
// person to a different page to fix a relationship they had never heard of.
//
// The split between the two records is a fact about this database. It is not
// a fact about anybody's job.
//
// What is pinned here: the creation path cannot produce that state again; an
// existing customer can be repaired in place by IDS — never by a name; the
// setup act is idempotent under a double click; and everything a person has
// to decide is refused rather than guessed.
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
jest.mock("../../utils/salesEmailService", () => ({ sendCustomerEmail: async () => ({}) }));
jest.mock("../../services/changeLog", () => ({
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../../models/CMS_Models/Sales/Account");
const Customer = require("../../models/Customer_Models/Customer");
const CustomerAccountClaim = require("../../models/CMS_Models/Sales/CustomerAccountClaim");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const link = require("../../services/sales/customerAccountLink.service");

const oid = () => new mongoose.Types.ObjectId();
const USER = { id: oid().toString(), name: "Anita Rao", role: "sales" };
const OTHER = { id: oid().toString(), name: "Someone Else", role: "sales" };

let server;
let accountsBase;
let customersBase;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/accounts", require("../../routes/CMS_Routes/Sales/accounts"));
  app.use("/api/cms/sales/customers", require("../../routes/CMS_Routes/Sales/salesCustomers"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const port = server.address().port;
  accountsBase = `http://127.0.0.1:${port}/api/cms/crm/accounts`;
  customersBase = `http://127.0.0.1:${port}/api/cms/sales/customers`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

async function call(root, path, { method = "GET", body, user = USER } = {}) {
  const res = await fetch(`${root}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(user) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  try {
    return { status: res.status, body: JSON.parse(raw) };
  } catch {
    throw new Error(`${method} ${path} -> ${res.status}: ${raw.slice(0, 200)}`);
  }
}
const onAccount = (path, opt) => call(accountsBase, path, opt);
const onCustomer = (path, opt) => call(customersBase, path, opt);

let CO;
let CO_B;
let seq = 0;

beforeEach(async () => {
  await Promise.all([
    Account.collection.deleteMany({}), Customer.collection.deleteMany({}),
    CustomerAccountClaim.collection.deleteMany({}), SpCompanyMembership.deleteMany({}),
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Link Co", booksFromDate: new Date("2026-04-01") });
  CO_B = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  await SpCompanyMembership.create({ companyId: CO._id, employeeRef: USER.id, personName: USER.name });
  await SpCompanyMembership.create({ companyId: CO_B._id, employeeRef: OTHER.id, personName: OTHER.name });
});

/** A portal customer, as the sales customer list holds them. */
async function portalCustomer(over = {}) {
  seq += 1;
  return Customer.create({
    name: `Metro Uniforms ${seq}`,
    email: `buyer${seq}@example.com`,
    phone: `90000000${String(seq).padStart(2, "0")}`,
    password: "not-a-real-password",
    isActive: true,
    createdBySales: true,
    ...over,
  });
}

const accountsFor = (customerId) => Account.collection
  .find({ linkedCustomer: new mongoose.Types.ObjectId(String(customerId)) }).toArray();

/* ══ 1 · THE ROOT CAUSE, CLOSED ════════════════════════════════════════════ */

describe("a customer Sales creates is set up completely", () => {
  test("2 · creating a customer establishes their commercial record with them", async () => {
    const created = await onCustomer("/", {
      method: "POST",
      body: { name: "Harbour Hotels", email: "buying@harbour.co", phone: "9876500011" },
    });
    expect(created.status).toBe(201);
    const customerId = created.body.customer._id;

    /* The bug was that this was empty. */
    const accounts = await accountsFor(customerId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].companyName).toBe("Harbour Hotels");
    /* Owned by the company the salesperson works in — never from the body. */
    expect(String(accounts[0].companyId)).toBe(String(CO._id));
    /* And the caller is told, so nothing has to go looking. */
    expect(created.body.account._id).toBe(String(accounts[0]._id));

    /* So the terms screen opens on the editor rather than on an explanation. */
    const asked = await onAccount(`/for-customer/${customerId}`);
    expect(asked.body.state).toBe("LINKED");
    expect(asked.body.setupRequired).toBe(false);
  });

  test("a customer is never left half-created", async () => {
    /* If the commercial record cannot be established, the customer does not
       survive either: a customer without one is exactly the state this
       fixes, and failing at the form beats failing silently months later. */
    const spy = jest.spyOn(link, "ensure").mockResolvedValueOnce({ ok: false, message: "no" });
    const created = await onCustomer("/", {
      method: "POST",
      body: { name: "Never Saved", email: "never@example.com", phone: "9876500099" },
    });
    expect(created.status).toBe(500);
    expect(created.body.message).toMatch(/nothing was saved/i);
    expect(await Customer.collection.findOne({ email: "never@example.com" })).toBeNull();
    spy.mockRestore();
  });
});

/* ══ 2 · THE ONES ALREADY IN IT ════════════════════════════════════════════ */

describe("a customer created before the fix", () => {
  test("1 · an existing linked customer opens straight onto their terms", async () => {
    const customer = await portalCustomer();
    const account = await Account.create({
      companyId: CO._id, companyName: "Metro Uniforms", status: "active", linkedCustomer: customer._id,
    });
    const asked = await onAccount(`/for-customer/${customer._id}`);
    expect(asked.status).toBe(200);
    expect(asked.body.state).toBe("LINKED");
    expect(asked.body.account._id).toBe(String(account._id));
    expect(asked.body.setupRequired).toBe(false);
  });

  test("3 · an unlinked one is repaired in place, in one act", async () => {
    const customer = await portalCustomer();
    /* Nothing exists yet — the state the old screen explained at the person. */
    const before = await onAccount(`/for-customer/${customer._id}`);
    expect(before.body.state).toBe("ABSENT");
    expect(before.body.setupRequired).toBe(true);
    expect(before.body.account).toBeNull();

    const setUp = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    expect(setUp.status).toBe(201);
    expect(setUp.body.created).toBe(true);
    expect(setUp.body.establishedBy).toBe("CREATED");

    /* 4 · exactly one account, and exactly one link. */
    const accounts = await accountsFor(customer._id);
    expect(accounts).toHaveLength(1);
    expect(String(accounts[0]._id)).toBe(setUp.body.account._id);
    /* One claim, for this company and this customer — the record that makes
       a second click a read rather than a second account. */
    expect(await CustomerAccountClaim.countDocuments({ customerId: customer._id })).toBe(1);
    const claim = await CustomerAccountClaim.collection.findOne({ customerId: customer._id });
    expect(claim._id).toBe(`${CO._id}:${customer._id}`);
    expect(String(claim.accountId)).toBe(setUp.body.account._id);
  });

  test("3b · an order the customer actually placed repairs the relationship by ids", async () => {
    /* The strongest evidence there is, and all of it ids: the customer's own
       order was raised FROM an enquiry, and that enquiry names its account. */
    const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
    const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
    await Promise.all([Enquiry.collection.deleteMany({}), CustomerRequest.collection.deleteMany({})]);

    const customer = await portalCustomer();
    const account = await Account.create({
      companyId: CO._id, companyName: "Proved By Order", status: "active",
    });
    const enquiryId = oid();
    const requestId = oid();
    await Enquiry.collection.insertOne({
      _id: enquiryId, enquiryId: "ENQ-PROOF-1", journeyId: oid(), isActive: true,
      companyId: CO._id, accountId: account._id, title: "Uniform programme",
      customerRequestId: requestId,
    });
    await CustomerRequest.collection.insertOne({
      _id: requestId, requestId: "REQ-PROOF-1", customerId: customer._id,
      status: "pending", salesOrigin: { enquiryId },
    });

    const asked = await onAccount(`/for-customer/${customer._id}`);
    expect(asked.body.state).toBe("REPAIRABLE");
    expect(asked.body.account._id).toBe(String(account._id));
    expect(asked.body.setupRequired).toBe(true);

    /* Repairing links the record that already existed — it does not make a
       second one for a customer who already has a commercial history. */
    const repaired = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    expect(repaired.status).toBe(200);
    expect(repaired.body.created).toBe(false);
    expect(repaired.body.establishedBy).toBe("REPAIRED");
    expect(repaired.body.account._id).toBe(String(account._id));
    expect(await accountsFor(customer._id)).toHaveLength(1);

    await Promise.all([Enquiry.collection.deleteMany({}), CustomerRequest.collection.deleteMany({})]);
  });

  test("5 · a double click sets up one account, not two", async () => {
    const customer = await portalCustomer();
    /* Two requests in flight at once — the thing a "create if missing"
       endpoint gets wrong, and the reason the claim's id is the customer's
       own rather than a lookup-then-insert. */
    const [a, b] = await Promise.all([
      onAccount(`/for-customer/${customer._id}`, { method: "POST" }),
      onAccount(`/for-customer/${customer._id}`, { method: "POST" }),
    ]);
    expect(a.status).toBeLessThan(400);
    expect(b.status).toBeLessThan(400);
    expect(a.body.account._id).toBe(b.body.account._id);
    expect(await accountsFor(customer._id)).toHaveLength(1);
    /* And a third, later, is still the same answer. */
    const again = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    expect(again.body.created).toBe(false);
    expect(again.body.account._id).toBe(a.body.account._id);
    expect(await accountsFor(customer._id)).toHaveLength(1);
  });

  test("6 · reopening the page finds the same record and the same plan", async () => {
    const customer = await portalCustomer();
    const setUp = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    const accountId = setUp.body.account._id;

    /* 10 · the plan saved here is what an enquiry will be offered. */
    const plan = [
      { name: "Advance payment", percentage: 60, dueEvent: "ORDER_CONFIRMATION", offsetDirection: "ON", offsetDays: 0 },
      { name: "Final payment", percentage: 40, dueEvent: "INVOICE", offsetDirection: "AFTER", offsetDays: 30 },
    ];
    expect((await onAccount(`/${accountId}`, { method: "PATCH", body: { paymentPlan: plan } })).status).toBe(200);

    const reopened = await onAccount(`/for-customer/${customer._id}`);
    expect(reopened.body.state).toBe("LINKED");
    expect(reopened.body.account._id).toBe(accountId);
    /* And it opens ON the plan: the editor is handed what is agreed, not an
       empty form beside a saved one. */
    expect(reopened.body.account.paymentPlan).toHaveLength(2);
    expect(reopened.body.account.paymentPlan[1]).toMatchObject({
      name: "Final payment", percentage: 40, dueEvent: "INVOICE", offsetDays: 30,
    });
    /* Restricted figures are not in this projection at all. */
    expect(reopened.body.account.creditLimit).toBeUndefined();
    expect(reopened.body.account.creditStatus).toBeUndefined();
    const stored = await Account.collection.findOne({ _id: new mongoose.Types.ObjectId(accountId) });
    expect(stored.paymentPlan).toHaveLength(2);
    /* And it is offered to an enquiry exactly as the customer's own terms. */
    const suggestion = require("../../services/sales/paymentTermsResolution.service").suggestionFor(stored);
    expect(suggestion.available).toBe(true);
    expect(suggestion.planSummary).toBe("60% due on order confirmation; 40% due 30 days after invoice date.");
  });
});

/* ══ 3 · WHAT IT REFUSES ═══════════════════════════════════════════════════ */

describe("what it will not decide on somebody's behalf", () => {
  test("7 · another company's record is never linked, read or reused here", async () => {
    const customer = await portalCustomer();
    /* The same buyer, already set up in the OTHER company of this group. */
    const theirs = await Account.create({
      companyId: CO_B._id, companyName: "Metro Uniforms (theirs)", status: "active", linkedCustomer: customer._id,
    });

    /* This company sees nothing of it — not the record, not even its name. */
    const asked = await onAccount(`/for-customer/${customer._id}`);
    expect(asked.body.state).toBe("ABSENT");
    expect(JSON.stringify(asked.body)).not.toMatch(/theirs/);

    /* Setting up here makes THIS company's own record. One portal login can
       buy from two companies in a group, and one company's terms are not the
       other's to read — so the claim is per company, and neither borrows the
       other's account. */
    const mine = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    expect(mine.status).toBe(201);
    expect(mine.body.account._id).not.toBe(String(theirs._id));

    const created = await Account.collection.findOne({ _id: new mongoose.Types.ObjectId(mine.body.account._id) });
    expect(String(created.companyId)).toBe(String(CO._id));
    /* And the other company's record is untouched. */
    const untouched = await Account.collection.findOne({ _id: theirs._id });
    expect(String(untouched.companyId)).toBe(String(CO_B._id));
    expect(untouched.companyName).toBe("Metro Uniforms (theirs)");
  });

  test("8 · two records already claiming one customer is refused, clearly", async () => {
    const customer = await portalCustomer();
    await Account.create({ companyId: CO._id, companyName: "Umung Pvt Ltd", status: "active", linkedCustomer: customer._id });
    await Account.create({ companyId: CO._id, companyName: "Soumya Pvt Ltd", status: "active", linkedCustomer: customer._id });

    const asked = await onAccount(`/for-customer/${customer._id}`);
    expect(asked.body.state).toBe("AMBIGUOUS");
    expect(asked.body.setupRequired).toBe(false);
    expect(asked.body.candidates).toHaveLength(2);
    /* Said as what it means for the customer, not as what it means for the
       database. */
    expect(asked.body.reason).toMatch(/more than one commercial record/i);
    expect(asked.body.reason).not.toMatch(/CRM|Account model|linkedCustomer/);

    /* And nothing is created to paper over it. */
    const setUp = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    expect(setUp.status).toBe(409);
    expect(await accountsFor(customer._id)).toHaveLength(2);
  });

  test("an archived record is not a missing one", async () => {
    const customer = await portalCustomer();
    await Account.create({
      companyId: CO._id, companyName: "Retired Buyer", status: "active",
      linkedCustomer: customer._id, isActive: false,
    });
    const asked = await onAccount(`/for-customer/${customer._id}`);
    expect(asked.body.state).toBe("ARCHIVED");
    expect(asked.body.setupRequired).toBe(false);
    /* Creating a second would duplicate a decision somebody already took. */
    expect((await onAccount(`/for-customer/${customer._id}`, { method: "POST" })).status).toBe(409);
    expect(await accountsFor(customer._id)).toHaveLength(1);
  });

  test("9 · an unauthenticated caller can neither read nor establish", async () => {
    const customer = await portalCustomer();
    const read = await fetch(`${accountsBase}/for-customer/${customer._id}`);
    expect(read.status).toBe(401);
    const write = await fetch(`${accountsBase}/for-customer/${customer._id}`, { method: "POST" });
    expect(write.status).toBe(401);
    expect(await accountsFor(customer._id)).toHaveLength(0);
  });

  test("nothing is ever found, or created, by a name", async () => {
    /* An account with exactly this customer's name, and no link to them.
       A name is evidence of nothing: four of five correct links on this
       company's live data would fail a similarity test, and the one pair
       that looked alike was two different companies. */
    const customer = await portalCustomer({ name: "Identical Name Ltd" });
    await Account.create({ companyId: CO._id, companyName: "Identical Name Ltd", status: "active" });

    const asked = await onAccount(`/for-customer/${customer._id}`);
    expect(asked.body.state).toBe("ABSENT");

    const setUp = await onAccount(`/for-customer/${customer._id}`, { method: "POST" });
    expect(setUp.body.created).toBe(true);
    /* A new record of their own — the same-named one is untouched and
       unlinked, because nothing here matched it. */
    const same = await Account.collection.find({ companyName: "Identical Name Ltd" }).toArray();
    expect(same).toHaveLength(2);
    expect(same.filter((a) => a.linkedCustomer)).toHaveLength(1);

    /* And the service looks nothing up by a name: no regex, no normalised
       name, no name in any query. The only place a name appears is what the
       new record is CALLED. */
    const source = require("fs").readFileSync(
      require("path").join(__dirname, "../../services/sales/customerAccountLink.service.js"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/normalizedName|RegExp|\$regex|\$text/);
    for (const query of source.match(/find(One)?\(([\s\S]*?)\)\s*\n/g) || []) {
      expect(query).not.toMatch(/companyName|displayName|\bname\b/);
    }
  });

  test("a dry run reports what it would do and writes nothing", async () => {
    const customer = await portalCustomer();
    const dry = await onAccount(`/for-customer/${customer._id}?dryRun=true`, { method: "POST" });
    expect(dry.status).toBeLessThan(400);
    expect(dry.body.dryRun).toBe(true);
    expect(await accountsFor(customer._id)).toHaveLength(0);
    expect(await CustomerAccountClaim.countDocuments({})).toBe(0);
  });
});
