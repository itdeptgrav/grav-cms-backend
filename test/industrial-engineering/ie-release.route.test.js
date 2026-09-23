// test/industrial-engineering/ie-release.route.test.js
//
// IE CHUNK 8A-i — ISSUING A RELEASE, AT THE WIRE.
//
// Industrial Engineering hands Planning a complete, approved aggregate. The
// claims worth holding:
//
//   · every member must be approved, at the exact revision the caller read, and
//     still bound to the members beside it;
//   · the whole payload is COPIED — rows, stations, metrics, inputs, calculation,
//     ramp and readiness — and never referenced live;
//   · `aggregateFingerprint` covers all three members, so an unchanged bulletin
//     with a changed layout or capacity standard is a CHANGED aggregate;
//   · re-issuing an identical aggregate is a no-op that returns what exists;
//   · a key replays, a changed request under that key is refused, and a missing
//     key is refused;
//   · the release, its predecessor's supersession and the ledger row are one
//     fact, and without transactions none of them happens;
//   · an operation retired AFTER bulletin approval may be overridden once, with
//     a reason, by somebody other than whoever retired it;
//   · an issued release accepts no write, replacement, upsert or deletion;
//   · and nothing here acknowledges, books, or writes Production, PPC, a work
//     order, a barcode or an outbox.
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
const IeLineLayout = require("../../models/CMS_Models/IndustrialEngineering/IeLineLayout");
const IeCapacityStandard = require("../../models/CMS_Models/IndustrialEngineering/IeCapacityStandard");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");
const IeCommandLedger = require("../../models/CMS_Models/IndustrialEngineering/IeCommandLedger");

const { calculateCapacity, garmentSamFor } = require("../../services/industrialEngineering/capacityCalculation");

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
  await IeOperation.syncIndexes();
  await IeCapacityStandard.syncIndexes();
  await IeRelease.syncIndexes();
  await IeCommandLedger.syncIndexes();
});

afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company, headers = {} } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      /* Chunk 8A-i: the release command's idempotency key travels as a header,
         never as a body field — a body field could be replayed verbatim by a
         client that believed it was retrying. */
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
  const email = `cap${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `C${n}`, email, biometricId: `CAP${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
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
 * A company whose four bulletin rows each carry an APPROVED standard time of
 * exactly the minutes asked for — so the garment SAM is an exact number this
 * file can assert against rather than a figure the fixture happens to produce.
 *
 * The default [1, 1.2, 0.8, 1.5] sums to a garment SAM of 4.5 minutes.
 */
async function world(name, { minutes = [1, 1.2, 0.8, 1.5], approveAll = true, machineRequirements = null } = {}) {
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
     compatible, and a capacity standard cannot be approved on a line nobody
     could approve — so this belongs in the ordinary fixture. */
  const operations = [];
  for (let i = 0; i < minutes.length; i += 1) {
    const op = (await call("/operations/library", {
      method: "POST", ...t, body: { code: `OP-${i + 1}`, name: `Operation ${i + 1}`, machineType: "SNLS" },
    })).body.operation;
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
  /* Chunk 5A requirements, configured BEFORE the bulletin is authored so the
     rows freeze them and Chunk 6B can decide compatibility from that evidence. */
  if (machineRequirements) {
    for (let i = 0; i < operations.length; i += 1) {
      const configured = await call(`/operations/library/${operations[i].operationId}/requirements`, {
        method: "PATCH", ...t,
        body: {
          expectedRevision: operations[i].revision,
          machineRequirements: machineRequirements[i] || [],
          attachmentRequirements: [], labourRequirements: [],
        },
      });
      expect(configured.status).toBe(200);
      operations[i] = configured.body.operation;
    }
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

  for (let i = 0; i < rows.length; i += 1) {
    if (!approveAll && i === rows.length - 1) break;
    const opened = await call(`/engineering-files/${file.fileId}/bulletin/${rows[i].rowId}/method-studies`, {
      method: "POST", ...t, body: {},
    });
    const studyId = opened.body.study.studyId;
    const filled = await call(`/method-studies/${studyId}`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 4",
        methodNote: "Two-hand method", ratingPercent: 100, observations: [{ durationSeconds: 60 }],
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
  }

  /* Chunk 7C2: a layout is opened against an APPROVED bulletin version. */
  const version = await approveBulletinVersion({ co, maker, approver, fileId: file.fileId, skip: !approveAll });

  return {
    co, maker, approver, style, workOrder: wo,
    fileId: file.fileId, rows, operations,
    fileRevision: version.fileRevision,
    fileRevisionNow: version.fileRevisionNow,
    bulletinVersion: version.version,
    /* The exact garment SAM this world's layouts will freeze. */
    garmentSam: minutes.reduce((a, b) => a + b, 0),
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


/** Approve ANOTHER study for a row — which moves the source without touching
 *  the bulletin, and is how this file makes a layout stale. */
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
  return approved;
}

/* ── ROUTES UNDER TEST ────────────────────────────────────────────────────── */

const openLayout = (a, w) => call(`/engineering-files/${w.fileId}/line-layouts`, {
  method: "POST", token: a.token, company: w.co._id, body: {},
});
const patchLayout = (a, w, layoutId, body) => call(`/line-layouts/${layoutId}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const makeStandard = (a, w, layoutId, body) => call(`/line-layouts/${layoutId}/capacity-standards`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const readStandard = (a, w, id) => call(`/capacity-standards/${id}`, { token: a.token, company: w.co._id });
const patchStandard = (a, w, id, body) => call(`/capacity-standards/${id}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const listStandards = (a, w, qs = "") => call(`/capacity-standards${qs}`, { token: a.token, company: w.co._id });
const listForLayout = (a, w, layoutId, qs = "") => call(
  `/line-layouts/${layoutId}/capacity-standards${qs}`, { token: a.token, company: w.co._id },
);

/** The planning inputs every test starts from. Net 480 productive minutes. */
const INPUTS = Object.freeze({
  availableShiftMinutes: 540,
  breakMinutes: 60,
  shiftsPerDay: 2,
  plannedOperatorCount: 25,
  plannedHelperCount: 4,
  targetEfficiencyPercent: 60,
  workingTimeSourceKind: "IE_PLANNING_ASSUMPTION",
  workingTimeNote: "Two nine-hour shifts with an hour of breaks, agreed with the floor.",
});

/** A layout with all four operations placed at two stations, and a plan. */
async function arranged(w, actorOverride) {
  const a = actorOverride || w.maker;
  const opened = await openLayout(a, w);
  expect(opened.status).toBe(201);
  const layout = opened.body.layout;
  const rows = layout.source.rows;
  const saved = await patchLayout(a, w, layout.layoutId, {
    expectedRevision: layout.revision,
    stations: [
      {
        label: "Front", note: "Two operators",
        plannedMachineTypes: [{ machineType: "SNLS", quantity: 2 }],
        assignments: [{ rowId: rows[0].rowId }, { rowId: rows[1].rowId }],
      },
      {
        label: "Close", note: "",
        plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }],
        assignments: [{ rowId: rows[2].rowId }, { rowId: rows[3].rowId }],
      },
    ],
  });
  expect(saved.status).toBe(200);
  return saved.body.layout;
}

/** A world with an arranged layout and one capacity standard on it. */
async function standing(name, overrides = {}) {
  const w = await world(name);
  const layout = await arranged(w);
  const made = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, ...overrides });
  expect(made.status).toBe(201);
  return { w, layout, standard: made.body.standard };
}


/**
 * Move the SOURCE a layout is balanced against — Chunk 7C2.
 *
 * Re-timing a row no longer does it on its own: a layout is a balance of an
 * approved bulletin version, and a version does not move. What moves the source
 * is the next version being approved, which is a decision two people took.
 */
async function moveSource(w, { rowIndex = 0, minutes = 2.4 } = {}) {
  await approveAgain(w, rowIndex, { minutes });
  const next = await approveBulletinVersion({
    co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
  });
  w.bulletinVersion = next.version;
  w.fileRevision = next.fileRevision;
  w.fileRevisionNow = next.fileRevisionNow;
  return next;
}


/* ── THE 7C3 SURFACE ──────────────────────────────────────────────────────── */

const approveStandard = (a, w, id, body) => call(`/capacity-standards/${id}/approve`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const approveLayout = (a, w, layoutId, body) => call(`/line-layouts/${layoutId}/approve`, {
  method: "POST", token: a.token, company: w.co._id, body,
});

/**
 * A world whose line layout is APPROVED, and a capacity standard created
 * against it afterwards — which is the only order that produces an approvable
 * standard, and is the order a person actually works in.
 */
async function onApprovedLayout(name, overrides = {}) {
  const w = await world(name);
  const draft = await arranged(w);
  const approved = await approveLayout(w.approver, w, draft.layoutId, {
    expectedRevision: draft.revision,
  });
  expect(approved.status).toBe(200);
  const layout = approved.body.layout;

  const made = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, ...overrides });
  expect(made.status).toBe(201);
  /* It froze the revision the layout is at NOW, which is one past the revision
     that was approved — the approval moved it in the same write. */
  expect(made.body.standard.source.lineLayoutRevision).toBe(layout.revision);
  expect(layout.revision).toBe(layout.approval.approvedRevision + 1);
  return { w, layout, standard: made.body.standard };
}

/** The same, and approved by somebody other than its author. */
async function approvedStandard(name, overrides = {}) {
  const { w, layout, standard } = await onApprovedLayout(name, overrides);
  const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
    expectedRevision: standard.revision,
  });
  expect(res.status).toBe(200);
  return { w, layout, standard: res.body.standard, before: standard };
}


/* ── THE 8A-i SURFACE ─────────────────────────────────────────────────────── */

const { aggregateFingerprintOf } = require("../../services/industrialEngineering/releaseFingerprint");
const { transactionsAvailable, __setTransactionSupport } = require("../../services/storePurchase/unitOfWork.service");

let keySeq = 0;
const nextKey = () => `key-${++keySeq}-${Date.now()}`;

const issue = (a, w, fileId, body, key) => call(`/style-files/${fileId}/releases`, {
  method: "POST", token: a.token, company: w.co._id, body,
  headers: key === null ? {} : { "Idempotency-Key": key ?? nextKey() },
});

/**
 * A world whose bulletin version, line layout and capacity standard are all
 * approved — the only shape a release can be issued from.
 */
async function releasable(name) {
  const { w, layout, standard } = await approvedStandard(name);
  const version = await IeBulletinVersion.findOne({
    companyId: w.co._id, state: "APPROVED",
  }).lean();
  expect(version).toBeTruthy();
  return {
    w, layout, standard, version,
    body: {
      bulletinVersionId: String(version._id),
      expectedBulletinVersionNo: version.versionNo,
      lineLayoutId: layout.layoutId,
      expectedLayoutRevision: layout.revision,
      capacityStandardId: standard.capacityStandardId,
      expectedCapacityRevision: standard.revision,
    },
  };
}

/** Released once, and the release it produced. */
async function released(name) {
  const ctx = await releasable(name);
  const res = await issue(ctx.w.approver, ctx.w, ctx.w.fileId, ctx.body);
  expect(res.status).toBe(201);
  return { ...ctx, release: res.body.release };
}

/* ══ 1. THE FIRST ISSUE ═══════════════════════════════════════════════════ */

describe("issuing a release", () => {
  test("version 1 carries the complete frozen aggregate", async () => {
    const { w, layout, standard, version, body } = await releasable("First");
    const res = await issue(w.approver, w, w.fileId, { ...body, note: "  First   handover  " });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);

    const r = res.body.release;
    expect(r.versionNo).toBe(1);
    expect(r.state).toBe("ISSUED");
    expect(r.releaseRef).toMatch(/^IEREL-[0-9A-F]{10}$/);
    expect(r.styleFileId).toBe(String(w.fileId));
    expect(r.issuedByName).toBeTruthy();
    expect(r.issuedAt).toBeTruthy();
    expect(r.supersededByVersionNo).toBeNull();
    expect(r.note).toBe("First handover");
    expect(r.aggregateFingerprint).toMatch(/^[0-9a-f]{64}$/);

    /* ── THE BULLETIN HALF, COPIED ROW FOR ROW ─────────────────────────── */
    expect(r.source.bulletinVersionId).toBe(String(version._id));
    expect(r.source.bulletinVersionNo).toBe(version.versionNo);
    expect(r.source.sourceFingerprint).toBe(version.sourceFingerprint);
    expect(r.source.sourceApprovalDigest).toBe(version.sourceApprovalDigest);
    expect(r.source.rows).toHaveLength(version.rows.length);
    version.rows.forEach((row, i) => {
      const frozen = r.source.rows[i];
      expect(frozen.rowId).toBe(row.rowId);
      expect(String(frozen.ieOperationId)).toBe(String(row.ieOperationId));
      expect(frozen.ieOperationRevision).toBe(row.ieOperationRevision);
      expect(frozen.operationCode).toBe(row.operationCode);
      expect(frozen.standardTimeMinutes).toBe(row.standardTimeMinutes);
      expect(String(frozen.methodStudyId)).toBe(String(row.methodStudyId));
      expect(frozen.approvedSubmissionId).toBe(row.approvedSubmissionId);
    });
    expect(r.source.garmentSamMinutes).toBe(4.5);
    expect(r.source.samRowCount).toBe(4);
    expect(r.source.samDerivation).toBeTruthy();

    /* ── THE LAYOUT HALF ───────────────────────────────────────────────── */
    expect(String(r.source.lineLayout.id)).toBe(layout.layoutId);
    expect(r.source.lineLayout.revision).toBe(layout.revision);
    expect(r.source.lineLayout.stationCount).toBe(2);
    expect(r.source.lineLayout.stations).toHaveLength(2);
    expect(r.source.lineLayout.metrics.totalWorkContentMinutes).toBe(4.5);
    expect(r.source.lineLayout.metrics.rounding).toBe("HALF_UP_4DP");

    /* ── AND THE CAPACITY HALF ─────────────────────────────────────────── */
    expect(String(r.source.capacityStandard.id)).toBe(standard.capacityStandardId);
    expect(r.source.capacityStandard.revision).toBe(standard.revision);
    expect(r.source.capacityStandard.inputs.plannedOperatorCount).toBe(INPUTS.plannedOperatorCount);
    expect(r.source.capacityStandard.calculation.wholePieceShiftTarget)
      .toBe(standard.calculation.wholePieceShiftTarget);
    expect(r.source.capturedAt).toBeTruthy();

    /* One bounded history line, about this version. */
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toMatchObject({ type: "RELEASE_ISSUED", versionNo: 1 });

    /* And it hands nothing on by itself. */
    expect(r.acknowledgement).toBeNull();
    expect(r.booksCapacity).toBe(false);
    expect(r.writesProduction).toBe(false);

    const stored = await IeRelease.findById(r.releaseId).lean();
    expect(stored.state).toBe("ISSUED");
    expect(stored.history).toHaveLength(1);
    expect(await IeCommandLedger.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("only an approver may issue", async () => {
    const { w, body } = await releasable("Roles");
    for (const a of [await viewerIn(w.co), await editorIn(w.co)]) {
      const res = await issue(a, w, w.fileId, body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    }
    expect(await IeRelease.countDocuments({})).toBe(0);
    expect((await issue(w.approver, w, w.fileId, body)).status).toBe(201);
  });

  test("another company's file and members are indistinguishable from absent", async () => {
    const mine = await releasable("IsoMine");
    const theirs = await releasable("IsoTheirs");
    const outsider = await approverIn(theirs.w.co);

    /* Their actor, my file. */
    const foreignFile = await issue(outsider, theirs.w, mine.w.fileId, theirs.body);
    const ghostFile = await issue(outsider, theirs.w, new mongoose.Types.ObjectId(), theirs.body);
    expect(foreignFile.status).toBe(404);
    expect(foreignFile.body.error.code).toBe("IE_FILE_NOT_FOUND");
    expect(foreignFile.body).toEqual(ghostFile.body);

    /* My file, their members: every one is simply not a member of this file. */
    const crossed = await issue(mine.w.approver, mine.w, mine.w.fileId, theirs.body);
    expect(crossed.status).toBe(409);
    expect(crossed.body.error.code).toBe("IE_RELEASE_NOT_APPROVED");
    expect(crossed.body.error.details.members.map((m) => m.reason)).toEqual(["NOT_FOUND", "NOT_FOUND", "NOT_FOUND"]);
    /* Nothing leaks about whether their records exist. */
    const invented = await issue(mine.w.approver, mine.w, mine.w.fileId, {
      ...mine.body,
      bulletinVersionId: String(new mongoose.Types.ObjectId()),
      lineLayoutId: String(new mongoose.Types.ObjectId()),
      capacityStandardId: String(new mongoose.Types.ObjectId()),
    });
    expect(invented.body.error.details.members.map((m) => m.reason))
      .toEqual(crossed.body.error.details.members.map((m) => m.reason));
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("the body accepts only the command's own fields", async () => {
    const { w, body } = await releasable("Body");
    for (const extra of [
      { companyId: String(w.co._id) }, { releaseRef: "IEREL-FORGED" }, { versionNo: 5 },
      { state: "ISSUED" }, { aggregateFingerprint: "f".repeat(64) }, { source: {} },
      { issuedBy: String(new mongoose.Types.ObjectId()) }, { issuedAt: "2026-01-01" },
      { supersededByVersionNo: 1 }, { history: [] }, { ieStyleFileId: String(w.fileId) },
      { idempotencyKey: "in-the-body" }, { acknowledgement: {} }, { workOrderId: "x" },
    ]) {
      const res = await issue(w.approver, w, w.fileId, { ...body, ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(Object.keys(extra)[0]);
    }
    expect(await IeRelease.countDocuments({})).toBe(0);
  });
});

/* ══ 2. EVERY MEMBER APPROVED, AT ITS EXACT REVISION ══════════════════════ */

describe("the aggregate must be approved and still bound together", () => {
  test("unapproved members are all returned together", async () => {
    /* A world where nothing has been approved: the bulletin version is in
       review, the layout is a draft, and the standard is a draft on it. */
    const w = await world("Unapproved");
    const file = await IeStyleFile.findById(w.fileId).lean();
    const submitted = await call(`/engineering-files/${w.fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    expect(submitted.status).toBe(201);
    const draftLayout = await arranged(w);
    const draftStandard = (await makeStandard(w.maker, w, draftLayout.layoutId, INPUTS)).body.standard;

    const res = await issue(w.approver, w, w.fileId, {
      bulletinVersionId: submitted.body.version.bulletinVersionId,
      expectedBulletinVersionNo: 1,
      lineLayoutId: draftLayout.layoutId,
      expectedLayoutRevision: draftLayout.revision,
      capacityStandardId: draftStandard.capacityStandardId,
      expectedCapacityRevision: draftStandard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_NOT_APPROVED");
    const members = res.body.error.details.members;
    expect(members.map((m) => m.member).sort())
      .toEqual(["BULLETIN_VERSION", "CAPACITY_STANDARD", "LINE_LAYOUT"]);
    expect(members.every((m) => m.reason === "NOT_APPROVED")).toBe(true);
    expect(members.find((m) => m.member === "BULLETIN_VERSION").state).toBe("IN_REVIEW");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("every expected revision is enforced, and all conflicts reported together", async () => {
    const { w, body } = await releasable("Expected");
    const res = await issue(w.approver, w, w.fileId, {
      ...body,
      expectedBulletinVersionNo: body.expectedBulletinVersionNo + 5,
      expectedLayoutRevision: body.expectedLayoutRevision + 5,
      expectedCapacityRevision: body.expectedCapacityRevision + 5,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_REVISION_CONFLICT");
    expect(res.body.error.details.conflicts).toHaveLength(3);
    for (const c of res.body.error.details.conflicts) {
      expect(c.expected).toBe(c.actual + 5);
    }
    expect(await IeRelease.countDocuments({})).toBe(0);

    /* One wrong is enough, and it names which. */
    const one = await issue(w.approver, w, w.fileId, {
      ...body, expectedLayoutRevision: body.expectedLayoutRevision + 1,
    });
    expect(one.status).toBe(409);
    expect(one.body.error.details.conflicts).toHaveLength(1);
    expect(one.body.error.details.conflicts[0].member).toBe("LINE_LAYOUT");
  });

  test("a layout balancing a different bulletin version is refused", async () => {
    const a = await releasable("CrossA");
    const b = await releasable("CrossB");
    /* B's layout, pointed at A's file, so it is found and then judged. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(b.layout.layoutId)) },
      {
        $set: {
          companyId: a.w.co._id,
          ieStyleFileId: new mongoose.Types.ObjectId(String(a.w.fileId)),
          sampleStyleId: a.w.style._id,
        },
      },
    );
    const res = await issue(a.w.approver, a.w, a.w.fileId, {
      ...a.body, lineLayoutId: b.layout.layoutId, expectedLayoutRevision: b.layout.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_CAPACITY_NOT_BOUND");
    expect(res.body.error.details.bulletinVersionId).toBe(a.body.bulletinVersionId);
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("a capacity standard targeting a different layout is refused", async () => {
    const a = await releasable("StdCrossA");
    const b = await releasable("StdCrossB");
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(b.standard.capacityStandardId)) },
      { $set: { ieStyleFileId: new mongoose.Types.ObjectId(String(a.w.fileId)), companyId: a.w.co._id } },
    );
    const res = await issue(a.w.approver, a.w, a.w.fileId, {
      ...a.body,
      capacityStandardId: b.standard.capacityStandardId,
      expectedCapacityRevision: b.standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_CAPACITY_NOT_BOUND");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("a layout whose frozen source no longer matches its version is refused", async () => {
    const { w, layout, body } = await releasable("LayoutMoved");
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $set: { "sourceRows.0.standardTimeMinutes": 9.5 } },
    );
    const res = await issue(w.approver, w, w.fileId, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_SOURCE_CHANGED");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("a capacity standard whose frozen source no longer matches is refused", async () => {
    const { w, standard, body } = await releasable("StandardMoved");
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) },
      { $set: { "source.garmentSamMinutes": 3.25 } },
    );
    const res = await issue(w.approver, w, w.fileId, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_SOURCE_CHANGED");
    expect(res.body.error.details.reasons).toContain("GARMENT_SAM_CHANGED");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("a layout with no calculable balance is refused", async () => {
    const { w, layout, body } = await releasable("NoBalance");
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) }, { $set: { stations: [] } },
    );
    const res = await issue(w.approver, w, w.fileId, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_LAYOUT_NOT_READY");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("the provisional calendar truth survives the release exactly", async () => {
    const { release } = await released("Provisional");
    const cs = release.source.capacityStandard;
    expect(cs.calendarLinkage.state).toBe("UNKNOWN");
    expect(cs.calendarLinkage.reason).toBe("NO_COMPANY_SCOPED_WORKING_TIME_CALENDAR");
    expect(cs.workingTimeSource.kind).toBe("IE_PLANNING_ASSUMPTION");
    expect(cs.workingTimeSource.calendarId).toBeNull();
    expect(cs.workingTimeSource.note).toBe(INPUTS.workingTimeNote);
    expect(cs.readiness.state).toBe("PROVISIONAL");
    expect(cs.readiness.gaps.map((g) => g.code)).toContain("IE_CAPACITY_WORKING_TIME_ASSUMED");
    /* Never upgraded on the way out. */
    expect(cs.readiness.state).not.toBe("READY");
    expect(JSON.stringify(release)).not.toContain("PROVED_CALENDAR_VERSION");
  });
});

/* ══ 3. IDEMPOTENCY AND THE AGGREGATE FINGERPRINT ═════════════════════════ */

describe("a release is issued once, however many times it is asked for", () => {
  test("the same key with the same request replays the first answer", async () => {
    const { w, body } = await releasable("Replay");
    const key = nextKey();
    const first = await issue(w.approver, w, w.fileId, body, key);
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);

    const again = await issue(w.approver, w, w.fileId, body, key);
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.release.releaseId).toBe(first.body.release.releaseId);
    expect(again.body.release.versionNo).toBe(1);

    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(await IeCommandLedger.countDocuments({})).toBe(1);
  });

  test("the same key with a different request is refused as a client bug", async () => {
    const { w, body } = await releasable("Reused");
    const key = nextKey();
    expect((await issue(w.approver, w, w.fileId, body, key)).status).toBe(201);

    const different = await issue(w.approver, w, w.fileId, { ...body, note: "A different intention" }, key);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(different.body.error.details.scope).toBe("IE_RELEASE_ISSUE");
    /* Replaying the first answer would have told somebody their SECOND,
       different intention had succeeded. */
    expect(await IeRelease.countDocuments({})).toBe(1);
  });

  test("a missing key is refused before anything is read", async () => {
    const { w, body } = await releasable("NoKey");
    const res = await issue(w.approver, w, w.fileId, body, null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(res.body.error.details.header).toBe("Idempotency-Key");
    expect(await IeRelease.countDocuments({})).toBe(0);
    expect(await IeCommandLedger.countDocuments({})).toBe(0);
  });

  test("a NEW key for an identical aggregate returns the release that exists", async () => {
    /* The caller asked for a state of the world that is already true. That is a
       no-op, not a second version — and not an error either. */
    const { w, body } = await releasable("SameAggregate");
    const first = await issue(w.approver, w, w.fileId, body);
    expect(first.status).toBe(201);

    const second = await issue(w.approver, w, w.fileId, body);
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.release.releaseId).toBe(first.body.release.releaseId);
    expect(second.body.release.versionNo).toBe(1);
    expect(second.body.release.state).toBe("ISSUED");

    expect(await IeRelease.countDocuments({})).toBe(1);
    /* And the first release was not touched on the way past. */
    const stored = await IeRelease.findById(first.body.release.releaseId).lean();
    expect(stored.history).toHaveLength(1);
  });

  test("a changed CAPACITY standard is a changed aggregate, though the bulletin never moved", async () => {
    /* The distinction the whole record turns on. The bulletin version is
       identical, so its own `sourceFingerprint` is identical — and under that
       fingerprint this second release would have been refused as a duplicate
       and Planning would never have learned the target had changed. */
    const { w, layout, body, release: first } = await released("ChangedCapacity");
    expect(first.versionNo).toBe(1);

    const second = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, plannedOperatorCount: 40,
    });
    expect(second.status).toBe(201);
    const approved = await approveStandard(w.approver, w, second.body.standard.capacityStandardId, {
      expectedRevision: second.body.standard.revision,
    });
    expect(approved.status).toBe(200);

    const res = await issue(w.approver, w, w.fileId, {
      ...body,
      capacityStandardId: approved.body.standard.capacityStandardId,
      expectedCapacityRevision: approved.body.standard.revision,
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(res.body.release.versionNo).toBe(2);
    /* The bulletin's own fingerprint did NOT move… */
    expect(res.body.release.source.sourceFingerprint).toBe(first.source.sourceFingerprint);
    /* …and the aggregate's did. */
    expect(res.body.release.aggregateFingerprint).not.toBe(first.aggregateFingerprint);

    /* Version 1 is superseded, and its event is about version 1. */
    const older = await IeRelease.findById(first.releaseId).lean();
    expect(older.state).toBe("SUPERSEDED");
    expect(older.supersededByVersionNo).toBe(2);
    expect(older.history.at(-1)).toMatchObject({ type: "RELEASE_SUPERSEDED", versionNo: 1 });
    /* Its frozen payload is untouched: superseding is not rewriting. */
    expect(older.source.capacityStandard.inputs.plannedOperatorCount)
      .toBe(INPUTS.plannedOperatorCount);
    expect(await IeRelease.countDocuments({ state: "ISSUED" })).toBe(1);
  });

  test("a changed LAYOUT is a changed aggregate too", async () => {
    const { w, body, release: first } = await released("ChangedLayout");
    /* A successor draft of the same approved bulletin, rearranged and approved. */
    const successor = await openLayout(w.maker, w);
    expect(successor.status).toBe(201);
    const rows = successor.body.layout.source.rows.map((r) => r.rowId);
    const saved = await patchLayout(w.maker, w, successor.body.layout.layoutId, {
      expectedRevision: successor.body.layout.revision,
      stations: [{
        label: "One line",
        plannedMachineTypes: [{ machineType: "SNLS", quantity: 4 }],
        assignments: rows.map((rowId) => ({ rowId })),
      }],
    });
    expect(saved.status).toBe(200);
    const approvedLayout = await approveLayout(w.approver, w, successor.body.layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
    });
    expect(approvedLayout.status).toBe(200);

    const std = await makeStandard(w.maker, w, approvedLayout.body.layout.layoutId, INPUTS);
    const approvedStd = await approveStandard(w.approver, w, std.body.standard.capacityStandardId, {
      expectedRevision: std.body.standard.revision,
    });
    expect(approvedStd.status).toBe(200);

    const res = await issue(w.approver, w, w.fileId, {
      ...body,
      lineLayoutId: approvedLayout.body.layout.layoutId,
      expectedLayoutRevision: approvedLayout.body.layout.revision,
      capacityStandardId: approvedStd.body.standard.capacityStandardId,
      expectedCapacityRevision: approvedStd.body.standard.revision,
    });
    expect(res.status).toBe(201);
    expect(res.body.release.versionNo).toBe(2);
    expect(res.body.release.source.sourceFingerprint).toBe(first.source.sourceFingerprint);
    expect(res.body.release.aggregateFingerprint).not.toBe(first.aggregateFingerprint);
    expect(res.body.release.source.lineLayout.stationCount).toBe(1);
    expect((await IeRelease.findById(first.releaseId).lean()).state).toBe("SUPERSEDED");
  });

  test("the fingerprint ignores the clock, the issuer, the note and the overrides", async () => {
    /* Two people issuing the same aggregate a minute apart are issuing the SAME
       aggregate. A fingerprint that moved with the clock would mint a version
       for no change at all. */
    const { release } = await released("Volatile");
    const payload = release.source;
    const a = aggregateFingerprintOf(payload);
    const b = aggregateFingerprintOf({
      ...payload, capturedAt: new Date("2030-01-01"),
    });
    expect(a).toBe(b);
    expect(a).toBe(release.aggregateFingerprint);
    /* But a real change moves it. */
    expect(aggregateFingerprintOf({
      ...payload,
      capacityStandard: {
        ...payload.capacityStandard,
        inputs: { ...payload.capacityStandard.inputs, plannedOperatorCount: 99 },
      },
    })).not.toBe(a);
    expect(aggregateFingerprintOf({
      ...payload, lineLayout: { ...payload.lineLayout, stationCount: 9 },
    })).not.toBe(a);
  });

  test("two concurrent commands leave exactly one issued head", async () => {
    const { w, body } = await releasable("Concurrent");
    const other = await approverIn(w.co);
    const [one, two] = await Promise.all([
      issue(w.approver, w, w.fileId, body),
      issue(other, w, w.fileId, body),
    ]);
    for (const res of [one, two]) expect([200, 201]).toContain(res.status);
    expect([one, two].filter((r) => r.status === 201)).toHaveLength(1);
    expect(one.body.release.releaseId).toBe(two.body.release.releaseId);

    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(await IeRelease.countDocuments({ state: "ISSUED" })).toBe(1);
    const stored = await IeRelease.findOne({}).lean();
    expect(stored.versionNo).toBe(1);
    expect(stored.history.filter((e) => e.type === "RELEASE_ISSUED")).toHaveLength(1);
  });
});

/* ══ 4. ALL FOUR EFFECTS, OR NONE ═════════════════════════════════════════ */

describe("the release, its supersession and its ledger row are one fact", () => {
  test("without transactions nothing at all is written", async () => {
    const { w, body } = await releasable("NoTxn");
    __setTransactionSupport(false);
    try {
      const res = await issue(w.approver, w, w.fileId, body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("IE_RELEASE_ATOMICITY_UNAVAILABLE");
      expect(res.body.error.details).toMatchObject({
        requires: "MONGODB_TRANSACTIONS", wrote: "NOTHING",
      });
    } finally {
      __setTransactionSupport(true);
    }
    expect(await IeRelease.countDocuments({})).toBe(0);
    expect(await IeCommandLedger.countDocuments({})).toBe(0);

    /* And the door opens again once the deployment can. */
    expect((await issue(w.approver, w, w.fileId, body)).status).toBe(201);
  });

  test("a failure inside the transaction rolls back all three writes together", async () => {
    const { w, body, release: first } = await released("Rollback");
    /* A second, genuinely changed aggregate — so the command reaches the
       supersession — with the ledger write made to fail. */
    const second = await makeStandard(w.maker, w, (await IeLineLayout.findOne({
      companyId: w.co._id, status: "APPROVED",
    }).lean())._id.toString(), { ...INPUTS, plannedOperatorCount: 44 });
    const approved = await approveStandard(w.approver, w, second.body.standard.capacityStandardId, {
      expectedRevision: second.body.standard.revision,
    });
    expect(approved.status).toBe(200);

    const real = IeCommandLedger.create;
    IeCommandLedger.create = async () => { throw new Error("ledger write exploded"); };
    let res;
    try {
      res = await issue(w.approver, w, w.fileId, {
        ...body,
        capacityStandardId: approved.body.standard.capacityStandardId,
        expectedCapacityRevision: approved.body.standard.revision,
      });
    } finally {
      IeCommandLedger.create = real;
    }
    expect(res.status).toBe(500);

    /* No version 2, no ledger row, and version 1 still the ISSUED head with its
       history untouched — the supersession rolled back with everything else. */
    expect(await IeRelease.countDocuments({})).toBe(1);
    /* One ledger row — the FIRST release's. The failed command left none, so a
       retry with the same key is a clean first attempt rather than a replay of
       something that never happened. */
    const rows = await IeCommandLedger.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].resultId)).toBe(first.releaseId);
    const older = await IeRelease.findById(first.releaseId).lean();
    expect(older.state).toBe("ISSUED");
    expect(older.supersededByVersionNo).toBeNull();
    expect(older.history).toHaveLength(1);
  });

  test("the ledger row records what is needed to replay, and is itself frozen", async () => {
    const { w, release } = await released("Ledger");
    const row = await IeCommandLedger.findOne({ companyId: w.co._id }).lean();
    expect(row.scope).toBe("IE_RELEASE_ISSUE");
    expect(row.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(String(row.resultId)).toBe(release.releaseId);
    expect(row.releaseRef).toBe(release.releaseRef);
    expect(row.releaseVersionNo).toBe(1);
    expect(row.aggregateFingerprint).toBe(release.aggregateFingerprint);
    expect(row.responseStatus).toBe(201);
    expect(row.responseBody.release.releaseId).toBe(release.releaseId);

    /* A ledger row records an answer already given; rewriting one would make a
       replay return something other than what the caller was told. */
    await expect(IeCommandLedger.updateOne({ _id: row._id }, { $set: { requestHash: "x" } }))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    await expect(IeCommandLedger.findOneAndUpdate({ _id: row._id }, { $set: { responseStatus: 200 } }))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
  });
});

/* ══ 5. OPERATIONS RETIRED AFTER APPROVAL ═════════════════════════════════ */

describe("a retired operation is one decision, taken once", () => {
  /** Retire one of the world's operations, by a named actor, after approval. */
  async function retireAfterApproval(w, index, by) {
    const op = w.operations[index];
    const res = await call(`/operations/library/${op.operationId}/retire`, {
      method: "POST", token: (by || w.maker).token, company: w.co._id,
      body: { expectedRevision: op.revision },
    });
    expect(res.status).toBe(200);
    return res.body.operation;
  }

  test("every uncovered retired operation is returned together", async () => {
    const { w, body } = await releasable("Retired");
    await retireAfterApproval(w, 0);
    await retireAfterApproval(w, 2);

    const res = await issue(w.approver, w, w.fileId, body);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_RELEASE_OPERATION_RETIRED");
    const listed = res.body.error.details.operations;
    expect(listed).toHaveLength(2);
    expect(listed.map((o) => o.operationCode).sort()).toEqual(["OP-1", "OP-3"]);
    for (const o of listed) {
      expect(o.status).toBe("RETIRED");
      expect(o.retiredAt).toBeTruthy();
      expect(o.ieOperationRevision).toBeGreaterThanOrEqual(1);
    }
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("a valid override releases, and freezes the evidence", async () => {
    const { w, body, version } = await releasable("Override");
    const retired = await retireAfterApproval(w, 0);
    const row = version.rows.find((r) => String(r.ieOperationId) === retired.operationId);

    const res = await issue(w.approver, w, w.fileId, {
      ...body,
      retiredOperationOverrides: [{
        ieOperationId: retired.operationId,
        ieOperationRevision: row.ieOperationRevision,
        reason: "  Retired in error after   approval; the line still runs it.  ",
      }],
    });
    expect(res.status).toBe(201);

    const frozen = res.body.release.retiredOperationOverrides;
    expect(frozen).toHaveLength(1);
    expect(frozen[0]).toMatchObject({
      ieOperationId: retired.operationId,
      ieOperationRevision: row.ieOperationRevision,
      operationCode: "OP-1",
      reason: "Retired in error after approval; the line still runs it.",
    });
    expect(frozen[0].retiredAt).toBeTruthy();
    expect(frozen[0].retiredByName).toBeTruthy();
    expect(frozen[0].bulletinApprovedAt).toBeTruthy();
    expect(frozen[0].overriddenByName).toBeTruthy();
    expect(frozen[0].overriddenAt).toBeTruthy();
    /* Enough to re-examine the decision without reading anything else. */
    expect(new Date(frozen[0].retiredAt) > new Date(frozen[0].bulletinApprovedAt)).toBe(true);
    /* And the history says an override was involved. */
    expect(res.body.release.history[0].summary).toMatch(/override/i);
  });

  test("a wrong revision, a short reason and an absent operation each refuse", async () => {
    const { w, body, version } = await releasable("BadOverrides");
    const retired = await retireAfterApproval(w, 0);
    const row = version.rows.find((r) => String(r.ieOperationId) === retired.operationId);
    const good = {
      ieOperationId: retired.operationId,
      ieOperationRevision: row.ieOperationRevision,
      reason: "A perfectly adequate reason for the override.",
    };

    /* The revision the bulletin FROZE — overriding "whatever it is now" would
       sign off a row nobody read. */
    const wrongRevision = await issue(w.approver, w, w.fileId, {
      ...body, retiredOperationOverrides: [{ ...good, ieOperationRevision: row.ieOperationRevision + 7 }],
    });
    expect(wrongRevision.status).toBe(400);
    expect(wrongRevision.body.error.code).toBe("IE_RELEASE_OVERRIDE_NOT_APPLICABLE");
    expect(wrongRevision.body.error.details.reason).toBe("REVISION_MISMATCH");

    for (const reason of [undefined, "", "   ", "too short"]) {
      const res = await issue(w.approver, w, w.fileId, {
        ...body, retiredOperationOverrides: [{ ...good, reason }],
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_RELEASE_OVERRIDE_REASON_REQUIRED");
    }

    /* An operation that is not on the bulletin decides nothing about it. */
    const stranger = (await call("/operations/library", {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { code: "OP-STRANGER", name: "Not on this bulletin", machineType: "SNLS" },
    })).body.operation;
    const absent = await issue(w.approver, w, w.fileId, {
      ...body,
      retiredOperationOverrides: [good, { ...good, ieOperationId: stranger.operationId, ieOperationRevision: 1 }],
    });
    expect(absent.status).toBe(400);
    expect(absent.body.error.code).toBe("IE_RELEASE_OVERRIDE_NOT_APPLICABLE");
    expect(absent.body.error.details.reason).toBe("NOT_ON_BULLETIN");

    /* And one for an operation that is perfectly active. */
    const active = await issue(w.approver, w, w.fileId, {
      ...body,
      retiredOperationOverrides: [good, {
        ieOperationId: w.operations[1].operationId,
        ieOperationRevision: version.rows[1].ieOperationRevision,
        reason: "Overriding something that needs no overriding.",
      }],
    });
    expect(active.status).toBe(400);
    expect(active.body.error.details.reason).toBe("OPERATION_IS_ACTIVE");

    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("an operation retired BEFORE approval cannot be overridden", async () => {
    /* Chunk 7C1 refuses to approve a bulletin naming a retired operation, so an
       override claiming a pre-approval retirement is describing something that
       did not happen. Constructed by moving the retirement timestamp back. */
    const { w, body, version } = await releasable("RetiredBefore");
    const retired = await retireAfterApproval(w, 0);
    const row = version.rows.find((r) => String(r.ieOperationId) === retired.operationId);
    await IeOperation.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(retired.operationId)) },
      { $set: { statusChangedAt: new Date("2020-01-01") } },
    );

    const res = await issue(w.approver, w, w.fileId, {
      ...body,
      retiredOperationOverrides: [{
        ieOperationId: retired.operationId,
        ieOperationRevision: row.ieOperationRevision,
        reason: "Trying to override a retirement that predates the approval.",
      }],
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_RELEASE_OVERRIDE_NOT_APPLICABLE");
    expect(res.body.error.details.reason).toBe("RETIRED_BEFORE_APPROVAL");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });

  test("the person who retired it may not be the person who overrides it", async () => {
    const { w, body, version } = await releasable("OverrideMaker");
    /* Retired BY the approver who would then issue the release. */
    const retired = await retireAfterApproval(w, 0, w.approver);
    const row = version.rows.find((r) => String(r.ieOperationId) === retired.operationId);
    const override = {
      ieOperationId: retired.operationId,
      ieOperationRevision: row.ieOperationRevision,
      reason: "Retired it myself and would now like to release it.",
    };

    const res = await issue(w.approver, w, w.fileId, { ...body, retiredOperationOverrides: [override] });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_RELEASE_OVERRIDE_MAKER_CHECKER");
    expect(res.body.error.details.retiredByName).toBeTruthy();
    expect(await IeRelease.countDocuments({})).toBe(0);

    /* Somebody else may. Compared by actor id, with no owner exemption. */
    const other = await approverIn(w.co);
    const ok = await issue(other, w, w.fileId, { ...body, retiredOperationOverrides: [override] });
    expect(ok.status).toBe(201);
    expect(ok.body.release.retiredOperationOverrides[0].overriddenByName).toBeTruthy();
  });

  test("the same operation cannot be overridden twice in one request", async () => {
    const { w, body, version } = await releasable("DoubleOverride");
    const retired = await retireAfterApproval(w, 0);
    const row = version.rows.find((r) => String(r.ieOperationId) === retired.operationId);
    const one = {
      ieOperationId: retired.operationId,
      ieOperationRevision: row.ieOperationRevision,
      reason: "One perfectly good reason for this override.",
    };
    const res = await issue(w.approver, w, w.fileId, { ...body, retiredOperationOverrides: [one, one] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IE_RELEASE_OVERRIDE_NOT_APPLICABLE");
    expect(await IeRelease.countDocuments({})).toBe(0);
  });
});

/* ══ 6. AN ISSUED RELEASE IS PERMANENT EVIDENCE ═══════════════════════════ */

describe("an issued release accepts no write, of any kind", () => {
  test("every content mutation, replacement, upsert and deletion is refused", async () => {
    const { w, release } = await released("Immutable");
    const id = release.releaseId;
    const before = await IeRelease.findById(id).lean();

    /* ── save() ── */
    for (const mutate of [
      (d) => { d.note = "Rewritten"; },
      (d) => { d.source.garmentSamMinutes = 99; },
      (d) => { d.state = "WITHDRAWN"; },
      (d) => { d.issuedByName = "Somebody else"; },
      (d) => { d.aggregateFingerprint = "f".repeat(64); },
    ]) {
      const doc = await IeRelease.findById(id);
      mutate(doc);
      await expect(doc.save()).rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    }

    /* ── the query layer, including every field nobody listed ── */
    const other = await world("Elsewhere");
    for (const update of [
      { $set: { note: "Rewritten" } },
      { $set: { source: {} } },
      { $set: { "source.garmentSamMinutes": 99 } },
      { $set: { aggregateFingerprint: "f".repeat(64) } },
      { $set: { companyId: other.co._id } },
      { $set: { releaseRef: "IEREL-FORGED" } },
      { $set: { versionNo: 9 } },
      { $set: { issuedBy: new mongoose.Types.ObjectId() } },
      { $set: { issuedByName: "Somebody else" } },
      { $set: { issuedAt: new Date("2000-01-01") } },
      { $set: { retiredOperationOverrides: [] } },
      { $set: { state: "WITHDRAWN" } },
      { $push: { history: { eventId: "forged", type: "RELEASE_ISSUED", at: new Date(), versionNo: 1 } } },
      { $set: { somethingAddedLater: true } },
      { $unset: { note: "" } },
    ]) {
      for (const write of [
        () => IeRelease.updateOne({ _id: id }, update),
        () => IeRelease.updateMany({ _id: id }, update),
        () => IeRelease.findOneAndUpdate({ _id: id }, update),
        () => IeRelease.updateOne({ _id: id, state: "ISSUED" }, update),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
      }
    }

    /* ── replacement, upsert and every deletion path ── */
    await expect(IeRelease.replaceOne({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    await expect(IeRelease.findOneAndReplace({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    await expect(IeRelease.updateOne({ _id: new mongoose.Types.ObjectId(), state: "ISSUED" },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } }, { upsert: true }))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });

    const doc = await IeRelease.findById(id);
    for (const run of [
      () => IeRelease.deleteOne({ _id: id }),
      () => IeRelease.deleteMany({ _id: id }),
      () => IeRelease.findOneAndDelete({ _id: id }),
      () => IeRelease.findByIdAndDelete(id),
      () => doc.deleteOne(),
      () => IeRelease.deleteMany({}),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    }

    const after = await IeRelease.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    void w;
  });

  test("the only movement is a supersession, inside a live transaction", async () => {
    const { release } = await released("Supersede");
    const id = release.releaseId;

    /* A supersession must name the state it moves from, write only its own
       fields, and run inside a transaction — it moves the head of a version
       chain, and the successor might never exist otherwise. */
    const move = { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } };
    await expect(IeRelease.updateOne({ _id: id }, move))
      .rejects.toThrow(/name .*ISSUED/i);
    await expect(IeRelease.updateOne({ _id: id, state: "ISSUED" }, move))
      .rejects.toThrow(/inside the transaction|live transaction/i);
    await expect(IeRelease.updateOne({ _id: id, state: "ISSUED" },
      { $set: { state: "SUPERSEDED", supersededByVersionNo: 2, note: "and this" } }))
      .rejects.toThrow(/cannot write note/i);
    /* And there is no other move at all. */
    await expect(IeRelease.updateOne({ _id: id, state: "ISSUED" }, { $set: { state: "WITHDRAWN" } }))
      .rejects.toThrow(/only movement a release makes/i);

    const stored = await IeRelease.findById(id).lean();
    expect(stored.state).toBe("ISSUED");
    expect(stored.supersededByVersionNo).toBeNull();
  });

  test("a superseded release is terminal and equally frozen", async () => {
    const { w, layout, body, release: first } = await released("TerminalSuperseded");
    const second = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, plannedOperatorCount: 33,
    });
    const approved = await approveStandard(w.approver, w, second.body.standard.capacityStandardId, {
      expectedRevision: second.body.standard.revision,
    });
    expect((await issue(w.approver, w, w.fileId, {
      ...body,
      capacityStandardId: approved.body.standard.capacityStandardId,
      expectedCapacityRevision: approved.body.standard.revision,
    })).status).toBe(201);

    const older = await IeRelease.findById(first.releaseId).lean();
    expect(older.state).toBe("SUPERSEDED");
    await expect(IeRelease.updateOne({ _id: first.releaseId, state: "SUPERSEDED" },
      { $set: { state: "ISSUED" } })).rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    await expect(IeRelease.updateOne({ _id: first.releaseId }, { $set: { note: "x" } }))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    await expect(IeRelease.deleteOne({ _id: first.releaseId }))
      .rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
    expect(JSON.stringify(await IeRelease.findById(first.releaseId).lean())).toBe(JSON.stringify(older));
  });
});

/* ══ 7. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("releasing hands a plan over and does nothing else", () => {
  test("no IE service imports or writes PPC, Production, a work order or a barcode", () => {
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../services/industrialEngineering");
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, name), "utf8");
      expect(src).not.toMatch(/models\/CMS_Models\/PPC/);
      expect(src).not.toMatch(/DownstreamHandoverReceipt/);
      expect(src).not.toMatch(/services\/ppc\//);
      expect(src).not.toMatch(/require\([^)]*ProductionTracking/);
      expect(src).not.toMatch(/require\([^)]*ProductionSchedule/);
      expect(src).not.toMatch(/require\([^)]*Barcode/);
      expect(src).not.toMatch(/require\([^)]*WorkingCalendar/);
      /* And no outbox, event bus or worker is IMPORTED or WRITTEN: delivery is
         a READ of the release collection, and an event that delivers nothing
         does not belong inside a transaction that guards a version chain.
         Saying so in a comment is the opposite of doing it, so the scan looks
         for requires and writes rather than for the word. */
      expect(src).not.toMatch(/require\([^)]*[Oo]utbox/);
      expect(src).not.toMatch(/require\([^)]*eventBus|require\([^)]*publisher/i);
      expect(src).not.toMatch(/[A-Za-z]*[Oo]utbox\.(create|insertMany|updateOne|findOneAndUpdate)\(/);
      for (const model of ["WorkOrder", "ProductionTracking", "ProductionSchedule"]) {
        expect(src).not.toMatch(
          new RegExp(`${model}\\.(updateOne|updateMany|findOneAndUpdate|findOneAndReplace|replaceOne|create|deleteOne)\\(`),
        );
      }
    }
  });

  test("the router gained exactly one release route, and nothing downstream", () => {
    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route)
      .filter((l) => /release/i.test(String(l.route.path)))
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    expect(paths).toEqual([
      "GET /releases/:releaseId/impact",
      "POST /style-files/:fileId/releases",
    ]);

    const all = router.stack.filter((l) => l.route).map((l) => l.route.path);
    /* 8A-iii's impact read is the ONE `impact` path here, and it only reads —
       excluded by name so a second one would still be caught. What stays absent
       is everything that would ACT on a release: an acknowledgement, a PPC
       receipt, a handover row, a withdrawal, an outbox, a delivery. */
    expect(all.filter((p) => /acknowledge|receipt|handover|impact|withdraw|outbox|deliver/i.test(p))
      .filter((p) => p !== "/releases/:releaseId/impact")).toEqual([]);
    expect(router.stack.filter((l) => l.route).flatMap((l) => Object.keys(l.route.methods)))
      .not.toContain("delete");
  });

  test("a release's payload carries no Production or people concept", async () => {
    const { release } = await released("CleanPayload");
    const wire = JSON.stringify(release);
    for (const forbidden of [
      "machineId", "serialNumber", "assetId", "maintenanceStatus",
      "employeeId", "operatorId", "operatorIdentityId", "attendance", "shiftName",
      "barcodeScans", "scanId", "workOrderId", "productionScheduleId",
      "bookedQuantity", "committedQuantity", "deliveryDate", "outboxId", "eventId2",
    ]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
    expect(release.acknowledgement).toBeNull();
    expect(release.booksCapacity).toBe(false);
    expect(release.writesProduction).toBe(false);
  });

  test("nothing outside Industrial Engineering was written", async () => {
    const { w } = await released("NoSideEffects");
    /* The aggregate's own records are untouched by the release. */
    const version = await IeBulletinVersion.findOne({ companyId: w.co._id, state: "APPROVED" }).lean();
    expect(version.revision).toBe(2);
    const layout = await IeLineLayout.findOne({ companyId: w.co._id, status: "APPROVED" }).lean();
    expect(layout.history.filter((e) => /RELEASE/.test(e.type))).toHaveLength(0);
    const standard = await IeCapacityStandard.findOne({ companyId: w.co._id, status: "APPROVED" }).lean();
    expect(standard.history.filter((e) => /RELEASE/.test(e.type))).toHaveLength(0);
    /* And exactly two IE collections grew. */
    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(await IeCommandLedger.countDocuments({})).toBe(1);
  });
});

/* ══ 8. THE THREE CORRECTIONS ═════════════════════════════════════════════ */

describe("every accepted key is bound, including a no-op's", () => {
  test("a new key for an identical aggregate writes a second ledger row and no release", async () => {
    const { w, body, release: first } = await released("NoOpBinds");
    expect(await IeCommandLedger.countDocuments({})).toBe(1);

    const secondKey = nextKey();
    const noop = await issue(w.approver, w, w.fileId, body, secondKey);
    expect(noop.status).toBe(200);
    expect(noop.body.created).toBe(false);
    expect(noop.body.release.releaseId).toBe(first.releaseId);

    /* No second release… */
    expect(await IeRelease.countDocuments({})).toBe(1);
    /* …and the key is spent, recorded as the 200 it answered with. */
    const rows = await IeCommandLedger.find({}).sort({ createdAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    const bound = rows.find((r) => r.idempotencyKey === secondKey);
    expect(bound).toBeTruthy();
    expect(bound.responseStatus).toBe(200);
    expect(bound.responseBody).toMatchObject({ success: true, created: false });
    expect(bound.responseBody.release.releaseId).toBe(first.releaseId);
    expect(String(bound.resultId)).toBe(first.releaseId);
    expect(bound.releaseVersionNo).toBe(1);
    expect(bound.aggregateFingerprint).toBe(first.aggregateFingerprint);

    /* And it replays as the no-op it was. */
    const again = await issue(w.approver, w, w.fileId, body, secondKey);
    expect(again.status).toBe(200);
    expect(again.body.release.releaseId).toBe(first.releaseId);
    expect(await IeCommandLedger.countDocuments({})).toBe(2);
  });

  test("reusing a no-op's key for a different request is refused", async () => {
    /* The hole this closes: an unbound no-op key stayed free, so a later,
       DIFFERENT request under it would have been issued as though nobody had
       used the key. */
    const { w, body } = await released("NoOpKeyReuse");
    const noopKey = nextKey();
    expect((await issue(w.approver, w, w.fileId, body, noopKey)).status).toBe(200);

    const different = await issue(w.approver, w, w.fileId,
      { ...body, note: "A different intention entirely" }, noopKey);
    expect(different.status).toBe(409);
    expect(different.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(different.body.error.details.scope).toBe("IE_RELEASE_ISSUE");
    expect(await IeRelease.countDocuments({})).toBe(1);
  });

  test("two concurrent identical requests under different keys bind both keys", async () => {
    const { w, body } = await releasable("ConcurrentTwoKeys");
    const other = await approverIn(w.co);
    const keyA = nextKey();
    const keyB = nextKey();
    const [one, two] = await Promise.all([
      issue(w.approver, w, w.fileId, body, keyA),
      issue(other, w, w.fileId, body, keyB),
    ]);
    for (const res of [one, two]) expect([200, 201]).toContain(res.status);
    expect([one, two].filter((r) => r.status === 201)).toHaveLength(1);
    expect(one.body.release.releaseId).toBe(two.body.release.releaseId);

    /* One release, one issued head — and BOTH keys spent. */
    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(await IeRelease.countDocuments({ state: "ISSUED" })).toBe(1);
    const rows = await IeCommandLedger.find({}).lean();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.idempotencyKey).sort()).toEqual([keyA, keyB].sort());
    expect(rows.map((r) => String(r.resultId))).toEqual([
      one.body.release.releaseId, one.body.release.releaseId,
    ]);
    /* Exactly one of them recorded the creation. */
    expect(rows.filter((r) => r.responseStatus === 201)).toHaveLength(1);
    expect(rows.filter((r) => r.responseStatus === 200)).toHaveLength(1);

    /* Neither key can now be reused for anything else. */
    for (const key of [keyA, keyB]) {
      const res = await issue(w.approver, w, w.fileId, { ...body, note: "Something else" }, key);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    }
  });

  test("two concurrent calls under ONE key leave one release and one ledger row", async () => {
    const { w, body } = await releasable("ConcurrentOneKey");
    const key = nextKey();
    const [one, two] = await Promise.all([
      issue(w.approver, w, w.fileId, body, key),
      issue(w.approver, w, w.fileId, body, key),
    ]);
    for (const res of [one, two]) expect([200, 201]).toContain(res.status);
    expect(one.body.release.releaseId).toBe(two.body.release.releaseId);
    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(await IeCommandLedger.countDocuments({})).toBe(1);
    const row = await IeCommandLedger.findOne({}).lean();
    expect(row.idempotencyKey).toBe(key);
    expect(row.responseStatus).toBe(201);
  });

  test("a failed no-op ledger write leaves no row for that key and no change to the release", async () => {
    const { w, body, release: first } = await released("NoOpLedgerFails");
    const before = await IeRelease.findById(first.releaseId).lean();
    const key = nextKey();

    const real = IeCommandLedger.create;
    let calls = 0;
    IeCommandLedger.create = async (...a) => {
      calls += 1;
      throw new Error("ledger write exploded");
    };
    let res;
    try {
      res = await issue(w.approver, w, w.fileId, body, key);
    } finally {
      IeCommandLedger.create = real;
    }
    expect(res.status).toBe(500);
    expect(calls).toBeGreaterThan(0);

    /* Nothing half-accepted: no row for that key, and the release untouched. */
    expect(await IeCommandLedger.countDocuments({ idempotencyKey: key })).toBe(0);
    expect(await IeCommandLedger.countDocuments({})).toBe(1);
    expect(await IeRelease.countDocuments({})).toBe(1);
    const after = await IeRelease.findById(first.releaseId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));

    /* And the key is still free, so a retry is a clean first attempt. */
    const retried = await issue(w.approver, w, w.fileId, body, key);
    expect(retried.status).toBe(200);
    expect(retried.body.release.releaseId).toBe(first.releaseId);
    expect(await IeCommandLedger.countDocuments({ idempotencyKey: key })).toBe(1);
  });

  test("a no-op fails closed where the key cannot be bound", async () => {
    /* Binding needs a durable write, so a deployment that cannot make one
       refuses the no-op exactly as it refuses an issue. Answering 200 without
       recording the key would leave it free for a different request. */
    const { w, body } = await released("NoOpNoTxn");
    __setTransactionSupport(false);
    try {
      const res = await issue(w.approver, w, w.fileId, body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe("IE_RELEASE_ATOMICITY_UNAVAILABLE");
    } finally {
      __setTransactionSupport(true);
    }
    expect(await IeCommandLedger.countDocuments({})).toBe(1);
    expect(await IeRelease.countDocuments({})).toBe(1);
  });
});

describe("the command ledger cannot be deleted by application code", () => {
  test("every deletion path is refused and the row stays byte-identical", async () => {
    const { w } = await released("LedgerUndeletable");
    const row = await IeCommandLedger.findOne({ companyId: w.co._id }).lean();
    const before = JSON.stringify(row);

    const doc = await IeCommandLedger.findById(row._id);
    for (const [what, run] of [
      ["query deleteOne", () => IeCommandLedger.deleteOne({ _id: row._id })],
      ["deleteMany", () => IeCommandLedger.deleteMany({ _id: row._id })],
      ["deleteMany over everything", () => IeCommandLedger.deleteMany({})],
      ["findOneAndDelete", () => IeCommandLedger.findOneAndDelete({ _id: row._id })],
      /* Not a hook of its own: it runs through `findOneAndDelete`, which is. */
      ["findByIdAndDelete", () => IeCommandLedger.findByIdAndDelete(row._id)],
      ["document deleteOne", () => doc.deleteOne()],
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
      expect(await IeCommandLedger.countDocuments({ _id: row._id })).toBe(1);
      void what;
    }

    const after = await IeCommandLedger.findOne({ _id: row._id }).lean();
    expect(JSON.stringify(after)).toBe(before);

    /* ── AND NORMAL EXPIRY IS UNTOUCHED ─────────────────────────────────
       The 30-day TTL is enforced by MongoDB's own background monitor, inside the
       server. It issues no Mongoose query, so none of the hooks above runs and
       none of them can interfere with it: what is refused is an application
       removing a row early, not the row eventually expiring. */
    const indexes = await IeCommandLedger.collection.indexes();
    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeTruthy();
    expect(ttl.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
    expect(ttl.key).toEqual({ createdAt: 1 });
  });
});

describe("a supersession is never a bulk write", () => {
  test("updateMany is refused even for a formally valid supersession in a live transaction", async () => {
    const { release } = await released("NoBulk");
    const id = release.releaseId;
    const before = await IeRelease.findById(id).lean();

    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      expect(session.inTransaction()).toBe(true);
      /* Everything the single-document path would need: the state it moves from,
         only the permitted fields, and a live transaction. Refused anyway,
         because a bulk write cannot have proved WHICH release it is moving or
         that there was only one. */
      await expect(IeRelease.updateMany(
        { _id: id, state: "ISSUED" },
        { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } },
        { session },
      )).rejects.toThrow(/never changed in bulk/i);
      /* And with no filter at all, which is the case that would take a whole
         company's release lines with it. */
      await expect(IeRelease.updateMany(
        { state: "ISSUED" },
        { $set: { state: "SUPERSEDED", supersededByVersionNo: 2 } },
        { session },
      )).rejects.toMatchObject({ code: "IE_RELEASE_IMMUTABLE" });
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    const after = await IeRelease.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.state).toBe("ISSUED");
  });

  test("the service still supersedes exactly one predecessor and leaves one head", async () => {
    /* The other half: narrowing the permitted path must not have broken it. */
    const { w, layout, body, release: first } = await released("StillSupersedes");

    const versions = [];
    for (const operators of [30, 31]) {
      const made = await makeStandard(w.maker, w, layout.layoutId, {
        ...INPUTS, plannedOperatorCount: operators,
      });
      const approved = await approveStandard(w.approver, w, made.body.standard.capacityStandardId, {
        expectedRevision: made.body.standard.revision,
      });
      expect(approved.status).toBe(200);
      const res = await issue(w.approver, w, w.fileId, {
        ...body,
        capacityStandardId: approved.body.standard.capacityStandardId,
        expectedCapacityRevision: approved.body.standard.revision,
      });
      expect(res.status).toBe(201);
      versions.push(res.body.release);
    }
    expect(versions.map((v) => v.versionNo)).toEqual([2, 3]);

    const all = await IeRelease.find({ companyId: w.co._id }).sort({ versionNo: 1 }).lean();
    expect(all.map((r) => r.state)).toEqual(["SUPERSEDED", "SUPERSEDED", "ISSUED"]);
    /* Each names only its own immediate successor — never the newest. */
    expect(all[0].supersededByVersionNo).toBe(2);
    expect(all[1].supersededByVersionNo).toBe(3);
    expect(all[2].supersededByVersionNo).toBeNull();
    /* And each supersession event is about the version it is written on. */
    expect(all[0].history.at(-1)).toMatchObject({ type: "RELEASE_SUPERSEDED", versionNo: 1 });
    expect(all[1].history.at(-1)).toMatchObject({ type: "RELEASE_SUPERSEDED", versionNo: 2 });
    expect(all[0].history.filter((e) => e.type === "RELEASE_SUPERSEDED")).toHaveLength(1);
    expect(await IeRelease.countDocuments({ state: "ISSUED" })).toBe(1);
    void first;
  });
});

describe("a caller that loses the race still has its key bound", () => {
  test("the loser is retried and bound to the winner, not answered from the catch", async () => {
    /* ── FORCING THE WINDOW ───────────────────────────────────────────────
       The race-loss path is reached only when two transactions BOTH get past
       the identical-aggregate check and one then loses the unique index. That
       window is real but narrow, so it is forced here rather than hoped for:
       version 1 is issued, and the in-transaction identical check is made to
       miss exactly once — which is precisely what the losing transaction sees,
       because the winner had not committed when it read.

       The aggregate index then refuses its insert, the catch retries, the retry
       sees the winner, and the loser's own key is bound to it with a 200. A
       catch that answered directly would leave that key free. */
    const { w, body, release: first } = await released("RaceLoser");
    const realFindOne = IeRelease.findOne.bind(IeRelease);
    let suppressed = 0;
    IeRelease.findOne = function patched(filter, ...rest) {
      /* Both identical-aggregate reads miss — the one before the transaction and
         the one inside it — which is exactly what the losing caller saw. The
         transaction then reaches the insert and the aggregate unique index
         refuses it. The RETRY's read is not suppressed, so it sees the winner. */
      if (filter && filter.aggregateFingerprint && filter.state === "ISSUED" && suppressed < 2) {
        suppressed += 1;
        return realFindOne({ _id: new mongoose.Types.ObjectId() }, ...rest);
      }
      return realFindOne(filter, ...rest);
    };

    const loserKey = nextKey();
    let res;
    try {
      res = await issue(w.approver, w, w.fileId, body, loserKey);
    } finally {
      IeRelease.findOne = realFindOne;
    }

    /* It lost, and was answered with the winner. */
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.release.releaseId).toBe(first.releaseId);
    expect(suppressed).toBe(2);

    /* One release still — the loser's insert was refused and rolled back. */
    expect(await IeRelease.countDocuments({})).toBe(1);
    expect(await IeRelease.countDocuments({ state: "ISSUED" })).toBe(1);

    /* And the loser's key is SPENT, bound to the winner. */
    const bound = await IeCommandLedger.findOne({ idempotencyKey: loserKey }).lean();
    expect(bound).toBeTruthy();
    expect(bound.responseStatus).toBe(200);
    expect(String(bound.resultId)).toBe(first.releaseId);
    expect(await IeCommandLedger.countDocuments({})).toBe(2);

    /* So it cannot be reused for anything else. */
    const reused = await issue(w.approver, w, w.fileId, { ...body, note: "Something else" }, loserKey);
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});
