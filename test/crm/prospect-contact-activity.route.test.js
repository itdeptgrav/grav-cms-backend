// test/crm/prospect-contact-activity.route.test.js
//
// WHICH PERSON DID THIS HAPPEN WITH?
//
// A B2B Prospect has several people on it, and until now every Activity said
// only which RECORD it belonged to. A timeline that reads "Call — Mayfair Lake
// Resort" cannot answer the one question a salesperson opening it has: who did
// we speak to?
//
// `Activity.leadContactId` is that answer. It is an EMBEDDED contact's `_id`,
// not a CRMContact — those belong to an Account and do not exist yet, which is
// exactly why `contactId` could never carry this. `contactName` stays the
// historical snapshot: what the person was called at the time, which survives
// them being renamed, removed, or promoted.
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
const Activity = require("../../models/CMS_Models/Sales/Activity");
const DepartmentRole = require("../../models/Access/DepartmentRole");
require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };
const dueDate = "2026-12-01T09:00:00.000Z";

let server, base;

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
  await DepartmentRole.deleteMany({});
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  if (!(await Acc_Company.countDocuments({}))) {
    await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
  }
});

async function call(path = "", { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(SALES_USER) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

const prospect = async (over = {}) => (await call("/", {
  method: "POST",
  body: { captureStatus: "draft", prospectType: "company", company: "Mayfair Lake Resort", ...over },
})).body.lead;

const patch = (id, body) => call(`/${id}`, { method: "PATCH", body });
const stored = (id) => Lead.findById(id).lean();

/** A Prospect with two named people on it. */
async function withContacts(over = {}) {
  const lead = await prospect(over);
  await patch(lead._id, {
    contacts: [
      { name: "Ramesh Sharma", jobTitle: "Purchase Manager", phone: "9876500011", email: "ramesh@mayfair.com", isPrimary: true },
      { name: "Anita Rao", jobTitle: "Admin Head", phone: "9800000000", email: "admin@mayfair.com" },
    ],
  });
  const saved = await stored(lead._id);
  return { lead: saved, ramesh: saved.contacts[0], anita: saved.contacts[1] };
}

const logCall = (leadId, body) => call(`/${leadId}/activities`, {
  method: "POST",
  body: { activityType: "call", subject: "Rang them", outcome: "replied_connected", ...body },
});

/* ══ CONTACT IDENTITY ON ACTIVITIES ════════════════════════════════════════ */

test("an Activity accepts a contact belonging to its own Lead", async () => {
  const { lead, ramesh } = await withContacts();
  const r = await logCall(lead._id, { leadContactId: String(ramesh._id) });
  expect(r.status).toBe(201);
  expect(String(r.body.activity.leadContactId)).toBe(String(ramesh._id));
});

test("a contact id from another Lead is refused", async () => {
  /* It would attach somebody else's identity to this record's history. */
  const mine = await withContacts();
  const theirs = await withContacts({ company: "Other Co" });
  const r = await logCall(mine.lead._id, { leadContactId: String(theirs.ramesh._id) });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/not on this Lead/i);
  expect(await Activity.countDocuments({ leadId: mine.lead._id })).toBe(0);
});

test("a contact id belonging to nobody is refused", async () => {
  const { lead } = await withContacts();
  const r = await logCall(lead._id, { leadContactId: new mongoose.Types.ObjectId().toString() });
  expect(r.status).toBe(400);
});

test("the server derives the contact name and ignores a contradicting one", async () => {
  /* A client that sends a name disagreeing with the id it also sent is stale
     or wrong; the server's copy of the record is the one to believe. */
  const { lead, ramesh } = await withContacts();
  const r = await logCall(lead._id, { leadContactId: String(ramesh._id), contactName: "Somebody Else" });
  expect(r.status).toBe(201);
  expect(r.body.activity.contactName).toBe("Ramesh Sharma");
});

test("an Activity with no contact stays valid — legacy history and general notes", async () => {
  const { lead } = await withContacts();
  const r = await call(`/${lead._id}/activities`, {
    method: "POST",
    body: { activityType: "note", subject: "Rang the switchboard, nobody named" },
  });
  expect(r.status).toBe(201);
  expect(r.body.activity.leadContactId).toBeUndefined();
});

test("the contact id comes back when the timeline is read", async () => {
  const { lead, anita } = await withContacts();
  await logCall(lead._id, { leadContactId: String(anita._id) });
  const r = await call(`/${lead._id}/activities`);
  expect(r.status).toBe(200);
  const row = r.body.activities.find((a) => a.activityType === "call");
  expect(String(row.leadContactId)).toBe(String(anita._id));
  expect(row.contactName).toBe("Anita Rao");
});

test("an embedded id never lands in contactId", async () => {
  /* `contactId` refs CRMContact. An embedded id there is a broken reference
     that populate() silently resolves to null. */
  const { lead, ramesh } = await withContacts();
  await logCall(lead._id, { leadContactId: String(ramesh._id) });
  const row = await Activity.findOne({ leadId: lead._id, activityType: "call" }).lean();
  expect(row.contactId).toBeUndefined();
  expect(String(row.leadContactId)).toBe(String(ramesh._id));
});

/* ══ ONE NEXT ACTION, WITH AN OPTIONAL TARGET ══════════════════════════════ */

test("the next action can name the person it is aimed at", async () => {
  const { lead, ramesh } = await withContacts();
  const r = await call(`/${lead._id}/next-action`, {
    method: "PATCH",
    body: { subject: "Send the catalogue", dueDate, leadContactId: String(ramesh._id) },
  });
  expect(r.status).toBe(200);
  expect(String((await stored(lead._id)).pendingFirstAction.leadContactId)).toBe(String(ramesh._id));
});

test("a general next action needs no person", async () => {
  const { lead } = await withContacts();
  const r = await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Chase the tender document", dueDate } });
  expect(r.status).toBe(200);
  expect((await stored(lead._id)).pendingFirstAction.leadContactId).toBeUndefined();
});

test("a next action cannot target somebody else's contact", async () => {
  const mine = await withContacts();
  const theirs = await withContacts({ company: "Other Co" });
  const r = await call(`/${mine.lead._id}/next-action`, {
    method: "PATCH",
    body: { subject: "Send the catalogue", dueDate, leadContactId: String(theirs.ramesh._id) },
  });
  expect(r.status).toBe(400);
  expect((await stored(mine.lead._id)).pendingFirstAction?.subject).toBeUndefined();
});

test("conversion carries the target onto the first follow-up Activity", async () => {
  const { lead, ramesh } = await withContacts({ source: "referral" });
  await patch(lead._id, { requirementCertainty: "suspected" });
  await call(`/${lead._id}/next-action`, {
    method: "PATCH",
    body: { subject: "Send the catalogue", dueDate, leadContactId: String(ramesh._id) },
  });
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Reached them",
    status: "completed", completedAt: new Date(), outcome: "replied_connected", ownerId: SALES_USER.id,
  });

  const r = await call(`/${lead._id}/convert-to-active`, {
    method: "POST",
    body: { interestSignal: "requested_sample", interestNote: "Asked for a sample." },
  });
  expect(r.status).toBe(200);

  const followUp = await Activity.findOne({ leadId: lead._id, activityType: "follow_up" }).lean();
  expect(String(followUp.leadContactId)).toBe(String(ramesh._id));
  expect(followUp.contactName).toBe("Ramesh Sharma");
});

test("conversion still works when the next action names nobody", async () => {
  const { lead } = await withContacts({ source: "referral" });
  await patch(lead._id, { requirementCertainty: "suspected" });
  await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Send the catalogue", dueDate } });
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Reached them",
    status: "completed", completedAt: new Date(), outcome: "replied_connected", ownerId: SALES_USER.id,
  });
  const r = await call(`/${lead._id}/convert-to-active`, {
    method: "POST",
    body: { interestSignal: "requested_sample", interestNote: "Asked for a sample." },
  });
  expect(r.status).toBe(200);
  expect((await Activity.findOne({ leadId: lead._id, activityType: "follow_up" }).lean()).leadContactId).toBeUndefined();
});

/* ══ HISTORY OUTLIVES THE PERSON ═══════════════════════════════════════════ */

test("a contact with history cannot be removed", async () => {
  /* Deleting them would leave a call in the timeline whose "who" resolves to
     nothing. Somebody who left is a fact about the relationship, not a row to
     tidy away. */
  const { lead, ramesh, anita } = await withContacts();
  await logCall(lead._id, { leadContactId: String(ramesh._id) });

  const r = await patch(lead._id, { contacts: [{ _id: String(anita._id), name: "Anita Rao", isPrimary: true }] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/Left organisation.*Do not contact/i);
  expect((await stored(lead._id)).contacts).toHaveLength(2);
});

test("a contact who is the current next action's target cannot be removed", async () => {
  const { lead, ramesh, anita } = await withContacts();
  await call(`/${lead._id}/next-action`, {
    method: "PATCH", body: { subject: "Send the catalogue", dueDate, leadContactId: String(ramesh._id) },
  });
  const r = await patch(lead._id, { contacts: [{ _id: String(anita._id), name: "Anita Rao", isPrimary: true }] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/next action/i);
});

test("a contact with no history is still removable", async () => {
  const { lead, ramesh, anita } = await withContacts();
  await logCall(lead._id, { leadContactId: String(ramesh._id) });
  const r = await patch(lead._id, { contacts: [{ _id: String(ramesh._id), name: "Ramesh Sharma", isPrimary: true }] });
  expect(r.status).toBe(200);
  expect((await stored(lead._id)).contacts).toHaveLength(1);
  expect(String((await stored(lead._id)).contacts[0]._id)).toBe(String(ramesh._id));
  expect(anita).toBeTruthy();
});

test("marking somebody Left organisation is always available instead", async () => {
  const { lead, ramesh, anita } = await withContacts();
  await logCall(lead._id, { leadContactId: String(ramesh._id) });
  const r = await patch(lead._id, {
    contacts: [
      { _id: String(ramesh._id), name: "Ramesh Sharma", status: "left_organization", isPrimary: false },
      { _id: String(anita._id), name: "Anita Rao", isPrimary: true },
    ],
  });
  expect(r.status).toBe(200);
  const after = await stored(lead._id);
  expect(after.contacts.find((c) => c.name === "Ramesh Sharma").status).toBe("left_organization");
  // and the history still points at them
  const row = await Activity.findOne({ leadId: lead._id, activityType: "call" }).lean();
  expect(String(row.leadContactId)).toBe(String(ramesh._id));
});

/* ══ RE-AIMING A REMINDER ══════════════════════════════════════════════════
 * `NextActionForm` was already sending `leadContactId` while editing a
 * reminder and the route ignored it — the selector was visible, the field
 * travelled, and nothing happened.
 * ═════════════════════════════════════════════════════════════════════════ */

const activeLead = async () => {
  const { body } = await call("/", { method: "POST", body: { prospectType: "company", company: "Mayfair Lake Resort", phone: "9876500011" } });
  const lead = body.lead;
  await patch(lead._id, {
    contacts: [
      { name: "Ramesh Sharma", phone: "9876500011", email: "ramesh@mayfair.com", isPrimary: true },
      { name: "Anita Rao", phone: "9800000000", email: "admin@mayfair.com" },
    ],
  });
  const saved = await stored(lead._id);
  return { lead: saved, ramesh: saved.contacts[0], anita: saved.contacts[1] };
};

test("a reminder can be created with a target, then re-aimed, then cleared", async () => {
  const { lead, ramesh, anita } = await activeLead();

  const made = await call(`/${lead._id}/next-action`, {
    method: "PATCH", body: { subject: "Send the catalogue", dueDate, leadContactId: String(ramesh._id) },
  });
  expect(made.status).toBe(200);
  const id = made.body.activity._id;
  expect(String((await Activity.findById(id).lean()).leadContactId)).toBe(String(ramesh._id));
  expect((await Activity.findById(id).lean()).contactName).toBe("Ramesh Sharma");

  const moved = await call(`/${lead._id}/activities/${id}`, { method: "PATCH", body: { leadContactId: String(anita._id) } });
  expect(moved.status).toBe(200);
  const after = await Activity.findById(id).lean();
  expect(String(after.leadContactId)).toBe(String(anita._id));
  expect(after.contactName).toBe("Anita Rao");   // the name follows the id

  const cleared = await call(`/${lead._id}/activities/${id}`, { method: "PATCH", body: { leadContactId: null } });
  expect(cleared.status).toBe(200);
  const blank = await Activity.findById(id).lean();
  expect(blank.leadContactId).toBeUndefined();
  /* No stale name left behind — a reminder still labelled with somebody it is
     no longer aimed at is worse than one labelled with nobody. */
  expect(blank.contactName).toBeUndefined();
});

test("a reminder cannot be re-aimed at another Lead's contact", async () => {
  const mine = await activeLead();
  const theirs = await withContacts({ company: "Other Co" });
  const made = await call(`/${mine.lead._id}/next-action`, { method: "PATCH", body: { subject: "Call them", dueDate } });
  const r = await call(`/${mine.lead._id}/activities/${made.body.activity._id}`, {
    method: "PATCH", body: { leadContactId: String(theirs.ramesh._id) },
  });
  expect(r.status).toBe(400);
});

/* ══ THE OTHER CONVERSION PATH ═════════════════════════════════════════════ */

test("the retained /approve path carries the pending target too", async () => {
  /* Not the path the UI uses, but a Prospect approved through it must not
     silently lose the person its first follow-up was aimed at. */
  const { lead, ramesh } = await withContacts({ source: "referral" });
  await patch(lead._id, { requirementCertainty: "suspected" });
  await call(`/${lead._id}/next-action`, {
    method: "PATCH", body: { subject: "Send the catalogue", dueDate, leadContactId: String(ramesh._id) },
  });
  await Lead.updateOne({ _id: lead._id }, { $set: { reviewStatus: "submitted" } });
  await DepartmentRole.create({ departmentSlug: "sales", email: SALES_USER.email, name: SALES_USER.name, role: "approver" });

  const r = await call(`/${lead._id}/approve`, { method: "POST", body: {} });
  expect(r.status).toBe(200);
  const followUp = await Activity.findOne({ leadId: lead._id, activityType: "follow_up" }).lean();
  expect(String(followUp.leadContactId)).toBe(String(ramesh._id));
  expect(followUp.contactName).toBe("Ramesh Sharma");
});

/* ══ TWO PEOPLE AT ONCE ARE NOT ONE EVENT ══════════════════════════════════
 * The de-duplication window was per CHANNEL: any call logged within ten
 * minutes suppressed the next. Ring the merchandiser and then the purchase
 * manager about the same order — as anybody would — and the second call
 * silently never appeared.
 * ═════════════════════════════════════════════════════════════════════════ */

test("two contacts reached on the same channel minutes apart both log", async () => {
  const { lead, ramesh, anita } = await withContacts();
  const t0 = new Date("2026-09-05T10:00:00.000Z");
  const t1 = new Date("2026-09-05T10:03:00.000Z");   // three minutes later

  expect((await logCall(lead._id, { leadContactId: String(ramesh._id), activityDate: t0.toISOString() })).status).toBe(201);
  expect((await logCall(lead._id, { leadContactId: String(anita._id), activityDate: t1.toISOString() })).status).toBe(201);

  const rows = await Activity.find({ leadId: lead._id, activityType: "call" }).lean();
  expect(rows).toHaveLength(2);
  expect(new Set(rows.map((r) => String(r.leadContactId))).size).toBe(2);
});

/* ══ HISTORY IS HISTORY, ACTIVE OR NOT ═════════════════════════════════════ */

test("a soft-deleted Activity still protects its contact from removal", async () => {
  /* The check filtered on `isActive: true`, so archiving a call made the
     person it named deletable — and the archived row was left pointing at
     nobody. Hidden history is not disposable history. */
  const { lead, ramesh, anita } = await withContacts();
  await logCall(lead._id, { leadContactId: String(ramesh._id) });
  await Activity.updateOne({ leadId: lead._id, activityType: "call" }, { $set: { isActive: false } });

  const r = await patch(lead._id, { contacts: [{ _id: String(anita._id), name: "Anita Rao", isPrimary: true }] });
  expect(r.status).toBe(400);
  expect((await stored(lead._id)).contacts).toHaveLength(2);
});

/* ══ AN INTERACTION AND ITS FOLLOW-UP ARE ABOUT THE SAME PERSON ════════════
 * Exercised as the real two-step flow — log, then schedule — rather than by
 * checking a prop is present in the source.
 * ═════════════════════════════════════════════════════════════════════════ */

test("logging an interaction and scheduling a follow-up keeps the same person", async () => {
  const { lead, ramesh } = await withContacts();

  const logged = await call(`/${lead._id}/activities`, {
    method: "POST",
    body: { activityType: "note", subject: "Discussed the sample", leadContactId: String(ramesh._id) },
  });
  expect(logged.status).toBe(201);
  expect(String(logged.body.activity.leadContactId)).toBe(String(ramesh._id));

  const followUp = await call(`/${lead._id}/next-action`, {
    method: "PATCH",
    body: { subject: "Send the revised quote", dueDate, leadContactId: String(ramesh._id) },
  });
  expect(followUp.status).toBe(200);

  const pending = (await stored(lead._id)).pendingFirstAction;
  expect(String(pending.leadContactId)).toBe(String(ramesh._id));
  /* Both halves name the same person, and the name came from the record. */
  expect(logged.body.activity.contactName).toBe("Ramesh Sharma");
});

test("a general interaction and a general follow-up name nobody", async () => {
  const { lead } = await withContacts();
  const logged = await call(`/${lead._id}/activities`, {
    method: "POST", body: { activityType: "note", subject: "Company is restructuring" },
  });
  expect(logged.body.activity.leadContactId).toBeUndefined();
  await call(`/${lead._id}/next-action`, { method: "PATCH", body: { subject: "Check back", dueDate } });
  expect((await stored(lead._id)).pendingFirstAction.leadContactId).toBeUndefined();
});

/* ══ ATTRIBUTION, EXERCISED DIRECTLY ═══════════════════════════════════════
 * These rules used to be unreachable without a Gmail account, a call log and a
 * WhatsApp conversation, which is precisely why two bugs sat in them: a
 * "unique" email match that returned the first address hitting anybody, and a
 * message body read from a field nobody had selected.
 * ═════════════════════════════════════════════════════════════════════════ */

const { parseEmailAddresses, contactByIdentity, contactByEmailAddresses, whatsappBody } =
  require("../../routes/CMS_Routes/Sales/leads").__attribution;

const C = (id, over = {}) => ({ _id: id, name: `Person ${id}`, ...over });
const PEOPLE = [
  C("a", { normalizedEmail: "ramesh@mayfair.com", normalizedPhone: "9876500011" }),
  C("b", { normalizedEmail: "admin@mayfair.com", normalizedPhone: "9800000000" }),
];

test("addresses are parsed out of a real header", () => {
  expect(parseEmailAddresses("Anita Rao <admin@mayfair.com>, ramesh@mayfair.com"))
    .toEqual(["admin@mayfair.com", "ramesh@mayfair.com"]);
  expect(parseEmailAddresses("")).toEqual([]);
});

test("one recipient matching one contact attributes to them", () => {
  const hit = contactByEmailAddresses(PEOPLE, ["ramesh@mayfair.com"], "sales@grav.in");
  expect(hit.leadContactId).toBe("a");
});

test("several addresses belonging to the SAME contact still attribute", () => {
  const people = [C("a", { normalizedEmail: "ramesh@mayfair.com", email: "ramesh@mayfair.com" }), PEOPLE[1]];
  const hit = contactByEmailAddresses(people, ["ramesh@mayfair.com", "ramesh@mayfair.com"], "sales@grav.in");
  expect(hit.leadContactId).toBe("a");
});

test("recipients matching TWO different contacts attribute to neither", () => {
  /* The old rule returned whichever appeared first in the header — a guess
     wearing a uniqueness check. Two people on one thread is a Lead-level
     email, which is what it actually is. */
  expect(contactByEmailAddresses(PEOPLE, ["ramesh@mayfair.com", "admin@mayfair.com"], "sales@grav.in")).toEqual({});
});

test("the salesperson's own address is excluded, leaving one customer", () => {
  const hit = contactByEmailAddresses(PEOPLE, ["sales@grav.in", "ramesh@mayfair.com"], "sales@grav.in");
  expect(hit.leadContactId).toBe("a");
});

test("no matching contact attributes to nobody", () => {
  expect(contactByEmailAddresses(PEOPLE, ["someone@else.com"], "sales@grav.in")).toEqual({});
  expect(contactByEmailAddresses([], ["ramesh@mayfair.com"], null)).toEqual({});
});

test("a shared phone or WhatsApp number is never guessed between", () => {
  const shared = [C("a", { normalizedPhone: "9876500011" }), C("b", { normalizedPhone: "9876500011" })];
  expect(contactByIdentity(shared, { phone: "+91 98765 00011" })).toEqual({});
  // and a unique one still matches, country code and spacing normalised
  expect(contactByIdentity(PEOPLE, { phone: "+91 98765 00011" }).leadContactId).toBe("a");
  expect(contactByIdentity(PEOPLE, { phone: "9800000000" }).leadContactId).toBe("b");
});

test("a WhatsApp message keeps its content", () => {
  /* `text` was read by the description and never selected, so every auto-logged
     WhatsApp lost its body. */
  expect(whatsappBody({ text: "Send the catalogue" })).toBe("Send the catalogue");
  expect(whatsappBody({ type: "image", media: { caption: "Our shirt" } })).toBe("Our shirt");
  expect(whatsappBody({ type: "document" })).toBe("[document]");
  expect(whatsappBody({ type: "text" })).toBe("");
});

/* ══ WHAT AUTO-SYNC DOES WITH ONE EVENT ════════════════════════════════════
 * `matchContacts` is the primitive the whole resolution rests on: how many of
 * THIS Lead's people own an identity. One is attributable, several is
 * ambiguous-but-ours, none falls through to the legacy guard.
 * ═════════════════════════════════════════════════════════════════════════ */

const { matchContacts } = require("../../routes/CMS_Routes/Sales/leads").__attribution;

test("a unique secondary contact is found even when the primary number is duplicated", () => {
  /* The old gate skipped an entire channel when the record's top-level phone
     was shared. A call that belongs uniquely to a SECOND contact has nothing
     to do with that, and was being thrown away with everything else. */
  const people = [
    C("a", { normalizedPhone: "9876500011" }),   // the duplicated primary number
    C("b", { normalizedPhone: "9800000000" }),   // this person's own, unique
  ];
  expect(matchContacts(people, { phone: "+91 98000 00000" }).map((c) => c._id)).toEqual(["b"]);
});

test("two of our own people on one number is ambiguous, not attributable", () => {
  const shared = [C("a", { normalizedPhone: "9876500011" }), C("b", { normalizedPhone: "9876500011" })];
  expect(matchContacts(shared, { phone: "9876500011" })).toHaveLength(2);
  expect(contactByIdentity(shared, { phone: "9876500011" })).toEqual({});
});

test("a WhatsApp number is matched as an identity in its own right", () => {
  const people = [C("a", { normalizedWhatsapp: "9800000000" }), C("b", { normalizedPhone: "9876500011" })];
  expect(matchContacts(people, { phone: "9800000000" }).map((c) => c._id)).toEqual(["a"]);
});

test("no match at all falls through to nobody", () => {
  expect(matchContacts(PEOPLE, { phone: "9711111111" })).toEqual([]);
  expect(matchContacts([], { phone: "9876500011" })).toEqual([]);
});

/* ══ AMBIGUITY IS AN IDENTITY, NOT A PERSON ════════════════════════════════
 * The check returned contact IDS, which is too coarse. A purchase manager with
 * a generic purchasing@ mailbox AND their own direct line had the whole
 * CONTACT marked shared — so their unique phone calls were skipped along with
 * the shared mailbox. One duplicated address should cost you that address, not
 * the person.
 * ═════════════════════════════════════════════════════════════════════════ */

/** The identity keys another Lead shares with this one, as auto-sync computes
 *  them. Exercised through the real route so the scoping and the raw/derived
 *  field handling are the ones that actually run. */
const sharedKeysFor = async (leadId) => {
  const { body } = await call(`/${leadId}/activities/auto-sync`, { method: "POST", body: {} });
  return body;
};

test("a shared email does not suppress a unique phone, and vice versa", async () => {
  /* One contact, two identities: a generic mailbox that another customer also
     uses, and a direct line nobody else has. */
  const mine = await prospect({ company: "Mayfair Lake Resort" });
  await patch(mine._id, {
    contacts: [{ name: "Ramesh Sharma", phone: "9876500011", email: "purchasing@shared.example", isPrimary: true }],
  });
  const other = await prospect({ company: "Other Co" });
  await patch(other._id, {
    contacts: [{ name: "Someone Else", phone: "9711111111", email: "purchasing@shared.example", isPrimary: true }],
  });

  const { ambiguousContactIdentities } = require("../../routes/CMS_Routes/Sales/leads").__attribution;
  const lead = await stored(mine._id);
  const shared = await ambiguousContactIdentities(lead, { user: SALES_USER });

  expect([...shared]).toContain("email:purchasing@shared.example");
  expect([...shared]).not.toContain("phone:9876500011");
});

test("a shared phone does not suppress a unique email", async () => {
  const mine = await prospect({ company: "Mayfair Lake Resort" });
  await patch(mine._id, {
    contacts: [{ name: "Ramesh Sharma", phone: "9876500011", email: "ramesh@mayfair.com", isPrimary: true }],
  });
  const other = await prospect({ company: "Other Co" });
  await patch(other._id, {
    contacts: [{ name: "Someone Else", phone: "+91 98765 00011", email: "someone@other.example", isPrimary: true }],
  });

  const { ambiguousContactIdentities } = require("../../routes/CMS_Routes/Sales/leads").__attribution;
  const shared = await ambiguousContactIdentities(await stored(mine._id), { user: SALES_USER });

  expect([...shared]).toContain("phone:9876500011");         // country code normalised
  expect([...shared]).not.toContain("email:ramesh@mayfair.com");
});

test("a raw WhatsApp number on an unedited record is still detected", async () => {
  /* `normalizedWhatsapp` was added recently, so an existing Lead has none
     until somebody saves it. A safety check that only protects records people
     have edited protects nothing. */
  const mine = await prospect({ company: "Mayfair Lake Resort" });
  await patch(mine._id, { contacts: [{ name: "Ramesh Sharma", whatsapp: "9800000000", isPrimary: true }] });

  const other = await prospect({ company: "Other Co" });
  /* Written straight to the collection, so the derived field never runs —
     exactly the shape of a record captured before this existed. */
  await Lead.collection.updateOne(
    /* The native driver does not cast, and the API hands back a string id. */
    { _id: new mongoose.Types.ObjectId(String(other._id)) },
    { $set: { whatsapp: "+91 98000 00000" }, $unset: { normalizedWhatsapp: "" } },
  );

  const { ambiguousContactIdentities } = require("../../routes/CMS_Routes/Sales/leads").__attribution;
  const shared = await ambiguousContactIdentities(await stored(mine._id), { user: SALES_USER });
  expect([...shared]).toContain("phone:9800000000");
});

test("an identity shared with nobody stays unambiguous", async () => {
  const mine = await prospect({ company: "Mayfair Lake Resort" });
  await patch(mine._id, { contacts: [{ name: "Ramesh Sharma", phone: "9876500011", email: "ramesh@mayfair.com", isPrimary: true }] });
  const { ambiguousContactIdentities } = require("../../routes/CMS_Routes/Sales/leads").__attribution;
  expect([...(await ambiguousContactIdentities(await stored(mine._id), { user: SALES_USER }))]).toEqual([]);
});

/* ══ DUPLICATE REVIEW COVERS EVERY IDENTITY IT CERTIFIES ═══════════════════ */

test("changing WhatsApp or a contact retires an earlier duplicate review", async () => {
  /* The review certifies the identity data it was performed against. WhatsApp
     and the people in contacts[] are identity now — the ambiguity check
     matches on both — so a stamp that never saw them is not a review. */
  const lead = await prospect({ company: "Mayfair Lake Resort" });

  for (const [what, change] of [
    ["whatsapp", { whatsapp: "9800000000" }],
    ["contacts", { contacts: [{ name: "Ramesh Sharma", phone: "9876500011", isPrimary: true }] }],
  ]) {
    await call(`/${lead._id}/review-duplicates`, { method: "POST", body: {} });
    expect((await stored(lead._id)).duplicateReviewedAt).toBeTruthy();

    const r = await patch(lead._id, change);
    expect(r.status).toBe(200);
    expect((await stored(lead._id)).duplicateReviewedAt).toBeUndefined();
  }
});

test("an unrelated edit leaves the review standing", async () => {
  const lead = await prospect({ company: "Mayfair Lake Resort" });
  await call(`/${lead._id}/review-duplicates`, { method: "POST", body: {} });
  await patch(lead._id, { notes: "Spoke at the Delhi show" });
  expect((await stored(lead._id)).duplicateReviewedAt).toBeTruthy();
});
