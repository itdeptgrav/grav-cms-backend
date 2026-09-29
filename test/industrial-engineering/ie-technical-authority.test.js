// test/industrial-engineering/ie-technical-authority.test.js
//
// PHASE 1 — IE IS WHERE R&D'S RECORD BECOMES COSTABLE, AND IT STARTS BEFORE THE ORDER.
//
// ── THE BUSINESS RULE ───────────────────────────────────────────────────────
//   Merchandising inputs → R&D technical draft → IE confirmation → Central
//   Costing → Sales.
//
// R&D may author and revise freely. No R&D value may affect a costing until IE
// has confirmed the EXACT revision it belongs to. This phase builds the half of
// that sentence IE owns; the costing half binds to it next.
//
// ── THE TWO CLAIMS ──────────────────────────────────────────────────────────
//
// 1. AN ENGINEERING FILE CAN BEGIN AT THE ENQUIRY LINE.
//    Engineering used to be reachable only through an order, which put IE after
//    the sale — impossible, because nothing may be quoted until IE has
//    confirmed the facts a price is built on. The file is now openable from the
//    style itself, proved through the style's own Sales parents. It is the SAME
//    file: one per style per company, and an order opened later attaches to it
//    rather than starting a second engineering record.
//
// 2. A SUBMITTED VERSION FREEZES THE R&D REVISION IT CONFIRMS.
//    `IeBulletinVersion.technicalSource` carries the exact revision, a key over
//    its identity, and the snapshot the reviewer actually read. Approving a
//    version IS the confirmation. It is server-frozen, refused from a client,
//    and immutable through return, approval and supersession — because a
//    costing that could re-read R&D would silently re-base onto a record
//    nobody reviewed.
//
// What is NOT here: Central Costing still reads R&D directly. That is phase 2,
// and this file deliberately makes no claim about it.
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
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");

const versions = require("../../services/industrialEngineering/ieBulletinVersion.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  /* The idempotency claim is a claim about an INDEX. */
  await IeStyleFile.syncIndexes();
  await IeBulletinVersion.syncIndexes();
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

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `ta${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "T", lastName: `A${n}`, email, biometricId: `TA${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "T" });
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
      { id: String(emp._id), email, name: `IE Person ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const approverIn = (...cos) => actor({ companies: cos, grants: { ie: "approver" } });

/**
 * R&D's frozen approved revision, in the shape R&D actually stores it.
 *
 * Materials carry consumption because the whole point of phase 2 is that a
 * costing reads THIS figure, from a version somebody approved, rather than the
 * live record.
 */
const approvedRevision = ({
  revision = 3,
  submittedAt = "2026-08-01",
  decidedAt = "2026-08-05",
  materials = [{ name: "Fabric A", consumptionPerPiece: 1.4, allowancePercent: 5 }],
  operations = [],
} = {}) => ({
  revision,
  submittedAt: new Date(submittedAt),
  outcome: "approved",
  decidedAt: new Date(decidedAt),
  snapshot: {
    revision,
    materials: materials.map((m) => ({
      rawItemId: String(new mongoose.Types.ObjectId()),
      rawItemName: m.name,
      consumptionPerPiece: m.consumptionPerPiece,
      allowancePercent: m.allowancePercent,
      unit: "m",
    })),
    requirements: [],
    operations,
  },
});

/** A company, a journey, an enquiry, a product, a work order and a style. */
async function world(name, { revisions = [approvedRevision()], technicalStatus = "approved" } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "Owner", name: `J ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `E ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
  });
  const item = await StockItem.create({
    name: `Tee ${name}`, sku: `SKU-${name}-${n}`, reference: `REF-${name}-${n}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${n}`, cost: 0, salesPrice: 0 }],
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${n}`, stockItemId: item._id, stockItemName: item.name,
    stockItemReference: item.reference, quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: `Tee ${name}`, styleCode: `ST-${name}`,
    variantLabel: "Navy", journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
    materials: { status: "pending", rawItems: [] },
    techSheet: {
      technical: {
        status: technicalStatus,
        revision: revisions.length ? revisions[revisions.length - 1].revision : 0,
      },
      technicalRevisions: revisions,
    },
    production: { workOrderIds: [wo._id] },
  });
  const maker = await editorIn(co);
  const approver = await approverIn(co);
  return { co, journey, enquiry, style, workOrder: wo, maker, approver };
}

const byStyle = (w) => `/styles/${w.style._id}/engineering-file`;
const byOrder = (w) => `/orders/${w.workOrder._id}/styles/${w.style._id}/engineering-file`;

const openByStyle = (a, w, body = {}) =>
  call(byStyle(w), { method: "POST", token: a.token, company: w.co._id, body });
const openByOrder = (a, w, body = {}) =>
  call(byOrder(w), { method: "POST", token: a.token, company: w.co._id, body });

/* ═══ 1 · THE FILE BEGINS AT THE ENQUIRY LINE ══════════════════════════════ */

describe("an engineering file before any order exists", () => {
  test("it opens from the style alone, from the approved R&D revision", async () => {
    const w = await world("EarlyStart");
    const res = await openByStyle(w.maker, w);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    /* The source is frozen at creation, from R&D's approved revision — the
       same rule the order entry point has always applied. */
    expect(res.body.file.source.technicalRevision).toBe(3);
    /* And no order was involved. */
    const stored = await IeStyleFile.findOne({ sampleStyleId: w.style._id }).lean();
    expect(stored.openedFromOrderId).toBeNull();
    expect(String(stored.companyId)).toBe(String(w.co._id));
  });

  test("it is readable from the style, and the read proves ownership again", async () => {
    const w = await world("EarlyRead");
    await openByStyle(w.maker, w);

    const read = await call(byStyle(w), { token: w.maker.token, company: w.co._id });
    expect(read.status).toBe(200);
    expect(read.body.file.source.technicalRevision).toBe(3);
  });

  test("a second open returns the same file, and creates nothing", async () => {
    const w = await world("EarlyTwice");
    const first = await openByStyle(w.maker, w);
    const second = await openByStyle(w.maker, w);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.file.fileId).toBe(first.body.file.fileId);
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(1);
  });

  test("four simultaneous opens produce one file — the index decides", async () => {
    /* A double-clicked button sends two requests a millisecond apart, and
       "look for one, create it if absent" is two operations that both find
       nothing. The unique index is the actual arbiter. */
    const w = await world("EarlyRace");
    const results = await Promise.all([
      openByStyle(w.maker, w), openByStyle(w.maker, w),
      openByStyle(w.maker, w), openByStyle(w.maker, w),
    ]);
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(results.filter((r) => r.body.created === true).length).toBe(1);
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(1);

    const ids = new Set(results.map((r) => r.body.file.fileId));
    expect(ids.size).toBe(1);
  });

  test("it takes no body at all — not even the revision it is opened from", async () => {
    const w = await world("EarlyBody");
    for (const body of [
      { technicalRevision: 9 },
      { companyId: String(new mongoose.Types.ObjectId()) },
      { sampleStyleId: String(w.style._id) },
    ]) {
      const res = await openByStyle(w.maker, w, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(0);
  });

  test("a style with no approved technical version is refused, and names why", async () => {
    /* IE works from what R&D approved. A draft is not a source. */
    const w = await world("EarlyDraft", {
      technicalStatus: "draft",
      revisions: [{ ...approvedRevision(), outcome: "submitted" }],
    });
    const res = await openByStyle(w.maker, w);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe("IE_SOURCE_VERSION_REQUIRED");
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(0);
  });
});

/* ═══ 2 · ONE FILE, HOWEVER IT WAS REACHED ═════════════════════════════════ */

describe("the order attaches to the file, it does not start a second one", () => {
  test("opening through an order later attaches that order to the same file", async () => {
    const w = await world("Attach");
    const early = await openByStyle(w.maker, w);
    expect(early.body.file.fileId).toBeTruthy();

    const later = await openByOrder(w.maker, w);
    expect(later.status).toBe(200);
    expect(later.body.created).toBe(false);
    expect(later.body.file.fileId).toBe(early.body.file.fileId);

    /* ── ONE ENGINEERING RECORD PER STYLE ──────────────────────────────
       Two files would be two routes, two SAMs and two answers to "what did
       IE approve" — which is the failure the unique index makes
       unrepresentable and this test makes visible. */
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(1);
    const stored = await IeStyleFile.findOne({ sampleStyleId: w.style._id }).lean();
    expect(String(stored.openedFromOrderId)).toBe(String(w.workOrder._id));
  });

  test("the first order a file was opened through is not overwritten by a second", async () => {
    /* `openedFromOrderId` is provenance. Ownership is re-proved on every
       request, so a style reachable through two orders still has one file —
       and the record of which order it was OPENED from is a fact. */
    const w = await world("TwoOrders");
    await openByOrder(w.maker, w);
    const first = await IeStyleFile.findOne({ sampleStyleId: w.style._id }).lean();

    const second = await WorkOrder.create({
      workOrderNumber: `WO-Second-${++seq}`, stockItemId: w.workOrder.stockItemId,
      stockItemName: "Tee", stockItemReference: "REF", quantity: 100, originalQuantity: 100,
      status: "planned",
      timeline: { plannedStartDate: new Date("2026-11-01"), plannedEndDate: new Date("2026-11-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
    });
    await SampleStyle.updateOne(
      { _id: w.style._id }, { $addToSet: { "production.workOrderIds": second._id } },
    );

    const again = await call(`/orders/${second._id}/styles/${w.style._id}/engineering-file`, {
      method: "POST", token: w.maker.token, company: w.co._id, body: {},
    });
    expect(again.status).toBe(200);
    const after = await IeStyleFile.findOne({ sampleStyleId: w.style._id }).lean();
    expect(String(after.openedFromOrderId)).toBe(String(first.openedFromOrderId));
  });

  test("opening by style and by order reach the same file from either direction", async () => {
    const w = await world("BothWays");
    const viaOrder = await openByOrder(w.maker, w);
    const viaStyle = await openByStyle(w.maker, w);
    expect(viaStyle.body.file.fileId).toBe(viaOrder.body.file.fileId);
    expect(await IeStyleFile.countDocuments({ sampleStyleId: w.style._id })).toBe(1);
  });
});

/* ═══ 3 · TENANCY, AND THE REFUSAL THAT REVEALS NOTHING ════════════════════ */

describe("whose style it is", () => {
  test("another company's style is refused, the same way one that does not exist is", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");

    const stolen = await call(byStyle(theirs), {
      method: "POST", token: mine.maker.token, company: mine.co._id, body: {},
    });
    const absent = await call(`/styles/${new mongoose.Types.ObjectId()}/engineering-file`, {
      method: "POST", token: mine.maker.token, company: mine.co._id, body: {},
    });
    const nonsense = await call("/styles/not-an-id/engineering-file", {
      method: "POST", token: mine.maker.token, company: mine.co._id, body: {},
    });

    /* ── ONE ANSWER, THREE SITUATIONS ──────────────────────────────────
       A refusal that varied would be an oracle for which style ids are real,
       and for which of them belong to somebody else. */
    for (const r of [stolen, absent, nonsense]) {
      expect(r.status).toBe(stolen.status);
      expect(r.body.error.code).toBe("IE_STYLE_NOT_FOUND");
    }
    /* And nothing was created in either company. */
    expect(await IeStyleFile.countDocuments({ sampleStyleId: theirs.style._id })).toBe(0);
  });

  test("a reader with no membership in that company gets nothing", async () => {
    const w = await world("NoMember");
    await openByStyle(w.maker, w);
    const outsider = await editorIn(); // a member of no company at all

    const res = await call(byStyle(w), { token: outsider.token, company: w.co._id });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).not.toBe(200);
  });
});

/* ═══ 4 · THE VERSION FREEZES THE R&D REVISION IT CONFIRMS ═════════════════ */

describe("what a submitted bulletin version says about R&D", () => {
  /**
   * A file with one library operation, one bulletin row, and an APPROVED
   * method study behind it — which is what the existing submit gate requires.
   *
   * The whole cycle is run through the real routes rather than written into
   * the database: a fixture that inserted an approved study would prove the
   * freeze works on data the workflow cannot actually produce.
   */
  async function readyToSubmit(name, opts) {
    const w = await world(name, opts);
    const t = { token: w.maker.token, company: w.co._id };

    /* A published allowance policy, so the standard time has a basis. */
    const drafted = await call("/allowance-policies", {
      method: "POST", ...t,
      body: { name: `No allowance ${++seq}`, effectiveFrom: "2026-01-01", categories: [] },
    });
    await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
      method: "POST", token: w.approver.token, company: w.co._id, body: { expectedRevision: 1 },
    });

    const file = (await openByStyle(w.maker, w)).body.file;

    const op = (await call("/operations/library", {
      method: "POST", ...t, body: { code: `OP-${++seq}`, name: "Side seam", machineType: "SNLS" },
    })).body.operation;

    const patched = await call(`/engineering-files/${file.fileId}/bulletin`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: file.revision,
        rows: [{ ieOperationId: op.operationId, proposedSamMinutes: 1.25 }],
      },
    });
    expect(patched.status).toBe(200);
    const row = patched.body.file.bulletin.rows[0];

    /* Open, fill, submit and approve the method study for that row. */
    const opened = await call(`/engineering-files/${file.fileId}/bulletin/${row.rowId}/method-studies`, {
      method: "POST", ...t, body: {},
    });
    const studyId = opened.body.study.studyId;
    const filled = await call(`/method-studies/${studyId}`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 4",
        methodNote: "Two-hand method", ratingPercent: 100, observations: [{ durationSeconds: 75 }],
      },
    });
    const submittedStudy = await call(`/method-studies/${studyId}/submit`, {
      method: "POST", ...t,
      body: {
        expectedRevision: filled.body.study.revision,
        manualStandardTimeMinutes: 1.25,
        overrideReason: "Fixed standard agreed for this exercise.",
      },
    });
    expect(submittedStudy.status).toBe(200);
    const approvedStudy = await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: submittedStudy.body.study.revision },
    });
    expect(approvedStudy.status).toBe(200);

    const reread = await call(byStyle(w), t);
    return { w, fileId: file.fileId, file: reread.body.file, op, row };
  }

  test("the frozen source names the exact revision, its key, and what was in it", async () => {
    const { w, fileId, file } = await readyToSubmit("Freeze");

    const submitted = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    /* A submission may legitimately be refused for an unrelated readiness gap
       in this fixture; the claim is about what a version CARRIES when one is
       made, so the test states which. */
    expect(submitted.status).toBe(201);

    const stored = await IeBulletinVersion.findById(submitted.body.version.bulletinVersionId).lean();
    expect(stored.technicalSource).toBeTruthy();
    expect(stored.technicalSource.technicalRevision).toBe(3);
    expect(String(stored.technicalSource.sampleStyleId)).toBe(String(w.style._id));
    expect(stored.technicalSource.technicalRevisionKey).toMatch(/^[0-9a-f]{32}$/);
    /* ── THE SNAPSHOT THE REVIEWER ACTUALLY READ ───────────────────────
       Not the identity alone. Costing reads consumption from here, so the
       figure it costs is the figure somebody approved. */
    expect(stored.technicalSource.snapshot.materials[0].consumptionPerPiece).toBe(1.4);
    expect(stored.technicalSource.snapshot.materials[0].allowancePercent).toBe(5);
    expect(stored.technicalSource.materialCount).toBe(1);
    expect(stored.technicalSource.operationCount).toBe(0);
    expect(stored.technicalSource.frozenAt).toBeInstanceOf(Date);
  });

  test("the projection publishes identity and counts, and withholds the snapshot", async () => {
    /* This projection is read by IE screens and order listings. R&D's full
       technical content is not theirs to hand out; Central Costing reads the
       stored document, having proved the version is the current approved one. */
    const { w, fileId, file } = await readyToSubmit("Publish");
    const submitted = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    expect(submitted.status).toBe(201);

    const published = submitted.body.version.technicalSource;
    expect(published.technicalRevision).toBe(3);
    expect(published.technicalRevisionKey).toMatch(/^[0-9a-f]{32}$/);
    expect(published.materialCount).toBe(1);
    expect(published).not.toHaveProperty("snapshot");
    expect(JSON.stringify(submitted.body.version)).not.toMatch(/consumptionPerPiece/);
  });

  test("a client cannot send it — that is the whole point of it", async () => {
    const { w, fileId, file } = await readyToSubmit("Forged");
    const res = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: {
        expectedRevision: file.revision,
        technicalSource: { technicalRevision: 99, technicalRevisionKey: "forged" },
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    /* ── REFUSED BY NAME, NOT MERELY AS AN UNKNOWN KEY ─────────────────
       The submit body is an allowlist, so any spelling would be refused. What
       this asserts is that the refusal SAYS WHY — a caller who sent it
       believed they were setting which revision the version confirms, and
       "not part of submitting a bulletin version" would leave them to guess
       whether the field exists at all. */
    expect(res.body.error.message).toMatch(/R&D revision this version confirms/);
    expect(res.body.error.message).toMatch(/the server freezes it|server freezes/);
    expect(await IeBulletinVersion.countDocuments({ ieStyleFileId: fileId })).toBe(0);
  });

  test("it survives return, approval and supersession unchanged", async () => {
    const { w, fileId, file } = await readyToSubmit("Immutable");
    const t = { token: w.maker.token, company: w.co._id };

    const first = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", ...t, body: { expectedRevision: file.revision },
    });
    expect(first.status).toBe(201);
    const v1 = first.body.version;
    const frozenAtSubmit = (await IeBulletinVersion.findById(v1.bulletinVersionId).lean()).technicalSource;

    /* Returned — the record of what was rejected must not be editable. */
    const returned = await call(`/bulletin-versions/${v1.bulletinVersionId}/return`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: v1.revision, reason: "Route needs a second look." },
    });
    expect(returned.status).toBe(200);
    const afterReturn = (await IeBulletinVersion.findById(v1.bulletinVersionId).lean()).technicalSource;
    expect(afterReturn.technicalRevisionKey).toBe(frozenAtSubmit.technicalRevisionKey);
    expect(afterReturn.snapshot).toEqual(frozenAtSubmit.snapshot);

    /* Resubmitted and approved. */
    const reread = await call(byStyle(w), t);
    const second = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", ...t, body: { expectedRevision: reread.body.file.revision },
    });
    expect(second.status).toBe(201);
    const v2 = second.body.version;
    const approved = await call(`/bulletin-versions/${v2.bulletinVersionId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: v2.revision },
    });
    expect(approved.status).toBe(200);

    const afterApproval = (await IeBulletinVersion.findById(v2.bulletinVersionId).lean()).technicalSource;
    expect(afterApproval.technicalRevision).toBe(3);
    expect(afterApproval.technicalRevisionKey).toBe(frozenAtSubmit.technicalRevisionKey);
    expect(afterApproval.snapshot.materials[0].consumptionPerPiece).toBe(1.4);

    /* And the file points at the approved version — the pointer Central
       Costing will read in phase 2. */
    const storedFile = await IeStyleFile.findById(fileId).lean();
    expect(String(storedFile.currentApprovedBulletinVersionId)).toBe(String(v2.bulletinVersionId));
  });

  test("somebody who may approve still cannot approve their own submission", async () => {
    /* ── TWO GATES, AND THE SECOND IS THE ONE THIS PHASE NEEDS ─────────
       An `ie: editor` is refused by the ROLE before maker-checker is even
       reached, which is correct and is not the claim. The claim is that
       holding the approver role is not enough: the confirmation this phase
       introduces is only worth something if the person who proposed it could
       not also be the one who confirmed it. So the submitter here IS an
       approver, and is still refused — by id, not by role. */
    const { w, fileId, file } = await readyToSubmit("SelfApprove");
    const submitter = w.approver;
    const other = await approverIn(w.co);

    const submitted = await call(`/engineering-files/${fileId}/bulletin-versions`, {
      method: "POST", token: submitter.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    expect(submitted.status).toBe(201);
    const version = submitted.body.version;

    const self = await call(`/bulletin-versions/${version.bulletinVersionId}/approve`, {
      method: "POST", token: submitter.token, company: w.co._id,
      body: { expectedRevision: version.revision },
    });
    expect(self.status).toBeGreaterThanOrEqual(400);
    expect(self.body.error.code).toBe("IE_BULLETIN_VERSION_MAKER_CHECKER");

    /* And the version is still in review — a refused approval changes nothing. */
    expect((await IeBulletinVersion.findById(version.bulletinVersionId).lean()).state).toBe("IN_REVIEW");

    /* Somebody else may. */
    const approved = await call(`/bulletin-versions/${version.bulletinVersionId}/approve`, {
      method: "POST", token: other.token, company: w.co._id,
      body: { expectedRevision: version.revision },
    });
    expect(approved.status).toBe(200);
    /* ── AND THE CONFIRMATION CARRIES BOTH NAMES ───────────────────────
       Which is what makes it a confirmation rather than a save. */
    const stored = await IeBulletinVersion.findById(version.bulletinVersionId).lean();
    expect(String(stored.submittedBy)).not.toBe(String(stored.approvedBy));
    expect(stored.approvedAt).toBeInstanceOf(Date);
    expect(stored.technicalSource.technicalRevision).toBe(3);
  });
});

/* ═══ 5 · THE REVISION KEY IS AN IDENTITY, NOT A NUMBER ════════════════════ */

describe("the technical revision key", () => {
  const { technicalRevisionKeyOf } = versions;

  test("the same revision always produces the same key", () => {
    const rev = { revision: 3, submittedAt: "2026-08-01", decidedAt: "2026-08-05", outcome: "approved" };
    expect(technicalRevisionKeyOf(rev)).toBe(technicalRevisionKeyOf({ ...rev }));
    expect(technicalRevisionKeyOf(rev)).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a revision re-approved under the same number is a DIFFERENT key", () => {
    /* ── WHY THE NUMBER IS NOT IDENTITY ────────────────────────────────
       `revision` is R&D's own counter. Two records carrying the number 3 and
       approved on different days are two decisions, and a costing that
       compared only the number would call the second one "the revision that
       was confirmed". */
    const first = { revision: 3, submittedAt: "2026-08-01", decidedAt: "2026-08-05", outcome: "approved" };
    const again = { revision: 3, submittedAt: "2026-08-01", decidedAt: "2026-09-02", outcome: "approved" };
    expect(technicalRevisionKeyOf(again)).not.toBe(technicalRevisionKeyOf(first));
  });

  test("every identity field moves the key", () => {
    const base = { revision: 3, submittedAt: "2026-08-01", decidedAt: "2026-08-05", outcome: "approved" };
    const key = technicalRevisionKeyOf(base);
    expect(technicalRevisionKeyOf({ ...base, revision: 4 })).not.toBe(key);
    expect(technicalRevisionKeyOf({ ...base, submittedAt: "2026-08-02" })).not.toBe(key);
    expect(technicalRevisionKeyOf({ ...base, outcome: "returned" })).not.toBe(key);
  });

  test("nothing is a key, and is not mistaken for one", () => {
    expect(technicalRevisionKeyOf(null)).toBe("");
    expect(technicalRevisionKeyOf(undefined)).toBe("");
  });
});
