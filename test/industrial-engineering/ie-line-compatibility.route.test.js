// test/industrial-engineering/ie-line-compatibility.route.test.js
//
// IE CHUNK 6B — REQUIRED-MACHINE COMPATIBILITY, AT THE WIRE.
//
// The rule this slice exists to protect: a layout is never judged by re-reading
// the operation library's current requirements. `IeOperation.requirements` holds
// ONE profile — today's — and its history records which categories somebody
// touched, never their values, so the requirements as of an older operation
// revision are unrecoverable. A row therefore FREEZES what its operation
// required when it was authored, and a row without that evidence reports
// UNKNOWN for ever — never compatible, never incompatible, never zero.
//
//   · new and explicitly replaced rows capture the evidence; a note, a proposed
//     SAM or a reorder preserves it byte-for-byte;
//   · editing an operation's requirements afterwards restates nothing;
//   · a station states planned machine TYPES and counts — no machine, no
//     availability, no operator, no shift;
//   · compatibility is decided by the server from frozen evidence and cannot be
//     submitted by a client;
//   · new evidence supersedes a layout exactly as a new approval does.
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

const layoutService = require("../../services/industrialEngineering/ieLineLayout.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  await IeLineLayout.syncIndexes();
  await IeStyleFile.syncIndexes();
  await IeOperation.syncIndexes();
  await IeMethodStudy.syncIndexes();
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

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `cx${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `X${n}`, email, biometricId: `CX${n}`,
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
 * A company, a file, and two operations whose 5A machine requirements are
 * configured before any bulletin row is authored — so the rows freeze real
 * evidence. Each row gets an approved standard time of one minute.
 */
async function world(name, { requirements = [[{ machineType: "SNLS", quantity: 1 }], [{ machineType: "Overlock 4T", quantity: 2 }]] } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01") });
  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `SJ-${name}-${n}`, companyId: co._id, accountId,
    ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: `J ${name}`, isActive: true,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${name}-${n}`, journeyId: journey._id, accountId, companyId: co._id,
    title: `E ${name}`, isActive: true, products: [{ product: "Tee", quantity: 500 }],
  });
  const item = await StockItem.create({
    name: `Tee ${name}`, sku: `SKU-${name}-${n}`, reference: `REF-${name}-${n}`, category: "Garment",
    createdBy: new mongoose.Types.ObjectId(), quantityOnHand: 0, minStock: 0, maxStock: 10,
    variants: [{ sku: `VAR-${name}-${n}`, cost: 0, salesPrice: 0 }],
  });
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${n}`, stockItemId: item._id, stockItemName: item.name,
    stockItemReference: item.reference, quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: "Tee", styleCode: `ST-${name}`, variantLabel: "Navy",
    journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
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

  /* A published 0% allowance policy so a standard time can be approved. */
  const author = await editorIn(co);
  const policy = await call("/allowance-policies", {
    method: "POST", token: author.token, company: co._id,
    body: { name: "No allowance", effectiveFrom: "2026-01-01", categories: [] },
  });
  await call(`/allowance-policies/${policy.body.policy.policyId}/publish`, {
    method: "POST", token: approver.token, company: co._id, body: { expectedRevision: 1 },
  });

  const file = (await call(`/orders/${wo._id}/styles/${style._id}/engineering-file`, {
    method: "POST", ...t, body: {},
  })).body.file;

  /* Operations, each with its Chunk 5A requirement profile configured FIRST. */
  const operations = [];
  for (let i = 0; i < requirements.length; i += 1) {
    const op = (await call("/operations/library", {
      method: "POST", ...t, body: { code: `OP-${n}-${i + 1}`, name: `Operation ${i + 1}`, machineType: "SNLS" },
    })).body.operation;
    const configured = await call(`/operations/library/${op.operationId}/requirements`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: op.revision,
        machineRequirements: requirements[i],
        attachmentRequirements: [],
        labourRequirements: [],
      },
    });
    expect(configured.status).toBe(200);
    operations.push(configured.body.operation);
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

  for (const row of rows) {
    const opened = await call(`/engineering-files/${file.fileId}/bulletin/${row.rowId}/method-studies`, {
      method: "POST", ...t, body: {},
    });
    const studyId = opened.body.study.studyId;
    const filled = await call(`/method-studies/${studyId}`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "Line 4",
        methodNote: "Method", ratingPercent: 100, observations: [{ durationSeconds: 60 }],
      },
    });
    const submitted = await call(`/method-studies/${studyId}/submit`, {
      method: "POST", ...t,
      body: { expectedRevision: filled.body.study.revision, manualStandardTimeMinutes: 1, overrideReason: "Fixed for the exercise." },
    });
    await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: approver.token, company: co._id,
      body: { expectedRevision: submitted.body.study.revision },
    });
  }

  /* Chunk 7C2: a layout is opened against an APPROVED bulletin version. */
  const version = await approveBulletinVersion({ co, maker, approver, fileId: file.fileId });

  return {
    co, maker, approver, fileId: file.fileId, rows, operations,
    fileRevision: version.fileRevision, fileRevisionNow: version.fileRevisionNow,
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



/** Approve the bulletin as it now stands, as the next version — Chunk 7C2. */
async function reapprove(w) {
  const next = await approveBulletinVersion({
    co: w.co, maker: w.maker, approver: w.approver, fileId: w.fileId,
  });
  w.bulletinVersion = next.version;
  w.fileRevision = next.fileRevision;
  w.fileRevisionNow = next.fileRevisionNow;
  return next;
}

const openLayout = (a, w) => call(`/engineering-files/${w.fileId}/line-layouts`, {
  method: "POST", token: a.token, company: w.co._id, body: {},
});
const readLayout = (a, w, id) => call(`/line-layouts/${id}`, { token: a.token, company: w.co._id });
const patchLayout = (a, w, id, body) => call(`/line-layouts/${id}`, {
  method: "PATCH", token: a.token, company: w.co._id, body,
});
const bulletinPatch = (w, rows, expectedRevision) => call(`/engineering-files/${w.fileId}/bulletin`, {
  method: "PATCH", token: w.maker.token, company: w.co._id, body: { expectedRevision, rows },
});
const resend = (w) => w.rows.map((r) => ({ rowId: r.rowId, ieOperationId: r.ieOperationId, proposedSamMinutes: r.proposedSamMinutes }));

/* ══ 1. THE FREEZE ════════════════════════════════════════════════════════ */

describe("freezing the required-machine evidence", () => {
  test("a new row captures what its operation required at that moment", async () => {
    const w = await world("Freeze");
    const file = await call(`/orders/${(await WorkOrder.findOne({ workOrderNumber: new RegExp("^WO-Freeze") }).lean())._id}/styles/x/engineering-file`, {
      token: w.maker.token, company: w.co._id,
    });
    expect(file.status).toBeGreaterThanOrEqual(400); // the order path needs the real style; read the file directly instead

    const stored = await IeStyleFile.findById(w.fileId).lean();
    expect(stored.bulletin.rows).toHaveLength(2);
    expect(stored.bulletin.rows[0].requirementSnapshot).toMatchObject({
      requirementsConfigured: true,
      ieOperationRevision: stored.bulletin.rows[0].ieOperationRevision,
      machineTypes: [{ machineType: "SNLS", quantity: 1 }],
    });
    expect(stored.bulletin.rows[1].requirementSnapshot.machineTypes)
      .toEqual([{ machineType: "Overlock 4T", quantity: 2 }]);
    expect(stored.bulletin.rows[0].requirementSnapshot.capturedAt).toBeTruthy();
  });

  test("a note, a proposed SAM and a reorder all preserve the frozen evidence", async () => {
    const w = await world("Preserve");
    const before = await IeStyleFile.findById(w.fileId).lean();
    const captured = before.bulletin.rows.map((r) => r.requirementSnapshot);

    const noted = await bulletinPatch(w, resend(w).map((r, i) => (i === 0 ? { ...r, note: "watch tension" } : r)), w.fileRevisionNow);
    expect(noted.status).toBe(200);
    const reSammed = await bulletinPatch(
      w, resend(w).map((r, i) => (i === 0 ? { ...r, note: "watch tension", proposedSamMinutes: 4 } : r)),
      noted.body.file.revision,
    );
    const flipped = await bulletinPatch(
      w,
      [
        { ...resend(w)[1] },
        { ...resend(w)[0], note: "watch tension", proposedSamMinutes: 4 },
      ],
      reSammed.body.file.revision,
    );
    expect(flipped.status).toBe(200);

    const after = await IeStyleFile.findById(w.fileId).lean();
    const byRow = new Map(after.bulletin.rows.map((r) => [r.rowId, r]));
    for (let i = 0; i < before.bulletin.rows.length; i += 1) {
      const row = byRow.get(before.bulletin.rows[i].rowId);
      expect(row.requirementSnapshot.machineTypes).toEqual(captured[i].machineTypes);
      expect(row.requirementSnapshot.capturedAt.toISOString()).toBe(captured[i].capturedAt.toISOString());
      expect(row.requirementSnapshot.ieOperationRevision).toBe(captured[i].ieOperationRevision);
    }
  });

  test("editing an operation's requirements afterwards restates nothing", async () => {
    const w = await world("NoRestate");
    const before = await IeStyleFile.findById(w.fileId).lean();
    const capturedAt = before.bulletin.rows[0].requirementSnapshot.capturedAt.toISOString();

    /* The library moves on: a different machine type entirely. */
    const changed = await call(`/operations/library/${w.operations[0].operationId}/requirements`, {
      method: "PATCH", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: w.operations[0].revision, machineRequirements: [{ machineType: "Bartack", quantity: 5 }] },
    });
    expect(changed.status).toBe(200);

    const after = await IeStyleFile.findById(w.fileId).lean();
    expect(after.bulletin.rows[0].requirementSnapshot.machineTypes)
      .toEqual([{ machineType: "SNLS", quantity: 1 }]);
    expect(after.bulletin.rows[0].requirementSnapshot.capturedAt.toISOString()).toBe(capturedAt);
    expect(after.revision).toBe(before.revision);
  });

  test("explicitly replacing a row's operation captures the new requirement version", async () => {
    const w = await world("Replace");
    const before = await IeStyleFile.findById(w.fileId).lean();

    const replaced = await bulletinPatch(w, [
      { rowId: w.rows[0].rowId, ieOperationId: w.operations[1].operationId, proposedSamMinutes: 1 },
      resend(w)[1],
    ], w.fileRevisionNow);
    expect(replaced.status).toBe(200);

    const after = await IeStyleFile.findById(w.fileId).lean();
    const row = after.bulletin.rows[0];
    /* The new operation's evidence, captured now. */
    expect(row.requirementSnapshot.machineTypes).toEqual([{ machineType: "Overlock 4T", quantity: 2 }]);
    expect(row.requirementSnapshot.capturedAt.toISOString())
      .not.toBe(before.bulletin.rows[0].requirementSnapshot.capturedAt.toISOString());
  });

  test("a row authored before the freeze existed stays unprovable, and is never backfilled", async () => {
    const w = await world("Legacy");
    /* Exactly a pre-6B record: the field simply is not there. */
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(w.fileId) },
      { $unset: { "bulletin.rows.0.requirementSnapshot": "" } },
    );
    const read = await call(`/engineering-files/${w.fileId}/history`, { token: w.maker.token, company: w.co._id });
    expect(read.status).toBe(200);

    /* CHUNK 7C2: a layout balances an APPROVED bulletin version, so the
       unprovable row has to reach one. Re-approving after the surgery snapshots
       the row exactly as it now stands — with nothing where its evidence was,
       which is what a pre-6B row looks like and what must never be invented. */
    await reapprove(w);

    const layout = (await openLayout(w.maker, w)).body.layout;
    expect(layout.source.rows[0].requirementSnapshot).toBeNull();
    expect(layout.source.rows[0].requirementEvidence).toBe("NOT_PROVABLE");
    /* And no read invented one. */
    const stored = await IeStyleFile.findById(w.fileId).lean();
    expect(stored.bulletin.rows[0].requirementSnapshot ?? null).toBeNull();
  });
});

/* ══ 2. COMPATIBILITY ═════════════════════════════════════════════════════ */

describe("required-machine compatibility", () => {
  async function laid(name, opts) {
    const w = await world(name, opts);
    const layout = (await openLayout(w.maker, w)).body.layout;
    return { w, layout };
  }
  const stationsFor = (w, plans) => plans.map((p) => ({
    assignments: p.rows.map((rowId) => ({ rowId })),
    ...(p.plannedMachineTypes ? { plannedMachineTypes: p.plannedMachineTypes } : {}),
    ...(p.label ? { label: p.label } : {}),
  }));

  test("a station planning the required types is compatible", async () => {
    const { w, layout } = await laid("Compatible");
    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: stationsFor(w, [
        { rows: [w.rows[0].rowId], plannedMachineTypes: [{ machineType: "snls", quantity: 1 }] },
        { rows: [w.rows[1].rowId], plannedMachineTypes: [{ machineType: "Overlock 4T", quantity: 3 }] },
      ]),
    });

    expect(res.status).toBe(200);
    const stations = res.body.layout.stations;
    expect(stations[0].plannedMachineTypes).toEqual([{ machineType: "snls", quantity: 1 }]);
    expect(stations[0].assignments[0].machineTypeCompatibility).toMatchObject({
      state: "COMPATIBLE", reason: "STATION_PLANS_REQUIRED_MACHINE_TYPES",
      requiredMachineTypes: [{ machineType: "SNLS", quantity: 1 }], missingMachineTypes: [],
    });
    /* Case and spacing are not a difference: "snls" plans SNLS. */
    expect(stations[1].assignments[0].machineTypeCompatibility.state).toBe("COMPATIBLE");
    expect(res.body.layout.machineTypeCompatibility).toEqual({
      evaluated: 2, compatible: 2, incompatible: 0, unknown: 0, state: "COMPATIBLE",
    });
    expect(res.body.layout.readiness.gaps.map((g) => g.code)).toEqual([]);
    expect(res.body.layout.readiness.ready).toBe(true);
  });

  test("a missing type and too few machines are both incompatible, and say which", async () => {
    const { w, layout } = await laid("Incompatible");
    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: stationsFor(w, [
        { rows: [w.rows[0].rowId], plannedMachineTypes: [{ machineType: "Bartack", quantity: 4 }] },
        { rows: [w.rows[1].rowId], plannedMachineTypes: [{ machineType: "Overlock 4T", quantity: 1 }] },
      ]),
    });

    const [first, second] = res.body.layout.stations;
    expect(first.assignments[0].machineTypeCompatibility).toMatchObject({
      state: "INCOMPATIBLE", reason: "STATION_MISSING_REQUIRED_MACHINE_TYPE",
    });
    expect(first.assignments[0].machineTypeCompatibility.missingMachineTypes)
      .toEqual([{ machineType: "SNLS", quantity: 1, planned: 0, reason: "STATION_MISSING_REQUIRED_MACHINE_TYPE" }]);
    /* Requires two, station plans one. */
    expect(second.assignments[0].machineTypeCompatibility).toMatchObject({
      state: "INCOMPATIBLE", reason: "STATION_PLANS_TOO_FEW_MACHINES",
    });
    expect(second.assignments[0].machineTypeCompatibility.missingMachineTypes[0])
      .toMatchObject({ machineType: "Overlock 4T", quantity: 2, planned: 1 });

    expect(res.body.layout.machineTypeCompatibility).toMatchObject({ incompatible: 2, state: "INCOMPATIBLE" });
    const gap = res.body.layout.readiness.gaps.find((g) => g.code === "IE_LAYOUT_OPERATION_STATION_INCOMPATIBLE");
    expect(gap.rowIds.sort()).toEqual([w.rows[0].rowId, w.rows[1].rowId].sort());
    expect(gap.missingMachineTypes.sort()).toEqual(["Overlock 4T", "SNLS"]);
  });

  test("unprovable, unconfigured and unstated inputs are UNKNOWN, never zero", async () => {
    /* One operation with NO requirement profile configured. */
    const w = await world("Unknowns", { requirements: [[{ machineType: "SNLS", quantity: 1 }]] });
    const bare = (await call("/operations/library", {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { code: `BARE-${++seq}`, name: "Unconfigured" },
    })).body.operation;
    const added = await bulletinPatch(w, [
      ...resend(w),
      { ieOperationId: bare.operationId, proposedSamMinutes: 1 },
    ], w.fileRevisionNow);
    expect(added.status).toBe(200);
    const bareRow = added.body.file.bulletin.rows.at(-1);
    expect(bareRow.requirementSnapshot.requirementsConfigured).toBe(false);

    /* Approve a standard time for the new row so a layout can open. */
    const t = { token: w.maker.token, company: w.co._id };
    const opened = await call(`/engineering-files/${w.fileId}/bulletin/${bareRow.rowId}/method-studies`, { method: "POST", ...t, body: {} });
    const filled = await call(`/method-studies/${opened.body.study.studyId}`, {
      method: "PATCH", ...t,
      body: { expectedRevision: 1, studiedAt: "2026-09-08T04:30:00.000Z", location: "L", methodNote: "M", ratingPercent: 100, observations: [{ durationSeconds: 60 }] },
    });
    const submitted = await call(`/method-studies/${opened.body.study.studyId}/submit`, {
      method: "POST", ...t, body: { expectedRevision: filled.body.study.revision, manualStandardTimeMinutes: 1, overrideReason: "Fixed." },
    });
    await call(`/method-studies/${opened.body.study.studyId}/approve`, {
      method: "POST", token: w.approver.token, company: w.co._id, body: { expectedRevision: submitted.body.study.revision },
    });

    /* Strip the first row's evidence, as a pre-6B record has none. */
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(w.fileId) },
      { $unset: { "bulletin.rows.0.requirementSnapshot": "" } },
    );
    await reapprove(w);

    const layout = (await openLayout(w.maker, w)).body.layout;
    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [
        /* row 0: no evidence · row 1 (bare): evidence but unconfigured */
        { assignments: [{ rowId: layout.source.rows[0].rowId }, { rowId: bareRow.rowId }],
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 9 }] },
      ],
    });

    const verdicts = res.body.layout.stations[0].assignments.map((a) => a.machineTypeCompatibility);
    expect(verdicts[0]).toMatchObject({ state: "UNKNOWN", reason: "REQUIREMENTS_NOT_PROVABLE", requiredMachineTypes: null });
    expect(verdicts[1]).toMatchObject({ state: "UNKNOWN", reason: "REQUIREMENTS_NOT_CONFIGURED" });
    /* Not compatible, not incompatible, and not a zero. */
    expect(res.body.layout.machineTypeCompatibility).toMatchObject({ unknown: 2, compatible: 0, incompatible: 0, state: "UNKNOWN" });
    for (const v of verdicts) expect(v.missingMachineTypes).toEqual([]);
    const codes = res.body.layout.readiness.gaps.map((g) => g.code);
    expect(codes).toContain("IE_LAYOUT_REQUIREMENTS_NOT_PROVABLE");
    expect(codes).toContain("IE_LAYOUT_REQUIREMENTS_NOT_CONFIGURED");
  });

  test("a station with no plan is UNKNOWN, and an operation needing no machine is compatible", async () => {
    const w = await world("NoneAndNothing", { requirements: [[]] });
    const layout = (await openLayout(w.maker, w)).body.layout;
    /* The operation is CONFIGURED as needing no machine — that is an answer. */
    expect(layout.source.rows[0].requirementSnapshot).toMatchObject({ requirementsConfigured: true, machineTypes: [] });

    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1, stations: [{ assignments: [{ rowId: w.rows[0].rowId }] }],
    });
    expect(res.body.layout.stations[0].assignments[0].machineTypeCompatibility)
      .toMatchObject({ state: "COMPATIBLE", reason: "NO_MACHINE_REQUIRED" });

    /* A station that plans nothing, for an operation that DOES need a machine. */
    const other = await world("StationSilent");
    const l2 = (await openLayout(other.maker, other)).body.layout;
    const res2 = await patchLayout(other.maker, other, l2.layoutId, {
      expectedRevision: 1, stations: [{ assignments: other.rows.map((r) => ({ rowId: r.rowId })) }],
    });
    expect(res2.body.layout.stations[0].assignments[0].machineTypeCompatibility)
      .toMatchObject({ state: "UNKNOWN", reason: "STATION_MACHINE_TYPE_MISSING" });
    expect(res2.body.layout.readiness.gaps.map((g) => g.code)).toContain("IE_LAYOUT_STATION_MACHINE_TYPE_MISSING");
  });

  test("a station planning types with nothing placed is surfaced, not silently ignored", async () => {
    const { w, layout } = await laid("UnusedPlan");
    const res = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [
        { assignments: w.rows.map((r) => ({ rowId: r.rowId })), plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }, { machineType: "Overlock 4T", quantity: 2 }] },
        { assignments: [], plannedMachineTypes: [{ machineType: "Bartack", quantity: 1 }], label: "Spare" },
      ],
    });
    const gap = res.body.layout.readiness.gaps.find((g) => g.code === "IE_LAYOUT_STATION_MACHINE_TYPE_UNUSED");
    expect(gap.stationIds).toEqual([res.body.layout.stations[1].stationId]);
    expect(res.body.layout.machineTypeCompatibility.state).toBe("COMPATIBLE");
  });

  test("a client cannot submit a verdict, a plan quantity of zero, or a duplicate type", async () => {
    const { w, layout } = await laid("Refusals");
    const rowId = w.rows[0].rowId;
    for (const [stations, code] of [
      [[{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "SNLS", quantity: 0 }] }], "IE_LAYOUT_STATION_MACHINE_TYPE_INVALID"],
      [[{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1.5 }] }], "IE_LAYOUT_STATION_MACHINE_TYPE_INVALID"],
      [[{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "", quantity: 1 }] }], "IE_LAYOUT_STATION_MACHINE_TYPE_INVALID"],
      [[{ assignments: [{ rowId }], plannedMachineTypes: "SNLS" }], "IE_LAYOUT_STATION_MACHINE_TYPE_INVALID"],
      [[{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }, { machineType: "snls", quantity: 2 }] }], "IE_LAYOUT_STATION_MACHINE_TYPE_DUPLICATE"],
    ]) {
      const res = await patchLayout(w.maker, w, layout.layoutId, { expectedRevision: 1, stations });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe(code);
    }

    /* Server-owned outputs and Production's identifiers are refused by name. */
    for (const stations of [
      [{ assignments: [{ rowId, machineTypeCompatibility: { state: "COMPATIBLE" } }] }],
      [{ assignments: [{ rowId }], compatibility: "COMPATIBLE" }],
      [{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1, available: 4 }] }],
      [{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1, machineId: String(new mongoose.Types.ObjectId()) }] }],
      [{ assignments: [{ rowId }], plannedMachineTypes: [{ machineType: "SNLS", quantity: 1, serialNumber: "SN-1" }] }],
      [{ assignments: [{ rowId }], barcodeId: "WO-abc-1" }],
      [{ assignments: [{ rowId }], operatorIdentityId: "GR0067" }],
      [{ assignments: [{ rowId }], activeOps: ["SJ-01"] }],
    ]) {
      const res = await patchLayout(w.maker, w, layout.layoutId, { expectedRevision: 1, stations });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    expect((await IeLineLayout.findById(layout.layoutId).lean()).revision).toBe(1);
  });

  test("a viewer reads compatibility and cannot plan a station", async () => {
    const { w, layout } = await laid("Roles");
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [{ assignments: w.rows.map((r) => ({ rowId: r.rowId })), plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }] }],
    });
    expect(saved.status).toBe(200);

    const viewer = await viewerIn(w.co);
    const seen = await readLayout(viewer, w, layout.layoutId);
    expect(seen.status).toBe(200);
    expect(seen.body.layout.machineTypeCompatibility.state).toBe("INCOMPATIBLE");
    const refused = await patchLayout(viewer, w, layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
      stations: [{ assignments: [], plannedMachineTypes: [] }],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe("IE_WRITE_FORBIDDEN");
  });

  test("a foreign layout's compatibility is not disclosed", async () => {
    const theirs = await world("TheirCompat");
    const theirLayout = (await openLayout(theirs.maker, theirs)).body.layout;
    await patchLayout(theirs.maker, theirs, theirLayout.layoutId, {
      expectedRevision: 1,
      stations: [{ assignments: theirs.rows.map((r) => ({ rowId: r.rowId })), plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }] }],
    });
    const mine = await world("MyCompat");
    const foreign = await readLayout(mine.maker, mine, theirLayout.layoutId);
    const invented = await readLayout(mine.maker, mine, new mongoose.Types.ObjectId());
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(invented.body);
    expect(JSON.stringify(foreign.body)).not.toMatch(/SNLS|COMPATIBLE|Overlock/);
  });
});

/* ══ 3. NEW EVIDENCE SUPERSEDES ═══════════════════════════════════════════ */

describe("evidence and supersession", () => {
  test("replacing a row's operation changes the successor draft, not the layout", async () => {
    const w = await world("Supersede");
    const layout = (await openLayout(w.maker, w)).body.layout;
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [{ assignments: w.rows.map((r) => ({ rowId: r.rowId })), plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }, { machineType: "Overlock 4T", quantity: 2 }] }],
    });
    expect(saved.body.layout.machineTypeCompatibility.state).toBe("COMPATIBLE");
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    /* Replace row 0's operation: new evidence, and a new bulletin revision. */
    const replaced = await bulletinPatch(w, [
      { rowId: w.rows[0].rowId, ieOperationId: w.operations[1].operationId, proposedSamMinutes: 1 },
      resend(w)[1],
    ], w.fileRevisionNow);
    expect(replaced.status).toBe(200);

    /* ── CHUNK 7C2: THE EDIT ALONE DOES NOT REACH THE LAYOUT ─────────────
       It changes the SUCCESSOR draft. The layout is a balance of an approved
       version, so it stays current and its frozen evidence stays put. */
    const untouched = await readLayout(w.maker, w, layout.layoutId);
    expect(untouched.body.layout.source.state).toBe("CURRENT");

    /* And the replaced operation cannot reach a layout at all until somebody
       approves a method study for it — the submit gate says so by name, which
       is where "this row has no approved standard time" is now decided. */
    const file = await IeStyleFile.findById(w.fileId).lean();
    const submitted = await call(`/engineering-files/${w.fileId}/bulletin-versions`, {
      method: "POST", token: w.maker.token, company: w.co._id,
      body: { expectedRevision: file.revision },
    });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error.code).toBe("IE_BULLETIN_VERSION_NOT_READY");
    expect(submitted.body.error.details.gapCodes).toContain("IE_BULLETIN_ROW_NO_APPROVED_TIME");

    const after = await readLayout(w.maker, w, layout.layoutId);
    expect(after.body.layout.source.state).toBe("CURRENT");
    /* The captured evidence and the balance are untouched. */
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.sourceRows[0].requirementSnapshot.machineTypes).toEqual([{ machineType: "SNLS", quantity: 1 }]);
    expect(stored.stations).toEqual(before.stations);
    expect(stored.revision).toBe(before.revision);
    /* Still editable, because it is still a balance of its own version — which
       is the difference 7C2 makes: a plan is no longer taken out of somebody's
       hands by an edit to the draft beside it. */
    expect(after.body.layout.editable).toBe(true);

    const stillEdits = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: stored.revision,
      stations: [{ assignments: w.rows.map((r) => ({ rowId: r.rowId })) }],
    });
    expect(stillEdits.status).toBe(200);
  });

  test("the requirement half of the fingerprint is what changed, when only it changed", async () => {
    /* Both halves are stored, so a superseded layout can name which moved. */
    const w = await world("RequirementHalf");
    const layout = (await openLayout(w.maker, w)).body.layout;
    const stored = await IeLineLayout.findById(layout.layoutId).lean();
    expect(stored.sourceRequirementDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.sourceApprovalDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(layout.source.requirementDigest).toBe(stored.sourceRequirementDigest);

    /* Same rows, same approvals, different frozen evidence — simulated by
       re-freezing row 0's snapshot as the row's own authoring would. */
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(w.fileId) },
      { $set: { "bulletin.rows.0.requirementSnapshot.machineTypes": [{ machineType: "Bartack", quantity: 1 }] } },
    );
    await reapprove(w);
    const after = await readLayout(w.maker, w, layout.layoutId);
    expect(after.body.layout.source.state).toBe("SOURCE_CHANGED");
    /* The requirement half is what moved, and the version that carried the old
       half has been superseded. Both are reported, and neither is inferred. */
    expect(after.body.layout.source.changeReasons)
      .toEqual(expect.arrayContaining(["BULLETIN_VERSION_SUPERSEDED"]));
    /* The old layout still reports its own evidence, unchanged. */
    expect(after.body.layout.source.rows[0].requirementSnapshot.machineTypes)
      .toEqual([{ machineType: "SNLS", quantity: 1 }]);
  });

  test("a layout written before the freeze keeps its fingerprint and stays current", async () => {
    const w = await world("LegacyFingerprint");
    /* A pre-6B record: rows with no evidence, and no stored digests. */
    await IeStyleFile.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(w.fileId) },
      { $unset: { "bulletin.rows.0.requirementSnapshot": "", "bulletin.rows.1.requirementSnapshot": "" } },
    );
    const layout = (await openLayout(w.maker, w)).body.layout;
    await IeLineLayout.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(layout.layoutId) },
      { $unset: { sourceApprovalDigest: "", sourceRequirementDigest: "" } },
    );

    const after = await readLayout(w.maker, w, layout.layoutId);
    expect(after.status).toBe(200);
    expect(after.body.layout.source.state).toBe("CURRENT");
    expect(after.body.layout.source.changeReasons).toEqual([]);
    expect(after.body.layout.editable).toBe(true);
    /* And it is still editable — no migration was needed to keep it usable. */
    const edited = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: after.body.layout.revision,
      stations: [{ assignments: w.rows.map((r) => ({ rowId: r.rowId })) }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.layout.machineTypeCompatibility.state).toBe("UNKNOWN");
  });

  test("a no-op that includes the plan changes nothing; a plan change is one real edit", async () => {
    const w = await world("PlanNoOp");
    const layout = (await openLayout(w.maker, w)).body.layout;
    const saved = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: 1,
      stations: [{ assignments: w.rows.map((r) => ({ rowId: r.rowId })), plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }] }],
    });
    const before = await IeLineLayout.findById(layout.layoutId).lean();

    const noop = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
      stations: saved.body.layout.stations.map((s) => ({
        stationId: s.stationId, label: s.label, note: s.note,
        plannedMachineTypes: s.plannedMachineTypes.map((m) => ({ machineType: `  ${m.machineType}  `, quantity: m.quantity })),
        assignments: s.assignments.map((a) => ({ rowId: a.rowId })),
      })),
    });
    expect(noop.body.updated).toBe(false);
    expect(noop.body.events).toEqual([]);
    const afterNoop = await IeLineLayout.findById(layout.layoutId).lean();
    expect(afterNoop.revision).toBe(before.revision);
    expect(afterNoop.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
    expect(afterNoop.history).toHaveLength(before.history.length);

    /* An omitted plan preserves it, and a changed one is a real edit. */
    const omitted = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: saved.body.layout.revision,
      stations: [{ stationId: saved.body.layout.stations[0].stationId, assignments: [{ rowId: w.rows[0].rowId }] }],
    });
    expect(omitted.body.updated).toBe(true);
    expect(omitted.body.layout.stations[0].plannedMachineTypes).toEqual([{ machineType: "SNLS", quantity: 1 }]);

    const changedPlan = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: omitted.body.layout.revision,
      stations: [{
        stationId: saved.body.layout.stations[0].stationId,
        assignments: [{ rowId: w.rows[0].rowId }],
        plannedMachineTypes: [{ machineType: "SNLS", quantity: 4 }],
      }],
    });
    expect(changedPlan.body.updated).toBe(true);
    expect(changedPlan.body.events[0].changed).toContain("machine_plan");
    expect(changedPlan.body.layout.revision).toBe(omitted.body.layout.revision + 1);

    const stale = await patchLayout(w.maker, w, layout.layoutId, {
      expectedRevision: omitted.body.layout.revision, stations: [],
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("IE_LINE_LAYOUT_REVISION_CONFLICT");
  });
});

/* ══ 4. THE ENGINE ON ITS OWN ═════════════════════════════════════════════ */

describe("compatibility, without a server", () => {
  const { compatibilityOf, compatibilitySummaryOf, requirementDigestOf, COMPATIBILITY } = layoutService;
  const source = (snapshot) => new Map([["r1", { rowId: "r1", requirementSnapshot: snapshot }]]);
  const assignment = { rowId: "r1" };

  test("the three unknowns and the two verdicts", () => {
    expect(compatibilityOf(assignment, { plannedMachineTypes: [] }, source(null)))
      .toMatchObject({ state: "UNKNOWN", reason: "REQUIREMENTS_NOT_PROVABLE" });
    expect(compatibilityOf(assignment, { plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }] },
      source({ requirementsConfigured: false, machineTypes: [] })))
      .toMatchObject({ state: "UNKNOWN", reason: "REQUIREMENTS_NOT_CONFIGURED" });
    expect(compatibilityOf(assignment, { plannedMachineTypes: [] },
      source({ requirementsConfigured: true, machineTypes: [{ machineType: "SNLS", quantity: 1 }] })))
      .toMatchObject({ state: "UNKNOWN", reason: "STATION_MACHINE_TYPE_MISSING" });
    expect(compatibilityOf(assignment, { plannedMachineTypes: [] },
      source({ requirementsConfigured: true, machineTypes: [] })))
      .toMatchObject({ state: "COMPATIBLE", reason: "NO_MACHINE_REQUIRED" });
    expect(compatibilityOf(assignment, { plannedMachineTypes: [{ machineType: " snls ", quantity: 2 }] },
      source({ requirementsConfigured: true, machineTypes: [{ machineType: "SNLS", quantity: 2 }] })))
      .toMatchObject({ state: "COMPATIBLE" });
  });

  test("the summary never turns unknown into a clean line", () => {
    const c = (state) => ({ state, reason: "x", missingMachineTypes: [] });
    expect(compatibilitySummaryOf([])).toMatchObject({ evaluated: 0, state: "UNKNOWN" });
    expect(compatibilitySummaryOf([c("COMPATIBLE"), c("UNKNOWN")])).toMatchObject({ state: "UNKNOWN" });
    expect(compatibilitySummaryOf([c("COMPATIBLE"), c("INCOMPATIBLE"), c("UNKNOWN")]))
      .toMatchObject({ state: "INCOMPATIBLE", compatible: 1, incompatible: 1, unknown: 1 });
    expect(compatibilitySummaryOf([c("COMPATIBLE"), c("COMPATIBLE")])).toMatchObject({ state: "COMPATIBLE" });
    expect(COMPATIBILITY.UNKNOWN).toBe("UNKNOWN");
  });

  test("the requirement digest ignores order and is empty without evidence", () => {
    const a = requirementDigestOf({ ieOperationRevision: 2, requirementsConfigured: true, machineTypes: [{ machineType: "SNLS", quantity: 1 }, { machineType: "Bartack", quantity: 2 }] });
    const b = requirementDigestOf({ ieOperationRevision: 2, requirementsConfigured: true, machineTypes: [{ machineType: "bartack", quantity: 2 }, { machineType: "snls", quantity: 1 }] });
    expect(a).toBe(b);
    expect(requirementDigestOf(null)).toBe("");
    expect(requirementDigestOf({ ieOperationRevision: 3, requirementsConfigured: true, machineTypes: [] })).not.toBe(a);
    /* Configured-with-none and not-configured are different evidence. */
    expect(requirementDigestOf({ ieOperationRevision: 2, requirementsConfigured: true, machineTypes: [] }))
      .not.toBe(requirementDigestOf({ ieOperationRevision: 2, requirementsConfigured: false, machineTypes: [] }));
  });
});
