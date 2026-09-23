// test/crm/prospect-fields.route.test.js
//
// THE FACTUAL PROSPECT FIELDS.
//
// A Prospect is a possible customer nobody has qualified yet, so the form asks
// only what a salesperson can actually know: what kind of business this is,
// how and when to reach them, and a broad guess at what they might want.
//
// Everything here is optional and nothing here gates conversion. What these
// tests pin is that each field genuinely saves, reloads, clears, survives the
// conversion to an Active Lead, and stays editable afterwards — a field that
// silently drops its value is worse than a field that was never offered.
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

const draft = async (over = {}) => (await call("/", {
  method: "POST",
  body: { captureStatus: "draft", company: "Mayfair Lake Resort", phone: "9876500011", ...over },
})).body.lead;

const patch = (id, body) => call(`/${id}`, { method: "PATCH", body });
const reload = (id) => call(`/${id}`).then((r) => r.body.lead);

const ALL = {
  businessType: "hotel_hospitality",
  preferredContactMethod: "whatsapp",
  bestContactTime: "morning",
  contactTimeNote: "Closed on Sundays",
  preferredLanguage: "Odia",
  productInterests: ["uniforms", "hospitality_linen"],
  state: "Odisha",
  country: "India",
};

/* ══ SAVING, RELOADING, CLEARING ═══════════════════════════════════════════ */

test("every new field saves and comes back on reload", async () => {
  const lead = await draft();
  const r = await patch(lead._id, ALL);
  expect(r.status).toBe(200);
  const back = await reload(lead._id);
  for (const [k, v] of Object.entries(ALL)) expect(back[k]).toEqual(v);
});

test("the enums clear when set to empty, rather than refusing the save", async () => {
  /* "Not sure yet" has to be an answer. Without the clearable-enum handling an
     empty string reaches the schema enum and the save is refused, which makes
     the only way to leave a field blank never to have touched it. */
  const lead = await draft();
  await patch(lead._id, ALL);
  const r = await patch(lead._id, { businessType: "", preferredContactMethod: "", bestContactTime: "" });
  expect(r.status).toBe(200);
  const back = await reload(lead._id);
  expect(back.businessType).toBeUndefined();
  expect(back.preferredContactMethod).toBeUndefined();
  expect(back.bestContactTime).toBeUndefined();
});

test("the multi-select clears to empty, and de-duplicates what it is given", async () => {
  const lead = await draft();
  await patch(lead._id, { productInterests: ["uniforms", "uniforms", " workwear ", ""] });
  expect((await reload(lead._id)).productInterests).toEqual(["uniforms", "workwear"]);

  await patch(lead._id, { productInterests: [] });
  expect((await reload(lead._id)).productInterests).toEqual([]);
});

test("malformed input is refused, and the saved list survives it", async () => {
  /* This used to turn any non-array into `[]` and return 200 — a malformed
     request silently wiped a saved list and reported success. Nothing to
     notice, nothing to retry. The earlier test asserted that deletion as if it
     were the correct behaviour; it was the defect. */
  const lead = await draft();
  await patch(lead._id, { productInterests: ["uniforms", "workwear"] });

  for (const bad of ["uniforms", 42, { 0: "uniforms" }, true]) {
    const r = await patch(lead._id, { productInterests: bad });
    expect(r.status).toBe(400);
    expect((await reload(lead._id)).productInterests).toEqual(["uniforms", "workwear"]);
  }

  // and an explicit empty array is still the way to clear it
  expect((await patch(lead._id, { productInterests: [] })).status).toBe(200);
  expect((await reload(lead._id)).productInterests).toEqual([]);
});

/* ══ "NOT KNOWN YET" IS AN ANSWER, NOT AN EXTRA OPTION ═════════════════════ */

test("the server refuses a contradictory list from any client", async () => {
  /* `["not_known", "uniforms"]` says both "we have no idea" and "we think it's
     uniforms". The UI makes the choice exclusive; an invariant the server does
     not hold is a convention, not an invariant. */
  const lead = await draft();
  await patch(lead._id, { productInterests: ["uniforms"] });

  const r = await patch(lead._id, { productInterests: ["not_known", "uniforms"] });
  expect(r.status).toBe(400);
  expect(r.body.message).toMatch(/not known yet/i);
  expect((await reload(lead._id)).productInterests).toEqual(["uniforms"]);
});

test("either answer on its own is accepted", async () => {
  const lead = await draft();
  expect((await patch(lead._id, { productInterests: ["not_known"] })).status).toBe(200);
  expect((await reload(lead._id)).productInterests).toEqual(["not_known"]);

  expect((await patch(lead._id, { productInterests: ["uniforms", "workwear"] })).status).toBe(200);
  expect((await reload(lead._id)).productInterests).toEqual(["uniforms", "workwear"]);
});

test("the contradiction is caught at creation too, not only on edit", async () => {
  const r = await call("/", {
    method: "POST",
    body: { captureStatus: "draft", company: "Zenith", productInterests: ["not_known", "workwear"] },
  });
  expect(r.status).toBe(400);
});

test("an unknown code is refused by the enum, not silently stored", async () => {
  const lead = await draft();
  const r = await patch(lead._id, { productInterests: ["uniforms", "yachts"] });
  expect(r.status).toBe(400);
  expect((await reload(lead._id)).productInterests).toEqual([]);
});

test("free text is trimmed", async () => {
  const lead = await draft();
  await patch(lead._id, { contactTimeNote: "  Closed on Sundays  ", preferredLanguage: "  Odia " });
  const back = await reload(lead._id);
  expect(back.contactTimeNote).toBe("Closed on Sundays");
  expect(back.preferredLanguage).toBe("Odia");
});

/* ══ NONE OF IT BLOCKS ANYTHING ════════════════════════════════════════════ */

test("a Prospect with none of these fields still converts", async () => {
  const lead = await readyProspect();
  const r = await call(`/${lead._id}/convert-to-active`, {
    method: "POST",
    body: { interestSignal: "requested_sample", interestNote: "Asked for a sample." },
  });
  expect(r.status).toBe(200);
});

test("none of them appears in the conversion checklist", async () => {
  const lead = await draft();
  const keys = (await call(`/${lead._id}/readiness`)).body.checks.map((c) => c.key);
  for (const k of Object.keys(ALL)) expect(keys).not.toContain(k);
});

/* ══ THEY SURVIVE CONVERSION, AND STAY EDITABLE AFTERWARDS ═════════════════ */

async function readyProspect(over = {}) {
  const lead = await draft(over);
  await Lead.updateOne({ _id: lead._id }, { $set: {
    prospectType: "company",
    source: "referral",
    pendingFirstAction: { subject: "Send the catalogue", dueDate: new Date(dueDate) },
    nextFollowUpAt: new Date(dueDate),
  } });
  await Activity.create({
    leadId: lead._id, activityType: "call", subject: "Rang the buyer",
    status: "completed", completedAt: new Date(), outcome: "replied_connected",
    ownerId: SALES_USER.id, ownerName: SALES_USER.name,
  });
  return lead;
}

test("every value survives Prospect → Lead untouched", async () => {
  /* It is the same record, so there is nothing to migrate — which is exactly
     why a regression here would be silent. */
  const lead = await readyProspect();
  await patch(lead._id, ALL);
  const r = await call(`/${lead._id}/convert-to-active`, {
    method: "POST",
    body: { interestSignal: "requested_sample", interestNote: "Asked for a sample." },
  });
  expect(r.status).toBe(200);

  const after = await reload(lead._id);
  expect(after.captureStatus).toBe("active");
  for (const [k, v] of Object.entries(ALL)) expect(after[k]).toEqual(v);
});

test("they remain editable once it is an Active Lead", async () => {
  const lead = await readyProspect();
  await call(`/${lead._id}/convert-to-active`, {
    method: "POST",
    body: { interestSignal: "requested_sample", interestNote: "Asked for a sample." },
  });
  const r = await patch(lead._id, { businessType: "corporate_office", productInterests: ["corporate_apparel"] });
  expect(r.status).toBe(200);
  const after = await reload(lead._id);
  expect(after.businessType).toBe("corporate_office");
  expect(after.productInterests).toEqual(["corporate_apparel"]);
});

/* ══ TENANCY ═══════════════════════════════════════════════════════════════ */

test("the fields do not open a route into another company's records", async () => {
  /* A PATCH still has to find the record through the same scoped read as
     everything else — the new fields add data, not a new way in. */
  const lead = await draft();
  await Lead.updateOne({ _id: lead._id }, { $set: { companyId: new mongoose.Types.ObjectId() } });
  const r = await patch(lead._id, { businessType: "hotel_hospitality" });
  expect([403, 404]).toContain(r.status);
});
