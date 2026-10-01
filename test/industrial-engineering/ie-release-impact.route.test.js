// test/industrial-engineering/ie-release-impact.route.test.js
//
// IE CHUNK 8A-iii — WHAT MOVED SINCE THE RELEASE, AT THE WIRE.
//
// The claims worth holding:
//
//   · it is a READ — nothing in either collection changes, and no impact record
//     is stored for anybody to later disagree with;
//   · rows are matched by STABLE identity, never by array position and never by
//     operation code, so an insertion does not make every later row "changed"
//     and a rename does not read as a replacement;
//   · a row that was re-timed AND re-sequenced AND had its requirements move
//     reports all three, because they have three different owners;
//   · the two digests stay two answers;
//   · the garment-SAM delta is exact and signed, and the capacity delta is
//     either exact or an explicit null with a typed reason — never a zero
//     standing in for an unknown;
//   · a work order is affected ONLY where its own `sampleStyleId` names this
//     style and the shared ownership rule proves the company, and every other
//     candidate examined is NAMED as unprovable rather than dropped;
//   · and one response never mixes two current bulletin versions.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
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
const IeRelease = require("../../models/CMS_Models/IndustrialEngineering/IeRelease");

const { calculateCapacity } = require("../../services/industrialEngineering/capacityCalculation");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/ie", require("../../routes/CMS_Routes/IndustrialEngineering/ieRoutes"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/ie`;
  await IeRelease.syncIndexes();
  await IeStyleFile.syncIndexes();
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

let keySeq = 0;
const nextKey = () => `impact-key-${++keySeq}-${Date.now()}`;

/* ══ FIXTURES ═════════════════════════════════════════════════════════════ */

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `imp${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "I", lastName: `I${n}`, email, biometricId: `IMP${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: "I",
    });
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

/** The four standard times this suite's worlds freeze. Garment SAM = 4.5. */
const MINUTES = [1, 1.2, 0.8, 1.5];

/**
 * A company, a style, an approved bulletin version, an approved layout, an
 * approved capacity standard and ONE issued release.
 *
 * Built through the real IE verbs, because the RELEASED half of every
 * comparison below must be genuine frozen evidence. The CURRENT half is
 * fabricated per test (see `moveCurrentTo`) so each classification can be
 * isolated without running a second full engineering chain for each one.
 */
async function released(name) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${name} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
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
  const wo = await WorkOrder.create({
    workOrderNumber: `WO-${name}-${n}`, stockItemId: item._id, stockItemName: item.name,
    stockItemReference: item.reference, quantity: 500, originalQuantity: 500, status: "planned",
    timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
    customerId: new mongoose.Types.ObjectId(), customerName: "Northwind Apparel Ltd",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${name}-${n}`, productName: `Tee ${name}`, styleCode: `ST-${name}-${n}`,
    variantLabel: "Navy", journeyId: journey._id, enquiryId: enquiry._id, sourceStockItemId: item._id,
    materials: { status: "pending", rawItems: [] },
    techSheet: {
      technical: { status: "approved", revision: 3 },
      technicalRevisions: [{
        revision: 3, submittedAt: new Date("2026-08-01"), outcome: "approved",
        decidedAt: new Date("2026-08-05"),
        snapshot: { revision: 3, materials: [], requirements: [], operations: [] },
      }],
    },
    production: { workOrderIds: [wo._id] },
  });
  /* The work order is linked to its style the way Chunk 1D links one. */
  await WorkOrder.updateOne({ _id: wo._id }, { $set: { sampleStyleId: style._id } });

  const maker = await actor({ companies: [co], grants: { ie: "editor" } });
  const approver = await actor({ companies: [co], grants: { ie: "approver" } });
  const viewer = await actor({ companies: [co], grants: { ie: "viewer" } });
  const t = { token: maker.token, company: co._id };

  const drafted = await call("/allowance-policies", {
    method: "POST", ...t,
    body: { name: `No allowance ${n}`, effectiveFrom: "2026-01-01", categories: [] },
  });
  await call(`/allowance-policies/${drafted.body.policy.policyId}/publish`, {
    method: "POST", token: approver.token, company: co._id, body: { expectedRevision: 1 },
  });

  const file = (await call(`/orders/${wo._id}/styles/${style._id}/engineering-file`, {
    method: "POST", ...t, body: {},
  })).body.file;

  const operations = [];
  for (let i = 0; i < MINUTES.length; i += 1) {
    const op = (await call("/operations/library", {
      method: "POST", ...t,
      body: { code: `OP-${n}-${i + 1}`, name: `Operation ${i + 1}`, machineType: "SNLS" },
    })).body.operation;
    const configured = await call(`/operations/library/${op.operationId}/requirements`, {
      method: "PATCH", ...t,
      body: {
        expectedRevision: op.revision,
        machineRequirements: [{ machineType: "SNLS", quantity: 1 }],
        /* ── ALL THREE DIMENSIONS, CONFIGURED ───────────────────────────
           Chunk 5A has always modelled attachments and labour; Chunk 8A-iii is
           what freezes them onto a bulletin row. The fixture configures all
           three so the frozen evidence this suite compares is real. */
        attachmentRequirements: [
          { code: `FOLD-${i + 1}`, name: "Hemming folder", quantity: 1, note: "20 mm" },
        ],
        labourRequirements: [
          { workerType: "OPERATOR", quantity: 1, skillCode: `SEW-${i + 1}`, skillName: "Sewing", grade: "B" },
          { workerType: "HELPER", quantity: 1 },
        ],
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

  for (let i = 0; i < rows.length; i += 1) {
    const opened = await call(
      `/engineering-files/${file.fileId}/bulletin/${rows[i].rowId}/method-studies`,
      { method: "POST", ...t, body: {} },
    );
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
        manualStandardTimeMinutes: MINUTES[i],
        overrideReason: "Fixed standard agreed for this exercise.",
      },
    });
    expect(submitted.status).toBe(200);
    expect((await call(`/method-studies/${studyId}/approve`, {
      method: "POST", token: approver.token, company: co._id,
      body: { expectedRevision: submitted.body.study.revision },
    })).status).toBe(200);
  }

  const stored = await IeStyleFile.findById(file.fileId).lean();
  const submittedVersion = await call(`/engineering-files/${file.fileId}/bulletin-versions`, {
    method: "POST", ...t, body: { expectedRevision: stored.revision },
  });
  expect(submittedVersion.status).toBe(201);
  const approvedVersion = await call(
    `/bulletin-versions/${submittedVersion.body.version.bulletinVersionId}/approve`,
    {
      method: "POST", token: approver.token, company: co._id,
      body: { expectedRevision: submittedVersion.body.version.revision },
    },
  );
  expect(approvedVersion.status).toBe(200);

  /* Layout, approved. */
  const opened = await call(`/engineering-files/${file.fileId}/line-layouts`, {
    method: "POST", ...t, body: {},
  });
  const draft = opened.body.layout;
  const lr = draft.source.rows;
  const saved = await call(`/line-layouts/${draft.layoutId}`, {
    method: "PATCH", ...t,
    body: {
      expectedRevision: draft.revision,
      stations: [
        {
          label: "Front", note: "",
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 2 }],
          assignments: [{ rowId: lr[0].rowId }, { rowId: lr[1].rowId }],
        },
        {
          label: "Close", note: "",
          plannedMachineTypes: [{ machineType: "SNLS", quantity: 1 }],
          assignments: [{ rowId: lr[2].rowId }, { rowId: lr[3].rowId }],
        },
      ],
    },
  });
  expect(saved.status).toBe(200);
  const approvedLayout = await call(`/line-layouts/${draft.layoutId}/approve`, {
    method: "POST", token: approver.token, company: co._id,
    body: { expectedRevision: saved.body.layout.revision },
  });
  expect(approvedLayout.status).toBe(200);
  const layout = approvedLayout.body.layout;

  const made = await call(`/line-layouts/${layout.layoutId}/capacity-standards`, {
    method: "POST", ...t, body: INPUTS,
  });
  expect(made.status).toBe(201);
  const approvedStd = await call(
    `/capacity-standards/${made.body.standard.capacityStandardId}/approve`,
    {
      method: "POST", token: approver.token, company: co._id,
      body: { expectedRevision: made.body.standard.revision },
    },
  );
  expect(approvedStd.status).toBe(200);

  const version = await IeBulletinVersion.findOne({
    companyId: co._id, ieStyleFileId: file.fileId, state: "APPROVED",
  }).lean();

  const issued = await call(`/style-files/${file.fileId}/releases`, {
    method: "POST", token: approver.token, company: co._id,
    headers: { "Idempotency-Key": nextKey() },
    body: {
      bulletinVersionId: String(version._id),
      expectedBulletinVersionNo: version.versionNo,
      lineLayoutId: layout.layoutId,
      expectedLayoutRevision: layout.revision,
      capacityStandardId: approvedStd.body.standard.capacityStandardId,
      expectedCapacityRevision: approvedStd.body.standard.revision,
    },
  });
  expect(issued.status).toBe(201);

  return {
    co, maker, approver, viewer, style, workOrder: wo, stockItem: item, journey,
    fileId: file.fileId, release: issued.body.release, version, operations,
  };
}

const impact = (ctx, person = ctx.viewer, company = ctx.co._id) => call(
  `/releases/${ctx.release.releaseId}/impact`, { token: person.token, company },
);

/**
 * Point the style file at a NEW approved bulletin version, built by cloning the
 * released one and mutating it.
 *
 * Written straight at the collections. The point of this suite is the
 * COMPARISON, and driving a second real approval chain for every one of seven
 * classifications would take minutes per test while proving nothing extra about
 * the code under test — the released half is genuine either way.
 */
async function moveCurrentTo(ctx, mutate) {
  const source = await IeBulletinVersion.findById(ctx.version._id).lean();
  const next = JSON.parse(JSON.stringify(source));
  next._id = new mongoose.Types.ObjectId();
  /* Monotonic per file: several tests move the current bulletin more than once,
     and `{companyId, ieStyleFileId, versionNo}` is unique. */
  ctx.nextVersionNo = (ctx.nextVersionNo || source.versionNo) + 1;
  next.versionNo = ctx.nextVersionNo;
  next.sourceFingerprint = `${++seq}`.padStart(64, "b");
  mutate(next);
  /* Ids and dates survive the JSON round trip as strings; put them back as the
     types Mongo stores so the service reads exactly what it would in life. */
  const revive = (o) => {
    for (const [k, v] of Object.entries(o || {})) {
      if (v && typeof v === "object") revive(v);
      else if (typeof v === "string" && /^[0-9a-f]{24}$/.test(v) && /Id$/.test(k)) {
        o[k] = new mongoose.Types.ObjectId(v);
      } else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) o[k] = new Date(v);
    }
  };
  revive(next);
  next.companyId = new mongoose.Types.ObjectId(String(source.companyId));
  next.ieStyleFileId = new mongoose.Types.ObjectId(String(source.ieStyleFileId));
  await mongoose.connection.collection("ie_bulletin_versions").insertOne(next);
  await mongoose.connection.collection("ie_style_files").updateOne(
    { _id: new mongoose.Types.ObjectId(String(ctx.fileId)) },
    { $set: { currentApprovedBulletinVersionId: next._id, currentApprovedVersionNo: next.versionNo } },
  );
  return next;
}

const rowFor = (body, rowId) => body.impact.rows.find((r) => r.rowId === rowId);

/**
 * Rewrite a frozen row's machine requirement the way the capture path writes
 * it — BOTH arrays, because a snapshot holds the Chunk 6B `machineTypes` shape
 * and the Chunk 8A-iii `machines` shape and they are written from one source.
 */
const setMachines = (row, machines) => {
  row.requirementSnapshot.machineTypes = machines.map((m) => ({
    machineType: m.machineType, quantity: m.quantity,
  }));
  row.requirementSnapshot.machines = machines.map((m, i) => ({
    requirementId: m.requirementId || `req_${i + 1}`,
    sequence: i + 1,
    machineType: m.machineType,
    quantity: m.quantity,
  }));
};

/* ══ 1. AUTHORITY AND COMPANY ═════════════════════════════════════════════ */

describe("who may ask, and about what", () => {
  test("an IE viewer may; an employee with no IE grant may not; anonymous may not", async () => {
    const ctx = await released("Access");

    const viewer = await impact(ctx);
    expect(viewer.status).toBe(200);
    expect(viewer.body.impact.release.releaseId).toBe(ctx.release.releaseId);

    const stranger = await actor({ companies: [ctx.co] });
    expect((await impact(ctx, stranger)).status).toBe(403);

    const otherDepartment = await actor({ companies: [ctx.co], grants: { ppc: "owner" } });
    expect((await impact(ctx, otherDepartment)).status).toBe(403);

    const anonymous = await call(`/releases/${ctx.release.releaseId}/impact`, { company: ctx.co._id });
    expect([401, 403]).toContain(anonymous.status);
  });

  test("a foreign release, a missing one and a malformed id are one answer", async () => {
    const mine = await released("Mine");
    const theirs = await released("Theirs");

    const foreign = await impact(theirs, mine.viewer, mine.co._id);
    const absent = await call(`/releases/${new mongoose.Types.ObjectId()}/impact`, {
      token: mine.viewer.token, company: mine.co._id,
    });
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
    expect(foreign.body).toEqual(absent.body);

    for (const bad of ["not-an-id", "12345", "zzzzzzzzzzzzzzzzzzzzzzzz"]) {
      const res = await call(`/releases/${bad}/impact`, {
        token: mine.viewer.token, company: mine.co._id,
      });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("IE_RELEASE_NOT_FOUND");
    }
  });

  test("asking changes nothing, anywhere", async () => {
    const ctx = await released("ReadOnly");
    await moveCurrentTo(ctx, (v) => { v.rows[0].standardTimeMinutes = 2.4; });

    const snapshot = async () => {
      const grab = async (name, q) => (await mongoose.connection.collection(name).find(q).toArray());
      return JSON.stringify({
        releases: await grab("ie_releases", { companyId: ctx.co._id }),
        files: await grab("ie_style_files", { companyId: ctx.co._id }),
        versions: await grab("ie_bulletin_versions", { companyId: ctx.co._id }),
        workorders: await grab("workorders", {}),
        layouts: await grab("ie_line_layouts", { companyId: ctx.co._id }),
        standards: await grab("ie_capacity_standards", { companyId: ctx.co._id }),
      });
    };
    const before = await snapshot();
    expect((await impact(ctx)).status).toBe(200);
    expect((await impact(ctx)).status).toBe(200);
    expect(await snapshot()).toBe(before);

    /* No impact collection came into existence to be disagreed with later. */
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
    expect(names.filter((n) => /impact/i.test(n))).toEqual([]);
    /* And nothing acknowledged anything. */
    const receipts = names.includes("ppc_ie_release_receipts")
      ? await mongoose.connection.collection("ppc_ie_release_receipts").countDocuments({}) : 0;
    expect(receipts).toBe(0);
  });
});

/* ══ 2. THE COMPARISON ════════════════════════════════════════════════════ */

describe("the bulletin comparison", () => {
  test("nothing moved: same bulletin, every row unchanged, both deltas nought", async () => {
    const ctx = await released("Same");
    const res = await impact(ctx);
    expect(res.status).toBe(200);
    const i = res.body.impact;

    expect(i.bulletin.verdict).toBe("CURRENT");
    expect(i.bulletin.moved).toBe(false);
    expect(i.bulletin.sourceFingerprint.moved).toBe(false);
    expect(i.bulletin.currentBulletinVersionId)
      .toBe(i.bulletin.releasedBulletinVersionId);
    expect(i.bulletin.approvalDigest.moved).toBe(false);
    expect(i.bulletin.requirementDigest.moved).toBe(false);
    expect(i.rows).toHaveLength(4);
    expect(i.rows.every((r) => r.classifications.length === 1 && r.classifications[0] === "UNCHANGED")).toBe(true);
    expect(i.summary.rowTally).toEqual({ UNCHANGED: 4 });
    expect(i.garmentSam.released).toBeCloseTo(4.5, 6);
    expect(i.garmentSam.delta).toBe(0);
    expect(i.capacity.delta).toBe(0);
    expect(i.capacity.unavailableReason).toBe("");
    expect(i.capacity.available).toBe(true);
    expect(i.stored).toBe(false);
  });

  test("no current approved bulletin is its own answer, not an empty comparison", async () => {
    const ctx = await released("NoCurrent");
    await mongoose.connection.collection("ie_style_files").updateOne(
      { _id: new mongoose.Types.ObjectId(String(ctx.fileId)) },
      { $unset: { currentApprovedBulletinVersionId: "", currentApprovedVersionNo: "" } },
    );
    const i = (await impact(ctx)).body.impact;

    expect(i.bulletin.verdict).toBe("NO_CURRENT_APPROVED");
    expect(i.bulletin.currentBulletinVersionId).toBeNull();
    expect(i.bulletin.sourceFingerprint.moved).toBeNull();
    expect(i.bulletin.approvalDigest.moved).toBeNull();
    expect(i.bulletin.requirementDigest.moved).toBeNull();
    expect(i.garmentSam.current).toBeNull();
    expect(i.garmentSam.delta).toBeNull();
    /* Never a zero standing in for an unknown. */
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.unavailableReason).toBe("NO_CURRENT_APPROVED_BULLETIN");
    /* The released rows are still named — they did not stop existing. */
    expect(i.rows).toHaveLength(4);
    expect(i.rows.every((r) => r.classifications[0] === "REMOVED")).toBe(true);
  });

  test("each classification, one at a time", async () => {
    const ctx = await released("EachOne");
    const released0 = await IeBulletinVersion.findById(ctx.version._id).lean();
    const ids = released0.rows.map((r) => r.rowId);

    /* ── RETIMED ─────────────────────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      v.rows[0].standardTimeMinutes = 2.4;
      v.rows[0].methodStudyId = String(new mongoose.Types.ObjectId());
      v.rows[0].approvedSubmissionId = "sub_retimed";
      v.totals.garmentSamMinutes = 5.9;
    });
    let i = (await impact(ctx)).body.impact;
    expect(i.bulletin.verdict).toBe("MOVED");
    expect(i.bulletin.moved).toBe(true);
    let row = rowFor({ impact: i }, ids[0]);
    expect(row.classifications).toEqual(["RETIMED"]);
    const retimed = row.reasons.find((r) => r.change === "RETIMED");
    /* Both studies and both submissions, named. */
    expect(retimed.releasedMethodStudyId).toBe(String(released0.rows[0].methodStudyId));
    expect(retimed.currentMethodStudyId).not.toBe(retimed.releasedMethodStudyId);
    expect(retimed.releasedApprovedSubmissionId)
      .toBe(String(released0.rows[0].approvedSubmissionId));
    expect(retimed.currentApprovedSubmissionId).toBe("sub_retimed");
    expect(retimed.deltaMinutes).toBeCloseTo(1.4, 6);
    expect(row.released.standardTimeMinutes).toBe(1);
    expect(row.current.standardTimeMinutes).toBe(2.4);

    /* ── REQUIREMENT_CHANGED ─────────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      setMachines(v.rows[1], [{ machineType: "OL4", quantity: 2 }]);
    });
    i = (await impact(ctx)).body.impact;
    row = rowFor({ impact: i }, ids[1]);
    expect(row.classifications).toEqual(["REQUIREMENT_CHANGED"]);
    const reqReason = row.reasons[0];
    expect(reqReason.code).toBe("REQUIREMENT_EVIDENCE_MOVED");
    /* Named by DIMENSION — not one undifferentiated "requirements changed". */
    expect(reqReason.movedDimensions).toEqual(["MACHINE"]);
    expect(reqReason.perDimension).toEqual({
      MACHINE: "MOVED", ATTACHMENT: "UNCHANGED", LABOUR: "UNCHANGED",
    });
    expect(row.released.requirements.machines)
      .toEqual([{ requirementId: expect.any(String), sequence: 1, machineType: "SNLS", quantity: 1 }]);
    expect(row.current.requirements.machines[0].machineType).toBe("OL4");
    /* The full evidence on both sides, with the two dimensions nobody froze
       stated as uncompared rather than reported as empty. */
    expect(row.released.requirements.dimensionState.MACHINE).toBe("CAPTURED");
    expect(row.released.requirements.configured).toBe(true);
    expect(row.released.requirements.capturedAt).toMatch(/^\d{4}-/);
    /* ── ALL THREE DIMENSIONS NOW FROZEN (Chunk 8A-iii) ───────────────
       The release in this suite was issued through the real verbs after the
       capture path began freezing attachments and labour, so all three are
       CAPTURED on both sides and all three are comparable. */
    expect(row.released.requirements.dimensionState).toEqual({
      MACHINE: "CAPTURED", ATTACHMENT: "CAPTURED", LABOUR: "CAPTURED",
    });
    expect(row.current.requirements.dimensionState.LABOUR).toBe("CAPTURED");
    expect(i.requirementCoverage.comparedOnAtLeastOneRow)
      .toEqual(["MACHINE", "ATTACHMENT", "LABOUR"]);
    expect(i.requirementCoverage.notComparableOnAtLeastOneRow).toEqual([]);

    /* A requirement going from configured to unconfigured is a change too —
       "nobody has decided" is not the same fact as "requires nothing". */
    await moveCurrentTo(ctx, (v) => {
      v.rows[1].requirementSnapshot.requirementsConfigured = false;
    });
    i = (await impact(ctx)).body.impact;
    expect(rowFor({ impact: i }, ids[1]).classifications).toEqual(["REQUIREMENT_CHANGED"]);

    /* ── RESEQUENCED ─────────────────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      v.rows[2].sequence = 9;
    });
    i = (await impact(ctx)).body.impact;
    row = rowFor({ impact: i }, ids[2]);
    expect(row.classifications).toEqual(["RESEQUENCED"]);
    expect(row.reasons[0]).toMatchObject({ releasedSequence: 3, currentSequence: 9 });

    /* ── OPERATION_REPLACED ──────────────────────────────────────────── */
    const replacement = new mongoose.Types.ObjectId();
    await moveCurrentTo(ctx, (v) => {
      v.rows[3].ieOperationId = String(replacement);
      v.rows[3].operationCode = "OP-REPLACEMENT";
    });
    i = (await impact(ctx)).body.impact;
    row = rowFor({ impact: i }, ids[3]);
    expect(row.classifications).toEqual(["OPERATION_REPLACED"]);
    expect(row.reasons[0].code).toBe("STABLE_OPERATION_ID_DIFFERS");
    expect(row.reasons[0].currentIeOperationId).toBe(String(replacement));

    /* ── REMOVED and ADDED ───────────────────────────────────────────── */
    const freshRowId = "row_brand_new_0001";
    await moveCurrentTo(ctx, (v) => {
      v.rows.splice(2, 1);
      v.rows.push({
        ...JSON.parse(JSON.stringify(released0.rows[0])),
        rowId: freshRowId, sequence: 4,
        ieOperationId: String(new mongoose.Types.ObjectId()),
        operationCode: "OP-NEW",
      });
    });
    i = (await impact(ctx)).body.impact;
    expect(rowFor({ impact: i }, ids[2]).classifications).toEqual(["REMOVED"]);
    expect(rowFor({ impact: i }, freshRowId).classifications).toEqual(["ADDED"]);
    /* ── AND POSITION PROVES NOTHING ─────────────────────────────────
       Removing row three shifted row four's index, and it is still UNCHANGED:
       a positional comparison would have called it replaced AND re-timed. */
    expect(rowFor({ impact: i }, ids[3]).classifications).toEqual(["UNCHANGED"]);
    expect(rowFor({ impact: i }, ids[0]).classifications).toEqual(["UNCHANGED"]);
  });

  test("simultaneous changes stay simultaneous", async () => {
    const ctx = await released("Simultaneous");
    const ids = ctx.version.rows.map((r) => r.rowId);
    await moveCurrentTo(ctx, (v) => {
      v.rows[0].standardTimeMinutes = 3.3;
      v.rows[0].approvedSubmissionId = "sub_simultaneous";
      setMachines(v.rows[0], [{ machineType: "FOA", quantity: 3 }]);
      v.rows[0].sequence = 7;
      v.rows[0].ieOperationId = String(new mongoose.Types.ObjectId());
    });
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    /* All four, and a reason for each. Not one "primary" result with the other
       three hidden behind an arbitrary precedence. */
    expect(new Set(row.classifications)).toEqual(new Set([
      "OPERATION_REPLACED", "RETIMED", "REQUIREMENT_CHANGED", "RESEQUENCED",
    ]));
    expect(row.classifications).toHaveLength(4);
    expect(row.reasons).toHaveLength(4);
    expect(new Set(row.reasons.map((r) => r.change))).toEqual(new Set(row.classifications));
    for (const r of row.reasons) {
      expect(typeof r.code).toBe("string");
      expect(r.message.length).toBeGreaterThan(10);
    }
    expect(i.summary.rowTally.RETIMED).toBe(1);
    expect(i.summary.rowTally.RESEQUENCED).toBe(1);
  });

  test("a rename is not a replacement", async () => {
    const ctx = await released("Rename");
    const ids = ctx.version.rows.map((r) => r.rowId);
    await moveCurrentTo(ctx, (v) => {
      /* Same stable operation id; only the labels move — and the code moves to
         one ANOTHER row already uses, which is exactly what makes code
         matching unsafe. */
      v.rows[0].operationCode = v.rows[1].operationCode;
      v.rows[0].operationName = "Attach collar (revised wording)";
    });
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    expect(row.classifications).toEqual(["UNCHANGED"]);
    expect(row.classifications).not.toContain("OPERATION_REPLACED");
    expect(row.labelsChanged).toBe(true);
    expect(row.reasons[0].code).toBe("LABEL_ONLY_RENAME");
    expect(row.released.ieOperationId).toBe(row.current.ieOperationId);
    expect(row.reasons[0].releasedOperationName).toBe("Operation 1");
    expect(row.reasons[0].currentOperationName).toBe("Attach collar (revised wording)");
    /* And the row whose code was borrowed is untouched by the collision. */
    expect(rowFor({ impact: i }, ids[1]).classifications).toEqual(["UNCHANGED"]);
  });

  test("the two digests move independently", async () => {
    const ctx = await released("Digests");

    await moveCurrentTo(ctx, (v) => { v.sourceApprovalDigest = "a".repeat(64); });
    let i = (await impact(ctx)).body.impact;
    expect(i.bulletin.approvalDigest.moved).toBe(true);
    expect(i.bulletin.requirementDigest.moved).toBe(false);
    expect(i.bulletin.approvalDigest.released).not.toBe(i.bulletin.approvalDigest.current);

    await moveCurrentTo(ctx, (v) => { v.sourceRequirementDigest = "b".repeat(64); });
    i = (await impact(ctx)).body.impact;
    expect(i.bulletin.approvalDigest.moved).toBe(false);
    expect(i.bulletin.requirementDigest.moved).toBe(true);
  });
});

/* ══ 3. THE NUMBERS ═══════════════════════════════════════════════════════ */

describe("SAM and capacity", () => {
  test("the SAM delta is exact and signed, in both directions", async () => {
    const ctx = await released("SamDelta");

    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 4.8; });
    let i = (await impact(ctx)).body.impact;
    expect(i.garmentSam.released).toBeCloseTo(4.5, 6);
    expect(i.garmentSam.current).toBeCloseTo(4.8, 6);
    /* 4.8 - 4.5 through scaled integers, not 0.30000000000000004. */
    expect(i.garmentSam.delta).toBe(0.3);

    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 4.1; });
    i = (await impact(ctx)).body.impact;
    expect(i.garmentSam.delta).toBe(-0.4);
  });

  test("the capacity delta uses the one calculator and the release's own assumptions", async () => {
    const ctx = await released("CapDelta");
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 5.625; });
    const i = (await impact(ctx)).body.impact;

    /* Recomputed here with the SAME server helper, against the SAME frozen
       assumptions — this suite does not carry a second capacity formula either. */
    const expected = calculateCapacity({
      availableShiftMinutes: INPUTS.availableShiftMinutes,
      breakMinutes: INPUTS.breakMinutes,
      shiftsPerDay: INPUTS.shiftsPerDay,
      plannedOperatorCount: INPUTS.plannedOperatorCount,
      targetEfficiencyPercent: INPUTS.targetEfficiencyPercent,
      garmentSamMinutes: 5.625,
    });
    expect(i.capacity.current).toBe(expected.wholePieceDailyTarget);
    expect(i.capacity.released).toBe(3200);
    expect(i.capacity.delta).toBe(expected.wholePieceDailyTarget - 3200);
    expect(i.capacity.delta).toBeLessThan(0);
    expect(i.capacity.basis).toBe("RELEASED_ASSUMPTIONS_WITH_CURRENT_GARMENT_SAM");
    expect(i.capacity.unavailableReason).toBe("");
    expect(i.capacity.available).toBe(true);
  });

  test("an underivable capacity target is null with a typed reason, never zero", async () => {
    const ctx = await released("CapUnknown");
    /* A current bulletin whose garment SAM is nought — the calculator refuses,
       and the refusal travels rather than being flattened to a target of 0. */
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 0; });
    let i = (await impact(ctx)).body.impact;
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.unavailableReason).toBe("CURRENT_CAPACITY_UNAVAILABLE");
    expect(i.capacity.unavailableReasons).toContain("NO_GARMENT_SAM");
    expect(i.garmentSam.current).toBe(0);
    expect(i.garmentSam.delta).toBe(-4.5);

    /* And a release whose own frozen assumptions are incomplete. */
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 4.5; });
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
      { $unset: { "source.capacityStandard.inputs.plannedOperatorCount": "" } },
    );
    i = (await impact(ctx)).body.impact;
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.unavailableReason).toBe("RELEASED_ASSUMPTIONS_INCOMPLETE");
  });
});

/* ══ 4. WORK ORDERS ═══════════════════════════════════════════════════════ */

describe("which work orders are provably affected", () => {
  test("only a direct style link with proved company ownership counts", async () => {
    const ctx = await released("WoProved");
    const i = (await impact(ctx)).body.impact;

    expect(i.workOrders.provablyAffected).toHaveLength(1);
    expect(i.workOrders.provablyAffected[0]).toEqual({
      workOrderId: String(ctx.workOrder._id),
      workOrderRef: ctx.workOrder.workOrderNumber,
      status: "planned",
      quantity: 500,
      bulletinVersionNo: null,
      candidateSource: "DIRECT_STYLE_LINK",
      provenBy: { styleLink: "SAMPLE_STYLE_ID", ownership: "SALES_JOURNEY" },
    });
    expect(i.workOrders.ownershipUnproven).toEqual([]);
    expect(i.workOrders.coverage.complete).toBe(true);
    expect(i.workOrders.coverage.withheldForTenantSafety).toBe(false);
    expect(i.workOrders.readOnly).toBe(true);
    expect(i.workOrders.writesProduction).toBe(false);
    expect(i.summary.affectedWorkOrderCount).toBe(1);
    expect(i.summary.unprovenWorkOrderCount).toBe(0);
  });

  test("your OWN order on another of your styles is named; nobody else's is", async () => {
    const ctx = await released("WoOwnOther");

    /* The caller's own company, a different style of theirs, reached through
       the shared stock item. Actionable, and safe to name. */
    const mineOtherStyle = await SampleStyle.create({
      sampleStyleId: `SS-MINE-${++seq}`, productName: "Tee", styleCode: `ST-MINE-${seq}`,
      journeyId: ctx.journey._id, sourceStockItemId: ctx.stockItem._id,
      materials: { status: "pending", rawItems: [] },
    });
    const ownOrder = await WorkOrder.create({
      workOrderNumber: `WO-MINE-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      sampleStyleId: mineOtherStyle._id,
      quantity: 120, originalQuantity: 120, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Mine Ltd",
    });

    const i = (await impact(ctx)).body.impact;
    expect(i.workOrders.ownershipUnproven).toHaveLength(1);
    expect(i.workOrders.ownershipUnproven[0]).toMatchObject({
      workOrderId: String(ownOrder._id),
      workOrderRef: ownOrder.workOrderNumber,
      quantity: 120,
      reasonCode: "DIFFERENT_STYLE",
    });
    expect(i.workOrders.ownershipUnproven[0].reasonMessage.length).toBeGreaterThan(20);
    expect(i.summary.unprovenWorkOrderCount).toBe(1);
    expect(i.workOrders.coverage.complete).toBe(true);
  });

  test("TENANT SAFETY — a shared stock item cannot reveal another company's order", async () => {
    /* ── THE TWO-COMPANY REGRESSION ────────────────────────────────────
       Two companies, one stock item. Company A asks for its own release's
       impact; company B has work orders reachable through that shared item.
       Hiding B's company id is not enough — an order NUMBER is B's record, and
       an exact count of them is an enumeration oracle. Neither may leave. */
    const a = await released("TenantA");
    const b = await released("TenantB");

    /* B's orders, all reachable from A's sweep through the shared product. */
    const theirs = [];
    for (let k = 0; k < 3; k += 1) {
      theirs.push(await WorkOrder.create({
        workOrderNumber: `WO-THEIRS-SECRET-${++seq}`, stockItemId: a.stockItem._id,
        stockItemName: a.stockItem.name, stockItemReference: a.stockItem.reference,
        sampleStyleId: b.style._id,
        quantity: 900 + k, originalQuantity: 900 + k, status: "in_progress",
        timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
        customerId: new mongoose.Types.ObjectId(), customerName: "Their Buyer Ltd",
      }));
    }
    /* And one legacy order with no style link at all — unattributable to
       anybody, so unattributable to A. */
    const legacy = await WorkOrder.create({
      workOrderNumber: `WO-LEGACY-SECRET-${++seq}`, stockItemId: a.stockItem._id,
      stockItemName: a.stockItem.name, stockItemReference: a.stockItem.reference,
      quantity: 77, originalQuantity: 77, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Nobody Ltd",
    });

    const i = (await impact(a)).body.impact;
    const wire = JSON.stringify(i);

    /* A sees only its own order. */
    expect(i.workOrders.provablyAffected.map((w) => w.workOrderId))
      .toEqual([String(a.workOrder._id)]);
    expect(i.workOrders.ownershipUnproven).toEqual([]);

    /* ── NOTHING OF B'S, ANYWHERE IN THE ENVELOPE ─────────────────────── */
    for (const wo of [...theirs, legacy]) {
      expect(wire).not.toContain(String(wo._id));
      expect(wire).not.toContain(wo.workOrderNumber);
    }
    expect(wire).not.toContain(String(b.co._id));
    expect(wire).not.toContain(String(b.style._id));
    expect(wire).not.toContain("Their Buyer Ltd");
    expect(wire).not.toContain("Nobody Ltd");
    expect(wire).not.toContain("SECRET");

    /* ── AND NO COUNT TO ENUMERATE THEM WITH ──────────────────────────
       The warning is a boolean and a set of reason codes. Four orders were
       withheld and no number anywhere in the response says four — adding a
       fifth must not change a single figure. */
    expect(i.workOrders.coverage.complete).toBe(false);
    expect(i.workOrders.coverage.withheldForTenantSafety).toBe(true);
    expect(i.workOrders.coverage.withheldReasonCodes.sort())
      .toEqual(["COMPANY_MISMATCH", "NO_STYLE_LINK"]);
    expect(i.workOrders.coverage.message.length).toBeGreaterThan(20);
    expect(Object.keys(i.workOrders.coverage)).not.toContain("withheldCount");
    expect(Object.keys(i.workOrders)).not.toContain("examinedCount");
    expect(i.summary.unprovenWorkOrderCount).toBe(0);
    expect(wire).not.toContain('"4"');

    const before = JSON.stringify((await impact(a)).body.impact.summary);
    await WorkOrder.create({
      workOrderNumber: `WO-THEIRS-SECRET-${++seq}`, stockItemId: a.stockItem._id,
      stockItemName: a.stockItem.name, stockItemReference: a.stockItem.reference,
      sampleStyleId: b.style._id,
      quantity: 42, originalQuantity: 42, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Their Buyer Ltd",
    });
    const after = (await impact(a)).body.impact;
    /* Not one number moved. The oracle is closed. */
    expect(JSON.stringify(after.summary)).toBe(before);
    expect(after.workOrders.coverage).toEqual(i.workOrders.coverage);
  });

  test("parentless, missing-style and foreign candidates are all withheld, each with its code", async () => {
    const ctx = await released("WoWithheld");

    /* AMBIGUOUS PARENTAGE — a journey that carries no company. */
    const danglingJourney = await SalesJourney.create({
      journeyId: `SJ-DANGLE-${++seq}`, accountId: new mongoose.Types.ObjectId(),
      ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "Dangling", isActive: true,
    });
    const ambiguousStyle = await SampleStyle.create({
      sampleStyleId: `SS-AMB-${++seq}`, productName: "Tee", styleCode: `ST-AMB-${seq}`,
      journeyId: danglingJourney._id, sourceStockItemId: ctx.stockItem._id,
      materials: { status: "pending", rawItems: [] },
    });
    /* NO PARENT — neither journey nor enquiry. */
    const orphanStyle = await SampleStyle.create({
      sampleStyleId: `SS-ORPH-${++seq}`, productName: "Tee", styleCode: `ST-ORPH-${seq}`,
      sourceStockItemId: ctx.stockItem._id, materials: { status: "pending", rawItems: [] },
    });

    const made = [];
    for (const [label, styleId] of [
      ["AMBIG", ambiguousStyle._id], ["ORPHAN", orphanStyle._id],
      ["GHOST", new mongoose.Types.ObjectId()],
    ]) {
      made.push(await WorkOrder.create({
        workOrderNumber: `WO-${label}-${++seq}`, stockItemId: ctx.stockItem._id,
        stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
        sampleStyleId: styleId,
        quantity: 100, originalQuantity: 100, status: "planned",
        timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
        customerId: new mongoose.Types.ObjectId(), customerName: "Someone Else Ltd",
      }));
    }

    const i = (await impact(ctx)).body.impact;
    const wire = JSON.stringify(i);

    expect(i.workOrders.provablyAffected.map((w) => w.workOrderId))
      .toEqual([String(ctx.workOrder._id)]);
    expect(i.workOrders.ownershipUnproven).toEqual([]);
    expect(i.workOrders.coverage.withheldForTenantSafety).toBe(true);
    /* An unprovable parent and a missing style record are DIFFERENT reasons and
       stay different — the aggregate loses the records, not the diagnosis. */
    expect(i.workOrders.coverage.withheldReasonCodes.sort())
      .toEqual(["OWNERSHIP_UNPROVEN", "STYLE_NOT_FOUND"]);

    for (const wo of made) {
      expect(wire).not.toContain(String(wo._id));
      expect(wire).not.toContain(wo.workOrderNumber);
    }
    expect(wire).not.toContain(String(ambiguousStyle._id));
    expect(wire).not.toContain(String(orphanStyle._id));
  });

  test("a style that has moved company takes its order out of the list entirely", async () => {
    const ctx = await released("WoCompanyMoved");
    const elsewhere = await Acc_Company.create({
      companyName: `Elsewhere ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    await SalesJourney.updateOne({ _id: ctx.journey._id }, { $set: { companyId: elsewhere._id } });

    const i = (await impact(ctx)).body.impact;
    const wire = JSON.stringify(i);

    /* It was the acting company's a moment ago; it is not now, and a stale
       memory of it is not a reason to keep publishing it. */
    expect(i.workOrders.provablyAffected).toEqual([]);
    expect(i.workOrders.ownershipUnproven).toEqual([]);
    expect(i.workOrders.coverage.withheldReasonCodes).toEqual(["COMPANY_MISMATCH"]);
    expect(wire).not.toContain(String(ctx.workOrder._id));
    expect(wire).not.toContain(ctx.workOrder.workOrderNumber);
    expect(wire).not.toContain(String(elsewhere._id));
    expect(i.summary.affectedWorkOrderCount).toBe(0);
  });
});

/* ══ 3b. REQUIREMENT DIMENSIONS ═══════════════════════════════════════════ */

describe("requirement evidence, per dimension", () => {
  test("all three dimensions are frozen, compared, and named when they move", async () => {
    const ctx = await released("ThreeDimensions");
    const ids = ctx.version.rows.map((r) => r.rowId);

    /* The released side froze all three from the operation's Chunk 5A profile. */
    const before = (await impact(ctx)).body.impact;
    const r0 = rowFor({ impact: before }, ids[0]).released.requirements;
    expect(r0.dimensionsCaptured).toEqual(["MACHINE", "ATTACHMENT", "LABOUR"]);
    expect(r0.attachments).toEqual([{
      requirementId: expect.stringMatching(/^areq_/), sequence: 1,
      code: "FOLD-1", name: "Hemming folder", quantity: 1, note: "20 mm",
    }]);
    expect(r0.labour).toEqual([
      {
        requirementId: expect.stringMatching(/^lreq_/), sequence: 1,
        workerType: "OPERATOR", quantity: 1,
        skillCode: "SEW-1", skillName: "Sewing", grade: "B", note: "",
      },
      {
        requirementId: expect.stringMatching(/^lreq_/), sequence: 2,
        workerType: "HELPER", quantity: 1,
        skillCode: "", skillName: "", grade: "", note: "",
      },
    ]);

    /* ── ATTACHMENT ALONE ──────────────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      v.rows[0].requirementSnapshot.attachments = [{
        requirementId: "areq_x", sequence: 1, code: "GUIDE-9", name: "Edge guide",
        quantity: 2, note: "",
      }];
    });
    let row = rowFor({ impact: (await impact(ctx)).body.impact }, ids[0]);
    expect(row.classifications).toEqual(["REQUIREMENT_CHANGED"]);
    expect(row.reasons[0].movedDimensions).toEqual(["ATTACHMENT"]);
    expect(row.reasons[0].perDimension.MACHINE).toBe("UNCHANGED");
    expect(row.reasons[0].perDimension.LABOUR).toBe("UNCHANGED");
    expect(row.reasons[0].message).toMatch(/attachment/i);

    /* ── LABOUR ALONE — and a GRADE change is a change ─────────────────── */
    await moveCurrentTo(ctx, (v) => {
      v.rows[0].requirementSnapshot.labour[0].grade = "A";
    });
    row = rowFor({ impact: (await impact(ctx)).body.impact }, ids[0]);
    expect(row.reasons[0].movedDimensions).toEqual(["LABOUR"]);

    /* ── TWO AT ONCE, BOTH NAMED ───────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      setMachines(v.rows[0], [{ machineType: "FOA", quantity: 1 }]);
      v.rows[0].requirementSnapshot.labour = [];
    });
    row = rowFor({ impact: (await impact(ctx)).body.impact }, ids[0]);
    expect(row.reasons[0].movedDimensions).toEqual(["MACHINE", "LABOUR"]);
    expect(row.reasons[0].perDimension.ATTACHMENT).toBe("UNCHANGED");
  });

  /**
   * ONE PREVIOUSLY-IGNORED FIELD AT A TIME.
   *
   * Each case edits a field that the first cut of this comparison did not look
   * at, while leaving every field it DID look at identical. If the canonical
   * form were still `machineType:quantity` / `code:quantity:name` /
   * `workerType:quantity:skillCode:grade`, every one of these rows would report
   * UNCHANGED — which is the whole failure being closed.
   *
   * The digest is asserted beside the verdict because the two must never
   * disagree about what a requirement change is.
   */
  test.each([
    ["machine requirement identity", "MACHINE",
      (r) => { r.requirementSnapshot.machines[0].requirementId = "mreq_rewritten"; }],
    ["machine sequence", "MACHINE",
      (r) => { r.requirementSnapshot.machines[0].sequence = 9; }],
    ["attachment note", "ATTACHMENT",
      (r) => { r.requirementSnapshot.attachments[0].note = "25 mm, revised"; }],
    ["attachment identity", "ATTACHMENT",
      (r) => { r.requirementSnapshot.attachments[0].requirementId = "areq_rewritten"; }],
    ["attachment sequence", "ATTACHMENT",
      (r) => { r.requirementSnapshot.attachments[0].sequence = 6; }],
    ["labour skill name", "LABOUR",
      (r) => { r.requirementSnapshot.labour[0].skillName = "Overlocking"; }],
    ["labour note", "LABOUR",
      (r) => { r.requirementSnapshot.labour[0].note = "left-hand feed"; }],
    ["labour identity", "LABOUR",
      (r) => { r.requirementSnapshot.labour[0].requirementId = "lreq_rewritten"; }],
    ["labour sequence", "LABOUR",
      (r) => { r.requirementSnapshot.labour[0].sequence = 8; }],
  ])("a change to %s moves only %s", async (_label, dimension, mutate) => {
    const ctx = await released(`Field${_label.replace(/[^a-z]/gi, "")}`);
    const ids = ctx.version.rows.map((r) => r.rowId);
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");
    const beforeSnapshot = ctx.version.rows[0].requirementSnapshot;

    await moveCurrentTo(ctx, (v) => mutate(v.rows[0]));
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    /* Only this dimension moved, and it did move. */
    expect(row.classifications).toEqual(["REQUIREMENT_CHANGED"]);
    expect(row.reasons[0].movedDimensions).toEqual([dimension]);
    expect(row.requirementMovement.perDimension[dimension]).toBe("MOVED");
    for (const other of ["MACHINE", "ATTACHMENT", "LABOUR"].filter((d) => d !== dimension)) {
      expect(`${other}:${row.requirementMovement.perDimension[other]}`).toBe(`${other}:UNCHANGED`);
    }
    /* Compared at FULL granularity — both sides captured everything. */
    expect(row.requirementMovement.reducedGranularity).toEqual([]);

    /* ── AND THE STORED DIGEST AGREES ──────────────────────────────────
       A comparison that said MOVED while the source digest said nothing had
       changed would be two surfaces giving opposite answers about one row. */
    const afterSnapshot = (await IeBulletinVersion.findOne({
      companyId: ctx.co._id, versionNo: ctx.nextVersionNo,
    }).lean()).rows[0].requirementSnapshot;
    expect(requirementDigestOf(afterSnapshot)).not.toBe(requirementDigestOf(beforeSnapshot));
  });

  test("re-ordering the stored array is not a change; each requirement keeps its own identity", async () => {
    const ctx = await released("Reordered");
    const ids = ctx.version.rows.map((r) => r.rowId);
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");
    const before = ctx.version.rows[0].requirementSnapshot;
    expect(before.labour).toHaveLength(2);

    await moveCurrentTo(ctx, (v) => {
      /* Same two requirements, same ids, same sequences — typed the other way
         round. Position has never been evidence and is not evidence now. */
      v.rows[0].requirementSnapshot.labour.reverse();
    });
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    expect(row.classifications).toEqual(["UNCHANGED"]);
    expect(row.requirementMovement.perDimension.LABOUR).toBe("UNCHANGED");

    const after = (await IeBulletinVersion.findOne({
      companyId: ctx.co._id, versionNo: ctx.nextVersionNo,
    }).lean()).rows[0].requirementSnapshot;
    expect(after.labour[0].requirementId).toBe(before.labour[1].requirementId);
    expect(requirementDigestOf(after)).toBe(requirementDigestOf(before));
  });

  test("a captured-but-empty dimension is comparable and unchanged against another empty one", async () => {
    const ctx = await released("CapturedEmpty");
    const ids = ctx.version.rows.map((r) => r.rowId);
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");

    /* Both sides captured ATTACHMENT and both are genuinely empty. That is
       agreement about a real fact — not the absence of evidence. */
    await mongoose.connection.collection("ie_bulletin_versions").updateOne(
      { _id: new mongoose.Types.ObjectId(String(ctx.version._id)) },
      { $set: { "rows.0.requirementSnapshot.attachments": [] } },
    );
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
      { $set: { "source.rows.0.requirementSnapshot.attachments": [] } },
    );
    await moveCurrentTo(ctx, (v) => { v.rows[0].requirementSnapshot.attachments = []; });

    const row = rowFor({ impact: (await impact(ctx)).body.impact }, ids[0]);
    expect(row.released.requirements.dimensionState.ATTACHMENT).toBe("CAPTURED");
    expect(row.released.requirements.attachments).toEqual([]);
    expect(row.requirementMovement.perDimension.ATTACHMENT).toBe("UNCHANGED");
    expect(row.requirementMovement.notComparable).toEqual([]);
    expect(row.classifications).toEqual(["UNCHANGED"]);

    /* And an empty CAPTURED dimension still hashes differently from a snapshot
       that never captured it at all. */
    const captured = {
      ieOperationRevision: 2, requirementsConfigured: true,
      machineTypes: [{ machineType: "SNLS", quantity: 1 }],
      dimensionsCaptured: ["MACHINE", "ATTACHMENT", "LABOUR"],
      machines: [], attachments: [], labour: [],
    };
    const legacy = {
      ieOperationRevision: 2, requirementsConfigured: true,
      machineTypes: [{ machineType: "SNLS", quantity: 1 }],
    };
    expect(requirementDigestOf(captured)).not.toBe(requirementDigestOf(legacy));
  });

  test("a version frozen before the capture existed reads NOT_CAPTURED and is never compared", async () => {
    const ctx = await released("Legacy");
    const ids = ctx.version.rows.map((r) => r.rowId);

    /* A current version shaped exactly as one submitted before Chunk 8A-iii:
       the machine half only, and no `dimensionsCaptured` marker. NOTHING
       backfills it — a frozen version is evidence of what was said then. */
    await moveCurrentTo(ctx, (v) => {
      for (const r of v.rows) {
        delete r.requirementSnapshot.dimensionsCaptured;
        delete r.requirementSnapshot.machines;
        delete r.requirementSnapshot.attachments;
        delete r.requirementSnapshot.labour;
      }
    });
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    expect(row.current.requirements.dimensionState).toEqual({
      MACHINE: "CAPTURED", ATTACHMENT: "NOT_CAPTURED", LABOUR: "NOT_CAPTURED",
    });
    expect(row.current.requirements.dimensionsCaptured).toEqual([]);
    /* The machine half still compares — it has been frozen since Chunk 6B — and
       a legacy row's machine list is rebuilt from `machineTypes` with the
       stable id and sequence stated as ABSENT rather than invented. */
    expect(row.current.requirements.machines)
      .toEqual([{ requirementId: null, sequence: null, machineType: "SNLS", quantity: 1 }]);

    /* ── AND THE OTHER TWO ARE NOT CALLED UNCHANGED ──────────────────── */
    expect(row.classifications).toEqual(["UNCHANGED"]);
    expect(row.requirementMovement.perDimension).toEqual({
      MACHINE: "UNCHANGED", ATTACHMENT: "NOT_COMPARABLE", LABOUR: "NOT_COMPARABLE",
    });
    expect(row.reasons[0].notComparableDimensions).toEqual(["ATTACHMENT", "LABOUR"]);
    /* ── AND THE MACHINE VERDICT SAYS WHAT IT IS WORTH ────────────────
       One side froze machine identities and the other never did, so the two
       were compared on type and quantity alone. `MACHINE: UNCHANGED` here must
       never be read as "the requirement identities agree" — they were not
       compared, and the reduction is published rather than left to be
       inferred from the absence of a complaint. */
    expect(row.requirementMovement.reducedGranularity).toEqual(["MACHINE"]);
    expect(i.requirementCoverage.comparedOnAtLeastOneRow).toEqual(["MACHINE"]);
    expect(i.requirementCoverage.notComparableOnAtLeastOneRow)
      .toEqual(["ATTACHMENT", "LABOUR"]);

    /* An attachment appearing on one side only is the ARRIVAL of evidence, not
       a change to it, and must not be reported as a requirement movement. */
    expect(row.released.requirements.attachments.length).toBeGreaterThan(0);
    expect(row.current.requirements.attachments).toEqual([]);
    expect(row.classifications).not.toContain("REQUIREMENT_CHANGED");
  });

  test("a moved operation revision is not a requirement change — on either surface", async () => {
    /* ── THE DISAGREEMENT THIS CLOSES ───────────────────────────────────
       The v2 digest used to be the LEGACY digest with a tail bolted on, and the
       legacy head carries `ieOperationRevision`. So re-saving an operation
       moved the requirement digest while every requirement field stayed
       identical: the row said nothing had changed and `requirementDigest.moved`
       said something had. One release, two answers.

       A v2 digest is now built only from what a requirement IS. */
    const ctx = await released("RevisionOnly");
    const ids = ctx.version.rows.map((r) => r.rowId);
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");
    const before = ctx.version.rows[0].requirementSnapshot;

    await moveCurrentTo(ctx, (v) => {
      /* The operation was re-saved; its requirements were not touched. */
      v.rows[0].ieOperationRevision = v.rows[0].ieOperationRevision + 5;
      v.rows[0].requirementSnapshot.ieOperationRevision =
        v.rows[0].requirementSnapshot.ieOperationRevision + 5;
      v.rows[0].requirementSnapshot.capturedAt = new Date("2027-01-01T00:00:00.000Z").toISOString();
    });
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    expect(row.classifications).not.toContain("REQUIREMENT_CHANGED");
    expect(row.requirementMovement.perDimension).toEqual({
      MACHINE: "UNCHANGED", ATTACHMENT: "UNCHANGED", LABOUR: "UNCHANGED",
    });

    const after = (await IeBulletinVersion.findOne({
      companyId: ctx.co._id, versionNo: ctx.nextVersionNo,
    }).lean()).rows[0].requirementSnapshot;
    expect(after.ieOperationRevision).not.toBe(before.ieOperationRevision);
    /* The two surfaces now agree, because the digest stopped answering a
       question nobody asked it. */
    expect(requirementDigestOf(after)).toBe(requirementDigestOf(before));

    /* The revision moving is still VISIBLE — the row's own identity carries it,
       and the approval half of the source fingerprint still covers it. It is
       simply not a REQUIREMENT change. */
    expect(row.current.ieOperationRevision).toBe(row.released.ieOperationRevision + 5);
  });

  test("a renamed operation is visible as a rename and moves no requirement digest", async () => {
    const ctx = await released("LabelOnlyDigest");
    const ids = ctx.version.rows.map((r) => r.rowId);
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");
    const before = ctx.version.rows[0].requirementSnapshot;

    await moveCurrentTo(ctx, (v) => {
      v.rows[0].operationCode = "OP-RENAMED";
      v.rows[0].operationName = "Attach collar (revised wording)";
    });
    const row = rowFor({ impact: (await impact(ctx)).body.impact }, ids[0]);

    /* The rename is visible, on both sides, and named as what it is. */
    expect(row.labelsChanged).toBe(true);
    expect(row.reasons[0].code).toBe("LABEL_ONLY_RENAME");
    expect(row.released.operationCode).not.toBe(row.current.operationCode);
    /* And it is not a requirement change on either surface. */
    expect(row.classifications).toEqual(["UNCHANGED"]);
    expect(row.requirementMovement.moved).toEqual([]);
    const after = (await IeBulletinVersion.findOne({
      companyId: ctx.co._id, versionNo: ctx.nextVersionNo,
    }).lean()).rows[0].requirementSnapshot;
    expect(requirementDigestOf(after)).toBe(requirementDigestOf(before));
  });

  test("whether requirements were decided AT ALL is itself a requirement change", async () => {
    const ctx = await released("ConfiguredMoved");
    const ids = ctx.version.rows.map((r) => r.rowId);
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");
    const before = ctx.version.rows[0].requirementSnapshot;

    /* Every list identical; only the flag moves. "Nobody has decided what this
       operation requires" and "somebody decided it requires exactly this" are
       different requirements, and both surfaces have to say so. */
    await moveCurrentTo(ctx, (v) => {
      v.rows[0].requirementSnapshot.requirementsConfigured = false;
    });
    const row = rowFor({ impact: (await impact(ctx)).body.impact }, ids[0]);

    expect(row.classifications).toEqual(["REQUIREMENT_CHANGED"]);
    expect(row.reasons[0].configuredChanged).toBe(true);
    expect(row.reasons[0].movedDimensions).toEqual([]);
    expect(row.reasons[0].releasedConfigured).toBe(true);
    expect(row.reasons[0].currentConfigured).toBe(false);

    const after = (await IeBulletinVersion.findOne({
      companyId: ctx.co._id, versionNo: ctx.nextVersionNo,
    }).lean()).rows[0].requirementSnapshot;
    expect(requirementDigestOf(after)).not.toBe(requirementDigestOf(before));
  });

  test("the requirement digest covers all three dimensions, and leaves legacy evidence alone", () => {
    const { requirementDigestOf } = require("../../services/industrialEngineering/ieLineLayout.service");
    const legacy = {
      ieOperationRevision: 2, requirementsConfigured: true,
      machineTypes: [{ machineType: "SNLS", quantity: 1 }],
    };
    /* ── NOT ONE BYTE OF HISTORY RESTATED ─────────────────────────────
       Every stored layout fingerprint, frozen capacity-standard digest and
       issued release was computed with the old function. Widening it for OLD
       evidence would have made an in-flight capacity standard fail its own
       re-proof at approval. */
    expect(requirementDigestOf(legacy)).toBe("2~1~SNLS:1");

    /* Shaped as the capture path actually writes one: all three dimensions
       together, machines included. `requirementSnapshotOf` never produces a
       half-captured snapshot, and a fixture that did would be testing a state
       the system cannot reach. */
    const captured = {
      ...legacy,
      dimensionsCaptured: ["MACHINE", "ATTACHMENT", "LABOUR"],
      machines: [{ requirementId: "mreq_1", sequence: 1, machineType: "SNLS", quantity: 1 }],
      attachments: [{ requirementId: "areq_1", sequence: 1, code: "F12", name: "Folder", quantity: 1 }],
      labour: [{
        requirementId: "lreq_1", sequence: 1, workerType: "OPERATOR",
        quantity: 1, skillCode: "S1", grade: "A",
      }],
    };
    const base = requirementDigestOf(captured);
    expect(base).not.toBe(requirementDigestOf(legacy));
    /* ── TWO FORMATS, NOT ONE WITH A TAIL ─────────────────────────────
       A v2 digest does not begin with the legacy head, and carries none of the
       facts that head carried. Those are facts ABOUT the row; this digest
       answers what the row REQUIRES. */
    expect(base.startsWith("v2~")).toBe(true);
    expect(base.startsWith(requirementDigestOf(legacy))).toBe(false);
    expect(requirementDigestOf({ ...captured, ieOperationRevision: 99 })).toBe(base);
    /* Once `machines` is captured, `machineTypes` is a duplicate of evidence the
       canonical form already covers — so it no longer participates. (For a
       legacy snapshot it IS the machine evidence, and still does.) */
    expect(requirementDigestOf({ ...captured, machineTypes: [] })).toBe(base);
    expect(requirementDigestOf({ ...captured, machines: [] })).not.toBe(base);
    expect(requirementDigestOf({ ...captured, capturedAt: new Date("2030-01-01") })).toBe(base);
    /* But the one flag that IS a requirement still moves it. */
    expect(requirementDigestOf({ ...captured, requirementsConfigured: false })).not.toBe(base);
    /* Captured-and-empty is a different fact from never-captured. */
    expect(requirementDigestOf({ ...captured, attachments: [], labour: [] }))
      .not.toBe(requirementDigestOf(legacy));
    /* Each dimension moves the digest on its own. */
    expect(requirementDigestOf({
      ...captured, attachments: [{ code: "F12", name: "Folder", quantity: 2 }],
    })).not.toBe(base);
    expect(requirementDigestOf({
      ...captured, labour: [{ workerType: "OPERATOR", quantity: 1, skillCode: "S1", grade: "B" }],
    })).not.toBe(base);
    /* Order is not a requirement. */
    expect(requirementDigestOf({
      ...captured,
      attachments: [{ code: "F12", name: "Folder", quantity: 1 }, { code: "A1", name: "A", quantity: 1 }],
    })).toBe(requirementDigestOf({
      ...captured,
      attachments: [{ code: "A1", name: "A", quantity: 1 }, { code: "F12", name: "Folder", quantity: 1 }],
    }));
  });
});

/* ══ 4a. UNKNOWN STAYS UNKNOWN ════════════════════════════════════════════ */

describe("tri-state evidence", () => {
  /* `true`, `false` and "not stated" are THREE answers. Collapsing the third
     into `false` hands out a denial the server never made; collapsing it into
     `true` hands out a reassurance. Each case below pins one of them. */

  test("a digest with only one side present cannot have moved or stayed", async () => {
    const ctx = await released("OneSidedDigest");

    /* ── ABSENT CURRENT DIGEST ───────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => { v.sourceRequirementDigest = ""; });
    let i = (await impact(ctx)).body.impact;
    expect(i.bulletin.requirementDigest.released).not.toBeNull();
    expect(i.bulletin.requirementDigest.current).toBeNull();
    /* Not `true`: the digests are not equal, but an opaque value compared
       against nothing has not been compared. */
    expect(i.bulletin.requirementDigest.moved).toBeNull();
    /* The approval digest beside it is unaffected — they stay two answers. */
    expect(i.bulletin.approvalDigest.moved).toBe(false);

    /* ── ABSENT RELEASED DIGEST ──────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => { v.sourceRequirementDigest = "e".repeat(64); });
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
      { $set: { "source.sourceRequirementDigest": "" } },
    );
    i = (await impact(ctx)).body.impact;
    expect(i.bulletin.requirementDigest.released).toBeNull();
    expect(i.bulletin.requirementDigest.current).toBe("e".repeat(64));
    expect(i.bulletin.requirementDigest.moved).toBeNull();

    /* ── AND BOTH ABSENT IS STILL NOT AGREEMENT ──────────────────────── */
    await moveCurrentTo(ctx, (v) => { v.sourceRequirementDigest = ""; });
    i = (await impact(ctx)).body.impact;
    expect(i.bulletin.requirementDigest.moved).toBeNull();
  });

  test("NO_CURRENT_APPROVED never reads as reassurance", async () => {
    const ctx = await released("NoReassurance");
    await mongoose.connection.collection("ie_style_files").updateOne(
      { _id: new mongoose.Types.ObjectId(String(ctx.fileId)) },
      { $unset: { currentApprovedBulletinVersionId: "", currentApprovedVersionNo: "" } },
    );
    const i = (await impact(ctx)).body.impact;

    expect(i.bulletin.verdict).toBe("NO_CURRENT_APPROVED");
    /* ── THE ONE THAT MATTERS ──────────────────────────────────────────
       `false` here would render as "nothing has moved" on a screen that has
       just been told there is nothing to have moved TO. */
    expect(i.bulletin.moved).toBeNull();
    expect(i.bulletin.moved).not.toBe(false);
    expect(i.bulletin.currentVersionNo).toBeNull();
    expect(i.bulletin.approvalDigest.moved).toBeNull();
    expect(i.bulletin.requirementDigest.moved).toBeNull();
    expect(i.bulletin.sourceFingerprint.moved).toBeNull();
    expect(i.garmentSam.current).toBeNull();
    expect(i.garmentSam.delta).toBeNull();
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.available).toBe(false);
    expect(i.capacity.unavailableReason).toBe("NO_CURRENT_APPROVED_BULLETIN");
    expect(i.capacity.unavailableMessage.length).toBeGreaterThan(30);

    /* Nothing anywhere in the envelope is a zero standing in for an unknown. */
    expect(i.garmentSam.current).not.toBe(0);
    expect(i.capacity.current).not.toBe(0);
    expect(i.capacity.delta).not.toBe(0);
  });

  test("capacity availability is true, false or null — and false carries a reason a person can act on", async () => {
    const ctx = await released("CapTriState");
    const frozenStandard = (await IeRelease.findById(ctx.release.releaseId).lean())
      .source.capacityStandard;

    /* FALSE — derivable in principle, refused in fact, with the reason. */
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 0; });
    let i = (await impact(ctx)).body.impact;
    expect(i.capacity.available).toBe(false);
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.unavailableReason).toBe("CURRENT_CAPACITY_UNAVAILABLE");
    expect(i.capacity.unavailableReasons).toContain("NO_GARMENT_SAM");
    expect(i.capacity.unavailableMessage).toMatch(/garment SAM/i);

    /* ── NULL — THE QUESTION WAS NEVER RAISED ────────────────────────
       A release that froze no capacity standard at all has no target to
       compare and no derivation that failed. `false` would report a failure
       nobody attempted; `null` is the server declining to answer, which is the
       truth. This is the third state, and it is reachable. */
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
      { $unset: { "source.capacityStandard": "" } },
    );
    i = (await impact(ctx)).body.impact;
    expect(i.capacity.available).toBeNull();
    expect(i.capacity.available).not.toBe(false);
    expect(i.capacity.released).toBeNull();
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.unavailableReason).toBe("");
    expect(i.capacity.unavailableMessage).toBe("");
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
      { $set: { "source.capacityStandard": frozenStandard } },
    );

    /* TRUE — and the reason field is empty rather than a placeholder. */
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 4.5; });
    i = (await impact(ctx)).body.impact;
    expect(i.capacity.available).toBe(true);
    expect(i.capacity.unavailableReason).toBe("");
    expect(i.capacity.unavailableMessage).toBe("");
    expect(i.capacity.delta).toBe(0);
  });

  test("genuine agreement IS published as agreement", async () => {
    /* The control. Everything above proves an unknown is not turned into a
       verdict; this proves a real verdict is not turned into an unknown. */
    const ctx = await released("GenuineUnchanged");
    const i = (await impact(ctx)).body.impact;

    expect(i.bulletin.verdict).toBe("CURRENT");
    expect(i.bulletin.moved).toBe(false);
    expect(i.bulletin.approvalDigest.moved).toBe(false);
    expect(i.bulletin.requirementDigest.moved).toBe(false);
    expect(i.bulletin.sourceFingerprint.moved).toBe(false);
    expect(i.bulletin.releasedVersionNo).toBe(i.bulletin.currentVersionNo);
    expect(i.garmentSam.delta).toBe(0);
    expect(i.capacity.available).toBe(true);
    expect(i.capacity.delta).toBe(0);
    expect(i.summary.changedRowCount).toBe(0);
    expect(i.summary.unchangedRowCount).toBe(i.summary.totalRowCount);
  });
});

/* ══ 4b. THE PUBLISHED CONTRACT ═══════════════════════════════════════════ */

/**
 * EVERY FIELD THE ACCEPTED FRONTEND CONTRACT REQUIRES.
 *
 * Copied verbatim from `REQUIRED_FIELDS` in
 * `grav-cms/components/industrialEngineering/releaseImpact/releaseImpactAdapter.js`,
 * which is the accepted contract of record. The test below ALSO reads that file
 * when the sibling checkout is present and fails if the two lists have drifted
 * — so this copy cannot quietly go stale, and the suite still runs where the
 * frontend repo is not checked out.
 */
const REQUIRED_FIELDS = Object.freeze([
  "release.releaseId",
  "release.releaseRef",
  "release.versionNo",
  "bulletin.releasedVersionNo",
  "bulletin.currentVersionNo",
  "bulletin.verdict",
  "bulletin.approvalDigest.released",
  "bulletin.approvalDigest.current",
  "bulletin.approvalDigest.moved",
  "bulletin.requirementDigest.released",
  "bulletin.requirementDigest.current",
  "bulletin.requirementDigest.moved",
  "garmentSam.released",
  "garmentSam.current",
  "garmentSam.delta",
  "capacity.released",
  "capacity.current",
  "capacity.delta",
  "capacity.available",
  "capacity.unavailableReason",
  "rows[].rowId",
  "rows[].classifications",
  "rows[].released.ieOperationId",
  "rows[].released.ieOperationRevision",
  "rows[].current.ieOperationId",
  "rows[].current.ieOperationRevision",
  "rows[].released.operationCode",
  "rows[].released.operationName",
  "rows[].released.sequence",
  "rows[].released.standardTimeMinutes",
  "rows[].released.methodStudyId",
  "rows[].released.approvedSubmissionId",
  "rows[].released.requirements.machines[].machineType",
  "rows[].released.requirements.machines[].quantity",
  "rows[].released.requirements.labour[].workerType",
  "rows[].released.requirements.labour[].skillCode",
  "rows[].released.requirements.labour[].skillName",
  "rows[].released.requirements.labour[].grade",
  "rows[].released.requirements.attachments[].code",
  "rows[].released.requirements.attachments[].name",
  "rows[].released.requirements.attachments[].quantity",
  "rows[].current.operationCode",
  "rows[].current.operationName",
  "rows[].current.sequence",
  "rows[].current.standardTimeMinutes",
  "rows[].current.methodStudyId",
  "rows[].current.approvedSubmissionId",
  "rows[].current.requirements.machines[].machineType",
  "rows[].current.requirements.labour[].workerType",
  "rows[].current.requirements.labour[].skillCode",
  "rows[].current.requirements.labour[].skillName",
  "rows[].current.requirements.labour[].grade",
  "rows[].current.requirements.attachments[].code",
  "rows[].current.requirements.attachments[].name",
  "rows[].current.requirements.attachments[].note",
  "workOrders.provablyAffected[]",
  "workOrders.ownershipUnproven[].reasonCode",
  "workOrders.ownershipUnproven[].reasonMessage",
  "bulletin.releasedBulletinVersionId",
  "bulletin.currentBulletinVersionId",
  "rows[].reasons[].code",
  "rows[].reasons[].message",
  "rows[].requirementMovement.perDimension",
  "rows[].requirementMovement.reducedGranularity",
  "rows[].released.requirements.dimensionState.MACHINE",
  "rows[].released.requirements.dimensionState.LABOUR",
  "rows[].released.requirements.dimensionState.ATTACHMENT",
  "rows[].current.requirements.dimensionState.MACHINE",
  "rows[].current.requirements.dimensionState.LABOUR",
  "rows[].current.requirements.dimensionState.ATTACHMENT",
  "workOrders.coverage.complete",
  "workOrders.coverage.withheldForTenantSafety",
  "workOrders.coverage.message",
  "summary.totalRowCount",
  "summary.changedRowCount",
  "summary.unchangedRowCount",
  "summary.affectedWorkOrderCount",
  "summary.unprovenWorkOrderCount",
]);

/**
 * Resolve one contract path against a payload.
 *
 * PRESENCE, not truthiness. `null` is a stated absence and a legitimate value
 * for every tri-state field in the contract, so a check that asked "is it
 * truthy" would reject exactly the answers this chunk exists to publish.
 */
function resolvePath(value, path) {
  const steps = path.split(".").filter(Boolean);
  let nodes = [value];
  for (const rawStep of steps) {
    const isList = rawStep.endsWith("[]");
    const key = isList ? rawStep.slice(0, -2) : rawStep;
    const next = [];
    for (const node of nodes) {
      if (node === null || node === undefined || typeof node !== "object") {
        return { ok: false, why: `missing at "${key}"` };
      }
      if (!(key in node)) return { ok: false, why: `missing key "${key}"` };
      const child = node[key];
      if (isList) {
        if (!Array.isArray(child)) return { ok: false, why: `"${key}" is not a list` };
        if (!child.length) return { ok: false, why: `"${key}" is empty in this fixture` };
        next.push(...child);
      } else next.push(child);
    }
    nodes = next;
  }
  return { ok: true, nodes };
}

describe("the published contract", () => {
  test("the real payload satisfies every field the accepted frontend contract requires", async () => {
    /* The UNCHANGED case deliberately: every row has both sides, so every
       per-side path in the contract is genuinely exercised. A removed row's
       `current` is legitimately null and would make the sweep vacuous. */
    const ctx = await released("Contract");
    const own = await SampleStyle.create({
      sampleStyleId: `SS-CT-${++seq}`, productName: "Tee", styleCode: `ST-CT-${seq}`,
      journeyId: ctx.journey._id, sourceStockItemId: ctx.stockItem._id,
      materials: { status: "pending", rawItems: [] },
    });
    /* One of the caller's own orders on another of their styles, so
       `ownershipUnproven[]` is populated and its paths are exercised too. */
    await WorkOrder.create({
      workOrderNumber: `WO-CT-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      sampleStyleId: own._id, quantity: 60, originalQuantity: 60, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Mine Ltd",
    });

    const res = await impact(ctx);
    expect(res.status).toBe(200);
    const payload = res.body.impact;

    const failures = REQUIRED_FIELDS
      .map((path) => ({ path, ...resolvePath(payload, path) }))
      .filter((r) => !r.ok)
      .map((r) => `${r.path} — ${r.why}`);
    expect(failures).toEqual([]);

    /* ── AND THE JUDGMENTS ARE THE SERVER'S ────────────────────────────
       Lane B reshapes; it must not have to decide. Each of these is a
       conclusion a browser could only reach by re-deriving something. */
    expect(["CURRENT", "MOVED", "NO_CURRENT_APPROVED"]).toContain(payload.bulletin.verdict);
    expect(typeof payload.summary.totalRowCount).toBe("number");
    expect(typeof payload.summary.changedRowCount).toBe("number");
    expect(typeof payload.summary.unchangedRowCount).toBe("number");
    expect(typeof payload.summary.affectedWorkOrderCount).toBe("number");
    expect(typeof payload.summary.unprovenWorkOrderCount).toBe("number");
    expect(payload.summary.totalRowCount)
      .toBe(payload.summary.changedRowCount + payload.summary.unchangedRowCount);
    expect(payload.summary.totalRowCount).toBe(payload.rows.length);
    expect(payload.summary.affectedWorkOrderCount).toBe(payload.workOrders.provablyAffected.length);
    expect(payload.summary.unprovenWorkOrderCount).toBe(payload.workOrders.ownershipUnproven.length);
    for (const row of payload.rows) {
      expect(Array.isArray(row.classifications)).toBe(true);
      expect(row.classifications.length).toBeGreaterThan(0);
      for (const c of row.classifications) expect(payload.changeVocabulary).toContain(c);
    }
    /* Every labour and attachment row carries the full display evidence — an
       earlier cut of this envelope published a grade and lost the skill. */
    const labour = payload.rows[0].released.requirements.labour[0];
    expect(Object.keys(labour).sort()).toEqual([
      "grade", "note", "quantity", "requirementId", "sequence", "skillCode",
      "skillName", "workerType",
    ]);
    const attachment = payload.rows[0].released.requirements.attachments[0];
    expect(Object.keys(attachment).sort()).toEqual([
      "code", "name", "note", "quantity", "requirementId", "sequence",
    ]);
  });

  test("this copy of the contract has not drifted from the accepted one", () => {
    const adapter = path.join(__dirname, "..", "..", "..", "grav-cms", "components",
      "industrialEngineering", "releaseImpact", "releaseImpactAdapter.js");
    if (!fs.existsSync(adapter)) {
      /* Stated rather than skipped silently: a reader must be able to tell
         "checked and agreed" from "could not check". */
      expect(fs.existsSync(adapter)).toBe(false);
      return;
    }
    const source = fs.readFileSync(adapter, "utf8");
    const block = source.slice(source.indexOf("export const REQUIRED_FIELDS"));
    const theirs = [...block.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(theirs.length).toBeGreaterThan(40);
    expect(theirs).toEqual([...REQUIRED_FIELDS]);
  });
});

/* ══ 5. THE BOUNDARY ══════════════════════════════════════════════════════ */

describe("what this chunk does not touch", () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", "..", p), "utf8");

  test("the service writes nothing and knows nothing of PPC, barcodes or Production", () => {
    const text = read("services/industrialEngineering/ieReleaseImpact.service.js");
    const writes = /\.(create|insertMany|insertOne|updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|findOneAndReplace|replaceOne|deleteOne|deleteMany|bulkWrite|save)\s*\(/g;
    expect(text.match(writes)).toBeNull();
    for (const forbidden of [
      /require\([^)]*PPC[^)]*\)/i,
      /require\([^)]*services\/ppc[^)]*\)/i,
      /IeReleaseReceipt|ppc_ie_release_receipts/,
      /require\([^)]*[Bb]arcode[^)]*\)/,
      /require\([^)]*[Ss]can[^)]*\)/,
      /require\([^)]*[Oo]utbox[^)]*\)/,
      /OutboxEvent\./,
      /setInterval|node-cron|scheduleJob/,
    ]) expect(text).not.toMatch(forbidden);

    /* One calculator, reused. No second capacity formula lives here. */
    expect(text).toContain('require("./capacityCalculation")');
    expect(text).not.toMatch(/targetPiecesPerDay\s*=\s*[^;]*\*/);

    /* The SHARED ownership rule, not an IE copy of the membership query. */
    expect(text).toContain("styleOwnerFrom");
    expect(text).toContain('require("./workOrderStyleLink.service")');
  });

  test("the route is a GET behind viewer and company context, and nothing else was added", () => {
    const router = read("routes/CMS_Routes/IndustrialEngineering/ieRoutes.js");
    expect(router).toContain('router.get("/releases/:releaseId/impact", requireCompany, canRead');
    /* No verb was opened beside it. */
    expect(router).not.toMatch(/router\.(post|patch|put|delete)\([^)]*releases\/:releaseId/);
    expect(router).not.toMatch(/router\.delete\(/);
  });

  test("one response never mixes evidence from two current bulletin versions", async () => {
    const ctx = await released("OneCurrent");
    /* A NEWER approved version exists but the file does not point at it. The
       pointer is the answer, and every current-side fact must come from the one
       document it names — rows, fingerprint, both digests and the SAM. */
    const pointed = await moveCurrentTo(ctx, (v) => {
      v.rows[0].standardTimeMinutes = 2;
      v.totals.garmentSamMinutes = 5.5;
      v.sourceApprovalDigest = "c".repeat(64);
    });
    const decoy = await moveCurrentTo(ctx, (v) => {
      v.rows[0].standardTimeMinutes = 9;
      v.totals.garmentSamMinutes = 12.5;
      v.sourceApprovalDigest = "d".repeat(64);
    });
    /* Point the file back at the FIRST of the two. */
    await mongoose.connection.collection("ie_style_files").updateOne(
      { _id: new mongoose.Types.ObjectId(String(ctx.fileId)) },
      { $set: { currentApprovedBulletinVersionId: pointed._id, currentApprovedVersionNo: pointed.versionNo } },
    );

    const i = (await impact(ctx)).body.impact;
    expect(i.bulletin.currentBulletinVersionId).toBe(String(pointed._id));
    expect(i.bulletin.sourceFingerprint.current).toBe(pointed.sourceFingerprint);
    expect(i.bulletin.approvalDigest.current).toBe("c".repeat(64));
    expect(i.garmentSam.current).toBe(5.5);
    const row = rowFor({ impact: i }, ctx.version.rows[0].rowId);
    expect(row.current.standardTimeMinutes).toBe(2);

    const wire = JSON.stringify(i);
    expect(wire).not.toContain(String(decoy._id));
    expect(wire).not.toContain("d".repeat(64));
    expect(wire).not.toContain(decoy.sourceFingerprint);
  });

  test("the release itself is byte-identical after any number of impact reads", async () => {
    const ctx = await released("ReleaseUntouched");
    const before = await IeRelease.findById(ctx.release.releaseId).lean();
    await moveCurrentTo(ctx, (v) => { v.rows[0].standardTimeMinutes = 7; });
    for (let k = 0; k < 3; k += 1) expect((await impact(ctx)).status).toBe(200);
    const after = await IeRelease.findById(ctx.release.releaseId).lean();
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect(after.history).toHaveLength(before.history.length);
  });
});
