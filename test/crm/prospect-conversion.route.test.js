// test/crm/prospect-conversion.route.test.js
//
// WHAT A PROSPECT MUST BE BEFORE IT BECOMES A LEAD.
//
// ── WHAT THE BAR USED TO BE ─────────────────────────────────────────────────
// Nine checks, most of them forecasts: estimated annual quantity, estimated
// annual revenue, a confidence level for each, a customer segment, a written
// case for pursuing them, and supporting evidence with a URL or document
// reference — all demanded of a record whose entire purpose is to discover
// whether there is anything here at all.
//
// Asking for numbers nobody can know yet does not produce knowledge. It
// produces invented numbers that are indistinguishable from researched ones,
// which is worse than collecting nothing.
//
// ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
// Only what a salesperson actually knows by then: who they are, how to reach
// them, where they came from, that somebody really made contact, and what the
// customer DID that showed interest. Observations, not forecasts.
//
// The commercial fields are not deleted — they still exist, still hold their
// values, and still gate an ACTIVE Lead's qualification. They are simply no
// longer asked of a Prospect. Several tests below pin that distinction,
// because "we removed the checks" and "we removed the data" look identical
// from the outside and only one of them is recoverable.
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
const OTHER_USER = { id: new mongoose.Types.ObjectId().toString(), name: "Deepak Nair", role: "sales", email: "deepak@example.com" };

let server, base;
const dueDate = "2026-09-15T09:00:00.000Z";

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

async function call(path = "", { method = "GET", body, user = SALES_USER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

/** A Prospect that satisfies everything except what a test removes. */
async function readyProspect(over = {}, user = SALES_USER) {
  const { body } = await call("/", {
    method: "POST",
    body: { captureStatus: "draft", company: "Zenith Apparel", phone: "9876500011", ...over },
    user,
  });
  const lead = body.lead;
  await Lead.updateOne({ _id: lead._id }, {
    $set: {
      prospectType: "company",
      source: "referral",
      pendingFirstAction: { subject: "Send the catalogue", dueDate: new Date(dueDate) },
      nextFollowUpAt: new Date(dueDate),
      ...(over.$set || {}),
    },
  });
  /* A genuine two-way contact, which the conversion bar requires: a completed
     call whose OUTCOME says the customer engaged. This fixture used to log a
     completed call with no outcome — an "interaction" nobody had actually had
     — and the rule was briefly weakened to keep it passing. The rule is the
     product decision; the fixture was the inaccurate half. */
  if (!over.noInteraction) {
    await Activity.create({
      leadId: lead._id, activityType: "call", subject: "Rang the buyer",
      status: "completed", completedAt: new Date(), outcome: "replied_connected",
      ownerId: user.id, ownerName: user.name,
    });
  }
  return await Lead.findById(lead._id);
}

const CONFIRM = { interestSignal: "requested_sample", interestNote: "Asked us to send a sample of the poly-cotton." };
const convert = (id, body = CONFIRM, user = SALES_USER) =>
  call(`/${id}/convert-to-active`, { method: "POST", body, user });

/* ══ IDENTITY ══════════════════════════════════════════════════════════════ */

test("a Company needs a company name; a contact name is not enough", async () => {
  const lead = await readyProspect({ company: "", firstName: "Ramesh" });
  await Lead.updateOne({ _id: lead._id }, { $set: { prospectType: "company", company: "" } });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "identity").met).toBe(false);
});

test("an Individual with neither a first name nor a company is not identified", async () => {
  /* Both cleared: a record holding only a company name is treated as the
     company it evidently is, whatever the defaulted type says — see the
     identity check's own note on why the label is not trusted over the data. */
  const lead = await readyProspect({ company: "Zenith Apparel" });
  await Lead.updateOne({ _id: lead._id }, { $set: { prospectType: "individual", firstName: "", company: "" } });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "identity").met).toBe(false);
});

test("an Individual with a first name and no company converts", async () => {
  // A sole trader is a real customer. Demanding a company name would refuse one.
  const lead = await readyProspect({ company: "", firstName: "Ramesh", phone: "9876500012" });
  await Lead.updateOne({ _id: lead._id }, { $set: { prospectType: "individual", company: "" } });
  const r = await convert(lead._id);
  expect(r.status).toBe(200);
});

/* ══ THE OTHER GATES ═══════════════════════════════════════════════════════ */

test("a Prospect with no way to contact them cannot convert", async () => {
  const lead = await readyProspect();
  await Lead.updateOne({ _id: lead._id }, { $set: { phone: "", whatsapp: "", email: "", contacts: [] } });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "contact").met).toBe(false);
});

test("a Prospect with no source cannot convert", async () => {
  const lead = await readyProspect();
  await Lead.updateOne({ _id: lead._id }, { $unset: { source: "" } });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "source").met).toBe(false);
});

test("a Prospect nobody has actually contacted cannot convert", async () => {
  const lead = await readyProspect({ noInteraction: true });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "interaction").met).toBe(false);
});

test("a PLANNED follow-up is not a contact", async () => {
  /* An intention to ring somebody is not evidence that anybody rang them. */
  const lead = await readyProspect({ noInteraction: true });
  await Activity.create({
    leadId: lead._id, activityType: "follow_up", subject: "Call them Tuesday",
    status: "planned", dueDate: new Date(dueDate), ownerId: SALES_USER.id,
  });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "interaction").met).toBe(false);
});

test("the next action and its due date are still required", async () => {
  const lead = await readyProspect();
  await Lead.updateOne({ _id: lead._id }, { $unset: { pendingFirstAction: "" } });
  const r = await convert(lead._id);
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "firstAction").met).toBe(false);
  expect(r.body.checks.find((c) => c.key === "firstActionDue").met).toBe(false);
});

/* ══ THE INTEREST CONFIRMATION ═════════════════════════════════════════════ */

test("conversion without an interest signal is refused", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id, { interestNote: "They seemed keen." });
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "interestSignal").met).toBe(false);
});

test("conversion without an interest note is refused", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id, { interestSignal: "requested_sample" });
  expect(r.status).toBe(400);
  expect(r.body.checks.find((c) => c.key === "interestNote").met).toBe(false);
});

test("the signal, note, actor and timestamp are all stored", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id);
  expect(r.status).toBe(200);
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.interestSignal).toBe("requested_sample");
  expect(doc.interestNote).toMatch(/poly-cotton/);
  expect(doc.interestConfirmedAt).toBeTruthy();
  expect(String(doc.interestConfirmedBy?.id)).toBe(SALES_USER.id);
});

test("who confirmed the interest is the authenticated user, never the client's claim", async () => {
  /* The whole point of the field. A client-supplied "confirmed by" is an
     assertion, not a confirmation, and this is the field somebody gets asked
     about later. */
  const lead = await readyProspect();
  const r = await convert(lead._id, {
    ...CONFIRM,
    interestConfirmedBy: { id: OTHER_USER.id, name: "Somebody Else" },
    interestConfirmedAt: new Date("2020-01-01").toISOString(),
  });
  expect(r.status).toBe(200);
  const doc = await Lead.findById(lead._id).lean();
  expect(String(doc.interestConfirmedBy?.id)).toBe(SALES_USER.id);
  expect(new Date(doc.interestConfirmedAt).getFullYear()).toBeGreaterThan(2020);
});

test("an interest signal outside the vocabulary is rejected", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id, { interestSignal: "vibes", interestNote: "Felt right." });
  expect(r.status).toBeGreaterThanOrEqual(400);
});

/* ══ THE COMMERCIAL FIELDS SURVIVE ═════════════════════════════════════════ */

test("a Prospect converts with no commercial estimates at all", async () => {
  /* The point of the chunk: none of these are asked of a Prospect any more. */
  const lead = await readyProspect();
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.estimatedAnnualQuantity == null).toBe(true);
  expect(doc.estimatedAnnualRevenue == null).toBe(true);
  const r = await convert(lead._id);
  expect(r.status).toBe(200);
});

test("existing commercial values are preserved through conversion, not erased", async () => {
  /* "We removed the checks" and "we removed the data" look identical from
     outside, and only one of them can be undone. */
  const lead = await readyProspect();
  await Lead.updateOne({ _id: lead._id }, {
    $set: {
      estimatedAnnualQuantity: 5000, estimatedAnnualRevenue: 750000,
      industry: "hospitality", pursuitJustification: "Big regional chain.",
      evidence: [{ claim: "annual_quantity", sourceUrl: "https://example.com/tender" }],
    },
  });
  const r = await convert(lead._id);
  expect(r.status).toBe(200);
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.estimatedAnnualQuantity).toBe(5000);
  expect(doc.estimatedAnnualRevenue).toBe(750000);
  expect(doc.industry).toBe("hospitality");
  expect(doc.pursuitJustification).toMatch(/regional chain/);
  expect(doc.evidence).toHaveLength(1);
});

/* ══ CONVERSION STAYS DELIBERATE, AND KEEPS THE RECORD ═════════════════════ */

test("nothing converts a Prospect on its own", async () => {
  /* A customer answering the phone must not promote their own record. */
  const lead = await readyProspect();
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "They called back",
    status: "completed", completedAt: new Date(), outcome: "replied_connected", ownerId: SALES_USER.id,
  });
  await call(`/${lead._id}/activities/auto-sync`, { method: "POST" });
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.captureStatus).toBe("draft");
});

test("conversion keeps the same record and its whole history", async () => {
  const lead = await readyProspect();
  const before = await Activity.countDocuments({ leadId: lead._id, isActive: true });
  const leadCountBefore = await Lead.countDocuments({});

  const r = await convert(lead._id);
  expect(r.status).toBe(200);

  expect(await Lead.countDocuments({})).toBe(leadCountBefore); // no duplicate record
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.captureStatus).toBe("active");
  const after = await Activity.countDocuments({ leadId: lead._id, isActive: true });
  expect(after).toBeGreaterThanOrEqual(before);

  const hist = await call(`/${lead._id}/activities`);
  expect(hist.body.activities.map((a) => a.subject)).toContain("Rang the buyer");
});

test("a Prospect stays draft when conversion is refused", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await convert(lead._id);
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.captureStatus).toBe("draft");
});

/* ══ ACCESS ════════════════════════════════════════════════════════════════ */

test("another salesperson cannot convert someone else's Prospect", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id, CONFIRM, OTHER_USER);
  expect(r.status).toBe(403);
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.captureStatus).toBe("draft");
});

test("an unauthenticated caller cannot convert", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id, CONFIRM, null);
  expect(r.status).toBe(401);
});

/* ══ THE DEADLOCK ══════════════════════════════════════════════════════════
 * Readiness required an interest signal and note; those two are typed into the
 * confirmation dialog; and the button that opens that dialog was disabled
 * until readiness passed. The only route to the two fields was gated on
 * already having them, so an ordinary Prospect could never be converted at
 * all.
 *
 * The report is now in two parts. `readyToConfirm` is what the button may gate
 * on — everything the form itself can answer. `ready` is unchanged and still
 * governs the endpoint. These tests pin both halves, because a fix that only
 * proved the first would be indistinguishable from one that had quietly
 * dropped the requirement.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a Prospect with no interest recorded is ready to CONFIRM but not to convert", async () => {
  const lead = await readyProspect();
  const r = await call(`/${lead._id}/readiness`);
  expect(r.status).toBe(200);
  expect(r.body.readyToConfirm).toBe(true);   // the dialog may open
  expect(r.body.ready).toBe(false);           // but conversion is not allowed
});

test("the dialog's own fields are never listed as blockers before it can open", async () => {
  const lead = await readyProspect();
  const r = await call(`/${lead._id}/readiness`);
  const preKeys = r.body.preConfirmChecks.map((c) => c.key);
  expect(preKeys).not.toContain("interestSignal");
  expect(preKeys).not.toContain("interestNote");
  // and the full list still carries them
  expect(r.body.checks.map((c) => c.key)).toEqual(
    expect.arrayContaining(["interestSignal", "interestNote"]),
  );
});

test("an incomplete Prospect is not ready to confirm either, and says why", async () => {
  const lead = await readyProspect({ noInteraction: true });
  const r = await call(`/${lead._id}/readiness`);
  expect(r.body.readyToConfirm).toBe(false);
  const unmet = r.body.preConfirmChecks.filter((c) => !c.met).map((c) => c.key);
  expect(unmet).toContain("interaction");
});

test("the server still refuses conversion without the interest, however ready the form looks", async () => {
  /* The half that must not move. Splitting the REPORT does not weaken the
     RULE. */
  const lead = await readyProspect();
  const r = await call(`/${lead._id}/convert-to-active`, { method: "POST", body: {} });
  expect(r.status).toBe(400);
  const unmet = r.body.checks.filter((c) => !c.met).map((c) => c.key);
  expect(unmet).toEqual(expect.arrayContaining(["interestSignal", "interestNote"]));
  expect((await Lead.findById(lead._id).lean()).captureStatus).toBe("draft");
});

/* ══ THE FIELDS THAT ARE ACTUALLY THERE ════════════════════════════════════ */

test("the new Prospect fields save and reload", async () => {
  const lead = await readyProspect();
  const patch = {
    designation: "Head of Procurement",
    whatsapp: "9876500011",
    sourceDetails: "Met at their Bhubaneswar office",
    referredBy: "Mayfair Lagoon",
    campaignOrEvent: "Garment Tech 2026",
    possibleNeed: "Around 400 housekeeping uniforms",
    tags: ["uniforms", "odisha"],
    priority: "high",
  };
  const saved = await call(`/${lead._id}`, { method: "PATCH", body: patch });
  expect(saved.status).toBe(200);

  const doc = await Lead.findById(lead._id).lean();
  for (const [k, v] of Object.entries(patch)) {
    if (Array.isArray(v)) expect(doc[k]).toEqual(v);
    else expect(doc[k]).toBe(v);
  }
});

test("a conditional source field is not erased by saving a different source", async () => {
  /* The field stopped being SHOWN, which is not the salesperson saying it was
     wrong. Clearing stays an explicit act. */
  const lead = await readyProspect();
  await call(`/${lead._id}`, { method: "PATCH", body: { source: "referral", referredBy: "Mayfair Lagoon" } });
  await call(`/${lead._id}`, { method: "PATCH", body: { source: "website", referredBy: "Mayfair Lagoon" } });
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.source).toBe("website");
  expect(doc.referredBy).toBe("Mayfair Lagoon");
});

test("a conditional field CAN be cleared deliberately", async () => {
  const lead = await readyProspect();
  await call(`/${lead._id}`, { method: "PATCH", body: { referredBy: "Mayfair Lagoon" } });
  await call(`/${lead._id}`, { method: "PATCH", body: { referredBy: "" } });
  expect((await Lead.findById(lead._id).lean()).referredBy || "").toBe("");
});

test("the WhatsApp number is stored as a number, not as a 'same as phone' flag", async () => {
  /* A stored flag would have to stay true as either number changed, and the
     day it drifted the record would claim two numbers matched when they did
     not. The UI copies the value; only the value is kept. */
  const lead = await readyProspect();
  await call(`/${lead._id}`, { method: "PATCH", body: { phone: "9876500011", whatsapp: "9876500011" } });
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.whatsapp).toBe("9876500011");
  expect(doc.sameAsPhone).toBeUndefined();
  expect(doc.whatsappSameAsPhone).toBeUndefined();
});

test("an ordinary salesperson cannot reassign the owner from this form", async () => {
  /* Not a new rule — an existing manager gate. Asserted here because the
     Prospect form now shows the assigned salesperson, and a displayed field is
     the one people try to edit. */
  const lead = await readyProspect();
  const r = await call(`/${lead._id}`, {
    method: "PATCH",
    body: { assignedTo: OTHER_USER.id, assignedToName: "Spoofed Owner" },
  });
  expect(r.status).toBeGreaterThanOrEqual(400);
  expect(r.body.message).toMatch(/manager/i);
  expect((await Lead.findById(lead._id).lean()).assignedToName).not.toBe("Spoofed Owner");
});

test("the interest attestation cannot be forged through the form", async () => {
  /* `interestConfirmedBy` and `interestConfirmedAt` are absent from the
     editable allowlist. A self-declared confirmation is not a confirmation,
     and this is exactly the field somebody gets asked about later. */
  const lead = await readyProspect();
  const r = await call(`/${lead._id}`, {
    method: "PATCH",
    body: {
      interestConfirmedBy: { id: OTHER_USER.id, name: "Spoofed" },
      interestConfirmedAt: new Date("2020-01-01").toISOString(),
      possibleNeed: "a legitimate edit alongside the forgeries",
    },
  });
  expect(r.status).toBe(200);
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.interestConfirmedBy?.name).toBeUndefined();
  expect(doc.interestConfirmedAt).toBeUndefined();
  /* The forged keys were dropped; the real one alongside them still saved —
     the allowlist ignores what it does not know rather than refusing the whole
     request, which is what makes a partial forgery silent and this test
     worth having. */
  expect(doc.possibleNeed).toMatch(/legitimate edit/);
});

test("editing the new fields leaves the old commercial data alone", async () => {
  const lead = await readyProspect();
  await Lead.updateOne({ _id: lead._id }, {
    $set: { estimatedAnnualQuantity: 5000, industry: "hospitality", pursuitJustification: "Big chain." },
  });
  await call(`/${lead._id}`, { method: "PATCH", body: { possibleNeed: "uniforms", tags: ["x"] } });
  const doc = await Lead.findById(lead._id).lean();
  expect(doc.estimatedAnnualQuantity).toBe(5000);
  expect(doc.industry).toBe("hospitality");
  expect(doc.pursuitJustification).toBe("Big chain.");
});

/* ══ PRIORITY IS GENUINELY OPTIONAL ════════════════════════════════════════
 * The form said "Optional" and offered "Not set". The model defaulted to
 * "medium" and the route refused "" against the enum — so every new Prospect
 * silently claimed a priority nobody chose, and the one control offered for
 * saying otherwise could not be used.
 * ═════════════════════════════════════════════════════════════════════════ */

test("a new Prospect has no priority until somebody chooses one", async () => {
  const { body } = await call("/", {
    method: "POST",
    body: { captureStatus: "draft", company: "Zenith Apparel" },
  });
  const doc = await Lead.findById(body.lead._id).lean();
  expect(doc.priority).toBeUndefined();
});

test("a priority can be set", async () => {
  const lead = await readyProspect();
  const r = await call(`/${lead._id}`, { method: "PATCH", body: { priority: "high" } });
  expect(r.status).toBe(200);
  expect((await Lead.findById(lead._id).lean()).priority).toBe("high");
});

test("a priority can be cleared back to unset", async () => {
  /* "Not set" sends "". Without `priority` in the clearable list that reached
     the enum and was refused, so the only way to have no priority was never to
     have touched the control. */
  const lead = await readyProspect();
  await call(`/${lead._id}`, { method: "PATCH", body: { priority: "urgent" } });
  const r = await call(`/${lead._id}`, { method: "PATCH", body: { priority: "" } });
  expect(r.status).toBe(200);
  expect((await Lead.findById(lead._id).lean()).priority).toBeUndefined();
});

test("a record already holding medium is left exactly as it is", async () => {
  /* Removing the default governs NEW documents. It does not migrate old ones,
     and nothing here should rewrite a value somebody may have chosen. */
  const lead = await readyProspect();
  await Lead.updateOne({ _id: lead._id }, { $set: { priority: "medium" } });
  await call(`/${lead._id}`, { method: "PATCH", body: { possibleNeed: "an unrelated edit" } });
  expect((await Lead.findById(lead._id).lean()).priority).toBe("medium");
});

test("an unset priority survives conversion", async () => {
  const lead = await readyProspect();
  const r = await convert(lead._id);
  expect(r.status).toBe(200);
  expect((await Lead.findById(lead._id).lean()).priority).toBeUndefined();
});


/* ══ THE CONVERSION BAR IS A REAL CONVERSATION ═════════════════════════════
 * A Prospect becomes a Lead only once the CUSTOMER has engaged. Everything
 * below is an outreach attempt that nobody answered, and none of it converts.
 * ═════════════════════════════════════════════════════════════════════════ */

const outreach = (leadId, over = {}) => Activity.create({
  leadId, activityType: "call", subject: "Attempt",
  status: "completed", completedAt: new Date(), ownerId: SALES_USER.id, ...over,
});

const interactionMet = async (id) =>
  (await call(`/${id}/readiness`)).body.checks.find((c) => c.key === "interaction").met;

test("a completed call that rang out cannot convert", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { outcome: "no_answer" });
  expect(await interactionMet(lead._id)).toBe(false);
  expect((await convert(lead._id)).status).toBe(400);
});

test("a completed activity with no outcome at all cannot convert", async () => {
  /* The exact shape of the old fixture — logged, completed, and silent about
     whether anybody actually spoke. */
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id);
  expect(await interactionMet(lead._id)).toBe(false);
  expect((await convert(lead._id)).status).toBe(400);
});

test("an outgoing email nobody replied to cannot convert", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { activityType: "email_log", subject: "Sent the catalogue" });
  expect(await interactionMet(lead._id)).toBe(false);
  expect((await convert(lead._id)).status).toBe(400);
});

test("an outgoing WhatsApp nobody replied to cannot convert", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { activityType: "message", subject: "Sent a message" });
  expect(await interactionMet(lead._id)).toBe(false);
  expect((await convert(lead._id)).status).toBe(400);
});

test("a note is not outreach and cannot convert", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { activityType: "note", subject: "Looks promising", outcome: "replied_connected" });
  expect(await interactionMet(lead._id)).toBe(false);
  expect((await convert(lead._id)).status).toBe(400);
});

test("a PLANNED call, however hopeful, cannot convert", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Will ring them",
    status: "planned", activityDate: new Date(), outcome: "replied_connected",
    ownerId: SALES_USER.id,
  });
  expect(await interactionMet(lead._id)).toBe(false);
  expect((await convert(lead._id)).status).toBe(400);
});

test("replied_connected satisfies the interaction check and converts", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { outcome: "replied_connected" });
  expect(await interactionMet(lead._id)).toBe(true);
  expect((await convert(lead._id)).status).toBe(200);
});

test("meeting_completed satisfies the interaction check and converts", async () => {
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { activityType: "meeting", subject: "Met at their office", outcome: "meeting_completed" });
  expect(await interactionMet(lead._id)).toBe(true);
  expect((await convert(lead._id)).status).toBe(200);
});

test("the card and the conversion endpoint never disagree", async () => {
  /* The defect this closes: the list computed readiness from "an attempt was
     made" while the endpoint required engagement, so a card could read "Ready
     to convert" on a Prospect the endpoint would refuse. */
  const lead = await readyProspect({ noInteraction: true });
  await outreach(lead._id, { outcome: "no_answer" });

  const listed = (await call("/?captureStatus=draft&limit=100")).body.leads
    .find((l) => String(l._id) === String(lead._id));
  expect(listed.workState.code).not.toBe("ready_to_convert");
  expect((await convert(lead._id)).status).toBe(400);

  await outreach(lead._id, { outcome: "replied_connected" });
  const again = (await call("/?captureStatus=draft&limit=100")).body.leads
    .find((l) => String(l._id) === String(lead._id));
  expect(again.workState.code).toBe("ready_to_convert");
  expect((await convert(lead._id)).status).toBe(200);
});

/* ══ ONE ROUTE, NOT TWO ════════════════════════════════════════════════════
 * `POST /:id/convert-to-active` was registered TWICE, ~190 lines apart.
 * Express matches the first registration and never reaches the second, so the
 * second handler was unreachable code that read exactly like live code: two
 * implementations of one rule, free to drift, with the drift invisible because
 * only one of them ever ran. Asserted against the router's own stack rather
 * than the source text, so a duplicate cannot return under a different
 * formatting.
 * ═════════════════════════════════════════════════════════════════════════ */

test("the conversion route is registered exactly once", () => {
  const router = require("../../routes/CMS_Routes/Sales/leads");
  const counts = new Map();
  for (const layer of router.stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) {
      const key = `${m.toUpperCase()} ${layer.route.path}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  expect(counts.get("POST /:id/convert-to-active")).toBe(1);

  // and nothing else in this router is doubled either
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([k]) => k);
  expect(dupes).toEqual([]);
});

test("the surviving handler keeps every behaviour the dead one had", async () => {
  /* The dead copy checked captureStatus itself and guarded the first action
     before dereferencing it. Both are covered here so the deletion cannot have
     quietly removed a rule. */
  const active = await readyProspect();
  await Lead.updateOne({ _id: active._id }, { $set: { captureStatus: "active" } });
  const r = await convert(active._id);
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/only a prospect/i);

  const noAction = await readyProspect();
  await Lead.updateOne({ _id: noAction._id }, { $unset: { pendingFirstAction: 1 }, $set: { nextFollowUpAt: null } });
  const r2 = await convert(noAction._id);
  expect(r2.status).toBe(400);
});
