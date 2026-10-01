// test/crm/prospect-duplicates.route.test.js
//
// DUPLICATE DETECTION THAT SEES EVERY PERSON, NOT JUST THE MIRRORED ONE.
//
// The old check read the Lead's top-level identity — which is the PRIMARY
// contact's mirror. On a Prospect with four people, three were invisible: the
// merchandiser could already exist on another Lead, or as a real Contact under
// a live Account, and nothing said so. The salesperson found out on the call.
//
// What replaces it answers a sentence a person can act on: "Ramesh Sharma's
// phone matches LEAD-2026-0042", not "this record may be a duplicate". So the
// tests below assert the ATTRIBUTION — which of our people, which of theirs,
// and on which identity — not merely that a match was found.
//
// It warns. It never merges, never blocks and never writes.
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
const { findProspectContactDuplicates, findProspectDuplicates } = require("../../services/crmDuplicates");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };

let server, base, CO, CTX;

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
  /* Duplicate detection is company-scoped on purpose: matching across
     companies would answer "is this a duplicate?" by disclosing that ANOTHER
     company has a customer with this number. The context names one company and
     every fixture is stamped with it. */
  CTX = { companyId: CO._id, reason: "duplicate detection test" };
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
const models = () => ({ Lead, Contact, Account });
const find = (lead) => findProspectContactDuplicates(models(), CTX, lead);

/* ══ 1. A NON-PRIMARY CONTACT IS CHECKED TOO ═══════════════════════════════
 * The defect this whole chunk exists for. Ramesh is primary and clean; Anita
 * is second and her number already sits on another Lead. The old check read
 * only the mirror, so Anita was never looked at.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a second contact's phone matching another Lead is found and attributed to her", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Anita Rao", phone: "9876500022", isPrimary: true }] });

  const mine = await prospect();
  await patch(mine._id, {
    contacts: [
      { name: "Ramesh Sharma", phone: "9876500011", isPrimary: true },
      { name: "Anita Rao", phone: "9876500022" },
    ],
  });

  const lead = await Lead.findById(mine._id).lean();
  const hits = await find(lead);

  expect(hits).toHaveLength(1);
  expect(hits[0].recordType).toBe("lead");
  expect(hits[0].recordId).toBe(String(other._id));
  // WHICH of our people — not an anonymous record-level flag.
  expect(hits[0].contactName).toBe("Anita Rao");
  expect(hits[0].matchedOn).toEqual([{ kind: "phone", value: "9876500022" }]);
  expect(hits[0].confidence).toBe("high");
});

/* ══ 2. IT NAMES THEIR PERSON, NOT JUST THEIR RECORD ══════════════════════ */

test("a match against another Lead's embedded contact names that contact", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, {
    contacts: [
      { name: "Sunil Menon", phone: "9000000001", isPrimary: true },
      { name: "Priya Nair", email: "priya@lakeview.com" },
    ],
  });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Priya N", email: "priya@lakeview.com", isPrimary: true }] });

  const hits = await find(await Lead.findById(mine._id).lean());
  expect(hits).toHaveLength(1);
  expect(hits[0].contactName).toBe("Priya N");         // ours
  expect(hits[0].matchedContactName).toBe("Priya Nair"); // theirs
  expect(hits[0].matchedOn[0].kind).toBe("email");
});

/* ══ 3. A PROMOTED CONTACT UNDER A LIVE ACCOUNT ═══════════════════════════
 * The most expensive duplicate: the "prospect" is already a customer.
 *
 * A CRMContact is a person INSIDE an Account, not a record a Prospect can be
 * linked to. So the match is reported as the ACCOUNT, carrying the person as
 * context — anything else produces a result whose id and href disagree about
 * what kind of thing it is.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a CRMContact match is reported as its parent Account, with the person named", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Lakeview Hotels Pvt Ltd", accountId: "ACC-1" });
  const con = await Contact.create({ companyId: CO._id, contactId: "CON-1", firstName: "Priya", lastName: "Nair", accountId: acct._id, mobile: "+91 90000 00007" });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Priya Nair", phone: "9000000007", isPrimary: true }] });

  const hits = await find(await Lead.findById(mine._id).lean());
  expect(hits).toHaveLength(1);
  expect(hits[0].recordType).toBe("account");
  expect(hits[0].recordId).toBe(String(acct._id));       // the Account, not the person
  expect(hits[0].reference).toBe("ACC-1");
  expect(hits[0].recordName).toBe("Lakeview Hotels Pvt Ltd");
  expect(hits[0].matchedContactId).toBe(String(con._id)); // the person, as context
  expect(hits[0].matchedContactName).toBe("Priya Nair");
  expect(hits[0].matchedContactReference).toBe("CON-1");
  expect(hits[0].href).toBe(`/sales/dashboard/accounts/${acct._id}`);
});

/* A person whose Account is gone (or inactive, or another company's) has no
   customer record to link to, so there is nothing actionable to show. */
test("a CRMContact with no reachable Account is not reported", async () => {
  await Contact.create({ companyId: CO._id, contactId: "CON-X", firstName: "Orphan", lastName: "Row", mobile: "9000000008" });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Orphan Row", phone: "9000000008", isPrimary: true }] });
  expect(await find(await Lead.findById(mine._id).lean())).toEqual([]);
});

/* ══ 3b. ONE ACCOUNT, ONE ROW — REACHED TWO WAYS ══════════════════════════
 * The Account's own primary phone AND one of its contacts can both match the
 * same person of ours. That is one customer to check, not two problems.
 * ═════════════════════════════════════════════════════════════════════════ */

test("Account primary-field and CRMContact matches merge into one result", async () => {
  const acct = await Account.create({
    companyId: CO._id, companyName: "Lakeview Hotels Pvt Ltd", accountId: "ACC-5",
    primaryEmail: "buying@lakeview.com",
  });
  const con = await Contact.create({
    companyId: CO._id, contactId: "CON-5", firstName: "Priya", lastName: "Nair",
    accountId: acct._id, mobile: "9000000009",
  });

  const mine = await prospect();
  await patch(mine._id, {
    contacts: [{ name: "Priya Nair", phone: "9000000009", email: "buying@lakeview.com", isPrimary: true }],
  });

  const hits = await find(await Lead.findById(mine._id).lean());
  expect(hits).toHaveLength(1);
  expect(hits[0].recordType).toBe("account");
  expect(hits[0].recordId).toBe(String(acct._id));
  // Both reasons survive the merge...
  expect(hits[0].matchedOn.map((m) => m.kind).sort()).toEqual(["email", "phone"]);
  // ...and so does the person the contact match identified.
  expect(hits[0].matchedContactId).toBe(String(con._id));
  expect(hits[0].matchedContactName).toBe("Priya Nair");
});

/* ══ 4. AN ACCOUNT'S OWN PRIMARY FIELDS ═══════════════════════════════════ */

test("a contact matching an Account's primary email is reported against the Account", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Lakeview Hotels Pvt Ltd", accountId: "ACC-2", primaryEmail: "buying@lakeview.com" });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Buying Desk", email: "buying@lakeview.com", isPrimary: true }] });

  const hits = await find(await Lead.findById(mine._id).lean());
  const account = hits.find((h) => h.recordType === "account");
  expect(account).toBeTruthy();
  expect(account.recordId).toBe(String(acct._id));
  expect(account.confidence).toBe("high");
});

/* ══ 5. THE CURRENT RECORD IS NEVER ITS OWN DUPLICATE ═════════════════════ */

test("a Prospect's own contacts never match itself", async () => {
  const mine = await prospect();
  await patch(mine._id, {
    contacts: [
      { name: "Ramesh Sharma", phone: "9876500011", isPrimary: true },
      { name: "Anita Rao", phone: "9876500022" },
    ],
  });
  expect(await find(await Lead.findById(mine._id).lean())).toEqual([]);
});

/* ══ 6. A PERSON WE ALREADY PROMOTED IS NOT A DUPLICATE OF HERSELF ════════ */

test("a contact already promoted to a CRMContact is not reported against that CRMContact", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Mayfair Lake Resort", accountId: "ACC-3" });
  const con = await Contact.create({ companyId: CO._id, contactId: "CON-2", firstName: "Ramesh", lastName: "Sharma", accountId: acct._id, mobile: "9876500011" });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ramesh Sharma", phone: "9876500011", isPrimary: true }] });

  const lead = await Lead.findById(mine._id).lean();
  expect(await find(lead)).toHaveLength(1); // reported while unlinked

  lead.contacts[0].promotedContactId = con._id;
  expect(await find(lead)).toEqual([]);      // and not once it IS that contact
});

/* ══ 7. INACTIVE AND ARCHIVED RECORDS STAY OUT ════════════════════════════ */

test("inactive Leads and archived Contacts are not offered as duplicates", async () => {
  const dead = await prospect({ company: "Closed Co" });
  await patch(dead._id, { contacts: [{ name: "Ghost", phone: "9111100001", isPrimary: true }] });
  await Lead.updateOne({ _id: dead._id }, { $set: { isActive: false } });

  const acct = await Account.create({ companyId: CO._id, companyName: "Archived Ltd", accountId: "ACC-4" });
  await Contact.create({ companyId: CO._id, contactId: "CON-3", firstName: "Old", lastName: "Row", accountId: acct._id, mobile: "9111100002", archivedAt: new Date() });

  const mine = await prospect();
  await patch(mine._id, {
    contacts: [
      { name: "A", phone: "9111100001", isPrimary: true },
      { name: "B", phone: "9111100002" },
    ],
  });
  expect(await find(await Lead.findById(mine._id).lean())).toEqual([]);
});

/* ══ 8. UNNORMALISED LEGACY NUMBERS ARE STILL SEEN ════════════════════════
 * Records saved before the derived fields existed hold "+91 98765 00033" and
 * nothing else. A plain suffix match fails on the spaces; the fallback is
 * digit-tolerant so those rows are visible without waiting for an edit.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a legacy contact stored with spaces and a country code still matches", async () => {
  const other = await prospect({ company: "Legacy Co" });
  // Write past the model so no pre-save hook derives the normalised fields.
  await Lead.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(other._id)) },
    { $set: { contacts: [{ _id: new mongoose.Types.ObjectId(), name: "Old Row", phone: "+91 98765 00033" }] } },
  );

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Same Person", phone: "9876500033", isPrimary: true }] });

  const hits = await find(await Lead.findById(mine._id).lean());
  expect(hits.map((h) => h.recordId)).toContain(String(other._id));
});

/* ══ 9. ONE ROW PER PERSON, WITH EVERY REASON ═════════════════════════════ */

test("a contact matching on both phone and email is one result carrying both reasons", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Dual", phone: "9222200001", email: "dual@lakeview.com", isPrimary: true }] });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Dual Match", phone: "9222200001", email: "dual@lakeview.com", isPrimary: true }] });

  const hits = await find(await Lead.findById(mine._id).lean());
  expect(hits).toHaveLength(1);
  expect(hits[0].matchedOn.map((m) => m.kind).sort()).toEqual(["email", "phone"]);
});

/* ══ 10. A NAME ALONE IS NOT A DUPLICATE ══════════════════════════════════
 * Two people called Ramesh Sharma is a Tuesday, not a warning. Crying wolf
 * teaches people to click past the alert that matters.
 * ═════════════════════════════════════════════════════════════════════════ */

test("identical contact names with no shared identity raise nothing", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Ramesh Sharma", phone: "9333300001", isPrimary: true }] });

  const mine = await prospect({ company: "Sunrise Textiles" });
  await patch(mine._id, { contacts: [{ name: "Ramesh Sharma", phone: "9333300002", isPrimary: true }] });

  expect(await find(await Lead.findById(mine._id).lean())).toEqual([]);
});

/* ══ 11. THE QUERY COUNT DOES NOT GROW WITH THE CONTACT COUNT ═════════════
 * Eight people must not cost twenty-four round trips to render a warning.
 * ═════════════════════════════════════════════════════════════════════════ */

test("eight contacts still cost one query per collection", async () => {
  const mine = await prospect();
  await patch(mine._id, {
    contacts: Array.from({ length: 8 }, (_, i) => ({
      name: `Person ${i}`, phone: `94444000${i}${i}`, email: `p${i}@mayfair.com`, isPrimary: i === 0,
    })),
  });

  const spies = [Lead, Contact, Account].map((m) => jest.spyOn(m, "find"));
  await find(await Lead.findById(mine._id).lean());
  for (const spy of spies) {
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  }
});

/* ══ 12. THE UNIFIED CONTRACT CARRIES RECORD-LEVEL AND PER-CONTACT ════════
 * A company-name match belongs to the organisation and no individual, so it
 * arrives with `contactId: null`. That is a meaningful value, not a gap.
 * ═════════════════════════════════════════════════════════════════════════ */

test("findProspectDuplicates returns company matches and contact matches in one shape", async () => {
  const other = await prospect({ company: "Mayfair Lake Resort" }); // same company name
  await patch(other._id, { contacts: [{ name: "Their Person", phone: "9555500001", isPrimary: true }] });

  const mine = await prospect({ company: "Mayfair Lake Resort" });
  await patch(mine._id, { contacts: [{ name: "Our Person", phone: "9555500001", isPrimary: true }] });

  const { matches, hasMatches, hasStrong, leadMatches } = await findProspectDuplicates(
    models(), CTX, await Lead.findById(mine._id).lean(),
  );
  expect(hasMatches).toBe(true);
  expect(hasStrong).toBe(true);
  expect(Array.isArray(leadMatches)).toBe(true); // legacy shape preserved for existing callers

  for (const m of matches) {
    expect(m).toHaveProperty("recordType");
    expect(m).toHaveProperty("recordId");
    expect(m).toHaveProperty("matchedOn");
    expect(m).toHaveProperty("confidence");
    expect(m).toHaveProperty("href");
  }
  // The strongest reason sorts first, and the person-level row names a person.
  expect(matches[0].confidence).toBe("high");
  expect(matches.some((m) => m.contactId && m.contactName === "Our Person")).toBe(true);
});

/* ══ 13. UNSAVED CAPTURE ROWS ARE CHECKED BEFORE THEY EXIST ═══════════════
 * The most valuable moment to warn is before the duplicate is created.
 * ═════════════════════════════════════════════════════════════════════════ */

test("POST /duplicate-check matches contacts that have no _id yet", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Existing", phone: "9666600001", isPrimary: true }] });

  const { status, body } = await call("/duplicate-check", {
    method: "POST",
    body: { company: "Brand New Co", contacts: [{ name: "Typed Just Now", phone: "9666600001" }] },
  });
  expect(status).toBe(200);
  expect(body.hasMatches).toBe(true);
  expect(body.matches[0].contactName).toBe("Typed Just Now");
  expect(body.matches[0].contactId).toBeNull();  // nothing saved
  expect(body.matches[0].recordId).toBe(String(other._id));
});

/* ══ 14. WARN, NEVER ACT ══════════════════════════════════════════════════
 * Detection is read-shaped: no merge, no overwrite, no CRMContact created for
 * an unconverted Prospect, and the record is byte-identical afterwards.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a duplicate check writes nothing anywhere", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Existing", phone: "9777700001", isPrimary: true }] });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ours", phone: "9777700001", isPrimary: true }] });

  const before = await Lead.findById(mine._id).lean();
  const contactsBefore = await Contact.countDocuments({});

  await call(`/${mine._id}/readiness`);
  await findProspectDuplicates(models(), CTX, before);

  const after = await Lead.findById(mine._id).lean();
  expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  expect(await Contact.countDocuments({})).toBe(contactsBefore);
});

/* ══ 15. THE REVIEW STAMP RETIRES WHEN A CONTACT CHANGES ══════════════════
 * A review certifies the identity data it was performed against. Adding a
 * person the review never saw must not inherit its green tick.
 * ═════════════════════════════════════════════════════════════════════════ */

test("adding a contact clears an existing duplicate review stamp", async () => {
  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ramesh", phone: "9888800001", isPrimary: true }] });
  await Lead.updateOne({ _id: mine._id }, { $set: { duplicateReviewedAt: new Date() } });
  expect((await Lead.findById(mine._id).lean()).duplicateReviewedAt).toBeTruthy();

  await patch(mine._id, {
    contacts: [
      { name: "Ramesh", phone: "9888800001", isPrimary: true },
      { name: "Anita", phone: "9888800002" },
    ],
  });
  expect((await Lead.findById(mine._id).lean()).duplicateReviewedAt).toBeFalsy();
});

/* ══ 16. ANOTHER COMPANY'S CUSTOMERS ARE NEVER THE ANSWER ═════════════════
 * The disclosure risk in duplicate detection is subtler than the feature:
 * answering "is this a duplicate?" across a company boundary reveals that
 * ANOTHER company holds a customer with this number — the answer IS the leak.
 * The identity below exists under a different company and must stay invisible.
 * ═════════════════════════════════════════════════════════════════════════ */

test("an identical phone under a different company is never reported", async () => {
  /* Our Prospect is captured first, while one company exists — a second
     company makes the route's own scope resolution ambiguous, which is a
     different guard and not what this test is about. */
  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ours", phone: "9999900001", isPrimary: true }] });

  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const rival = await Acc_Company.create({ companyName: "Rival Co", booksFromDate: new Date("2026-04-01") });

  const theirAcct = await Account.create({ companyId: rival._id, companyName: "Rival's Customer", accountId: "ACC-9" });
  await Contact.create({ companyId: rival._id, contactId: "CON-9", firstName: "Shared", lastName: "Number", accountId: theirAcct._id, mobile: "9999900001" });
  await Lead.create({
    companyId: rival._id, leadId: "LEAD-RIVAL-1", company: "Rival Lead", isActive: true,
    contacts: [{ name: "Shared Number", phone: "9999900001", isPrimary: true }],
  });

  const lead = await Lead.findById(mine._id).lean();
  expect(await find(lead)).toEqual([]);
  const { matches } = await findProspectDuplicates(models(), CTX, lead);
  expect(matches).toEqual([]);
});

/* ══ 17. THE ROUTE IS THE SERVER'S TO DECIDE ══════════════════════════════
 * Every consumer used to rebuild the destination from `recordType` + id, and
 * each of them got a case wrong: a CRMContact match opened /leads/<contactId>,
 * and a Prospect opened the Lead route. The server knows what the record IS,
 * so it computes the destination once and the UI navigates to it.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a draft Prospect match routes to the Prospect screen, an active Lead to the Lead screen", async () => {
  const draft = await prospect({ company: "Still A Draft" });
  await patch(draft._id, { contacts: [{ name: "D", phone: "9101010101", isPrimary: true }] });

  const active = await prospect({ company: "Now A Lead" });
  await patch(active._id, { contacts: [{ name: "A", phone: "9202020202", isPrimary: true }] });
  await Lead.updateOne({ _id: active._id }, { $set: { captureStatus: "active" } });

  const mine = await prospect();
  await patch(mine._id, {
    contacts: [
      { name: "Ours One", phone: "9101010101", isPrimary: true },
      { name: "Ours Two", phone: "9202020202" },
    ],
  });

  const hits = await find(await Lead.findById(mine._id).lean());
  const toDraft = hits.find((h) => h.recordId === String(draft._id));
  const toActive = hits.find((h) => h.recordId === String(active._id));
  expect(toDraft.href).toBe(`/sales/dashboard/prospects/${draft._id}`);
  expect(toActive.href).toBe(`/sales/dashboard/leads/${active._id}`);
});

test("a CRMContact-derived match routes to its Account, never to the person", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Lakeview Hotels Pvt Ltd", accountId: "ACC-6" });
  const con = await Contact.create({ companyId: CO._id, contactId: "CON-6", firstName: "Priya", lastName: "Nair", accountId: acct._id, mobile: "9303030303" });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Priya Nair", phone: "9303030303", isPrimary: true }] });

  const [hit] = await find(await Lead.findById(mine._id).lean());
  expect(hit.href).toBe(`/sales/dashboard/accounts/${acct._id}`);
  expect(hit.href).not.toContain(String(con._id));
  expect(hit.recordId).not.toBe(String(con._id));
});

/* ══ 18. THE WARNING DOES NOT HAND OUT A CONTACT LIST ═════════════════════
 * "phone matches Lakeview Hotels" needs the KIND, not the number. A duplicate
 * check is reachable for any Prospect and would otherwise return identities
 * belonging to records the caller may not be entitled to read in full.
 * ═════════════════════════════════════════════════════════════════════════ */

test("public results carry the reason and a masked tail, never the raw identity", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Theirs", phone: "9404040404", email: "buyer@lakeview.com", isPrimary: true }] });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ours", phone: "9404040404", email: "buyer@lakeview.com", isPrimary: true }] });

  const { matches } = await findProspectDuplicates(models(), CTX, await Lead.findById(mine._id).lean());
  const payload = JSON.stringify(matches);
  expect(payload).not.toContain("9404040404");
  expect(payload).not.toContain("buyer@lakeview.com");

  /* What it DOES carry is still enough to act on. Read the PERSON-level row —
     the record-level company/domain check contributes its own row, which is a
     different reason about the same organisation. */
  const person = matches.find((m) => m.contactName === "Ours");
  const reasons = person.matchedOn;
  expect(reasons.map((r) => r.kind).sort()).toEqual(["email", "phone"]);
  expect(reasons.every((r) => r.label)).toBe(true);
  expect(reasons.find((r) => r.kind === "phone").masked).toBe("…0404");
  expect(reasons.find((r) => r.kind === "email").masked).toBe("b…@lakeview.com");
  expect(matches.every((m) => ["high", "medium"].includes(m.confidence))).toBe(true);
});

test("the route's duplicate-check response leaks no raw identity either", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Theirs", phone: "9505050505", isPrimary: true }] });

  const { body } = await call("/duplicate-check", {
    method: "POST",
    body: { company: "Brand New Co", contacts: [{ name: "Typed", phone: "9505050505" }] },
  });
  expect(body.hasMatches).toBe(true);
  expect(JSON.stringify(body.matches)).not.toContain("9505050505");
});

/* ══ 19. A CONTACT-ONLY MATCH IS STILL A MATCH TO COUNT ═══════════════════
 * Quick Capture's headline used to be computed from the legacy arrays, which a
 * contact-only match never populates. The result was a panel saying "Found 0
 * possible matches" directly above one. The unified collection is the thing
 * both the count and the rows come from, so they cannot disagree.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a Quick Capture match found only through a secondary contact still counts as one", async () => {
  const other = await prospect({ company: "Nothing Alike Ltd" });
  await patch(other._id, {
    contacts: [
      { name: "Their Primary", phone: "9606060601", isPrimary: true },
      { name: "Their Second", phone: "9606060602" },
    ],
  });

  const { body } = await call("/duplicate-check", {
    method: "POST",
    body: {
      company: "Totally Different Name",     // nothing the legacy check can see
      contacts: [{ name: "Typed Just Now", phone: "9606060602" }],
    },
  });

  expect(body.hasMatches).toBe(true);
  // The legacy arrays are empty — this is precisely the case that showed "0".
  expect(body.leadMatches).toEqual([]);
  expect(body.accountMatches).toEqual([]);
  // The unified collection has the one row the panel renders.
  expect(body.matches).toHaveLength(1);
  expect(body.matches[0].contactName).toBe("Typed Just Now");
  expect(body.matches[0].matchedContactName).toBe("Their Second");
});

/* ══ 20. THE RECORD-LEVEL PATH ROUTES LIKE THE PERSON-LEVEL ONE ═══════════
 * A company-name match carries no contact identity, so it never reaches the
 * contact-aware finder — it comes through `findLeadDuplicates`, which was
 * hardcoding the Lead route. A Prospect matched by name alone therefore opened
 * a Lead screen for a record that is still in capture. Nothing else covered
 * this path, because every other test matches on a person.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a company-name-only match routes to the Prospect screen while it is a draft", async () => {
  const other = await prospect({ company: "Mayfair Lake Resort" }); // no contacts at all

  const mine = await prospect({ company: "Mayfair Lake Resort" });
  const { matches } = await findProspectDuplicates(models(), CTX, await Lead.findById(mine._id).lean());

  const hit = matches.find((m) => m.recordId === String(other._id));
  expect(hit).toBeTruthy();
  expect(hit.contactId).toBeNull();                                  // record-level
  expect(hit.matchedOn.map((r) => r.kind)).toContain("company");
  expect(hit.href).toBe(`/sales/dashboard/prospects/${other._id}`);
});

test("the same match routes to the Lead screen once that record is an Active Lead", async () => {
  const other = await prospect({ company: "Mayfair Lake Resort" });
  await Lead.updateOne({ _id: other._id }, { $set: { captureStatus: "active" } });

  const mine = await prospect({ company: "Mayfair Lake Resort" });
  const { matches } = await findProspectDuplicates(models(), CTX, await Lead.findById(mine._id).lean());

  const hit = matches.find((m) => m.recordId === String(other._id));
  expect(hit.href).toBe(`/sales/dashboard/leads/${other._id}`);
});

/* ══ 21. A REASON NAMES THE FIELD IT CAME FROM ════════════════════════════
 * Every number used to be checked against both channels and reported under
 * whichever of OUR fields held it, so an Account's primaryPhone could be
 * reported as a WhatsApp match — a claim the Account record cannot support.
 * The numbers below differ per channel, so a mislabelled reason is visible.
 * ═════════════════════════════════════════════════════════════════════════ */

test("an Account's primary phone is reported as a phone match, never WhatsApp", async () => {
  await Account.create({
    companyId: CO._id, companyName: "Lakeview Hotels Pvt Ltd", accountId: "ACC-P",
    primaryPhone: "9700000001",
  });

  const mine = await prospect();
  // Ours is held as a WhatsApp number; theirs is a plain phone field.
  await patch(mine._id, { contacts: [{ name: "Ours", whatsapp: "9700000001", phone: "9700000099", isPrimary: true }] });

  const [hit] = await find(await Lead.findById(mine._id).lean());
  expect(hit.recordType).toBe("account");
  expect(hit.matchedOn.map((m) => m.kind)).toEqual(["phone"]);
});

test("a CRMContact's WhatsApp is reported as a WhatsApp match, never phone", async () => {
  const acct = await Account.create({ companyId: CO._id, companyName: "Lakeview Hotels Pvt Ltd", accountId: "ACC-W" });
  await Contact.create({
    companyId: CO._id, contactId: "CON-W", firstName: "Priya", lastName: "Nair", accountId: acct._id,
    whatsapp: "9700000002", mobile: "9700000003",
  });

  const mine = await prospect();
  // Only their WhatsApp number is one of ours, and we hold it as a phone.
  await patch(mine._id, { contacts: [{ name: "Ours", phone: "9700000002", isPrimary: true }] });

  const [hit] = await find(await Lead.findById(mine._id).lean());
  expect(hit.matchedOn.map((m) => m.kind)).toEqual(["whatsapp"]);
});

test("another Lead's WhatsApp is not reported as a phone match", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Theirs", phone: "9700000004", whatsapp: "9700000005", isPrimary: true }] });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ours", phone: "9700000005", isPrimary: true }] });

  const [hit] = await find(await Lead.findById(mine._id).lean());
  expect(hit.matchedOn.map((m) => m.kind)).toEqual(["whatsapp"]);
});

test("both reasons appear only when both of their fields hold the number", async () => {
  const other = await prospect({ company: "Lakeview Hotels" });
  await patch(other._id, { contacts: [{ name: "Theirs", phone: "9700000006", whatsapp: "9700000006", isPrimary: true }] });

  const mine = await prospect();
  await patch(mine._id, { contacts: [{ name: "Ours", phone: "9700000006", isPrimary: true }] });

  const [hit] = await find(await Lead.findById(mine._id).lean());
  expect(hit.matchedOn.map((m) => m.kind).sort()).toEqual(["phone", "whatsapp"]);
});
