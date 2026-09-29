// test/crm/lead-form-redesign.route.test.js
//
// CONTACTS ARE THE BUYER AUTHORITY, AND THE PROJECTIONS ARE DERIVED.
//
// Two facts used to have two writers each. The decision-maker lived both in
// `contacts[]` and in the Lead's own `decisionMakerName`/`Role` boxes, either
// copy able to satisfy the Ready-for-Enquiry gate on its own — so a
// salesperson maintained the same buyer twice and the record could disagree
// with itself. And `productInterest[]` / `estimatedQuantity` were computed in
// the browser and PATCHed alongside the rows they were computed from, which
// meant a stale total could qualify a Lead whose lines said otherwise.
//
// One writer each now. The legacy fields stay stored, and stay the answer for
// records that never had embedded contacts — nothing is migrated.
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
const { computeEnquiryReadiness, decisionMakerFacts } = require("../../services/leadReadiness");

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
  await Promise.all([Lead.deleteMany({}), DepartmentRole.deleteMany({})]);
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

const patch = (id, body) => call(`/${id}`, { method: "PATCH", body });

/* A PATCH that fails leaves the record empty, and a readiness check about a
   figure that was never saved passes vacuously. Four of these tests did
   exactly that, hiding behind an invalid `evidenceType`. Every write asserts
   it landed. */
const patchOk = async (id, body) => {
  const r = await patch(id, body);
  if (r.status !== 200) throw new Error(`PATCH ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
};
const lead = async (over = {}) => (await call("/", {
  method: "POST",
  body: { captureStatus: "draft", prospectType: "company", company: "Mayfair Lake Resort", ...over },
})).body.lead;
const check = (doc, key) => computeEnquiryReadiness(doc).checks.find((c) => c.key === key);

/* ══ THE DECISION-MAKER IS A CONTACT ══════════════════════════════════════ */

test("a contact flagged as decision-maker satisfies the check", async () => {
  const l = await lead();
  await patch(l._id, { contacts: [{ name: "Vikram Singh", phone: "9876500011", isPrimary: true, isDecisionMaker: true }] });
  const doc = await Lead.findById(l._id).lean();

  expect(check(doc, "decisionMaker").met).toBe(true);
  expect(decisionMakerFacts(doc).source).toBe("contacts");
});

test("the canonical decision_maker role satisfies it too", async () => {
  const l = await lead();
  await patch(l._id, { contacts: [{ name: "Vikram Singh", phone: "9876500011", isPrimary: true, roleCode: "decision_maker" }] });
  expect(check(await Lead.findById(l._id).lean(), "decisionMaker").met).toBe(true);
});

test("a buying committee is valid — more than one may be marked", async () => {
  const l = await lead();
  await patch(l._id, { contacts: [
    { name: "Vikram Singh", phone: "9876500011", isPrimary: true, isDecisionMaker: true },
    { name: "Priya Nair", phone: "9876500022", isDecisionMaker: true },
  ]});
  expect(check(await Lead.findById(l._id).lean(), "decisionMaker").met).toBe(true);
});

/* Somebody who cannot approve an order, or cannot be called, is not an answer
   to "who signs this off". */
test.each([
  ["left_organization"],
  ["do_not_contact"],
  ["blocked"],
  ["archived"],
  ["inactive"],
])("a decision-maker marked %s does not satisfy the check", async (status) => {
  const l = await lead();
  await patch(l._id, { contacts: [
    { name: "Ramesh Sharma", phone: "9876500011", isPrimary: true },
    { name: "Gone Person", phone: "9876500099", isDecisionMaker: true, status },
  ]});
  expect(check(await Lead.findById(l._id).lean(), "decisionMaker").met).toBe(false);
});

/* ══ THE LEGACY FIELDS ARE A FALLBACK, NOT AN ALTERNATIVE ═════════════════ */

test("a legacy Lead with no contacts still qualifies on decisionMakerName", async () => {
  const l = await lead();
  await Lead.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(l._id)) },
    { $set: { decisionMakerName: "Old Record Person", decisionMakerRole: "Owner" }, $unset: { contacts: "" } },
  );
  const doc = await Lead.findById(l._id).lean();

  expect(doc.contacts).toBeUndefined();
  expect(check(doc, "decisionMaker").met).toBe(true);
  expect(decisionMakerFacts(doc).source).toBe("legacy");
});

test("once contacts exist, the legacy name no longer answers for them", async () => {
  const l = await lead();
  await patch(l._id, { contacts: [{ name: "Ramesh Sharma", phone: "9876500011", isPrimary: true }] });
  await Lead.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(l._id)) },
    { $set: { decisionMakerName: "Old Record Person" } },
  );
  const doc = await Lead.findById(l._id).lean();

  // The historical value is untouched…
  expect(doc.decisionMakerName).toBe("Old Record Person");
  // …and no longer a second way to satisfy the gate.
  expect(check(doc, "decisionMaker").met).toBe(false);
});

test("the checklist item names where the answer is given", async () => {
  const doc = await Lead.findById((await lead())._id).lean();
  expect(check(doc, "decisionMaker").label).toMatch(/contacts/i);
});

/* ══ THE PROJECTIONS FOLLOW THE ROWS ══════════════════════════════════════ */

test("productInterest and estimatedQuantity are derived from the rows", async () => {
  const l = await lead();
  await patch(l._id, { requirementItems: [
    { product: "Housekeeping shirt", quantity: 400, unit: "pieces" },
    { product: "F&B waistcoat", quantity: 120, unit: "pieces" },
  ]});
  const doc = await Lead.findById(l._id).lean();

  expect(doc.productInterest).toEqual(["Housekeeping shirt", "F&B waistcoat"]);
  expect(doc.estimatedQuantity).toBe(520);
});

test("a client that sends stale projections cannot override the rows", async () => {
  const l = await lead();
  await patch(l._id, {
    requirementItems: [{ product: "Housekeeping shirt", quantity: 400 }],
    productInterest: ["Something else entirely"],
    estimatedQuantity: 99999,
  });
  const doc = await Lead.findById(l._id).lean();

  expect(doc.productInterest).toEqual(["Housekeeping shirt"]);
  expect(doc.estimatedQuantity).toBe(400);
});

test("rows with no quantity leave the total unset rather than zero", async () => {
  const l = await lead();
  await patch(l._id, { requirementItems: [{ product: "Housekeeping shirt" }] });
  const doc = await Lead.findById(l._id).lean();

  expect(doc.productInterest).toEqual(["Housekeeping shirt"]);
  expect(doc.estimatedQuantity == null).toBe(true);
});

/* A Lead that predates the structured rows must keep what it has — rebuilding
   projections from an empty array would erase real data. */
test("a legacy Lead with no requirementItems keeps its own projections", async () => {
  const l = await lead();
  await Lead.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(l._id)) },
    { $set: { productInterest: ["Legacy product"], estimatedQuantity: 250 }, $unset: { requirementItems: "" } },
  );
  await patch(l._id, { notes: "touched something unrelated" });
  const doc = await Lead.findById(l._id).lean();

  expect(doc.productInterest).toEqual(["Legacy product"]);
  expect(doc.estimatedQuantity).toBe(250);
});

/* ══ THE NEW REQUIREMENT AND BUYING-PROCESS FIELDS ════════════════════════ */

test("unit and use case persist per requirement", async () => {
  const l = await lead();
  await patch(l._id, {
    requirementItems: [
      { product: "Housekeeping shirt", quantity: 400, unit: "pieces" },
      { product: "Shirting fabric", quantity: 200, unit: "metres" },
    ],
    requirementUseCase: "Annual staff uniform refresh",
    deliveryTimeline: "before the season opens",
  });
  const doc = await Lead.findById(l._id).lean();

  expect(doc.requirementItems.map((r) => r.unit)).toEqual(["pieces", "metres"]);
  expect(doc.requirementUseCase).toBe("Annual staff uniform refresh");
  expect(doc.deliveryTimeline).toBe("before the season opens");
});

test("budget status saves, clears, and never disturbs the free-text detail", async () => {
  const l = await lead();
  await patch(l._id, { budgetStatus: "approved", budget: "₹50L approved for FY26", keyObjection: "Late delivery last season" });
  let doc = await Lead.findById(l._id).lean();
  expect(doc.budgetStatus).toBe("approved");
  expect(doc.budget).toBe("₹50L approved for FY26");
  expect(doc.keyObjection).toBe("Late delivery last season");

  // "Not set" must genuinely unset the enum, and leave the detail alone.
  await patch(l._id, { budgetStatus: "" });
  doc = await Lead.findById(l._id).lean();
  expect(doc.budgetStatus).toBeUndefined();
  expect(doc.budget).toBe("₹50L approved for FY26");
});

test("an existing free-text budget is preserved untouched and stays editable", async () => {
  const l = await lead();
  await Lead.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(l._id)) },
    { $set: { budget: "roughly 40 lakh, not approved" } },
  );
  await patch(l._id, { budgetStatus: "indicative" });
  let doc = await Lead.findById(l._id).lean();
  expect(doc.budget).toBe("roughly 40 lakh, not approved");   // never reinterpreted

  await patch(l._id, { budget: "45 lakh, approved" });
  doc = await Lead.findById(l._id).lean();
  expect(doc.budget).toBe("45 lakh, approved");
});

/* ══ EVIDENCE COUNTS WHEREVER IT WAS TYPED, IF IT IS THE RIGHT EVIDENCE ═══ */

const researched = {
  estimatedAnnualQuantity: 1200,
  estimatedAnnualQuantityConfidence: "researched",
};

test("a researched estimate with neither inline source nor evidence stays blocked", async () => {
  const l = await lead();
  await patchOk(l._id, researched);
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(false);
});

test("an Evidence item for that exact claim satisfies it", async () => {
  const l = await lead();
  await patchOk(l._id, {
    ...researched,
    evidence: [{ claim: "annual_quantity", evidenceType: "internal_note", note: "Counted ~600 wearers per property on 12 Nov." }],
  });
  const doc = await Lead.findById(l._id).lean();
  // The state the rule is about must actually be on the record.
  expect(doc.estimatedAnnualQuantity).toBe(1200);
  expect(doc.estimatedAnnualQuantityConfidence).toBe("researched");
  expect(doc.evidence).toHaveLength(1);
  expect(doc.evidence[0].claim).toBe("annual_quantity");
  expect(check(doc, "estimatesEvidenced").met).toBe(true);
});

test("evidence for a different claim does not satisfy it", async () => {
  const l = await lead();
  await patchOk(l._id, {
    ...researched,
    evidence: [{ claim: "requirement", evidenceType: "contact_statement", note: "Ramesh confirmed 400 shirts." }],
  });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(false);
});

test("a general evidence note does not satisfy an estimate", async () => {
  const l = await lead();
  await patchOk(l._id, {
    ...researched,
    evidence: [{ claim: "general", evidenceType: "website", note: "They have two properties." }],
  });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(false);
});

test("an empty evidence row naming the claim proves nothing", async () => {
  const l = await lead();
  await patchOk(l._id, { ...researched, evidence: [{ claim: "annual_quantity", evidenceType: "other" }] });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(false);
});

test("the inline source still works on its own", async () => {
  const l = await lead();
  await patchOk(l._id, { ...researched, estimatedAnnualQuantitySource: "Site visit, 12 Nov 2026" });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(true);
});

test("an assumed estimate needs no support at all", async () => {
  const l = await lead();
  await patchOk(l._id, { estimatedAnnualQuantity: 1200, estimatedAnnualQuantityConfidence: "assumed" });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(true);
});

test("unit price has no claim code, so its inline source remains the only support", async () => {
  const l = await lead();
  await patchOk(l._id, {
    estimatedUnitPrice: 720,
    estimatedUnitPriceConfidence: "researched",
    evidence: [{ claim: "annual_revenue", evidenceType: "industry_report", note: "Band from the 2026 report." }],
  });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(false);

  await patchOk(l._id, { estimatedUnitPriceSource: "Quotation from a comparable account" });
  expect(check(await Lead.findById(l._id).lean(), "estimatesEvidenced").met).toBe(true);
});
