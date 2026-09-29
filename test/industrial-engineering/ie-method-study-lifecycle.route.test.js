// test/industrial-engineering/ie-method-study-lifecycle.route.test.js
//
// IE CHUNK 4B — SUBMIT, RETURN, APPROVE, AND THE STANDARD TIME, AT THE WIRE.
//
// This is where a timed study becomes a number other people will plan and cost
// against, so the claims worth holding are the ones that make that number
// defensible:
//
//   · a submission FREEZES everything — the cycles, the rating, the normal time
//     and the exact published allowance policy effective on the day it was
//     studied — so a policy published next year restates nothing;
//   · standard time is normal time plus allowances, rounded once, to four
//     decimals, and missing inputs are null rather than zero;
//   · a manual override never hides what the calculation said, and never
//     travels without a reason;
//   · the submitter cannot return or approve their own submission, and an owner
//     or platform administrator is refused on identical terms;
//   · a study in review cannot be edited, an approved one cannot be touched at
//     all, and re-timing means a NEW study beside the approved evidence;
//   · every attempt survives, including the returned ones;
//   · one atomic write moves status, submission, revision and audit together —
//     two simultaneous decisions cannot both land, and a stale request is
//     refused even when the outcome it asks for already looks true;
//   · and nothing is written into the bulletin or released anywhere.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const IeOperation = require("../../models/CMS_Models/IndustrialEngineering/IeOperation");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");
const IeAllowancePolicy = require("../../models/CMS_Models/IndustrialEngineering/IeAllowancePolicy");

const { calculateStandardTime } = require("../../services/industrialEngineering/standardTimeCalculation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  await IeMethodStudy.syncIndexes();
  await IeAllowancePolicy.syncIndexes();
  await IeStyleFile.syncIndexes();
  await IeOperation.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = JSON.parse(text || "null"); } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `ms${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `S${n}`, email, biometricId: `MS${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `IE Person ${n}`, role: "employee", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const approverIn = (...cos) => actor({ companies: cos, grants: { ie: "approver" } });
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

const approvedRevision = (revision) => ({
  revision, submittedAt: new Date("2026-08-01"), outcome: "approved", decidedAt: new Date("2026-08-05"),
  snapshot: {
    revision, materials: [], requirements: [],
    operations: [{
      operationId: String(new mongoose.Types.ObjectId()), operationCode: "SEW-1",
      name: "Side seam", machineType: "SNLS", minutes: 1, seconds: 0, samMinutes: 1, notes: "",
    }],
  },
});

/**
 * A company with: a published allowance policy (15.5%), an engineering file
 * whose bulletin holds two rows, and a DRAFT method study on the first row that
 * is complete enough to submit.
 */
async function world(name, {
  policyCategories = [
    { code: "PERSONAL", name: "Personal allowance", percent: 5 },
    { code: "FATIGUE", name: "Fatigue allowance", percent: 8 },
    { code: "DELAY", name: "Unavoidable delay", percent: 2.5 },
  ],
  policyEffectiveFrom = "2026-01-01",
  publishPolicy = true,
  fillStudy = true,
} = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: `Journey ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `Enquiry ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
  });
  const item = await StockItem.create({
    name: `Tee ${name}`, sku: `SKU-${name}-${n}`, reference: `REF-${name}-${n}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${n}`, cost: 0, salesPrice: 0 }],
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${n}`,
    stockItemId: item._id, stockItemName: item.name, stockItemReference: item.reference,
    quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
    estimatedCost: 184000, actualCost: 190500,
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: `Tee ${name}`,
    styleCode: `ST-${name}`, variantLabel: "Navy",
    journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
    materials: { status: "pending", rawItems: [] },
    techSheet: { technical: { status: "approved", revision: 3 }, technicalRevisions: [approvedRevision(3)] },
    production: { workOrderIds: [wo._id] },
  });

  const maker = await editorIn(co);
  const approver = await approverIn(co);

  /* The allowance policy, made properly: a third person drafts it so the
     approver above is free to publish, and free to review studies later. */
  let policy = null;
  if (publishPolicy) {
    const policyAuthor = await editorIn(co);
    const drafted = await call("/allowance-policies", {
      method: "POST", token: policyAuthor.token, company: co._id,
      body: { name: "Standard sewing allowance", effectiveFrom: policyEffectiveFrom, categories: policyCategories },
    });
    expect(drafted.status).toBe(201);
    const publishedRes = await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
      method: "POST", token: approver.token, company: co._id,
      body: { expectedRevision: drafted.body.policy.revision },
    });
    expect(publishedRes.status).toBe(200);
    policy = publishedRes.body.policy;
  }

  const opened = await call(`/orders/${wo._id}/styles/${style._id}/engineering-file`, {
    method: "POST", token: maker.token, company: co._id, body: {},
  });
  expect(opened.status).toBe(201);
  const fileId = opened.body.file.fileId;

  const sew = (await call("/operations/library", {
    method: "POST", token: maker.token, company: co._id,
    body: { code: "SEW-01", name: "Side seam", machineType: "SNLS" },
  })).body.operation;
  const hem = (await call("/operations/library", {
    method: "POST", token: maker.token, company: co._id,
    body: { code: "HEM-01", name: "Hem", machineType: "FOA" },
  })).body.operation;

  const bulletin = await call(`/engineering-files/${fileId}/bulletin`, {
    method: "PATCH", token: maker.token, company: co._id,
    body: {
      expectedRevision: 1,
      rows: [
        { ieOperationId: sew.operationId, proposedSamMinutes: 1.5 },
        { ieOperationId: hem.operationId, proposedSamMinutes: 0.5 },
      ],
    },
  });
  expect(bulletin.status).toBe(200);
  const [row, secondRow] = bulletin.body.file.bulletin.rows;

  const openedStudy = await call(`/engineering-files/${fileId}/bulletin/${row.rowId}/method-studies`, {
    method: "POST", token: maker.token, company: co._id, body: {},
  });
  expect(openedStudy.status).toBe(201);
  let study = openedStudy.body.study;

  if (fillStudy) {
    /* 60s and 70s included, one excluded — 65s observed, 110% rating → 71.5s
       normal, and 15.5% allowance → 82.5825s standard. */
    const filled = await call(`/method-studies/${study.studyId}`, {
      method: "PATCH", token: maker.token, company: co._id,
      body: {
        expectedRevision: study.revision,
        studiedAt: "2026-09-08T04:30:00.000Z",
        location: "Line 4",
        methodNote: "Two-hand method, guide fitted",
        evidenceNote: "Stopwatch, snap-back",
        ratingPercent: 110,
        observations: [
          { durationSeconds: 60 },
          { durationSeconds: 70 },
          { durationSeconds: 900, included: false, exclusionReason: "Thread break mid-cycle" },
        ],
      },
    });
    expect(filled.status).toBe(200);
    study = filled.body.study;
  }

  return { co, style, workOrder: wo, fileId, row, secondRow, sew, hem, maker, approver, policy, study,
    fileRevision: bulletin.body.file.revision };
}

const submit = (a, w, studyId, body = {}) => call(`/method-studies/${studyId}/submit`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const doReturn = (a, w, studyId, body) => call(`/method-studies/${studyId}/return`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const approve = (a, w, studyId, body) => call(`/method-studies/${studyId}/approve`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const readStudy = (a, w, studyId) => call(`/method-studies/${studyId}`, { token: a.token, company: w.co._id });
const submissions = (a, w, studyId) => call(`/method-studies/${studyId}/submissions`, { token: a.token, company: w.co._id });

/* ══ 1. READINESS ═════════════════════════════════════════════════════════ */

describe("what has to be true before a study can be submitted", () => {
  test("every missing requirement is named, each with its own code", async () => {
    const w = await world("Readiness", { fillStudy: false });
    const res = await readStudy(w.maker, w, w.study.studyId);

    expect(res.body.study.canSubmit).toBe(false);
    const codes = res.body.study.submissionReadiness.gaps.map((g) => g.code).sort();
    expect(codes).toEqual([
      "IE_STUDY_CALCULATION_INCOMPLETE",
      "IE_STUDY_DATE_MISSING",
      "IE_STUDY_LOCATION_MISSING",
      "IE_STUDY_METHOD_NOTE_MISSING",
      "IE_STUDY_NO_INCLUDED_OBSERVATION",
      "IE_STUDY_RATING_MISSING",
    ]);
    for (const g of res.body.study.submissionReadiness.gaps) {
      expect(g).toMatchObject({ owner: "INDUSTRIAL_ENGINEERING", action: expect.any(String), message: expect.any(String) });
    }
    expect(res.body.study.availableActions).toEqual(["EDIT"]);

    /* And submitting says the same thing rather than a generic refusal. */
    const refused = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_METHOD_STUDY_NOT_READY");
    expect(refused.body.error.details.gaps.map((g) => g.code).sort()).toEqual(codes);
    expect((await IeMethodStudy.findById(w.study.studyId).lean()).status).toBe("DRAFT");
  });

  test("a study with no allowance policy for its date names that, and only that", async () => {
    /* The policy is effective from October; the study was made in September. */
    const w = await world("NoPolicyYet", { policyEffectiveFrom: "2026-10-01" });
    const res = await readStudy(w.maker, w, w.study.studyId);

    const gaps = res.body.study.submissionReadiness.gaps;
    expect(gaps.map((g) => g.code)).toEqual(["IE_STUDY_NO_EFFECTIVE_ALLOWANCE_POLICY"]);
    expect(gaps[0]).toMatchObject({ action: "PUBLISH_ALLOWANCE_POLICY", requestedDate: "2026-09-08" });
    expect(res.body.study.canSubmit).toBe(false);

    const refused = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    expect(refused.body.error.code).toBe("IE_METHOD_STUDY_NOT_READY");
    expect(refused.body.error.details.gaps[0].code).toBe("IE_STUDY_NO_EFFECTIVE_ALLOWANCE_POLICY");
  });

  test("a complete study says it can be submitted", async () => {
    const w = await world("Ready");
    const res = await readStudy(w.maker, w, w.study.studyId);
    expect(res.body.study.submissionReadiness).toEqual({ ready: true, gaps: [] });
    expect(res.body.study.canSubmit).toBe(true);
    expect(res.body.study.availableActions).toEqual(["EDIT", "SUBMIT"]);
    /* The Chunk 4A fields are all still there and unchanged in shape. */
    expect(res.body.study.result).toEqual({
      includedCycleCount: 2, excludedCycleCount: 1, averageObservedSeconds: 65,
      ratingPercent: 110, normalTimeSeconds: 71.5, normalTimeMinutes: 1.1917, calculationComplete: true,
    });
    expect(res.body.study.applicability).toBe("CURRENT");
    expect(res.body.study.observations).toHaveLength(3);
    expect(res.body.study.history.map((e) => e.type)).toEqual(["METHOD_STUDY_EDITED", "METHOD_STUDY_CREATED"]);
  });

  test("a superseded or removed row cannot be submitted", async () => {
    for (const [name, rowsAfter] of [
      ["Replaced", (w) => [{ rowId: w.row.rowId, ieOperationId: w.hem.operationId, proposedSamMinutes: 1.5 }]],
      ["Removed", (w) => [{ rowId: w.secondRow.rowId, ieOperationId: w.hem.operationId, proposedSamMinutes: 0.5 }]],
    ]) {
      const w = await world(name);
      const moved = await call(`/engineering-files/${w.fileId}/bulletin`, {
        method: "PATCH", token: w.maker.token, company: w.co._id,
        body: { expectedRevision: w.fileRevision, rows: rowsAfter(w) },
      });
      expect(moved.status).toBe(200);

      const res = await readStudy(w.maker, w, w.study.studyId);
      expect(res.body.study.applicability).toBe(name === "Replaced" ? "OPERATION_CHANGED" : "ROW_REMOVED");
      expect(res.body.study.submissionReadiness.gaps.map((g) => g.code)).toContain("IE_STUDY_NOT_CURRENT");
      expect(res.body.study.canSubmit).toBe(false);
      expect(res.body.study.availableActions).toEqual([]);

      const refused = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe("IE_METHOD_STUDY_NOT_READY");
      expect((await IeMethodStudy.findById(w.study.studyId).lean()).submissions).toEqual([]);
    }
  });
});

/* ══ 2. SUBMISSION FREEZES EVERYTHING ═════════════════════════════════════ */

describe("submitting", () => {
  test("the submission snapshots the study and the exact policy, and calculates the standard time", async () => {
    const w = await world("Submit");
    const res = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });

    expect(res.status).toBe(200);
    expect(res.body.submitted).toBe(true);
    expect(res.body.study.status).toBe("IN_REVIEW");
    expect(res.body.study.revision).toBe(w.study.revision + 1);
    expect(res.body.study.editable).toBe(false);
    expect(res.body.study.availableActions).toEqual(["RETURN", "APPROVE"]);

    const sub = res.body.submission;
    expect(sub.status).toBe("IN_REVIEW");
    expect(sub.sourceStudyRevision).toBe(w.study.revision);
    expect(sub.submissionId).toMatch(/^sub_[0-9a-f]{18}$/);
    /* The study's own facts, frozen. */
    expect(sub).toMatchObject({
      studiedAt: "2026-09-08T04:30:00.000Z",
      location: "Line 4",
      methodNote: "Two-hand method, guide fitted",
      evidenceNote: "Stopwatch, snap-back",
      ratingPercent: 110,
    });
    expect(sub.observations).toHaveLength(3);
    expect(sub.observations[2]).toMatchObject({ included: false, exclusionReason: "Thread break mid-cycle" });
    expect(sub.result.normalTimeSeconds).toBe(71.5);
    /* The exact policy — id, revision, name, date, categories and total. */
    expect(sub.allowancePolicy).toMatchObject({
      policyId: w.policy.policyId,
      policyRevision: w.policy.revision,
      name: "Standard sewing allowance",
      effectiveFrom: "2026-01-01",
      totalAllowancePercent: 15.5,
    });
    expect(sub.allowancePolicy.categories.map((c) => c.code)).toEqual(["PERSONAL", "FATIGUE", "DELAY"]);
    /* 71.5 × 1.155 = 82.58250 → 82.5825s → 1.3764 min. */
    expect(sub.calculatedStandardTimeSeconds).toBe(82.5825);
    expect(sub.calculatedStandardTimeMinutes).toBe(1.3764);
    expect(sub.standardTimeSource).toBe("CALCULATED");
    expect(sub.standardTimeSeconds).toBe(82.5825);
    expect(sub.standardTimeMinutes).toBe(1.3764);
    expect(sub.manualStandardTimeMinutes).toBeNull();
    expect(sub.isOverridden).toBe(false);
    expect(sub.submittedByName).toMatch(/^IE Person /);

    /* The study points at it and reports one audit event. */
    expect(res.body.study.currentSubmission).toMatchObject({
      submissionId: sub.submissionId, status: "IN_REVIEW", standardTimeMinutes: 1.3764,
    });
    expect(res.body.study.approvedSubmission).toBeNull();
    expect(res.body.study.approvedStandardTime).toBeNull();
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0].type).toBe("METHOD_STUDY_SUBMITTED");
  });

  test("a policy published afterwards does not restate the submission", async () => {
    const w = await world("PolicyMoves");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const frozen = submitted.body.submission;

    /* A new, much larger policy, effective before the study date. */
    const author = await editorIn(w.co);
    const drafted = await call("/allowance-policies", {
      method: "POST", token: author.token, company: w.co._id,
      body: { name: "Revised", effectiveFrom: "2026-09-01", categories: [{ code: "ALL", name: "Everything", percent: 40 }] },
    });
    const publishedRes = await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
      method: "POST", token: w.approver.token, company: w.co._id, body: { expectedRevision: 1 },
    });
    expect(publishedRes.status).toBe(200);

    /* The submission is untouched — same policy, same total, same figure. */
    const after = await submissions(w.maker, w, w.study.studyId);
    expect(after.body.submissions[0].allowancePolicy.policyId).toBe(w.policy.policyId);
    expect(after.body.submissions[0].allowancePolicy.totalAllowancePercent).toBe(15.5);
    expect(after.body.submissions[0].standardTimeMinutes).toBe(frozen.standardTimeMinutes);

    /* And what a NEW submission would use is the newer policy — proved by
       returning this one and resubmitting. */
    const returned = await doReturn(w.approver, w, w.study.studyId, {
      expectedRevision: submitted.body.study.revision, reason: "Re-time with the new allowances.",
    });
    expect(returned.status).toBe(200);
    const resubmitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: returned.body.study.revision });
    expect(resubmitted.body.submission.allowancePolicy.policyId).toBe(drafted.body.policy.policyId);
    expect(resubmitted.body.submission.allowancePolicy.totalAllowancePercent).toBe(40);
    expect(resubmitted.body.submission.calculatedStandardTimeMinutes).toBe(1.6683);
    /* The first submission is STILL exactly as it was. */
    const both = await submissions(w.maker, w, w.study.studyId);
    expect(both.body.submissions).toHaveLength(2);
    expect(both.body.submissions[1]).toMatchObject({
      status: "RETURNED", standardTimeMinutes: frozen.standardTimeMinutes,
    });
    expect(both.body.submissions[1].allowancePolicy.totalAllowancePercent).toBe(15.5);
  });

  test("a manual override keeps the calculated figure beside it, and needs a reason", async () => {
    const w = await world("Override");

    const noReason = await submit(w.maker, w, w.study.studyId, {
      expectedRevision: w.study.revision, manualStandardTimeMinutes: 1.45,
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("IE_METHOD_STUDY_OVERRIDE_REASON_REQUIRED");
    expect(noReason.body.error.details.field).toBe("overrideReason");

    for (const bad of [0, -1, "1.45"]) {
      const res = await submit(w.maker, w, w.study.studyId, {
        expectedRevision: w.study.revision, manualStandardTimeMinutes: bad, overrideReason: "Because",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_METHOD_STUDY_OVERRIDE_INVALID");
    }
    /* A reason with no number is a body that lost its number. */
    const reasonOnly = await submit(w.maker, w, w.study.studyId, {
      expectedRevision: w.study.revision, overrideReason: "Because",
    });
    expect(reasonOnly.status).toBe(400);
    expect(reasonOnly.body.error.code).toBe("IE_METHOD_STUDY_OVERRIDE_INVALID");
    expect((await IeMethodStudy.findById(w.study.studyId).lean()).submissions).toEqual([]);

    const ok = await submit(w.maker, w, w.study.studyId, {
      expectedRevision: w.study.revision,
      manualStandardTimeMinutes: 1.45,
      overrideReason: "Approved customer method requires fixed handling time.",
    });
    expect(ok.status).toBe(200);
    const sub = ok.body.submission;
    expect(sub.standardTimeSource).toBe("MANUAL_OVERRIDE");
    expect(sub.isOverridden).toBe(true);
    expect(sub.standardTimeMinutes).toBe(1.45);
    expect(sub.standardTimeSeconds).toBe(87);
    /* NEITHER figure is hidden: the calculation is still on the record. */
    expect(sub.calculatedStandardTimeMinutes).toBe(1.3764);
    expect(sub.calculatedStandardTimeSeconds).toBe(82.5825);
    expect(sub.manualStandardTimeMinutes).toBe(1.45);
    expect(sub.overrideReason).toBe("Approved customer method requires fixed handling time.");
    expect(ok.body.study.currentSubmission).toMatchObject({
      standardTimeSource: "MANUAL_OVERRIDE", standardTimeMinutes: 1.45, calculatedStandardTimeMinutes: 1.3764,
    });
  });

  test("an override too large to record is refused, and nothing is written", async () => {
    /* `Number.isFinite` on the incoming value is not enough: rounding
       multiplies by 10,000 and the seconds by 60 again, so a finite JSON number
       can become Infinity on the way to being stored — and `JSON.stringify`
       publishes Infinity as `null`, leaving a MANUAL_OVERRIDE submission with no
       time in it for somebody to approve. */
    const w = await world("OverrideOverflow");
    const before = await IeMethodStudy.findById(w.study.studyId).lean();

    for (const manualStandardTimeMinutes of [
      1e308,      // rounding overflows: 1e308 × 10,000 is Infinity
      1e304,      // minutes survive rounding; the derived SECONDS overflow
      Number.MAX_VALUE,
    ]) {
      const res = await submit(w.maker, w, w.study.studyId, {
        expectedRevision: w.study.revision,
        manualStandardTimeMinutes,
        overrideReason: "Customer method requires a fixed handling time.",
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_METHOD_STUDY_OVERRIDE_INVALID");
      expect(res.body.error.details.field).toBe("manualStandardTimeMinutes");
      expect(res.body.error.details.fieldErrors[0].code).toBe("OUT_OF_RANGE");
    }

    const after = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(after.submissions).toEqual([]);
    expect(after.status).toBe("DRAFT");
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.currentSubmissionId).toBeNull();

    /* A large but recordable override still works — no arbitrary business
       maximum was introduced, only the requirement that it can be stored. */
    const ok = await submit(w.maker, w, w.study.studyId, {
      expectedRevision: w.study.revision,
      manualStandardTimeMinutes: 1000000,
      overrideReason: "Customer method requires a fixed handling time.",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.submission.standardTimeMinutes).toBe(1000000);
    expect(ok.body.submission.standardTimeSeconds).toBe(60000000);
    expect(Number.isFinite(ok.body.submission.standardTimeSeconds)).toBe(true);
  });

  test("a study in review cannot be edited or submitted again", async () => {
    const w = await world("Frozen");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const revision = submitted.body.study.revision;

    const edit = await call(`/method-studies/${w.study.studyId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: revision, location: "Line 7" },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("IE_METHOD_STUDY_TRANSITION_INVALID");
    expect(edit.body.error.details.status).toBe("IN_REVIEW");

    const again = await submit(w.maker, w, w.study.studyId, { expectedRevision: revision });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("IE_METHOD_STUDY_TRANSITION_INVALID");

    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(stored.location).toBe("Line 4");
    expect(stored.revision).toBe(revision);
    expect(stored.submissions).toHaveLength(1);
  });

  test("an editor submits; a viewer cannot", async () => {
    const w = await world("SubmitRole");
    const viewer = await viewerIn(w.co);
    const refused = await submit(viewer, w, w.study.studyId, { expectedRevision: w.study.revision });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    expect((await IeMethodStudy.findById(w.study.studyId).lean()).status).toBe("DRAFT");
  });
});

/* ══ 3. RETURN AND APPROVE ════════════════════════════════════════════════ */

describe("the review decision", () => {
  test("returning needs an approver, a different person, and a reason", async () => {
    const w = await world("Return");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const revision = submitted.body.study.revision;

    /* The submitter holds an editor role, so the role check refuses them first. */
    const bySubmitter = await doReturn(w.maker, w, w.study.studyId, { expectedRevision: revision, reason: "Mine" });
    expect(bySubmitter.status).toBe(403);
    expect(bySubmitter.body.error.code).toBe("IE_WRITE_FORBIDDEN");

    /* The case where the role is NOT what refuses them — an approver returning
       their own submission — is proved in the maker-checker test below. */

    const noReason = await doReturn(w.approver, w, w.study.studyId, { expectedRevision: revision });
    expect(noReason.status).toBe(400);
    expect(noReason.body.error.code).toBe("IE_METHOD_STUDY_REVIEW_REASON_REQUIRED");
    const blankReason = await doReturn(w.approver, w, w.study.studyId, { expectedRevision: revision, reason: "   " });
    expect(blankReason.body.error.code).toBe("IE_METHOD_STUDY_REVIEW_REASON_REQUIRED");

    const ok = await doReturn(w.approver, w, w.study.studyId, {
      expectedRevision: revision, reason: "Repeat the excluded cycle and clarify the method.",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.returned).toBe(true);
    expect(ok.body.study.status).toBe("DRAFT");
    expect(ok.body.study.editable).toBe(true);
    expect(ok.body.study.currentSubmission).toBeNull();
    expect(ok.body.submission).toMatchObject({
      status: "RETURNED",
      reviewNote: "Repeat the excluded cycle and clarify the method.",
    });
    expect(ok.body.submission.reviewedByName).toMatch(/^IE Person /);
    expect(ok.body.events[0].type).toBe("METHOD_STUDY_RETURNED");

    /* The frozen snapshot survives, and the study is editable again. */
    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(stored.submissions).toHaveLength(1);
    expect(stored.submissions[0].standardTimeMinutes).toBe(1.3764);
    expect(stored.currentSubmissionId).toBeNull();
    const edited = await call(`/method-studies/${w.study.studyId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: stored.revision, location: "Line 7" },
    });
    expect(edited.status).toBe(200);
  });

  test("a submitter cannot approve their own submission, whatever their grant", async () => {
    /* Somebody who holds BOTH: they may submit and they may approve, but not the
       same submission. This is the case a role check alone would let through. */
    const w = await world("SelfApprove");
    const both = await actor({ companies: [w.co], grants: { ie: "owner" }, isAdmin: true });
    /* They edit and submit the study themselves. */
    const filled = await call(`/method-studies/${w.study.studyId}`, {
      method: "PATCH", token: both.token, company: w.co._id,
      body: { expectedRevision: w.study.revision, evidenceNote: "Re-checked by me" },
    });
    expect(filled.status).toBe(200);
    const submitted = await submit(both, w, w.study.studyId, { expectedRevision: filled.body.study.revision });
    expect(submitted.status).toBe(200);

    const own = await approve(both, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });
    expect(own.status).toBe(403);
    expect(own.body.error.code).toBe("IE_METHOD_STUDY_MAKER_CHECKER");
    expect(own.body.error.details.reason).toBe("REVIEWER_IS_SUBMITTER");

    const ownReturn = await doReturn(both, w, w.study.studyId, {
      expectedRevision: submitted.body.study.revision, reason: "Mine",
    });
    expect(ownReturn.status).toBe(403);
    expect(ownReturn.body.error.code).toBe("IE_METHOD_STUDY_MAKER_CHECKER");

    /* Somebody else can. */
    const ok = await approve(w.approver, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });
    expect(ok.status).toBe(200);
    expect((await IeMethodStudy.findById(w.study.studyId).lean()).status).toBe("APPROVED");
  });

  test("approval freezes the standard time and the study becomes permanent", async () => {
    const w = await world("Approve");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const revision = submitted.body.study.revision;

    const ok = await approve(w.approver, w, w.study.studyId, {
      expectedRevision: revision, note: "Method and rating agreed.",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.approved).toBe(true);
    const study = ok.body.study;
    expect(study.status).toBe("APPROVED");
    expect(study.revision).toBe(revision + 1);
    expect(study.editable).toBe(false);
    expect(study.canSubmit).toBe(false);
    expect(study.availableActions).toEqual([]);
    expect(study.currentSubmission).toBeNull();
    expect(study.approvedSubmission).toMatchObject({ status: "APPROVED", standardTimeMinutes: 1.3764 });
    expect(study.approvedStandardTime).toMatchObject({
      standardTimeSeconds: 82.5825,
      standardTimeMinutes: 1.3764,
      standardTimeSource: "CALCULATED",
      normalTimeSeconds: 71.5,
      totalAllowancePercent: 15.5,
      allowancePolicyId: w.policy.policyId,
    });
    expect(study.approvedStandardTime.approvedByName).toMatch(/^IE Person /);
    expect(ok.body.events[0].type).toBe("METHOD_STUDY_APPROVED");
    expect(ok.body.submission.reviewNote).toBe("Method and rating agreed.");

    /* Nothing may touch it now. */
    const nextRevision = study.revision;
    const edit = await call(`/method-studies/${w.study.studyId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: nextRevision, location: "Line 7" },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("IE_METHOD_STUDY_TRANSITION_INVALID");
    for (const [fn, body] of [
      [submit, { expectedRevision: nextRevision }],
      [doReturn, { expectedRevision: nextRevision, reason: "Changed my mind" }],
      [approve, { expectedRevision: nextRevision }],
    ]) {
      const res = await fn(fn === submit ? w.maker : w.approver, w, w.study.studyId, body);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("IE_METHOD_STUDY_TRANSITION_INVALID");
    }
    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(stored.revision).toBe(nextRevision);
    expect(stored.approved.standardTimeMinutes).toBe(1.3764);
  });

  test("a study whose row changed while in review cannot be approved, only returned", async () => {
    const w = await world("StaleInReview");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    await call(`/engineering-files/${w.fileId}/bulletin`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: w.fileRevision, rows: [{ rowId: w.row.rowId, ieOperationId: w.hem.operationId }] },
    });

    const refused = await approve(w.approver, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_METHOD_STUDY_SOURCE_CHANGED");
    expect((await IeMethodStudy.findById(w.study.studyId).lean()).status).toBe("IN_REVIEW");

    /* Returning it is the way out. */
    const returned = await doReturn(w.approver, w, w.study.studyId, {
      expectedRevision: submitted.body.study.revision, reason: "The row moved to another operation.",
    });
    expect(returned.status).toBe(200);
    expect(returned.body.study.status).toBe("DRAFT");
  });

  test("resubmission after a return creates a second frozen submission", async () => {
    const w = await world("Resubmit");
    const first = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const returned = await doReturn(w.approver, w, w.study.studyId, {
      expectedRevision: first.body.study.revision, reason: "Time two more cycles.",
    });
    const edited = await call(`/method-studies/${w.study.studyId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: {
        expectedRevision: returned.body.study.revision,
        observations: [
          ...returned.body.study.observations.map((o) => ({
            observationId: o.observationId, durationSeconds: o.durationSeconds,
            included: o.included, exclusionReason: o.exclusionReason, note: o.note,
          })),
          { durationSeconds: 68 },
        ],
      },
    });
    expect(edited.status).toBe(200);

    const second = await submit(w.maker, w, w.study.studyId, { expectedRevision: edited.body.study.revision });
    expect(second.status).toBe(200);
    expect(second.body.submission.submissionId).not.toBe(first.body.submission.submissionId);
    expect(second.body.submission.result.includedCycleCount).toBe(3);

    const history = await submissions(w.maker, w, w.study.studyId);
    expect(history.body.submissions).toHaveLength(2);
    expect(history.body.submissions.map((s) => s.status)).toEqual(["IN_REVIEW", "RETURNED"]);
    /* Newest first, and the returned one still says exactly what it said. */
    expect(history.body.submissions[1].result.includedCycleCount).toBe(2);
    expect(history.body.submissions[1].reviewNote).toBe("Time two more cycles.");
    expect(history.body.total).toBe(2);

    const approved = await approve(w.approver, w, w.study.studyId, { expectedRevision: second.body.study.revision });
    expect(approved.status).toBe(200);
    expect(approved.body.study.approvedSubmission.submissionId).toBe(second.body.submission.submissionId);
    /* Both attempts survive the approval. */
    expect((await IeMethodStudy.findById(w.study.studyId).lean()).submissions).toHaveLength(2);
  });

  test("after approval a new study may be opened, and the approved one is untouched", async () => {
    const w = await world("ReopenAfterApproval");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const approved = await approve(w.approver, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });
    expect(approved.status).toBe(200);

    const fresh = await call(`/engineering-files/${w.fileId}/bulletin/${w.row.rowId}/method-studies`, {
      method: "POST", token: w.maker.token, company: w.co._id, body: {},
    });
    expect(fresh.status).toBe(201);
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.study.studyId).not.toBe(w.study.studyId);
    expect(fresh.body.study.status).toBe("DRAFT");
    expect(fresh.body.study.observations).toEqual([]);

    /* Two studies for the row: the approved evidence and the new draft. */
    const list = await call(`/engineering-files/${w.fileId}/bulletin/${w.row.rowId}/method-studies`, {
      token: w.maker.token, company: w.co._id,
    });
    expect(list.body.studies.map((s) => s.status)).toEqual(["DRAFT", "APPROVED"]);
    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(stored.status).toBe("APPROVED");
    expect(stored.approved.standardTimeMinutes).toBe(1.3764);
    expect(stored.revision).toBe(approved.body.study.revision);

    /* And a second open draft for the same row-operation is still refused. */
    const again = await call(`/engineering-files/${w.fileId}/bulletin/${w.row.rowId}/method-studies`, {
      method: "POST", token: w.maker.token, company: w.co._id, body: {},
    });
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.study.studyId).toBe(fresh.body.study.studyId);
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: w.row.rowId })).toBe(2);
  });
});

/* ══ 4. CONCURRENCY ═══════════════════════════════════════════════════════ */

describe("one lifecycle winner", () => {
  test("two simultaneous submissions: exactly one lands", async () => {
    const w = await world("SubmitRace");
    const [one, two] = await Promise.all([
      submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision }),
      submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision }),
    ]);
    expect([one, two].filter((r) => r.status === 200)).toHaveLength(1);
    const loser = [one, two].find((r) => r.status !== 200);
    expect(loser.status).toBe(409);
    expect(["IE_METHOD_STUDY_REVISION_CONFLICT", "IE_METHOD_STUDY_TRANSITION_INVALID", "IE_METHOD_STUDY_NOT_READY"])
      .toContain(loser.body.error.code);

    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(stored.submissions).toHaveLength(1);
    expect(stored.status).toBe("IN_REVIEW");
    expect(stored.revision).toBe(w.study.revision + 1);
    expect(stored.history.filter((e) => e.type === "METHOD_STUDY_SUBMITTED")).toHaveLength(1);
  });

  test("a return racing an approval: one decision, one audit event", async () => {
    const w = await world("DecisionRace");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const revision = submitted.body.study.revision;
    const otherApprover = await approverIn(w.co);

    const [returned, approved] = await Promise.all([
      doReturn(w.approver, w, w.study.studyId, { expectedRevision: revision, reason: "Send it back." }),
      approve(otherApprover, w, w.study.studyId, { expectedRevision: revision }),
    ]);

    const winners = [returned, approved].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = [returned, approved].find((r) => r.status !== 200);
    expect(loser.status).toBe(409);
    expect(["IE_METHOD_STUDY_REVISION_CONFLICT", "IE_METHOD_STUDY_TRANSITION_INVALID", "IE_METHOD_STUDY_SUBMISSION_NOT_FOUND"])
      .toContain(loser.body.error.code);

    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(stored.revision).toBe(revision + 1);
    expect(stored.submissions).toHaveLength(1);
    /* The submission's state and the study's status agree — there is no
       half-approved record. */
    if (stored.status === "APPROVED") {
      expect(stored.submissions[0].status).toBe("APPROVED");
      expect(stored.approvedSubmissionId).toBe(stored.submissions[0].submissionId);
      expect(stored.approved.standardTimeMinutes).toBe(1.3764);
    } else {
      expect(stored.status).toBe("DRAFT");
      expect(stored.submissions[0].status).toBe("RETURNED");
      expect(stored.approvedSubmissionId).toBeNull();
      expect(stored.approved.standardTimeMinutes).toBeNull();
    }
    expect(stored.history.filter((e) => /RETURNED|APPROVED/.test(e.type))).toHaveLength(1);
  });

  test("a stale lifecycle request conflicts even when the outcome already looks true", async () => {
    const w = await world("StaleLifecycle");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const revision = submitted.body.study.revision;
    await approve(w.approver, w, w.study.studyId, { expectedRevision: revision });

    /* Approving again at the OLD revision: the outcome (approved) is already
       true, and it is still refused, because the caller is deciding from a state
       that no longer exists. */
    const stale = await approve(w.approver, w, w.study.studyId, { expectedRevision: revision });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_METHOD_STUDY_TRANSITION_INVALID");

    /* And a submit at a revision that has moved. */
    const w2 = await world("StaleSubmit");
    await call(`/method-studies/${w2.study.studyId}`, {
      method: "PATCH", token: w2.maker.token, company: w2.co._id,
      body: { expectedRevision: w2.study.revision, location: "Line 9" },
    });
    const staleSubmit = await submit(w2.maker, w2, w2.study.studyId, { expectedRevision: w2.study.revision });
    expect(staleSubmit.status).toBe(409);
    expect(staleSubmit.body.error.code).toBe("IE_METHOD_STUDY_REVISION_CONFLICT");
    expect((await IeMethodStudy.findById(w2.study.studyId).lean()).submissions).toEqual([]);
  });

  test("every lifecycle action requires an expected revision", async () => {
    const w = await world("RevisionRequired");
    for (const [fn, a, body] of [
      [submit, w.maker, {}],
      [doReturn, w.approver, { reason: "x" }],
      [approve, w.approver, {}],
    ]) {
      const res = await fn(a, w, w.study.studyId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.details.field).toBe("expectedRevision");
    }
    /* And nothing but the documented fields. */
    for (const [fn, a, body] of [
      [submit, w.maker, { expectedRevision: 2, status: "APPROVED" }],
      [doReturn, w.approver, { expectedRevision: 2, reason: "x", standardTimeMinutes: 9 }],
      [approve, w.approver, { expectedRevision: 2, approvedSubmissionId: "sub_x" }],
    ]) {
      const res = await fn(a, w, w.study.studyId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
  });
});

/* ══ 4b. ONE ACTIVE STUDY PER OPERATION ═══════════════════════════════════
 *
 * The invariant is about being ACTIVE, not about being a draft. Covering only
 * DRAFT let the open endpoint start a second study the moment the first was
 * submitted — and returning the first then collided with the second, as a raw
 * duplicate key. */

describe("no second study while one is open", () => {
  const openStudy = (a, w) => call(`/engineering-files/${w.fileId}/bulletin/${w.row.rowId}/method-studies`, {
    method: "POST", token: a.token, company: w.co._id, body: {},
  });

  test("opening while a study is IN_REVIEW resumes it rather than starting another", async () => {
    const w = await world("NoSecondWhileReviewing");
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    expect(submitted.body.study.status).toBe("IN_REVIEW");

    const reopened = await openStudy(w.maker, w);
    expect(reopened.status).toBe(200);
    expect(reopened.body.created).toBe(false);
    expect(reopened.body.study.studyId).toBe(w.study.studyId);
    expect(reopened.body.study.status).toBe("IN_REVIEW");
    /* It says what may happen to it next, rather than offering an edit. */
    expect(reopened.body.study.availableActions).toEqual(["RETURN", "APPROVE"]);
    expect(reopened.body.study.editable).toBe(false);
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: w.row.rowId })).toBe(1);

    /* And the return still works — this is the collision the old rule caused. */
    const returned = await doReturn(w.approver, w, w.study.studyId, {
      expectedRevision: submitted.body.study.revision, reason: "Time two more cycles.",
    });
    expect(returned.status).toBe(200);
    expect(returned.body.study.status).toBe("DRAFT");
    expect(returned.body.study.editable).toBe(true);
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: w.row.rowId })).toBe(1);
  });

  test("opening while a DRAFT exists resumes it, and after approval starts a new one", async () => {
    const w = await world("SlotLifecycle");
    const resumedDraft = await openStudy(w.maker, w);
    expect(resumedDraft.body.created).toBe(false);
    expect(resumedDraft.body.study.studyId).toBe(w.study.studyId);

    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    const approved = await approve(w.approver, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });
    expect(approved.body.study.status).toBe("APPROVED");

    const fresh = await openStudy(w.maker, w);
    expect(fresh.status).toBe(201);
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.study.studyId).not.toBe(w.study.studyId);
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: w.row.rowId })).toBe(2);
    /* The approved evidence is untouched by the new draft. */
    const old = await IeMethodStudy.findById(w.study.studyId).lean();
    expect(old.status).toBe("APPROVED");
    expect(old.approved.standardTimeMinutes).toBe(1.3764);
  });

  test("opening racing a submission cannot leave an IN_REVIEW study and a stray DRAFT", async () => {
    const w = await world("OpenSubmitRace");
    const [submitted, opened] = await Promise.all([
      submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision }),
      openStudy(w.maker, w),
    ]);

    expect(submitted.status).toBe(200);
    /* Whichever order they landed in, the open either resumed the one study or
       was refused with a typed conflict — it never created a second. */
    if (opened.status >= 400) {
      expect(opened.status).toBe(409);
      expect(opened.body.error.code).toBe("IE_METHOD_STUDY_TRANSITION_INVALID");
    } else {
      expect(opened.body.created).toBe(false);
      expect(opened.body.study.studyId).toBe(w.study.studyId);
    }

    const studies = await IeMethodStudy.find({ bulletinRowId: w.row.rowId }).lean();
    expect(studies).toHaveLength(1);
    expect(studies[0].status).toBe("IN_REVIEW");

    /* Four simultaneous opens against an IN_REVIEW study, for good measure. */
    const many = await Promise.all([openStudy(w.maker, w), openStudy(w.maker, w), openStudy(w.maker, w), openStudy(w.maker, w)]);
    expect(many.every((r) => r.status === 200 && r.body.created === false)).toBe(true);
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: w.row.rowId })).toBe(1);
  });

  test("the database itself refuses a second active study", async () => {
    const w = await world("DatabaseInvariant");
    const indexes = await IeMethodStudy.collection.indexes();
    const active = indexes.find((i) => i.name === "ie_method_study_one_active_per_row_operation");
    expect(active).toMatchObject({
      unique: true,
      key: { companyId: 1, ieStyleFileId: 1, bulletinRowId: 1, ieOperationId: 1, ieOperationRevision: 1 },
      partialFilterExpression: { status: { $in: ["DRAFT", "IN_REVIEW"] } },
    });
    /* The superseded DRAFT-only index is gone, not merely unused. */
    expect(indexes.find((i) => i.name === "ie_method_study_one_draft_per_row_operation")).toBeUndefined();

    const stored = await IeMethodStudy.findById(w.study.studyId).lean();
    const twin = (status) => ({
      companyId: stored.companyId, ieStyleFileId: stored.ieStyleFileId, sampleStyleId: stored.sampleStyleId,
      bulletinRowId: stored.bulletinRowId, ieOperationId: stored.ieOperationId,
      ieOperationRevision: stored.ieOperationRevision, status, revision: 1,
    });

    /* Written straight to the model, past every line of service code: a second
       DRAFT and a second IN_REVIEW are both refused while this one is a draft. */
    await expect(IeMethodStudy.create(twin("DRAFT"))).rejects.toMatchObject({ code: 11000 });
    await expect(IeMethodStudy.create(twin("IN_REVIEW"))).rejects.toMatchObject({ code: 11000 });

    /* Submitting moves it to IN_REVIEW — still the one active slot. */
    await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    await expect(IeMethodStudy.create(twin("DRAFT"))).rejects.toMatchObject({ code: 11000 });

    /* An APPROVED twin is outside the filter, which is how history accumulates. */
    const approvedTwin = await IeMethodStudy.create(twin("APPROVED"));
    expect(approvedTwin.status).toBe("APPROVED");
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: w.row.rowId })).toBe(2);
  });
});

/* ══ 5. NOTHING LEAVES ════════════════════════════════════════════════════ */

describe("what an approval does not do", () => {
  test("no bulletin row, operation or file is changed by submission or approval", async () => {
    const w = await world("NoSideEffects");
    const fileBefore = await IeStyleFile.findById(w.fileId).lean();
    const opBefore = await IeOperation.findById(w.sew.operationId).lean();
    const policyBefore = await IeAllowancePolicy.findById(w.policy.policyId).lean();

    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    await approve(w.approver, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });

    const fileAfter = await IeStyleFile.findById(w.fileId).lean();
    expect(fileAfter.revision).toBe(fileBefore.revision);
    expect(fileAfter.bulletin.rows).toEqual(fileBefore.bulletin.rows);
    expect(fileAfter.history).toHaveLength(fileBefore.history.length);
    /* The row's proposed SAM is NOT overwritten with the approved standard. */
    expect(fileAfter.bulletin.rows[0].proposedSamMinutes).toBe(1.5);

    const opAfter = await IeOperation.findById(w.sew.operationId).lean();
    expect(opAfter.revision).toBe(opBefore.revision);
    expect(opAfter.updatedAt.toISOString()).toBe(opBefore.updatedAt.toISOString());

    const policyAfter = await IeAllowancePolicy.findById(w.policy.policyId).lean();
    expect(policyAfter.revision).toBe(policyBefore.revision);
    expect(policyAfter.updatedAt.toISOString()).toBe(policyBefore.updatedAt.toISOString());
  });

  test("no other department's record is written, and there is no release verb", async () => {
    const w = await world("NoRelease");
    const before = await Promise.all([
      WorkOrder.findById(w.workOrder._id).lean(),
      SampleStyle.findById(w.style._id).lean(),
    ]);
    const submitted = await submit(w.maker, w, w.study.studyId, { expectedRevision: w.study.revision });
    await approve(w.approver, w, w.study.studyId, { expectedRevision: submitted.body.study.revision });
    const after = await Promise.all([
      WorkOrder.findById(w.workOrder._id).lean(),
      SampleStyle.findById(w.style._id).lean(),
    ]);
    expect(after[0].updatedAt.toISOString()).toBe(before[0].updatedAt.toISOString());
    expect(after[1].updatedAt.toISOString()).toBe(before[1].updatedAt.toISOString());
    /* The style's own technical route is untouched — no approved IE time was
       written back into R&D's record. */
    expect(after[1].techSheet.technical.revision).toBe(before[1].techSheet.technical.revision);

    for (const path of [
      `/method-studies/${w.study.studyId}/release`,
      `/method-studies/${w.study.studyId}/apply`,
      `/engineering-files/${w.fileId}/bulletin/${w.row.rowId}/apply-standard-time`,
      `/engineering-files/${w.fileId}/approve`,
      `/engineering-files/${w.fileId}/release`,
    ]) {
      expect((await call(path, { method: "POST", token: w.approver.token, company: w.co._id, body: {} })).status).toBe(404);
    }
    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    /* Two release routes exist on this router and no more: CHUNK 8A-i's
       `POST /style-files/:fileId/releases`, which issues one, and 8A-iii's
       `GET /releases/:releaseId/impact`, which only READS what has moved
       since. Both are excluded by name rather than by weakening the pattern,
       so anything else matching would still be caught. Everything DOWNSTREAM
       of a release — acknowledging it, a PPC receipt, withdrawal, an outbox —
       is still absent, and PPC's receipt is on PPC's own router. */
    expect(paths.filter((p) => /release|apply/i.test(p))
      .filter((p) => p !== "/style-files/:fileId/releases"
        && p !== "/releases/:releaseId/impact")).toEqual([]);
    expect(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods))).not.toContain("delete");
  });

  test("a foreign study's lifecycle is unreachable and undisclosed", async () => {
    const theirs = await world("TheirStudy");
    const theirSubmitted = await submit(theirs.maker, theirs, theirs.study.studyId, {
      expectedRevision: theirs.study.revision,
    });
    expect(theirSubmitted.status).toBe(200);

    const mine = await world("MyStudy");
    for (const [fn, body] of [
      [submit, { expectedRevision: 1 }],
      [doReturn, { expectedRevision: 1, reason: "x" }],
      [approve, { expectedRevision: 1 }],
    ]) {
      const res = await fn(fn === submit ? mine.maker : mine.approver, mine, theirs.study.studyId, body);
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("IE_METHOD_STUDY_NOT_FOUND");
      expect(JSON.stringify(res.body)).not.toMatch(/Line 4|SEW-01|IN_REVIEW|1\.3764/);
    }
    const subs = await submissions(mine.maker, mine, theirs.study.studyId);
    expect(subs.status).toBe(404);
    expect((await IeMethodStudy.findById(theirs.study.studyId).lean()).status).toBe("IN_REVIEW");
  });
});

/* ══ 6. THE ARITHMETIC ON ITS OWN ═════════════════════════════════════════ */

describe("standard time, without a server", () => {
  test("normal time plus allowances, rounded once", () => {
    expect(calculateStandardTime({ normalTimeSeconds: 71.5, totalAllowancePercent: 15.5 })).toEqual({
      totalAllowancePercent: 15.5,
      standardTimeSeconds: 82.5825,
      standardTimeMinutes: 1.3764,
      calculationComplete: true,
    });
    /* Minutes follow the ROUNDED seconds, so the two figures always agree. */
    const out = calculateStandardTime({ normalTimeSeconds: 43.0333, totalAllowancePercent: 12.3456 });
    expect(out.standardTimeMinutes).toBe(Math.round((out.standardTimeSeconds / 60) * 10000) / 10000);
    for (const v of [out.standardTimeSeconds, out.standardTimeMinutes, out.totalAllowancePercent]) {
      expect(String(v).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    }
  });

  test("a 0% policy is a policy: standard time equals normal time", () => {
    expect(calculateStandardTime({ normalTimeSeconds: 71.5, totalAllowancePercent: 0 }))
      .toMatchObject({ standardTimeSeconds: 71.5, standardTimeMinutes: 1.1917, calculationComplete: true });
  });

  test("missing inputs are null and never zero", () => {
    expect(calculateStandardTime({ normalTimeSeconds: null, totalAllowancePercent: 15 }))
      .toMatchObject({ standardTimeSeconds: null, standardTimeMinutes: null, calculationComplete: false });
    expect(calculateStandardTime({ normalTimeSeconds: 60, totalAllowancePercent: null }))
      .toMatchObject({ standardTimeSeconds: null, standardTimeMinutes: null, calculationComplete: false });
    expect(calculateStandardTime({})).toMatchObject({ standardTimeSeconds: null, calculationComplete: false });
  });

  test("it reads no payroll, costing or material field", () => {
    const out = calculateStandardTime({
      normalTimeSeconds: 60, totalAllowancePercent: 10,
      wageRate: 500, costingAllowance: 20, materialAllowance: 5,
    });
    expect(Object.keys(out).sort()).toEqual([
      "calculationComplete", "standardTimeMinutes", "standardTimeSeconds", "totalAllowancePercent",
    ]);
    expect(out.standardTimeSeconds).toBe(66);
  });
});
