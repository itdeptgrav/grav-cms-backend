// test/industrial-engineering/ie-method-study.route.test.js
//
// IE CHUNK 4A — THE DRAFT METHOD STUDY, AT THE WIRE.
//
// A method study is the evidence behind a time, so the claims worth holding are
// the ones that decide whether that evidence can be trusted later:
//
//   · the operation it says it timed is the one the BULLETIN ROW named, not
//     whatever the library says today — renaming, re-revising or retiring an
//     operation afterwards changes nothing on the study;
//   · a reorder, a note or a re-timed proposed SAM leaves it CURRENT, because
//     none of them changes what was timed;
//   · replacing the row's operation makes it OPERATION_CHANGED and removing the
//     row makes it ROW_REMOVED — both still readable, neither editable, neither
//     rebased and neither deleted;
//   · only included cycles count, an excluded one has to say why, and missing
//     inputs produce null rather than a zero somebody could mistake for a
//     measurement;
//   · the arithmetic is deterministic to four decimals;
//   · two edits quoting one revision produce exactly one winner, a stale no-op
//     still conflicts, and a true no-op writes nothing at all;
//   · and a foreign company's file, row and study are indistinguishable from
//     ones that never existed.
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

const { calculateMethodStudy } = require("../../services/industrialEngineering/methodStudyCalculation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  /* The idempotency claim is a claim about an INDEX. */
  await IeMethodStudy.syncIndexes();
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

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `ie4a${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `E${n}`, email, biometricId: `IE4A${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "I" });
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
      { id: String(emp._id), email, name: `IE Engineer ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const editorIn = (...cos) => actor({ companies: cos, grants: { ie: "editor" } });
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

async function company(name) {
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
  return { co, journey, enquiry };
}

const approvedRevision = (revision, operations = []) => ({
  revision,
  submittedAt: new Date("2026-08-01"),
  outcome: "approved",
  decidedAt: new Date("2026-08-05"),
  snapshot: {
    revision, materials: [], requirements: [],
    operations: operations.map((o) => ({
      operationId: String(new mongoose.Types.ObjectId()),
      operationCode: o.code, name: o.name, machineType: "SNLS",
      minutes: 1, seconds: 0, samMinutes: 1, notes: "",
    })),
  },
});

/** A company, an order, and a style on it with an approved technical version. */
async function world(name) {
  const ctx = await company(name);
  const item = await StockItem.create({
    name: `Tee ${name}`, sku: `SKU-${name}-${++seq}`, reference: `REF-${name}-${seq}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${seq}`, cost: 0, salesPrice: 0 }],
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${++seq}`,
    stockItemId: item._id, stockItemName: item.name, stockItemReference: item.reference,
    quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
    estimatedCost: 184000, actualCost: 190500,
  });
  const s = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${++seq}`, productName: `Tee ${name}`,
    styleCode: `ST-${name}`, variantLabel: "Navy",
    journeyId: ctx.journey._id, enquiryId: ctx.enquiry._id, sourceStockItemId: item._id,
    materials: { status: "pending", rawItems: [] },
    techSheet: {
      technical: { status: "approved", revision: 3 },
      technicalRevisions: [approvedRevision(3, [{ code: "SEW-1", name: "Side seam" }])],
    },
    production: { workOrderIds: [wo._id] },
  });
  return { ...ctx, product: item, workOrder: wo, style: s };
}

const libraryOperation = async (a, co, { code, name, machineType = "SNLS" }) => {
  const res = await call("/operations/library", {
    method: "POST", token: a.token, company: co._id, body: { code, name, machineType },
  });
  expect(res.status).toBe(201);
  return res.body.operation;
};

const patchBulletin = (a, w, fileId, body) => call(`/engineering-files/${fileId}/bulletin`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});

/** A company with an engineering file whose bulletin holds one row. */
async function bulletinRow(name, { rows = 1 } = {}) {
  const w = await world(name);
  const a = await editorIn(w.co);
  const opened = await call(`/orders/${w.workOrder._id}/styles/${w.style._id}/engineering-file`, {
    method: "POST", token: a.token, company: w.co._id, body: {},
  });
  expect(opened.status).toBe(201);
  const file = opened.body.file;

  const sew = await libraryOperation(a, w.co, { code: "SEW-01", name: "Side seam", machineType: "SNLS" });
  const hem = rows > 1 ? await libraryOperation(a, w.co, { code: "HEM-01", name: "Hem", machineType: "FOA" }) : null;
  const saved = await patchBulletin(a, w, file.fileId, {
    expectedRevision: 1,
    rows: [
      { ieOperationId: sew.operationId, proposedSamMinutes: 1.5 },
      ...(hem ? [{ ieOperationId: hem.operationId }] : []),
    ],
  });
  expect(saved.status).toBe(200);
  return {
    w, a, sew, hem,
    fileId: file.fileId,
    fileRevision: saved.body.file.revision,
    row: saved.body.file.bulletin.rows[0],
    secondRow: saved.body.file.bulletin.rows[1] || null,
  };
}

const studiesPath = (fileId, rowId) => `/engineering-files/${fileId}/bulletin/${rowId}/method-studies`;

async function openStudy(a, w, fileId, rowId) {
  const res = await call(studiesPath(fileId, rowId), { method: "POST", token: a.token, company: w.co._id, body: {} });
  expect(res.status).toBe(201);
  return res.body.study;
}

const patchStudy = (a, w, studyId, body) => call(`/method-studies/${studyId}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});

/* ══ 1. OPENING A STUDY ═══════════════════════════════════════════════════ */

describe("opening a study for a bulletin row", () => {
  test("an editor opens one, and it carries the ROW's operation snapshot", async () => {
    const { w, a, sew, fileId, row } = await bulletinRow("Open");
    const res = await call(studiesPath(fileId, row.rowId), {
      method: "POST", token: a.token, company: w.co._id, body: {},
    });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    const study = res.body.study;
    expect(study).toMatchObject({
      ieStyleFileId: fileId,
      sampleStyleId: String(w.style._id),
      bulletinRowId: row.rowId,
      status: "DRAFT",
      revision: 1,
      applicability: "CURRENT",
      editable: true,
      canSubmit: false,
      approvalChunk: "CHUNK_4B",
    });
    expect(study.operation).toEqual({
      ieOperationId: sew.operationId, ieOperationRevision: 1,
      operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
    });
    /* Nothing has been observed yet, so nothing is calculated — and nothing is
       zero either. */
    expect(study.observations).toEqual([]);
    expect(study.result).toEqual({
      includedCycleCount: 0, excludedCycleCount: 0,
      averageObservedSeconds: null, ratingPercent: null,
      normalTimeSeconds: null, normalTimeMinutes: null, calculationComplete: false,
    });
    expect(study.history.map((e) => e.type)).toEqual(["METHOD_STUDY_CREATED"]);
    expect(study.createdByName).toMatch(/^IE Engineer /);
  });

  test("opening the same row twice resumes the same draft", async () => {
    const { w, a, fileId, row } = await bulletinRow("Idempotent");
    const first = await call(studiesPath(fileId, row.rowId), { method: "POST", token: a.token, company: w.co._id, body: {} });
    const second = await call(studiesPath(fileId, row.rowId), { method: "POST", token: a.token, company: w.co._id, body: {} });

    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.study.studyId).toBe(first.body.study.studyId);
    expect(await IeMethodStudy.countDocuments({})).toBe(1);
    const stored = await IeMethodStudy.findById(first.body.study.studyId).lean();
    expect(stored.history.filter((e) => e.type === "METHOD_STUDY_CREATED")).toHaveLength(1);
  });

  test("four simultaneous opens produce one draft", async () => {
    const { w, a, fileId, row } = await bulletinRow("RaceOpen");
    const send = () => call(studiesPath(fileId, row.rowId), { method: "POST", token: a.token, company: w.co._id, body: {} });
    const results = await Promise.all([send(), send(), send(), send()]);

    expect(new Set(results.map((r) => r.body.study.studyId)).size).toBe(1);
    expect(results.filter((r) => r.body.created === true)).toHaveLength(1);
    expect(await IeMethodStudy.countDocuments({})).toBe(1);

    /* The rule this test has always held — one open study per row-operation —
       is now enforced across DRAFT and IN_REVIEW rather than DRAFT alone,
       because submitting a study used to free the slot and let a second one be
       opened beside it. Same claim, wider and correct. */
    const indexes = await IeMethodStudy.collection.indexes();
    expect(indexes.find((i) => i.name === "ie_method_study_one_active_per_row_operation"))
      .toMatchObject({
        unique: true,
        key: { companyId: 1, ieStyleFileId: 1, bulletinRowId: 1, ieOperationId: 1, ieOperationRevision: 1 },
        partialFilterExpression: { status: { $in: ["DRAFT", "IN_REVIEW"] } },
      });
  });

  test("a row that is not on the bulletin is refused", async () => {
    const { w, a, fileId } = await bulletinRow("NoSuchRow");
    const res = await call(studiesPath(fileId, "row_deadbeefdeadbeefde"), {
      method: "POST", token: a.token, company: w.co._id, body: {},
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("IE_BULLETIN_ROW_NOT_FOUND");
    expect(await IeMethodStudy.countDocuments({})).toBe(0);
  });

  test("opening takes no authority from the body", async () => {
    const { w, a, fileId, row } = await bulletinRow("BodyAuthority");
    for (const body of [
      { companyId: String(w.co._id) },
      { ieOperationRevision: 9 },
      { ratingPercent: 100 },
      { workerName: "Someone" },
    ]) {
      const res = await call(studiesPath(fileId, row.rowId), { method: "POST", token: a.token, company: w.co._id, body });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect(await IeMethodStudy.countDocuments({})).toBe(0);
  });
});

/* ══ 2. WHO MAY DO WHAT, AND WHOSE DATA IT IS ═════════════════════════════ */

describe("role and company", () => {
  test("a viewer reads and lists but opens and edits nothing", async () => {
    const { w, a, fileId, row } = await bulletinRow("ViewerStudy");
    const study = await openStudy(a, w, fileId, row.rowId);

    const viewer = await viewerIn(w.co);
    expect((await call(`/method-studies/${study.studyId}`, { token: viewer.token, company: w.co._id })).status).toBe(200);
    expect((await call(studiesPath(fileId, row.rowId), { token: viewer.token, company: w.co._id })).status).toBe(200);

    for (const [method, path, body] of [
      ["POST", studiesPath(fileId, row.rowId), {}],
      ["PATCH", `/method-studies/${study.studyId}`, { expectedRevision: 1, location: "Line 4" }],
    ]) {
      const res = await call(path, { method, token: viewer.token, company: w.co._id, body });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
      expect(res.body.error.details.requires).toEqual({ department: "ie", minimumRole: "editor" });
    }
    expect((await IeMethodStudy.findById(study.studyId).lean()).revision).toBe(1);
  });

  test("somebody with no IE access reaches none of it", async () => {
    const { w, fileId, row } = await bulletinRow("NoGrant");
    const outsider = await actor({ companies: [w.co], grants: { sales: "owner" } });

    const read = await call(studiesPath(fileId, row.rowId), { token: outsider.token, company: w.co._id });
    expect(read.status).toBe(403);
    const write = await call(studiesPath(fileId, row.rowId), {
      method: "POST", token: outsider.token, company: w.co._id, body: {},
    });
    expect(write.status).toBe(403);
    expect(write.body.error.code).toBe("IE_WRITE_FORBIDDEN");
  });

  test("membership without a role, and a role without membership, are both refused", async () => {
    const { w, fileId, row } = await bulletinRow("BothChecks");
    await company("SecondCompanySoNoSingleCompanyFallback");

    const member = await actor({ companies: [w.co], grants: {} });
    expect((await call(studiesPath(fileId, row.rowId), {
      method: "POST", token: member.token, company: w.co._id, body: {},
    })).body.error.code).toBe("IE_WRITE_FORBIDDEN");

    const stranger = await actor({ companies: [], grants: { ie: "owner" } });
    expect((await call(studiesPath(fileId, row.rowId), {
      method: "POST", token: stranger.token, company: w.co._id, body: {},
    })).body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    expect(await IeMethodStudy.countDocuments({})).toBe(0);
  });

  test("a foreign file and a foreign study disclose nothing at all", async () => {
    const theirs = await bulletinRow("TheirRow");
    const theirStudy = await openStudy(theirs.a, theirs.w, theirs.fileId, theirs.row.rowId);
    await patchStudy(theirs.a, theirs.w, theirStudy.studyId, {
      expectedRevision: 1, location: "Their line", ratingPercent: 95,
    });

    const mine = await bulletinRow("MyRow");

    const foreignStudy = await call(`/method-studies/${theirStudy.studyId}`, { token: mine.a.token, company: mine.w.co._id });
    const inventedStudy = await call(`/method-studies/${new mongoose.Types.ObjectId()}`, { token: mine.a.token, company: mine.w.co._id });
    expect(foreignStudy.status).toBe(404);
    expect(foreignStudy.body).toEqual(inventedStudy.body);
    expect(foreignStudy.body.error.code).toBe("IE_METHOD_STUDY_NOT_FOUND");
    /* Not a word about their style, operation, revision or applicability. */
    expect(JSON.stringify(foreignStudy.body)).not.toMatch(/Their line|SEW-01|applicability|revision/i);

    const foreignFile = await call(studiesPath(theirs.fileId, theirs.row.rowId), { token: mine.a.token, company: mine.w.co._id });
    const inventedFile = await call(studiesPath(new mongoose.Types.ObjectId(), theirs.row.rowId), { token: mine.a.token, company: mine.w.co._id });
    expect(foreignFile.status).toBe(404);
    expect(foreignFile.body).toEqual(inventedFile.body);

    const foreignPatch = await patchStudy(mine.a, mine.w, theirStudy.studyId, { expectedRevision: 2, location: "Mine now" });
    expect(foreignPatch.status).toBe(404);
    expect((await IeMethodStudy.findById(theirStudy.studyId).lean()).location).toBe("Their line");
  });
});

/* ══ 3. THE SNAPSHOT, AND WHAT THE BULLETIN DOES TO IT ════════════════════ */

describe("the study says what it timed, whatever happens next", () => {
  test("the snapshot comes from the row, not from the live library", async () => {
    const { w, a, sew, fileId, row } = await bulletinRow("SnapshotSource");
    /* Move the library on BEFORE the study is opened: the row still carries
       revision 1, so the study must too. */
    const moved = await call(`/operations/library/${sew.operationId}`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { name: "Side seam (twin needle)", machineType: "DNLS", expectedRevision: 1 },
    });
    expect(moved.body.operation).toMatchObject({ revision: 2, machineType: "DNLS" });

    const study = await openStudy(a, w, fileId, row.rowId);
    expect(study.operation).toEqual({
      ieOperationId: sew.operationId, ieOperationRevision: 1,
      operationCode: "SEW-01", operationName: "Side seam", machineType: "SNLS",
    });
    expect(study.applicability).toBe("CURRENT");
  });

  test("later library edits and retirement leave the study exactly as it was", async () => {
    const { w, a, sew, fileId, row } = await bulletinRow("LibraryMoves");
    const study = await openStudy(a, w, fileId, row.rowId);

    await call(`/operations/library/${sew.operationId}`, {
      method: "PATCH", token: a.token, company: w.co._id,
      body: { code: "SEW-99", name: "Renamed", machineType: "DNLS", expectedRevision: 1 },
    });
    await call(`/operations/library/${sew.operationId}/retire`, {
      method: "POST", token: a.token, company: w.co._id, body: { expectedRevision: 2 },
    });

    const after = await call(`/method-studies/${study.studyId}`, { token: a.token, company: w.co._id });
    expect(after.body.study.operation).toEqual(study.operation);
    expect(after.body.study.applicability).toBe("CURRENT");
    expect(after.body.study.editable).toBe(true);
    expect(after.body.study.revision).toBe(1);
  });

  test("a reorder, a note and a proposed-SAM change keep the study CURRENT", async () => {
    const { w, a, sew, hem, fileId, fileRevision, row, secondRow } = await bulletinRow("StillCurrent", { rows: 2 });
    const study = await openStudy(a, w, fileId, row.rowId);

    const reordered = await patchBulletin(a, w, fileId, {
      expectedRevision: fileRevision,
      rows: [
        { rowId: secondRow.rowId, ieOperationId: hem.operationId },
        { rowId: row.rowId, ieOperationId: sew.operationId, proposedSamMinutes: 2.75, note: "watch the tension" },
      ],
    });
    expect(reordered.status).toBe(200);
    expect(reordered.body.file.bulletin.rows[1]).toMatchObject({
      rowId: row.rowId, proposedSamMinutes: 2.75, note: "watch the tension",
    });

    const after = await call(`/method-studies/${study.studyId}`, { token: a.token, company: w.co._id });
    expect(after.body.study.applicability).toBe("CURRENT");
    expect(after.body.study.editable).toBe(true);
    /* And it can still be edited. */
    expect((await patchStudy(a, w, study.studyId, { expectedRevision: 1, location: "Line 4" })).status).toBe(200);
  });

  test("replacing the row's operation supersedes the study and allows a new one", async () => {
    const { w, a, hem, fileId, fileRevision, row } = await bulletinRow("Replaced", { rows: 2 });
    const study = await openStudy(a, w, fileId, row.rowId);
    await patchStudy(a, w, study.studyId, { expectedRevision: 1, location: "Line 4", ratingPercent: 100 });

    const replaced = await patchBulletin(a, w, fileId, {
      expectedRevision: fileRevision,
      rows: [{ rowId: row.rowId, ieOperationId: hem.operationId, proposedSamMinutes: 1.5 }],
    });
    expect(replaced.status).toBe(200);

    const old = await call(`/method-studies/${study.studyId}`, { token: a.token, company: w.co._id });
    expect(old.status).toBe(200);
    expect(old.body.study.applicability).toBe("OPERATION_CHANGED");
    expect(old.body.study.editable).toBe(false);
    /* The evidence is intact — nothing was rebased and nothing deleted. */
    expect(old.body.study.operation.operationCode).toBe("SEW-01");
    expect(old.body.study.location).toBe("Line 4");

    /* And a NEW draft opens for the replacement operation. */
    const fresh = await call(studiesPath(fileId, row.rowId), { method: "POST", token: a.token, company: w.co._id, body: {} });
    expect(fresh.status).toBe(201);
    expect(fresh.body.created).toBe(true);
    expect(fresh.body.study.studyId).not.toBe(study.studyId);
    expect(fresh.body.study.operation).toMatchObject({ ieOperationId: hem.operationId, operationCode: "HEM-01" });
    expect(await IeMethodStudy.countDocuments({ bulletinRowId: row.rowId })).toBe(2);

    /* Both are listed for the row, newest first, each saying how it applies. */
    const list = await call(studiesPath(fileId, row.rowId), { token: a.token, company: w.co._id });
    expect(list.body.studies.map((s) => s.studyId)).toEqual([fresh.body.study.studyId, study.studyId]);
    expect(list.body.studies.map((s) => s.applicability)).toEqual(["CURRENT", "OPERATION_CHANGED"]);
    expect(list.body.rowPresent).toBe(true);
  });

  test("removing the row leaves the study readable as ROW_REMOVED", async () => {
    const { w, a, hem, fileId, fileRevision, row, secondRow } = await bulletinRow("RowRemoved", { rows: 2 });
    const study = await openStudy(a, w, fileId, row.rowId);

    const removed = await patchBulletin(a, w, fileId, {
      expectedRevision: fileRevision,
      rows: [{ rowId: secondRow.rowId, ieOperationId: hem.operationId }],
    });
    expect(removed.status).toBe(200);

    const after = await call(`/method-studies/${study.studyId}`, { token: a.token, company: w.co._id });
    expect(after.status).toBe(200);
    expect(after.body.study.applicability).toBe("ROW_REMOVED");
    expect(after.body.study.editable).toBe(false);
    expect(await IeMethodStudy.countDocuments({ _id: study.studyId })).toBe(1);

    const list = await call(studiesPath(fileId, row.rowId), { token: a.token, company: w.co._id });
    expect(list.body.rowPresent).toBe(false);
    expect(list.body.studies).toHaveLength(1);
  });

  test("a superseded study is readable and refuses every edit", async () => {
    const { w, a, hem, fileId, fileRevision, row } = await bulletinRow("StaleEdit", { rows: 2 });
    const study = await openStudy(a, w, fileId, row.rowId);
    await patchBulletin(a, w, fileId, {
      expectedRevision: fileRevision,
      rows: [{ rowId: row.rowId, ieOperationId: hem.operationId }],
    });

    const refused = await patchStudy(a, w, study.studyId, { expectedRevision: 1, location: "Too late" });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe("IE_METHOD_STUDY_SOURCE_CHANGED");
    expect(refused.body.error.details).toMatchObject({ applicability: "OPERATION_CHANGED", bulletinRowId: row.rowId });
    /* Not rebased, not deleted, not touched. */
    const stored = await IeMethodStudy.findById(study.studyId).lean();
    expect(stored.location).toBe("");
    expect(stored.revision).toBe(1);
    expect(stored.ieOperationId.toString()).not.toBe(hem.operationId);
  });
});

/* ══ 4. THE CYCLES AND THE CALCULATION ════════════════════════════════════ */

describe("observed time and normal time", () => {
  async function study(name) {
    const b = await bulletinRow(name);
    const s = await openStudy(b.a, b.w, b.fileId, b.row.rowId);
    return { ...b, study: s };
  }

  test("included cycles drive the average and the normal time", async () => {
    const { w, a, study: s } = await study("Average");
    const res = await patchStudy(a, w, s.studyId, {
      expectedRevision: 1,
      ratingPercent: 110,
      studiedAt: "2026-09-08T04:30:00.000Z",
      location: "Line 4",
      methodNote: "Two-hand method, guide fitted",
      evidenceNote: "Stopwatch, snap-back",
      observations: [
        { durationSeconds: 60 },
        { durationSeconds: 70 },
        { durationSeconds: 900, included: false, exclusionReason: "Thread break mid-cycle" },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    const out = res.body.study;
    expect(out.result).toEqual({
      includedCycleCount: 2,
      excludedCycleCount: 1,
      averageObservedSeconds: 65,
      ratingPercent: 110,
      normalTimeSeconds: 71.5,
      normalTimeMinutes: 1.1917,
      calculationComplete: true,
    });
    expect(out.studiedAt).toBe("2026-09-08T04:30:00.000Z");
    expect(out.observations.map((o) => o.sequence)).toEqual([1, 2, 3]);
    expect(out.observations.every((o) => /^obs_[0-9a-f]{18}$/.test(o.observationId))).toBe(true);
    /* The excluded cycle is kept, with its reason — it is evidence of the
       interruption, not a mistake to be deleted. */
    expect(out.observations[2]).toMatchObject({ included: false, exclusionReason: "Thread break mid-cycle" });
    /* The stored calculation matches the published one. */
    expect((await IeMethodStudy.findById(s.studyId).lean()).result.normalTimeMinutes).toBe(1.1917);
  });

  test("an excluded cycle must say why, and an included one keeps no reason", async () => {
    const { w, a, study: s } = await study("Exclusions");
    const refused = await patchStudy(a, w, s.studyId, {
      expectedRevision: 1,
      observations: [{ durationSeconds: 60 }, { durationSeconds: 90, included: false }],
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("IE_METHOD_STUDY_EXCLUSION_REASON_REQUIRED");
    expect(refused.body.error.details.fieldErrors[0]).toMatchObject({
      field: "observations.1.exclusionReason", code: "REQUIRED",
    });
    expect(refused.body.error.details.fieldErrors[0].observationId).toEqual(expect.stringMatching(/^obs_/));
    expect((await IeMethodStudy.findById(s.studyId).lean()).observations).toEqual([]);

    const blank = await patchStudy(a, w, s.studyId, {
      expectedRevision: 1,
      observations: [{ durationSeconds: 90, included: false, exclusionReason: "   " }],
    });
    expect(blank.body.error.code).toBe("IE_METHOD_STUDY_EXCLUSION_REASON_REQUIRED");

    /* Re-including a cycle drops the reason it no longer has. */
    const saved = await patchStudy(a, w, s.studyId, {
      expectedRevision: 1,
      observations: [{ durationSeconds: 90, included: true, exclusionReason: "no longer true" }],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.study.observations[0]).toMatchObject({ included: true, exclusionReason: "" });
  });

  test("missing cycles and a missing rating are null, never zero", async () => {
    const { w, a, study: s } = await study("Nulls");
    const rated = await patchStudy(a, w, s.studyId, { expectedRevision: 1, ratingPercent: 100 });
    expect(rated.body.study.result).toMatchObject({
      includedCycleCount: 0, averageObservedSeconds: null,
      normalTimeSeconds: null, normalTimeMinutes: null, calculationComplete: false,
    });

    const timed = await patchStudy(a, w, s.studyId, {
      expectedRevision: 2, ratingPercent: null, observations: [{ durationSeconds: 42 }],
    });
    expect(timed.body.study.result).toMatchObject({
      includedCycleCount: 1, averageObservedSeconds: 42,
      ratingPercent: null, normalTimeSeconds: null, normalTimeMinutes: null,
      calculationComplete: false,
    });

    /* Every cycle excluded is not an average of zero either. */
    const allOut = await patchStudy(a, w, s.studyId, {
      expectedRevision: 3, ratingPercent: 100,
      observations: [{ durationSeconds: 42, included: false, exclusionReason: "Machine jam" }],
    });
    expect(allOut.body.study.result).toMatchObject({
      includedCycleCount: 0, excludedCycleCount: 1,
      averageObservedSeconds: null, normalTimeSeconds: null, calculationComplete: false,
    });
  });

  test("the rounding is four decimals and is deterministic", async () => {
    const { w, a, study: s } = await study("Rounding");
    const res = await patchStudy(a, w, s.studyId, {
      expectedRevision: 1, ratingPercent: 97.5,
      observations: [{ durationSeconds: 31.3333 }, { durationSeconds: 42.6667 }, { durationSeconds: 55.1 }],
    });

    const { result } = res.body.study;
    expect(result.averageObservedSeconds).toBe(43.0333);
    expect(result.normalTimeSeconds).toBe(41.9575);
    expect(result.normalTimeMinutes).toBe(0.6993);
    for (const v of [result.averageObservedSeconds, result.normalTimeSeconds, result.normalTimeMinutes]) {
      expect(String(v).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
    }
    /* Reading it back gives the same numbers — they are stored, not re-derived
       differently. */
    const again = await call(`/method-studies/${s.studyId}`, { token: a.token, company: w.co._id });
    expect(again.body.study.result).toEqual(result);
  });

  test("a cycle of zero, a negative one and a bad rating are refused by name", async () => {
    const { w, a, study: s } = await study("BadInputs");
    for (const [observations, field] of [
      [[{ durationSeconds: 0 }], "observations.0.durationSeconds"],
      [[{ durationSeconds: -5 }], "observations.0.durationSeconds"],
      [[{ durationSeconds: "60" }], "observations.0.durationSeconds"],
      [[{ durationSeconds: 60 }, { note: "forgot the time" }], "observations.1.durationSeconds"],
    ]) {
      const res = await patchStudy(a, w, s.studyId, { expectedRevision: 1, observations });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_METHOD_STUDY_OBSERVATION_INVALID");
      expect(res.body.error.details.field).toBe(field);
    }

    for (const ratingPercent of [0, -10, 501, "100"]) {
      const res = await patchStudy(a, w, s.studyId, { expectedRevision: 1, ratingPercent });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_METHOD_STUDY_RATING_INVALID");
      expect(res.body.error.details.field).toBe("ratingPercent");
    }

    /* Nothing was half-written by any of that. */
    const stored = await IeMethodStudy.findById(s.studyId).lean();
    expect(stored.revision).toBe(1);
    expect(stored.observations).toEqual([]);
    expect(stored.ratingPercent).toBeNull();
  });

  test("cycle ids are stable across edits, and an unknown one is refused", async () => {
    const { w, a, study: s } = await study("StableIds");
    const first = await patchStudy(a, w, s.studyId, {
      expectedRevision: 1, observations: [{ durationSeconds: 60 }, { durationSeconds: 70 }],
    });
    const [one, two] = first.body.study.observations;

    /* Reorder, re-time, and add a third: the two originals keep their ids. */
    const second = await patchStudy(a, w, s.studyId, {
      expectedRevision: 2,
      observations: [
        { observationId: two.observationId, durationSeconds: 70 },
        { observationId: one.observationId, durationSeconds: 65 },
        { durationSeconds: 80 },
      ],
    });
    const after = second.body.study.observations;
    expect(after.map((o) => o.observationId).slice(0, 2)).toEqual([two.observationId, one.observationId]);
    expect(after.map((o) => o.sequence)).toEqual([1, 2, 3]);
    expect(after[1].durationSeconds).toBe(65);
    expect(after[2].observationId).not.toBe(one.observationId);

    const unknown = await patchStudy(a, w, s.studyId, {
      expectedRevision: 3, observations: [{ observationId: "obs_deadbeefdeadbeefde", durationSeconds: 10 }],
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe("IE_METHOD_STUDY_OBSERVATION_INVALID");
    expect(unknown.body.error.details.fieldErrors[0].field).toBe("observations.0.observationId");
  });

  test("unknown and server-owned fields are refused, on the study and on a cycle", async () => {
    const { w, a, study: s } = await study("RefusedFields");
    for (const body of [
      { expectedRevision: 1, colour: "blue" },
      { expectedRevision: 1, status: "APPROVED" },
      { expectedRevision: 1, revision: 5 },
      { expectedRevision: 1, result: { normalTimeSeconds: 1 } },
      { expectedRevision: 1, normalTimeSeconds: 12 },
      { expectedRevision: 1, standardTimeMinutes: 1.4 },
      { expectedRevision: 1, allowancePercent: 12 },
      { expectedRevision: 1, workerName: "Someone" },
      { expectedRevision: 1, employeeId: "GR0067" },
      { expectedRevision: 1, wageRate: 500 },
      { expectedRevision: 1, ieOperationId: String(new mongoose.Types.ObjectId()) },
      { expectedRevision: 1, history: [] },
      { expectedRevision: 1, observations: [{ durationSeconds: 60, sequence: 4 }] },
      { expectedRevision: 1, observations: [{ durationSeconds: 60, workerName: "Someone" }] },
      { expectedRevision: 1, observations: [{ durationSeconds: 60, ratingPercent: 100 }] },
      { expectedRevision: 1, observations: [{ durationSeconds: 60, colour: "blue" }] },
    ]) {
      const res = await patchStudy(a, w, s.studyId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(typeof res.body.error.details.field).toBe("string");
    }
    const stored = await IeMethodStudy.findById(s.studyId).lean();
    expect(stored.revision).toBe(1);
    /* No person and no pay, ever — the rule this record was designed around.
       (Chunk 4B added an `approved` standard time and a frozen allowance
       snapshot to the lifecycle; on a draft both are empty, asserted below.) */
    expect(JSON.stringify(stored)).not.toMatch(/workerName|employeeId|wageRate|designation/i);
    expect(stored.approved.standardTimeMinutes).toBeNull();
    expect(stored.approved.totalAllowancePercent).toBeNull();
    expect(stored.submissions).toEqual([]);
  });
});

/* ══ 5. CONCURRENCY, NO-OPS AND AUDIT ═════════════════════════════════════ */

describe("one revision, one winner, one history", () => {
  async function study(name) {
    const b = await bulletinRow(name);
    const s = await openStudy(b.a, b.w, b.fileId, b.row.rowId);
    const saved = await patchStudy(b.a, b.w, s.studyId, {
      expectedRevision: 1, location: "Line 4", ratingPercent: 100,
      observations: [{ durationSeconds: 60 }, { durationSeconds: 62, included: false, exclusionReason: "Bobbin change" }],
    });
    expect(saved.status).toBe(200);
    return { ...b, study: saved.body.study };
  }
  const resend = (s) => s.observations.map((o) => ({
    observationId: o.observationId, durationSeconds: o.durationSeconds,
    included: o.included, exclusionReason: o.exclusionReason, note: o.note,
  }));

  test("two edits quoting the same revision: exactly one lands", async () => {
    const { w, a, study: s } = await study("EditRace");
    /* Two DIFFERENT values, both different from what is stored — so both are
       real changes and the only thing that can separate them is the revision. */
    const send = (location) => patchStudy(a, w, s.studyId, { expectedRevision: s.revision, location });
    const [one, two] = await Promise.all([send("Line 7"), send("Line 9")]);

    const winners = [one, two].filter((r) => r.status === 200);
    const losers = [one, two].filter((r) => r.status !== 200);
    expect(winners).toHaveLength(1);
    expect(losers[0].status).toBe(409);
    expect(losers[0].body.error.code).toBe("IE_METHOD_STUDY_REVISION_CONFLICT");
    expect(losers[0].body.error.details).toMatchObject({ expected: s.revision, actual: s.revision + 1 });

    const stored = await IeMethodStudy.findById(s.studyId).lean();
    expect(stored.revision).toBe(s.revision + 1);
    expect(stored.location).toBe(winners[0].body.study.location);
    /* The loser wrote no audit entry either. */
    expect(stored.history.filter((e) => e.type === "METHOD_STUDY_EDITED")).toHaveLength(2);
  });

  test("a no-op racing a real edit loses nothing", async () => {
    /* Both quote the current revision; one changes something and one does not.
       The no-op writes nothing, so there is nothing for it to overwrite — it
       is answered as a no-op rather than as a conflict, and the real edit
       lands exactly once. */
    const { w, a, study: s } = await study("NoOpRace");
    const [noop, real] = await Promise.all([
      patchStudy(a, w, s.studyId, { expectedRevision: s.revision, location: s.location }),
      patchStudy(a, w, s.studyId, { expectedRevision: s.revision, location: "Line 9" }),
    ]);

    expect(noop.status).toBe(200);
    expect(noop.body.updated).toBe(false);
    expect(real.status).toBe(200);
    expect(real.body.updated).toBe(true);

    const stored = await IeMethodStudy.findById(s.studyId).lean();
    expect(stored.location).toBe("Line 9");
    expect(stored.revision).toBe(s.revision + 1);
    expect(stored.history.filter((e) => e.type === "METHOD_STUDY_EDITED")).toHaveLength(2);
  });

  test("a stale request is refused even when its values would change nothing", async () => {
    const { w, a, study: s } = await study("StaleNoOp");
    await patchStudy(a, w, s.studyId, { expectedRevision: s.revision, location: "Line 7" });

    const stale = await patchStudy(a, w, s.studyId, {
      expectedRevision: s.revision, location: "Line 7", ratingPercent: 100, observations: resend(s),
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_METHOD_STUDY_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: s.revision, actual: s.revision + 1 });
  });

  test("re-sending the same study changes nothing and says so", async () => {
    const { w, a, study: s } = await study("NoOp");
    const before = await IeMethodStudy.findById(s.studyId).lean();

    const res = await patchStudy(a, w, s.studyId, {
      expectedRevision: s.revision,
      location: "Line 4",
      ratingPercent: 100,
      /* Padded text and an omitted note normalise to what is stored. */
      observations: resend(s).map((o) => ({ ...o, note: `  ${o.note}  ` })),
    });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    expect(res.body.study.revision).toBe(s.revision);
    expect(res.body.study.result).toEqual(s.result);

    const after = await IeMethodStudy.findById(s.studyId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("a real edit bumps the revision once and writes one audit entry", async () => {
    const { w, a, study: s } = await study("RealEdit");
    const before = await IeMethodStudy.findById(s.studyId).lean();

    const res = await patchStudy(a, w, s.studyId, {
      expectedRevision: s.revision, ratingPercent: 95,
      observations: [...resend(s), { durationSeconds: 58 }],
    });

    expect(res.body.updated).toBe(true);
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "METHOD_STUDY_EDITED", studyRevision: s.revision + 1, actorName: expect.stringMatching(/^IE Engineer /),
    });
    expect(res.body.events[0].changed.sort()).toEqual(["observations", "rating"]);

    const after = await IeMethodStudy.findById(s.studyId).lean();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.history).toHaveLength(before.history.length + 1);
    /* The audit line says WHAT KIND of thing changed, and carries no cycles. */
    expect(JSON.stringify(after.history)).not.toMatch(/durationSeconds|observationId/);
    expect(after.history.at(-1).summary.length).toBeLessThanOrEqual(300);

    const detail = await call(`/method-studies/${s.studyId}`, { token: a.token, company: w.co._id });
    expect(detail.body.study.history.map((e) => e.type))
      .toEqual(["METHOD_STUDY_EDITED", "METHOD_STUDY_EDITED", "METHOD_STUDY_CREATED"]);
  });

  test("a study edit never touches the bulletin or the operation library", async () => {
    const { w, a, sew, fileId, fileRevision, study: s } = await study("NoSideEffects");
    const file = await IeStyleFile.findById(fileId).lean();
    const op = await IeOperation.findById(sew.operationId).lean();

    await patchStudy(a, w, s.studyId, {
      expectedRevision: s.revision, ratingPercent: 120,
      observations: [{ durationSeconds: 99 }],
    });

    const fileAfter = await IeStyleFile.findById(fileId).lean();
    const opAfter = await IeOperation.findById(sew.operationId).lean();
    expect(fileAfter.revision).toBe(fileRevision);
    expect(fileAfter.revision).toBe(file.revision);
    expect(fileAfter.bulletin.rows).toEqual(file.bulletin.rows);
    expect(fileAfter.history).toHaveLength(file.history.length);
    expect(opAfter.revision).toBe(op.revision);
    expect(opAfter.updatedAt.toISOString()).toBe(op.updatedAt.toISOString());
  });

  test("nothing here releases a time, writes a bulletin row, or deletes evidence", async () => {
    /* ── WHAT THIS TEST USED TO SAY ─────────────────────────────────────────
       In Chunk 4A it asserted that no submit or approve verb existed at all.
       Chunk 4B is the chunk that adds them, deliberately and under
       maker-checker, so that half of the claim is superseded — the lifecycle
       endpoints are proved in the Chunk 4B suite.

       What remains true, and is what this test now holds, is the boundary that
       has not moved: an approved standard time is not RELEASED to another
       department, is not written into the bulletin, and no evidence can be
       deleted. */
    const { w, a, fileId, row, study: s } = await study("NoRelease");
    for (const path of [
      `/method-studies/${s.studyId}/release`,
      `/method-studies/${s.studyId}/publish`,
      `/method-studies/${s.studyId}/apply`,
      `/method-studies/${s.studyId}/apply-to-bulletin`,
      `/engineering-files/${fileId}/bulletin/${row.rowId}/apply-standard-time`,
      `/engineering-files/${fileId}/approve`,
      `/engineering-files/${fileId}/release`,
    ]) {
      expect((await call(path, { method: "POST", token: a.token, company: w.co._id, body: {} })).status).toBe(404);
    }
    for (const path of [`/method-studies/${s.studyId}`, `/method-studies/${s.studyId}/submissions`]) {
      expect((await call(path, { method: "DELETE", token: a.token, company: w.co._id })).status).toBe(404);
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
    expect(paths.filter((p) => /release|publish-to|apply/i.test(p))
      .filter((p) => p !== "/style-files/:fileId/releases"
        && p !== "/releases/:releaseId/impact")).toEqual([]);
    /* The one `publish` on this router is the allowance policy's own — a
       company decision, not a release to another department. */
    expect(paths.filter((p) => /publish/i.test(p))).toEqual(["/allowance-policies/:policyId/publish"]);
    expect(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods))).not.toContain("delete");
    /* An incomplete study still cannot be submitted — `canSubmit` is about the
       record, and this one has no study date. */
    expect(s.canSubmit).toBe(false);
    expect(s.submissionReadiness.gaps.map((g) => g.code)).toContain("IE_STUDY_DATE_MISSING");
  });
});

/* ══ 6. THE ARITHMETIC ON ITS OWN ═════════════════════════════════════════ */

describe("the calculation, without a server", () => {
  const obs = (durationSeconds, included = true) => ({ durationSeconds, included });

  test("the canonical formula", () => {
    expect(calculateMethodStudy({ observations: [obs(60), obs(70)], ratingPercent: 110 })).toEqual({
      includedCycleCount: 2, excludedCycleCount: 0,
      averageObservedSeconds: 65, ratingPercent: 110,
      normalTimeSeconds: 71.5, normalTimeMinutes: 1.1917, calculationComplete: true,
    });
  });

  test("100 means observed pace was normal pace", () => {
    const out = calculateMethodStudy({ observations: [obs(48)], ratingPercent: 100 });
    expect(out.normalTimeSeconds).toBe(out.averageObservedSeconds);
    /* Above 100 the operator was faster than normal, so the standard must be
       LONGER than what was observed — and below 100, shorter. */
    expect(calculateMethodStudy({ observations: [obs(48)], ratingPercent: 125 }).normalTimeSeconds).toBe(60);
    expect(calculateMethodStudy({ observations: [obs(48)], ratingPercent: 75 }).normalTimeSeconds).toBe(36);
  });

  test("excluded cycles are counted but never averaged", () => {
    const out = calculateMethodStudy({
      observations: [obs(60), obs(9999, false), obs(70)], ratingPercent: 100,
    });
    expect(out).toMatchObject({ includedCycleCount: 2, excludedCycleCount: 1, averageObservedSeconds: 65 });
  });

  test("missing inputs are null and never zero", () => {
    expect(calculateMethodStudy({ observations: [], ratingPercent: 100 })).toMatchObject({
      averageObservedSeconds: null, normalTimeSeconds: null, normalTimeMinutes: null, calculationComplete: false,
    });
    expect(calculateMethodStudy({ observations: [obs(60)], ratingPercent: null })).toMatchObject({
      averageObservedSeconds: 60, normalTimeSeconds: null, calculationComplete: false,
    });
    expect(calculateMethodStudy({})).toMatchObject({
      includedCycleCount: 0, averageObservedSeconds: null, normalTimeSeconds: null,
    });
  });

  test("four decimals, and the same answer every time", () => {
    const input = { observations: [obs(31.3333), obs(42.6667), obs(55.1)], ratingPercent: 97.5 };
    const once = calculateMethodStudy(input);
    expect(once).toEqual(calculateMethodStudy({ ...input, observations: [...input.observations] }));
    expect(once.averageObservedSeconds).toBe(43.0333);
    expect(once.normalTimeSeconds).toBe(41.9575);
    /* Minutes follow the ROUNDED seconds, so the two published figures agree. */
    expect(once.normalTimeMinutes).toBe(Math.round((once.normalTimeSeconds / 60) * 10000) / 10000);
  });

  test("it reads no allowance and produces no standard time", () => {
    const out = calculateMethodStudy({
      observations: [obs(60)], ratingPercent: 100, allowancePercent: 15, wageRate: 500,
    });
    expect(Object.keys(out).sort()).toEqual([
      "averageObservedSeconds", "calculationComplete", "excludedCycleCount",
      "includedCycleCount", "normalTimeMinutes", "normalTimeSeconds", "ratingPercent",
    ]);
  });
});
