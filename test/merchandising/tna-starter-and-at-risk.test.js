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
const { TnaPlan, TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
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
  for (const r of ["executionRoute", "tnaRoute", "handoverPackRoute", "ppmRoute"]) {
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
const LEGACY_MILESTONES = starter.LEGACY_STARTER_MILESTONES.map((m) => (m.milestoneCode === "FINAL_INSPECTION"
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
    /* ── WHAT THE STARTER NO LONGER PLACES, AND WHY ────────────────────
       This test used to assert that final inspection fell before its drop's
       ex-factory and after production started. None of those three is in the
       starter any more: each is completed by a system action no application
       publishes, so a version containing one cannot be published — a schedule
       must not commit to a date nothing can ever meet. They stay on the
       company's milestone list, ready to place when their producer exists.

       So the starter's plan is shorter, and this asserts that plainly rather
       than quietly dropping the check. The anchor arithmetic those rows
       exercised is covered directly in `tna-calendar-graph.test.js`. */
    const placed = plan.body.milestones.map((m) => m.milestoneCode);
    expect([...new Set(placed)].sort())
      .toEqual(starter.STARTER_PLACEMENTS.map((p) => p.milestoneCode).sort());
    for (const notYet of ["FINAL_INSPECTION", "EX_FACTORY", "PRODUCTION_START"]) {
      expect(placed).not.toContain(notYet);
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
    /* ── WRITTEN STRAIGHT TO DISK, AND THAT IS THE POINT ────────────────
       This version is HISTORY: what a company published before milestones
       came from a company-controlled list. It cannot be created through
       `createVersion` any more, because a step may no longer type its own
       milestone name — which is exactly the defect the list fixed. Reaching
       for the model here is not a shortcut around the new rule; the state
       being reproduced predates it, and the repair path below must still
       work against a company that holds one. */
    await TnaTemplateVersion.create({
      companyId: co._id, templateId: tpl.template.id, versionNo: 1, state: "PUBLISHED",
      milestones: LEGACY_MILESTONES,
      dependencies: LEGACY_DEPENDENCIES.map((d, i) => ({ ...d, dependencyRef: `DEP-${i + 1}` })),
      effectiveFrom: "2026-01-01", effectiveTo: null,
      defaultCalendarId: cal.calendarId, publishedAt: new Date(),
    });
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

  test("the repair is reported and refused, and changes nothing at all", async () => {
    /* ── WHY THIS REVERSED ─────────────────────────────────────────────
       This repair republished the starter with final inspection re-anchored.
       Six of those ten milestones can no longer be published, because nothing
       publishes the events that would complete them — so the only version it
       could create now is one MISSING six of the company's milestones. That is
       not a repair, and doing it quietly would be worse than the defect.

       The defect also matters less than it did: final inspection is one of the
       six, so it is already shown as not integrated and already kept out of
       every overdue, at-risk and next-action figure.

       Re-anchoring a milestone inside a company's own published template is
       now a decision for whoever owns that template. */
    const { co, templateId } = await legacyCompany();
    const call = caller(co, await owner(co));

    const earlyFile = await acceptedFile(co, call, { product: "Kurta", deliveries: ORDINARY });
    await call(`/files/${earlyFile}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" } });
    const earlyPlanBefore = await TnaPlan.findOne({ companyId: co._id }).lean();
    const v1Before = await TnaTemplateVersion.findOne({ companyId: co._id, templateId, versionNo: 1 }).lean();

    const out = await starter.seedCompany({ _id: co._id }, { apply: true });

    /* Reported, with the six it would have lost named. */
    expect(out.repairBlocked).toEqual(expect.objectContaining({
      wouldLose: expect.arrayContaining(["FINAL_INSPECTION", "EX_FACTORY", "PRODUCTION_START"]),
    }));
    expect(out.template).toBeNull();

    /* And nothing written: no version 2, version 1 byte for byte, plan untouched. */
    expect(await TnaTemplateVersion.countDocuments({ companyId: co._id, templateId })).toBe(1);
    const v1After = await TnaTemplateVersion.findOne({ companyId: co._id, templateId, versionNo: 1 }).lean();
    expect(v1After).toEqual(v1Before);
    const earlyPlanAfter = await TnaPlan.findById(earlyPlanBefore._id).lean();
    expect(earlyPlanAfter.revision).toBe(earlyPlanBefore.revision);
    expect(earlyPlanAfter.templateVersionNo).toBe(1);
  }, 300000);

  test("a plan on the legacy template still reads, and its stuck milestones stay honest", async () => {
    /* The compatibility rule, end to end: history is readable and describes
       itself truthfully, even though none of it could be created today. */
    const { co } = await legacyCompany();
    const call = caller(co, await owner(co));
    const fileId = await acceptedFile(co, call, { product: "Kurta", deliveries: ORDINARY });
    await call(`/files/${fileId}/tna`, { method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" } });

    const plan = await call(`/files/${fileId}/tna`);
    const codes = plan.body.milestones.map((m) => m.milestoneCode);
    /* All ten are there, including the six that could not be published now. */
    for (const code of ["FINAL_INSPECTION", "EX_FACTORY", "PRODUCTION_START"]) {
      expect(codes).toContain(code);
    }
    const stuck = plan.body.milestones.filter((m) => m.notIntegrated);
    expect(stuck.length).toBeGreaterThan(0);
    expect(stuck[0].integrationNote).toMatch(/not connected|does not publish|publishes/i);
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
    /* Any baselined, unfinished milestone will do — what is under test is the
       at-risk figure, not which row slips. Named rows are avoided on purpose:
       this used to pick FABRIC_IN_HOUSE, which the starter no longer places
       because nothing publishes the event that would complete it. */
    const target = plan.body.milestones.find((m) => m.forecastDate && m.baselineDate && !m.actualDate);
    expect(target).toBeDefined();
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

/* ══ 3 — THE TWO WIRED MOMENTS, ON A REAL STARTER PLAN ════════════════════ */

describe("a starter plan's milestones close from their own source records", () => {
  /**
   * ── WHAT THIS EXISTS TO CATCH ──────────────────────────────────────────
   * The production-readiness meeting and the execution pack both publish an
   * event, and Time & Action consumes both. They were wired, tested against
   * synthetic events, and then not placed in any real plan: the starter
   * template was still derived from a ten-row snapshot written before the
   * publication rule, so a newly seeded company's schedule had no milestone for
   * either. Wired end to end, and used by nobody.
   *
   * So this uses the REAL seeded starter, drives the REAL services, and proves
   * the two milestones close separately — the meeting from its issued minutes,
   * the pack from its submitted version — each carrying a reference back to the
   * record that closed it.
   */
  /** The starter, a file, a baselined plan, and the two people who act. */
  async function readyFile() {
    const co = await Acc_Company.create({
      companyName: `Wired Co ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    await starter.seedCompany({ _id: co._id }, { apply: true });
    /* ── TWO PEOPLE, BECAUSE THE PRODUCT INSISTS ────────────────────────
       Minutes are issued by somebody other than the person who took them, and
       a pack is submitted by somebody other than the person who prepared it.
       One actor here returns 409 `PPM_SELF_ISSUE`, which is the rule working. */
    const maker = await owner(co);
    const checker = await owner(co);
    const call = caller(co, maker);
    const asChecker = caller(co, checker);
    const fileId = await acceptedFile(co, call, { product: "Utility Shirt", deliveries: ORDINARY });
    await call(`/files/${fileId}/tna`, {
      method: "POST", body: { idempotencyKey: uniq(), planStartDate: "2026-10-05" },
    });
    expect([200, 201]).toContain((await approveBaseline(call, fileId)).status);
    return { co, call, asChecker, maker, checker, fileId, planCompany: co._id };
  }

  /**
   * ── THE PACK'S OWN GATE, SATISFIED THE REAL WAY ────────────────────────
   * A pack cannot be submitted until this order's materials, packaging and
   * development work are each approved. That is the product's rule and it is
   * not worked around here — the three revisions are created and approved
   * through the real service, by a maker and a different checker.
   *
   * It also makes this test a truer end to end than it looks: those same three
   * approvals publish the three events that close the starter's other three
   * milestones. So by the time the pack is submitted, five of the plan's five
   * milestones have closed from five separate records, and none of them was
   * ticked by hand.
   */
  /** The least a revision of each family can honestly say about this order. */
  const ROW = Object.freeze({
    MATERIAL_TRIM: {
      group: "FABRIC", componentCode: "FAB-TWILL-240", componentName: "Cotton twill 240gsm",
      colourOrShade: "Indigo", placement: "Body, sleeves, collar",
    },
    PACKAGING: {
      group: "POLYBAG", componentCode: "PB-RECYCLED-01", componentName: "Recycled polybag",
      sizeOrDimension: "300 x 400mm",
    },
    DEVELOPMENT: {
      requirementType: "PRE_PRODUCTION_SAMPLE", title: "Confirm the size M cuff opening",
      brief: "The PP sample measured 5mm wide at the cuff on size M. Correct the pattern before cutting.",
      requiredByDate: "2026-10-20", responsibleApplication: "PRODUCT_DEVELOPMENT",
    },
  });

  async function approveTheThree(co, fileId, makerActor, checkerActor) {
    const selection = require("../../services/merchandising/selection.service");
    const ctx = { companyId: co._id };
    for (const family of ["MATERIAL_TRIM", "PACKAGING", "DEVELOPMENT"]) {
      // eslint-disable-next-line no-await-in-loop
      await selection.createDraft({ ...ctx }, {
        fileId, family, actor: makerActor, idempotencyKey: uniq(),
      }).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const current = await selection.getCurrent(ctx, { fileId, family });
      if (!current?.working) continue;

      /* One row each, because a revision with none cannot be submitted — the
         gate is about the order being described, not about the count. */
      // eslint-disable-next-line no-await-in-loop
      await selection.addRow(ctx, {
        fileId, family, actor: makerActor,
        body: { ...ROW[family], expectedRevision: current.working.revision },
      });
      // eslint-disable-next-line no-await-in-loop
      const withRow = await selection.getCurrent(ctx, { fileId, family });
      // eslint-disable-next-line no-await-in-loop
      await selection.submit(ctx, {
        fileId, family, actor: makerActor, idempotencyKey: uniq(),
        body: { expectedRevision: withRow.working.revision },
      });
      // eslint-disable-next-line no-await-in-loop
      const submitted = await selection.getCurrent(ctx, { fileId, family });
      // eslint-disable-next-line no-await-in-loop
      await selection.approve(ctx, {
        fileId, family, actor: checkerActor, idempotencyKey: uniq(),
        body: { expectedRevision: submitted.working.revision },
      });
    }
    /* The approvals are announced through the outbox; carry them now. */
    await require("../../services/integration/tnaSourceDelivery.service")
      .deliverPending({ companyId: co._id, limit: 50 });
  }

  const milestones = async (call, fileId) => (await call(`/files/${fileId}/tna`)).body.milestones;
  const find = (rows, code) => rows.find((m) => m.milestoneCode === code);

  test("the starter places both, and the meeting comes before the handover", async () => {
    const { call, asChecker, fileId, planCompany } = await readyFile();
    const rows = await milestones(call, fileId);

    const meeting = find(rows, "PP_MEETING_HELD");
    const handover = find(rows, "PPC_HANDOVER");
    expect(meeting).toBeDefined();
    expect(handover).toBeDefined();
    /* The order the work happens in: the meeting settles how the order will be
       made, and the pack goes to production planning afterwards. */
    expect(meeting.forecastDate < handover.forecastDate).toBe(true);
    /* Both open, and neither is "not integrated" — each has a live producer. */
    for (const m of [meeting, handover]) {
      expect(m.actualDate).toBeFalsy();
      expect(m.notIntegrated).toBeFalsy();
    }
  }, 300000);

  test("issuing the minutes closes the meeting milestone and ONLY that one", async () => {
    const { call, asChecker, fileId, planCompany } = await readyFile();

    /* Draft → written up → conducted → issued, through the real routes. */
    await call(`/files/${fileId}/ppm`, { method: "POST", body: { idempotencyKey: uniq() } });
    let ppm = (await call(`/files/${fileId}/ppm`)).body;
    await call(`/files/${fileId}/ppm`, {
      method: "PATCH",
      body: {
        expectedRevision: ppm.working.revision,
        actualMeetingAt: "2026-10-12T09:30:00.000Z",
        locationOrMode: "Factory meeting room 2",
        chairperson: "Production Manager",
        attendees: [{ name: "A Merchandiser", department: "MERCHANDISING", role: "Merchandiser" }],
      },
    });
    ppm = (await call(`/files/${fileId}/ppm`)).body;
    await call(`/files/${fileId}/ppm/conduct`, {
      method: "POST", body: { idempotencyKey: uniq(), expectedRevision: ppm.working.revision },
    });
    ppm = (await call(`/files/${fileId}/ppm`)).body;
    const issued = await asChecker(`/files/${fileId}/ppm/issue`, {
      method: "POST", body: { idempotencyKey: uniq(), expectedRevision: ppm.working.revision },
    });
    expect(issued.status).toBe(200);
    /* The route says the milestone closed, rather than the test assuming it. */
    expect(issued.body.timeAndAction).toMatchObject({ closed: true, retrying: false });

    const rows = await milestones(call, fileId);
    const meeting = find(rows, "PP_MEETING_HELD");
    expect(meeting.status).toBe("COMPLETED");
    expect(meeting.actualDate).toBeTruthy();

    /* ── THE POINT: nothing else moved ──────────────────────────────────
       The pack milestone is a DIFFERENT record's business and is still open. */
    expect(find(rows, "PPC_HANDOVER").actualDate).toBeFalsy();
    expect(find(rows, "PPC_HANDOVER").status).not.toBe("COMPLETED");

    /* And the completion is traceable back to the minutes that closed it —
       no actor, because nobody signed for it by hand. */
    const stored = await TnaMilestone.findOne({
      companyId: planCompany, milestoneCode: "PP_MEETING_HELD",
    }).lean();
    expect(stored.completion).toMatchObject({
      sourceEventKind: "merchandising.pre_production_meeting.issued",
    });
    expect(stored.completion.sourceRecordRef).toBeTruthy();
    expect(stored.completion.sourceRecordVersion).toBe(issued.body.versionNo);
    expect(stored.completedBy).toBeFalsy();
  }, 300000);

  test("submitting the pack closes the handover milestone and ONLY that one", async () => {
    const { co, call, asChecker, maker, checker, fileId, planCompany } = await readyFile();
    await approveTheThree(co, fileId, maker, checker);

    await call(`/files/${fileId}/pack`, { method: "POST", body: { idempotencyKey: uniq() } });
    const opened = (await call(`/files/${fileId}/pack`)).body;
    await call(`/files/${fileId}/pack/refresh`, {
      method: "POST", body: { expectedRevision: opened.pack?.revision },
    });
    const draft = (await call(`/files/${fileId}/pack`)).body;
    const submitted = await asChecker(`/files/${fileId}/pack/submit`, {
      method: "POST",
      body: {
        idempotencyKey: uniq(), declarationAcknowledged: true,
        expectedRevision: draft.pack?.revision,
      },
    });
    /* The body is in the message on failure: a pack refusal names its gates, and
       reading them beats guessing which one bit. */
    expect(submitted.status === 200 ? "submitted" : JSON.stringify(submitted.body))
      .toBe("submitted");
    expect(submitted.body.timeAndAction).toMatchObject({ closed: true, retrying: false });

    const rows = await milestones(call, fileId);
    expect(find(rows, "PPC_HANDOVER").status).toBe("COMPLETED");
    /* The meeting was never held, and submitting a pack does not pretend it was. */
    expect(find(rows, "PP_MEETING_HELD").actualDate).toBeFalsy();

    const stored = await TnaMilestone.findOne({
      companyId: planCompany, milestoneCode: "PPC_HANDOVER",
    }).lean();
    expect(stored.completion).toMatchObject({
      sourceEventKind: "merchandising.execution_pack.submitted",
    });
    expect(stored.completion.sourceRecordRef).toBeTruthy();
    expect(stored.completedBy).toBeFalsy();
  }, 300000);

  test("both, in order, close two different milestones from two different records", async () => {
    const { co, call, asChecker, maker, checker, fileId, planCompany } = await readyFile();
    await approveTheThree(co, fileId, maker, checker);

    await call(`/files/${fileId}/ppm`, { method: "POST", body: { idempotencyKey: uniq() } });
    let ppm = (await call(`/files/${fileId}/ppm`)).body;
    await call(`/files/${fileId}/ppm`, {
      method: "PATCH",
      body: {
        expectedRevision: ppm.working.revision,
        actualMeetingAt: "2026-10-12T09:30:00.000Z",
        locationOrMode: "Factory meeting room 2",
        chairperson: "Production Manager",
        attendees: [{ name: "A Merchandiser", department: "MERCHANDISING", role: "Merchandiser" }],
      },
    });
    ppm = (await call(`/files/${fileId}/ppm`)).body;
    await call(`/files/${fileId}/ppm/conduct`, {
      method: "POST", body: { idempotencyKey: uniq(), expectedRevision: ppm.working.revision },
    });
    ppm = (await call(`/files/${fileId}/ppm`)).body;
    await asChecker(`/files/${fileId}/ppm/issue`, {
      method: "POST", body: { idempotencyKey: uniq(), expectedRevision: ppm.working.revision },
    });

    await call(`/files/${fileId}/pack`, { method: "POST", body: { idempotencyKey: uniq() } });
    const opened = (await call(`/files/${fileId}/pack`)).body;
    await call(`/files/${fileId}/pack/refresh`, {
      method: "POST", body: { expectedRevision: opened.pack?.revision },
    });
    const draft = (await call(`/files/${fileId}/pack`)).body;
    expect((await asChecker(`/files/${fileId}/pack/submit`, {
      method: "POST",
      body: {
        idempotencyKey: uniq(), declarationAcknowledged: true,
        expectedRevision: draft.pack?.revision,
      },
    })).status).toBe(200);

    const rows = await milestones(call, fileId);
    const meeting = find(rows, "PP_MEETING_HELD");
    const handover = find(rows, "PPC_HANDOVER");
    expect([meeting.status, handover.status]).toEqual(["COMPLETED", "COMPLETED"]);

    /* Two records, two kinds, two different dates — not one event closing both. */
    const companyId = planCompany;
    const both = await TnaMilestone.find({
      companyId, milestoneCode: { $in: ["PP_MEETING_HELD", "PPC_HANDOVER"] },
    }).lean();
    const kinds = both.map((m) => m.completion?.sourceEventKind).sort();
    expect(kinds).toEqual([
      "merchandising.execution_pack.submitted",
      "merchandising.pre_production_meeting.issued",
    ]);
    const refs = both.map((m) => String(m.completion?.sourceRecordRef || ""));
    expect(new Set(refs).size).toBe(2);
  }, 300000);
});
