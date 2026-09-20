// test/industrial-engineering/ie-capacity-standard.route.test.js
//
// IE CHUNK 7A — DRAFT CAPACITY STANDARDS AND DETERMINISTIC TARGETS, AT THE WIRE.
//
// A capacity standard is quoted, planned against and argued about weeks after
// it was computed, so the claims worth holding are the ones that keep it
// honest that long:
//
//   · the garment SAM is SUMMED BY THE SERVER off the layout's frozen approved
//     standard times, and a client that sends one is refused by name;
//   · every source fact — layout revision, fingerprint, bulletin revision,
//     digests — is frozen at creation and never re-read;
//   · the arithmetic is exact: nothing is rounded on the way through, the
//     decimal truth is rounded once by a stated policy, and the whole-piece
//     targets are FLOORED so no target is ever inflated by arithmetic;
//   · a missing fact is a typed gap with a null figure, NEVER a zero;
//   · the working time is an explicitly labelled IE planning assumption, the
//     calendar linkage is UNKNOWN, and the readiness is PROVISIONAL because of
//     it — no Merchandising deadline calendar, Production booking document or
//     HR attendance record is borrowed to pretend otherwise;
//   · a source that moves FREEZES the record as evidence rather than rebasing
//     it;
//   · and nothing here approves, releases, publishes, books, allocates,
//     promises a date, names an employee, names a machine or touches a barcode.
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

  const operations = [];
  for (let i = 0; i < minutes.length; i += 1) {
    operations.push((await call("/operations/library", {
      method: "POST", ...t, body: { code: `OP-${i + 1}`, name: `Operation ${i + 1}`, machineType: "SNLS" },
    })).body.operation);
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

/* ══ 1. THE BOUNDARY — COMPANY, ROLE AND INDISTINGUISHABILITY ═════════════ */

describe("every capacity endpoint is company-scoped and role-gated", () => {
  test("a viewer reads and cannot write; an editor may do both", async () => {
    const { w, layout, standard } = await standing("Gate");
    const viewer = await viewerIn(w.co);

    const reads = [
      `/capacity-standards/${standard.capacityStandardId}`,
      "/capacity-standards",
      `/line-layouts/${layout.layoutId}/capacity-standards`,
    ];
    for (const path of reads) {
      const res = await call(path, { token: viewer.token, company: w.co._id });
      expect(res.status).toBe(200);
    }

    const writes = [
      ["POST", `/line-layouts/${layout.layoutId}/capacity-standards`, INPUTS],
      ["PATCH", `/capacity-standards/${standard.capacityStandardId}`, { expectedRevision: 1, plannedOperatorCount: 30 }],
    ];
    for (const [method, path, body] of writes) {
      const res = await call(path, { method, body, token: viewer.token, company: w.co._id });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    }
  });

  test("another company's standard is indistinguishable from a missing one", async () => {
    const mine = await standing("Mine");
    const theirs = await world("Theirs");
    const outsider = await editorIn(theirs.co);
    const t = { token: outsider.token, company: theirs.co._id };
    const id = mine.standard.capacityStandardId;

    const read = await call(`/capacity-standards/${id}`, t);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("IE_CAPACITY_STANDARD_NOT_FOUND");

    /* Absent, foreign and malformed all answer identically — byte for byte. */
    const ghost = await call(`/capacity-standards/${new mongoose.Types.ObjectId()}`, t);
    const rubbish = await call("/capacity-standards/not-an-id", t);
    for (const other of [ghost, rubbish]) {
      expect(other.status).toBe(read.status);
      expect(other.body.error.code).toBe(read.body.error.code);
      expect(other.body.error.message).toBe(read.body.error.message);
    }

    const edited = await call(`/capacity-standards/${id}`, {
      method: "PATCH", body: { expectedRevision: 1, plannedOperatorCount: 9 }, ...t,
    });
    expect(edited.status).toBe(404);
    expect(edited.body.error.code).toBe("IE_CAPACITY_STANDARD_NOT_FOUND");

    /* And it appears in nobody else's list or count. */
    const list = await listStandards(outsider, theirs);
    expect(list.body.standards).toEqual([]);
    expect(await IeCapacityStandard.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });

  test("opening a standard on another company's layout is refused as a missing layout", async () => {
    const mine = await world("CapMine");
    const theirs = await world("CapTheirs");
    const foreign = await arranged(theirs);
    const outsider = await editorIn(mine.co);

    const res = await call(`/line-layouts/${foreign.layoutId}/capacity-standards`, {
      method: "POST", token: outsider.token, company: mine.co._id, body: INPUTS,
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("IE_LINE_LAYOUT_NOT_FOUND");

    const ghost = await call(`/line-layouts/${new mongoose.Types.ObjectId()}/capacity-standards`, {
      method: "POST", token: outsider.token, company: mine.co._id, body: INPUTS,
    });
    expect(ghost.status).toBe(res.status);
    expect(ghost.body.error.message).toBe(res.body.error.message);
    expect(await IeCapacityStandard.countDocuments({ companyId: mine.co._id })).toBe(0);
  });
});

/* ══ 2. THE REQUEST ALLOWLIST ═════════════════════════════════════════════ */

describe("the request accepts planning inputs and nothing else", () => {
  test("a derived figure, a frozen source fact or a calculated target is refused by name", async () => {
    const { w, layout, standard } = await standing("Allow");
    const refusable = [
      /* the SAM and the source */
      { garmentSamMinutes: 3 },
      { samMinutes: 3 },
      { standardTimeMinutes: 3 },
      { lineLayoutRevision: 1 },
      { bulletinRevision: 1 },
      { sourceFingerprint: "deadbeef" },
      { layoutFingerprint: "deadbeef" },
      { approvalDigest: "x" },
      { sourceRows: [] },
      /* the calculation */
      { targetPiecesPerHour: 9999 },
      { theoreticalPiecesPerShift: 9999 },
      { wholePieceDailyTarget: 9999 },
      { netMinutesPerShift: 1 },
      { targetOutput: 9999 },
      { readiness: "READY" },
      /* identity and lifecycle */
      { companyId: String(w.co._id) },
      { capacityStandardId: String(new mongoose.Types.ObjectId()) },
      { revision: 5 },
      { status: "DRAFT" },
      { history: [] },
      { lineLayoutId: layout.layoutId },
      { styleFileId: w.fileId },
      /* machines, people, Production, approval */
      { machineId: String(new mongoose.Types.ObjectId()) },
      { serialNumber: "SN-4471" },
      { machineCapacity: 120 },
      { availability: "AVAILABLE" },
      { employeeId: "GR0067" },
      { operatorId: "GR0067" },
      { operators: ["GR0067"] },
      { attendance: [] },
      { shiftName: "General Shift" },
      { barcodeId: "WO-abc-1" },
      { scanId: "s1" },
      { workOrderId: String(w.workOrder._id) },
      { allocation: {} },
      { bookedQuantity: 100 },
      { deliveryDate: "2026-11-01" },
      { approvedAt: "2026-10-01" },
      { releasedAt: "2026-10-01" },
      { acknowledgedAt: "2026-10-01" },
      /* and the calendar shape nothing proves yet */
      { calendarId: String(new mongoose.Types.ObjectId()) },
      { calendarVersionNo: 2 },
    ];

    for (const extra of refusable) {
      const created = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, ...extra });
      expect(created.status).toBe(400);
      expect(created.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(created.body.error.details.field).toBe(Object.keys(extra)[0]);

      const edited = await patchStandard(w.maker, w, standard.capacityStandardId, {
        expectedRevision: standard.revision, ...extra,
      });
      expect(edited.status).toBe(400);
      expect(edited.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }

    /* Nothing was written by any of them. */
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(1);
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.revision).toBe(1);
  });

  test("an edit without expectedRevision is refused before anything is read", async () => {
    const { w, standard } = await standing("NeedRevision");
    const res = await patchStandard(w.maker, w, standard.capacityStandardId, { plannedOperatorCount: 30 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION");
    expect(res.body.error.details.fieldErrors[0]).toMatchObject({
      field: "expectedRevision", code: "REQUIRED",
    });
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).revision).toBe(1);
  });
});

/* ══ 3. THE SERVER-DERIVED SAM AND FROZEN PROVENANCE ══════════════════════ */

describe("the garment SAM and the source are the server's, not the caller's", () => {
  test("the SAM is summed off the layout's frozen approved standard times", async () => {
    const { w, layout, standard } = await standing("Sam");
    /* [1, 1.2, 0.8, 1.5] — a sum a client never sent. */
    expect(w.garmentSam).toBeCloseTo(4.5, 10);
    expect(standard.source.garmentSamMinutes).toBe(4.5);
    expect(standard.source.samRowCount).toBe(4);
    expect(standard.source.samDerivation)
      .toBe("SUM_OF_FROZEN_LAYOUT_SOURCE_ROW_APPROVED_STANDARD_TIMES");

    /* And it is exactly the layout's own frozen rows, summed. */
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(garmentSamFor(stored.sourceRows).garmentSamMinutes).toBe(standard.source.garmentSamMinutes);
  });

  test("the exact layout revision, fingerprint, bulletin revision and digests are frozen", async () => {
    const { w, layout, standard } = await standing("Provenance");
    const stored = await IeLineLayout.findById(layout.layoutId).lean();

    expect(standard.lineLayoutId).toBe(layout.layoutId);
    expect(standard.styleFileId).toBe(w.fileId);
    expect(standard.source.lineLayoutRevision).toBe(layout.revision);
    expect(standard.source.layoutFingerprint).toBe(stored.sourceFingerprint);
    expect(standard.source.bulletinRevision).toBe(layout.source.bulletinRevision);
    expect(standard.source.approvalDigest).toBe(stored.sourceApprovalDigest);
    expect(standard.source.requirementDigest).toBe(stored.sourceRequirementDigest);
    expect(standard.source.capturedAt).toBeTruthy();
    expect(standard.status).toBe("DRAFT");
    expect(standard.revision).toBe(1);

    /* Stored, not merely published. */
    const doc = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(doc.source.layoutFingerprint).toBe(stored.sourceFingerprint);
    expect(doc.source.garmentSamMinutes).toBe(4.5);
    expect(String(doc.companyId)).toBe(String(w.co._id));
  });

  test("rearranging the layout freezes the standard, and moves none of its evidence", async () => {
    /* REVERSED after review. This assertion used to hold that a rearrangement
       left the standard current and editable, on the grounds that the bulletin
       and the approved times had not moved. That contradicts the contract: a
       capacity standard is tied to one exact LINE CONFIGURATION, and a target
       calculated for two stations is not a target for one. */
    const { w, layout, standard } = await standing("Frozen");
    const rows = layout.source.rows;
    const moved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [{
        label: "One line", plannedMachineTypes: [{ machineType: "SNLS", quantity: 3 }],
        assignments: rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(moved.status).toBe(200);
    expect(moved.body.layout.revision).toBe(layout.revision + 1);

    const after = await readStandard(w.maker, w, standard.capacityStandardId);
    /* Readable, and every frozen fact exactly where it was. */
    expect(after.status).toBe(200);
    expect(after.body.standard.source.lineLayoutRevision).toBe(layout.revision);
    expect(after.body.standard.source.garmentSamMinutes).toBe(4.5);
    expect(after.body.standard.calculation.theoreticalPiecesPerShift).toBe(1600);
    expect(after.body.standard.revision).toBe(1);
    expect(after.body.standard.history).toHaveLength(1);

    /* And plainly no longer a current standard. */
    expect(after.body.standard.source.state).toBe("SOURCE_CHANGED");
    expect(after.body.standard.source.changeReasons).toContain("LINE_LAYOUT_REVISION_CHANGED");
    expect(after.body.standard.source.currentLineLayoutRevision).toBe(layout.revision + 1);
    expect(after.body.standard.editable).toBe(false);
    expect(after.body.standard.readiness.state).toBe("BLOCKED");
  });
});

/* ══ 4. THE CALCULATION ═══════════════════════════════════════════════════ */

describe("the hourly, shift and daily figures are exact", () => {
  test("a worked example, checked against arithmetic done by hand", async () => {
    /* SAM 4.5 · shift 540 · break 60 · 25 operators · 60% · 2 shifts
         net              = 540 − 60                      = 480
         operator minutes = 480 × 25                      = 12000
         per hour         = 25 × 60 × 0.60 / 4.5          = 200
         per shift        = 12000 × 0.60 / 4.5            = 1600
         per day          = 1600 × 2                      = 3200            */
    const { standard } = await standing("Exact");
    const c = standard.calculation;
    expect(c.available).toBe(true);
    expect(c.netMinutesPerShift).toBe(480);
    expect(c.availableOperatorMinutesPerShift).toBe(12000);
    expect(c.targetPiecesPerHour).toBe(200);
    expect(c.theoreticalPiecesPerShift).toBe(1600);
    expect(c.wholePieceShiftTarget).toBe(1600);
    expect(c.theoreticalPiecesPerDay).toBe(3200);
    expect(c.wholePieceDailyTarget).toBe(3200);
    /* The units are named in the payload, so no reader has to guess. */
    expect(c.rounding).toBe("HALF_UP_4DP");
    expect(c.wholePiecePolicy).toBe("FLOOR");
    expect(standard.inputs.efficiencyUnit).toBe("PERCENT");
    expect(standard.inputs.targetEfficiencyPercent).toBe(60);
  });

  test("the whole-piece targets floor, and never round up", async () => {
    /* SAM 4.5 · net 465 · 17 operators · 71% · 2 shifts
         per shift = 465 × 17 × 0.71 / 4.5 = 1247.2333…  → 1247
         per day   = that × 2              = 2494.4666…  → 2494            */
    const { standard } = await standing("Floor", {
      availableShiftMinutes: 500, breakMinutes: 35,
      plannedOperatorCount: 17, targetEfficiencyPercent: 71, shiftsPerDay: 2,
    });
    const c = standard.calculation;
    expect(c.theoreticalPiecesPerShift).toBe(1247.2333);
    expect(c.wholePieceShiftTarget).toBe(1247);
    expect(c.theoreticalPiecesPerDay).toBe(2494.4667);
    expect(c.wholePieceDailyTarget).toBe(2494);
    /* .4667 and .2333 both round UP under HALF_UP; neither becomes a target. */
    expect(c.wholePieceDailyTarget).toBeLessThan(c.theoreticalPiecesPerDay);
    expect(c.wholePieceShiftTarget).toBeLessThan(c.theoreticalPiecesPerShift);
  });

  test("a target two thirds of the way to the next piece still floors", async () => {
    /* The case that tells FLOOR apart from ordinary rounding: .6667 rounds UP
       to 1627 under any half-up rule, and a target of 1627 is a shortfall
       invented by arithmetic. 480 × 25 × 0.61 / 4.5 = 1626.6667.              */
    const { standard } = await standing("FloorAboveHalf", {
      targetEfficiencyPercent: 61, shiftsPerDay: 1,
    });
    const c = standard.calculation;
    expect(c.theoreticalPiecesPerShift).toBe(1626.6667);
    expect(c.wholePieceShiftTarget).toBe(1626);
    expect(c.wholePieceDailyTarget).toBe(1626);
    expect(c.wholePieceShiftTarget).not.toBe(1627);
  });

  test("nothing is rounded on the way through", async () => {
    /* SAM 4.5 · net 480 · 10 operators · 55% · THREE shifts
         per shift = 480 × 10 × 0.55 / 4.5 = 586.666…    → 586
         per day   = 480 × 10 × 3 × 0.55 / 4.5 = 1760 exactly

       The day is 1760 and not 1758. Deriving the day from the FLOORED shift
       target — the obvious shortcut — loses two whole pieces a day to
       arithmetic nobody chose. The day has its own numerator and its own single
       division, so it does not. */
    const { standard } = await standing("NoIntermediateRounding", {
      shiftsPerDay: 3, plannedOperatorCount: 10, targetEfficiencyPercent: 55,
    });
    const c = standard.calculation;
    expect(c.theoreticalPiecesPerShift).toBe(586.6667);
    expect(c.wholePieceShiftTarget).toBe(586);
    expect(c.theoreticalPiecesPerDay).toBe(1760);
    expect(c.wholePieceDailyTarget).toBe(1760);
    expect(c.wholePieceDailyTarget).not.toBe(c.wholePieceShiftTarget * 3);
    expect(c.wholePieceDailyTarget).not.toBe(1759);
  });

  test("the hourly figure agrees with the shift figure over the shift's hours", async () => {
    const { standard } = await standing("HourAgrees");
    const c = standard.calculation;
    /* 480 net minutes is eight hours; 200 an hour is 1600 a shift. */
    expect(c.targetPiecesPerHour * (c.netMinutesPerShift / 60))
      .toBeCloseTo(c.theoreticalPiecesPerShift, 6);
  });

  test("the helper count is recorded as a requirement and changes no figure", async () => {
    /* A helper does not earn standard minutes against the garment SAM. Adding
       helpers to the operator count would inflate every target on the floor by
       a number nobody agreed to. */
    const few = await standing("HelpersFew", { plannedHelperCount: 0 });
    const many = await makeStandard(few.w.maker, few.w, few.layout.layoutId, {
      ...INPUTS, plannedHelperCount: 40,
    });
    expect(many.status).toBe(201);
    expect(many.body.standard.inputs.plannedHelperCount).toBe(40);
    expect(many.body.standard.inputs.helperUsage).toBe("INFORMATIONAL_ONLY");
    expect(many.body.standard.calculation).toEqual(few.standard.calculation);
  });

  test("the pure calculator is the same one the wire uses", async () => {
    const { standard } = await standing("PureMatch");
    expect(calculateCapacity({
      availableShiftMinutes: standard.inputs.availableShiftMinutes,
      breakMinutes: standard.inputs.breakMinutes,
      shiftsPerDay: standard.inputs.shiftsPerDay,
      plannedOperatorCount: standard.inputs.plannedOperatorCount,
      targetEfficiencyPercent: standard.inputs.targetEfficiencyPercent,
      garmentSamMinutes: standard.source.garmentSamMinutes,
    })).toEqual(standard.calculation);
  });
});

/* ══ 5. EFFICIENCY AND TIME BOUNDARIES ════════════════════════════════════ */

describe("efficiency is a percentage, greater than zero and at most 100", () => {
  test("100 is accepted and 100.01 is not", async () => {
    const w = await world("EffBounds");
    const layout = await arranged(w);

    const full = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, targetEfficiencyPercent: 100,
    });
    expect(full.status).toBe(201);
    /* 480 × 25 / 4.5 = 2666.666… pieces at a full hundred per cent. */
    expect(full.body.standard.calculation.theoreticalPiecesPerShift).toBe(2666.6667);
    expect(full.body.standard.calculation.wholePieceShiftTarget).toBe(2666);

    const over = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, targetEfficiencyPercent: 100.01,
    });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe("IE_CAPACITY_STANDARD_INPUT_INVALID");
    expect(over.body.error.details.fieldErrors[0]).toMatchObject({
      field: "targetEfficiencyPercent", code: "TOO_LARGE",
    });
  });

  test("zero and negative efficiency are refused, and a fraction is not mistaken for a percentage", async () => {
    const w = await world("EffZero");
    const layout = await arranged(w);

    for (const [value, code] of [[0, "TOO_SMALL"], [-1, "TOO_SMALL"]]) {
      const res = await makeStandard(w.maker, w, layout.layoutId, {
        ...INPUTS, targetEfficiencyPercent: value,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({
        field: "targetEfficiencyPercent", code,
      });
    }

    /* 0.6 is a legal input and means SIX TENTHS OF ONE PER CENT, not 60%.
       The field name says so and the calculation obeys it, so a caller who
       meant 60 gets a number they cannot mistake for the one they wanted. */
    const fraction = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, targetEfficiencyPercent: 0.6,
    });
    expect(fraction.status).toBe(201);
    expect(fraction.body.standard.calculation.theoreticalPiecesPerShift).toBe(16);
  });
});

describe("time and manpower inputs are checked, and never silently zeroed", () => {
  const bad = [
    [{ availableShiftMinutes: undefined }, "availableShiftMinutes", "REQUIRED"],
    [{ availableShiftMinutes: 0 }, "availableShiftMinutes", "TOO_SMALL"],
    [{ availableShiftMinutes: -60 }, "availableShiftMinutes", "TOO_SMALL"],
    [{ availableShiftMinutes: 1441 }, "availableShiftMinutes", "TOO_LARGE"],
    [{ availableShiftMinutes: "eight hours" }, "availableShiftMinutes", "NOT_A_NUMBER"],
    [{ availableShiftMinutes: null }, "availableShiftMinutes", "REQUIRED"],
    [{ breakMinutes: -5 }, "breakMinutes", "TOO_SMALL"],
    [{ breakMinutes: "lunch" }, "breakMinutes", "NOT_A_NUMBER"],
    [{ plannedOperatorCount: undefined }, "plannedOperatorCount", "REQUIRED"],
    [{ plannedOperatorCount: 0 }, "plannedOperatorCount", "TOO_SMALL"],
    [{ plannedOperatorCount: -3 }, "plannedOperatorCount", "TOO_SMALL"],
    [{ plannedOperatorCount: 12.5 }, "plannedOperatorCount", "NOT_AN_INTEGER"],
    [{ plannedHelperCount: -1 }, "plannedHelperCount", "TOO_SMALL"],
    [{ shiftsPerDay: 0 }, "shiftsPerDay", "TOO_SMALL"],
    [{ shiftsPerDay: 4 }, "shiftsPerDay", "TOO_LARGE"],
    [{ shiftsPerDay: 1.5 }, "shiftsPerDay", "NOT_AN_INTEGER"],
    [{ targetEfficiencyPercent: undefined }, "targetEfficiencyPercent", "REQUIRED"],
    [{ targetEfficiencyPercent: "sixty" }, "targetEfficiencyPercent", "NOT_A_NUMBER"],
  ];

  test("each bad number is refused with its own field and code, and writes nothing", async () => {
    const w = await world("BadNumbers");
    const layout = await arranged(w);
    for (const [override, field, code] of bad) {
      const body = { ...INPUTS, ...override };
      if (override[field] === undefined) delete body[field];
      const res = await makeStandard(w.maker, w, layout.layoutId, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_INPUT_INVALID");
      expect(res.body.error.details.fieldErrors.some((e) => e.field === field && e.code === code)).toBe(true);
    }
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a non-finite number is refused rather than coerced", async () => {
    const w = await world("NonFinite");
    const layout = await arranged(w);
    /* JSON has no Infinity, so it arrives as the string a client would send. */
    for (const value of ["Infinity", "-Infinity", "NaN"]) {
      const res = await makeStandard(w.maker, w, layout.layoutId, {
        ...INPUTS, availableShiftMinutes: value,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.fieldErrors[0].field).toBe("availableShiftMinutes");
      expect(["NOT_FINITE", "NOT_A_NUMBER"]).toContain(res.body.error.details.fieldErrors[0].code);
    }
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("contradictory time is named as a contradiction, not clamped", async () => {
    const w = await world("Contradiction");
    const layout = await arranged(w);
    for (const breakMinutes of [540, 600]) {
      const res = await makeStandard(w.maker, w, layout.layoutId, {
        ...INPUTS, availableShiftMinutes: 540, breakMinutes,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({
        field: "breakMinutes", code: "CONTRADICTS_SHIFT",
      });
    }
    /* And an effective period that ends before it begins. */
    const backwards = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, effectiveFrom: "2026-11-01", effectiveTo: "2026-10-01",
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details.fieldErrors[0]).toMatchObject({
      field: "effectiveTo", code: "BEFORE_EFFECTIVE_FROM",
    });

    const notADate = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, effectiveFrom: "the first of never",
    });
    expect(notADate.status).toBe(400);
    expect(notADate.body.error.details.fieldErrors[0]).toMatchObject({
      field: "effectiveFrom", code: "NOT_A_DATE",
    });
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("an effective period is kept as calendar dates", async () => {
    const { standard } = await standing("Effective", {
      effectiveFrom: "2026-10-01", effectiveTo: "2026-12-31",
    });
    expect(standard.inputs.effectiveFrom).toBe("2026-10-01");
    expect(standard.inputs.effectiveTo).toBe("2026-12-31");
    /* Optional: a standard with no stated period says null, not a date. */
    const { standard: open } = await standing("EffectiveOpen");
    expect(open.inputs.effectiveFrom).toBeNull();
    expect(open.inputs.effectiveTo).toBeNull();
  });
});

/* ══ 6. READINESS, GAPS AND THE CALENDAR THAT DOES NOT EXIST ══════════════ */

describe("readiness is explicit, and a missing fact is never a zero", () => {
  test("an assumed working time is PROVISIONAL, never READY", async () => {
    const { standard } = await standing("Provisional");
    expect(standard.readiness.state).toBe("PROVISIONAL");
    expect(standard.readiness.ready).toBe(false);
    expect(standard.calculation.available).toBe(true);

    const assumed = standard.readiness.gaps.find((g) => g.code === "IE_CAPACITY_WORKING_TIME_ASSUMED");
    expect(assumed).toMatchObject({
      owner: "INDUSTRIAL_ENGINEERING",
      action: "STATE_OR_SUPPLY_WORKING_TIME_CALENDAR",
      workingTimeSourceKind: "IE_PLANNING_ASSUMPTION",
      requiredUpstreamContract: "COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR",
    });
    expect(assumed.message).toMatch(/planning assumption/i);
    /* Every gap carries the four fields a screen needs. */
    for (const g of standard.readiness.gaps) {
      expect(typeof g.code).toBe("string");
      expect(typeof g.message).toBe("string");
      expect(g.owner).toBe("INDUSTRIAL_ENGINEERING");
      expect(typeof g.action).toBe("string");
    }
  });

  test("the calendar linkage is published as UNKNOWN, naming what was rejected", async () => {
    const { standard } = await standing("Linkage");
    expect(standard.calendarLinkage.state).toBe("UNKNOWN");
    expect(standard.calendarLinkage.reason).toBe("NO_COMPANY_SCOPED_WORKING_TIME_CALENDAR");
    expect(standard.calendarLinkage.rejectedSources).toEqual([
      "MERCHANDISING_WORKING_CALENDAR_VERSION",
      "PRODUCTION_SCHEDULE",
      "HR_ATTENDANCE_SHIFT_SNAPSHOT",
    ]);
    expect(standard.calendarLinkage.requiredUpstreamContract)
      .toBe("COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR");
    /* No calendar is cited, and the absence is null rather than a stand-in. */
    expect(standard.workingTimeSource.kind).toBe("IE_PLANNING_ASSUMPTION");
    expect(standard.workingTimeSource.calendarId).toBeNull();
    expect(standard.workingTimeSource.calendarVersionNo).toBeNull();
    expect(standard.workingTimeSource.note).toBe(INPUTS.workingTimeNote);
  });

  test("claiming a proved calendar is refused, because none exists to prove", async () => {
    const w = await world("FakeCalendar");
    const layout = await arranged(w);
    const res = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, workingTimeSourceKind: "PROVED_CALENDAR_VERSION",
    });
    expect(res.status).toBe(400);
    expect(res.body.error.details.fieldErrors[0]).toMatchObject({
      field: "workingTimeSourceKind", code: "NO_AUTHORITATIVE_CALENDAR",
    });

    const invented = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, workingTimeSourceKind: "MERCHANDISING_WORKING_CALENDAR",
    });
    expect(invented.status).toBe(400);
    expect(invented.body.error.details.fieldErrors[0]).toMatchObject({
      field: "workingTimeSourceKind", code: "INVALID",
    });
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("no approved standard time means an unknown target, not a target of zero", async () => {
    /* Chunk 6A refuses to open a layout at all while a bulletin row has no
       approved standard time, so the capacity chunk inherits that boundary:
       there is no door through which an unproved SAM can enter. */
    const w = await world("NoSam", { approveAll: false, minutes: [1, 1.2] });
    const opened = await openLayout(w.maker, w);
    expect(opened.status).toBe(409);
    /* CHUNK 7C2: caught one step earlier — such a bulletin cannot be approved
       as a version, so the file has none to balance a line against. */
    expect(opened.body.error.code).toBe("IE_LAYOUT_BULLETIN_NOT_APPROVED");

    /* A record whose frozen evidence cannot prove a SAM — what a layout from
       before this boundary existed would look like — still reads honestly.
       Written straight to the collection, because no endpoint can make one. */
    const sound = await standing("NoSamRead");
    const unproved = await IeCapacityStandard.create({
      companyId: sound.w.co._id,
      ieStyleFileId: sound.w.fileId,
      lineLayoutId: sound.layout.layoutId,
      source: {
        lineLayoutRevision: sound.layout.revision,
        layoutFingerprint: sound.standard.source.layoutFingerprint,
        bulletinRevision: sound.standard.source.bulletinRevision,
        garmentSamMinutes: 0, samRowCount: 0,
        samDerivation: "SUM_OF_FROZEN_LAYOUT_SOURCE_ROW_APPROVED_STANDARD_TIMES",
        layoutReady: true, layoutGapCodes: [], capturedAt: new Date(),
      },
      workingTime: {
        availableShiftMinutes: 540, breakMinutes: 60, shiftsPerDay: 2,
        source: { kind: "IE_PLANNING_ASSUMPTION" },
      },
      manpower: { plannedOperatorCount: 25, plannedHelperCount: 0 },
      targetEfficiencyPercent: 60,
      history: [],
    });

    const res = await readStandard(sound.w.maker, sound.w, String(unproved._id));
    expect(res.status).toBe(200);
    const c = res.body.standard.calculation;

    /* Every derived figure is NULL — never 0, which would read as "this line
       makes nothing" rather than "nobody has approved a standard time". */
    expect(c.available).toBe(false);
    expect(c.targetPiecesPerHour).toBeNull();
    expect(c.theoreticalPiecesPerShift).toBeNull();
    expect(c.wholePieceShiftTarget).toBeNull();
    expect(c.theoreticalPiecesPerDay).toBeNull();
    expect(c.wholePieceDailyTarget).toBeNull();
    expect(c.unavailableReasons).toContain("NO_GARMENT_SAM");
    /* The net time it COULD prove is still stated — an unprovable SAM does not
       blank out the facts that are known. */
    expect(c.netMinutesPerShift).toBe(480);

    expect(res.body.standard.readiness.state).toBe("BLOCKED");
    const sam = res.body.standard.readiness.gaps.find((g) => g.code === "IE_CAPACITY_NO_GARMENT_SAM");
    expect(sam).toMatchObject({ owner: "INDUSTRIAL_ENGINEERING", action: "APPROVE_STANDARD_TIMES", samRowCount: 0 });
    expect(sam.message).toMatch(/unknown, not zero/i);
  });

  test("a layout with no stations blocks the standard, and its gaps stay visible", async () => {
    const w = await world("NoStations");
    const opened = await openLayout(w.maker, w);
    const layout = opened.body.layout;
    expect(layout.stations).toEqual([]);

    const res = await makeStandard(w.maker, w, layout.layoutId, INPUTS);
    expect(res.status).toBe(201);
    const s = res.body.standard;

    /* The SAM is provable — the garment's standard times do not depend on how
       far the line planner has got — so the arithmetic still produces a figure. */
    expect(s.source.garmentSamMinutes).toBe(4.5);
    expect(s.calculation.available).toBe(true);
    /* But the layout could not be relied on, so the verdict is BLOCKED. */
    expect(s.readiness.state).toBe("BLOCKED");
    expect(s.readiness.gaps.map((g) => g.code)).toContain("IE_CAPACITY_LAYOUT_NOT_READY");
    expect(s.source.layoutReadyAtCapture).toBe(false);
    expect(s.source.layoutGapCodesAtCapture).toEqual(
      expect.arrayContaining(["IE_LAYOUT_NO_STATIONS", "IE_LAYOUT_ROWS_UNASSIGNED"]),
    );
  });

  test("machine compatibility gaps from the layout stay visible and are not restated", async () => {
    /* One station plans OVERLOCK while its operations require SNLS. Chunk 6B
       decides that; Chunk 7A carries the verdict and invents no throughput. */
    const w = await world("Compat", {
      machineRequirements: [
        [{ machineType: "SNLS", quantity: 1 }], [{ machineType: "SNLS", quantity: 1 }],
        [{ machineType: "SNLS", quantity: 1 }], [{ machineType: "SNLS", quantity: 1 }],
      ],
    });
    const opened = await openLayout(w.maker, w);
    const layout = opened.body.layout;
    const rows = layout.source.rows;
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [{
        label: "Wrong machines",
        plannedMachineTypes: [{ machineType: "OVERLOCK", quantity: 2 }],
        assignments: rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(saved.status).toBe(200);
    const layoutGaps = saved.body.layout.readiness.gaps.map((g) => g.code);

    const res = await makeStandard(w.maker, w, saved.body.layout.layoutId, INPUTS);
    expect(res.status).toBe(201);
    const s = res.body.standard;

    expect(s.source.layoutGapCodesAtCapture).toEqual(expect.arrayContaining(layoutGaps));
    const carried = s.readiness.gaps.find((g) => g.code === "IE_CAPACITY_LAYOUT_GAPS_CARRIED");
    expect(carried.layoutGapCodes).toEqual(
      expect.arrayContaining(["IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE"]),
    );
    expect(carried.lineLayoutId).toBe(saved.body.layout.layoutId);
    /* Carried, not blocking: the arithmetic is still sound. */
    expect(s.readiness.state).toBe("PROVISIONAL");

    /* And no machine throughput or availability was invented to go with it. */
    const wire = JSON.stringify(s);
    expect(wire).not.toMatch(/machineThroughput|machineCapacity|availabilityPercent|piecesPerMachine/);
  });

  test("READY is unreachable while the working time is assumed", async () => {
    /* The one honest limitation of Chunk 7A, pinned: not one record this chunk
       can write may claim to be READY. */
    const { w, layout } = await standing("NeverReady");
    const another = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, availableShiftMinutes: 480, breakMinutes: 0, shiftsPerDay: 1,
    });
    const list = await listStandards(w.maker, w);
    expect(list.body.standards.length).toBeGreaterThanOrEqual(2);
    for (const s of list.body.standards) {
      expect(s.readiness.state).not.toBe("READY");
      expect(s.readiness.ready).toBe(false);
    }
    expect(another.body.standard.readiness.state).toBe("PROVISIONAL");
  });
});

/* ══ 7. WRITE BEHAVIOUR ═══════════════════════════════════════════════════ */

describe("editing moves one revision, or nothing at all", () => {
  test("a real edit recalculates, names the changed input groups and appends one event", async () => {
    const { w, standard } = await standing("RealEdit");
    expect(standard.calculation.theoreticalPiecesPerShift).toBe(1600);

    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      plannedOperatorCount: 30, targetEfficiencyPercent: 80,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.standard.revision).toBe(2);

    /* 480 × 30 × 0.80 / 4.5 = 2560 a shift, 5120 a day. */
    expect(res.body.standard.calculation.theoreticalPiecesPerShift).toBe(2560);
    expect(res.body.standard.calculation.theoreticalPiecesPerDay).toBe(5120);

    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "CAPACITY_STANDARD_EDITED", standardRevision: 2,
    });
    /* Input GROUPS, never a field-by-field diff and never an approval. */
    expect(res.body.events[0].changed.sort()).toEqual(["efficiency", "manpower"]);
    expect(res.body.events[0].summary).toBe("Changed manpower, efficiency");

    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.history).toHaveLength(2);
    expect(stored.history.map((e) => e.type))
      .toEqual(["CAPACITY_STANDARD_CREATED", "CAPACITY_STANDARD_EDITED"]);
    /* The frozen source did not move with the edit. */
    expect(stored.source.garmentSamMinutes).toBe(4.5);
    expect(stored.source.lineLayoutRevision).toBe(standard.source.lineLayoutRevision);
  });

  test("identical normalised input is an honest no-op", async () => {
    const { w, standard } = await standing("NoOp");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    /* The same values, some as strings and with untidy whitespace in the note —
       normalisation happens before the comparison, so this is not a change. */
    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      availableShiftMinutes: "540",
      breakMinutes: 60,
      plannedOperatorCount: "25",
      targetEfficiencyPercent: 60,
      workingTimeNote: `  ${INPUTS.workingTimeNote}  `,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    expect(res.body.standard.revision).toBe(1);

    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
  });

  test("a stale request conflicts even when its outcome would be a no-op", async () => {
    const { w, standard } = await standing("StaleNoOp");
    const moved = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 30,
    });
    expect(moved.status).toBe(200);
    const now = moved.body.standard.revision;

    /* Sending back exactly what is stored NOW, at the OLD revision. The
       outcome would have been "nothing changed"; the answer is a conflict,
       because the caller decided from a state that no longer exists. */
    const stale = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 30,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_CAPACITY_STANDARD_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: standard.revision, actual: now });

    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.revision).toBe(now);
    expect(stored.history).toHaveLength(2);
  });

  test("two simultaneous edits produce exactly one winner", async () => {
    const { w, standard } = await standing("Race");
    const [one, two] = await Promise.all([
      patchStandard(w.maker, w, standard.capacityStandardId, {
        expectedRevision: standard.revision, plannedOperatorCount: 30,
      }),
      patchStandard(w.maker, w, standard.capacityStandardId, {
        expectedRevision: standard.revision, targetEfficiencyPercent: 85,
      }),
    ]);

    const winners = [one, two].filter((r) => r.status === 200 && r.body.updated === true);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("IE_CAPACITY_STANDARD_REVISION_CONFLICT");
    expect(loser.body.error.details).toMatchObject({
      expected: standard.revision, actual: standard.revision + 1,
    });

    /* One increment, one event, and no mixture of the two edits. */
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.revision).toBe(standard.revision + 1);
    expect(stored.history.filter((e) => e.type === "CAPACITY_STANDARD_EDITED")).toHaveLength(1);
    const wonOperators = stored.manpower.plannedOperatorCount === 30;
    expect(wonOperators
      ? stored.targetEfficiencyPercent === 60
      : stored.manpower.plannedOperatorCount === 25 && stored.targetEfficiencyPercent === 85).toBe(true);
  });

  test("the audit trail is bounded and never grows without limit", async () => {
    const { w, standard } = await standing("Bounded");
    const cap = IeCapacityStandard.LIMITS.HISTORY;
    expect(cap).toBe(200);

    /* Enough real edits to pass the bound comfortably, alternating so each one
       genuinely changes something. */
    let revision = standard.revision;
    for (let i = 0; i < 12; i += 1) {
      const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
        expectedRevision: revision, plannedOperatorCount: 25 + (i % 2) + 1,
      });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
      revision = res.body.standard.revision;
    }
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.history).toHaveLength(13);
    expect(stored.history.length).toBeLessThanOrEqual(cap);
    /* Newest first on the wire, and each entry names its own revision. */
    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.history[0].standardRevision).toBe(revision);
    expect(read.body.standard.history).toHaveLength(13);
    /* Not one of them is an approval, a release or a publication. */
    for (const e of read.body.standard.history) {
      expect(["CAPACITY_STANDARD_CREATED", "CAPACITY_STANDARD_EDITED"]).toContain(e.type);
    }
  });
});

/* ══ 8. A SOURCE THAT MOVES FREEZES THE RECORD ════════════════════════════ */

describe("a moved source freezes the standard as evidence", () => {
  test("editing is refused with a typed source-changed error, and nothing is rebased", async () => {
    const { w, layout, standard } = await standing("SourceMoved");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    /* A newer method study, approved. The bulletin does not move, but the
       approved standard behind row 0 does — which is a different source. */
    await moveSource(w, { minutes: 2.4 });

    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 30,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details).toMatchObject({
      lineLayoutId: layout.layoutId,
      resolution: "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE",
    });
    /* CHUNK 7C2: the reason a version-backed layout's source moved is that the
       version it balances has been superseded by a newer approved one — not
       that a study was re-approved underneath it, which no longer reaches it. */
    expect(res.body.error.details.reasons).toContain("BULLETIN_VERSION_SUPERSEDED");

    /* Not one byte moved, and the frozen SAM is still the old one. */
    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
    expect(after.source.garmentSamMinutes).toBe(4.5);
    expect(after.manpower.plannedOperatorCount).toBe(25);
  });

  test("the frozen record still reads, and says it is no longer current", async () => {
    const { w, standard } = await standing("SourceMovedRead");
    await moveSource(w, { minutes: 2.4 });

    const res = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(res.status).toBe(200);
    const s = res.body.standard;

    /* The evidence is intact and unrebased… */
    expect(s.source.garmentSamMinutes).toBe(4.5);
    expect(s.calculation.theoreticalPiecesPerShift).toBe(1600);
    /* …and the record says plainly that it is evidence, not a current standard. */
    expect(s.source.state).toBe("SOURCE_CHANGED");
    expect(s.source.changeReasons).toContain("BULLETIN_VERSION_SUPERSEDED");
    expect(s.editable).toBe(false);
    expect(s.readiness.state).toBe("BLOCKED");
    const moved = s.readiness.gaps.find((g) => g.code === "IE_CAPACITY_SOURCE_CHANGED");
    expect(moved).toMatchObject({ action: "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE" });
  });

  test("a new standard is created from the new exact source, and both survive", async () => {
    const { w, layout, standard } = await standing("Reopen");
    await moveSource(w, { minutes: 2.4 });

    /* The old layout is superseded too, so a standard cannot be opened on it. */
    const onOld = await makeStandard(w.maker, w, layout.layoutId, INPUTS);
    expect(onOld.status).toBe(409);
    expect(onOld.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");

    /* A layout for the CURRENT source, and a standard on that. */
    const fresh = await arranged(w);
    expect(fresh.layoutId).not.toBe(layout.layoutId);
    const made = await makeStandard(w.maker, w, fresh.layoutId, INPUTS);
    expect(made.status).toBe(201);

    /* Row 0 moved from 1.0 to 2.4 minutes, so the garment SAM is 4.5 + 1.4. */
    expect(made.body.standard.source.garmentSamMinutes).toBe(5.9);
    expect(made.body.standard.source.lineLayoutRevision).toBe(fresh.revision);
    expect(made.body.standard.calculation.theoreticalPiecesPerShift)
      .toBe(Number(((480 * 25 * 0.6) / 5.9).toFixed(4)));

    /* And the old one is still there, still saying what it said. */
    const old = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(old.status).toBe(200);
    expect(old.body.standard.source.garmentSamMinutes).toBe(4.5);
    expect(old.body.standard.calculation.theoreticalPiecesPerShift).toBe(1600);
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(2);
  });
});

/* ══ 9. THE LIST, AND THE VERBS THAT DO NOT EXIST ═════════════════════════ */

describe("the list is company-scoped and bounded", () => {
  test("it pages newest first and can be narrowed to one layout or file", async () => {
    const w = await world("List");
    const layoutA = await arranged(w);
    const first = await makeStandard(w.maker, w, layoutA.layoutId, INPUTS);
    const second = await makeStandard(w.maker, w, layoutA.layoutId, {
      ...INPUTS, plannedOperatorCount: 40,
    });
    expect(second.status).toBe(201);

    const all = await listStandards(w.maker, w);
    expect(all.status).toBe(200);
    expect(all.body.standards).toHaveLength(2);
    expect(all.body.sort).toBe("createdAt:desc,_id:desc");
    expect(all.body.standards[0].capacityStandardId).toBe(second.body.standard.capacityStandardId);

    const byLayout = await listForLayout(w.maker, w, layoutA.layoutId);
    expect(byLayout.body.standards.map((s) => s.capacityStandardId).sort()).toEqual(
      [first.body.standard.capacityStandardId, second.body.standard.capacityStandardId].sort(),
    );

    const byFile = await listStandards(w.maker, w, `?styleFileId=${w.fileId}`);
    expect(byFile.body.standards).toHaveLength(2);

    /* One page at a time, with a marker this list issued. */
    const paged = await listStandards(w.maker, w, "?limit=1");
    expect(paged.body.standards).toHaveLength(1);
    expect(paged.body.hasMore).toBe(true);
    const next = await listStandards(w.maker, w, `?limit=1&cursor=${paged.body.nextCursor}`);
    expect(next.body.standards).toHaveLength(1);
    expect(next.body.standards[0].capacityStandardId)
      .not.toBe(paged.body.standards[0].capacityStandardId);
    expect(next.body.hasMore).toBe(false);
  });

  test("a foreign or malformed filter is a truthful empty page, never somebody else's rows", async () => {
    const mine = await standing("FilterMine");
    const theirs = await standing("FilterTheirs");

    const foreign = await listStandards(mine.w.maker, mine.w, `?layoutId=${theirs.layout.layoutId}`);
    expect(foreign.status).toBe(200);
    expect(foreign.body.standards).toEqual([]);

    const rubbish = await listStandards(mine.w.maker, mine.w, "?layoutId=not-an-id");
    expect(rubbish.status).toBe(200);
    expect(rubbish.body.standards).toEqual([]);

    /* And my own list holds only mine. */
    const own = await listStandards(mine.w.maker, mine.w);
    expect(own.body.standards.map((s) => s.companyId)).toEqual([String(mine.w.co._id)]);
  });
});

describe("this chunk calculates a standard and does nothing else", () => {
  test("there is no release, publish, book, allocate or scan endpoint", async () => {
    /* CHUNK 7C3 adds `/approve`, and only that. Everything downstream of an
       accepted target — releasing it, acknowledging it, booking against it,
       reading actuals back — is still absent. */
    const { w, layout, standard } = await standing("NoVerbs");
    const id = standard.capacityStandardId;
    const absent = [
      ["POST", `/capacity-standards/${id}/submit`],
      ["POST", `/capacity-standards/${id}/release`],
      ["POST", `/capacity-standards/${id}/publish`],
      ["POST", `/capacity-standards/${id}/acknowledge`],
      ["POST", `/capacity-standards/${id}/book`],
      ["POST", `/capacity-standards/${id}/allocate`],
      ["POST", `/capacity-standards/${id}/scan`],
      ["POST", `/capacity-standards/${id}/barcode`],
      ["POST", `/capacity-standards/${id}/actuals`],
      ["DELETE", `/capacity-standards/${id}`],
      ["DELETE", `/line-layouts/${layout.layoutId}/capacity-standards`],
    ];
    for (const [method, path] of absent) {
      const res = await call(path, { method, body: {}, token: w.maker.token, company: w.co._id });
      expect(res.status).toBe(404);
      /* Not a typed refusal — there is genuinely no route to refuse from. */
      expect(res.body?.error?.code).not.toBe("IE_WRITE_FORBIDDEN");
    }
    /* The one verb that DOES exist answers as a route, not as a missing one. */
    const approve = await call(`/capacity-standards/${id}/approve`, {
      method: "POST", body: {}, token: w.approver.token, company: w.co._id,
    });
    expect(approve.status).toBe(400);
    expect(approve.body.error.details.fieldErrors[0].field).toBe("expectedRevision");
    /* Nothing was deleted by any of them. */
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("the published record states that it books and promises nothing", async () => {
    const { standard } = await standing("SaysSo");
    /* CHUNK 7C3: `canApprove` is a real answer about THIS record — a draft,
       whose source is current, bound to a line somebody has APPROVED. This
       world's layout is still a draft, so approval is not yet the relevant
       action and the flag says so rather than promising what the endpoint would
       refuse. What stays false regardless is everything downstream. */
    expect(standard.status).toBe("DRAFT");
    expect(standard.lineLayoutStatus).toBe("DRAFT");
    expect(standard.canApprove).toBe(false);
    expect(standard.approval).toBeNull();
    expect(standard.canRelease).toBe(false);
    expect(standard.booksCapacity).toBe(false);
    expect(standard.promisesDelivery).toBe(false);

    /* And no Production, machine, employee or barcode concept appears anywhere
       in the payload — not as a value, and not as a field name. */
    const wire = JSON.stringify(standard);
    for (const forbidden of [
      "machineId", "serialNumber", "assetId", "maintenanceStatus",
      "employeeId", "operatorId", "operatorIdentityId", "attendance",
      "barcodeScans", "scanId", "workOrderId", "productionScheduleId",
      "bookedQuantity", "committedQuantity", "deliveryDate",
      "approvedAt", "releasedAt", "acknowledgedAt",
    ]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });

  test("the capacity routes are the five reads and writes, plus one approval", async () => {
    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const capacityRoutes = router.stack
      .filter((l) => l.route && String(l.route.path).includes("capacity-standard"))
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    expect(capacityRoutes).toEqual([
      "GET /capacity-standards",
      "GET /capacity-standards/:capacityStandardId",
      "GET /line-layouts/:layoutId/capacity-standards",
      "PATCH /capacity-standards/:capacityStandardId",
      "POST /capacity-standards/:capacityStandardId/approve",
      "POST /line-layouts/:layoutId/capacity-standards",
    ].sort());
    /* And no capacity route releases, acknowledges, books or allocates. */
    expect(capacityRoutes.filter((p) => /release|acknowledge|publish|book|allocate|scan|barcode/i.test(p)))
      .toEqual([]);
  });
});

/* ══ 10. THE EXACT LINE CONFIGURATION ═════════════════════════════════════
 *
 * A capacity standard is tied to one exact line, not merely to the bulletin
 * behind it. Everything below moves the LAYOUT revision while leaving the
 * bulletin and the approved standard times untouched.
 */

describe("a moved line-layout revision freezes the standard", () => {
  /** Every kind of real layout save, each moving only the layout's revision. */
  const EDITS = [
    ["a station rearrangement", (layout) => ({
      stations: [{
        label: "One line", plannedMachineTypes: [{ machineType: "SNLS", quantity: 3 }],
        assignments: layout.source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    })],
    ["a changed planned machine type", (layout) => ({
      stations: layout.stations.map((s, i) => ({
        label: s.label, note: s.note,
        plannedMachineTypes: [{ machineType: "SNLS", quantity: i === 0 ? 9 : 1 }],
        assignments: s.assignments.map((a) => ({ rowId: a.rowId })),
      })),
    })],
    ["a moved assignment", (layout) => ({
      stations: [
        {
          label: layout.stations[0].label, note: layout.stations[0].note,
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 2 }],
          assignments: [{ rowId: layout.source.rows[0].rowId }],
        },
        {
          label: layout.stations[1].label, note: layout.stations[1].note,
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }],
          assignments: [
            { rowId: layout.source.rows[1].rowId },
            { rowId: layout.source.rows[2].rowId },
            { rowId: layout.source.rows[3].rowId },
          ],
        },
      ],
    })],
    ["a relabelled station", (layout) => ({
      stations: layout.stations.map((s, i) => ({
        label: i === 0 ? "Front, renamed" : s.label,
        note: i === 0 ? "A different note" : s.note,
        plannedMachineTypes: s.plannedMachineTypes.map((m) => ({ machineType: m.machineType, quantity: m.quantity })),
        assignments: s.assignments.map((a) => ({ rowId: a.rowId })),
      })),
    })],
  ];

  test.each(EDITS)("%s moves the revision and freezes the standard", async (_label, build) => {
    const { w, layout, standard } = await standing(`Config${_label.replace(/\W/g, "")}`);
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision, ...build(layout),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.layout.revision).toBe(layout.revision + 1);
    /* The bulletin and the approved evidence did NOT move — only the line did. */
    expect(saved.body.layout.source.bulletinRevision).toBe(layout.source.bulletinRevision);
    expect(saved.body.layout.source.fingerprint).toBe(layout.source.fingerprint);

    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.status).toBe(200);
    expect(read.body.standard.source.state).toBe("SOURCE_CHANGED");
    expect(read.body.standard.source.changeReasons).toEqual(["LINE_LAYOUT_REVISION_CHANGED"]);
    expect(read.body.standard.editable).toBe(false);
    expect(read.body.standard.readiness.state).toBe("BLOCKED");

    /* Not one stored byte moved. */
    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
    expect(after.source.lineLayoutRevision).toBe(before.source.lineLayoutRevision);
    expect(after.source.garmentSamMinutes).toBe(before.source.garmentSamMinutes);
  });

  test("PATCH names the bound revision N and the current revision N+1", async () => {
    const { w, layout, standard } = await standing("PatchAfterMove");
    const n = standard.source.lineLayoutRevision;

    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [{
        label: "Consolidated", plannedMachineTypes: [{ machineType: "SNLS", quantity: 3 }],
        assignments: layout.source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(saved.body.layout.revision).toBe(n + 1);

    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 30,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details).toMatchObject({
      lineLayoutId: layout.layoutId,
      boundLineLayoutRevision: n,
      currentLineLayoutRevision: n + 1,
      resolution: "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE",
    });
    expect(res.body.error.details.reasons).toContain("LINE_LAYOUT_REVISION_CHANGED");
    /* The bulletin did not move, so it is not blamed for this. */
    expect(res.body.error.details.reasons).not.toContain("BULLETIN_REVISION_CHANGED");
    expect(res.body.error.details.reasons).not.toContain("APPROVED_STANDARD_CHANGED");

    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).revision).toBe(1);
  });

  test("a new standard captures the new revision, and both survive with distinct evidence", async () => {
    const { w, layout, standard } = await standing("BothSurvive");
    const n = standard.source.lineLayoutRevision;

    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [{
        label: "Consolidated", plannedMachineTypes: [{ machineType: "SNLS", quantity: 3 }],
        assignments: layout.source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(saved.body.layout.revision).toBe(n + 1);

    /* The SAME layout, now at its new revision, takes a new standard: the
       resolution is a new standard, not a new layout, because the bulletin
       never moved. */
    const fresh = await makeStandard(w.maker, w, layout.layoutId, INPUTS);
    expect(fresh.status).toBe(201);
    expect(fresh.body.standard.source.lineLayoutRevision).toBe(n + 1);
    expect(fresh.body.standard.source.state).toBe("CURRENT");
    expect(fresh.body.standard.editable).toBe(true);
    /* Same garment, same SAM, same target — a different line configuration. */
    expect(fresh.body.standard.source.garmentSamMinutes).toBe(4.5);

    const old = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(old.status).toBe(200);
    expect(old.body.standard.source.lineLayoutRevision).toBe(n);
    expect(old.body.standard.source.state).toBe("SOURCE_CHANGED");
    expect(old.body.standard.editable).toBe(false);

    /* Two standards, two frozen revisions, one layout — and the list tells them
       apart rather than giving both the same answer. */
    const list = await listForLayout(w.maker, w, layout.layoutId);
    expect(list.body.standards).toHaveLength(2);
    const byId = new Map(list.body.standards.map((x) => [x.capacityStandardId, x]));
    expect(byId.get(fresh.body.standard.capacityStandardId).source.state).toBe("CURRENT");
    expect(byId.get(fresh.body.standard.capacityStandardId).editable).toBe(true);
    expect(byId.get(standard.capacityStandardId).source.state).toBe("SOURCE_CHANGED");
    expect(byId.get(standard.capacityStandardId).editable).toBe(false);
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(2);
  });

  test("a layout save that moves no revision freezes nothing", async () => {
    /* Chunk 6A's own no-op: saving the arrangement already stored writes
       nothing and leaves the revision where it was. Nothing downstream may
       treat that as movement. */
    const { w, layout, standard } = await standing("LayoutNoOp");
    const same = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: layout.stations.map((s) => ({
        stationId: s.stationId, label: s.label, note: s.note,
        plannedMachineTypes: s.plannedMachineTypes.map((m) => ({ machineType: m.machineType, quantity: m.quantity })),
        assignments: s.assignments.map((a) => ({ rowId: a.rowId })),
      })),
    });
    expect(same.status).toBe(200);
    expect(same.body.updated).toBe(false);
    expect(same.body.layout.revision).toBe(layout.revision);

    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.source.state).toBe("CURRENT");
    expect(read.body.standard.source.changeReasons).toEqual([]);
    expect(read.body.standard.editable).toBe(true);
    expect(read.body.standard.readiness.state).toBe("PROVISIONAL");

    /* And it still edits. */
    const edited = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 30,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.updated).toBe(true);
  });

  test("a moved bulletin and a moved line are reported as two distinct reasons", async () => {
    const { w, layout, standard } = await standing("TwoReasons");
    await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [{
        label: "Consolidated", plannedMachineTypes: [{ machineType: "SNLS", quantity: 3 }],
        assignments: layout.source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    await moveSource(w, { minutes: 2.4 });

    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.source.changeReasons).toEqual(
      expect.arrayContaining(["BULLETIN_VERSION_SUPERSEDED", "LINE_LAYOUT_REVISION_CHANGED"]),
    );
    expect(read.body.standard.editable).toBe(false);
  });
});

/* ══ 11. UNKNOWN PROVENANCE FAILS CLOSED ══════════════════════════════════ */

describe("a source nobody can resolve is never treated as current", () => {
  /** The layout gone from under a standard that still exists. */
  async function orphaned(name) {
    const { w, layout, standard } = await standing(name);
    await IeLineLayout.deleteOne({ _id: layout.layoutId });
    return { w, layout, standard };
  }

  test("reading it is blocked and non-editable, with a typed gap", async () => {
    const { w, standard } = await orphaned("Orphan");
    const res = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(res.status).toBe(200);
    const s = res.body.standard;

    /* An explicit state, never a null for a reader to interpret. */
    expect(s.source.state).toBe("SOURCE_UNAVAILABLE");
    expect(s.source.changeReasons).toEqual(["LINE_LAYOUT_UNAVAILABLE"]);
    expect(s.source.currentLineLayoutRevision).toBeNull();
    expect(s.editable).toBe(false);
    expect(s.readiness.state).toBe("BLOCKED");
    expect(s.readiness.ready).toBe(false);

    const g = s.readiness.gaps.find((x) => x.code === "IE_CAPACITY_SOURCE_UNAVAILABLE");
    expect(g).toMatchObject({
      owner: "INDUSTRIAL_ENGINEERING",
      action: "RESOLVE_SOURCE_LINE_LAYOUT",
      boundLineLayoutRevision: standard.source.lineLayoutRevision,
    });
    expect(typeof g.message).toBe("string");

    /* The frozen figures stay visible as historical evidence… */
    expect(s.source.garmentSamMinutes).toBe(4.5);
    expect(s.calculation.theoreticalPiecesPerShift).toBe(1600);
    /* …but the record does not present itself as a usable standard. */
    expect(s.readiness.state).not.toBe("PROVISIONAL");
  });

  test("a list row with a missing source is blocked and non-editable too", async () => {
    const { w, standard } = await orphaned("OrphanList");
    const list = await listStandards(w.maker, w);
    expect(list.status).toBe(200);
    expect(list.body.standards).toHaveLength(1);

    const row = list.body.standards[0];
    expect(row.capacityStandardId).toBe(standard.capacityStandardId);
    expect(row.source.state).toBe("SOURCE_UNAVAILABLE");
    expect(row.editable).toBe(false);
    expect(row.readiness.state).toBe("BLOCKED");
    expect(row.readiness.gaps.map((g) => g.code)).toContain("IE_CAPACITY_SOURCE_UNAVAILABLE");
  });

  test("editing it is refused, and nothing is written", async () => {
    const { w, standard } = await orphaned("OrphanPatch");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 30,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details.reasons).toEqual(["LINE_LAYOUT_UNAVAILABLE"]);
    /* A layout that cannot be found cannot be re-opened, so the resolution is
       not "make a new standard from it". */
    expect(res.body.error.details.resolution).toBe("RESOLVE_SOURCE_LINE_LAYOUT");

    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
  });

  test("a missing engineering file is its own reason, and equally closed", async () => {
    const { w, layout, standard } = await standing("OrphanFile");
    await IeStyleFile.deleteOne({ _id: w.fileId });

    const res = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(res.status).toBe(200);
    expect(res.body.standard.source.state).toBe("SOURCE_UNAVAILABLE");
    expect(res.body.standard.source.changeReasons).toEqual(["ENGINEERING_FILE_UNAVAILABLE"]);
    /* The layout itself is still there, so its revision is still knowable. */
    expect(res.body.standard.source.currentLineLayoutRevision).toBe(layout.revision);
    expect(res.body.standard.editable).toBe(false);
    expect(res.body.standard.readiness.state).toBe("BLOCKED");
  });

  test("an unexpected failure propagates instead of becoming a provisional answer", async () => {
    /* The distinction this contract turns on: a source that is MISSING is a
       fact, and a source resolution that BROKE is not. The second must never
       be published as the first, or an outage would silently redraw every
       capacity page as a set of ordinary provisional records. */
    const { w } = await standing("Infra");
    const svc = require("../../services/industrialEngineering/ieLineLayout.service");
    const real = svc.sourceForLayout;
    svc.sourceForLayout = async () => { throw new Error("replica set unreachable"); };
    try {
      const list = await listStandards(w.maker, w);
      expect(list.status).toBe(500);
      expect(list.body?.standards).toBeUndefined();

      const read = await readStandard(w.maker, w, (await IeCapacityStandard.findOne({
        companyId: w.co._id,
      }).lean())._id.toString());
      expect(read.status).toBe(500);
      expect(read.body?.standard).toBeUndefined();
    } finally {
      svc.sourceForLayout = real;
    }

    /* And the normal answer comes back once the failure clears. */
    const recovered = await listStandards(w.maker, w);
    expect(recovered.status).toBe(200);
    expect(recovered.body.standards[0].source.state).toBe("CURRENT");
  });

  test("an unavailable source discloses nothing about another company", async () => {
    /* A standard whose layout is now another company's — the same answer a
       deleted layout gives, byte for byte, so the state cannot be read as a
       probe for somebody else's record. */
    const mine = await standing("LeakMine");
    const theirs = await world("LeakTheirs");
    /* Fabricating a state the application cannot create, so it goes through the
       raw collection. Chunk 7C2's guard requires a layout mutation to name
       `status: "DRAFT"`, and this is not a mutation the app would ever make. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(mine.layout.layoutId)) },
      { $set: { companyId: theirs.co._id } },
    );

    const moved = await readStandard(mine.w.maker, mine.w, mine.standard.capacityStandardId);
    const deleted = await orphaned("LeakGone");
    const gone = await readStandard(deleted.w.maker, deleted.w, deleted.standard.capacityStandardId);

    expect(moved.body.standard.source.state).toBe(gone.body.standard.source.state);
    expect(moved.body.standard.source.changeReasons).toEqual(gone.body.standard.source.changeReasons);
    expect(moved.body.standard.readiness.gaps.map((g) => g.code))
      .toEqual(gone.body.standard.readiness.gaps.map((g) => g.code));
    expect(JSON.stringify(moved.body.standard)).not.toContain(String(theirs.co._id));
  });
});

/* ══ 12. EFFECTIVE DATES ARE CALENDAR DATES ═══════════════════════════════ */

describe("an effective date is a real day on the calendar", () => {
  test("ordinary dates and a genuine leap day are accepted and published unchanged", async () => {
    for (const [from, to] of [
      ["2026-10-01", "2026-12-31"],
      ["2028-02-29", "2028-03-01"],
      ["2026-01-01", "2026-01-01"],
      ["2026-12-31", "2027-01-01"],
    ]) {
      const { standard } = await standing(`Dates${from}`, { effectiveFrom: from, effectiveTo: to });
      expect(standard.inputs.effectiveFrom).toBe(from);
      expect(standard.inputs.effectiveTo).toBe(to);
    }
  });

  test("a day that is not on the calendar is refused, not rolled over", async () => {
    const w = await world("Impossible");
    const layout = await arranged(w);
    /* `new Date("2026-02-30")` does not fail — it returns the 2nd of March. A
       record that accepted it would show a date nobody typed. */
    for (const value of ["2026-02-29", "2026-02-30", "2026-02-31", "2026-04-31", "2026-06-31", "2026-13-01", "2026-00-10", "2026-01-32", "2026-01-00"]) {
      const res = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, effectiveFrom: value });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_INPUT_INVALID");
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({
        field: "effectiveFrom", code: "IMPOSSIBLE_DATE",
      });
    }
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a timestamp, a locale date and a decorated string are all refused", async () => {
    const w = await world("NotCalendar");
    const layout = await arranged(w);
    for (const value of [
      "2026-10-01T10:30:00Z",
      "2026-10-01T00:00:00.000Z",
      "2026-10-01 10:30",
      "01/10/2026",
      "10/01/2026",
      "1 October 2026",
      " 2026-10-01 ",
      "2026-1-1",
      "20261001",
      "2026-10",
      "yesterday",
      123456789,
      true,
      { year: 2026 },
      ["2026-10-01"],
    ]) {
      const res = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, effectiveTo: value });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_INPUT_INVALID");
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({
        field: "effectiveTo", code: "NOT_A_DATE",
      });
    }
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("each date field is named on its own, and the ordering rule still holds", async () => {
    const w = await world("DateFields");
    const layout = await arranged(w);

    const both = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, effectiveFrom: "2026-02-30", effectiveTo: "2026-04-31",
    });
    expect(both.status).toBe(400);
    expect(both.body.error.details.fieldErrors.map((e) => `${e.field}:${e.code}`)).toEqual([
      "effectiveFrom:IMPOSSIBLE_DATE", "effectiveTo:IMPOSSIBLE_DATE",
    ]);

    /* Preserved from before the correction. */
    const backwards = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, effectiveFrom: "2026-11-01", effectiveTo: "2026-10-01",
    });
    expect(backwards.status).toBe(400);
    expect(backwards.body.error.details.fieldErrors[0]).toMatchObject({
      field: "effectiveTo", code: "BEFORE_EFFECTIVE_FROM",
    });
  });

  test("the same rule governs an edit, and a refused date writes nothing", async () => {
    const { w, standard } = await standing("DateEdit", { effectiveFrom: "2026-10-01" });
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    for (const [value, code] of [["2027-02-29", "IMPOSSIBLE_DATE"], ["2027-03-01T00:00:00Z", "NOT_A_DATE"]]) {
      const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
        expectedRevision: standard.revision, effectiveTo: value,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({ field: "effectiveTo", code });
    }
    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());

    /* A good one still saves, and still publishes as the day it was given. */
    const ok = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, effectiveTo: "2028-02-29",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.standard.inputs.effectiveTo).toBe("2028-02-29");
    expect(ok.body.events[0].changed).toContain("effectivePeriod");
  });
});
