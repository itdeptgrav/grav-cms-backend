// test/industrial-engineering/ie-line-layout-approval.route.test.js
//
// IE CHUNK 7C2 — LINE LAYOUT APPROVAL, AT THE WIRE.
//
// A layout is opened against an APPROVED operation bulletin version and, once a
// second person accepts the balance, becomes permanent evidence of the plan.
// The claims worth holding:
//
//   · a new layout copies the approved version's identity and its frozen rows,
//     and a client can neither supply nor override either version field;
//   · no approved version means no layout, and a foreign, mismatched, returned
//     or superseded one is indistinguishable from none;
//   · opening twice resumes one draft, and approving releases the slot;
//   · a pre-7C1 layout stays readable for ever and is never approvable;
//   · every gate is returned together, never the first alone;
//   · maker-checker compares actor ids, with no owner exemption;
//   · an approved layout refuses every edit, every template and every write
//     path, and nothing downstream restates it;
//   · and nothing here reads or writes Production, PPC, a work order or a scan.
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
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeMethodStudy = require("../../models/CMS_Models/IndustrialEngineering/IeMethodStudy");
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");

const { calculateLineBalance } = require("../../services/industrialEngineering/lineBalanceCalculation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  await IeLineLayout.syncIndexes();
  await IeMethodStudy.syncIndexes();
  await IeStyleFile.syncIndexes();
  await IeBulletinVersion.syncIndexes();
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
  const email = `ll${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "L", lastName: `L${n}`, email, biometricId: `LL${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "L" });
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
const viewerIn = (...cos) => actor({ companies: cos, grants: { ie: "viewer" } });

/**
 * A company with an engineering file whose bulletin rows each carry an APPROVED
 * standard time of exactly the minutes asked for.
 *
 * The approved time is set through Chunk 4B's manual override, so the balance
 * arithmetic below is exact and the allowance policy's own value cannot make it
 * ambiguous — the policy is published at 0% for the same reason.
 */
async function world(name, { minutes = [1, 1.2, 0.8, 1.5], approveAll = true, requirements = true } = {}) {
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
      technical: { status: "approved", revision: 3 },
      technicalRevisions: [{
        revision: 3, submittedAt: new Date("2026-08-01"), outcome: "approved", decidedAt: new Date("2026-08-05"),
        snapshot: { revision: 3, materials: [], requirements: [], operations: [] },
      }],
    },
    production: { workOrderIds: [wo._id] },
  });

  const maker = await editorIn(co);
  const approver = await approverIn(co);
  const t = { token: maker.token, company: co._id };

  /* A published 0% allowance policy, made properly by two people. */
  const policyAuthor = await editorIn(co);
  const drafted = await call("/allowance-policies", {
    method: "POST", token: policyAuthor.token, company: co._id,
    body: { name: "No allowance", effectiveFrom: "2026-01-01", categories: [] },
  });
  await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
    method: "POST", token: approver.token, company: co._id, body: { expectedRevision: 1 },
  });

  const file = (await call(`/orders/${wo._id}/styles/${style._id}/engineering-file`, {
    method: "POST", ...t, body: {},
  })).body.file;

  /* ── EACH OPERATION'S CHUNK 5A REQUIREMENT, CONFIGURED FIRST ───────────
     Before the bulletin is authored, so every row freezes real machine-type
     evidence. Chunk 7C2 approval requires every placed operation to be PROVABLY
     compatible, and a row with nothing frozen is UNKNOWN — which is a refusal,
     not a pass. A world that could not configure this could not approve
     anything, so it is part of the ordinary fixture rather than a special case. */
  const operations = [];
  for (let i = 0; i < minutes.length; i += 1) {
    const op = (await call("/operations/library", {
      method: "POST", ...t, body: { code: `OP-${i + 1}`, name: `Operation ${i + 1}`, machineType: "SNLS" },
    })).body.operation;
    if (requirements) {
      const configured = await call(`/operations/library/${op.operationId}/requirements`, {
        method: "PATCH", ...t,
        body: {
          expectedRevision: op.revision,
          machineRequirements: [{ machineType: "SNLS", quantity: 1 }],
          attachmentRequirements: [],
          labourRequirements: [],
        },
      });
      expect(configured.status).toBe(200);
      operations.push(configured.body.operation);
      continue;
    }
    operations.push(op);
  }
  const bulletin = await call(`/engineering-files/${file.fileId}/bulletin`, {
    method: "PATCH", ...t,
    body: {
      expectedRevision: 1,
      rows: operations.map((op) => ({ ieOperationId: op.operationId, proposedSamMinutes: 1 })),
    },
  });
  expect(bulletin.status).toBe(200);
  const rows = bulletin.body.file.bulletin.rows;

  /* One approved method study per row, at exactly the minutes asked for. */
  const approvals = [];
  for (let i = 0; i < rows.length; i += 1) {
    if (!approveAll && i === rows.length - 1) break;
    const opened = await call(`/engineering-files/${file.fileId}/bulletin/${rows[i].rowId}/method-studies`, {
      method: "POST", ...t, body: {},
    });
    const studyId = opened.body.study.studyId;
    const filled = await call(`/method-studies/${studyId}`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: 1,
        studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 4",
        methodNote: "Two-hand method", ratingPercent: 100,
        observations: [{ durationSeconds: 60 }],
      },
    });
    const submitted = await call(`/method-studies/${studyId}/submit`, {
      method: "POST", ...t,
      body: {
        expectedRevision: filled.body.study.revision,
        manualStandardTimeMinutes: minutes[i],
        overrideReason: "Fixed standard agreed for this exercise.",
      },
    });
    expect(submitted.status).toBe(200);
    const approved = await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: approver.token, company: co._id,
      body: { expectedRevision: submitted.body.study.revision },
    });
    expect(approved.status).toBe(200);
    approvals.push({ studyId, rowId: rows[i].rowId, minutes: minutes[i], submission: approved.body.submission.submissionId });
  }

  /* ── CHUNK 7C2: A LINE IS BALANCED AGAINST AN APPROVED BULLETIN ────────
     `POST .../line-layouts` no longer reads the Style File's mutable draft; it
     opens against the version a second person approved. So every world that
     expects to open a layout submits its bulletin and has it approved first,
     exactly as a person would. */
  const version = await approveBulletinVersion({ co, maker, approver, fileId: file.fileId, skip: !approveAll });

  return {
    co, maker, approver, style, workOrder: wo,
    fileId: file.fileId, rows, operations, approvals,
    fileRevision: version.fileRevision,
    fileRevisionNow: version.fileRevisionNow,
    bulletinVersion: version.version,
  };
}

/**
 * Submit this file's bulletin and have a second person approve it — Chunk 7C1.
 *
 * Every layout in this suite is opened against the result, because Chunk 7C2
 * made that the only thing a line may be balanced against. The approver is a
 * third actor, not the world's own `approver`, only where maker-checker would
 * otherwise refuse; here the maker submits and the approver decides, which is
 * the ordinary case.
 */
async function approveBulletinVersion({ co, maker, approver, fileId, skip = false }) {
  /* A world built deliberately incomplete — a row with no approved standard
     time — cannot submit a bulletin at all, which is Chunk 7C1's own gate. Such
     a world has no approved version, and opening a layout against it is refused
     for exactly that reason. */
  if (skip) return { version: null, fileRevision: null, fileRevisionNow: null };
  const file = await IeStyleFile.findById(fileId).lean();
  const submitted = await call(`/engineering-files/${fileId}/bulletin-versions`, {
    method: "POST", token: maker.token, company: co._id,
    body: { expectedRevision: file.revision },
  });
  expect(submitted.status).toBe(201);

  const approved = await call(`/bulletin-versions/${submitted.body.version.bulletinVersionId}/approve`, {
    method: "POST", token: approver.token, company: co._id,
    body: { expectedRevision: submitted.body.version.revision },
  });
  expect(approved.status).toBe(200);
  return {
    version: approved.body.version,
    /* The revision the ROWS came from — which is what a layout's
       `bulletinRevision` has always meant, and still does. */
    fileRevision: approved.body.version.fileRevisionAtSubmit,
    /* And where the file itself stands now, after the submit and the approval
       each moved it. This is what an edit of the successor draft must send. */
    fileRevisionNow: approved.body.file.revision,
  };
}


/**
 * Approve ANOTHER method study for a row that already has one.
 *
 * Chunk 4B permits this — an approved study is re-timed and approved again —
 * and it changes the current approved standard without touching the bulletin.
 */
async function approveAgain(w, rowIndex, { minutes }) {
  const t = { token: w.maker.token, company: w.co._id };
  const rowId = w.rows[rowIndex].rowId;
  const opened = await call(`/engineering-files/${w.fileId}/bulletin/${rowId}/method-studies`, {
    method: "POST", ...t, body: {},
  });
  expect(opened.status).toBe(201);
  const studyId = opened.body.study.studyId;
  const filled = await call(`/method-studies/${studyId}`, {
    method: "PATCH", ...t,
    body: {
      expectedRevision: 1, studiedAt: "2026-09-09T04:30:00.000Z", location: "Line 4",
      methodNote: "Re-timed", ratingPercent: 100, observations: [{ durationSeconds: 60 }],
    },
  });
  const submitted = await call(`/method-studies/${studyId}/submit`, {
    method: "POST", ...t,
    body: {
      expectedRevision: filled.body.study.revision,
      manualStandardTimeMinutes: minutes,
      overrideReason: "Re-timed after a method change.",
    },
  });
  expect(submitted.status).toBe(200);
  const approved = await call(`/method-studies/${studyId}/approve`, {
    method: "POST", token: w.approver.token, company: w.co._id,
    body: { expectedRevision: submitted.body.study.revision },
  });
  expect(approved.status).toBe(200);
  return { studyId, submissionId: approved.body.submission.submissionId, minutes };
}

const open = (a, w) => call(`/engineering-files/${w.fileId}/line-layouts`, {
  method: "POST", token: a.token, company: w.co._id, body: {},
});
const readLayout = (a, w, layoutId) => call(`/line-layouts/${layoutId}`, { token: a.token, company: w.co._id });
const patchLayout = (a, w, layoutId, body) => call(`/line-layouts/${layoutId}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const station = (assignments, extra = {}) => ({ assignments: assignments.map((rowId) => ({ rowId })), ...extra });


/* ── THE 7C2 SURFACE ──────────────────────────────────────────────────────── */

const approveLayout = (a, w, layoutId, body) => call(`/line-layouts/${layoutId}/approve`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const listLayouts = (a, w, qs = "") => call(`/engineering-files/${w.fileId}/line-layouts${qs}`, {
  token: a.token, company: w.co._id,
});

/** A layout with every row placed at two stations — approvable, if a second
 *  person asks. The author is the world's maker unless one is named. */
async function arranged(w, author) {
  const a = author || w.maker;
  const opened = await open(a, w);
  /* 201 when it created the draft, 200 when it resumed the one already open —
     either is a draft to arrange. */
  expect([200, 201]).toContain(opened.status);
  const layout = opened.body.layout;
  const [r1, r2, r3, r4] = layout.source.rows.map((r) => r.rowId);
  const saved = await patchLayout(a, w, layout.layoutId, {
    expectedRevision: layout.revision,
    stations: [
      station([r1, r2], { label: "Front", plannedMachineTypes: [{ machineType: "SNLS", quantity: 2 }] }),
      station([r3, r4], { label: "Close", plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }] }),
    ],
  });
  expect(saved.status).toBe(200);
  return saved.body.layout;
}

/** Arranged, and approved by somebody other than its author. */
async function approvedLayout(name) {
  const w = await world(name);
  const layout = await arranged(w);
  const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
  expect(res.status).toBe(200);
  return { w, layout: res.body.layout, before: layout };
}

/* ══ 1. A LAYOUT IS OPENED FROM AN APPROVED BULLETIN VERSION ══════════════ */

describe("a new layout copies the approved version's identity and frozen source", () => {
  test("it names the exact version and copies its rows, fingerprint and digests", async () => {
    const w = await world("Copy");
    const version = w.bulletinVersion;
    const res = await open(w.maker, w);
    expect(res.status).toBe(201);
    const l = res.body.layout;

    expect(l.versionBacked).toBe(true);
    expect(l.bulletinVersion).toEqual({
      bulletinVersionId: version.bulletinVersionId, versionNo: 1, state: "APPROVED",
    });
    /* `bulletinRevision` keeps the meaning it has always had, taken from the
       version's own record of which file revision it snapshotted. */
    expect(l.source.bulletinRevision).toBe(version.fileRevisionAtSubmit);
    expect(l.source.fingerprint).toBe(version.source.fingerprint);
    expect(l.source.approvalDigest).toBe(version.source.approvalDigest);
    expect(l.source.state).toBe("CURRENT");

    /* Row for row, exactly the version's frozen evidence — nothing re-resolved. */
    expect(l.source.rows).toHaveLength(version.rows.length);
    version.rows.forEach((frozen, i) => {
      const copied = l.source.rows[i];
      expect(copied.rowId).toBe(frozen.rowId);
      expect(copied.ieOperationId).toBe(frozen.ieOperationId);
      expect(copied.ieOperationRevision).toBe(frozen.ieOperationRevision);
      expect(copied.standardTimeMinutes).toBe(frozen.standardTimeMinutes);
      expect(copied.methodStudyId).toBe(frozen.methodStudyId);
      expect(copied.approvedSubmissionId).toBe(frozen.approvedSubmissionId);
      expect(copied.requirementSnapshot).toEqual(frozen.requirementSnapshot);
    });

    const stored = await IeLineLayout.findById(l.layoutId).lean();
    expect(String(stored.ieBulletinVersionId)).toBe(version.bulletinVersionId);
    expect(stored.bulletinVersionNo).toBe(1);
    expect(stored.status).toBe("DRAFT");
    expect("approvedBy" in stored).toBe(false);
    expect("approvedRevision" in stored).toBe(false);
  });

  test("a client can neither supply nor override either version field", async () => {
    const w = await world("NoOverride");
    for (const body of [
      { ieBulletinVersionId: String(new mongoose.Types.ObjectId()) },
      { bulletinVersionNo: 9 },
      { bulletinRevision: 1 },
      { sourceFingerprint: "f".repeat(64) },
      { sourceRows: [] },
      { status: "APPROVED" },
      { approvedBy: String(new mongoose.Types.ObjectId()) },
    ]) {
      const res = await call(`/engineering-files/${w.fileId}/line-layouts`, {
        method: "POST", token: w.maker.token, company: w.co._id, body,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(Object.keys(body)[0]);
    }
    expect(await IeLineLayout.countDocuments({})).toBe(0);
  });

  test("a file with no approved version cannot open a layout at all", async () => {
    const w = await world("NoVersion", { approveAll: false });
    expect(w.bulletinVersion).toBeNull();
    const res = await open(w.maker, w);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_BULLETIN_NOT_APPROVED");
    expect(res.body.error.details.fileId).toBe(String(w.fileId));
    expect(await IeLineLayout.countDocuments({})).toBe(0);
  });

  test("a returned, superseded, foreign or mismatched version is refused identically", async () => {
    const w = await world("Pointers");
    const good = await open(w.maker, w);
    expect(good.status).toBe(201);
    const answers = [];

    /* The pointer is not taken on trust. Each of these leaves it naming
       something that is not this file's current APPROVED version. */
    const theirs = await world("TheirPointer");
    const cases = [
      ["a version that does not exist", { currentApprovedBulletinVersionId: new mongoose.Types.ObjectId() }],
      ["another company's version", {
        currentApprovedBulletinVersionId: new mongoose.Types.ObjectId(String(theirs.bulletinVersion.bulletinVersionId)),
      }],
    ];
    for (const [, patch] of cases) {
      await IeStyleFile.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(String(w.fileId)) }, { $set: patch },
      );
      const res = await open(w.maker, w);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("IE_LAYOUT_BULLETIN_NOT_APPROVED");
      answers.push(JSON.stringify(res.body));
    }

    /* And a version of this file that is no longer APPROVED. */
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.fileId)) },
      { $set: { currentApprovedBulletinVersionId: new mongoose.Types.ObjectId(String(w.bulletinVersion.bulletinVersionId)) } },
    );
    await IeBulletinVersion.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.bulletinVersion.bulletinVersionId)) },
      { $set: { state: "SUPERSEDED" } },
    );
    const superseded = await open(w.maker, w);
    expect(superseded.status).toBe(409);
    answers.push(JSON.stringify(superseded.body));

    /* Every refusal is the same refusal: the state of somebody else's record is
       not discoverable by trying to open a layout. */
    expect(new Set(answers).size).toBe(1);
    expect(answers[0]).not.toContain(theirs.bulletinVersion.bulletinVersionId);
  });

  test("opening twice resumes one draft, and approving releases the slot", async () => {
    const w = await world("Resume");
    const first = await open(w.maker, w);
    expect(first.body.created).toBe(true);
    const again = await open(w.maker, w);
    expect(again.body.created).toBe(false);
    expect(again.body.layout.layoutId).toBe(first.body.layout.layoutId);
    expect(await IeLineLayout.countDocuments({})).toBe(1);

    /* Arrange and approve it. */
    const layout = await arranged(w);
    const approved = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: layout.revision,
    });
    expect(approved.status).toBe(200);

    /* The successor draft opens against the SAME approved version, because that
       is still the version the file stands behind. */
    const successor = await open(w.maker, w);
    expect(successor.status).toBe(201);
    expect(successor.body.created).toBe(true);
    expect(successor.body.layout.layoutId).not.toBe(layout.layoutId);
    expect(successor.body.layout.bulletinVersion.versionNo).toBe(1);
    expect(successor.body.layout.stations).toEqual([]);

    /* And the approved one is untouched. */
    const evidence = await IeLineLayout.findById(layout.layoutId).lean();
    expect(evidence.status).toBe("APPROVED");
    expect(evidence.stations).toHaveLength(2);
    expect(await IeLineLayout.countDocuments({})).toBe(2);
    /* Two drafts for one version are still impossible. */
    expect(await IeLineLayout.countDocuments({ status: "DRAFT" })).toBe(1);
  });
});

/* ══ 2. THE APPROVAL ══════════════════════════════════════════════════════ */

describe("approving a layout", () => {
  test("one atomic write sets the status, the approver and the approved revision", async () => {
    const w = await world("Approve");
    const layout = await arranged(w);
    expect(layout.canApprove).toBe(true);

    const res = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: layout.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    const l = res.body.layout;
    expect(l.status).toBe("APPROVED");
    expect(l.revision).toBe(layout.revision + 1);
    expect(l.approval.approvedRevision).toBe(layout.revision);
    expect(l.approval.approvedByName).toBeTruthy();
    expect(l.approval.approvedAt).toBeTruthy();
    expect(l.editable).toBe(false);
    expect(l.canApprove).toBe(false);
    /* And nothing downstream is implied. */
    expect(l.canRelease).toBe(false);
    expect(l.allocates).toBe(false);

    /* One bounded event, whose revision is the one the record reached. */
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "LINE_LAYOUT_APPROVED", layoutRevision: layout.revision + 1,
    });
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.status).toBe("APPROVED");
    expect(stored.approvedRevision).toBe(layout.revision);
    expect(String(stored.approvedBy)).toBe(String((await DeptUserIdOf(w.approver))));
    expect(stored.history.at(-1).type).toBe("LINE_LAYOUT_APPROVED");
    expect(stored.history.at(-1).layoutRevision).toBe(stored.revision);
    expect(stored.history.length).toBeLessThanOrEqual(IeLineLayout.LIMITS.HISTORY);

    /* The bulletin version it balances is untouched by the approval. */
    const version = await IeBulletinVersion.findById(w.bulletinVersion.bulletinVersionId).lean();
    expect(version.state).toBe("APPROVED");
    expect(version.revision).toBe(2);
  });

  test("a repeated approval is not a no-op", async () => {
    const { w, layout } = await approvedLayout("Twice");
    const res = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: layout.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_NOT_APPROVABLE");
    expect(res.body.error.details).toMatchObject({
      status: "APPROVED", approvedRevision: layout.approval.approvedRevision,
    });
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.revision).toBe(layout.revision);
    expect(stored.history.filter((e) => e.type === "LINE_LAYOUT_APPROVED")).toHaveLength(1);
  });

  test("the body accepts only expectedRevision", async () => {
    const w = await world("Body");
    const layout = await arranged(w);
    for (const extra of [
      { status: "APPROVED" }, { approvedBy: String(new mongoose.Types.ObjectId()) },
      { approvedByName: "Nobody" }, { approvedAt: "2026-09-11" }, { approvedRevision: 1 },
      { revision: 3 }, { history: [] }, { stations: [] }, { sourceRows: [] },
      { sourceFingerprint: "f".repeat(64) }, { ieBulletinVersionId: String(new mongoose.Types.ObjectId()) },
      { bulletinVersionNo: 2 }, { companyId: String(w.co._id) }, { reason: "Looks fine" },
    ]) {
      const res = await approveLayout(w.approver, w, layout.layoutId, {
        expectedRevision: layout.revision, ...extra,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(Object.keys(extra)[0]);
    }
    /* And it is required. */
    const missing = await approveLayout(w.approver, w, layout.layoutId, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fieldErrors[0].field).toBe("expectedRevision");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("a stale revision conflicts and writes nothing", async () => {
    const w = await world("Stale");
    const layout = await arranged(w);
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
    expect(res.body.error.details).toMatchObject({ expected: 1, actual: layout.revision });
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.status).toBe("DRAFT");
    expect(stored.revision).toBe(layout.revision);
    expect("approvedBy" in stored).toBe(false);
  });

  test("two simultaneous approvals produce exactly one winner", async () => {
    const w = await world("Race");
    const layout = await arranged(w);
    const other = await approverIn(w.co);
    const [one, two] = await Promise.all([
      approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision }),
      approveLayout(other, w, layout.layoutId, { expectedRevision: layout.revision }),
    ]);
    const winners = [one, two].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(["IE_LAYOUT_NOT_APPROVABLE", "IE_LINE_LAYOUT_REVISION_CONFLICT"])
      .toContain(loser.body.error.code);

    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.status).toBe("APPROVED");
    expect(stored.revision).toBe(layout.revision + 1);
    expect(stored.history.filter((e) => e.type === "LINE_LAYOUT_APPROVED")).toHaveLength(1);
  });

  test("a viewer and an editor cannot approve; an approver can", async () => {
    const w = await world("Roles");
    const layout = await arranged(w);
    for (const a of [await viewerIn(w.co), await editorIn(w.co)]) {
      const res = await approveLayout(a, w, layout.layoutId, { expectedRevision: layout.revision });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    }
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
    const ok = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(ok.status).toBe(200);
  });

  test("another company's layout is indistinguishable from absent", async () => {
    const mine = await world("IsoMine");
    const layout = await arranged(mine);
    const theirs = await world("IsoTheirs");
    const outsider = await approverIn(theirs.co);

    const foreign = await approveLayout(outsider, theirs, layout.layoutId, { expectedRevision: layout.revision });
    const invented = await approveLayout(outsider, theirs, new mongoose.Types.ObjectId(), { expectedRevision: 1 });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("IE_LINE_LAYOUT_NOT_FOUND");
    expect(foreign.body).toEqual(invented.body);
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });
});

/** The acting person's stable id, as the token carries it. */
async function DeptUserIdOf(a) {
  const jwtLib = require("jsonwebtoken");
  return jwtLib.decode(a.token).id;
}

/* ══ 3. MAKER-CHECKER ═════════════════════════════════════════════════════ */

describe("the approver is not the author", () => {
  test("the person who last worked on the layout cannot approve it", async () => {
    const w = await world("Maker");
    /* An actor who both authors and may approve — so only the identity
       comparison can refuse them, and it does. */
    const both = await actor({ companies: [w.co], grants: { ie: "approver" } });
    const layout = await arranged(w, both);

    const res = await approveLayout(both, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_LAYOUT_MAKER_CHECKER");
    expect(res.body.error.message).toMatch(/somebody other than the person who last worked on it/i);

    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.status).toBe("DRAFT");
    expect(stored.revision).toBe(layout.revision);

    /* Somebody else approves the very same layout without difficulty. */
    const ok = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(ok.status).toBe(200);
  });

  test("the same display name with a different actor id is not the same person", async () => {
    /* Every actor in this fixture is minted with the same display-name shape, so
       two of them genuinely share it. The comparison is of ids, so the second
       may approve the first's work. */
    const w = await world("SameName");
    const author = await actor({ companies: [w.co], grants: { ie: "editor" } });
    const decider = await actor({ companies: [w.co], grants: { ie: "approver" } });
    const jwtLib = require("jsonwebtoken");
    const nameOf = (a) => jwtLib.decode(a.token).name;
    const idOf = (a) => jwtLib.decode(a.token).id;
    expect(nameOf(author).replace(/\d+$/, "")).toBe(nameOf(decider).replace(/\d+$/, ""));
    expect(idOf(author)).not.toBe(idOf(decider));

    const layout = await arranged(w, author);
    /* ── THE DISCRIMINATING CASE ────────────────────────────────────────
       The layout's stored author NAME is made identical to the approver's own,
       while the stored author ID stays the other person's. A comparison by name
       refuses this — wrongly, because they are two people. A comparison by id
       allows it, which is the answer. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $set: { updatedByName: nameOf(decider), createdByName: nameOf(decider) } },
    );
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.updatedByName).toBe(nameOf(decider));
    expect(String(stored.updatedBy)).toBe(idOf(author));

    const res = await approveLayout(decider, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(200);
    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(after.status).toBe("APPROVED");
    expect(String(after.approvedBy)).toBe(idOf(decider));
  });

  test("a layout with no provable author fails closed", async () => {
    const w = await world("NoAuthor");
    const layout = await arranged(w);
    /* Exactly what an unattributable record looks like. Treating that as "not
       the approver" would make every such record one anybody may wave through. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $unset: { updatedBy: "", createdBy: "" } },
    );
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_LAYOUT_MAKER_CHECKER");
    expect(res.body.error.message).toMatch(/nothing stored says who authored/i);
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });
});

/* ══ 4. THE GATES ═════════════════════════════════════════════════════════ */

describe("every reason a layout cannot be approved, all of them at once", () => {
  test("an empty layout names no stations, no metrics and every unplaced row", async () => {
    const w = await world("Empty");
    const opened = await open(w.maker, w);
    const layout = opened.body.layout;

    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_NOT_APPROVABLE");
    const codes = res.body.error.details.gapCodes;
    expect(codes).toContain("IE_LAYOUT_NO_STATIONS");
    expect(codes).toContain("IE_LAYOUT_METRICS_UNAVAILABLE");
    expect(codes).toContain("IE_LAYOUT_ROWS_UNASSIGNED");
    /* All of them together, never the first alone. */
    expect(codes.length).toBeGreaterThanOrEqual(3);
    for (const g of res.body.error.details.gaps) {
      expect(typeof g.code).toBe("string");
      expect(typeof g.message).toBe("string");
      expect(g.owner).toBe("INDUSTRIAL_ENGINEERING");
      expect(typeof g.action).toBe("string");
    }
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("an unplaced row and an empty station each refuse with their own code", async () => {
    const w = await world("Partial");
    const opened = await open(w.maker, w);
    const layout = opened.body.layout;
    const rows = layout.source.rows.map((r) => r.rowId);

    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [station(rows.slice(0, 2)), station([])],
    });
    expect(saved.status).toBe(200);

    const res = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
    });
    expect(res.status).toBe(409);
    const codes = res.body.error.details.gapCodes;
    expect(codes).toContain("IE_LAYOUT_ROWS_UNASSIGNED");
    expect(codes).toContain("IE_LAYOUT_EMPTY_STATION");
    const unassigned = res.body.error.details.gaps.find((g) => g.code === "IE_LAYOUT_ROWS_UNASSIGNED");
    expect(unassigned.rowIds).toEqual(rows.slice(2));
  });

  test("an operation at a station that does not plan its machine types refuses", async () => {
    const w = await world("Incompatible");
    const opened = await open(w.maker, w);
    const layout = opened.body.layout;
    const rows = layout.source.rows.map((r) => r.rowId);

    /* Give row 0 a frozen requirement — on the VERSION and on the layout alike,
       so the two still agree and the only gate left is compatibility itself. */
    const requirement = {
      capturedAt: new Date(), ieOperationRevision: 1, requirementsConfigured: true,
      machineTypes: [{ machineType: "SNLS", quantity: 1 }],
    };
    for (const [Model, id] of [
      [IeBulletinVersion, w.bulletinVersion.bulletinVersionId],
      [IeLineLayout, layout.layoutId],
    ]) {
      const field = Model === IeBulletinVersion ? "rows" : "sourceRows";
      await Model.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(String(id)) },
        { $set: { [`${field}.0.requirementSnapshot`]: requirement } },
      );
    }

    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [station(rows, { plannedMachineTypes: [{ machineType: "Bartack", quantity: 1 }] })],
    });
    expect(saved.status).toBe(200);

    const res = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
    });
    expect(res.status).toBe(409);
    const gap = res.body.error.details.gaps
      .find((g) => g.code === "IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE");
    expect(gap).toBeTruthy();
    expect(gap.missingMachineTypes).toContain("SNLS");
  });

  test("a fingerprint, digest or frozen-row mismatch refuses approval", async () => {
    /* Each is the layout's stored evidence no longer being the version's. None
       of them can happen through a route; each is what a corrupted or
       hand-edited record looks like, and approval must not bless one. */
    for (const [what, patch] of [
      ["fingerprint", { sourceFingerprint: "f".repeat(64) }],
      ["approval digest", { sourceApprovalDigest: "a".repeat(64) }],
      ["requirement digest", { sourceRequirementDigest: "r".repeat(64) }],
    ]) {
      const w = await world(`Mismatch${what.replace(/\W/g, "")}`);
      const layout = await arranged(w);
      await IeLineLayout.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) }, { $set: patch },
      );
      const res = await approveLayout(w.approver, w, layout.layoutId, {
        expectedRevision: layout.revision,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.details.gapCodes).toContain("IE_LAYOUT_SOURCE_CHANGED");
      expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
    }

    /* And the rows themselves, compared field by field rather than by hash —
       because a fingerprint proves the rows were equal when it was computed. */
    const w = await world("MismatchRows");
    const layout = await arranged(w);
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $set: { "sourceRows.0.standardTimeMinutes": 99 } },
    );
    const res = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: layout.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.gapCodes).toContain("IE_LAYOUT_SOURCE_CHANGED");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("a version that is no longer approved refuses with its own code", async () => {
    const w = await world("VersionMoved");
    const layout = await arranged(w);
    await IeBulletinVersion.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.bulletinVersion.bulletinVersionId)) },
      { $set: { state: "SUPERSEDED" } },
    );
    const res = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: layout.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_BULLETIN_NOT_APPROVED");
    expect(res.body.error.details).toMatchObject({
      bulletinVersionNo: 1, bulletinVersionState: "SUPERSEDED",
    });
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("a pre-7C1 layout is readable for ever and never approvable", async () => {
    const w = await world("Legacy");
    const layout = await arranged(w);
    /* Exactly a pre-7C1 record: the fields simply are not there. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $unset: { ieBulletinVersionId: "", bulletinVersionNo: "" } },
    );

    const read = await readLayout(w.maker, w, layout.layoutId);
    expect(read.status).toBe(200);
    expect(read.body.layout.stations).toHaveLength(2);
    expect(read.body.layout.versionBacked).toBe(false);
    expect(read.body.layout.bulletinVersion).toBeNull();
    expect(read.body.layout.canApprove).toBe(false);
    /* It keeps its metrics and its place in the file's list. */
    expect(read.body.layout.metrics.totalWorkContentMinutes).toBe(4.5);
    const list = await listLayouts(w.maker, w);
    expect(list.body.layouts.map((l) => l.layoutId)).toContain(layout.layoutId);

    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_BULLETIN_VERSION_UNPROVEN");
    expect(res.body.error.details.resolution).toBe("OPEN_NEW_DRAFT_LAYOUT");

    /* And no backfill happened on the way past. */
    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect("ieBulletinVersionId" in after).toBe(false);
    expect(after.status).toBe("DRAFT");
    expect(after.revision).toBe(layout.revision);
  });
});

/* ══ 5. AN APPROVED LAYOUT IS PERMANENT EVIDENCE ══════════════════════════ */

describe("an approved layout accepts no write at all", () => {
  test("the PATCH refuses it, before the source and before the revision", async () => {
    const { w, layout } = await approvedLayout("NoPatch");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    for (const expectedRevision of [layout.revision, layout.revision - 1, 99]) {
      const res = await patchLayout(w.maker, w, layout.layoutId, {
        expectedRevision, stations: [station([before.sourceRows[0].rowId])],
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("IE_LAYOUT_IMMUTABLE");
      expect(res.body.error.details).toMatchObject({
        status: "APPROVED", resolution: "OPEN_NEW_DRAFT_LAYOUT",
      });
    }
    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("a template cannot be applied to it", async () => {
    const { w, layout } = await approvedLayout("NoTemplate");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    /* A template captured from the approved layout itself, so nothing about the
       pattern is the reason it is refused. */
    const made = await call("/line-templates", {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { layoutId: layout.layoutId, name: "From the approved plan" },
    });
    expect(made.status).toBe(201);

    const res = await call(`/line-layouts/${layout.layoutId}/from-template`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { templateId: made.body.template.templateId, expectedRevision: layout.revision },
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_IMMUTABLE");
    expect(res.body.error.details.resolution).toBe("OPEN_NEW_DRAFT_LAYOUT");

    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    /* And it applies perfectly well to a fresh draft. */
    const successor = await open(w.maker, w);
    const ok = await call(`/line-layouts/${successor.body.layout.layoutId}/from-template`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { templateId: made.body.template.templateId, expectedRevision: successor.body.layout.revision },
    });
    expect(ok.status).toBe(200);
  });

  test("every protected field is refused through every write method", async () => {
    const { layout } = await approvedLayout("NoWrites");
    const id = layout.layoutId;
    const before = await IeLineLayout.findById(id).lean();

    /* ── save() ── */
    for (const mutate of [
      (d) => { d.stations = []; },
      (d) => { d.sourceRows[0].standardTimeMinutes = 99; },
      (d) => { d.status = "DRAFT"; },
      (d) => { d.approvedByName = "Somebody else"; },
      (d) => { d.revision += 1; },
    ]) {
      const doc = await IeLineLayout.findById(id);
      mutate(doc);
      await expect(doc.save()).rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
    }

    /* ── the query layer, including the metadata-only writes that are how
           immutability actually gets bypassed ── */
    for (const update of [
      { $set: { stations: [] } },
      { $set: { sourceRows: [] } },
      { $set: { sourceFingerprint: "f".repeat(64) } },
      { $set: { ieBulletinVersionId: new mongoose.Types.ObjectId() } },
      { $set: { bulletinRevision: 99 } },
      { $set: { status: "DRAFT" } },
      { $set: { approvedBy: new mongoose.Types.ObjectId() } },
      { $set: { approvedByName: "Somebody else" } },
      { $set: { approvedAt: new Date() } },
      { $set: { approvedRevision: 99 } },
      { $inc: { revision: 1 } },
      { $push: { history: { eventId: "forged", type: "LINE_LAYOUT_APPROVED", at: new Date(), layoutRevision: 9 } } },
    ]) {
      await expect(IeLineLayout.updateOne({ _id: id }, update))
        .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
      await expect(IeLineLayout.findOneAndUpdate({ _id: id }, update))
        .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
      await expect(IeLineLayout.updateMany({ _id: id }, update))
        .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
      /* Naming the status it is NOT does not help either. */
      await expect(IeLineLayout.updateOne({ _id: id, status: "APPROVED" }, update))
        .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
    }

    /* ── replacement ── */
    await expect(IeLineLayout.replaceOne({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
    await expect(IeLineLayout.findOneAndReplace({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });

    const after = await IeLineLayout.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("editing the Style File successor draft restates nothing", async () => {
    const { w, layout } = await approvedLayout("Successor");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    const file = await IeStyleFile.findById(w.fileId).lean();
    const edited = await call(`/engineering-files/${w.fileId}/bulletin`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: {
        expectedRevision: file.revision,
        rows: file.bulletin.rows.slice(0, 2).map((r) => ({
          rowId: r.rowId, ieOperationId: String(r.ieOperationId), proposedSamMinutes: 8, note: "Next time",
        })),
      },
    });
    expect(edited.status).toBe(200);

    const read = await readLayout(w.maker, w, layout.layoutId);
    expect(read.status).toBe(200);
    expect(read.body.layout.status).toBe("APPROVED");
    expect(read.body.layout.source.state).toBe("CURRENT");
    expect(read.body.layout.source.rows).toHaveLength(4);
    expect(read.body.layout.metrics.totalWorkContentMinutes).toBe(4.5);
    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("approving a later bulletin version rewrites nothing, and says what changed", async () => {
    const { w, layout } = await approvedLayout("LaterVersion");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    await approveAgain(w, 0, { minutes: 6.5 });
    const next = await approveBulletinVersion({
      co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
    });
    expect(next.version.versionNo).toBe(2);

    /* Not one stored byte moved — the plan somebody accepted is still what they
       accepted, against the version they accepted it for. */
    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    /* What changed is the ANSWER to "is this still a balance of the current
       approved bulletin", and it is reported rather than inferred. */
    const read = await readLayout(w.maker, w, layout.layoutId);
    expect(read.body.layout.status).toBe("APPROVED");
    expect(read.body.layout.source.state).toBe("SOURCE_CHANGED");
    expect(read.body.layout.source.changeReasons).toContain("BULLETIN_VERSION_SUPERSEDED");
    expect(read.body.layout.bulletinVersion.versionNo).toBe(1);
    expect(read.body.layout.bulletinVersion.state).toBe("SUPERSEDED");
    expect(read.body.layout.approval.approvedRevision).toBe(before.approvedRevision);

    /* And a layout for version 2 opens beside it. */
    const fresh = await open(w.maker, w);
    expect(fresh.status).toBe(201);
    expect(fresh.body.layout.bulletinVersion.versionNo).toBe(2);
    expect(fresh.body.layout.source.rows[0].standardTimeMinutes).toBe(6.5);
  });

  test("the list publishes each layout's own version, status and approval", async () => {
    const { w, layout } = await approvedLayout("List");
    const successor = await open(w.maker, w);
    expect(successor.status).toBe(201);

    const list = await listLayouts(w.maker, w);
    expect(list.status).toBe(200);
    expect(list.body.currentApprovedBulletinVersionId).toBe(w.bulletinVersion.bulletinVersionId);
    expect(list.body.currentApprovedVersionNo).toBe(1);

    const byId = new Map(list.body.layouts.map((l) => [l.layoutId, l]));
    expect(byId.get(layout.layoutId).status).toBe("APPROVED");
    expect(byId.get(layout.layoutId).approval.approvedRevision).toBe(layout.approval.approvedRevision);
    expect(byId.get(layout.layoutId).canApprove).toBe(false);
    expect(byId.get(successor.body.layout.layoutId).status).toBe("DRAFT");
    expect(byId.get(successor.body.layout.layoutId).approval).toBeNull();
    expect(byId.get(successor.body.layout.layoutId).canApprove).toBe(true);
    for (const l of list.body.layouts) {
      expect(l.versionBacked).toBe(true);
      expect(l.bulletinVersion.versionNo).toBe(1);
    }
  });
});

/* ══ 6. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("nothing downstream of a plan exists here", () => {
  test("no IE service imports or writes Production, PPC, a work order or a scan", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../services/industrialEngineering");
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      expect(src).not.toMatch(/models\/CMS_Models\/PPC/);
      expect(src).not.toMatch(/DownstreamHandoverReceipt/);
      expect(src).not.toMatch(/services\/ppc\//);
      /* No Production or tracking model is IMPORTED — mentioning one in a
         comment that explains a boundary is the opposite of crossing it. */
      expect(src).not.toMatch(/require\([^)]*ProductionTracking/);
      expect(src).not.toMatch(/require\([^)]*ProductionSchedule/);
      expect(src).not.toMatch(/require\([^)]*Barcode/);
      /* The work-order MODEL is read by the accepted order boundary; what must
         not exist is a WRITE to one, or to any scan record. */
      for (const model of ["WorkOrder", "ProductionTracking", "ProductionSchedule"]) {
        expect(src).not.toMatch(
          new RegExp(`${model}\\.(updateOne|updateMany|findOneAndUpdate|findOneAndReplace|replaceOne|create|deleteOne)\\(`),
        );
      }
      expect(src).not.toMatch(/barcodeScans["']?\s*:/);
    }
  });

  test("the router gained exactly one layout verb, and nothing downstream", () => {
    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route).map((l) => l.route.path);
    expect(paths.filter((p) => /line-layouts/.test(p) && /approve/i.test(p)))
      .toEqual(["/line-layouts/:layoutId/approve"]);
    /* Two release routes exist on this router and no more: CHUNK 8A-i's
       `POST /style-files/:fileId/releases`, which issues one, and 8A-iii's
       `GET /releases/:releaseId/impact`, which only READS what has moved
       since. Both are excluded by name rather than by weakening the pattern,
       so anything else matching would still be caught. Everything DOWNSTREAM
       of a release — acknowledging it, a PPC receipt, withdrawal, an outbox —
       is still absent, and PPC's receipt is on PPC's own router. */
    expect(paths.filter((p) => /release|acknowledge|handover|receipt|book|allocate|dispatch/i.test(p)))
      .toEqual(["/style-files/:fileId/releases", "/releases/:releaseId/impact"]);
    expect(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods)))
      .not.toContain("delete");
  });

  test("an approved layout's payload carries no Production or people concept", async () => {
    const { layout } = await approvedLayout("CleanPayload");
    const wire = JSON.stringify(layout);
    for (const forbidden of [
      "machineId", "serialNumber", "assetId", "availability", "maintenanceStatus",
      "employeeId", "operatorId", "operatorIdentityId", "attendance", "shiftName",
      "barcodeId", "scanId", "barcodeScans", "workOrderId", "productionScheduleId",
      "releasedAt", "acknowledgedAt", "bookedQuantity", "deliveryDate",
    ]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });
});

/* ══ 7. THE VERSION'S ROWS, NOT TODAY'S ═══════════════════════════════════ */

describe("opening re-resolves nothing", () => {
  test("a layout opened after the draft has moved still carries the version's evidence", async () => {
    /* The discriminating case. Right after approval the successor draft and the
       approved version agree, so re-deriving the rows would look correct. Here
       the draft is moved FIRST — a row re-timed and approved again — and only
       then is the layout opened. Anything that re-resolved the current method
       studies would pick up 5.5 minutes; the version says 1, and the version is
       what the line is a balance of. */
    const w = await world("NoReresolve");
    const version = w.bulletinVersion;
    const firstRow = version.rows[0];
    expect(firstRow.standardTimeMinutes).toBe(1);

    const later = await approveAgain(w, 0, { minutes: 5.5 });
    expect(later.minutes).toBe(5.5);

    const opened = await open(w.maker, w);
    expect(opened.status).toBe(201);
    const row = opened.body.layout.source.rows.find((r) => r.rowId === firstRow.rowId);

    /* The version's figure and the version's study — not today's. */
    expect(row.standardTimeMinutes).toBe(1);
    expect(row.methodStudyId).toBe(firstRow.methodStudyId);
    expect(row.approvedSubmissionId).toBe(firstRow.approvedSubmissionId);
    expect(row.methodStudyId).not.toBe(later.studyId);

    /* And the whole frozen set agrees with the version, digest for digest. */
    expect(opened.body.layout.source.fingerprint).toBe(version.source.fingerprint);
    expect(opened.body.layout.source.approvalDigest).toBe(version.source.approvalDigest);
    expect(opened.body.layout.metrics.available).toBe(false);
    const stored = await IeLineLayout.findById(opened.body.layout.layoutId).lean();
    expect(stored.sourceRows.map((r) => r.standardTimeMinutes)).toEqual(
      version.rows.map((r) => r.standardTimeMinutes),
    );
    /* So it is approvable on its own terms, once arranged. */
    const layout = await arranged(w);
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(200);
  });
});

/* ══ 8. THE THREE CORRECTIONS ═════════════════════════════════════════════ */

describe("an approved layout accepts no write, of any field, by any query", () => {
  test("identity, authorship, timestamps and arbitrary metadata are all refused", async () => {
    const { layout } = await approvedLayout("NoFieldAtAll");
    const id = layout.layoutId;
    const before = await IeLineLayout.findById(id).lean();
    const other = await world("SomewhereElse");

    /* None of these is on any protected list, and every one of them is a
       rewrite of an approved plan. Moving it into another company is not a
       lesser kind of rewrite than moving its stations. */
    const updates = [
      { $set: { companyId: other.co._id } },
      { $set: { ieStyleFileId: new mongoose.Types.ObjectId(String(other.fileId)) } },
      { $set: { sampleStyleId: other.style._id } },
      { $set: { createdBy: new mongoose.Types.ObjectId() } },
      { $set: { createdByName: "Somebody else entirely" } },
      { $set: { updatedBy: new mongoose.Types.ObjectId() } },
      { $set: { updatedByName: "Somebody else entirely" } },
      { $set: { createdAt: new Date("2000-01-01") } },
      { $set: { updatedAt: new Date("2000-01-01") } },
      /* A field nobody has thought of yet behaves the same way. */
      { $set: { somethingAddedLater: true } },
      { $unset: { createdByName: "" } },
      { $rename: { createdByName: "authorName" } },
    ];
    for (const update of updates) {
      for (const write of [
        () => IeLineLayout.updateOne({ _id: id }, update),
        () => IeLineLayout.updateMany({ _id: id }, update),
        () => IeLineLayout.findOneAndUpdate({ _id: id }, update),
        /* Naming the status it actually has does not help. */
        () => IeLineLayout.updateOne({ _id: id, status: "APPROVED" }, update),
        /* Nor does a filter that would be safe for one status and not another. */
        () => IeLineLayout.updateOne({ _id: id, status: { $in: ["DRAFT", "APPROVED"] } }, update),
        () => IeLineLayout.updateOne({ _id: id, status: { $ne: "APPROVED" } }, update),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
      }
    }

    /* Replacement stays refused outright, and so does an upsert. */
    await expect(IeLineLayout.replaceOne({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
    await expect(IeLineLayout.findOneAndReplace({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });
    await expect(IeLineLayout.updateOne({ _id: new mongoose.Types.ObjectId(), status: "DRAFT" },
      { $set: { createdByName: "x" } }, { upsert: true }))
      .rejects.toMatchObject({ code: "IE_LAYOUT_IMMUTABLE" });

    /* Byte-identical afterwards. */
    const after = await IeLineLayout.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("a DRAFT layout still edits, and the real approval still works", async () => {
    /* The guard is satisfied by naming `status: "DRAFT"`, which is exactly what
       every service mutation already carries — so nothing legitimate changed. */
    const w = await world("StillWorks");
    const opened = await open(w.maker, w);
    const layout = opened.body.layout;
    const rows = layout.source.rows.map((r) => r.rowId);

    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [station(rows, { plannedMachineTypes: [{ machineType: "SNLS", quantity: 4 }] })],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.layout.revision).toBe(layout.revision + 1);

    const approved = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.layout.status).toBe("APPROVED");

    /* And a direct write naming DRAFT is allowed — it simply matches nothing
       now, which is the guard doing its job through the filter rather than
       through a list of fields. */
    const missed = await IeLineLayout.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)), status: "DRAFT" },
      { $set: { updatedByName: "Nobody" } },
    );
    expect(missed.matchedCount).toBe(0);
    expect((await IeLineLayout.findById(layout.layoutId).lean()).updatedByName)
      .not.toBe("Nobody");
  });
});

describe("approval requires provable compatibility, not merely the absence of a clash", () => {
  /** A layout whose rows are placed, with the station plan the test wants. */
  async function placed(name, plannedMachineTypes, worldOpts) {
    const w = await world(name, worldOpts);
    const opened = await open(w.maker, w);
    const layout = opened.body.layout;
    const rows = layout.source.rows.map((r) => r.rowId);
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [station(rows, { label: "One line", plannedMachineTypes })],
    });
    expect(saved.status).toBe(200);
    return { w, layout: saved.body.layout };
  }

  /** Rewrite the frozen requirement on BOTH the version and the layout, so the
   *  two still agree and compatibility is the only thing under test. */
  async function refreeze(w, layout, snapshot) {
    for (const [Model, id, field] of [
      [IeBulletinVersion, w.bulletinVersion.bulletinVersionId, "rows"],
      [IeLineLayout, layout.layoutId, "sourceRows"],
    ]) {
      const doc = await Model.findById(id).lean();
      const rows = (doc[field] || []).map((r) => ({ ...r, requirementSnapshot: snapshot }));
      await Model.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { [field]: rows } },
      );
    }
  }

  test("unprovable requirement evidence refuses approval", async () => {
    /* A row authored before the Chunk 6B freeze existed: nothing says what its
       operation required, so nothing can say whether the station suits it. */
    const { w, layout } = await placed("NotProvable", [{ machineType: "SNLS", quantity: 4 }]);
    await refreeze(w, layout, null);

    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_NOT_APPROVABLE");
    const gap = res.body.error.details.gaps.find((g) => g.code === "IE_LAYOUT_REQUIREMENTS_NOT_PROVABLE");
    expect(gap).toBeTruthy();
    expect(gap.rowIds).toHaveLength(4);
    expect(gap.owner).toBe("INDUSTRIAL_ENGINEERING");
    expect(gap.action).toBe("REAUTHOR_ROW_TO_FREEZE_REQUIREMENTS");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("unconfigured requirements refuse approval", async () => {
    /* The evidence is frozen and says nobody had decided what the operation
       needs. That is not "needs nothing" — it is not known. */
    const { w, layout } = await placed("NotConfigured", [{ machineType: "SNLS", quantity: 4 }],
      { requirements: false });
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    const gap = res.body.error.details.gaps.find((g) => g.code === "IE_LAYOUT_REQUIREMENTS_NOT_CONFIGURED");
    expect(gap).toBeTruthy();
    expect(gap.action).toBe("CONFIGURE_OPERATION_REQUIREMENTS");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("a station planning no machine types refuses approval", async () => {
    const { w, layout } = await placed("NoStationPlan", []);
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    const gap = res.body.error.details.gaps.find((g) => g.code === "IE_LAYOUT_STATION_MACHINE_TYPE_MISSING");
    expect(gap).toBeTruthy();
    expect(gap.action).toBe("PLAN_STATION_MACHINE_TYPES");
    expect(gap.stationIds).toHaveLength(1);
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("an outright clash refuses approval", async () => {
    const { w, layout } = await placed("Clash", [{ machineType: "Bartack", quantity: 4 }]);
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    const gap = res.body.error.details.gaps
      .find((g) => g.code === "IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE");
    expect(gap).toBeTruthy();
    expect(gap.missingMachineTypes).toContain("SNLS");
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("several causes at once are all returned together", async () => {
    const { w, layout } = await placed("ManyCauses", [{ machineType: "SNLS", quantity: 4 }]);
    /* Row 0 unprovable, row 1 unconfigured, rows 2 and 3 fine. */
    const version = await IeBulletinVersion.findById(w.bulletinVersion.bulletinVersionId).lean();
    const rows = version.rows.map((r, i) => {
      if (i === 0) return { ...r, requirementSnapshot: null };
      if (i === 1) {
        return {
          ...r,
          requirementSnapshot: { ...r.requirementSnapshot, requirementsConfigured: false, machineTypes: [] },
        };
      }
      return r;
    });
    for (const [Model, id, field] of [
      [IeBulletinVersion, w.bulletinVersion.bulletinVersionId, "rows"],
      [IeLineLayout, layout.layoutId, "sourceRows"],
    ]) {
      await Model.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(String(id)) }, { $set: { [field]: rows } },
      );
    }

    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    const codes = res.body.error.details.gapCodes;
    expect(codes).toContain("IE_LAYOUT_REQUIREMENTS_NOT_PROVABLE");
    expect(codes).toContain("IE_LAYOUT_REQUIREMENTS_NOT_CONFIGURED");
    /* Never the first alone. */
    expect(codes.length).toBeGreaterThanOrEqual(2);
    expect((await IeLineLayout.findById(layout.layoutId).lean()).status).toBe("DRAFT");
  });

  test("a fully provable, fully compatible layout approves", async () => {
    const { w, layout } = await placed("AllProvable", [{ machineType: "SNLS", quantity: 4 }]);
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(200);
    expect(res.body.layout.status).toBe("APPROVED");
    expect(res.body.layout.machineTypeCompatibility.state).toBe("COMPATIBLE");
  });
});

describe("the frozen evidence is compared field by field", () => {
  /** Tamper with one field of the layout's frozen row 0 and try to approve. */
  async function tamper(name, patch) {
    const w = await world(name);
    const layout = await arranged(w);
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) }, { $set: patch },
    );
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_LAYOUT_NOT_APPROVABLE");
    expect(res.body.error.details.gapCodes).toContain("IE_LAYOUT_SOURCE_CHANGED");

    /* Nothing moved: not the revision, the history, the timestamp, the status
       or any approval field. */
    const after = await IeLineLayout.findById(layout.layoutId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.status).toBe("DRAFT");
    for (const f of ["approvedBy", "approvedByName", "approvedAt", "approvedRevision"]) {
      expect(f in after).toBe(false);
    }
  }

  test("a changed operation code refuses approval", async () => {
    /* A station card reading "OP-4 Buttonhole" is not evidence of a plan
       approved against "OP-4 Bartack", however identical the minutes. */
    await tamper("CodeTamper", { "sourceRows.0.operationCode": "OP-FORGED" });
  });

  test("a changed operation name refuses approval", async () => {
    await tamper("NameTamper", { "sourceRows.0.operationName": "Something else" });
  });

  test("a changed requirement capture time refuses approval", async () => {
    /* It says WHICH freeze of the operation's requirements this row carries. */
    await tamper("CapturedAtTamper",
      { "sourceRows.0.requirementSnapshot.capturedAt": new Date("2020-01-01") });
  });

  test("a changed requirement operation revision refuses approval", async () => {
    await tamper("ReqRevisionTamper",
      { "sourceRows.0.requirementSnapshot.ieOperationRevision": 99 });
  });

  test("the remaining evidence fields are compared too", async () => {
    for (const [name, patch] of [
      ["Sequence", { "sourceRows.0.sequence": 4 }],
      ["OperationId", { "sourceRows.0.ieOperationId": new mongoose.Types.ObjectId() }],
      ["OperationRevision", { "sourceRows.0.ieOperationRevision": 9 }],
      ["Minutes", { "sourceRows.0.standardTimeMinutes": 9.5 }],
      ["TimeSource", { "sourceRows.0.standardTimeSource": "GUESSED" }],
      ["StudyId", { "sourceRows.0.methodStudyId": new mongoose.Types.ObjectId() }],
      ["SubmissionId", { "sourceRows.0.approvedSubmissionId": "sub_forged" }],
      ["ApprovedAt", { "sourceRows.0.approvedAt": new Date("2020-01-01") }],
      ["Configured", { "sourceRows.0.requirementSnapshot.requirementsConfigured": false }],
      ["MachineTypes", { "sourceRows.0.requirementSnapshot.machineTypes": [{ machineType: "Bartack", quantity: 7 }] }],
      ["SnapshotGone", { "sourceRows.0.requirementSnapshot": null }],
      ["RowId", { "sourceRows.0.rowId": "row_forged" }],
    ]) {
      await tamper(`Field${name}`, patch);
    }
  });

  test("a reordered row set is a different plan", async () => {
    const w = await world("Reordered");
    const layout = await arranged(w);
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    const swapped = [stored.sourceRows[1], stored.sourceRows[0], ...stored.sourceRows.slice(2)];
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) }, { $set: { sourceRows: swapped } },
    );
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(409);
    expect(res.body.error.details.gapCodes).toContain("IE_LAYOUT_SOURCE_CHANGED");
  });

  test("an untampered layout compares equal and approves", async () => {
    /* The other half of the claim: the comparison is not simply always false.
       Ids stored as ObjectIds and dates stored as Dates compare equal to the
       version's own, which is what the normalisation is for. */
    const w = await world("Untampered");
    const layout = await arranged(w);
    const version = await IeBulletinVersion.findById(w.bulletinVersion.bulletinVersionId).lean();
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(IeLineLayoutService.sameFrozenRows(stored.sourceRows, version.rows)).toBe(true);

    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(200);
  });

  test("the fields a layout deliberately does not copy are not compared", async () => {
    /* A version row also carries IE's proposal and its notes. A layout does not
       store them, and comparing them would refuse every layout ever opened. */
    const w = await world("NotCopied");
    const layout = await arranged(w);
    await IeBulletinVersion.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(w.bulletinVersion.bulletinVersionId)) },
      { $set: { "rows.0.proposedSamMinutes": 42, "rows.0.note": "Only the bulletin's business" } },
    );
    const res = await approveLayout(w.approver, w, layout.layoutId, { expectedRevision: layout.revision });
    expect(res.status).toBe(200);
  });
});

const IeLineLayoutService = require("../../services/industrialEngineering/ieLineLayout.service");
