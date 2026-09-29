// test/crm/lead-contact-promotion.test.js
//
// THE PEOPLE ON A LEAD BECOME THE PEOPLE ON A CUSTOMER.
//
// A Prospect collects four people — merchandiser, purchase manager, admin
// head, whoever signs. Before this, `POST /leads/:id/account` created an
// Account with nobody on it, and Sales Journey seeded exactly ONE contact
// ("decision-maker, else the first one") and only when the Account had none.
// The other three were silently dropped and re-typed by hand.
//
// What matters in these tests is not that contacts appear. It is that the
// wrong ones never do: names are never merged, ambiguity is refused rather
// than guessed, an existing customer record is never overwritten by a Lead's
// older copy of it, and a refusal leaves nothing half-written.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
jest.mock("../../services/changeLog", () => ({
  recordChange: jest.fn().mockResolvedValue(undefined),
  historyForWithChildren: jest.fn(),
}));

const Lead = require("../../models/CMS_Models/Sales/Lead");
const Account = require("../../models/CMS_Models/Sales/Account");
const Contact = require("../../models/CMS_Models/Sales/Contact");
const DepartmentRole = require("../../models/Access/DepartmentRole");
require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");
const { promoteLeadContacts, ContactPromotionError } = require("../../services/leadContactPromotion");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };

let server, base, CO;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/leads", require("../../routes/CMS_Routes/Sales/leads"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/leads`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

beforeEach(async () => {
  await _resetSequence(new Date().getFullYear());
  await Promise.all([Lead.deleteMany({}), Account.deleteMany({}), Contact.deleteMany({}), DepartmentRole.deleteMany({})]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
});

async function call(path = "", { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(SALES_USER) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

const patch = (id, body) => call(`/${id}`, { method: "PATCH", body });

/** An Active Lead with people on it — the state customer setup starts from. */
async function activeLead(contacts, over = {}) {
  const lead = (await call("/", {
    method: "POST",
    body: { captureStatus: "draft", prospectType: "company", company: "Mayfair Lake Resort", ...over },
  })).body.lead;
  if (contacts) await patch(lead._id, { contacts });
  await Lead.updateOne({ _id: lead._id }, { $set: { captureStatus: "active" } });
  return Lead.findById(lead._id);
}

const FOUR = [
  { name: "Ramesh Sharma", jobTitle: "Purchase Manager", roleCode: "procurement", phone: "9876500011", email: "ramesh@mayfair.com", preferredChannel: "phone", preferredLanguage: "Hindi", isPrimary: true },
  { name: "Anita Rao", jobTitle: "Admin Head", roleCode: "hr_admin", email: "admin@mayfair.com" },
  { name: "Vikram Singh", roleCode: "merchandiser", whatsapp: "9876500033", isDecisionMaker: true },
  { name: "Priya Nair", roleCode: "site_coordinator", phone: "9876500044", status: "left_organization" },
];

const ctxFor = (lead) => ({
  scopeClause: { companyId: CO._id },
  ownership: { companyId: CO._id },
  actor: { id: SALES_USER.id, name: SALES_USER.name },
  lead,
});

/* ══ EVERYBODY COMES ACROSS ════════════════════════════════════════════════ */

test("every embedded contact is promoted, not just one decision-maker", async () => {
  const lead = await activeLead(FOUR);
  const { body, status } = await call(`/${lead._id}/account`, { method: "POST" });

  expect(status).toBe(201);
  expect(body.contacts.created).toBe(4);
  const contacts = await Contact.find({ accountId: body.accountId }).lean();
  expect(contacts.map((c) => `${c.firstName} ${c.lastName}`.trim()).sort()).toEqual(
    ["Anita Rao", "Priya Nair", "Ramesh Sharma", "Vikram Singh"],
  );
});

test("everything a contact knows survives the move", async () => {
  const lead = await activeLead(FOUR);
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  const ramesh = await Contact.findOne({ accountId: body.accountId, firstName: "Ramesh" }).lean();
  expect(ramesh.lastName).toBe("Sharma");
  expect(ramesh.jobTitle).toBe("Purchase Manager");
  expect(ramesh.roles).toEqual(["procurement"]);
  expect(ramesh.email).toBe("ramesh@mayfair.com");
  expect(ramesh.phone).toBe("9876500011");
  expect(ramesh.preferredChannel).toBe("phone");
  expect(ramesh.preferredContact).toBe("phone");     // the older field, where it maps
  expect(ramesh.preferredLanguage).toBe("Hindi");
  expect(ramesh.isPrimary).toBe(true);
  expect(String(ramesh.linkedLeads[0])).toBe(String(lead._id));

  // The decision-maker flag is a ROLE here, not a boolean that had nowhere to go.
  const vikram = await Contact.findOne({ accountId: body.accountId, firstName: "Vikram" }).lean();
  expect(vikram.roles.sort()).toEqual(["decision_maker", "merchandiser"]);
  expect(vikram.whatsapp).toBe("9876500033");

  // Somebody who has left arrives marked as having left, not as a fresh contact.
  const priya = await Contact.findOne({ accountId: body.accountId, firstName: "Priya" }).lean();
  expect(priya.status).toBe("left_organization");
  expect(priya.isPrimary).toBe(false);
});

test("each Lead contact records where its person went", async () => {
  const lead = await activeLead(FOUR);
  await call(`/${lead._id}/account`, { method: "POST" });

  const stored = await Lead.findById(lead._id).lean();
  expect(stored.contacts).toHaveLength(4);
  for (const c of stored.contacts) expect(c.promotedContactId).toBeTruthy();
});

/* ══ AN EXISTING CUSTOMER RECORD IS AUTHORITATIVE ═════════════════════════ */

test("a contact the Account already has is matched, not duplicated", async () => {
  const lead = await activeLead(FOUR);
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });
  await Lead.updateOne({ _id: lead._id }, { $unset: { "contacts.$[].promotedContactId": "" } });

  const { summary: again } = await promoteLeadContacts({ Contact }, {
    ...ctxFor(await Lead.findById(lead._id)),
    account: await Account.findById(body.accountId),
  });
  expect(again.created).toBe(0);
  expect(again.matched).toBe(4);
  expect(await Contact.countDocuments({ accountId: body.accountId })).toBe(4);
});

test("empty fields are filled; fields the customer already answered are not touched", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-1" });
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-1",
    firstName: "Ramesh", lastName: "Sharma", email: "ramesh@mayfair.com",
    jobTitle: "Head of Procurement",                 // their answer, not the Lead's
    // phone deliberately absent
  });

  const lead = await activeLead([FOUR[0]]);
  await promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct });

  const after = await Contact.findOne({ accountId: acct._id }).lean();
  expect(after.jobTitle).toBe("Head of Procurement");  // never overwritten
  expect(after.phone).toBe("9876500011");              // genuinely empty, so filled
  expect(after.preferredLanguage).toBe("Hindi");
});

test("a shared surname is never a merge", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-2" });
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-2",
    firstName: "Ramesh", lastName: "Sharma", phone: "9000000000", email: "other.ramesh@elsewhere.com",
  });

  const lead = await activeLead([FOUR[0]]);
  const { summary: result } = await promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct });

  expect(result.created).toBe(1);
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(2);
});

/* ══ AMBIGUITY IS REFUSED, NOT GUESSED ════════════════════════════════════ */

test("two existing contacts sharing our number refuse the promotion outright", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-3" });
  await Contact.create({ companyId: CO._id, accountId: acct._id, contactId: "CON-3", firstName: "One", phone: "9876500011" });
  await Contact.create({ companyId: CO._id, accountId: acct._id, contactId: "CON-4", firstName: "Two", mobile: "9876500011" });

  const lead = await activeLead(FOUR);
  await expect(promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct }))
    .rejects.toThrow(ContactPromotionError);

  // Nothing partial: the other three were resolvable and still were not written.
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(2);
  const stored = await Lead.findById(lead._id).lean();
  expect(stored.contacts.every((c) => !c.promotedContactId)).toBe(true);
});

test("the conflict names the person and the reason", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-4" });
  await Contact.create({ companyId: CO._id, accountId: acct._id, contactId: "CON-5", firstName: "One", email: "ramesh@mayfair.com" });
  await Contact.create({ companyId: CO._id, accountId: acct._id, contactId: "CON-6", firstName: "Two", email: "ramesh@mayfair.com" });

  const lead = await activeLead([FOUR[0]]);
  try {
    await promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct });
    throw new Error("should have refused");
  } catch (e) {
    expect(e).toBeInstanceOf(ContactPromotionError);
    expect(e.conflicts).toHaveLength(1);
    expect(e.conflicts[0].reason).toBe("ambiguous_email");
    expect(e.conflicts[0].contactName).toBe("Ramesh Sharma");
    expect(e.conflicts[0].contactIds).toHaveLength(2);
  }
});

/* ══ REPEATING IS SAFE, AND NEW PEOPLE STILL ARRIVE ═══════════════════════ */

test("running promotion twice creates nothing the second time", async () => {
  const lead = await activeLead(FOUR);
  const first = await call(`/${lead._id}/account`, { method: "POST" });
  const second = await call(`/${lead._id}/account`, { method: "POST" });

  expect(second.body.accountId).toBe(first.body.accountId);
  expect(second.body.contacts.created).toBe(0);
  expect(second.body.contacts.linked).toBe(4);
  expect(await Contact.countDocuments({ accountId: first.body.accountId })).toBe(4);
});

test("a Lead already linked to an Account still promotes people added later", async () => {
  const lead = await activeLead(FOUR.slice(0, 2));
  const first = await call(`/${lead._id}/account`, { method: "POST" });
  expect(first.body.contacts.created).toBe(2);

  // The site coordinator turns up on the second call, after customer setup.
  await patch(lead._id, { contacts: [...FOUR.slice(0, 2), { name: "Latecomer Singh", phone: "9876500099" }] });

  const again = await call(`/${lead._id}/account`, { method: "POST" });
  expect(again.body.created).toBe(false);           // the same Account
  expect(again.body.contacts.created).toBe(1);      // the new person only
  expect(await Contact.countDocuments({ accountId: first.body.accountId })).toBe(3);
});

/* ══ A POINTER IS ONLY WORTH WHAT IT POINTS AT ════════════════════════════ */

test("a promotedContactId belonging to another Account is refused", async () => {
  const otherAcct = await Account.create({ companyId: CO._id, companyName: "Somebody Else", accountId: "ACC-5" });
  const foreign = await Contact.create({ companyId: CO._id, accountId: otherAcct._id, contactId: "CON-7", firstName: "Foreign", lastName: "Person" });

  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-6" });
  const lead = await activeLead([{ ...FOUR[0] }]);
  await Lead.updateOne({ _id: lead._id }, { $set: { "contacts.0.promotedContactId": foreign._id } });

  try {
    await promoteLeadContacts({ Contact }, { ...ctxFor(await Lead.findById(lead._id)), account: acct });
    throw new Error("should have refused");
  } catch (e) {
    expect(e.conflicts[0].reason).toBe("foreign_link");
  }
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(0);
});

test("a promotedContactId from another company is refused too", async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-7" });
  const lead = await activeLead([{ ...FOUR[0] }]);

  const rival = await Acc_Company.create({ companyName: "Rival Co", booksFromDate: new Date("2026-04-01") });
  const theirs = await Contact.create({ companyId: rival._id, accountId: acct._id, contactId: "CON-8", firstName: "Their", lastName: "Person" });
  await Lead.updateOne({ _id: lead._id }, { $set: { "contacts.0.promotedContactId": theirs._id } });

  /* The scope clause is this company's, so their contact is invisible to the
     "already under this Account" lookup and lands in the foreign-link check. */
  await expect(promoteLeadContacts({ Contact }, { ...ctxFor(await Lead.findById(lead._id)), account: acct }))
    .rejects.toThrow(ContactPromotionError);
});

/* ══ ONE PRIMARY, AND NOBODY IS DEMOTED ═══════════════════════════════════ */

test("an Account's existing primary keeps the role", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-8" });
  const incumbent = await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-9",
    firstName: "Existing", lastName: "Primary", isPrimary: true, phone: "9111111111",
  });

  const lead = await activeLead(FOUR);
  const { summary: result } = await promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct });

  expect(result.primaryContactId).toBe(String(incumbent._id));
  const primaries = await Contact.find({ accountId: acct._id, isPrimary: true, isActive: true }).lean();
  expect(primaries).toHaveLength(1);
  expect(String(primaries[0]._id)).toBe(String(incumbent._id));
});

test("with no Account primary, the Lead's primary takes the role", async () => {
  const lead = await activeLead(FOUR);
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  const primaries = await Contact.find({ accountId: body.accountId, isPrimary: true }).lean();
  expect(primaries).toHaveLength(1);
  expect(primaries[0].firstName).toBe("Ramesh");
  const account = await Account.findById(body.accountId).lean();
  expect(String(account.primaryContact)).toBe(String(primaries[0]._id));
});

test("a Lead whose only person has left leaves the Account with no primary", async () => {
  /* Better no primary than an unreachable one: a customer whose named contact
     is somebody who left is worse than a customer with nobody named, because
     the first looks answered. */
  const lead = await activeLead([FOUR[3]]);          // left_organization, not primary
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  const promoted = await Contact.findOne({ accountId: body.accountId }).lean();
  expect(promoted.status).toBe("left_organization");
  expect(promoted.isPrimary).toBe(false);
  expect(await Contact.countDocuments({ accountId: body.accountId, isPrimary: true })).toBe(0);
  expect(body.contacts.primaryContactId).toBeNull();
});

test("the guard holds even for a legacy row the Lead rules would now refuse", async () => {
  /* A departed primary cannot be created through the Lead any more, so this
     state only exists on records that predate those rules. Asserted against
     the service directly: the route would also have to re-save the Lead, and
     that save is refused by the Lead's own validation — a separate rule, and
     not the one under test here. */
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-11" });
  const lead = await activeLead([{ name: "Priya Nair", phone: "9876500044" }]);
  lead.contacts[0].isPrimary = true;
  lead.contacts[0].status = "left_organization";

  const result = await promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct })
    .then((r) => r.summary)
    .catch((e) => ({ refusedBy: e.name }));

  if (result.refusedBy) {
    /* The Lead's own save refused the invalid row — also an acceptable
       outcome, and nothing was written. */
    expect(await Contact.countDocuments({ accountId: acct._id })).toBe(0);
  } else {
    expect(result.primaryContactId).toBeNull();
    expect(await Contact.countDocuments({ accountId: acct._id, isPrimary: true })).toBe(0);
  }
});

test("a departed contact is promoted alongside the active primary, without taking the role", async () => {
  const lead = await activeLead([FOUR[0], FOUR[3]]);   // active primary + somebody who left
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  expect(body.contacts.created).toBe(2);
  const primaries = await Contact.find({ accountId: body.accountId, isPrimary: true }).lean();
  expect(primaries).toHaveLength(1);
  expect(primaries[0].firstName).toBe("Ramesh");
});

/* ══ A FAILURE LEAVES NOTHING BEHIND ══════════════════════════════════════ */

test("a failure part-way through undoes what it had already written", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-9" });
  const lead = await activeLead(FOUR);

  /* The Lead save is the last write, after every Contact has been created —
     the exact window where a crash used to leave four orphan contacts under
     the Account and no link back from the Lead. */
  const boom = new Error("disk gave up");
  jest.spyOn(lead, "save").mockRejectedValueOnce(boom);

  await expect(promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct })).rejects.toThrow("disk gave up");
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(0);
});

test("a failed fill puts the customer's own value back", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-10" });
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-10",
    firstName: "Ramesh", lastName: "Sharma", email: "ramesh@mayfair.com", jobTitle: "Head of Procurement",
  });

  const lead = await activeLead([FOUR[0]]);
  jest.spyOn(lead, "save").mockRejectedValueOnce(new Error("nope"));
  await expect(promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct })).rejects.toThrow("nope");

  const after = await Contact.findOne({ accountId: acct._id }).lean();
  expect(after.jobTitle).toBe("Head of Procurement");
  expect(after.phone == null || after.phone === "").toBe(true);   // the fill was undone
});

/* ══ PROMOTION BEGINS AT THE ACCOUNT, NOT BEFORE ══════════════════════════ */

test("Prospect → Lead conversion creates no CRM Contact", async () => {
  const draft = (await call("/", {
    method: "POST",
    body: { captureStatus: "draft", prospectType: "company", company: "Mayfair Lake Resort" },
  })).body.lead;
  await patch(draft._id, { contacts: FOUR.slice(0, 2) });

  await call(`/${draft._id}/convert-to-active`, {
    method: "POST",
    body: { interestSignal: "verbal", interestNote: "Asked for a quote on 400 shirts." },
  });

  expect(await Contact.countDocuments({})).toBe(0);
  expect(await Account.countDocuments({})).toBe(0);
});

test("customer setup is refused for a Prospect, so nothing can be promoted early", async () => {
  const draft = (await call("/", {
    method: "POST",
    body: { captureStatus: "draft", prospectType: "company", company: "Mayfair Lake Resort" },
  })).body.lead;
  await patch(draft._id, { contacts: FOUR.slice(0, 2) });

  const { status } = await call(`/${draft._id}/account`, { method: "POST" });
  expect(status).toBe(400);
  expect(await Contact.countDocuments({})).toBe(0);
});

/* ══ A HALF-SET-UP CUSTOMER IS WORSE THAN NONE ════════════════════════════
 * The Account and the Lead's link to it were written BEFORE promotion, so a
 * failure afterwards left a customer record on the Lead whose people had never
 * arrived — and no way back, because the button only offers to create a
 * customer that now appears to exist.
 * ═════════════════════════════════════════════════════════════════════════ */

test("an unexpected promotion failure leaves no Account and no link on the Lead", async () => {
  const lead = await activeLead(FOUR);
  const boom = jest.spyOn(Contact, "create").mockRejectedValueOnce(new Error("disk gave up"));

  const { status } = await call(`/${lead._id}/account`, { method: "POST" });
  boom.mockRestore();

  expect(status).toBeGreaterThanOrEqual(400);   // the route's general error shape
  expect(await Account.countDocuments({})).toBe(0);
  expect(await Contact.countDocuments({})).toBe(0);
  const after = await Lead.findById(lead._id).lean();
  expect(after.accountId == null).toBe(true);
  expect(after.contacts.every((c) => !c.promotedContactId)).toBe(true);
});

/* ══ A REFUSAL IS NOT A SUCCESS ═══════════════════════════════════════════
 * Conflicts used to come back as `success: true` with a count, so the screen
 * linked the customer and showed a mild note — while the people it was about
 * had not been promoted, and there is no screen anywhere for doing it by hand.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a conflict on an EXISTING Account refuses, and changes nothing", async () => {
  /* Two Lead contacts carrying one number: whichever way it resolved, one of
     them would be wrong. */
  const lead = await activeLead([
    { name: "Ramesh Sharma", phone: "9876500011", isPrimary: true },
    { name: "Anita Rao", phone: "9876500022" },
  ]);
  const acct = await Account.create({ companyId: CO._id, companyName: "Elsewhere", accountId: "ACC-C1" });
  await Contact.create({ companyId: CO._id, accountId: acct._id, contactId: "CON-C1", firstName: "A", phone: "9876500011" });
  await Contact.create({ companyId: CO._id, accountId: acct._id, contactId: "CON-C2", firstName: "B", mobile: "9876500011" });
  // Point the Lead at that Account so promotion runs against it.
  await Lead.updateOne({ _id: lead._id }, { $set: { accountId: acct._id } });

  const { status, body } = await call(`/${lead._id}/account`, { method: "POST" });
  if (status !== 409) throw new Error(`got ${status}: ${JSON.stringify(body)}`);
  expect(body.success).toBe(false);
  expect(body.code).toBe("contact_promotion_conflict");
  expect(body.conflicts[0].reason).toBe("ambiguous_phone");
  expect(body.conflicts[0].contactName).toBe("Ramesh Sharma");

  // Existing Account preserved; not one contact or promotedContactId moved.
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(2);
  const after = await Lead.findById(lead._id).lean();
  expect(String(after.accountId)).toBe(String(acct._id));
  expect(after.contacts.every((c) => !c.promotedContactId)).toBe(true);
});

/* ══ EVERY MUTATION IS RECORDED, SO EVERY MUTATION CAN BE UNDONE ══════════ */

test("a failed Lead save leaves a matched Contact byte-equivalent", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-R1" });
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-R1",
    firstName: "Ramesh", lastName: "Sharma", email: "ramesh@mayfair.com",
  });
  const before = await Contact.findOne({ accountId: acct._id }).lean();
  expect(before.linkedLeads).toEqual([]);   // nothing linked yet

  const lead = await activeLead([FOUR[0]]);
  jest.spyOn(lead, "save").mockRejectedValueOnce(new Error("nope"));
  await expect(promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct })).rejects.toThrow("nope");

  const after = await Contact.findOne({ accountId: acct._id }).lean();
  expect(after.linkedLeads).toEqual([]);    // the link we added was pulled back
  expect(after.phone == null || after.phone === "").toBe(true);
  expect(after.jobTitle == null).toBe(true);
  expect(after.updatedBy == null).toBe(true);
  expect(after.roles).toEqual(before.roles);
});

test("a rollback never removes a link that was already there", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-R2" });
  const otherLead = new mongoose.Types.ObjectId();
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-R2",
    firstName: "Ramesh", lastName: "Sharma", email: "ramesh@mayfair.com",
    linkedLeads: [otherLead],
  });

  const lead = await activeLead([FOUR[0]]);
  jest.spyOn(lead, "save").mockRejectedValueOnce(new Error("nope"));
  await expect(promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct })).rejects.toThrow("nope");

  const after = await Contact.findOne({ accountId: acct._id }).lean();
  expect(after.linkedLeads.map(String)).toEqual([String(otherLead)]);
});

/* ══ THE PRIMARY BELONGS ON THE ACCOUNT, IN BOTH PATHS ════════════════════ */

test("a newly created Account is returned with its primary already on it", async () => {
  const lead = await activeLead(FOUR);
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  const ramesh = await Contact.findOne({ accountId: body.accountId, firstName: "Ramesh" }).lean();
  // The RETURNED document, not a re-fetch — a stale copy is what the bug was.
  expect(String(body.account.primaryContact)).toBe(String(ramesh._id));
});

test("reconciling an already-linked Account persists the primary too", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-P1" });
  const lead = await activeLead(FOUR);
  await Lead.updateOne({ _id: lead._id }, { $set: { accountId: acct._id } });

  const { status, body } = await call(`/${lead._id}/account`, { method: "POST" });
  expect(status).toBe(200);
  expect(body.created).toBe(false);

  const ramesh = await Contact.findOne({ accountId: acct._id, firstName: "Ramesh" }).lean();
  expect(String(body.account.primaryContact)).toBe(String(ramesh._id));
  expect(String((await Account.findById(acct._id).lean()).primaryContact)).toBe(String(ramesh._id));
});

test("an Account that already names a primary keeps it through reconciliation", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-P2" });
  const incumbent = await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-P2",
    firstName: "Existing", lastName: "Primary", isPrimary: true, phone: "9111111111",
  });
  await Account.updateOne({ _id: acct._id }, { $set: { primaryContact: incumbent._id } });

  const lead = await activeLead(FOUR);
  await Lead.updateOne({ _id: lead._id }, { $set: { accountId: acct._id } });
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  expect(String(body.account.primaryContact)).toBe(String(incumbent._id));
});

/* ══ AN ARCHIVED CONTACT IS NOT AN ABSENT ONE ═════════════════════════════
 * Loading only active contacts made two lies possible: a link to an archived
 * contact under THIS Account was reported as belonging to a different one, and
 * an archived person's number produced a second contact with the same
 * identity sitting beside them.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a link to an archived contact on this Account is not called foreign", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-I1" });
  const archived = await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-I1",
    firstName: "Ramesh", lastName: "Sharma", isActive: false, status: "archived", archivedAt: new Date(),
  });

  const lead = await activeLead([FOUR[0]]);
  await Lead.updateOne({ _id: lead._id }, { $set: { "contacts.0.promotedContactId": archived._id } });

  try {
    await promoteLeadContacts({ Contact }, { ...ctxFor(await Lead.findById(lead._id)), account: acct });
    throw new Error("should have refused");
  } catch (e) {
    expect(e.conflicts[0].reason).toBe("inactive_link");     // not "foreign_link"
    expect(e.conflicts[0].message).toMatch(/archived contact on this customer/);
  }
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(1);
});

test("an archived contact's identity is never silently duplicated", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-I2" });
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-I2",
    firstName: "Ramesh", lastName: "Sharma", phone: "9876500011",
    isActive: false, status: "archived", archivedAt: new Date(),
  });

  const lead = await activeLead([FOUR[0]]);
  try {
    await promoteLeadContacts({ Contact }, { ...ctxFor(lead), account: acct });
    throw new Error("should have refused");
  } catch (e) {
    expect(e.conflicts[0].reason).toBe("inactive_match");
  }
  // No second Ramesh sitting beside the archived one.
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(1);
});

test("a conflict on a NEW Account rolls the Account and the link back", async () => {
  /* A Lead with no Account yet, carrying a link to somebody else's contact.
     The Account is created first, so the refusal has to undo it. */
  const otherAcct = await Account.create({ companyId: CO._id, companyName: "Somebody Else", accountId: "ACC-N1" });
  const foreign = await Contact.create({
    companyId: CO._id, accountId: otherAcct._id, contactId: "CON-N1",
    firstName: "Foreign", lastName: "Person",
  });

  const lead = await activeLead([FOUR[0]]);
  await Lead.updateOne({ _id: lead._id }, { $set: { "contacts.0.promotedContactId": foreign._id } });

  const before = await Account.countDocuments({});
  const { status, body } = await call(`/${lead._id}/account`, { method: "POST" });

  expect(status).toBe(409);
  expect(body.conflicts[0].reason).toBe("foreign_link");
  expect(await Account.countDocuments({})).toBe(before);   // no new Account survived
  const after = await Lead.findById(lead._id).lean();
  expect(after.accountId == null).toBe(true);              // and no link on the Lead
});

test("a failure while persisting the Account primary undoes the promotion too", async () => {
  const lead = await activeLead(FOUR);
  const boom = jest.spyOn(Account, "updateOne").mockRejectedValueOnce(new Error("primary write failed"));

  const { status } = await call(`/${lead._id}/account`, { method: "POST" });
  boom.mockRestore();

  expect(status).toBeGreaterThanOrEqual(400);
  expect(await Account.countDocuments({})).toBe(0);
  expect(await Contact.countDocuments({})).toBe(0);
  const after = await Lead.findById(lead._id).lean();
  expect(after.accountId == null).toBe(true);
  expect(after.contacts.every((c) => !c.promotedContactId)).toBe(true);
});

/* ══ COMPENSATION MUST NOT TRAVEL BACK IN TIME ════════════════════════════
 * `undo()` used to call `lead.save()` on the document loaded before promotion
 * — the WHOLE record, not just the links it wrote. In a Journey race the other
 * request converts the same Lead in the meantime; saving this stale copy wrote
 * `readyToConvert` back over the winner's `converted` and silently undid their
 * conversion, along with anything else changed since the load.
 *
 * These tests change the DATABASE between promotion and compensation — not a
 * mock — because that is the only way the defect appears at all.
 * ═════════════════════════════════════════════════════════════════════════ */

test("undo() does not overwrite a conversion another request made in the meantime", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-Z1" });
  const lead = await activeLead(FOUR);
  await Lead.updateOne({ _id: lead._id }, { $set: { qualificationState: "readyToConvert" } });

  // Our request promotes, holding the document it loaded a moment ago.
  const held = await Lead.findById(lead._id);
  const { undo } = await promoteLeadContacts({ Contact, Lead }, { ...ctxFor(held), account: acct });
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(4);

  /* ANOTHER request wins: it converts the Lead and edits an unrelated field.
     Written straight to the database, exactly as a concurrent request would. */
  const journeyId = new mongoose.Types.ObjectId();
  await Lead.updateOne({ _id: lead._id }, {
    $set: {
      qualificationState: "converted",
      conversion: { accountId: acct._id, journeyId, convertedAt: new Date() },
      notes: "the winner's note",
    },
  });

  // Now our losing request compensates.
  await undo();

  const after = await Lead.findById(lead._id).lean();
  expect(after.qualificationState).toBe("converted");            // NOT reversed
  expect(String(after.conversion.journeyId)).toBe(String(journeyId));
  expect(after.notes).toBe("the winner's note");                 // unrelated edit intact
  // …and our links, which were still ours, are gone.
  expect(after.contacts.every((c) => !c.promotedContactId)).toBe(true);
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(0);
});

test("undo() leaves a link another request has since repointed", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-Z2" });
  const lead = await activeLead(FOUR);

  const held = await Lead.findById(lead._id);
  const { summary, undo } = await promoteLeadContacts({ Contact, Lead }, { ...ctxFor(held), account: acct });
  const first = summary.contacts[0];

  /* Somebody else repoints that one contact at a different CRM Contact. Our
     compensation wrote the OLD value, so it must not touch this row. */
  const somebodyElse = new mongoose.Types.ObjectId();
  await Lead.updateOne(
    { _id: lead._id, "contacts._id": first.leadContactId },
    { $set: { "contacts.$.promotedContactId": somebodyElse } },
  );

  await undo();

  const after = await Lead.findById(lead._id).lean();
  const row = after.contacts.find((c) => String(c._id) === first.leadContactId);
  expect(String(row.promotedContactId)).toBe(String(somebodyElse));   // newer value stands
  // Every other row, still holding what we wrote, was cleared.
  expect(after.contacts.filter((c) => String(c._id) !== first.leadContactId)
    .every((c) => !c.promotedContactId)).toBe(true);
});

test("undo() is idempotent", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-Z3" });
  const lead = await activeLead(FOUR);
  const held = await Lead.findById(lead._id);
  const { undo } = await promoteLeadContacts({ Contact, Lead }, { ...ctxFor(held), account: acct });

  await undo();
  const once = await Lead.findById(lead._id).lean();
  await undo();
  await undo();
  const thrice = await Lead.findById(lead._id).lean();

  expect(thrice.contacts.map((c) => c.promotedContactId)).toEqual(once.contacts.map((c) => c.promotedContactId));
  expect(await Contact.countDocuments({ accountId: acct._id })).toBe(0);
});

test("undo() restores a link that existed before this promotion, not a blank", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-Z4" });
  const previous = await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-Z4",
    firstName: "Ramesh", lastName: "Sharma", email: "ramesh@mayfair.com",
  });
  const lead = await activeLead([FOUR[0]]);
  await Lead.updateOne({ _id: lead._id }, { $set: { "contacts.0.promotedContactId": previous._id } });

  const held = await Lead.findById(lead._id);
  const { undo } = await promoteLeadContacts({ Contact, Lead }, { ...ctxFor(held), account: acct });
  await undo();

  const after = await Lead.findById(lead._id).lean();
  expect(String(after.contacts[0].promotedContactId)).toBe(String(previous._id));
});

/* ══ A SUPPRESSED PERSON IS NOT A PRIMARY ═════════════════════════════════ */

test("promotion never inherits an Account primary who is marked do-not-contact", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-D1" });
  await Contact.create({
    companyId: CO._id, accountId: acct._id, contactId: "CON-D1",
    firstName: "Suppressed", lastName: "Primary", isPrimary: true,
    phone: "9111111111", doNotContact: true,
  });

  const lead = await activeLead(FOUR);
  const { summary } = await promoteLeadContacts({ Contact, Lead }, { ...ctxFor(lead), account: acct });

  /* The suppressed incumbent is not offered, so the Lead's own active primary
     takes the role instead — and is never the suppressed person. */
  const ramesh = await Contact.findOne({ accountId: acct._id, firstName: "Ramesh" }).lean();
  expect(summary.primaryContactId).toBe(String(ramesh._id));
  const suppressed = await Contact.findOne({ firstName: "Suppressed" }).lean();
  expect(summary.primaryContactId).not.toBe(String(suppressed._id));
});

test("a Lead contact marked do-not-contact never becomes the primary", async () => {
  const lead = await activeLead([{ name: "Priya Nair", phone: "9876500044", status: "do_not_contact" }]);
  const { body } = await call(`/${lead._id}/account`, { method: "POST" });

  expect(await Contact.countDocuments({ accountId: body.accountId, isPrimary: true })).toBe(0);
  expect(body.contacts.primaryContactId).toBeNull();
});

test("undo() does not delete a contact another request added in the meantime", async () => {
  /* The sharpest form of the stale-save hazard. `lead.save()` after
     `markModified("contacts")` rewrites the WHOLE array from the copy loaded
     before promotion — so a person added by a concurrent request, who does not
     exist in that copy, is silently deleted by the losing request's rollback. */
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-Z5" });
  const lead = await activeLead(FOUR);

  const held = await Lead.findById(lead._id);
  const { undo } = await promoteLeadContacts({ Contact, Lead }, { ...ctxFor(held), account: acct });

  // Another request adds the site coordinator while ours is failing.
  await Lead.updateOne({ _id: lead._id }, {
    $push: { contacts: { name: "Latecomer Singh", phone: "9876500099", status: "active" } },
  });

  await undo();

  const after = await Lead.findById(lead._id).lean();
  expect(after.contacts).toHaveLength(5);
  expect(after.contacts.some((c) => c.name === "Latecomer Singh")).toBe(true);
});
