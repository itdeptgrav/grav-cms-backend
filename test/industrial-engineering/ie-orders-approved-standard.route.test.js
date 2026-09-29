// test/industrial-engineering/ie-orders-approved-standard.route.test.js
//
// IE ORDERS READS THE APPROVED OPERATION BULLETIN AS THE IE STANDARD.
//
// Live testing found a style with an approved seven-operation, 6.25-minute
// bulletin — already part of an issued release — reading "0 operations",
// "SAM not recorded" and NO_ROUTE_RECORDED on IE Orders, because IE Orders only
// ever looked at the two LEGACY route sources and R&D's route was empty.
//
// The claims worth holding:
//
//   · the approved standard is found through the style file's own pointer and
//     nothing else, with company, style, file, version id, version number and
//     APPROVED state all proved;
//   · it wins IE readiness and the headline figures, while the legacy route
//     sources stay visible and untouched as source context;
//   · a draft, an in-review, returned or superseded version, an approved version
//     nobody points at, another company's evidence and another file's version
//     are all refused — each with the reason it failed;
//   · a multi-style order is summed only when EVERY style is approved;
//   · the whole page costs two extra queries, not two per style;
//   · and neither read writes anything.
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

const {
  STANDARD_STATE, standardSummaryOf,
} = require("../../services/industrialEngineering/approvedStandard.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  await IeStyleFile.syncIndexes();
  await IeBulletinVersion.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (p, { method = "GET", body, token, company, headers = {} } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      ...headers,
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
  const email = `ias${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "A", lastName: `A${n}`, email, biometricId: `IAS${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
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
      { id: String(emp._id), email, name: `Person ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * THE DEMO'S SEVEN OPERATIONS, EXACTLY.
 *
 * Copied from `scripts/ie/ieDemoLifecycle.js` — the order that exposed this
 * defect — rather than required from it, so this suite does not depend on a
 * seeder another lane owns. 0.72 + 1.15 + 1.40 + 1.05 + 0.88 + 0.45 + 0.60 =
 * 6.25 minutes of garment SAM.
 */
const DEMO_OPERATIONS = Object.freeze([
  { code: "SJ-01", name: "Join shoulder", machineType: "SNLS", minutes: 0.72 },
  { code: "OL-02", name: "Attach sleeve", machineType: "OL4", minutes: 1.15 },
  { code: "OL-03", name: "Close side seam", machineType: "OL4", minutes: 1.40 },
  { code: "CS-04", name: "Attach neck rib", machineType: "CSTITCH", minutes: 1.05 },
  { code: "HM-05", name: "Hem bottom", machineType: "CSTITCH", minutes: 0.88 },
  { code: "SJ-06", name: "Attach label", machineType: "SNLS", minutes: 0.45 },
  { code: "HF-07", name: "Hand finish and trim", machineType: "MANUAL", minutes: 0.60 },
]);

async function company(name) {
  const n = ++seq;
  return Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
}

/**
 * A company, its people, and ONE style on ONE work order — shaped as the demo
 * shapes it: R&D's technical route is EMPTY. That emptiness is what made IE
 * Orders read "0 operations" over a style whose IE standard was approved.
 */
async function world(name, { co: givenCo = null, styleStatus = null } = {}) {
  const co = givenCo || await company(name);
  const n = ++seq;
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
    name: `Tee ${name} ${n}`, sku: `SKU-${name}-${n}`, reference: `REF-${name}-${n}`,
    category: "Garment", createdBy: new mongoose.Types.ObjectId(),
    quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${n}`, cost: 0, salesPrice: 0 }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: `Tee ${name}`, styleCode: `ST-${name}-${n}`,
    variantLabel: "Navy", journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
    materials: { status: "pending", rawItems: [] },
    ...(styleStatus ? { status: styleStatus } : {}),
    techSheet: {
      technical: { status: "approved", revision: 3 },
      technicalRevisions: [{
        revision: 3, submittedAt: new Date("2026-08-01"), outcome: "approved",
        decidedAt: new Date("2026-08-05"),
        snapshot: { revision: 3, materials: [], requirements: [], operations: [] },
      }],
    },
    production: { workOrderIds: [] },
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${n}`, stockItemId: item._id, stockItemName: item.name,
    stockItemReference: item.reference, quantity: 500, originalQuantity: 500, status: "planned",
    sampleStyleId: style._id,
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
  });

  /* People and an allowance policy are made ONCE per company, whether the
     company was created here or handed in — a method study cannot be submitted
     without an effective policy, and a second company's worth of actors would
     only obscure which person did what. */
  const maker = co._maker || await actor({ companies: [co], grants: { ie: "editor" } });
  const approver = co._approver || await actor({ companies: [co], grants: { ie: "approver" } });
  const viewer = co._viewer || await actor({ companies: [co], grants: { ie: "viewer" } });
  if (!co._policyPublished) {
    const t = { token: maker.token, company: co._id };
    const drafted = await call("/allowance-policies", {
      method: "POST", ...t,
      body: { name: `No allowance ${n}`, effectiveFrom: "2026-01-01", categories: [] },
    });
    await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
      method: "POST", token: approver.token, company: co._id, body: { expectedRevision: 1 },
    });
    co._maker = maker; co._approver = approver; co._viewer = viewer;
    co._policyPublished = true;
  }
  return { co, maker, approver, viewer, journey, style, wo, item };
}

/** Open the style's engineering file through the real IE verb. */
async function openFile(w) {
  const res = await call(`/orders/${w.wo._id}/styles/${w.style._id}/engineering-file`, {
    method: "POST", token: w.maker.token, company: w.co._id, body: {},
  });
  expect(res.status).toBe(201);
  return res.body.file;
}

/**
 * Author a bulletin, time every row through an approved method study, and
 * SUBMIT it as a version — optionally approving it. Every step is a real IE
 * verb, so the approved version under test is genuine evidence.
 */
async function bulletin(w, ops, { approve = true, fileId = null } = {}) {
  const t = { token: w.maker.token, company: w.co._id };
  const id = fileId || (await openFile(w)).fileId;
  const n = ++seq;

  const operations = [];
  for (const op of ops) {
    const made = (await call("/operations/library", {
      method: "POST", ...t,
      body: { code: `${op.code}-${n}`, name: op.name, machineType: op.machineType },
    })).body.operation;
    const configured = await call(`/operations/library/${made.operationId}/requirements`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: made.revision,
        machineRequirements: [{ machineType: op.machineType, quantity: 1 }],
        attachmentRequirements: [], labourRequirements: [],
      },
    });
    expect(configured.status).toBe(200);
    operations.push(configured.body.operation);
  }

  const file = await IeStyleFile.findById(id).lean();
  const written = await call(`/engineering-files/${id}/bulletin`, {
    method: "PATCH", ...t,
    body: {
      expectedRevision: file.revision,
      rows: operations.map((o) => ({ ieOperationId: o.operationId, proposedSamMinutes: 1 })),
    },
  });
  expect(written.status).toBe(200);
  const rows = written.body.file.bulletin.rows;

  for (let i = 0; i < rows.length; i += 1) {
    const opened = await call(`/engineering-files/${id}/bulletin/${rows[i].rowId}/method-studies`, {
      method: "POST", ...t, body: {},
    });
    const studyId = opened.body.study.studyId;
    const filled = await call(`/method-studies/${studyId}`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 4",
        methodNote: "Standard method", ratingPercent: 100, observations: [{ durationSeconds: 60 }],
      },
    });
    const submitted = await call(`/method-studies/${studyId}/submit`, {
      method: "POST", ...t,
      body: {
        expectedRevision: filled.body.study.revision,
        manualStandardTimeMinutes: ops[i].minutes,
        overrideReason: "Standard agreed for this exercise.",
      },
    });
    expect(submitted.status).toBe(200);
    expect((await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: submitted.body.study.revision },
    })).status).toBe(200);
  }

  const now = await IeStyleFile.findById(id).lean();
  const submitted = await call(`/engineering-files/${id}/bulletin-versions`, {
    method: "POST", ...t, body: { expectedRevision: now.revision },
  });
  expect(submitted.status).toBe(201);
  const version = submitted.body.version;
  if (!approve) return { fileId: id, version };

  const approved = await call(`/bulletin-versions/${version.bulletinVersionId}/approve`, {
    method: "POST", token: w.approver.token, company: w.co._id,
    body: { expectedRevision: version.revision },
  });
  expect(approved.status).toBe(200);
  return { fileId: id, version: approved.body.version };
}

const list = (w) => call("/orders?limit=100", { token: w.viewer.token, company: w.co._id });
const detail = (w, orderId = w.wo._id) => call(`/orders/${orderId}`, {
  token: w.viewer.token, company: w.co._id,
});
const rowOf = (res, w) => res.body.rows.find((r) => r.orderId === String(w.wo._id));

/* Raw collection handles, for the states no IE verb can reach. */
const files = () => mongoose.connection.collection("ie_style_files");
const versions = () => mongoose.connection.collection("ie_bulletin_versions");

/* ══ 1. THE DEMO ORDER ════════════════════════════════════════════════════ */

describe("the seeded-equivalent order", () => {
  test("seven approved operations and 6.25 minutes — not 0, not 'not recorded', not NO_ROUTE", async () => {
    const w = await world("Demo");
    const { fileId, version } = await bulletin(w, DEMO_OPERATIONS);

    /* ── THE DETAIL ──────────────────────────────────────────────────── */
    const d = await detail(w);
    expect(d.status).toBe(200);
    const s = d.body.styles[0];

    expect(s.operationCount).toBe(7);
    expect(s.samMinutes).toBe(6.25);
    expect(s.samComplete).toBe(true);
    expect(s.standardSource).toBe("APPROVED_BULLETIN_VERSION");
    expect(s.ieReadiness).toBe("READY");
    expect(s.gaps.map((g) => g.code)).not.toContain("NO_ROUTE_RECORDED");

    expect(s.engineeringStandard).toMatchObject({
      state: "APPROVED_CURRENT",
      available: true,
      styleFileId: String(fileId),
      bulletinVersionId: version.bulletinVersionId,
      versionNo: 1,
      approvalState: "APPROVED",
      pointer: {
        currentApprovedBulletinVersionId: version.bulletinVersionId,
        currentApprovedVersionNo: 1,
        matches: true,
      },
      operationCount: 7,
      garmentSamMinutes: 6.25,
      samRowCount: 7,
      gaps: [],
    });
    expect(s.engineeringStandard.digests.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(s.engineeringStandard.digests.approvalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s.engineeringStandard.approvedAt).toMatch(/^\d{4}-/);
    /* Why NO_ROUTE_RECORDED is gone, stated rather than left to be wondered at. */
    expect(s.engineeringStandard.satisfiesLegacyGaps).toContain("NO_ROUTE_RECORDED");
    expect(s.engineeringFile).toEqual({
      styleFileId: String(fileId),
      href: `/api/cms/ie/orders/${w.wo._id}/styles/${w.style._id}/engineering-file`,
    });

    /* ── THE LEGACY SOURCES ARE STILL THERE, UNTOUCHED ─────────────────── */
    expect(s.routeSources.technical.operationCount).toBe(0);
    expect(s.routeSources.technical.totalSamMinutes).toBeNull();
    expect(s.comparisonState).toBe("NO_ROUTE");

    /* ── THE ORDER ROLL-UP ───────────────────────────────────────────── */
    expect(d.body.order.ieReadiness).toBe("READY");
    expect(d.body.order.routeSummary.totalSamMinutes).toBe(6.25);
    expect(d.body.order.routeSummary.samComplete).toBe(true);
    expect(d.body.order.routeSummary.standardSource).toBe("APPROVED_BULLETIN_VERSION");
    expect(d.body.order.routeSummary.legacyTechnical.totalSamMinutes).toBeNull();
    expect(d.body.order.engineeringStandardSummary).toEqual({
      styles: 1,
      stylesWithApprovedStandard: 1,
      stylesWithoutApprovedStandard: 0,
      rule: "SUM_OF_ONE_GARMENT_OF_EACH_STYLE_ONLY_WHEN_EVERY_STYLE_IS_APPROVED",
      complete: true,
      operationCount: 7,
      garmentSamMinutes: 6.25,
      unavailableReason: null,
    });

    /* ── THE LIST SAYS THE SAME ──────────────────────────────────────── */
    const l = await list(w);
    const row = rowOf(l, w);
    expect(row.ieReadiness).toBe("READY");
    expect(row.stylesReady).toBe(1);
    expect(row.stylesWithGaps).toBe(0);
    expect(row.routeSummary.totalSamMinutes).toBe(6.25);
    expect(row.engineeringStandardSummary.operationCount).toBe(7);
    expect(row.engineeringStandardSummary.garmentSamMinutes).toBe(6.25);
  });
});

/* ══ 2. EVERYTHING THAT IS NOT THE APPROVED STANDARD ═════════════════════ */

describe("what is never treated as the approved standard", () => {
  test("no engineering file, and a file with nothing approved", async () => {
    const w = await world("NoFile");
    let s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("NO_ENGINEERING_FILE");
    expect(s.engineeringStandard.available).toBe(false);
    expect(s.engineeringStandard.operationCount).toBeNull();
    expect(s.engineeringStandard.garmentSamMinutes).toBeNull();
    /* The legacy precedence is untouched when there is no approved standard. */
    expect(s.ieReadiness).toBe("NOT_STARTED");
    expect(s.gaps.map((g) => g.code)).toContain("NO_ROUTE_RECORDED");
    expect(s.standardSource).toBe("NONE");

    /* An opened file whose working draft has seven rows is STILL not approved. */
    await openFile(w);
    s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("NO_APPROVED_VERSION");
    expect(s.engineeringStandard.styleFileId).toBeTruthy();
    expect(s.engineeringStandard.gaps[0].code).toBe("IE_STANDARD_NO_APPROVED_VERSION");
    expect(s.operationCount).toBe(0);
  });

  test("an in-review or returned version is not the standard", async () => {
    const w = await world("InReview");
    const { fileId, version } = await bulletin(w, DEMO_OPERATIONS.slice(0, 3), { approve: false });

    let s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("NO_APPROVED_VERSION");
    expect(s.ieReadiness).not.toBe("READY");
    expect(s.operationCount).toBe(0);

    const returned = await call(`/bulletin-versions/${version.bulletinVersionId}/return`, {
      method: "POST", token: w.approver.token, company: w.co._id,
      body: { expectedRevision: version.revision, reason: "Re-time the sleeve operation, please." },
    });
    expect(returned.status).toBe(200);
    s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("NO_APPROVED_VERSION");
    expect(s.engineeringStandard.styleFileId).toBe(String(fileId));

    /* And a pointer forced onto the RETURNED version still does not make it
       the standard — the version's own state is checked, not just the pointer. */
    await files().updateOne({ _id: new mongoose.Types.ObjectId(String(fileId)) }, {
      $set: {
        currentApprovedBulletinVersionId: new mongoose.Types.ObjectId(version.bulletinVersionId),
        currentApprovedVersionNo: 1,
      },
    });
    s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("VERSION_NOT_APPROVED");
    expect(s.engineeringStandard.approvalState).toBe("RETURNED");
    expect(s.ieReadiness).not.toBe("READY");
  });

  test("a superseded decoy is ignored, and a pointer onto it is refused", async () => {
    const w = await world("Superseded");
    const v1 = await bulletin(w, DEMO_OPERATIONS.slice(0, 2));
    /* A second approved version supersedes the first. */
    const v2 = await bulletin(w, DEMO_OPERATIONS.slice(0, 5), { fileId: v1.fileId });

    let s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.bulletinVersionId).toBe(v2.version.bulletinVersionId);
    expect(s.engineeringStandard.versionNo).toBe(2);
    expect(s.operationCount).toBe(5);
    const stored1 = await IeBulletinVersion.findById(v1.version.bulletinVersionId).lean();
    expect(stored1.state).toBe("SUPERSEDED");

    /* Repoint at the superseded version: refused on its state. */
    await files().updateOne({ _id: new mongoose.Types.ObjectId(String(v1.fileId)) }, {
      $set: {
        currentApprovedBulletinVersionId: new mongoose.Types.ObjectId(v1.version.bulletinVersionId),
        currentApprovedVersionNo: 1,
      },
    });
    s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("VERSION_NOT_APPROVED");
    expect(s.engineeringStandard.approvalState).toBe("SUPERSEDED");
    expect(s.operationCount).toBe(0);
  });

  test("an APPROVED version nobody points at is never the standard", async () => {
    const w = await world("NotPointed");
    const real = await bulletin(w, DEMO_OPERATIONS.slice(0, 3));

    /* A second APPROVED version on the same file, with a higher number and
       more rows — exactly what "the latest approved version" would pick.
       Fabricated straight into the collection, because no IE verb can leave an
       approved version the pointer does not name. */
    const decoy = await IeBulletinVersion.findById(real.version.bulletinVersionId).lean();
    decoy._id = new mongoose.Types.ObjectId();
    decoy.versionNo = 99;
    decoy.rows = [...decoy.rows, ...decoy.rows, ...decoy.rows];
    decoy.totals = { ...decoy.totals, garmentSamMinutes: 99.99 };
    await versions().insertOne(decoy);

    const s = (await detail(w)).body.styles[0];
    expect(s.engineeringStandard.bulletinVersionId).toBe(real.version.bulletinVersionId);
    expect(s.engineeringStandard.versionNo).toBe(1);
    expect(s.operationCount).toBe(3);
    expect(s.samMinutes).not.toBe(99.99);
    expect(JSON.stringify(s)).not.toContain(String(decoy._id));
  });

  test("another company's approved evidence resolves to nothing", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    await openFile(mine);
    const their = await bulletin(theirs, DEMO_OPERATIONS);

    /* Point MY file at THEIR approved version, number and all. */
    const myFile = await IeStyleFile.findOne({ companyId: mine.co._id }).lean();
    await files().updateOne({ _id: myFile._id }, {
      $set: {
        currentApprovedBulletinVersionId: new mongoose.Types.ObjectId(their.version.bulletinVersionId),
        currentApprovedVersionNo: 1,
      },
    });
    const s = (await detail(mine)).body.styles[0];
    /* The version query is company-scoped, so it is never even loaded. */
    expect(s.engineeringStandard.state).toBe("POINTER_UNRESOLVED");
    expect(s.engineeringStandard.available).toBe(false);
    expect(s.operationCount).toBe(0);
    expect(s.ieReadiness).not.toBe("READY");
    const wire = JSON.stringify(s);
    expect(wire).not.toContain(String(theirs.co._id));
    expect(wire).not.toContain(String(their.fileId));
  });

  test("a version belonging to another file, or carrying another number, is refused", async () => {
    const co = await company("Mismatch");
    const a = await world("MismatchA", { co });
    const b = await world("MismatchB", { co });
    const fileA = (await openFile(a)).fileId;
    const bv = await bulletin(b, DEMO_OPERATIONS.slice(0, 4));

    /* Same company — but B's version, owned by B's file, pointed at from A. */
    await files().updateOne({ _id: new mongoose.Types.ObjectId(String(fileA)) }, {
      $set: {
        currentApprovedBulletinVersionId: new mongoose.Types.ObjectId(bv.version.bulletinVersionId),
        currentApprovedVersionNo: 1,
      },
    });
    let s = (await detail(a)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("POINTER_MISMATCH");
    expect(s.engineeringStandard.pointer.matches).toBe(false);
    expect(s.operationCount).toBe(0);

    /* B's own pointer, with the recorded number moved off the version's. */
    await files().updateOne({ _id: new mongoose.Types.ObjectId(String(bv.fileId)) }, {
      $set: { currentApprovedVersionNo: 7 },
    });
    s = (await detail(b)).body.styles[0];
    expect(s.engineeringStandard.state).toBe("POINTER_MISMATCH");
    expect(s.ieReadiness).not.toBe("READY");
  });

  test("a caller cannot name the version — the response ignores every supplied id", async () => {
    const w = await world("CallerIds");
    const real = await bulletin(w, DEMO_OPERATIONS.slice(0, 2));
    const decoyId = new mongoose.Types.ObjectId();
    const res = await call(
      `/orders/${w.wo._id}?bulletinVersionId=${decoyId}&currentApprovedBulletinVersionId=${decoyId}`,
      {
        token: w.viewer.token, company: w.co._id,
        headers: { "X-Bulletin-Version": String(decoyId) },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.styles[0].engineeringStandard.bulletinVersionId)
      .toBe(real.version.bulletinVersionId);
  });
});

/* ══ 3. HISTORY, AND SEVERAL STYLES ═══════════════════════════════════════ */

describe("historical styles and multi-style orders", () => {
  test("a historical (cancelled) style keeps its approved standard visible", async () => {
    const w = await world("Historical", { styleStatus: "cancelled" });
    await bulletin(w, DEMO_OPERATIONS);
    const d = await detail(w);
    expect(d.status).toBe(200);
    const s = d.body.styles[0];
    expect(s.lifecycle.historical).toBe(true);
    expect(s.engineeringStandard.state).toBe("APPROVED_CURRENT");
    expect(s.operationCount).toBe(7);
    expect(s.samMinutes).toBe(6.25);
  });

  /**
   * TWO STYLES ON ONE ORDER, BUILT THROUGH THE REAL LINK RULES.
   *
   * The order carries no canonical `sampleStyleId`, and both styles name it in
   * their own `production.workOrderIds` — one agreeing source, two styles, so
   * both attach. (Mixing a canonical reference in would make the sources
   * disagree, and a disputed order attaches nothing by design.)
   */
  async function twoStyleOrder(name) {
    const w = await world(name);
    const second = await world(`${name}B`, { co: w.co });
    await WorkOrder.updateOne({ _id: w.wo._id }, { $unset: { sampleStyleId: "" } });
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { "production.workOrderIds": [w.wo._id] } });
    await SampleStyle.updateOne({ _id: second.style._id }, {
      $set: { "production.workOrderIds": [w.wo._id], sourceStockItemId: w.item._id },
    });
    /* The second style's own order is left orphaned on purpose; the one under
       test is the first world's. */
    const secondOnFirst = { ...second, wo: w.wo };
    return { w, secondOnFirst };
  }

  test("every style approved → summed deterministically", async () => {
    const { w, secondOnFirst } = await twoStyleOrder("MultiComplete");
    await bulletin(w, DEMO_OPERATIONS);
    await bulletin(secondOnFirst, DEMO_OPERATIONS.slice(0, 3));

    const d = await detail(w);
    expect(d.body.styles).toHaveLength(2);
    const summary = d.body.order.engineeringStandardSummary;
    expect(summary.complete).toBe(true);
    expect(summary.stylesWithApprovedStandard).toBe(2);
    expect(summary.operationCount).toBe(7 + 3);
    /* 6.25 + (0.72 + 1.15 + 1.40 = 3.27), decimal-safe. */
    expect(summary.garmentSamMinutes).toBe(9.52);
    expect(d.body.order.routeSummary.totalSamMinutes).toBe(9.52);
    expect(d.body.order.routeSummary.standardSource).toBe("APPROVED_BULLETIN_VERSION");
    expect(d.body.order.ieReadiness).toBe("READY");

    /* Deterministic: the same evidence, read again, the same figures. */
    const again = await detail(w);
    expect(again.body.order.engineeringStandardSummary).toEqual(summary);
  });

  test("some styles approved → no invented total, and the reason named", async () => {
    const { w } = await twoStyleOrder("MultiPartial");
    await bulletin(w, DEMO_OPERATIONS);

    const d = await detail(w);
    expect(d.body.styles).toHaveLength(2);
    const summary = d.body.order.engineeringStandardSummary;
    expect(summary).toMatchObject({
      styles: 2,
      stylesWithApprovedStandard: 1,
      stylesWithoutApprovedStandard: 1,
      complete: false,
      operationCount: null,
      garmentSamMinutes: null,
      unavailableReason: "APPROVED_STANDARD_MISSING_FOR_SOME_STYLES",
    });
    /* The order's headline SAM is WITHHELD rather than 6.25 + an unknown. */
    expect(d.body.order.routeSummary.totalSamMinutes).toBeNull();
    expect(d.body.order.routeSummary.samComplete).toBe(false);
    expect(d.body.order.routeSummary.standardSource).toBe("MIXED");
    expect(d.body.order.routeSummary.samUnavailableReason)
      .toBe("APPROVED_STANDARD_MISSING_FOR_SOME_STYLES");
    expect(d.body.order.ieReadiness).toBe("BLOCKED");

    /* Per-style evidence is still published for the one that IS approved. */
    const approved = d.body.styles.find((s) => s.engineeringStandard.available);
    expect(approved.operationCount).toBe(7);
    expect(approved.samMinutes).toBe(6.25);
  });

  test("the aggregate rule itself, on its own", () => {
    const ok = (ops, sam) => ({ state: STANDARD_STATE.APPROVED_CURRENT, operationCount: ops, garmentSamMinutes: sam });
    const missing = { state: STANDARD_STATE.NO_APPROVED_VERSION, operationCount: null, garmentSamMinutes: null };
    expect(standardSummaryOf([])).toMatchObject({
      complete: false, operationCount: null, garmentSamMinutes: null, unavailableReason: "NO_STYLES_LINKED",
    });
    expect(standardSummaryOf([ok(7, 6.25)])).toMatchObject({
      complete: true, operationCount: 7, garmentSamMinutes: 6.25, unavailableReason: null,
    });
    /* 0.1 + 0.2 is 0.3 here, not 0.30000000000000004. */
    expect(standardSummaryOf([ok(1, 0.1), ok(1, 0.2)]).garmentSamMinutes).toBe(0.3);
    expect(standardSummaryOf([ok(7, 6.25), missing])).toMatchObject({
      complete: false, operationCount: null, garmentSamMinutes: null,
      unavailableReason: "APPROVED_STANDARD_MISSING_FOR_SOME_STYLES",
    });
    /* Order of the styles does not change the answer. */
    expect(standardSummaryOf([ok(3, 3.27), ok(7, 6.25)]))
      .toEqual(standardSummaryOf([ok(7, 6.25), ok(3, 3.27)]));
  });
});

/* ══ 4. LIST AND DETAIL AGREE, COST, AND WRITES ═══════════════════════════ */

describe("consistency, cost and read-only behaviour", () => {
  test("the list and the detail tell the same story", async () => {
    const w = await world("Consistent");
    await bulletin(w, DEMO_OPERATIONS);
    const row = rowOf(await list(w), w);
    const d = (await detail(w)).body.order;
    for (const key of ["ieReadiness", "stylesReady", "stylesWithGaps", "routeSummary",
      "engineeringStandardSummary", "styleCount"]) {
      expect(`${key}:${JSON.stringify(row[key])}`).toBe(`${key}:${JSON.stringify(d[key])}`);
    }
  });

  test("a page of many styles costs two extra queries, not two per style", async () => {
    const co = await company("NPlusOne");
    const first = await world("NPlusOne0", { co });
    await bulletin(first, DEMO_OPERATIONS.slice(0, 2));
    for (let k = 1; k < 6; k += 1) {
      const w = await world(`NPlusOne${k}`, { co });
      if (k % 2) await bulletin(w, DEMO_OPERATIONS.slice(0, 2));
      else await openFile(w);
    }

    /* Count reads of the two collections this correction added. */
    const counted = { files: 0, versions: 0 };
    const spyFile = jest.spyOn(IeStyleFile, "find");
    const spyVersion = jest.spyOn(IeBulletinVersion, "find");
    const res = await list(first);
    counted.files = spyFile.mock.calls.length;
    counted.versions = spyVersion.mock.calls.length;
    spyFile.mockRestore();
    spyVersion.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThanOrEqual(6);
    /* Six styles on the page; one read of each collection, not six. */
    expect(counted.files).toBe(1);
    expect(counted.versions).toBe(1);

    /* And no single-document lookups sneaking in beside the batch. */
    const one = jest.spyOn(IeBulletinVersion, "findOne");
    const oneFile = jest.spyOn(IeStyleFile, "findOne");
    await list(first);
    expect(one).not.toHaveBeenCalled();
    expect(oneFile).not.toHaveBeenCalled();
    one.mockRestore();
    oneFile.mockRestore();
  });

  test("neither read writes anything", async () => {
    const w = await world("NoWrites");
    await bulletin(w, DEMO_OPERATIONS);
    const snapshot = async () => JSON.stringify({
      files: await files().find({ companyId: w.co._id }).toArray(),
      versions: await versions().find({ companyId: w.co._id }).toArray(),
      orders: await mongoose.connection.collection("workorders").find({ _id: w.wo._id }).toArray(),
      styles: await mongoose.connection.collection("samplestyles").find({ _id: w.style._id }).toArray(),
    });
    const before = await snapshot();

    const spies = [
      jest.spyOn(mongoose.Model.prototype, "save"),
      ...["updateOne", "updateMany", "findOneAndUpdate", "findByIdAndUpdate", "replaceOne",
        "bulkWrite", "insertMany", "create", "deleteOne", "deleteMany", "findOneAndDelete"]
        .map((name) => jest.spyOn(mongoose.Model, name)),
    ];
    expect((await list(w)).status).toBe(200);
    expect((await detail(w)).status).toBe(200);
    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(await snapshot()).toBe(before);
  });
});
