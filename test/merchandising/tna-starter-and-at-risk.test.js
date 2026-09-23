// test/merchandising/tna-starter-and-at-risk.test.js
//
// THE TWO TIME & ACTION GAPS THE DEMO WALKTHROUGH FOUND, ON A REAL DATABASE.
//
//   1  A plan built from the published starter template could never approve
//      baseline 1. "Final inspection passed" was anchored to the target
//      ex-factory date — a date the Sales handover makes OPTIONAL and an
//      ordinary order does not carry — and had no predecessor, so it had no
//      date at all, and a plan with an undated milestone cannot be committed.
//      Everything behind the baseline — the execution pack and the PPC
//      handover — waited for ever.
//
//   2  The Overview's "Milestones at risk" counted overdue AND forecast-late
//      milestones and opened a view that listed only the overdue ones.
//
// Everything below goes through the mounted routes against an ephemeral
// replica set, with a real live `merchandiser` grant.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const { TnaTemplateVersion } = require("../../models/CMS_Models/Merchandising/TnaTemplate");
const { TnaPlan } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const { WorkingCalendarVersion } = require("../../models/CMS_Models/Merchandising/WorkingCalendar");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const config = require("../../services/merchandising/tnaConfig.service");
const starter = require("../../scripts/readiness/seed-tna-starter");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "tna_starter" });
  const app = express();
  app.use(express.json());
  for (const r of ["executionRoute", "tnaRoute", "handoverPackRoute"]) {
    app.use("/api/cms/merchandising", require(`../../routes/CMS_Routes/Merchandising/${r}`));
  }
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
}, 180000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const uniq = () => `k-${++seq}-${Date.now()}`;

function caller(co, who) {
  return (path, { method = "GET", body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${who.token}`,
      "X-Costing-Company": String(co._id),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed };
  });
}

async function owner(co) {
  const n = ++seq;
  const email = `tna-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "T", lastName: `A${n}`, email, biometricId: `TA${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `Owner ${n}`, email, passwordHash: "x", isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `Owner ${n}` });
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email, name: `Owner ${n}`, role: "owner", isActive: true,
    departmentId: new mongoose.Types.ObjectId(),
  });
  return {
    name: `Owner ${n}`, email,
    token: jwt.sign({ id: String(emp._id), email, name: `Owner ${n}`, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "30m" }),
  };
}

/**
 * An accepted Execution File for an ORDINARY order: committed delivery dates
 * and nothing else. No target ex-factory date — which is exactly the order the
 * starter template could not plan.
 */
async function acceptedFile(co, call, { product, deliveries, statesExFactory = false }) {
  const n = ++seq;
  const account = await Account.create({ companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-TNA-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "S",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-TNA-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: product, isActive: true, products: [{ product, quantity: 600 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-TNA-${n}`, styleCode: `SC-TNA-${n}`, productName: product,
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
  });
  const order = await CustomerRequest.create({
    requestId: `REQ-TNA-${n}`, status: "quotation_sales_approved", orderOrigin: "customer",
    customerInfo: { name: `Buyer ${n}` },
    items: [{ stockItemName: product, totalQuantity: 600, sampleStyleId: style._id }],
  });
  const saved = await CustomerRequest.findById(order._id).lean();
  if (!statesExFactory) for (const d of deliveries) expect(d.targetExFactoryDate).toBeUndefined();
  const out = await producer.issue({ companyId: co._id }, {
    requestId: String(order._id), lineId: String(saved.items[0].lineRef),
    body: {
      expectedCurrentVersionNo: 0, deliveries,
      breakdown: [{ lineSplitRef: "S1", sizeRange: "S-XL", quantity: 600,
        attributes: [{ name: "Colourway", value: "Ecru" }] }],
    },
    actor: { name: "Sales" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId: out.correlationId });
  const accepted = await call(`/handovers/${out.version._id}/accept`, {
    method: "POST", body: { idempotencyKey: uniq() },
  });
  expect([200, 201]).toContain(accepted.status);
  return accepted.body.file.id;
}

const ORDINARY = [
  { dropRef: "D1", committedDeliveryDate: "2027-02-15", quantity: 360 },
  { dropRef: "D2", committedDeliveryDate: "2027-03-10", quantity: 240 },
];

async function approveBaseline(call, fileId) {
  const plan = await call(`/files/${fileId}/tna`);
  return call(`/files/${fileId}/tna/baseline/approve`, {
    method: "POST", body: { idempotencyKey: uniq(), expectedRevision: plan.body.plan.revision },
  });
}

/* The starter exactly as it was first published — for the company that
   already has it. Derived from the current definition, so the only
   difference is the defect itself. */
const LEGACY_MILESTONES = starter.MILESTONES.map((m) => (m.milestoneCode === "FINAL_INSPECTION"
  ? { ...m, anchor: "EX_FACTORY", offsetWorkingDays: -3, scope: "FILE" }
  : m));
const LEGACY_DEPENDENCIES = starter.DEPENDENCIES.filter((d) => !(
  (d.predecessorCode === "PRODUCTION_START" && d.successorCode === "FINAL_INSPECTION")
  || (d.predecessorCode === "FINAL_INSPECTION" && d.successorCode === "EX_FACTORY")));

/* ══ 1 — THE STARTER TEMPLATE ═════════════════════════════════════════════ */

describe("a plan from the published starter can commit to a schedule", () => {
  test("every milestone has a date, baseline 1 approves, and the pack's T&A gate passes", async () => {
    const co = await Acc_Company.create({ companyName: "Starter Co", booksFromDate: new Date("2026-04-01") });
    await starter.seedCompany({ _id: co._id }, { apply: true });
    const me = await owner(co);
    const call = caller(co, me);
    const fileId = await acceptedFile(co, call, { product: "Oxford Shirt", deliveries: ORDINARY });

    /* Before the baseline, the pack gate is honestly closed. */
    await call(`/files/${fileId}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" } });
    const gateBefore = await call(`/files/${fileId}/pack/preview`);
    expect(JSON.stringify(gateBefore.body)).toMatch(/"key":"TNA_BASELINED","passed":false/);

    const plan = await call(`/files/${fileId}/tna`);
    const undated = plan.body.milestones.filter((m) => !m.forecastDate);
    expect(undated.map((m) => m.milestoneCode)).toEqual([]);
    /* Final inspection is per drop now, and falls before its drop's ex-factory. */
    const fi = plan.body.milestones.filter((m) => m.milestoneCode === "FINAL_INSPECTION");
    const ex = plan.body.milestones.filter((m) => m.milestoneCode === "EX_FACTORY");
    expect(fi.map((m) => m.dropRef).sort()).toEqual(["D1", "D2"]);
    for (const f of fi) {
      const x = ex.find((e) => e.dropRef === f.dropRef);
      expect(f.forecastDate < x.forecastDate).toBe(true);
      /* And never before production has started. */
      const ps = plan.body.milestones.find((m) => m.milestoneCode === "PRODUCTION_START");
      expect(f.forecastDate > ps.forecastDate).toBe(true);
    }

    const approved = await approveBaseline(call, fileId);
    expect([200, 201]).toContain(approved.status);

    /* Proceeds toward the execution-pack gate: the T&A gate is now open. */
    const gateAfter = await call(`/files/${fileId}/pack/preview`);
    expect(JSON.stringify(gateAfter.body)).toMatch(/"key":"TNA_BASELINED","passed":true/);
  }, 240000);

  test("an order that does state a target ex-factory still plans the same way", async () => {
    /* The fix does not depend on the field being absent: a Sales handover that
       carries ex-factory dates gets the same dated, baselinable plan. */
    const co = await Acc_Company.create({ companyName: "Stated Co", booksFromDate: new Date("2026-04-01") });
    await starter.seedCompany({ _id: co._id }, { apply: true });
    const call = caller(co, await owner(co));
    const fileId = await acceptedFile(co, call, {
      product: "Chino", statesExFactory: true,
      deliveries: [{ dropRef: "D1", committedDeliveryDate: "2027-02-15", targetExFactoryDate: "2027-02-01", quantity: 600 }],
    });
    await call(`/files/${fileId}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" } });
    const approved = await approveBaseline(call, fileId);
    expect([200, 201]).toContain(approved.status);
  }, 240000);
});

describe("a company that already published the defective starter", () => {
  async function legacyCompany() {
    const co = await Acc_Company.create({ companyName: "Legacy Co", booksFromDate: new Date("2026-04-01") });
    /* Everything the starter seeds, except the template — which is published
       the way it first shipped. */
    await starter.seedCompany({ _id: co._id }, { apply: true, skipTemplate: true });
    const ctx = { companyId: co._id };
    const actor = { name: "Starter configuration" };
    const tpl = await config.createTemplate(ctx, { body: { name: starter.STARTER_TEMPLATE }, actor });
    const cal = await WorkingCalendarVersion.findOne({ companyId: co._id, state: "PUBLISHED" }).lean();
    const v1 = await config.createVersion(ctx, {
      templateId: tpl.template.id, actor,
      body: {
        milestones: LEGACY_MILESTONES, dependencies: LEGACY_DEPENDENCIES,
        effectiveFrom: "2026-01-01", defaultCalendarId: String(cal.calendarId),
      },
    });
    await config.publishVersion(ctx, { templateId: tpl.template.id, versionNo: v1.version.versionNo, actor });
    return { co, templateId: tpl.template.id };
  }

  test("reproduction: its plans cannot approve baseline 1", async () => {
    const { co } = await legacyCompany();
    const call = caller(co, await owner(co));
    const fileId = await acceptedFile(co, call, { product: "Polo", deliveries: ORDINARY });
    await call(`/files/${fileId}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" } });
    const refused = await approveBaseline(call, fileId);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/FINAL_INSPECTION/);
  }, 240000);

  test("the repair publishes a corrected version and leaves version 1 exactly as it was", async () => {
    const { co, templateId } = await legacyCompany();
    const call = caller(co, await owner(co));

    /* A plan created before the repair stays pinned to version 1. */
    const earlyFile = await acceptedFile(co, call, { product: "Kurta", deliveries: ORDINARY });
    await call(`/files/${earlyFile}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" } });
    const earlyPlanBefore = await TnaPlan.findOne({ companyId: co._id }).lean();

    const v1Before = await TnaTemplateVersion.findOne({ companyId: co._id, templateId, versionNo: 1 }).lean();
    const out = await starter.seedCompany({ _id: co._id }, { apply: true });
    expect(out.template).toEqual(expect.objectContaining({ repairedFromVersionNo: 1, versionNo: 2 }));

    /* Version 1's content is untouched; only its window closed, which is what
       publishing any successor does. */
    const v1After = await TnaTemplateVersion.findOne({ companyId: co._id, templateId, versionNo: 1 }).lean();
    const { effectiveTo: _a, updatedAt: _b, __v: _c, ...v1BeforeContent } = v1Before;
    const { effectiveTo: _d, updatedAt: _e, __v: _f, ...v1AfterContent } = v1After;
    expect(v1AfterContent).toEqual(v1BeforeContent);
    expect(v1After.state).toBe("PUBLISHED");

    /* The running plan is not rewritten. */
    const earlyPlanAfter = await TnaPlan.findById(earlyPlanBefore._id).lean();
    expect(earlyPlanAfter.templateVersionNo).toBe(1);
    expect(earlyPlanAfter.revision).toBe(earlyPlanBefore.revision);

    /* A NEW plan — even one that starts on a date inside version 1's original
       window — gets the corrected version and can commit. */
    const newFile = await acceptedFile(co, call, { product: "Hoodie", deliveries: ORDINARY });
    await call(`/files/${newFile}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-03-02" } });
    const newPlan = await TnaPlan.findOne({ companyId: co._id, fileId: newFile }).lean();
    expect(newPlan.templateVersionNo).toBe(2);
    const approved = await approveBaseline(call, newFile);
    expect([200, 201]).toContain(approved.status);

    /* Running the seed again repairs nothing further. */
    const again = await starter.seedCompany({ _id: co._id }, { apply: true });
    expect(again.template).toBeNull();
    expect(await TnaTemplateVersion.countDocuments({ companyId: co._id, templateId })).toBe(2);
  }, 300000);

  test("a company's own edited template is never touched by the repair", async () => {
    const { co, templateId } = await legacyCompany();
    const ctx = { companyId: co._id };
    /* The company renamed it: it is theirs now, whatever it contains. */
    await mongoose.model("TnaTemplate").updateOne({ _id: templateId }, { $set: { name: "Our garment order" } });
    const out = await starter.seedCompany({ _id: co._id }, { apply: true });
    expect(out.template).toBeNull();
    expect(await TnaTemplateVersion.countDocuments(ctx)).toBe(1);
  }, 240000);

  test("without --apply the repair only reports", async () => {
    const { co, templateId } = await legacyCompany();
    const out = await starter.seedCompany({ _id: co._id }, { apply: false });
    expect(out.repairable).toEqual(expect.objectContaining({ versionNo: 1 }));
    expect(await TnaTemplateVersion.countDocuments({ companyId: co._id, templateId })).toBe(1);
  }, 240000);
});

/* ══ 2 — MILESTONES AT RISK ═══════════════════════════════════════════════ */

describe("the Overview's at-risk figure opens exactly the records it counted", () => {
  test("with BOTH overdue and forecast-late milestones present", async () => {
    const co = await Acc_Company.create({ companyName: "Risk Co", booksFromDate: new Date("2026-04-01") });
    await starter.seedCompany({ _id: co._id }, { apply: true });
    const call = caller(co, await owner(co));

    /* Overdue: a plan that started in the summer, whose early milestones'
       forecasts are before today and not done. */
    const late = await acceptedFile(co, call, { product: "Denim", deliveries: ORDINARY });
    await call(`/files/${late}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-07-06" } });

    /* Forecast late: a baselined plan whose milestone is now expected after
       the committed date, but not yet past today. */
    const slipping = await acceptedFile(co, call, { product: "Skirt", deliveries: ORDINARY });
    await call(`/files/${slipping}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-11-02" } });
    expect([200, 201]).toContain((await approveBaseline(call, slipping)).status);
    const plan = await call(`/files/${slipping}/tna`);
    const target = plan.body.milestones.find((m) => m.milestoneCode === "FABRIC_IN_HOUSE"
      && m.forecastDate && m.baselineDate && !m.actualDate);
    const later = new Date(new Date(`${target.baselineDate}T00:00:00Z`).getTime() + 12 * 86400000)
      .toISOString().slice(0, 10);
    const reason = (await call("/tna/reason-codes")).body;
    const reasonCode = (reason.reasonCodes || reason.rows || reason.codes || [])[0]?.code;
    const moved = await call(`/files/${slipping}/tna/milestones/${encodeURIComponent(target.milestoneRef)}/forecast`, {
      method: "PATCH",
      body: { idempotencyKey: uniq(), expectedRevision: target.revision, forecastDate: later,
        reasonCode, note: "Mill confirmed the fabric ships a fortnight late." },
    });
    expect([200, 201]).toContain(moved.status);

    const counts = (await call("/tna/portfolio/counts")).body.counts;
    expect(counts.overdue).toBeGreaterThan(0);
    expect(counts["forecast-late"]).toBeGreaterThan(0);

    /* The Overview figure… */
    const overview = (await call("/execution/overview")).body.counts;
    expect(overview.deliveryAtRisk).toBe(counts.overdue + counts["forecast-late"]);

    /* …and the view it opens, which lists exactly those records. */
    const atRisk = await call("/tna/portfolio?view=at-risk&limit=200");
    expect(atRisk.status).toBe(200);
    const rows = atRisk.body.rows;
    expect(rows).toHaveLength(overview.deliveryAtRisk);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(["OVERDUE", "FORECAST_LATE"]));
    expect(counts["at-risk"]).toBe(overview.deliveryAtRisk);

    /* Row for row the union of the two views it stands for. */
    const overdue = (await call("/tna/portfolio?view=overdue&limit=200")).body.rows;
    const fl = (await call("/tna/portfolio?view=forecast-late&limit=200")).body.rows;
    const key = (r) => `${r.fileId}:${r.milestoneRef}`;
    expect(rows.map(key).sort()).toEqual([...overdue, ...fl].map(key).sort());
  }, 300000);
});
