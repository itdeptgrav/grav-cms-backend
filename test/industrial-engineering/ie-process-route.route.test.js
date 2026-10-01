// test/industrial-engineering/ie-process-route.route.test.js
//
// PPC MULTI-STAGE, SLICE 1 — THE APPROVED PROCESS ROUTE, IE OWNER, PPC READER.
//
// IE declares which production processes a style passes through, their
// dependencies, and which optional ones do NOT apply. The route is frozen into
// the approved bulletin version, carried into each release, and published
// read-only to Planning. The claims worth holding:
//
//   · an order requiring embroidery and one not requiring it are told apart
//     from approved evidence — never from an operation's name or machine;
//   · the route's order is its own predecessors, including parallel stages,
//     and every malformed dependency is refused;
//   · a release with no declared route publishes UNKNOWN, not "no stages";
//   · an approved version and an issued release never change, and a newer
//     revision leaves the old ones — and their stage ids — intact;
//   · another company sees nothing, and the reader edits nothing.
//
// The fixture below is the release suite's own (ie-release.route.test.js),
// with one addition: a world may declare its route before submitting.
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
async function world(name, { minutes = [1, 1.2, 0.8, 1.5], approveAll = true, machineRequirements = null, route = null, names = null } = {}) {
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
      method: "POST", ...t, body: { code: names ? `EMB-${i + 1}` : `OP-${i + 1}`, name: names ? names[i] : `Operation ${i + 1}`, machineType: "SNLS" },
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
  /* ── THE PROCESS ROUTE, DECLARED BEFORE THE BULLETIN IS SUBMITTED ─────
     So the version approved below freezes it. `null` leaves it undeclared,
     which is every world written before routes existed. */
  if (route) {
    const now = await IeStyleFile.findById(file.fileId).lean();
    const declared = await call(`/engineering-files/${file.fileId}/process-route`, {
      method: "PATCH", token: maker.token, company: co._id,
      body: { expectedRevision: now.revision, stages: route },
    });
    expect(declared.status).toBe(200);
  }
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
/* ══ THE SLICE-1 SURFACE ════════════════════════════════════════════════════ */

const publication = require("../../services/industrialEngineering/releasePublication.service");

const patchRoute = (a, w, body) => call(`/engineering-files/${w.fileId}/process-route`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const fileRevisionOf = async (w) => (await IeStyleFile.findById(w.fileId).lean()).revision;

/** Planning reads with nothing but its own company. */
const asPlanning = (w) => ({ companyId: String(w.co._id) });

const WITH_EMBROIDERY = [
  { process: "CUTTING", applicability: "REQUIRED" },
  { process: "EMBROIDERY", label: "Chest logo", applicability: "REQUIRED", predecessors: [1] },
  { process: "SEWING", applicability: "REQUIRED", predecessors: [2] },
];
const WITHOUT_EMBROIDERY = [
  { process: "CUTTING", applicability: "REQUIRED" },
  { process: "EMBROIDERY", applicability: "NOT_APPLICABLE" },
  { process: "SEWING", applicability: "REQUIRED", predecessors: [1] },
];

/** Issue a release from whatever bulletin version is approved NOW. */
async function releaseCurrent(w) {
  const draft = await arranged(w);
  const approvedLayout = await approveLayout(w.approver, w, draft.layoutId, { expectedRevision: draft.revision });
  expect(approvedLayout.status).toBe(200);
  const layout = approvedLayout.body.layout;
  const made = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS });
  expect(made.status).toBe(201);
  const std = await approveStandard(w.approver, w, made.body.standard.capacityStandardId, {
    expectedRevision: made.body.standard.revision,
  });
  expect(std.status).toBe(200);
  const version = await IeBulletinVersion.findOne({ companyId: w.co._id, ieStyleFileId: w.fileId, state: "APPROVED" }).lean();
  const res = await issue(w.approver, w, w.fileId, {
    bulletinVersionId: String(version._id), expectedBulletinVersionNo: version.versionNo,
    lineLayoutId: layout.layoutId, expectedLayoutRevision: layout.revision,
    capacityStandardId: std.body.standard.capacityStandardId, expectedCapacityRevision: std.body.standard.revision,
  });
  expect(res.status).toBe(201);
  return { release: res.body.release, version };
}

const stagesOf = (route) => route.stages.map((s) => [s.process, s.applicability, s.predecessorStageIds.length]);

/* ══ 1. REQUIRED AND NOT-APPLICABLE, FROM APPROVED EVIDENCE ═══════════════ */

describe("an order's processes are told apart by the approved route", () => {
  test("an order requiring embroidery publishes cutting → embroidery → sewing", async () => {
    const w = await world("RouteEmb", { route: WITH_EMBROIDERY });
    const { release, version } = await releaseCurrent(w);

    expect(version.processRoute.stages.map((s) => s.process)).toEqual(["CUTTING", "EMBROIDERY", "SEWING"]);
    const route = await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    expect(route).toMatchObject({
      releaseId: release.releaseId, versionNo: 1, state: "ISSUED",
      bulletinVersionId: String(version._id), bulletinVersionNo: version.versionNo,
      routeState: "DECLARED",
    });
    const [cut, emb, sew] = route.stages;
    expect(stagesOf(route)).toEqual([["CUTTING", "REQUIRED", 0], ["EMBROIDERY", "REQUIRED", 1], ["SEWING", "REQUIRED", 1]]);
    expect(emb).toMatchObject({ label: "Chest logo", sequence: 2, predecessorStageIds: [cut.stageId] });
    expect(sew.predecessorStageIds).toEqual([emb.stageId]);
    for (const s of route.stages) expect(s.stageId).toMatch(/^stg_[0-9a-f]{18}$/);
  });

  test("an order not requiring embroidery says so, and sewing waits only for cutting", async () => {
    const w = await world("RouteNoEmb", { route: WITHOUT_EMBROIDERY });
    const { release } = await releaseCurrent(w);
    const route = await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    expect(route.routeState).toBe("DECLARED");
    const [cut, emb, sew] = route.stages;
    /* Present and explicitly NOT_APPLICABLE — a decision, not an omission. */
    expect(emb).toMatchObject({ process: "EMBROIDERY", applicability: "NOT_APPLICABLE", predecessorStageIds: [] });
    expect(sew.predecessorStageIds).toEqual([cut.stageId]);
  });

  test("an operation named for embroidery does not make embroidery a stage", async () => {
    const w = await world("RouteNoInference", {
      names: ["Embroider chest logo", "Embroidery trim", "Print back", "Wash & finish"],
    });
    const { release, version } = await releaseCurrent(w);
    expect(version.processRoute).toBeUndefined();
    const route = await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    expect(route).toMatchObject({ routeState: "UNKNOWN", stages: null });
  });
});

/* ══ 2. SEQUENCE AND DEPENDENCIES ══════════════════════════════════════════ */

describe("the order is the route's own", () => {
  test("parallel stages and a join are stored as declared, with stable ids on re-save", async () => {
    const w = await world("RouteParallel", { approveAll: false });
    const route = [
      { process: "CUTTING", applicability: "REQUIRED" },
      { process: "EMBROIDERY", applicability: "REQUIRED", predecessors: [1] },
      { process: "PRINTING", applicability: "REQUIRED", predecessors: [1] },
      { process: "SEWING", applicability: "REQUIRED", predecessors: [2, 3] },
      { process: "WASHING", label: "Enzyme wash", applicability: "REQUIRED", predecessors: [4] },
      { process: "OTHER", label: "Garment dye", applicability: "NOT_APPLICABLE" },
    ];
    const saved = await patchRoute(w.maker, w, { expectedRevision: await fileRevisionOf(w), stages: route });
    expect(saved.status).toBe(200);
    expect(saved.body.events[0].type).toBe("PROCESS_ROUTE_EDITED");
    const stages = saved.body.file.bulletin.processRoute.stages;
    const [cut, emb, prt, sew, wash] = stages;
    expect(emb.predecessorStageIds).toEqual([cut.stageId]);
    expect(prt.predecessorStageIds).toEqual([cut.stageId]);   // parallel with embroidery
    expect(sew.predecessorStageIds).toEqual([emb.stageId, prt.stageId]);
    expect(wash.predecessorStageIds).toEqual([sew.stageId]);

    // Re-sent by id: same ids, and an unchanged route is a no-op.
    const again = await patchRoute(w.maker, w, {
      expectedRevision: saved.body.file.revision,
      stages: stages.map((s) => ({ stageId: s.stageId, process: s.process, label: s.label,
        applicability: s.applicability, predecessors: s.predecessorStageIds })),
    });
    expect(again.status).toBe(200);
    expect(again.body.updated).toBe(false);
    expect(again.body.file.bulletin.processRoute.stages).toEqual(stages);
  });

  test("every malformed route is refused and nothing is written", async () => {
    const w = await world("RouteRefused", { approveAll: false });
    const rev = await fileRevisionOf(w);
    const refused = [
      [],
      [{ process: "CUTTING" }],                                                        // applicability unstated
      [{ process: "EMBELLISH", applicability: "REQUIRED" }],                          // unknown process
      [{ process: "SEWING", applicability: "REQUIRED", predecessors: [2] },
        { process: "CUTTING", applicability: "REQUIRED" }],                           // predecessor later
      [{ process: "CUTTING", applicability: "REQUIRED", predecessors: [1] }],          // itself
      [{ process: "EMBROIDERY", applicability: "NOT_APPLICABLE" },
        { process: "SEWING", applicability: "REQUIRED", predecessors: [1] }],         // gated by a stage that does not apply
      [{ process: "CUTTING", applicability: "REQUIRED" },
        { process: "WASHING", applicability: "NOT_APPLICABLE", predecessors: [1] }],  // non-applicable stage with predecessors
      [{ process: "WASHING", applicability: "REQUIRED" }, { process: "WASHING", applicability: "REQUIRED" }], // indistinguishable repeat
      [{ process: "OTHER", applicability: "REQUIRED" }],                               // OTHER needs a name
      [{ process: "EMBROIDERY", applicability: "NOT_APPLICABLE" }],                    // nothing required
      [{ process: "CUTTING", applicability: "REQUIRED", predecessors: ["stg_000000000000000000"] }],
      [{ stageId: "stg_000000000000000000", process: "CUTTING", applicability: "REQUIRED" }],
      [{ process: "CUTTING", applicability: "REQUIRED", startDate: "2026-10-01" }],
      [{ process: "CUTTING", applicability: "REQUIRED", machineId: "M-7" }],
      [{ process: "CUTTING", applicability: "REQUIRED", sequence: 4 }],
    ];
    for (const stages of refused) {
      const res = await patchRoute(w.maker, w, { expectedRevision: rev, stages });
      expect([res.status, stages]).toEqual([400, stages]);
    }
    const stored = await IeStyleFile.findById(w.fileId).lean();
    expect(stored.revision).toBe(rev);
    expect(stored.bulletin.processRoute).toBeUndefined();
  });

  test("a process repeated with distinct labels is two stages, keyed by id", async () => {
    const w = await world("RouteRepeat", { approveAll: false });
    const res = await patchRoute(w.maker, w, {
      expectedRevision: await fileRevisionOf(w),
      stages: [
        { process: "CUTTING", applicability: "REQUIRED" },
        { process: "FINISHING", label: "Thread trim", applicability: "REQUIRED", predecessors: [1] },
        { process: "FINISHING", label: "Press", applicability: "REQUIRED", predecessors: [2] },
      ],
    });
    expect(res.status).toBe(200);
    const [, a, b] = res.body.file.bulletin.processRoute.stages;
    expect(a.stageId).not.toBe(b.stageId);
    expect(b.predecessorStageIds).toEqual([a.stageId]);
  });

  test("a stale revision conflicts, and a route under review is frozen with the bulletin", async () => {
    const w = await world("RouteStale", { approveAll: false });
    const rev = await fileRevisionOf(w);
    const first = await patchRoute(w.maker, w, { expectedRevision: rev, stages: WITHOUT_EMBROIDERY });
    expect(first.status).toBe(200);
    const stale = await patchRoute(w.maker, w, { expectedRevision: rev, stages: WITH_EMBROIDERY });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_FILE_REVISION_CONFLICT");

    const w2 = await world("RouteFrozen", { route: WITH_EMBROIDERY });
    const now = await IeStyleFile.findById(w2.fileId).lean();
    const submitted = await call(`/engineering-files/${w2.fileId}/bulletin-versions`, {
      method: "POST", token: w2.maker.token, company: w2.co._id, body: { expectedRevision: now.revision },
    });
    expect(submitted.status).toBe(201);
    expect(submitted.body.version.processRoute.routeState).toBe("DECLARED");
    const frozen = await patchRoute(w2.maker, w2, { expectedRevision: submitted.body.file.revision, stages: WITHOUT_EMBROIDERY });
    expect(frozen.status).toBe(409);
    expect(frozen.body.error.code).toBe("IE_BULLETIN_VERSION_IN_REVIEW");
  });
});

/* ══ 3. IMMUTABLE APPROVALS, AND A REVISION THAT LEAVES THEM ALONE ═══════ */

describe("a newer route revision leaves every earlier approval intact", () => {
  test("v2 drops embroidery; v1's version and release keep it, and surviving stage ids carry over", async () => {
    const w = await world("RouteRevise", { route: WITH_EMBROIDERY });
    const first = await releaseCurrent(w);
    const v1Route = await publication.publishReleaseProcessRoute(asPlanning(w), first.release.releaseId);
    const v1VersionBefore = await IeBulletinVersion.findById(first.version._id).lean();
    const v1ReleaseBefore = await IeRelease.findById(first.release.releaseId).lean();

    // The successor draft: same stages by id, embroidery no longer applies.
    const draft = (await IeStyleFile.findById(w.fileId).lean()).bulletin.processRoute.stages;
    const [cut, emb, sew] = draft;
    const edited = await patchRoute(w.maker, w, {
      expectedRevision: await fileRevisionOf(w),
      stages: [
        { stageId: cut.stageId, process: "CUTTING", applicability: "REQUIRED" },
        { stageId: emb.stageId, process: "EMBROIDERY", label: "Chest logo", applicability: "NOT_APPLICABLE" },
        { stageId: sew.stageId, process: "SEWING", applicability: "REQUIRED", predecessors: [cut.stageId] },
      ],
    });
    expect(edited.status).toBe(200);
    await approveBulletinVersion({ co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId });
    const second = await releaseCurrent(w);
    expect(second.version.versionNo).toBe(first.version.versionNo + 1);

    const v2Route = await publication.publishReleaseProcessRoute(asPlanning(w), second.release.releaseId);
    expect(v2Route.versionNo).toBe(2);
    expect(v2Route.stages.map((s) => s.stageId)).toEqual(v1Route.stages.map((s) => s.stageId));
    expect(v2Route.stages[1].applicability).toBe("NOT_APPLICABLE");
    expect(v2Route.stages[2].predecessorStageIds).toEqual([cut.stageId]);

    // The old version and release are byte-for-byte what they were…
    const v1VersionAfter = await IeBulletinVersion.findById(first.version._id).lean();
    expect(v1VersionAfter.processRoute).toEqual(v1VersionBefore.processRoute);
    expect(v1VersionAfter.state).toBe("SUPERSEDED");
    const v1ReleaseAfter = await IeRelease.findById(first.release.releaseId).lean();
    expect(v1ReleaseAfter.source).toEqual(v1ReleaseBefore.source);
    expect(v1ReleaseAfter.aggregateFingerprint).toBe(v1ReleaseBefore.aggregateFingerprint);
    // …and a plan that froze v1 still reads v1's route, now marked superseded.
    const reread = await publication.publishReleaseProcessRoute(asPlanning(w), first.release.releaseId);
    expect(reread.stages).toEqual(v1Route.stages);
    expect(reread).toMatchObject({ state: "SUPERSEDED", supersededByVersionNo: 2 });
  });

  test("an approved version's route and an issued release's route refuse every direct write", async () => {
    const w = await world("RouteImmutable", { route: WITH_EMBROIDERY });
    const { release, version } = await releaseCurrent(w);
    await expect(IeBulletinVersion.updateOne({ _id: version._id },
      { $set: { "processRoute.stages.1.applicability": "NOT_APPLICABLE" } })).rejects.toThrow();
    await expect(IeRelease.updateOne({ _id: release.releaseId },
      { $set: { "source.processRoute.stages": [] } })).rejects.toThrow();
    const route = await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    expect(route.stages[1].applicability).toBe("REQUIRED");
  });

  test("a release with no declared route stays UNKNOWN, and its fingerprint carries no route key", async () => {
    const w = await world("RouteLegacy");
    const { release } = await releaseCurrent(w);
    const stored = await IeRelease.findById(release.releaseId).lean();
    expect("processRoute" in stored.source).toBe(false);
    const route = await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    expect(route).toMatchObject({ routeState: "UNKNOWN", stages: null, state: "ISSUED" });
  });
});

/* ══ 4. COMPANY BOUNDARY, AND A READER THAT WRITES NOTHING ════════════════ */

describe("Planning reads the route of its own company, and changes nothing", () => {
  test("another company can neither edit the draft route nor read the published one", async () => {
    const w = await world("RouteIsoMine", { route: WITH_EMBROIDERY });
    const { release } = await releaseCurrent(w);
    const theirs = await world("RouteIsoTheirs", { approveAll: false });
    const outsider = await editorIn(theirs.co);

    const edit = await call(`/engineering-files/${w.fileId}/process-route`, {
      method: "PATCH", token: outsider.token, company: theirs.co._id,
      body: { expectedRevision: 1, stages: WITHOUT_EMBROIDERY },
    });
    expect(edit.status).toBe(404);
    expect(edit.body.error.code).toBe("IE_FILE_NOT_FOUND");
    expect(await publication.publishReleaseProcessRoute(asPlanning(theirs), release.releaseId)).toBeNull();
    expect(await publication.publishReleaseProcessRoute(asPlanning(w), new mongoose.Types.ObjectId())).toBeNull();
  });

  test("a planner without an IE grant cannot declare a route; a viewer cannot either", async () => {
    const w = await world("RouteGrants", { approveAll: false });
    const planner = await actor({ companies: [w.co], grants: { ppc: "editor" } });
    const viewer = await viewerIn(w.co);
    for (const who of [planner, viewer]) {
      const res = await patchRoute(who, w, { expectedRevision: await fileRevisionOf(w), stages: WITH_EMBROIDERY });
      expect(res.status).toBe(403);
    }
  });

  test("reading the published route writes nothing and carries no fingerprint or digest", async () => {
    const w = await world("RouteReader", { route: WITH_EMBROIDERY });
    const { release, version } = await releaseCurrent(w);
    const snapshot = async () => JSON.stringify([
      await IeRelease.find({ companyId: w.co._id }).lean(),
      await IeBulletinVersion.find({ companyId: w.co._id }).lean(),
      await IeStyleFile.find({ companyId: w.co._id }).lean(),
    ]);
    const before = await snapshot();
    const route = await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    await publication.publishReleaseProcessRoute(asPlanning(w), release.releaseId);
    expect(await snapshot()).toBe(before);

    const keys = [];
    const walk = (v) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { keys.push(k); walk(x); }
    };
    walk(route);
    expect(keys.filter((k) => /fingerprint|digest|hash/i.test(k))).toEqual([]);
    expect(route.bulletinVersionId).toBe(String(version._id));
  });

  test("the route contract names no execution app, and IE reaches into none", () => {
    const fs = require("fs");
    const path = require("path");
    for (const f of [
      "services/industrialEngineering/ieProcessRoute.service.js",
      "models/CMS_Models/IndustrialEngineering/processRoute.schema.js",
    ]) {
      const src = fs.readFileSync(path.join(__dirname, "../..", f), "utf8");
      expect(src).not.toMatch(/require\([^)]*(Cutting|Embroidery|ppc\/|PPC\/|Production)/i);
    }
  });
});
