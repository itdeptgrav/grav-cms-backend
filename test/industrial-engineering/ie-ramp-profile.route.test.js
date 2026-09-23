// test/industrial-engineering/ie-ramp-profile.route.test.js
//
// IE CHUNK 7B — CONFIGURED RAMP ASSUMPTIONS, AT THE WIRE.
//
// A ramp profile says what efficiency a line is PLANNED to hold on each stage of
// a run. The claims worth holding are the ones that keep it an assumption and
// keep it honest once it has been used:
//
//   · it is company-scoped, versioned, and another company's is indistinguishable
//     from one that does not exist;
//   · its stages TILE the run from production day one — no overlap, no gap, and
//     a deterministic order derived from the days themselves, never sent;
//   · every efficiency is a percentage, greater than zero and at most 100;
//   · it retires reversibly and deletes nothing, and retiring releases its name;
//   · a capacity standard FREEZES the profile id, revision, stage and percentage,
//     so correcting or retiring the profile afterwards restates no target;
//   · the ramp target comes from Chunk 7A's own calculator, with the same
//     rounding and the same floor — there is no second formula;
//   · and nothing here observes a run: no date, no scan, no output, no operator,
//     no machine, and no approve or release verb.
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
const IeRampProfile = require("../../models/CMS_Models/IndustrialEngineering/IeRampProfile");

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
  await IeRampProfile.syncIndexes();
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
  const email = `ramp${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "R", lastName: `R${n}`, email, biometricId: `RMP${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "R" });
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


/* ── THE RAMP ROUTES UNDER TEST ───────────────────────────────────────────── */

const makeProfile = (a, w, body) => call("/ramp-profiles", {
  method: "POST", token: a.token, company: w.co._id, body,
});
const readProfile = (a, w, id) => call(`/ramp-profiles/${id}`, { token: a.token, company: w.co._id });
const listProfiles = (a, w, qs = "") => call(`/ramp-profiles${qs}`, { token: a.token, company: w.co._id });
const patchProfile = (a, w, id, body) => call(`/ramp-profiles/${id}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const retireProfile = (a, w, id, body) => call(`/ramp-profiles/${id}/retire`, {
  method: "POST", token: a.token, company: w.co._id, body,
});
const restoreProfile = (a, w, id, body) => call(`/ramp-profiles/${id}/restore`, {
  method: "POST", token: a.token, company: w.co._id, body,
});

/** Three stages tiling days 1-3, 4-10 and 11 onward. */
const STAGES = Object.freeze([
  { label: "Week one", fromProductionDay: 1, toProductionDay: 3, targetEfficiencyPercent: 40 },
  { label: "Settling", fromProductionDay: 4, toProductionDay: 10, targetEfficiencyPercent: 60 },
  { label: "Steady", fromProductionDay: 11, toProductionDay: null, targetEfficiencyPercent: 80 },
]);

const ramped = (name, stages = STAGES) => ({ name, description: "As agreed with the floor", stages });

/** A company with an arranged layout and one active ramp profile. */
async function withProfile(name, stages = STAGES) {
  const w = await world(name);
  const layout = await arranged(w);
  const made = await makeProfile(w.maker, w, ramped(`${name} ramp`, stages));
  expect(made.status).toBe(201);
  return { w, layout, profile: made.body.profile };
}

/* ══ 1. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("every ramp endpoint is company-scoped and role-gated", () => {
  test("a viewer reads and cannot write; an editor may do both", async () => {
    const { w, profile } = await withProfile("Gate");
    const viewer = await viewerIn(w.co);

    for (const path of ["/ramp-profiles", `/ramp-profiles/${profile.rampProfileId}`]) {
      expect((await call(path, { token: viewer.token, company: w.co._id })).status).toBe(200);
    }
    for (const [method, path, body] of [
      ["POST", "/ramp-profiles", ramped("Viewer ramp")],
      ["PATCH", `/ramp-profiles/${profile.rampProfileId}`, { expectedRevision: 1, name: "X" }],
      ["POST", `/ramp-profiles/${profile.rampProfileId}/retire`, { expectedRevision: 1 }],
      ["POST", `/ramp-profiles/${profile.rampProfileId}/restore`, { expectedRevision: 1 }],
    ]) {
      const res = await call(path, { method, body, token: viewer.token, company: w.co._id });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("IE_WRITE_FORBIDDEN");
    }
  });

  test("another company's profile is indistinguishable from a missing one", async () => {
    const mine = await withProfile("Mine");
    const theirs = await world("Theirs");
    const outsider = await editorIn(theirs.co);
    const t = { token: outsider.token, company: theirs.co._id };
    const id = mine.profile.rampProfileId;

    const read = await call(`/ramp-profiles/${id}`, t);
    expect(read.status).toBe(404);
    expect(read.body.error.code).toBe("IE_RAMP_PROFILE_NOT_FOUND");

    for (const other of [
      await call(`/ramp-profiles/${new mongoose.Types.ObjectId()}`, t),
      await call("/ramp-profiles/not-an-id", t),
    ]) {
      expect(other.status).toBe(read.status);
      expect(other.body.error.code).toBe(read.body.error.code);
      expect(other.body.error.message).toBe(read.body.error.message);
    }

    for (const [method, path, body] of [
      ["PATCH", `/ramp-profiles/${id}`, { expectedRevision: 1, name: "Z" }],
      ["POST", `/ramp-profiles/${id}/retire`, { expectedRevision: 1 }],
      ["POST", `/ramp-profiles/${id}/restore`, { expectedRevision: 1 }],
    ]) {
      const res = await call(path, { method, body, ...t });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("IE_RAMP_PROFILE_NOT_FOUND");
    }

    const list = await listProfiles(outsider, theirs);
    expect(list.body.profiles).toEqual([]);
    expect(await IeRampProfile.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });

  test("two companies may hold the same profile name", async () => {
    const one = await world("SameNameOne");
    const two = await world("SameNameTwo");
    const a = await makeProfile(one.maker, one, ramped("Standard ramp"));
    const b = await makeProfile(two.maker, two, ramped("Standard ramp"));
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.profile.rampProfileId).not.toBe(b.body.profile.rampProfileId);
    expect(a.body.profile.companyId).toBe(String(one.co._id));
    expect(b.body.profile.companyId).toBe(String(two.co._id));
  });
});

/* ══ 2. CREATE, READ, LIST ════════════════════════════════════════════════ */

describe("a profile records its stages in a deterministic order", () => {
  test("it publishes what it was given, with server-minted stage ids", async () => {
    const { profile } = await withProfile("Create");
    expect(profile.name).toBe("Create ramp");
    expect(profile.status).toBe("ACTIVE");
    expect(profile.isActive).toBe(true);
    expect(profile.revision).toBe(1);
    expect(profile.stageCount).toBe(3);
    expect(profile.coversThroughProductionDay).toBeNull();

    expect(profile.stages.map((s) => s.sequence)).toEqual([1, 2, 3]);
    expect(profile.stages.map((s) => s.targetEfficiencyPercent)).toEqual([40, 60, 80]);
    expect(profile.stages.map((s) => s.fromProductionDay)).toEqual([1, 4, 11]);
    expect(profile.stages.map((s) => s.toProductionDay)).toEqual([3, 10, null]);
    for (const s of profile.stages) {
      expect(s.stageId).toMatch(/^rst_[0-9a-f]{18}$/);
      expect(s.efficiencyUnit).toBe("PERCENT");
    }
    /* A stated assumption, and it says so. */
    expect(profile.canApprove).toBe(false);
    expect(profile.canRelease).toBe(false);
    expect(profile.describesActuals).toBe(false);
    expect(profile.history[0].type).toBe("RAMP_PROFILE_CREATED");
  });

  test("the order comes from the production days, not from the array", async () => {
    /* Shuffled on the way in. Two profiles with the same stages in different
       array orders are the same profile. */
    const w = await world("Order");
    const shuffled = await makeProfile(w.maker, w, ramped("Shuffled", [
      STAGES[2], STAGES[0], STAGES[1],
    ]));
    expect(shuffled.status).toBe(201);
    expect(shuffled.body.profile.stages.map((s) => s.fromProductionDay)).toEqual([1, 4, 11]);
    expect(shuffled.body.profile.stages.map((s) => s.targetEfficiencyPercent)).toEqual([40, 60, 80]);
    expect(shuffled.body.profile.stages.map((s) => s.sequence)).toEqual([1, 2, 3]);
  });

  test("a closed final stage publishes the day it covers through", async () => {
    const w = await world("Closed");
    const res = await makeProfile(w.maker, w, ramped("Closed ramp", [
      { fromProductionDay: 1, toProductionDay: 5, targetEfficiencyPercent: 50 },
      { fromProductionDay: 6, toProductionDay: 20, targetEfficiencyPercent: 75 },
    ]));
    expect(res.status).toBe(201);
    expect(res.body.profile.coversThroughProductionDay).toBe(20);
  });

  test("it lists newest first, filters by status and pages", async () => {
    const w = await world("List");
    const first = await makeProfile(w.maker, w, ramped("First ramp"));
    const second = await makeProfile(w.maker, w, ramped("Second ramp"));
    expect(second.status).toBe(201);

    const all = await listProfiles(w.maker, w);
    expect(all.body.profiles[0].rampProfileId).toBe(second.body.profile.rampProfileId);
    expect(all.body.sort).toBe("createdAt:desc,_id:desc");

    expect((await retireProfile(w.maker, w, first.body.profile.rampProfileId,
      { expectedRevision: 1 })).status).toBe(200);

    const active = await listProfiles(w.maker, w, "?status=ACTIVE");
    expect(active.body.profiles.map((p) => p.rampProfileId))
      .toEqual([second.body.profile.rampProfileId]);
    const retired = await listProfiles(w.maker, w, "?status=RETIRED");
    expect(retired.body.profiles.map((p) => p.rampProfileId))
      .toEqual([first.body.profile.rampProfileId]);
    /* Retired ones are listed and labelled, never hidden. */
    expect(retired.body.profiles[0].isActive).toBe(false);

    const bad = await listProfiles(w.maker, w, "?status=LAPSED");
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.fieldErrors[0].field).toBe("status");

    const paged = await listProfiles(w.maker, w, "?limit=1");
    expect(paged.body.profiles).toHaveLength(1);
    expect(paged.body.hasMore).toBe(true);
    const next = await listProfiles(w.maker, w, `?limit=1&cursor=${paged.body.nextCursor}`);
    expect(next.body.profiles[0].rampProfileId)
      .not.toBe(paged.body.profiles[0].rampProfileId);
  });

  test("one active name per company, released by retirement", async () => {
    const w = await world("Names");
    const first = await makeProfile(w.maker, w, ramped("Only one"));
    expect(first.status).toBe(201);

    const clash = await makeProfile(w.maker, w, ramped("only  ONE"));
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("IE_RAMP_PROFILE_NAME_TAKEN");
    expect(clash.body.error.details.fieldErrors[0]).toMatchObject({ field: "name", code: "TAKEN" });

    /* Retiring releases the name… */
    expect((await retireProfile(w.maker, w, first.body.profile.rampProfileId,
      { expectedRevision: 1 })).status).toBe(200);
    const second = await makeProfile(w.maker, w, ramped("Only one"));
    expect(second.status).toBe(201);

    /* …so restoring the first is refused rather than creating two of one name. */
    const restored = await restoreProfile(w.maker, w, first.body.profile.rampProfileId,
      { expectedRevision: 2 });
    expect(restored.status).toBe(409);
    expect(restored.body.error.code).toBe("IE_RAMP_PROFILE_NAME_TAKEN");
    expect(await IeRampProfile.countDocuments({ companyId: w.co._id, status: "ACTIVE" })).toBe(1);
  });
});

/* ══ 3. THE STAGES MUST TILE THE RUN ══════════════════════════════════════ */

describe("stages are validated strictly", () => {
  const refuse = async (w, stages) => {
    const layoutless = await makeProfile(w.maker, w, ramped(`Bad ${Math.random()}`, stages));
    expect(layoutless.status).toBe(400);
    expect(layoutless.body.error.code).toBe("IE_RAMP_STAGE_INVALID");
    return layoutless.body.error.details.fieldErrors;
  };

  test("overlapping stages are refused, naming the stage that overlaps", async () => {
    const w = await world("Overlap");
    const errs = await refuse(w, [
      { fromProductionDay: 1, toProductionDay: 5, targetEfficiencyPercent: 40 },
      { fromProductionDay: 4, toProductionDay: 10, targetEfficiencyPercent: 60 },
    ]);
    expect(errs[0]).toMatchObject({
      field: "stages.1.fromProductionDay", code: "OVERLAPS_PREVIOUS_STAGE", index: 1,
    });
    expect(errs[0].message).toContain("day 4");
  });

  test("a duplicated stage range is an overlap", async () => {
    const w = await world("Duplicate");
    const errs = await refuse(w, [
      { fromProductionDay: 1, toProductionDay: 5, targetEfficiencyPercent: 40 },
      { fromProductionDay: 1, toProductionDay: 5, targetEfficiencyPercent: 70 },
    ]);
    expect(errs[0].code).toBe("OVERLAPS_PREVIOUS_STAGE");
  });

  test("a gap is refused, because a day with no stage would be unknown not zero", async () => {
    const w = await world("Gap");
    const errs = await refuse(w, [
      { fromProductionDay: 1, toProductionDay: 3, targetEfficiencyPercent: 40 },
      { fromProductionDay: 7, toProductionDay: null, targetEfficiencyPercent: 80 },
    ]);
    expect(errs[0]).toMatchObject({
      field: "stages.1.fromProductionDay", code: "LEAVES_A_GAP", index: 1,
    });
    expect(errs[0].message).toContain("day 4");
    expect(errs[0].message).toMatch(/unknown, not zero/i);
  });

  test("a ramp starts on production day one", async () => {
    const w = await world("NotDayOne");
    const errs = await refuse(w, [
      { fromProductionDay: 2, toProductionDay: 5, targetEfficiencyPercent: 40 },
      { fromProductionDay: 6, toProductionDay: null, targetEfficiencyPercent: 80 },
    ]);
    expect(errs[0]).toMatchObject({ code: "MUST_START_AT_DAY_ONE", index: 0 });
  });

  test("only the last stage may be open-ended", async () => {
    const w = await world("OpenMiddle");
    const errs = await refuse(w, [
      { fromProductionDay: 1, toProductionDay: null, targetEfficiencyPercent: 40 },
      { fromProductionDay: 4, toProductionDay: 10, targetEfficiencyPercent: 60 },
    ]);
    expect(errs[0]).toMatchObject({
      field: "stages.0.toProductionDay", code: "OPEN_ENDED_NOT_LAST", index: 0,
    });
  });

  test("a stage cannot end before it begins", async () => {
    const w = await world("Backwards");
    const errs = await refuse(w, [
      { fromProductionDay: 5, toProductionDay: 2, targetEfficiencyPercent: 40 },
    ]);
    expect(errs.some((e) => e.field === "stages.0.toProductionDay" && e.code === "BEFORE_FROM")).toBe(true);
  });

  test("efficiency is a percentage greater than zero and at most 100", async () => {
    const w = await world("Percent");
    for (const [value, code] of [[0, "TOO_SMALL"], [-10, "TOO_SMALL"], [100.01, "TOO_LARGE"], [140, "TOO_LARGE"]]) {
      const errs = await refuse(w, [
        { fromProductionDay: 1, toProductionDay: null, targetEfficiencyPercent: value },
      ]);
      expect(errs[0]).toMatchObject({
        field: "stages.0.targetEfficiencyPercent", code, index: 0,
      });
    }
    /* Exactly 100 is a legal plan. */
    const full = await makeProfile(w.maker, w, ramped("Full", [
      { fromProductionDay: 1, toProductionDay: null, targetEfficiencyPercent: 100 },
    ]));
    expect(full.status).toBe(201);
    expect(full.body.profile.stages[0].targetEfficiencyPercent).toBe(100);
  });

  test("a missing, non-numeric or fractional production day is refused on its own field", async () => {
    const w = await world("Days");
    for (const [stage, field, code] of [
      [{ toProductionDay: 5, targetEfficiencyPercent: 40 }, "stages.0.fromProductionDay", "REQUIRED"],
      [{ fromProductionDay: "one", toProductionDay: 5, targetEfficiencyPercent: 40 }, "stages.0.fromProductionDay", "NOT_A_NUMBER"],
      [{ fromProductionDay: 1.5, toProductionDay: 5, targetEfficiencyPercent: 40 }, "stages.0.fromProductionDay", "NOT_AN_INTEGER"],
      [{ fromProductionDay: 0, toProductionDay: 5, targetEfficiencyPercent: 40 }, "stages.0.fromProductionDay", "TOO_SMALL"],
      [{ fromProductionDay: 99999, toProductionDay: null, targetEfficiencyPercent: 40 }, "stages.0.fromProductionDay", "TOO_LARGE"],
      [{ fromProductionDay: 1, toProductionDay: 5 }, "stages.0.targetEfficiencyPercent", "REQUIRED"],
      [{ fromProductionDay: 1, toProductionDay: 5, targetEfficiencyPercent: "Infinity" }, "stages.0.targetEfficiencyPercent", "NOT_FINITE"],
    ]) {
      const errs = await refuse(w, [stage]);
      expect(errs.some((e) => e.field === field && e.code === code)).toBe(true);
    }
    expect(await IeRampProfile.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a profile states at least one stage, and not too many", async () => {
    const w = await world("StageCount");
    for (const stages of [[], null]) {
      const res = await makeProfile(w.maker, w, ramped("Empty", stages));
      expect(res.status).toBe(400);
      expect(res.body.error.details.fieldErrors[0]).toMatchObject({ field: "stages", code: "REQUIRED" });
    }
    const notAList = await makeProfile(w.maker, w, ramped("NotAList", "three stages"));
    expect(notAList.body.error.details.fieldErrors[0].code).toBe("NOT_A_LIST");

    const tooMany = Array.from({ length: 61 }, (_, i) => ({
      fromProductionDay: i + 1, toProductionDay: i + 1, targetEfficiencyPercent: 50,
    }));
    const over = await makeProfile(w.maker, w, ramped("TooMany", tooMany));
    expect(over.body.error.details.fieldErrors[0].code).toBe("TOO_MANY");
    expect(await IeRampProfile.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a stage cannot carry an observation of what actually happened", async () => {
    const w = await world("NoActuals");
    for (const extra of [
      { actualEfficiencyPercent: 55 },
      { achievedEfficiencyPercent: 55 },
      { actualOutput: 900 },
      { goodOutput: 900 },
      { startDate: "2026-10-01" },
      { endDate: "2026-10-05" },
      { runStartedAt: "2026-10-01" },
      { workOrderId: String(w.workOrder._id) },
      { barcodeId: "WO-abc-1" },
      { scanId: "s1" },
      { machineId: String(new mongoose.Types.ObjectId()) },
      { employeeId: "GR0067" },
      { operatorId: "GR0067" },
      { attendance: [] },
      { stageId: "rst_deadbeef" },
      { sequence: 1 },
    ]) {
      const res = await makeProfile(w.maker, w, ramped(`Extra ${Object.keys(extra)[0]}`, [
        { fromProductionDay: 1, toProductionDay: null, targetEfficiencyPercent: 40, ...extra },
      ]));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(`stages.0.${Object.keys(extra)[0]}`);
    }
    /* And the profile itself refuses the same concepts at the top level. */
    for (const extra of [
      { companyId: String(w.co._id) }, { rampProfileId: "x" }, { status: "ACTIVE" },
      { revision: 2 }, { history: [] }, { nameKey: "X" },
      { calendarId: String(new mongoose.Types.ObjectId()) },
      { approvedAt: "2026-10-01" }, { releasedAt: "2026-10-01" },
      { availability: "AVAILABLE" }, { actualOutput: 5 },
    ]) {
      const res = await makeProfile(w.maker, w, { ...ramped("Top level"), ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect(await IeRampProfile.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ══ 4. EDIT, CONCURRENCY, NO-OP AND LIFECYCLE ════════════════════════════ */

describe("editing a profile moves one revision, or nothing at all", () => {
  test("a real edit names the changed groups and appends one event", async () => {
    const { w, profile } = await withProfile("Edit");
    const res = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision,
      name: "Edit ramp, revised",
      stages: [
        { label: "Week one", fromProductionDay: 1, toProductionDay: 5, targetEfficiencyPercent: 45 },
        { label: "Steady", fromProductionDay: 6, toProductionDay: null, targetEfficiencyPercent: 85 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.profile.revision).toBe(2);
    expect(res.body.profile.stageCount).toBe(2);
    expect(res.body.events[0]).toMatchObject({ type: "RAMP_PROFILE_EDITED", profileRevision: 2 });
    expect(res.body.events[0].changed.sort()).toEqual(["name", "stages"]);

    const stored = await IeRampProfile.findById(profile.rampProfileId).lean();
    expect(stored.history.map((e) => e.type))
      .toEqual(["RAMP_PROFILE_CREATED", "RAMP_PROFILE_EDITED"]);
    expect(stored.nameKey).toBe("EDIT RAMP, REVISED");
  });

  test("an unchanged stage keeps its id, and a new range gets a new one", async () => {
    const { w, profile } = await withProfile("StageIds");
    const [one, two, three] = profile.stages;
    const res = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision,
      stages: [
        { label: "Week one", fromProductionDay: 1, toProductionDay: 3, targetEfficiencyPercent: 40 },
        { label: "Settling", fromProductionDay: 4, toProductionDay: 12, targetEfficiencyPercent: 60 },
        { label: "Steady", fromProductionDay: 13, toProductionDay: null, targetEfficiencyPercent: 80 },
      ],
    });
    expect(res.status).toBe(200);
    const after = res.body.profile.stages;
    /* Days 1-3 did not move, so its id survives — a capacity standard that
       froze it can still be explained against this profile. */
    expect(after[0].stageId).toBe(one.stageId);
    /* Days 4-10 became 4-12: a different range, and a fresh id. */
    expect(after[1].stageId).not.toBe(two.stageId);
    expect(after[2].stageId).not.toBe(three.stageId);
  });

  test("identical normalised input is an honest no-op", async () => {
    const { w, profile } = await withProfile("NoOp");
    const before = await IeRampProfile.findById(profile.rampProfileId).lean();

    const res = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision,
      name: "  NoOp   ramp  ",
      description: "As agreed   with the floor",
      /* Same stages, shuffled and with the open end given explicitly as null. */
      stages: [STAGES[1], STAGES[2], STAGES[0]],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    expect(res.body.profile.revision).toBe(1);

    const after = await IeRampProfile.findById(profile.rampProfileId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(after.history).toHaveLength(before.history.length);
  });

  test("a stale request conflicts even when its outcome would be a no-op", async () => {
    const { w, profile } = await withProfile("Stale");
    const moved = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision, name: "Stale ramp, moved",
    });
    expect(moved.status).toBe(200);

    const stale = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision, name: "Stale ramp, moved",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_RAMP_PROFILE_REVISION_CONFLICT");
    expect(stale.body.error.details).toMatchObject({ expected: profile.revision, actual: 2 });
    expect((await IeRampProfile.findById(profile.rampProfileId).lean()).revision).toBe(2);
  });

  test("two simultaneous edits produce exactly one winner", async () => {
    const { w, profile } = await withProfile("Race");
    const [one, two] = await Promise.all([
      patchProfile(w.maker, w, profile.rampProfileId, {
        expectedRevision: profile.revision, description: "First writer",
      }),
      patchProfile(w.maker, w, profile.rampProfileId, {
        expectedRevision: profile.revision, description: "Second writer",
      }),
    ]);
    const winners = [one, two].filter((r) => r.status === 200 && r.body.updated === true);
    expect(winners).toHaveLength(1);
    const loser = [one, two].find((r) => r !== winners[0]);
    expect(loser.status).toBe(409);
    expect(loser.body.error.code).toBe("IE_RAMP_PROFILE_REVISION_CONFLICT");

    const stored = await IeRampProfile.findById(profile.rampProfileId).lean();
    expect(stored.revision).toBe(2);
    expect(stored.history.filter((e) => e.type === "RAMP_PROFILE_EDITED")).toHaveLength(1);
    expect(["First writer", "Second writer"]).toContain(stored.description);
  });

  test("retirement is reversible, deletes nothing and refuses twice", async () => {
    const { w, profile } = await withProfile("Lifecycle");
    const retired = await retireProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 1 });
    expect(retired.status).toBe(200);
    expect(retired.body.profile.status).toBe("RETIRED");
    expect(retired.body.profile.revision).toBe(2);
    expect(retired.body.events[0].type).toBe("RAMP_PROFILE_RETIRED");

    const again = await retireProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 2 });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("IE_RAMP_PROFILE_ALREADY_RETIRED");
    expect(again.body.error.details.allowedAction).toBe("RESTORE");

    /* A retired profile cannot be edited until it is restored. */
    const edit = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: 2, description: "While retired",
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("IE_RAMP_PROFILE_ALREADY_RETIRED");

    const restored = await restoreProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 2 });
    expect(restored.status).toBe(200);
    expect(restored.body.profile.status).toBe("ACTIVE");
    expect(restored.body.profile.revision).toBe(3);

    const restoredAgain = await restoreProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 3 });
    expect(restoredAgain.status).toBe(409);
    expect(restoredAgain.body.error.code).toBe("IE_RAMP_PROFILE_ALREADY_ACTIVE");

    /* The record was never deleted, and the whole trail is there. */
    const stored = await IeRampProfile.findById(profile.rampProfileId).lean();
    expect(stored.history.map((e) => e.type)).toEqual([
      "RAMP_PROFILE_CREATED", "RAMP_PROFILE_RETIRED", "RAMP_PROFILE_RESTORED",
    ]);
  });

  test("a stale retirement or restoration conflicts", async () => {
    const { w, profile } = await withProfile("StaleLifecycle");
    expect((await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: 1, description: "Moved on",
    })).status).toBe(200);

    const retire = await retireProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 1 });
    expect(retire.status).toBe(409);
    expect(retire.body.error.code).toBe("IE_RAMP_PROFILE_REVISION_CONFLICT");
    expect(retire.body.error.details).toMatchObject({ expected: 1, actual: 2 });

    expect((await retireProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 2 })).status).toBe(200);
    const restore = await restoreProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 2 });
    expect(restore.status).toBe(409);
    expect(restore.body.error.code).toBe("IE_RAMP_PROFILE_REVISION_CONFLICT");
  });

  test("the audit trail is bounded", async () => {
    const { w, profile } = await withProfile("Bounded");
    expect(IeRampProfile.LIMITS.HISTORY).toBe(200);
    let revision = profile.revision;
    for (let i = 0; i < 10; i += 1) {
      const res = await patchProfile(w.maker, w, profile.rampProfileId, {
        expectedRevision: revision, description: `Note ${i}`,
      });
      expect(res.status).toBe(200);
      revision = res.body.profile.revision;
    }
    const stored = await IeRampProfile.findById(profile.rampProfileId).lean();
    expect(stored.history).toHaveLength(11);
    expect(stored.history.length).toBeLessThanOrEqual(IeRampProfile.LIMITS.HISTORY);
    const read = await readProfile(w.maker, w, profile.rampProfileId);
    expect(read.body.profile.history[0].profileRevision).toBe(revision);
  });
});

/* ══ 5. A CAPACITY STANDARD FREEZES THE RAMP ══════════════════════════════ */

/** A world with a layout, a profile and a standard that froze its first stage.
 *  The capacity route helpers and the Chunk 7A `INPUTS` come from the shared
 *  fixture above — this suite adds no second copy of either. */
async function rampedStanding(name, stages = STAGES) {
  const { w, layout, profile } = await withProfile(name, stages);
  const made = await makeStandard(w.maker, w, layout.layoutId, {
    ...INPUTS,
    rampProfileId: profile.rampProfileId,
    rampStageId: profile.stages[0].stageId,
  });
  expect(made.status).toBe(201);
  return { w, layout, profile, standard: made.body.standard };
}

describe("applying a ramp freezes it onto the capacity standard", () => {
  test("the profile, revision, stage and percentage are all copied", async () => {
    const { profile, standard } = await rampedStanding("Freeze");
    const stage = profile.stages[0];

    expect(standard.ramp).toMatchObject({
      rampProfileId: profile.rampProfileId,
      rampProfileRevision: profile.revision,
      rampProfileName: profile.name,
      stageId: stage.stageId,
      stageSequence: 1,
      stageLabel: "Week one",
      fromProductionDay: 1,
      toProductionDay: 3,
      targetEfficiencyPercent: 40,
      efficiencyUnit: "PERCENT",
      basis: "STATED_IE_ASSUMPTION",
      describesActuals: false,
    });
    expect(standard.ramp.capturedAt).toBeTruthy();

    /* Stored, not merely published. */
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(String(stored.ramp.rampProfileId)).toBe(profile.rampProfileId);
    expect(stored.ramp.rampProfileRevision).toBe(profile.revision);
    expect(stored.ramp.targetEfficiencyPercent).toBe(40);
    /* And the creation event names the ramp as one of its input groups. */
    expect(standard.history[0].changed).toContain("ramp");
  });

  test("the ramp target uses Chunk 7A's calculator, rounding and floor", async () => {
    const { standard } = await rampedStanding("Calculate");
    /* SAM 4.5 · net 480 · 25 operators · 2 shifts.
         steady state at 60%: 480 × 25 × 0.60 / 4.5 = 1600 a shift
         ramp stage at 40%:   480 × 25 × 0.40 / 4.5 = 1066.666…  → 1066      */
    expect(standard.calculation.theoreticalPiecesPerShift).toBe(1600);
    expect(standard.calculation.wholePieceShiftTarget).toBe(1600);

    const r = standard.rampCalculation;
    expect(r.targetEfficiencyPercent).toBe(40);
    expect(r.theoreticalPiecesPerShift).toBe(1066.6667);
    expect(r.wholePieceShiftTarget).toBe(1066);
    expect(r.theoreticalPiecesPerDay).toBe(2133.3333);
    expect(r.wholePieceDailyTarget).toBe(2133);
    /* The same stated policies, from the one calculator. */
    expect(r.rounding).toBe("HALF_UP_4DP");
    expect(r.wholePiecePolicy).toBe("FLOOR");
    expect(r.netMinutesPerShift).toBe(standard.calculation.netMinutesPerShift);
    expect(r.garmentSamMinutes).toBe(standard.source.garmentSamMinutes);
    /* Floored, never rounded up. */
    expect(r.wholePieceShiftTarget).toBeLessThan(r.theoreticalPiecesPerShift);
    /* And the day is not the floored shift target multiplied out. */
    expect(r.wholePieceDailyTarget).not.toBe(r.wholePieceShiftTarget * 2);

    /* One calculator: the pure function reproduces the wire exactly. */
    expect(calculateCapacity({
      availableShiftMinutes: standard.inputs.availableShiftMinutes,
      breakMinutes: standard.inputs.breakMinutes,
      shiftsPerDay: standard.inputs.shiftsPerDay,
      plannedOperatorCount: standard.inputs.plannedOperatorCount,
      targetEfficiencyPercent: standard.ramp.targetEfficiencyPercent,
      garmentSamMinutes: standard.source.garmentSamMinutes,
    })).toEqual(r);
  });

  test("no ramp means null, never a target of zero", async () => {
    const { w, layout } = await withProfile("NoRamp");
    const made = await makeStandard(w.maker, w, layout.layoutId, INPUTS);
    expect(made.status).toBe(201);
    expect(made.body.standard.ramp).toBeNull();
    expect(made.body.standard.rampCalculation).toBeNull();
    expect(made.body.standard.history[0].changed).not.toContain("ramp");
    /* The steady-state figure is untouched by the ramp's absence. */
    expect(made.body.standard.calculation.theoreticalPiecesPerShift).toBe(1600);
  });

  test("a later profile edit or retirement rewrites nothing", async () => {
    const { w, profile, standard } = await rampedStanding("Immutable");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();

    /* First the dangerous edit: the SAME stage range, so its id survives, but a
       different percentage. A record that read the profile back instead of its
       own frozen copy would silently restate this standard's first-week target
       from forty per cent to twenty-five. */
    const repriced = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision,
      name: "Immutable ramp, repriced",
      stages: [
        { label: "Week one", fromProductionDay: 1, toProductionDay: 3, targetEfficiencyPercent: 25 },
        { label: "Settling", fromProductionDay: 4, toProductionDay: 10, targetEfficiencyPercent: 55 },
        { label: "Steady", fromProductionDay: 11, toProductionDay: null, targetEfficiencyPercent: 95 },
      ],
    });
    expect(repriced.status).toBe(200);
    expect(repriced.body.profile.revision).toBe(2);
    expect(repriced.body.profile.stages[0].stageId).toBe(standard.ramp.stageId);
    expect(repriced.body.profile.stages[0].targetEfficiencyPercent).toBe(25);

    const midway = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(midway.body.standard.ramp).toEqual(standard.ramp);
    expect(midway.body.standard.ramp.targetEfficiencyPercent).toBe(40);
    expect(midway.body.standard.ramp.rampProfileRevision).toBe(1);
    expect(midway.body.standard.ramp.rampProfileName).toBe("Immutable ramp");
    expect(midway.body.standard.rampCalculation.wholePieceShiftTarget).toBe(1066);

    /* Then restage it hard, and retire it entirely. */
    const edited = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: 2,
      stages: [
        { label: "Reworked", fromProductionDay: 1, toProductionDay: 8, targetEfficiencyPercent: 25 },
        { label: "Later", fromProductionDay: 9, toProductionDay: null, targetEfficiencyPercent: 95 },
      ],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.profile.revision).toBe(3);
    expect((await retireProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 3 })).status).toBe(200);

    const after = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(after.status).toBe(200);
    /* Every frozen fact is what it was, including the name AS IT WAS. */
    expect(after.body.standard.ramp).toEqual(standard.ramp);
    expect(after.body.standard.ramp.rampProfileRevision).toBe(1);
    expect(after.body.standard.ramp.rampProfileName).toBe("Immutable ramp");
    /* Not the repriced name, and not the repriced percentage. */
    expect(after.body.standard.ramp.rampProfileName).not.toContain("repriced");
    expect(after.body.standard.ramp.targetEfficiencyPercent).toBe(40);
    expect(after.body.standard.rampCalculation.wholePieceShiftTarget).toBe(1066);

    /* And nothing in the record moved. */
    const stored = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(stored.revision).toBe(before.revision);
    expect(stored.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(stored.history).toHaveLength(before.history.length);
    expect(stored.ramp.rampProfileRevision).toBe(1);
  });

  test("a re-application after an edit re-freezes, because somebody asked", async () => {
    const { w, profile, standard } = await rampedStanding("Reapply");
    const edited = await patchProfile(w.maker, w, profile.rampProfileId, {
      expectedRevision: profile.revision,
      stages: [
        { label: "Week one", fromProductionDay: 1, toProductionDay: 3, targetEfficiencyPercent: 50 },
        { label: "Steady", fromProductionDay: 4, toProductionDay: null, targetEfficiencyPercent: 80 },
      ],
    });
    expect(edited.status).toBe(200);
    /* Days 1-3 kept its id, so the same stage can be re-applied by name. */
    const stage = edited.body.profile.stages[0];
    expect(stage.stageId).toBe(profile.stages[0].stageId);
    expect(stage.targetEfficiencyPercent).toBe(50);

    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      rampProfileId: profile.rampProfileId,
      rampStageId: stage.stageId,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.events[0].changed).toEqual(["ramp"]);
    expect(res.body.standard.ramp.rampProfileRevision).toBe(2);
    expect(res.body.standard.ramp.targetEfficiencyPercent).toBe(50);
    /* 480 × 25 × 0.50 / 4.5 = 1333.333… → 1333 */
    expect(res.body.standard.rampCalculation.wholePieceShiftTarget).toBe(1333);
  });

  test("re-applying an unchanged stage is an honest no-op", async () => {
    const { w, profile, standard } = await rampedStanding("RampNoOp");
    const before = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      rampProfileId: profile.rampProfileId,
      rampStageId: profile.stages[0].stageId,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(false);
    expect(res.body.events).toEqual([]);
    const after = await IeCapacityStandard.findById(standard.capacityStandardId).lean();
    expect(after.revision).toBe(before.revision);
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  test("a stale ramp change conflicts rather than writing", async () => {
    const { w, profile, standard } = await rampedStanding("RampStale");
    const moved = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      rampStageId: profile.stages[1].stageId, rampProfileId: profile.rampProfileId,
    });
    expect(moved.status).toBe(200);
    const stale = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      rampStageId: profile.stages[2].stageId, rampProfileId: profile.rampProfileId,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_CAPACITY_STANDARD_REVISION_CONFLICT");
  });

  test("the ramp can be cleared, which is a real decision", async () => {
    const { w, standard } = await rampedStanding("Clear");
    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision, rampProfileId: null, rampStageId: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(true);
    expect(res.body.standard.ramp).toBeNull();
    expect(res.body.standard.rampCalculation).toBeNull();
    expect(res.body.events[0].changed).toEqual(["ramp"]);
    /* Clearing a standard that never had one changes nothing. */
    const again = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: res.body.standard.revision, rampProfileId: null, rampStageId: null,
    });
    expect(again.body.updated).toBe(false);
  });

  test("an unknown, foreign, retired or mismatched selection is refused, and writes nothing", async () => {
    const { w, layout, profile } = await withProfile("BadSelection");
    const theirs = await withProfile("TheirSelection");

    const cases = [
      [{ rampProfileId: String(new mongoose.Types.ObjectId()), rampStageId: profile.stages[0].stageId },
        404, "IE_RAMP_PROFILE_NOT_FOUND"],
      [{ rampProfileId: theirs.profile.rampProfileId, rampStageId: theirs.profile.stages[0].stageId },
        404, "IE_RAMP_PROFILE_NOT_FOUND"],
      [{ rampProfileId: "not-an-id", rampStageId: profile.stages[0].stageId },
        400, "IE_CAPACITY_STANDARD_INPUT_INVALID"],
      [{ rampProfileId: profile.rampProfileId, rampStageId: "rst_nosuchstage" },
        400, "IE_RAMP_STAGE_NOT_IN_PROFILE"],
      /* A stage from ANOTHER profile of this company: found, but not in this one. */
      [{ rampProfileId: profile.rampProfileId, rampStageId: theirs.profile.stages[0].stageId },
        400, "IE_RAMP_STAGE_NOT_IN_PROFILE"],
      [{ rampProfileId: profile.rampProfileId }, 400, "IE_CAPACITY_STANDARD_INPUT_INVALID"],
      [{ rampStageId: profile.stages[0].stageId }, 400, "IE_CAPACITY_STANDARD_INPUT_INVALID"],
    ];
    for (const [extra, status, code] of cases) {
      const res = await makeStandard(w.maker, w, layout.layoutId, { ...INPUTS, ...extra });
      expect(res.status).toBe(status);
      expect(res.body.error.code).toBe(code);
    }
    /* A foreign profile answers exactly as a missing one does. */
    const foreign = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, rampProfileId: theirs.profile.rampProfileId, rampStageId: theirs.profile.stages[0].stageId,
    });
    const ghost = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, rampProfileId: String(new mongoose.Types.ObjectId()), rampStageId: "rst_x",
    });
    expect(foreign.body.error.message).toBe(ghost.body.error.message);

    /* A retired profile cannot be newly applied. */
    expect((await retireProfile(w.maker, w, profile.rampProfileId, { expectedRevision: 1 })).status).toBe(200);
    const retired = await makeStandard(w.maker, w, layout.layoutId, {
      ...INPUTS, rampProfileId: profile.rampProfileId, rampStageId: profile.stages[0].stageId,
    });
    expect(retired.status).toBe(409);
    expect(retired.body.error.code).toBe("IE_RAMP_PROFILE_RETIRED");
    expect(retired.body.error.details.allowedAction).toBe("RESTORE");

    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a client cannot send a ramp efficiency or a ramp result", async () => {
    const { w, layout, profile } = await withProfile("RampRefused");
    for (const extra of [
      { rampTargetEfficiencyPercent: 95 },
      { rampEfficiencyPercent: 95 },
      { rampProfileRevision: 9 },
      { rampCalculation: {} },
      { ramp: { targetEfficiencyPercent: 95 } },
      { actualEfficiencyPercent: 55 },
      { productionDay: 4 },
    ]) {
      const res = await makeStandard(w.maker, w, layout.layoutId, {
        ...INPUTS, rampProfileId: profile.rampProfileId,
        rampStageId: profile.stages[0].stageId, ...extra,
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
      expect(res.body.error.details.field).toBe(Object.keys(extra)[0]);
    }
    expect(await IeCapacityStandard.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a ramp changes nothing about the working-time verdict", async () => {
    /* No calendar exists to prove a working time, and a ramp does not pretend
       to be one: the linkage stays unknown and the readiness stays provisional. */
    const { standard } = await rampedStanding("StillUnknown");
    expect(standard.calendarLinkage.state).toBe("UNKNOWN");
    expect(standard.calendarLinkage.reason).toBe("NO_COMPANY_SCOPED_WORKING_TIME_CALENDAR");
    expect(standard.workingTimeSource.kind).toBe("IE_PLANNING_ASSUMPTION");
    expect(standard.workingTimeSource.calendarId).toBeNull();
    expect(standard.readiness.state).toBe("PROVISIONAL");
    expect(standard.readiness.gaps.map((g) => g.code)).toContain("IE_CAPACITY_WORKING_TIME_ASSUMED");
    /* And the ramp is nowhere named as provenance for the working time. */
    const assumed = standard.readiness.gaps.find((g) => g.code === "IE_CAPACITY_WORKING_TIME_ASSUMED");
    expect(assumed.requiredUpstreamContract).toBe("COMPANY_SCOPED_VERSIONED_WORKING_TIME_CALENDAR");
    expect(JSON.stringify(standard.calendarLinkage)).not.toMatch(/ramp/i);
  });

  test("the source freeze still governs a ramped standard", async () => {
    const { w, layout, standard } = await rampedStanding("SourceStillRules");
    /* Move the line configuration only. */
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: layout.revision,
      stations: [{
        label: "Consolidated", plannedMachineTypes: [{ machineType: "SNLS", quantity: 3 }],
        assignments: layout.source.rows.map((r) => ({ rowId: r.rowId })),
      }],
    });
    expect(saved.body.layout.revision).toBe(layout.revision + 1);

    const read = await readStandard(w.maker, w, standard.capacityStandardId);
    expect(read.body.standard.source.state).toBe("SOURCE_CHANGED");
    expect(read.body.standard.editable).toBe(false);
    expect(read.body.standard.readiness.state).toBe("BLOCKED");
    /* The frozen ramp and its target survive as evidence. */
    expect(read.body.standard.ramp.targetEfficiencyPercent).toBe(40);
    expect(read.body.standard.rampCalculation.wholePieceShiftTarget).toBe(1066);

    /* And a ramp change cannot be used to edit past the freeze. */
    const res = await patchStandard(w.maker, w, standard.capacityStandardId, {
      expectedRevision: standard.revision,
      rampProfileId: standard.ramp.rampProfileId, rampStageId: standard.ramp.stageId,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("IE_CAPACITY_STANDARD_SOURCE_CHANGED");
  });
});

/* ══ 6. THE VERBS THAT DO NOT EXIST ═══════════════════════════════════════ */

describe("this chunk states an assumption and does nothing else", () => {
  test("there is no approve, release, apply, book or actuals endpoint", async () => {
    const { w, profile } = await withProfile("NoVerbs");
    const id = profile.rampProfileId;
    for (const [method, path] of [
      ["POST", `/ramp-profiles/${id}/approve`],
      ["POST", `/ramp-profiles/${id}/submit`],
      ["POST", `/ramp-profiles/${id}/release`],
      ["POST", `/ramp-profiles/${id}/publish`],
      ["POST", `/ramp-profiles/${id}/acknowledge`],
      ["POST", `/ramp-profiles/${id}/apply`],
      ["POST", `/ramp-profiles/${id}/book`],
      ["POST", `/ramp-profiles/${id}/actuals`],
      ["POST", `/ramp-profiles/${id}/scan`],
      ["DELETE", `/ramp-profiles/${id}`],
    ]) {
      const res = await call(path, { method, body: {}, token: w.maker.token, company: w.co._id });
      expect(res.status).toBe(404);
      expect(res.body?.error?.code).not.toBe("IE_WRITE_FORBIDDEN");
    }
    expect(await IeRampProfile.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("no Production, machine, employee or barcode concept appears in the payload", async () => {
    const { profile } = await withProfile("CleanPayload");
    const wire = JSON.stringify(profile);
    for (const forbidden of [
      "machineId", "serialNumber", "assetId", "availability", "maintenanceStatus",
      "employeeId", "operatorId", "attendance", "shiftName",
      "barcodeId", "scanId", "workOrderId", "productionScheduleId",
      "actualOutput", "achievedEfficiencyPercent", "startDate", "runStartedAt",
      "approvedAt", "releasedAt", "acknowledgedAt", "calendarId",
    ]) {
      expect(wire).not.toContain(`"${forbidden}"`);
    }
  });

  test("the routes this chunk added are exactly the six it was asked for", async () => {
    const router = require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes");
    const paths = router.stack.filter((l) => l.route)
      .filter((l) => String(l.route.path).includes("ramp"))
      .map((l) => `${Object.keys(l.route.methods)[0].toUpperCase()} ${l.route.path}`)
      .sort();
    expect(paths).toEqual([
      "GET /ramp-profiles",
      "GET /ramp-profiles/:rampProfileId",
      "PATCH /ramp-profiles/:rampProfileId",
      "POST /ramp-profiles",
      "POST /ramp-profiles/:rampProfileId/restore",
      "POST /ramp-profiles/:rampProfileId/retire",
    ]);
    /* And no ramp route carries a verb this boundary excludes. */
    expect(paths.filter((p) => /approve|submit|release|publish|acknowledge|book|allocate|scan|barcode|delete/i.test(p)))
      .toEqual([]);
  });
});
