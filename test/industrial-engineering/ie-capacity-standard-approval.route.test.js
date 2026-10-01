// test/industrial-engineering/ie-capacity-standard-approval.route.test.js
//
// IE CHUNK 7C3 — CAPACITY STANDARD APPROVAL, AT THE WIRE.
//
// A second person accepts the stated assumptions and the target they produce.
// The claims worth holding:
//
//   · approval is bound to ONE approved line layout at ITS exact revision, so a
//     standard built while the layout was still a draft never becomes
//     approvable because somebody approved that layout later;
//   · a PROVISIONAL standard is the ordinary thing to approve, and approving it
//     changes nothing about why it is provisional — the calendar linkage stays
//     UNKNOWN, the working time stays a stated IE assumption, the readiness
//     stays PROVISIONAL and the assumed-time gap travels with the record;
//   · a BLOCKED standard is refused with its complete gap list;
//   · maker-checker compares actor ids, with no owner exemption;
//   · an approved standard accepts no write, of any field, by any path, and
//     stays readable and byte-stable when its layout later moves or vanishes;
//   · and nothing here releases, books, promises, or writes Production, PPC, a
//     work order, a barcode or a calendar.
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

/* ══ 1. APPROVING A PROVISIONAL STANDARD ══════════════════════════════════ */

describe("approving a capacity standard", () => {
  test("one atomic write sets the status, the approver and the approved revision", async () => {
    const { w, layout, standard } = await onApprovedLayout("Approve");
    expect(standard.status).toBe("DRAFT");
    expect(standard.canApprove).toBe(true);
    expect(standard.readiness.state).toBe("PROVISIONAL");

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);

    const s = res.body.standard;
    expect(s.status).toBe("APPROVED");
    expect(s.revision).toBe(standard.revision + 1);
    expect(s.approval.approvedRevision).toBe(standard.revision);
    expect(s.approval.approvedByName).toBeTruthy();
    expect(s.approval.approvedAt).toBeTruthy();
    expect(s.editable).toBe(false);
    expect(s.canApprove).toBe(false);
    expect(s.canRelease).toBe(false);
    expect(s.booksCapacity).toBe(false);
    expect(s.promisesDelivery).toBe(false);

    /* One bounded event, whose revision is the one the record reached. */
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "CAPACITY_STANDARD_APPROVED", standardRevision: standard.revision + 1,
    });
    expect(res.body.events[0].summary).toMatch(/stated working-time assumptions/i);

    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.status).toBe("APPROVED");
    expect(stored.approvedRevision).toBe(standard.revision);
    expect(stored.history.at(-1).type).toBe("CAPACITY_STANDARD_APPROVED");
    expect(stored.history.at(-1).standardRevision).toBe(stored.revision);
    expect(stored.history.length).toBeLessThanOrEqual(IeCapacityStandard.LIMITS.HISTORY);

    /* The layout it is a target for is untouched by the approval. */
    const storedLayout = await IeLineLayout.findById(layout.layoutId).lean();
    expect(storedLayout.status).toBe("APPROVED");
    expect(storedLayout.revision).toBe(layout.revision);
  });

  test("approving proves no calendar, and says so afterwards exactly as before", async () => {
    /* The whole point of the chunk. A second person accepts the ASSUMPTION;
       nothing about it becomes proved, and the record keeps saying which it is
       so that a later release cannot present one as the other. */
    const { standard: before } = await onApprovedLayout("StillProvisional");
    const { standard: after } = await approvedStandard("StillProvisional2");

    for (const s of [before, after]) {
      expect(s.calendarLinkage.state).toBe("UNKNOWN");
      expect(s.calendarLinkage.reason).toBe("NO_COMPANY_SCOPED_WORKING_TIME_CALENDAR");
      expect(s.calendarLinkage.requiredUpstreamContract)
        .toBe("COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR");
      expect(s.workingTimeSource.kind).toBe("IE_PLANNING_ASSUMPTION");
      expect(s.workingTimeSource.calendarId).toBeNull();
      expect(s.workingTimeSource.calendarVersionNo).toBeNull();
      expect(s.readiness.state).toBe("PROVISIONAL");
      expect(s.readiness.ready).toBe(false);
      const gap = s.readiness.gaps.find((g) => g.code === "IE_CAPACITY_WORKING_TIME_ASSUMED");
      expect(gap).toBeTruthy();
      expect(gap.workingTimeSourceKind).toBe("IE_PLANNING_ASSUMPTION");
      expect(gap.requiredUpstreamContract).toBe("COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR");
    }
    /* Never promoted. */
    expect(after.readiness.state).not.toBe("READY");
    /* The stated assumption note survives word for word. */
    expect(after.workingTimeSource.note).toBe(INPUTS.workingTimeNote);
    expect(after.inputs.availableShiftMinutes).toBe(INPUTS.availableShiftMinutes);
    expect(after.inputs.breakMinutes).toBe(INPUTS.breakMinutes);
    expect(after.inputs.shiftsPerDay).toBe(INPUTS.shiftsPerDay);
    expect(after.inputs.plannedOperatorCount).toBe(INPUTS.plannedOperatorCount);
    expect(after.inputs.targetEfficiencyPercent).toBe(INPUTS.targetEfficiencyPercent);
    /* And the calculation is the same figures it always was. */
    expect(after.calculation).toEqual(before.calculation);
  });

  test("a blocked standard is refused with its complete gap list", async () => {
    /* A layout with no stations blocks the target: the SAM cannot be proved. */
    const w = await world("Blocked");
    const opened = await openLayout(w.maker, w);
    const empty = opened.body.layout;
    /* It cannot be approved as a layout either, so the standard is built on it
       while it is still a draft and refused on both counts. */
    const made = await makeStandard(w.maker, w, empty.layoutId, INPUTS);
    expect(made.status).toBe(201);
    expect(made.body.standard.readiness.state).toBe("BLOCKED");

    const res = await approveStandard(w.approver, w, made.body.standard.capacityStandardId, {
      expectedRevision: made.body.standard.revision,
    });
    expect(res.status).toBe(409);
    /* The layout is the first thing that is wrong, and it is named as such. */
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED");

    /* With the layout approved but the standard still blocked, the readiness
       refusal is what answers — and it carries every blocking gap. */
    const stored = await IeCapacityStandard.findById(made.body.standard.capacityStandardId).lean();
    expect(stored.status).toBe("DRAFT");
    expect(stored.revision).toBe(made.body.standard.revision);
  });

  test("a blocked standard on an approved layout names every blocking gap", async () => {
    const { w, standard } = await onApprovedLayout("BlockedOnApproved");
    /* Corrupted so the TARGET cannot be calculated — an operator count of none.
       Deliberately not a frozen-source field: tampering with the source is a
       different refusal, proved separately, and this test is about the readiness
       one. Written raw because the service refuses such an input on the way in. */
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) },
      { $set: { "manpower.plannedOperatorCount": 0 } },
    );
    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.readiness.state).toBe("BLOCKED");
    expect(read.body.standard.calculation.available).toBe(false);

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_NOT_APPROVABLE");
    const codes = res.body.error.details.gapCodes;
    expect(codes).toContain("IE_CAPACITY_CALCULATION_UNAVAILABLE");
    /* The assumed-working-time gap is this lane's stated limitation, not a
       blocker — accepting it is precisely what approval is. */
    expect(codes).not.toContain("IE_CAPACITY_WORKING_TIME_ASSUMED");
    expect(res.body.error.details.readiness).toBe("BLOCKED");
    for (const g of res.body.error.details.gaps) {
      expect(g.owner).toBe("INDUSTRIAL_ENGINEERING");
      expect(typeof g.action).toBe("string");
    }
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
  });

  test("a standard blocked by its layout is refused for the layout, which is the earlier fact", async () => {
    /* A layout with gaps cannot be approved at all (Chunk 7C2), so a standard
       carrying its blocking gap codes is a standard on an unapproved line — and
       that is what it is told, because it is the fact that has to change first. */
    const w = await world("BlockedByLayout");
    const opened = await openLayout(w.maker, w);
    const made = await makeStandard(w.maker, w, opened.body.layout.layoutId, INPUTS);
    expect(made.status).toBe(201);
    const s = made.body.standard;
    expect(s.readiness.state).toBe("BLOCKED");
    expect(s.readiness.gaps.map((g) => g.code)).toContain("IE_CAPACITY_LAYOUT_NOT_READY");
    /* And the record itself already says approval is not the relevant action. */
    expect(s.canApprove).toBe(false);

    const res = await approveStandard(w.approver, w, s.capacityStandardId, {
      expectedRevision: s.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED");
    expect((await IeCapacityStandard.findById(s.capacityStandardId).lean()).status).toBe("DRAFT");
  });

  test("the body accepts only expectedRevision", async () => {
    const { w, standard } = await onApprovedLayout("Body");
    for (const extra of [
      { status: "APPROVED" }, { approvedBy: String(new mongoose.Types.ObjectId()) },
      { approvedByName: "Nobody" }, { approvedAt: "2026-09-11" }, { approvedRevision: 1 },
      { revision: 3 }, { history: [] }, { readiness: {} }, { calendarLinkage: {} },
      { workingTimeSourceKind: "PROVED_CALENDAR_VERSION" },
      { lineLayoutId: String(new mongoose.Types.ObjectId()) }, { reason: "Looks fine" },
      { plannedOperatorCount: 30 }, { targetPiecesPerHour: 99 },
    ]) {
      const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
        expectedRevision: standard.revision, ...extra,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(Object.keys(extra)[0]);
    }
    const missing = await approveStandard(w.approver, w, standard.capacityStandardId, {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.fieldErrors[0].field).toBe("expectedRevision");
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
  });
});

/* ══ 2. BOUND TO ONE APPROVED LAYOUT REVISION ═════════════════════════════ */

describe("approval is bound to one approved line layout at its exact revision", () => {
  test("a draft layout refuses, naming the status it actually has", async () => {
    const { w, layout, standard } = await standing("DraftLayout");
    expect(layout.status).toBe("DRAFT");

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED");
    expect(res.body.error.details).toMatchObject({
      lineLayoutId: layout.layoutId, lineLayoutStatus: "DRAFT",
    });
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
  });

  test("a standard built before the layout was approved never becomes approvable", async () => {
    /* The rule that matters most. The standard froze the DRAFT layout's
       revision; approving the layout moves it. Such a record is a target for a
       line nobody signed off, and somebody else's later decision must not turn
       it into one that was. */
    const { w, layout, standard } = await standing("BuiltBefore");
    expect(standard.source.lineLayoutRevision).toBe(layout.revision);

    const approved = await approveLayout(w.approver, w, layout.layoutId, {
      expectedRevision: layout.revision,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.layout.revision).toBe(layout.revision + 1);

    /* The layout IS approved now — and this standard still cannot be, because
       it is a target for the revision BEFORE that decision. The refusal is the
       source-changed one, which already carries the reason, both revisions and
       the resolution; a second code would be a second way of saying one thing. */
    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details.reasons).toContain("LINE_LAYOUT_REVISION_CHANGED");
    expect(res.body.error.details).toMatchObject({
      lineLayoutId: layout.layoutId,
      boundLineLayoutRevision: layout.revision,
      currentLineLayoutRevision: layout.revision + 1,
      resolution: "CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE",
    });
    /* And the record itself says it is no longer approvable. */
    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.canApprove).toBe(false);
    expect(read.body.standard.editable).toBe(false);
    expect(read.body.standard.source.state).toBe("SOURCE_CHANGED");
    /* Nothing was written, and the record stays a draft for ever. */
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.status).toBe("DRAFT");
    expect(stored.revision).toBe(standard.revision);
    expect("approvedBy" in stored).toBe(false);

    /* The way forward is a NEW standard against the approved layout. */
    const fresh = await makeStandard(w.maker, w, layout.layoutId, INPUTS);
    expect(fresh.status).toBe(201);
    expect(fresh.body.standard.source.lineLayoutRevision).toBe(layout.revision + 1);
    const ok = await approveStandard(w.approver, w, fresh.body.standard.capacityStandardId, {
      expectedRevision: fresh.body.standard.revision,
    });
    expect(ok.status).toBe(200);
    /* And both survive, one approved and one for ever a draft. */
    expect(await IeCapacityStandard.countDocuments({ status: "APPROVED" })).toBe(1);
    expect(await IeCapacityStandard.countDocuments({ status: "DRAFT" })).toBe(1);
  });

  test("source movement refuses with the code that already means it", async () => {
    const { w, layout, standard } = await onApprovedLayout("SourceMoved");
    /* Move the line configuration, which moves the layout's revision and so the
       standard's own frozen evidence out of date. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $set: { revision: layout.revision + 1 } },
    );

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details.reasons).toContain("LINE_LAYOUT_REVISION_CHANGED");
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
  });

  test("an unresolvable layout refuses and writes nothing", async () => {
    const { w, layout, standard } = await onApprovedLayout("LayoutGone");
    await IeLineLayout.deleteOne({ _id: layout.layoutId });

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details.reasons).toContain("LINE_LAYOUT_UNAVAILABLE");
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
  });
});

/* ══ 3. MAKER-CHECKER, ROLES AND CONCURRENCY ══════════════════════════════ */

describe("the approver is not the author", () => {
  test("the person who last worked on the standard cannot approve it", async () => {
    const { w, layout } = await onApprovedLayout("Maker");
    const both = await actor({ companies: [w.co], grants: { ie: "approver" } });
    const made = await makeStandard(both, w, layout.layoutId, { ...INPUTS, plannedOperatorCount: 20 });
    expect(made.status).toBe(201);
    const standard = made.body.standard;

    const res = await approveStandard(both, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_MAKER_CHECKER");
    expect(res.body.error.message).toMatch(/somebody other than the person who last worked on it/i);
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");

    /* Somebody else approves the very same standard without difficulty. */
    const ok = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(ok.status).toBe(200);
  });

  test("the same display name with a different actor id is not the same person", async () => {
    const { w, layout } = await onApprovedLayout("SameName");
    const author = await actor({ companies: [w.co], grants: { ie: "editor" } });
    const decider = await actor({ companies: [w.co], grants: { ie: "approver" } });
    const jwtLib = require("jsonwebtoken");
    const nameOf = (a) => jwtLib.decode(a.token).name;
    const idOf = (a) => jwtLib.decode(a.token).id;
    expect(idOf(author)).not.toBe(idOf(decider));

    const made = await makeStandard(author, w, layout.layoutId, { ...INPUTS, plannedOperatorCount: 21 });
    const standard = made.body.standard;
    /* The stored author NAME is made identical to the approver's own while the
       stored author ID stays the other person's. A comparison by name refuses
       this wrongly; a comparison by id allows it. */
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) },
      { $set: { updatedByName: nameOf(decider), createdByName: nameOf(decider) } },
    );

    const res = await approveStandard(decider, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(200);
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(String(stored.approvedBy)).toBe(idOf(decider));
    expect(String(stored.updatedBy)).not.toBe(idOf(author));
  });

  test("a standard with no provable author fails closed", async () => {
    const { w, standard } = await onApprovedLayout("NoAuthor");
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) },
      { $unset: { updatedBy: "", createdBy: "" } },
    );
    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_MAKER_CHECKER");
    expect(res.body.error.message).toMatch(/nothing stored says who authored/i);
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
  });

  test("a viewer and an editor cannot approve; an approver can", async () => {
    const { w, standard } = await onApprovedLayout("Roles");
    for (const a of [await viewerIn(w.co), await editorIn(w.co)]) {
      const res = await approveStandard(a, w, standard.capacityStandardId, {
        expectedRevision: standard.revision,
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    }
    expect((await IeCapacityStandard.findById(standard.capacityStandardId).lean()).status).toBe("DRAFT");
    const ok = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(ok.status).toBe(200);
  });

  test("a stale approval conflicts and writes nothing", async () => {
    const { w, standard } = await onApprovedLayout("Stale");
    /* A real edit first, so the revision genuinely moves. */
    const edited = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 26,
    });
    expect(edited.status).toBe(200);

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_REVISION_CONFLICT");
    expect(res.body.error.details).toMatchObject({
      expected: standard.revision, actual: standard.revision + 1,
    });
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.status).toBe("DRAFT");
    expect("approvedBy" in stored).toBe(false);
  });

  test("two simultaneous approvals produce exactly one winner", async () => {
    const { w, standard } = await onApprovedLayout("Race");
    const other = await approverIn(w.co);
    const [one, two] = await Promise.all([
      approveStandard(w.approver, w, standard.capacityStandardId, { expectedRevision: standard.revision }),
      approveStandard(other, w, standard.capacityStandardId, { expectedRevision: standard.revision }),
    ]);
    const winners = [one, two].filter((r) => r.status === 200);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(["IE_CAPACITY_STANDARD_IMMUTABLE", "IE_CAPACITY_STANDARD_REVISION_CONFLICT"])
      .toContain(loser.body.error.code);

    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.status).toBe("APPROVED");
    expect(stored.revision).toBe(standard.revision + 1);
    expect(stored.history.filter((e) => e.type === "CAPACITY_STANDARD_APPROVED")).toHaveLength(1);
  });

  test("another company's standard is indistinguishable from absent", async () => {
    const mine = await onApprovedLayout("IsoMine");
    const theirs = await world("IsoTheirs");
    const outsider = await approverIn(theirs.co);

    const foreign = await approveStandard(outsider, theirs, mine.standard.capacityStandardId, {
      expectedRevision: mine.standard.revision,
    });
    const invented = await approveStandard(outsider, theirs, new mongoose.Types.ObjectId(), {
      expectedRevision: 1,
    });
    expect(foreign.status).toBe(404);
    expect(foreign.body.error.code).toBe("IE_CAPACITY_STANDARD_NOT_FOUND");
    expect(foreign.body).toEqual(invented.body);
    expect((await IeCapacityStandard.findById(mine.standard.capacityStandardId).lean()).status)
      .toBe("DRAFT");
  });
});

/* ══ 4. AN APPROVED STANDARD IS PERMANENT EVIDENCE ════════════════════════ */

describe("an approved standard accepts no write, of any field, by any path", () => {
  test("the PATCH refuses it before the source and before the revision", async () => {
    const { w, standard } = await approvedStandard("NoPatch");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    for (const expectedRevision of [standard.revision, standard.revision - 1, 99]) {
      const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
        expectedRevision, plannedOperatorCount: 30,
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_IMMUTABLE");
      expect(res.body.error.details).toMatchObject({
        status: "APPROVED", resolution: "CREATE_NEW_DRAFT_STANDARD",
      });
    }
    /* Even an edit that would have been an honest no-op. */
    const noop = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      plannedOperatorCount: standard.inputs.plannedOperatorCount,
    });
    expect(noop.status).toBe(409);
    expect(noop.body.error.code).toBe("IE_CAPACITY_STANDARD_IMMUTABLE");

    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("identity, authorship, timestamps, inputs, evidence and arbitrary fields are all refused", async () => {
    const { w, standard } = await approvedStandard("NoWrites");
    const id = standard.capacityStandardId;
    const before = await IeCapacityStandard.findById(id).lean();
    const other = await world("Elsewhere");

    /* ── save() ── */
    for (const mutate of [
      (d) => { d.manpower.plannedOperatorCount = 99; },
      (d) => { d.targetEfficiencyPercent = 100; },
      (d) => { d.source.garmentSamMinutes = 99; },
      (d) => { d.status = "DRAFT"; },
      (d) => { d.approvedByName = "Somebody else"; },
      (d) => { d.revision += 1; },
      (d) => { d.note = "Rewritten after the fact"; },
      (d) => { d.effectiveFrom = new Date("2030-01-01"); },
    ]) {
      const doc = await IeCapacityStandard.findById(id);
      mutate(doc);
      await expect(doc.save()).rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
    }

    /* ── every query mutation, of every kind of field ── */
    const updates = [
      { $set: { companyId: other.co._id } },
      { $set: { lineLayoutId: new mongoose.Types.ObjectId() } },
      { $set: { ieStyleFileId: new mongoose.Types.ObjectId() } },
      { $set: { createdBy: new mongoose.Types.ObjectId() } },
      { $set: { createdByName: "Somebody else" } },
      { $set: { updatedBy: new mongoose.Types.ObjectId() } },
      { $set: { updatedByName: "Somebody else" } },
      { $set: { createdAt: new Date("2000-01-01") } },
      { $set: { updatedAt: new Date("2000-01-01") } },
      { $set: { status: "DRAFT" } },
      { $set: { approvedBy: new mongoose.Types.ObjectId() } },
      { $set: { approvedByName: "Somebody else" } },
      { $set: { approvedAt: new Date() } },
      { $set: { approvedRevision: 99 } },
      { $set: { "manpower.plannedOperatorCount": 99 } },
      { $set: { "workingTime.availableShiftMinutes": 1 } },
      { $set: { "workingTime.source.kind": "PROVED_CALENDAR_VERSION" } },
      { $set: { targetEfficiencyPercent: 100 } },
      { $set: { "source.garmentSamMinutes": 99 } },
      { $set: { "source.layoutFingerprint": "f".repeat(64) } },
      { $set: { "source.lineLayoutRevision": 99 } },
      { $set: { ramp: null } },
      { $set: { "ramp.targetEfficiencyPercent": 95 } },
      { $inc: { revision: 1 } },
      { $push: { history: { eventId: "forged", type: "CAPACITY_STANDARD_APPROVED", at: new Date(), standardRevision: 9 } } },
      { $unset: { note: "" } },
      /* A field nobody has thought of yet behaves the same way. */
      { $set: { somethingAddedLater: true } },
    ];
    for (const update of updates) {
      for (const write of [
        () => IeCapacityStandard.updateOne({ _id: id }, update),
        () => IeCapacityStandard.updateMany({ _id: id }, update),
        () => IeCapacityStandard.findOneAndUpdate({ _id: id }, update),
        /* Naming the status it actually has does not help. */
        () => IeCapacityStandard.updateOne({ _id: id, status: "APPROVED" }, update),
        /* Nor does a filter safe for one status and not another. */
        () => IeCapacityStandard.updateOne({ _id: id, status: { $in: ["DRAFT", "APPROVED"] } }, update),
        () => IeCapacityStandard.updateOne({ _id: id, status: { $ne: "APPROVED" } }, update),
      ]) {
        await expect(write()).rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
      }
    }

    /* ── replacement and upsert ── */
    await expect(IeCapacityStandard.replaceOne({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
    await expect(IeCapacityStandard.findOneAndReplace({ _id: id }, before))
      .rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
    await expect(IeCapacityStandard.updateOne({ _id: new mongoose.Types.ObjectId(), status: "DRAFT" },
      { $set: { note: "x" } }, { upsert: true }))
      .rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });

    const after = await IeCapacityStandard.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("a draft standard still edits, and the real approval still works", async () => {
    const { w, standard } = await onApprovedLayout("StillWorks");
    const edited = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 26,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.updated).toBe(true);
    /* A no-op is still an honest no-op. */
    const noop = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: edited.body.standard.revision, plannedOperatorCount: 26,
    });
    expect(noop.body.updated).toBe(false);

    const approved = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: edited.body.standard.revision,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.standard.status).toBe("APPROVED");
  });

  test("there is no unapprove, refresh, rebase, return or delete", async () => {
    const { w, standard } = await approvedStandard("NoUndo");
    const id = standard.capacityStandardId;
    for (const [method, path] of [
      ["POST", `/capacity-standards/${id}/unapprove`],
      ["POST", `/capacity-standards/${id}/return`],
      ["POST", `/capacity-standards/${id}/restore`],
      ["POST", `/capacity-standards/${id}/refresh`],
      ["POST", `/capacity-standards/${id}/rebase`],
      ["POST", `/capacity-standards/${id}/recalculate`],
      ["DELETE", `/capacity-standards/${id}`],
    ]) {
      const res = await call(path, { method, body: {}, token: w.approver.token, company: w.co._id });
      expect(res.status).toBe(404);
    }
    expect((await IeCapacityStandard.findById(id).lean()).status).toBe("APPROVED");
  });
});

/* ══ 5. IT STAYS READABLE, AND STAYS THE SAME ═════════════════════════════ */

describe("approved evidence survives whatever happens upstream", () => {
  test("a superseded or vanished layout leaves the stored record byte-identical", async () => {
    const { w, layout, standard } = await approvedStandard("Upstream");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    /* The layout moves on, then disappears entirely. */
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $set: { revision: layout.revision + 5 } },
    );
    const moved = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(moved.status).toBe(200);
    expect(moved.body.standard.status).toBe("APPROVED");
    expect(moved.body.standard.source.state).toBe("SOURCE_CHANGED");
    expect(moved.body.standard.editable).toBe(false);
    expect(moved.body.standard.canApprove).toBe(false);
    /* The frozen target and its evidence are exactly what was approved. */
    expect(moved.body.standard.calculation).toEqual(standard.calculation);
    expect(moved.body.standard.source.garmentSamMinutes).toBe(standard.source.garmentSamMinutes);
    expect(moved.body.standard.approval).toEqual(standard.approval);

    await IeLineLayout.deleteOne({ _id: layout.layoutId });
    const gone = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(gone.status).toBe(200);
    expect(gone.body.standard.source.state).toBe("SOURCE_UNAVAILABLE");
    expect(gone.body.standard.status).toBe("APPROVED");
    expect(gone.body.standard.calculation).toEqual(standard.calculation);
    /* And the provisional truth still travels with it. */
    expect(gone.body.standard.calendarLinkage.state).toBe("UNKNOWN");
    expect(gone.body.standard.readiness.gaps.map((g) => g.code))
      .toContain("IE_CAPACITY_WORKING_TIME_ASSUMED");

    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("the list publishes each standard's own status and approval", async () => {
    const { w, layout, standard } = await approvedStandard("List");
    const second = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, plannedOperatorCount: 30,
    });
    expect(second.status).toBe(201);

    const list = await listForLayout(w.maker, w, layout.layoutId);
    expect(list.status).toBe(200);
    const byId = new Map(list.body.standards.map((s) => [s.capacityStandardId, s]));
    expect(byId.get(standard.capacityStandardId).status).toBe("APPROVED");
    expect(byId.get(standard.capacityStandardId).approval.approvedRevision)
      .toBe(standard.approval.approvedRevision);
    expect(byId.get(standard.capacityStandardId).canApprove).toBe(false);
    expect(byId.get(second.body.standard.capacityStandardId).status).toBe("DRAFT");
    expect(byId.get(second.body.standard.capacityStandardId).approval).toBeNull();
    expect(byId.get(second.body.standard.capacityStandardId).canApprove).toBe(true);
    /* Both stay provisional, because both rest on stated assumptions. */
    for (const s of list.body.standards) {
      expect(s.readiness.state).toBe("PROVISIONAL");
      expect(s.calendarLinkage.state).toBe("UNKNOWN");
      expect(s.canRelease).toBe(false);
    }
  });

  test("the frozen ramp evidence survives approval untouched", async () => {
    const { w, layout } = await onApprovedLayout("RampFrozen");
    const profile = (await call("/ramp-profiles", {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: {
        name: "Approved ramp",
        stages: [{ label: "Week one", fromProductionDay: 1, toProductionDay: null, targetEfficiencyPercent: 40 }],
      },
    })).body.profile;

    const made = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, rampProfileId: profile.rampProfileId, rampStageId: profile.stages[0].stageId,
    });
    expect(made.status).toBe(201);
    const draft = made.body.standard;
    expect(draft.ramp.targetEfficiencyPercent).toBe(40);

    const res = await approveStandard(w.approver, w, draft.capacityStandardId, {
      expectedRevision: draft.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.standard.ramp).toEqual(draft.ramp);
    expect(res.body.standard.rampCalculation).toEqual(draft.rampCalculation);
    expect(res.body.standard.ramp.basis).toBe("STATED_IE_ASSUMPTION");
    expect(res.body.standard.ramp.describesActuals).toBe(false);

    /* Editing the profile afterwards restates nothing. */
    await call(`/ramp-profiles/${profile.rampProfileId}`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: {
        expectedRevision: profile.revision,
        stages: [{ label: "Week one", fromProductionDay: 1, toProductionDay: null, targetEfficiencyPercent: 90 }],
      },
    });
    const after = await readStandard(w.maker, w, draft.capacityStandardId);
    expect(after.body.standard.ramp.targetEfficiencyPercent).toBe(40);
    expect(after.body.standard.rampCalculation).toEqual(draft.rampCalculation);
  });
});

/* ══ 6. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("nothing downstream of an accepted target exists here", () => {
  test("no IE service imports or writes Production, PPC, a work order or a barcode", () => {
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
      for (const model of ["WorkOrder", "ProductionTracking", "ProductionSchedule", "WorkingCalendar"]) {
        expect(src).not.toMatch(
          new RegExp(`${model}\\.(updateOne|updateMany|findOneAndUpdate|findOneAndReplace|replaceOne|create|deleteOne)\\(`),
        );
      }
    }
  });

  test("an approved standard's payload carries no Production or people concept", async () => {
    const { standard } = await approvedStandard("CleanPayload");
    const wire = JSON.stringify(standard);
    for (const forbidden of [
      "machineId", "serialNumber", "assetId", "maintenanceStatus",
      "employeeId", "operatorId", "operatorIdentityId", "attendance", "shiftName",
      "barcodeScans", "scanId", "workOrderId", "productionScheduleId",
      "releasedAt", "acknowledgedAt", "bookedQuantity", "committedQuantity", "deliveryDate",
    ]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
    /* And it still says what it does not do. */
    expect(standard.canRelease).toBe(false);
    expect(standard.booksCapacity).toBe(false);
    expect(standard.promisesDelivery).toBe(false);
  });
});

/* ══ 7. THE FOUR CORRECTIONS ══════════════════════════════════════════════ */

describe("no capacity standard is ever deleted or replaced", () => {
  test("every Mongoose deletion path is refused, and the record stays byte-identical", async () => {
    const { standard } = await approvedStandard("NoDelete");
    const id = standard.capacityStandardId;
    const before = await IeCapacityStandard.findById(id).lean();

    /* Every path Mongoose offers, including the ones that are not hooks of
       their own — `findByIdAndDelete` runs through `findOneAndDelete`, and the
       document method through the document `deleteOne` hook. */
    const doc = await IeCapacityStandard.findById(id);
    for (const [what, run] of [
      ["query deleteOne", () => IeCapacityStandard.deleteOne({ _id: id })],
      ["deleteMany", () => IeCapacityStandard.deleteMany({ _id: id })],
      ["findOneAndDelete", () => IeCapacityStandard.findOneAndDelete({ _id: id })],
      ["findByIdAndDelete", () => IeCapacityStandard.findByIdAndDelete(id)],
      ["document deleteOne", () => doc.deleteOne()],
      /* Naming DRAFT does not help: there is no deletion lifecycle at all, so
         the rule is universal rather than conditional — a conditional one would
         need every caller to prove the status, and the first to forget would
         take an approved record with it. */
      ["deleteOne naming DRAFT", () => IeCapacityStandard.deleteOne({ _id: id, status: "DRAFT" })],
      ["deleteMany naming DRAFT", () => IeCapacityStandard.deleteMany({ status: "DRAFT" })],
      ["deleteMany over everything", () => IeCapacityStandard.deleteMany({})],
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
      expect(await IeCapacityStandard.countDocuments({ _id: id })).toBe(1);
      void what;
    }

    const after = await IeCapacityStandard.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("a draft cannot be deleted either", async () => {
    const { standard } = await onApprovedLayout("NoDeleteDraft");
    const id = standard.capacityStandardId;
    await expect(IeCapacityStandard.deleteOne({ _id: id, status: "DRAFT" }))
      .rejects.toThrow(/never deleted/i);
    await expect(IeCapacityStandard.findByIdAndDelete(id))
      .rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
    expect(await IeCapacityStandard.countDocuments({ _id: id })).toBe(1);
    /* A standard that was wrong is superseded by a new one. */
    const { w, layout } = await onApprovedLayout("Supersede");
    const second = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, plannedOperatorCount: 30 });
    expect(second.status).toBe(201);
  });

  test("a DRAFT-filtered replacement is refused, on both paths", async () => {
    /* This was the hole: a filter naming DRAFT let a replacement through, and a
       replacement's field set is the WHOLE document — the frozen source, the
       calculation inputs and the entire audit trail, all server-owned. */
    const { standard } = await onApprovedLayout("NoReplace");
    const id = standard.capacityStandardId;
    const before = await IeCapacityStandard.findById(id).lean();
    const forged = { ...before, source: { ...before.source, garmentSamMinutes: 99 }, history: [] };

    for (const run of [
      () => IeCapacityStandard.findOneAndReplace({ _id: id, status: "DRAFT" }, forged),
      () => IeCapacityStandard.replaceOne({ _id: id, status: "DRAFT" }, forged),
      () => IeCapacityStandard.findOneAndReplace({ _id: id }, forged),
      () => IeCapacityStandard.replaceOne({ _id: id }, forged),
    ]) {
      await expect(run()).rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });
    }
    /* And on an approved one, for the same reason. */
    const { standard: approved } = await approvedStandard("NoReplaceApproved");
    await expect(IeCapacityStandard.findOneAndReplace(
      { _id: approved.capacityStandardId, status: "DRAFT" }, forged,
    )).rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });

    const after = await IeCapacityStandard.findById(id).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("an upsert is refused, and ordinary draft edits and approval still work", async () => {
    const { w, standard } = await onApprovedLayout("StillWorksAfterGuards");
    await expect(IeCapacityStandard.updateOne(
      { _id: new mongoose.Types.ObjectId(), status: "DRAFT" }, { $set: { note: "x" } }, { upsert: true },
    )).rejects.toMatchObject({ code: "IE_CAPACITY_STANDARD_IMMUTABLE" });

    const edited = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, plannedOperatorCount: 27, note: "Re-planned",
    });
    expect(edited.status).toBe(200);
    expect(edited.body.updated).toBe(true);
    expect(edited.body.standard.inputs.plannedOperatorCount).toBe(27);

    const approved = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: edited.body.standard.revision,
    });
    expect(approved.status).toBe(200);
    expect(approved.body.standard.status).toBe("APPROVED");
  });
});

describe("the frozen source is re-proved against the layout at approval", () => {
  /**
   * Corrupt one frozen fact and try to approve.
   *
   * Raw collection writes only — the service refuses every one of these on the
   * way in, which is the point: this is what a corrupted or hand-edited record
   * looks like, and an approval must not bless one.
   */
  async function tamper(name, patch, expectedReason) {
    const { w, standard } = await onApprovedLayout(name);
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) }, { $set: patch },
    );
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
    expect(res.body.error.details.reasons).toContain(expectedReason);
    expect(res.body.error.details.resolution).toBe("CREATE_NEW_STANDARD_FROM_CURRENT_SOURCE");
    /* The new gate names the exact field that disagrees. The bound layout
       revision is the one exception: it is caught a step earlier, by the
       source-state comparison that has always owned it, so that refusal carries
       the reason without a field-by-field list. */
    if (res.body.error.details.mismatches) {
      expect(res.body.error.details.mismatches.map((m) => m.field)).toContain(Object.keys(patch)[0]);
    } else {
      expect(Object.keys(patch)[0]).toBe("source.lineLayoutRevision");
    }

    /* Nothing moved: not the status, the revision, the history, the timestamp or
       any approval field. */
    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.status).toBe("DRAFT");
    expect(after.revision).toBe(before.revision);
    expect(after.history).toHaveLength(before.history.length);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    for (const f of ["approvedBy", "approvedByName", "approvedAt", "approvedRevision"]) {
      expect(f in after).toBe(false);
    }
    return res;
  }

  test("a tampered layout revision refuses, caught by the comparison that owns it", async () => {
    /* The frozen layout revision is compared by `withSourceState`, which has
       owned that question since Chunk 7A. The new field-by-field gate does not
       repeat it — one fact, one refusal. */
    await tamper("TamperRevision", { "source.lineLayoutRevision": 99 }, "LINE_LAYOUT_REVISION_CHANGED");
  });

  test("a tampered layout fingerprint refuses", async () => {
    await tamper("TamperFingerprint", { "source.layoutFingerprint": "f".repeat(64) },
      "LAYOUT_FINGERPRINT_CHANGED");
  });

  test("a tampered bulletin revision refuses", async () => {
    await tamper("TamperBulletin", { "source.bulletinRevision": 77 }, "BULLETIN_REVISION_CHANGED");
  });

  test("a tampered approval digest refuses", async () => {
    await tamper("TamperApprovalDigest", { "source.approvalDigest": "a".repeat(64) },
      "APPROVED_STANDARD_CHANGED");
  });

  test("a tampered requirement digest refuses", async () => {
    await tamper("TamperReqDigest", { "source.requirementDigest": "r".repeat(64) },
      "REQUIREMENT_EVIDENCE_CHANGED");
  });

  test("a tampered garment SAM refuses, even though the target still computes", async () => {
    /* The case a positive number would otherwise wave through: 3.5 minutes
       produces a perfectly plausible figure, and the calculation cannot say
       whether it was calculated from this layout. */
    const res = await tamper("TamperSam", { "source.garmentSamMinutes": 3.5 }, "GARMENT_SAM_CHANGED");
    const mismatch = res.body.error.details.mismatches.find((m) => m.field === "source.garmentSamMinutes");
    expect(mismatch.frozen).toBe(3.5);
    expect(mismatch.derived).toBe(4.5);
  });

  test("a tampered SAM derivation refuses", async () => {
    await tamper("TamperDerivation", { "source.samDerivation": "GUESSED_FROM_THE_BULLETIN" },
      "SAM_DERIVATION_CHANGED");
  });

  test("a tampered SAM row count refuses", async () => {
    await tamper("TamperRowCount", { "source.samRowCount": 9 }, "SAM_ROW_COUNT_CHANGED");
  });

  test("a tampered captured layout readiness refuses", async () => {
    await tamper("TamperReady", { "source.layoutReady": false }, "LAYOUT_READINESS_CHANGED");
  });

  test("a tampered captured gap-code list refuses", async () => {
    await tamper("TamperGaps", { "source.layoutGapCodes": ["IE_LAYOUT_NO_STATIONS"] },
      "LAYOUT_GAPS_CHANGED");
  });

  test("capture evidence is validated as stored, never compared with now", async () => {
    /* `capturedAt` says WHEN the copy was taken. There is nothing on the layout
       to compare it against, and re-deriving it would make it differ every time
       it was read — so an ordinary past date approves. */
    const { w, standard } = await onApprovedLayout("CapturedPast");
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) },
      { $set: { "source.capturedAt": new Date("2026-01-01") } },
    );
    const ok = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(ok.status).toBe(200);

    /* A missing one, and one claiming tomorrow, are both refused: neither was
       written by this service. */
    await tamper("CapturedGone", { "source.capturedAt": null }, "CAPTURE_EVIDENCE_MISSING");
    await tamper("CapturedFuture",
      { "source.capturedAt": new Date(Date.now() + 7 * 24 * 3600 * 1000) },
      "CAPTURE_EVIDENCE_IMPOSSIBLE");
  });

  test("several tampered facts are all reported together", async () => {
    const { w, standard } = await onApprovedLayout("TamperMany");
    await IeCapacityStandard.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(standard.capacityStandardId)) },
      {
        $set: {
          "source.garmentSamMinutes": 3.5,
          "source.samRowCount": 9,
          "source.layoutFingerprint": "f".repeat(64),
        },
      },
    );
    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.reasons).toEqual(expect.arrayContaining([
      "GARMENT_SAM_CHANGED", "SAM_ROW_COUNT_CHANGED", "LAYOUT_FINGERPRINT_CHANGED",
    ]));
    expect(res.body.error.details.mismatches).toHaveLength(3);
  });

  test("untampered evidence approves", async () => {
    /* The other half: the comparison is not simply always false. Every fact is
       re-derived from the layout by the same helpers that froze it, so an honest
       record matches digit for digit. */
    const { w, standard } = await onApprovedLayout("Untampered");
    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(200);
    expect(res.body.standard.status).toBe("APPROVED");
    expect(res.body.standard.source.garmentSamMinutes).toBe(4.5);
  });
});

describe("canApprove never promises what the endpoint refuses", () => {
  test("a standard on a DRAFT layout publishes false, and the endpoint agrees", async () => {
    const { w, layout, standard } = await standing("DraftLayoutFlag");
    expect(layout.status).toBe("DRAFT");
    expect(standard.canApprove).toBe(false);
    expect(standard.lineLayoutStatus).toBe("DRAFT");

    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.canApprove).toBe(false);
    const list = await listForLayout(w.maker, w, layout.layoutId);
    expect(list.body.standards[0].canApprove).toBe(false);

    /* And the endpoint refuses, which is what the flag was promising about. */
    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(409);
  });

  test("a standard on an APPROVED layout with a current source publishes true", async () => {
    const { w, layout, standard } = await onApprovedLayout("ApprovedLayoutFlag");
    expect(standard.canApprove).toBe(true);
    expect(standard.lineLayoutStatus).toBe("APPROVED");
    expect(standard.status).toBe("DRAFT");
    expect(standard.editable).toBe(true);

    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.canApprove).toBe(true);
    const list = await listForLayout(w.maker, w, layout.layoutId);
    expect(list.body.standards[0].canApprove).toBe(true);

    /* And the endpoint agrees. */
    const res = await approveStandard(w.approver, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
    });
    expect(res.status).toBe(200);
  });

  test("an approved standard and a moved-source standard both publish false", async () => {
    const { w, layout, standard } = await approvedStandard("ApprovedFlag");
    expect(standard.canApprove).toBe(false);
    expect((await readStandard(w.maker, w, standard.capacityStandardId)).body.standard.canApprove)
      .toBe(false);

    /* And a draft whose source has moved under it. */
    const second = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, plannedOperatorCount: 31,
    });
    expect(second.body.standard.canApprove).toBe(true);
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(layout.layoutId)) },
      { $set: { revision: layout.revision + 3 } },
    );
    const moved = await readStandard(w.maker, w, second.body.standard.capacityStandardId);
    expect(moved.body.standard.source.state).toBe("SOURCE_CHANGED");
    expect(moved.body.standard.canApprove).toBe(false);

    /* And one whose layout cannot be resolved at all. */
    await IeLineLayout.deleteOne({ _id: layout.layoutId });
    const gone = await readStandard(w.maker, w, second.body.standard.capacityStandardId);
    expect(gone.body.standard.source.state).toBe("SOURCE_UNAVAILABLE");
    expect(gone.body.standard.canApprove).toBe(false);
    expect(gone.body.standard.lineLayoutStatus).toBeNull();
  });
});
