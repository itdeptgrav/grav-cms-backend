// test/crm/prospect-contacts.route.test.js
//
// THE PEOPLE ON A PROSPECT — the data contract, and what it promises records
// captured before it existed.
//
// A B2B garment buyer is rarely one person: a merchandiser, a purchase
// manager, an admin head and whoever signs are four people from the first call
// onwards. `contacts[]` is where they live, and once a Prospect has one, the
// PRIMARY contact is the authority for every person-specific value.
//
// The Lead's own `firstName`/`lastName`/`designation`/`email`/`phone`/
// `whatsapp` and its four communication-preference fields become COMPATIBILITY
// MIRRORS — written FROM the primary, never back into it. Duplicate detection,
// identityFor, call and WhatsApp matching, the readiness gate and every card
// read those fields; mirroring keeps all of it working, and one direction of
// authority is what stops the two disagreeing.
//
// Records with no `contacts[]` are read exactly as they always were, and a GET
// never writes.
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
const DepartmentRole = require("../../models/Access/DepartmentRole");
require("../../models/SalesDepartment");
const { _resetSequence } = require("../../services/leadRef");
const { hasContactRoute } = require("../../services/leadReadiness");

const SALES_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales", email: "anita@example.com" };

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

const RAMESH = { name: "Ramesh Sharma", jobTitle: "Purchase Manager", roleCode: "procurement", phone: "+91 98765 00011", email: "R@Mayfair.com", preferredChannel: "phone" };
const ANITA = { name: "Anita Rao", jobTitle: "Admin Head", roleCode: "hr_admin", email: "admin@mayfair.com" };

/* ══ A LEGACY PROSPECT IS UNTOUCHED ════════════════════════════════════════
 * The whole compatibility promise in one place: a record with only top-level
 * person fields keeps them, reads normally, and is never rewritten by being
 * looked at.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a Prospect with only top-level contact fields reads exactly as before", async () => {
  const lead = await prospect({ firstName: "Sunil", lastName: "Menon", designation: "Owner", phone: "9811111111", email: "sunil@old.example" });
  const r = await call(`/${lead._id}`);
  expect(r.status).toBe(200);
  expect(r.body.lead.firstName).toBe("Sunil");
  expect(r.body.lead.designation).toBe("Owner");
  expect(r.body.lead.phone).toBe("9811111111");
  expect(r.body.lead.contacts).toBeUndefined();
});

test("reading a Prospect never writes to it", async () => {
  /* A GET that quietly materialised a contact would rewrite history on every
     page load, under whoever happened to open the page. */
  const lead = await prospect({ firstName: "Sunil", phone: "9811111111" });
  const before = await stored(lead._id);

  await call(`/${lead._id}`);
  await call(`/${lead._id}/readiness`);
  await call("/?captureStatus=draft&limit=50");

  const after = await stored(lead._id);
  expect(after.contacts).toBeUndefined();
  expect(new Date(after.updatedAt).toISOString()).toBe(new Date(before.updatedAt).toISOString());
});

test("materialising the first contact does not disturb anything else", async () => {
  const lead = await prospect({ firstName: "Sunil", lastName: "Menon", designation: "Owner", phone: "9811111111", source: "referral" });
  const r = await patch(lead._id, { contacts: [{ name: "Sunil Menon", jobTitle: "Owner", phone: "9811111111" }] });
  expect(r.status).toBe(200);

  const after = await stored(lead._id);
  expect(after.contacts).toHaveLength(1);
  expect(after.contacts[0].isPrimary).toBe(true);
  expect(after.source).toBe("referral");        // untouched
  expect(after.company).toBe("Mayfair Lake Resort");
});

/* ══ EMBEDDED CONTACTS HAVE STABLE IDENTITY ═══════════════════════════════
 * The first version dropped every `_id` and handed Mongoose a fresh array, so
 * each save minted new ids for the same people. A future
 * `Activity.leadContactId` would dangle, a `promotedContactId` would detach
 * from its person, and per-contact history would reset — an ordinary rename
 * made all four contacts look newly created.
 * ═════════════════════════════════════════════════════════════════════════ */

const idsOf = async (id) => (await stored(id)).contacts.map((c) => String(c._id));
const withIds = async (id) => (await stored(id)).contacts.map((c) => ({ _id: String(c._id), name: c.name, isPrimary: c.isPrimary }));

test("editing a contact preserves its id", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });
  const before = await idsOf(lead._id);

  const rows = await withIds(lead._id);
  const r = await patch(lead._id, { contacts: [{ ...rows[0], name: "Ramesh K Sharma", jobTitle: "Head of Purchasing" }, rows[1]] });
  expect(r.status).toBe(200);

  expect(await idsOf(lead._id)).toEqual(before);
  expect((await stored(lead._id)).contacts[0].name).toBe("Ramesh K Sharma");
});

test("reordering contacts preserves every id", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });
  const rows = await withIds(lead._id);

  await patch(lead._id, { contacts: [rows[1], rows[0]] });
  const after = await stored(lead._id);
  expect(after.contacts.map((c) => String(c._id))).toEqual([rows[1]._id, rows[0]._id]);
  // and the primary did not move with the order
  expect(after.contacts.find((c) => c.isPrimary).name).toBe("Ramesh Sharma");
});

test("adding a contact mints exactly one new id", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });
  const rows = await withIds(lead._id);

  await patch(lead._id, { contacts: [rows[0], ANITA] });
  const after = await idsOf(lead._id);
  expect(after).toHaveLength(2);
  expect(after[0]).toBe(rows[0]._id);
  expect(after[1]).not.toBe(rows[0]._id);
});

test("removing one contact leaves the others' ids alone", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA, { name: "Third Person" }] });
  const rows = await withIds(lead._id);

  await patch(lead._id, { contacts: [rows[0], rows[2]] });
  expect(await idsOf(lead._id)).toEqual([rows[0]._id, rows[2]._id]);
});

test("a contact id from another Prospect is refused, not quietly re-minted", async () => {
  const mine = await prospect();
  const theirs = await prospect({ company: "Other Co" });
  await patch(theirs._id, { contacts: [{ name: "Someone Else" }] });
  const foreign = (await idsOf(theirs._id))[0];

  const r = await patch(mine._id, { contacts: [{ _id: foreign, name: "Stolen" }] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/not on this Prospect/i);
  expect((await stored(mine._id)).contacts).toBeUndefined();
});

test("an id that belongs to nobody is refused", async () => {
  const lead = await prospect();
  const r = await patch(lead._id, { contacts: [{ _id: new mongoose.Types.ObjectId().toString(), name: "Ghost" }] });
  expect(r.status).toBe(400);
});

test("the same contact cannot be listed twice", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });
  const rows = await withIds(lead._id);
  const r = await patch(lead._id, { contacts: [rows[0], { ...rows[0], name: "Clone" }] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/listed twice/i);
});

test("a server-set promotedContactId survives an edit", async () => {
  /* It links this person to the CRMContact they became. Losing it on a rename
     detaches the two silently, and a later promotion would double-create. */
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });
  const [cid] = await idsOf(lead._id);
  const promoted = new mongoose.Types.ObjectId();
  await Lead.updateOne({ _id: lead._id, "contacts._id": cid }, { $set: { "contacts.$.promotedContactId": promoted } });

  await patch(lead._id, { contacts: [{ _id: cid, name: "Ramesh K Sharma", isPrimary: true }] });
  const after = (await stored(lead._id)).contacts[0];
  expect(String(after.promotedContactId)).toBe(String(promoted));
  expect(after.name).toBe("Ramesh K Sharma");
});

/* ══ THE PRIMARY IS THE AUTHORITY ══/* ══ THE PRIMARY IS THE AUTHORITY ══════════════════════════════════════════ */

test("the primary contact's data is mirrored onto the legacy fields", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });

  const after = await stored(lead._id);
  expect(after.firstName).toBe("Ramesh");
  expect(after.lastName).toBe("Sharma");
  expect(after.designation).toBe("Purchase Manager");
  expect(after.email).toBe("r@mayfair.com");
  expect(after.phone).toBe("+91 98765 00011");
  /* The contact carries the CRM's own PREFERRED_CHANNELS ("phone"); the Lead's
     legacy field is an older, different set ("call"). The mirror translates —
     writing one onto the other unmapped fails the enum and loses the whole
     save. */
  expect(after.preferredContactMethod).toBe("call");
});

test("switching the primary refreshes every mirror", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });
  await patch(lead._id, { contacts: [RAMESH, { ...ANITA, isPrimary: true }] });

  const after = await stored(lead._id);
  expect(after.firstName).toBe("Anita");
  expect(after.lastName).toBe("Rao");
  expect(after.designation).toBe("Admin Head");
  expect(after.email).toBe("admin@mayfair.com");
  expect(after.phone).toBe("");                       // Anita has none — the mirror says so
  expect(after.preferredContactMethod).toBeUndefined();
});

test("the sync is one-directional — editing a legacy field does not rewrite the contact", async () => {
  /* Two authorities agree until the first conflicting edit, then disagree
     forever. The contact wins; the legacy field is its shadow. */
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });

  await patch(lead._id, { firstName: "Someone", phone: "9000000000" });
  const after = await stored(lead._id);
  expect(after.contacts[0].name).toBe("Ramesh Sharma");
  expect(after.contacts[0].phone).toBe("+91 98765 00011");
  // the legacy write landed, and the next contact save will overwrite it
  expect(after.firstName).toBe("Someone");
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });
  expect((await stored(lead._id)).firstName).toBe("Ramesh");
});

/* ══ EXACTLY ONE PRIMARY, ENFORCED AT THE MODEL ════════════════════════════ */

/* ── AMBIGUITY IS REFUSED, NOT REPAIRED ───────────────────────────────────
   The first version settled a malformed list: several primaries became "the
   last one wins", none became "the first active". Both are guesses. The
   server cannot know which contact somebody just clicked, and choosing by
   array order means a reorder silently moves the primary. */

test("two primaries are rejected, and nothing is stored", async () => {
  const lead = await prospect();
  const r = await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, { ...ANITA, isPrimary: true }] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/only one contact can be the primary/i);
  expect((await stored(lead._id)).contacts).toBeUndefined();
});

test("several active contacts with no primary are rejected", async () => {
  const lead = await prospect();
  const r = await patch(lead._id, { contacts: [RAMESH, ANITA] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/mark which/i);
  expect((await stored(lead._id)).contacts).toBeUndefined();
});

test("one active contact with no primary becomes primary — the only safe inference", async () => {
  const lead = await prospect();
  const r = await patch(lead._id, { contacts: [RAMESH] });
  expect(r.status).toBe(200);
  expect((await stored(lead._id)).contacts[0].isPrimary).toBe(true);
});

test("a non-active contact cannot be primary", async () => {
  const lead = await prospect();
  const r = await patch(lead._id, {
    contacts: [{ ...RAMESH, isPrimary: true, status: "left_organization" }, ANITA],
  });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/must be active/i);
  expect((await stored(lead._id)).contacts).toBeUndefined();
});

test("deactivating the primary without naming a replacement is rejected", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });
  const rows = await withIds(lead._id);

  const r = await patch(lead._id, { contacts: [{ ...rows[0], status: "do_not_contact" }, rows[1]] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/mark which contact is now the primary/i);
  // the record is untouched — the old primary is still primary and still active
  const after = await stored(lead._id);
  expect(after.contacts.find((c) => c.isPrimary).name).toBe("Ramesh Sharma");
  expect(after.contacts[0].status).toBe("active");
});

test("removing the primary without naming a replacement is rejected", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });
  const rows = await withIds(lead._id);

  const r = await patch(lead._id, { contacts: [rows[1]] });
  expect(r.status).toBe(400);
  expect((await stored(lead._id)).contacts).toHaveLength(2);
});

test("naming the replacement is accepted, and the mirrors follow it", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] });
  const rows = await withIds(lead._id);

  const r = await patch(lead._id, { contacts: [{ ...rows[0], status: "left_organization", isPrimary: false }, { ...rows[1], isPrimary: true }] });
  expect(r.status).toBe(200);
  const after = await stored(lead._id);
  expect(after.contacts.find((c) => c.isPrimary).name).toBe("Anita Rao");
  expect(after.firstName).toBe("Anita");
});

test("a Prospect whose contacts are all inactive may have no primary", async () => {
  /* Valid during early work; it simply cannot convert. */
  const lead = await prospect();
  const r = await patch(lead._id, { contacts: [{ ...RAMESH, status: "left_organization" }] });
  expect(r.status).toBe(200);
  expect((await stored(lead._id)).contacts.filter((c) => c.isPrimary)).toHaveLength(0);
});

test("a Prospect with no contacts at all is valid", async () => {
  const lead = await prospect();
  expect((await stored(lead._id)).contacts).toBeUndefined();
  expect((await call(`/${lead._id}/readiness`)).status).toBe(200);
});

/* ══ AN INDIVIDUAL PROSPECT IS THE PERSON ══════════════════════════════════ */

test("an Individual Prospect takes exactly one contact, automatically primary", async () => {
  const lead = await prospect({ prospectType: "individual", company: "", firstName: "Ravi" });
  const r = await patch(lead._id, { contacts: [{ name: "Ravi Kumar", phone: "9800000000" }] });
  expect(r.status).toBe(200);
  const after = await stored(lead._id);
  expect(after.contacts).toHaveLength(1);
  expect(after.contacts[0].isPrimary).toBe(true);
  expect(after.firstName).toBe("Ravi");
});

test("an Individual given several contacts is rejected — nothing demoted, nothing deleted", async () => {
  const lead = await prospect({ prospectType: "individual", company: "", firstName: "Ravi" });
  await patch(lead._id, { contacts: [{ name: "Ravi Kumar" }] });

  const r = await patch(lead._id, { contacts: [{ name: "Ravi Kumar" }, { name: "Somebody Else" }] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/change its type to Organisation/i);
  expect((await stored(lead._id)).contacts).toHaveLength(1);
});

test("prospectType is the authority — a company name does not override it", async () => {
  /* An earlier version inferred the type from the presence of a company name,
     so an explicitly Individual Prospect with an employer on file was treated
     as an Organisation, overriding a choice the user actually made. */
  const lead = await prospect({ prospectType: "individual", company: "Their Employer Ltd" });
  expect((await stored(lead._id)).prospectType).toBe("individual");

  const r = await patch(lead._id, { contacts: [RAMESH, ANITA] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/Individual Prospect can have only one contact/i);
});

test("a legacy record defaulted to Individual is changed to Organisation first", async () => {
  /* `prospectType` DEFAULTS to "individual", so a Prospect captured before
     anybody chose a type carries that label. The fix is an explicit, visible
     type change — not a silent override that ignores the stored choice
     forever. */
  const lead = await prospect({ prospectType: undefined, company: "Zenith Apparel" });
  expect((await stored(lead._id)).prospectType).toBe("individual");

  expect((await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA] })).status).toBe(400);

  await patch(lead._id, { prospectType: "company" });
  const r = await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }, ANITA, { name: "Third Person" }] });
  expect(r.status).toBe(200);
  expect((await stored(lead._id)).contacts).toHaveLength(3);
});

/* ══ CODES, CLEARING, AND WHAT A CLIENT MAY NOT SEND ═══════════════════════ */

test("the existing role vocabulary is canonical, and prose is not reinterpreted", async () => {
  const lead = await prospect();
  await patch(lead._id, {
    contacts: [{ name: "Ramesh Sharma", roleCode: "merchandiser", role: "buyer for the north region", isDecisionMaker: true }],
  });
  const c = (await stored(lead._id)).contacts[0];
  expect(c.roleCode).toBe("merchandiser");
  expect(c.role).toBe("buyer for the north region");   // kept verbatim, never guessed into a code
  expect(c.isDecisionMaker).toBe(true);
});

test("an invalid role, status or channel code is refused, not silently dropped", async () => {
  const lead = await prospect();
  for (const bad of [{ roleCode: "influencer" }, { status: "maybe" }, { preferredChannel: "carrier_pigeon" }, { bestContactTime: "midnight" }]) {
    const r = await patch(lead._id, { contacts: [{ name: "Ramesh Sharma", ...bad }] });
    expect(r.status).toBe(400);
  }
  expect((await stored(lead._id)).contacts).toBeUndefined();
});

test("optional contact values clear", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, department: "Purchasing", notes: "Prefers mornings" }] });
  const [cid] = await idsOf(lead._id);
  expect((await stored(lead._id)).contacts[0].department).toBe("Purchasing");

  await patch(lead._id, { contacts: [{ _id: cid, name: "Ramesh Sharma", isPrimary: true, department: "", notes: "", roleCode: "", preferredChannel: "" }] });
  const c = (await stored(lead._id)).contacts[0];
  expect(String(c._id)).toBe(cid);
  for (const k of ["department", "notes", "roleCode", "preferredChannel", "jobTitle"]) expect(c[k]).toBeUndefined();
});

test("an explicit empty list is still how contacts are removed", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });
  const r = await patch(lead._id, { contacts: [] });
  expect(r.status).toBe(200);
  expect((await stored(lead._id)).contacts).toEqual([]);
});

test("normalised identity is derived, never accepted from the client", async () => {
  const lead = await prospect();
  await patch(lead._id, {
    contacts: [{
      name: "Ramesh Sharma", phone: "+91 98765 00011", email: "R@Mayfair.com", whatsapp: "098765 00011",
      normalizedPhone: "0000000000", normalizedEmail: "spoof@example.com", promotedContactId: new mongoose.Types.ObjectId().toString(),
    }],
  });
  const c = (await stored(lead._id)).contacts[0];
  expect(c.normalizedPhone).toBe("919876500011");
  expect(c.normalizedEmail).toBe("r@mayfair.com");
  expect(c.normalizedWhatsapp).toBe("09876500011");
  expect(c.promotedContactId).toBeUndefined();       // set at promotion, not by a client
});

/* ══ MALFORMED INPUT IS REFUSED, NEVER ABSORBED ═══════════════════════════
 * A non-array used to become `[]`, which DELETED every contact and returned
 * 200. An oversized list was sliced. A row with no name vanished. Same
 * principle as `productInterests`: silent data loss with a success response is
 * the worst of both — nothing to notice, nothing to retry.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a non-array is refused and does not erase the saved contacts", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });

  for (const bad of ["Ramesh", 42, { 0: RAMESH }, true]) {
    const r = await patch(lead._id, { contacts: bad });
    expect(r.status).toBe(400);
    expect((await stored(lead._id)).contacts).toHaveLength(1);
  }
});

test("an oversized list is refused, not silently sliced", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });
  const r = await patch(lead._id, { contacts: Array.from({ length: 40 }, (_, i) => ({ name: `Person ${i}` })) });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/at most 25/i);
  expect((await stored(lead._id)).contacts).toHaveLength(1);
});

test("a row that is not a contact, or has no name, is refused", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ ...RAMESH, isPrimary: true }] });

  for (const bad of [[{ name: "Ok" }, { jobTitle: "Nameless" }], [{ name: "  " }], [{ name: "Ok" }, "not a contact"], [{ name: "Ok" }, null], [{ name: "Ok" }, ["nested"]]]) {
    const r = await patch(lead._id, { contacts: bad });
    expect(r.status).toBe(400);
  }
  expect((await stored(lead._id)).contacts).toHaveLength(1);
});

/* ══ WHAT ALREADY DEPENDED ON THIS KEEPS WORKING ═══════════════════════════ */

test("readiness still accepts a reachable route on any contact", async () => {
  /* hasContactRoute already read contacts[] before this chunk — the point is
     that the richer shape did not break it. */
  expect(hasContactRoute({ contacts: [{ name: "X", phone: "9800000000" }] })).toBe(true);
  expect(hasContactRoute({ contacts: [{ name: "X", email: "x@y.z" }] })).toBe(true);
  expect(hasContactRoute({ contacts: [{ name: "X" }] })).toBe(false);

  const lead = await prospect({ phone: "", email: "" });
  await patch(lead._id, { contacts: [{ name: "Ramesh Sharma", phone: "9800000000" }] });
  const r = await call(`/${lead._id}/readiness`);
  expect(r.body.checks.find((c) => c.key === "contact").met).toBe(true);
});

test("the decision-maker check still reads a flagged contact", async () => {
  /* The Enquiry gate is a LEAD concept — `/readiness` returns null for it on a
     Prospect — so this exercises the pure checklist directly. `isDecisionMaker`
     is retained precisely so this keeps working. */
  const { computeEnquiryReadiness } = require("../../services/leadReadiness");
  const met = (lead) => computeEnquiryReadiness(lead).checks.find((c) => c.key === "decisionMaker").met;
  expect(met({ contacts: [{ name: "Ramesh Sharma", isDecisionMaker: true }] })).toBe(true);
  expect(met({ contacts: [{ name: "Ramesh Sharma", isDecisionMaker: false }] })).toBe(false);
  expect(met({ decisionMakerName: "Ravi Kumar" })).toBe(true);   // the legacy field, untouched
});


test("the two channel vocabularies are mapped, not assumed equal", async () => {
  const lead = await prospect();
  await patch(lead._id, { contacts: [{ name: "Ramesh Sharma" }] });
  const [cid] = await idsOf(lead._id);
  for (const [channel, legacy] of [["phone", "call"], ["messaging", "whatsapp"], ["email", "email"], ["none", "none"]]) {
    const r = await patch(lead._id, { contacts: [{ _id: cid, name: "Ramesh Sharma", isPrimary: true, preferredChannel: channel }] });
    expect(r.status).toBe(200);
    expect((await stored(lead._id)).preferredContactMethod).toBe(legacy);
  }
  /* `portal` has no legacy equivalent. The mirror is CLEARED rather than
     guessed at — an absent preference is honest, a wrong one is not. */
  expect((await patch(lead._id, { contacts: [{ _id: cid, name: "Ramesh Sharma", isPrimary: true, preferredChannel: "portal" }] })).status).toBe(200);
  expect((await stored(lead._id)).preferredContactMethod).toBeUndefined();
});
