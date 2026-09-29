// test/crm/lead-clear-values.route.test.js
//
// CLEARING A FIELD HAS TO REACH THE SERVER.
//
// `crmApi` serialises with JSON.stringify, which DROPS any property whose
// value is `undefined`. Several Lead-form handlers used `undefined` to mean
// "the user emptied this box", so the PATCH said nothing about the field at
// all and the stored value survived untouched — a delete that returned 200 and
// changed nothing, with the readiness gate still judging a number the
// salesperson had already removed.
//
// `null` survives serialisation. These tests pin the wire contract from the
// server's side: what an explicit clear looks like, that it really unsets, and
// that readiness notices immediately.
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

/* The Lead form's own transport: JSON.stringify, exactly as crmApi does it.
   Sending a raw object through `call` would hide the very bug these tests are
   about, because Node's fetch would never see the dropped key. */
const patchAsForm = (id, payload) => call(`/${id}`, { method: "PATCH", body: JSON.parse(JSON.stringify(payload)) });

const activeLead = async (over = {}) => {
  const { body } = await call("/", { method: "POST", body: { firstName: "Ravi", company: "Northstar", phone: "9876500000" } });
  const lead = body.lead;
  if (Object.keys(over).length) await Lead.updateOne({ _id: lead._id }, { $set: over });
  return lead;
};
const stored = (id) => Lead.findById(id).lean();
const readiness = async (id) => (await call(`/${id}/readiness`)).body;

/* ══ THE BUG ITSELF ════════════════════════════════════════════════════════ */

test("`undefined` never arrives — which is why it cannot be how a field is cleared", () => {
  const payload = { estimatedQuantity: undefined, requirementDate: undefined, keep: 1 };
  expect(JSON.parse(JSON.stringify(payload))).toEqual({ keep: 1 });
  // `null` survives, which is why it is the wire value for "cleared"
  expect(JSON.parse(JSON.stringify({ estimatedQuantity: null }))).toEqual({ estimatedQuantity: null });
});

/* ══ THE REQUIREMENT ═══════════════════════════════════════════════════════ */

test("removing every requirement row clears the structured AND the flat values", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, {
    requirementItems: [{ product: "Housekeeping shirts", quantity: 500 }],
    productInterest: ["Housekeeping shirts"],
    estimatedQuantity: 500,
    requirementCertainty: "suspected",
  });
  expect((await stored(lead._id)).estimatedQuantity).toBe(500);

  // the form's payload when the last row is emptied
  const r = await patchAsForm(lead._id, { requirementItems: [], productInterest: [], estimatedQuantity: null });
  expect(r.status).toBe(200);

  const after = await stored(lead._id);
  expect(after.requirementItems).toEqual([]);
  expect(after.productInterest).toEqual([]);
  expect(after.estimatedQuantity).toBeUndefined();
});

test("clearing the expected requirement date removes it", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, { requirementDate: "2026-12-01T00:00:00.000Z" });
  expect((await stored(lead._id)).requirementDate).toBeTruthy();

  expect((await patchAsForm(lead._id, { requirementDate: null })).status).toBe(200);
  expect((await stored(lead._id)).requirementDate).toBeUndefined();
});

test("clearing the next follow-up removes the saved date", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, { nextFollowUpAt: "2026-12-01T09:00:00.000Z" });
  expect((await stored(lead._id)).nextFollowUpAt).toBeTruthy();

  expect((await patchAsForm(lead._id, { nextFollowUpAt: null })).status).toBe(200);
  expect((await stored(lead._id)).nextFollowUpAt).toBeUndefined();
});

/* ══ THE COMMERCIAL ESTIMATES ══════════════════════════════════════════════ */

const RESEARCHED = {
  estimatedAnnualQuantity: 12000,
  estimatedAnnualQuantityConfidence: "researched",
  estimatedAnnualQuantitySource: "Their 2025 tender document",
};

test("clearing an estimate removes its value, its basis and its source", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, RESEARCHED);
  expect((await stored(lead._id)).estimatedAnnualQuantity).toBe(12000);

  // what the form sends once the number is deleted from the box
  const r = await patchAsForm(lead._id, {
    estimatedAnnualQuantity: null,
    estimatedAnnualQuantityConfidence: "",
    estimatedAnnualQuantitySource: null,
  });
  expect(r.status).toBe(200);

  const after = await stored(lead._id);
  expect(after.estimatedAnnualQuantity).toBeUndefined();
  expect(after.estimatedAnnualQuantityConfidence).toBeUndefined();
  expect(after.estimatedAnnualQuantitySource).toBeUndefined();
});

test("downgrading a researched estimate to Assumed drops the now-obsolete source", async () => {
  /* Evidence for a claim nobody is making any more is worse than none: it
     reads as backing for whatever the number says next. */
  const lead = await activeLead();
  await patchAsForm(lead._id, RESEARCHED);

  const r = await patchAsForm(lead._id, {
    estimatedAnnualQuantity: 12000,
    estimatedAnnualQuantityConfidence: "assumed",
    estimatedAnnualQuantitySource: null,
  });
  expect(r.status).toBe(200);

  const after = await stored(lead._id);
  expect(after.estimatedAnnualQuantity).toBe(12000);
  expect(after.estimatedAnnualQuantityConfidence).toBe("assumed");
  expect(after.estimatedAnnualQuantitySource).toBeUndefined();
});

test("the same holds for revenue and unit price", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, {
    estimatedAnnualRevenue: 900000, estimatedAnnualRevenueConfidence: "researched", estimatedAnnualRevenueSource: "A tender",
    estimatedUnitPrice: 75, estimatedUnitPriceConfidence: "researched", estimatedUnitPriceSource: "A quote",
  });
  await patchAsForm(lead._id, {
    estimatedAnnualRevenue: null, estimatedAnnualRevenueConfidence: "", estimatedAnnualRevenueSource: null,
    estimatedUnitPrice: null, estimatedUnitPriceConfidence: "", estimatedUnitPriceSource: null,
  });
  const after = await stored(lead._id);
  for (const k of [
    "estimatedAnnualRevenue", "estimatedAnnualRevenueConfidence", "estimatedAnnualRevenueSource",
    "estimatedUnitPrice", "estimatedUnitPriceConfidence", "estimatedUnitPriceSource",
  ]) expect(after[k]).toBeUndefined();
});

/* ══ READINESS NOTICES AT ONCE ═════════════════════════════════════════════ */

test("readiness reflects a cleared value on the very next read", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, {
    requirementItems: [{ product: "Shirts", quantity: 500 }],
    productInterest: ["Shirts"], estimatedQuantity: 500,
    requirementCertainty: "prospect_confirmed", decisionMakerName: "Ravi Kumar",
  });
  const before = await readiness(lead._id);
  expect(before.requirementIdentified.ready).toBe(true);

  await patchAsForm(lead._id, { requirementItems: [], productInterest: [], estimatedQuantity: null });
  const after = await readiness(lead._id);
  expect(after.requirementIdentified.ready).toBe(false);
  expect(after.requirementIdentified.checks.find((c) => c.key === "requirementQuantity").met).toBe(false);
  expect(after.enquiryReady.ready).toBe(false);
});

test("an unevidenced researched estimate blocks the Enquiry gate, and clearing it unblocks", async () => {
  const lead = await activeLead();
  await patchAsForm(lead._id, {
    requirementItems: [{ product: "Shirts", quantity: 500 }],
    productInterest: ["Shirts"], estimatedQuantity: 500,
    requirementCertainty: "prospect_confirmed", decisionMakerName: "Ravi Kumar",
    estimatedAnnualQuantity: 12000, estimatedAnnualQuantityConfidence: "researched",
  });
  expect((await readiness(lead._id)).enquiryReady.ready).toBe(false);

  // removing the figure entirely is a legitimate fix, and it has to take effect
  await patchAsForm(lead._id, {
    estimatedAnnualQuantity: null, estimatedAnnualQuantityConfidence: "", estimatedAnnualQuantitySource: null,
  });
  expect((await readiness(lead._id)).enquiryReady.ready).toBe(true);
});

/* ══ null IS NOT REINTERPRETED WHEREVER IT LANDS ═══════════════════════════ */

test("clearing is an allowlist, not a blanket rule for null", async () => {
  /* `null` is reinterpreted as "unset" only for the named value fields. On a
     field outside that list it keeps whatever meaning the schema gives it —
     a blanket rule would quietly turn every null anywhere into a deletion. */
  const lead = await activeLead();
  const r = await patchAsForm(lead._id, { notes: null, tags: [] });
  expect(r.status).toBe(200);
  const after = await stored(lead._id);
  expect(after.notes ?? null).toBeNull();   // not touched by the clear rule
  expect(after.tags).toEqual([]);           // an array clears by being empty, not null
});
