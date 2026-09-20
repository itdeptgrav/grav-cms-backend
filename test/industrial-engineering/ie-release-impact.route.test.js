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
        attachmentRequirements: [], labourRequirements: [],
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

const rowFor = (body, rowId) => body.impact.rows.find(
  (r) => r.released?.identity?.rowId === rowId || r.current?.identity?.rowId === rowId,
);

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

    expect(i.comparison.state).toBe("SAME_APPROVED_BULLETIN");
    expect(i.comparison.moved).toBe(false);
    expect(i.comparison.sourceFingerprintChanged).toBe(false);
    expect(i.comparison.currentBulletin.bulletinVersionId)
      .toBe(i.comparison.releasedBulletin.bulletinVersionId);
    expect(i.digests.approval.approvalDigestChanged).toBe(false);
    expect(i.digests.requirement.requirementDigestChanged).toBe(false);
    expect(i.rows).toHaveLength(4);
    expect(i.rows.every((r) => r.changes.length === 1 && r.changes[0] === "UNCHANGED")).toBe(true);
    expect(i.rowTally).toEqual({ UNCHANGED: 4 });
    expect(i.garmentSam.released).toBeCloseTo(4.5, 6);
    expect(i.garmentSam.deltaMinutes).toBe(0);
    expect(i.capacity.delta).toBe(0);
    expect(i.capacity.unknownReason).toBeNull();
    expect(i.stored).toBe(false);
  });

  test("no current approved bulletin is its own answer, not an empty comparison", async () => {
    const ctx = await released("NoCurrent");
    await mongoose.connection.collection("ie_style_files").updateOne(
      { _id: new mongoose.Types.ObjectId(String(ctx.fileId)) },
      { $unset: { currentApprovedBulletinVersionId: "", currentApprovedVersionNo: "" } },
    );
    const i = (await impact(ctx)).body.impact;

    expect(i.comparison.state).toBe("NO_CURRENT_APPROVED_BULLETIN");
    expect(i.comparison.currentBulletin).toBeNull();
    expect(i.comparison.sourceFingerprintChanged).toBeNull();
    expect(i.digests.approval.approvalDigestChanged).toBeNull();
    expect(i.digests.requirement.requirementDigestChanged).toBeNull();
    expect(i.garmentSam.current).toBeNull();
    expect(i.garmentSam.deltaMinutes).toBeNull();
    /* Never a zero standing in for an unknown. */
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.unknownReason).toBe("NO_CURRENT_APPROVED_BULLETIN");
    /* The released rows are still named — they did not stop existing. */
    expect(i.rows).toHaveLength(4);
    expect(i.rows.every((r) => r.changes[0] === "REMOVED")).toBe(true);
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
    expect(i.comparison.state).toBe("APPROVED_BULLETIN_MOVED");
    expect(i.comparison.moved).toBe(true);
    let row = rowFor({ impact: i }, ids[0]);
    expect(row.changes).toEqual(["RETIMED"]);
    const retimed = row.reasons.find((r) => r.change === "RETIMED");
    /* Both studies and both submissions, named. */
    expect(retimed.releasedMethodStudyId).toBe(String(released0.rows[0].methodStudyId));
    expect(retimed.currentMethodStudyId).not.toBe(retimed.releasedMethodStudyId);
    expect(retimed.releasedApprovedSubmissionId)
      .toBe(String(released0.rows[0].approvedSubmissionId));
    expect(retimed.currentApprovedSubmissionId).toBe("sub_retimed");
    expect(retimed.deltaMinutes).toBeCloseTo(1.4, 6);
    expect(row.released.timing.standardTimeMinutes).toBe(1);
    expect(row.current.timing.standardTimeMinutes).toBe(2.4);

    /* ── REQUIREMENT_CHANGED ─────────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      v.rows[1].requirementSnapshot.machineTypes = [{ machineType: "OL4", quantity: 2 }];
    });
    i = (await impact(ctx)).body.impact;
    row = rowFor({ impact: i }, ids[1]);
    expect(row.changes).toEqual(["REQUIREMENT_CHANGED"]);
    const reqReason = row.reasons[0];
    expect(reqReason.code).toBe("MACHINE_REQUIREMENT_EVIDENCE_MOVED");
    expect(reqReason.releasedMachineTypes).toEqual([{ machineType: "SNLS", quantity: 1 }]);
    expect(reqReason.currentMachineTypes).toEqual([{ machineType: "OL4", quantity: 2 }]);
    /* The full evidence on both sides, with the two dimensions nobody froze
       stated as uncompared rather than reported as empty. */
    expect(row.released.requirements.machine.state).toBe("CAPTURED");
    expect(row.released.requirements.machine.requirementsConfigured).toBe(true);
    expect(row.released.requirements.machine.capturedAt).toMatch(/^\d{4}-/);
    expect(row.released.requirements.attachment.state).toBe("NOT_CAPTURED");
    expect(row.current.requirements.labour.state).toBe("NOT_CAPTURED");
    expect(i.requirementCoverage).toEqual({
      compared: ["MACHINE"],
      uncompared: ["ATTACHMENT", "LABOUR"],
      reason: "NOT_FROZEN_BY_ANY_BULLETIN_VERSION",
      requiredUpstreamContract: "BULLETIN_ROW_ATTACHMENT_AND_LABOUR_REQUIREMENT_SNAPSHOT",
    });

    /* A requirement going from configured to unconfigured is a change too —
       "nobody has decided" is not the same fact as "requires nothing". */
    await moveCurrentTo(ctx, (v) => {
      v.rows[1].requirementSnapshot.requirementsConfigured = false;
    });
    i = (await impact(ctx)).body.impact;
    expect(rowFor({ impact: i }, ids[1]).changes).toEqual(["REQUIREMENT_CHANGED"]);

    /* ── RESEQUENCED ─────────────────────────────────────────────────── */
    await moveCurrentTo(ctx, (v) => {
      v.rows[2].sequence = 9;
    });
    i = (await impact(ctx)).body.impact;
    row = rowFor({ impact: i }, ids[2]);
    expect(row.changes).toEqual(["RESEQUENCED"]);
    expect(row.reasons[0]).toMatchObject({ releasedSequence: 3, currentSequence: 9 });

    /* ── OPERATION_REPLACED ──────────────────────────────────────────── */
    const replacement = new mongoose.Types.ObjectId();
    await moveCurrentTo(ctx, (v) => {
      v.rows[3].ieOperationId = String(replacement);
      v.rows[3].operationCode = "OP-REPLACEMENT";
    });
    i = (await impact(ctx)).body.impact;
    row = rowFor({ impact: i }, ids[3]);
    expect(row.changes).toEqual(["OPERATION_REPLACED"]);
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
    expect(rowFor({ impact: i }, ids[2]).changes).toEqual(["REMOVED"]);
    expect(rowFor({ impact: i }, freshRowId).changes).toEqual(["ADDED"]);
    /* ── AND POSITION PROVES NOTHING ─────────────────────────────────
       Removing row three shifted row four's index, and it is still UNCHANGED:
       a positional comparison would have called it replaced AND re-timed. */
    expect(rowFor({ impact: i }, ids[3]).changes).toEqual(["UNCHANGED"]);
    expect(rowFor({ impact: i }, ids[0]).changes).toEqual(["UNCHANGED"]);
  });

  test("simultaneous changes stay simultaneous", async () => {
    const ctx = await released("Simultaneous");
    const ids = ctx.version.rows.map((r) => r.rowId);
    await moveCurrentTo(ctx, (v) => {
      v.rows[0].standardTimeMinutes = 3.3;
      v.rows[0].approvedSubmissionId = "sub_simultaneous";
      v.rows[0].requirementSnapshot.machineTypes = [{ machineType: "FOA", quantity: 3 }];
      v.rows[0].sequence = 7;
      v.rows[0].ieOperationId = String(new mongoose.Types.ObjectId());
    });
    const i = (await impact(ctx)).body.impact;
    const row = rowFor({ impact: i }, ids[0]);

    /* All four, and a reason for each. Not one "primary" result with the other
       three hidden behind an arbitrary precedence. */
    expect(new Set(row.changes)).toEqual(new Set([
      "OPERATION_REPLACED", "RETIMED", "REQUIREMENT_CHANGED", "RESEQUENCED",
    ]));
    expect(row.changes).toHaveLength(4);
    expect(row.reasons).toHaveLength(4);
    expect(new Set(row.reasons.map((r) => r.change))).toEqual(new Set(row.changes));
    for (const r of row.reasons) {
      expect(typeof r.code).toBe("string");
      expect(r.message.length).toBeGreaterThan(10);
    }
    expect(i.rowTally.RETIMED).toBe(1);
    expect(i.rowTally.RESEQUENCED).toBe(1);
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

    expect(row.changes).toEqual(["UNCHANGED"]);
    expect(row.changes).not.toContain("OPERATION_REPLACED");
    expect(row.labelsChanged).toBe(true);
    expect(row.reasons[0].code).toBe("LABEL_ONLY_RENAME");
    expect(row.released.identity.ieOperationId).toBe(row.current.identity.ieOperationId);
    expect(row.reasons[0].releasedOperationName).toBe("Operation 1");
    expect(row.reasons[0].currentOperationName).toBe("Attach collar (revised wording)");
    /* And the row whose code was borrowed is untouched by the collision. */
    expect(rowFor({ impact: i }, ids[1]).changes).toEqual(["UNCHANGED"]);
  });

  test("the two digests move independently", async () => {
    const ctx = await released("Digests");

    await moveCurrentTo(ctx, (v) => { v.sourceApprovalDigest = "a".repeat(64); });
    let i = (await impact(ctx)).body.impact;
    expect(i.digests.approval.approvalDigestChanged).toBe(true);
    expect(i.digests.requirement.requirementDigestChanged).toBe(false);
    expect(i.digests.approval.released).not.toBe(i.digests.approval.current);

    await moveCurrentTo(ctx, (v) => { v.sourceRequirementDigest = "b".repeat(64); });
    i = (await impact(ctx)).body.impact;
    expect(i.digests.approval.approvalDigestChanged).toBe(false);
    expect(i.digests.requirement.requirementDigestChanged).toBe(true);
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
    expect(i.garmentSam.deltaMinutes).toBe(0.3);

    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 4.1; });
    i = (await impact(ctx)).body.impact;
    expect(i.garmentSam.deltaMinutes).toBe(-0.4);
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
    expect(i.capacity.unknownReason).toBeNull();
  });

  test("an underivable capacity target is null with a typed reason, never zero", async () => {
    const ctx = await released("CapUnknown");
    /* A current bulletin whose garment SAM is nought — the calculator refuses,
       and the refusal travels rather than being flattened to a target of 0. */
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 0; });
    let i = (await impact(ctx)).body.impact;
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.delta).toBeNull();
    expect(i.capacity.unknownReason).toBe("CURRENT_CAPACITY_UNAVAILABLE");
    expect(i.capacity.unavailableReasons).toContain("NO_GARMENT_SAM");
    expect(i.garmentSam.current).toBe(0);
    expect(i.garmentSam.deltaMinutes).toBe(-4.5);

    /* And a release whose own frozen assumptions are incomplete. */
    await moveCurrentTo(ctx, (v) => { v.totals.garmentSamMinutes = 4.5; });
    await mongoose.connection.collection("ie_releases").updateOne(
      { _id: new mongoose.Types.ObjectId(ctx.release.releaseId) },
      { $unset: { "source.capacityStandard.inputs.plannedOperatorCount": "" } },
    );
    i = (await impact(ctx)).body.impact;
    expect(i.capacity.current).toBeNull();
    expect(i.capacity.unknownReason).toBe("RELEASED_ASSUMPTIONS_INCOMPLETE");
  });
});

/* ══ 4. WORK ORDERS ═══════════════════════════════════════════════════════ */

describe("which work orders are provably affected", () => {
  test("only a direct style link with proved company ownership counts", async () => {
    const ctx = await released("WoProved");
    const i = (await impact(ctx)).body.impact;

    expect(i.workOrders.affected).toHaveLength(1);
    expect(i.workOrders.affected[0]).toEqual({
      workOrderId: String(ctx.workOrder._id),
      workOrderNumber: ctx.workOrder.workOrderNumber,
      candidateSource: "DIRECT_STYLE_LINK",
      status: "planned",
      provenBy: { styleLink: "SAMPLE_STYLE_ID", ownership: "SALES_JOURNEY" },
    });
    expect(i.workOrders.unprovable).toEqual([]);
    expect(i.workOrders.readOnly).toBe(true);
    expect(i.workOrders.writesProduction).toBe(false);
  });

  test("legacy, ambiguous, parentless and foreign candidates are named, never dropped", async () => {
    const ctx = await released("WoUnprovable");

    /* LEGACY — the same product, no style reference at all. The Chunk 1C
       audit's 141: reachable, recognisable and unprovable. */
    const legacy = await WorkOrder.create({
      workOrderNumber: `WO-LEGACY-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      quantity: 100, originalQuantity: 100, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Someone Else Ltd",
    });

    /* AMBIGUOUS PARENTAGE — a style naming a journey that carries no company. */
    const danglingJourney = await SalesJourney.create({
      journeyId: `SJ-DANGLE-${++seq}`, accountId: new mongoose.Types.ObjectId(),
      ownerId: new mongoose.Types.ObjectId(), ownerName: "O", name: "Dangling", isActive: true,
    });
    const ambiguousStyle = await SampleStyle.create({
      sampleStyleId: `SS-AMB-${++seq}`, productName: "Tee", styleCode: `ST-AMB-${seq}`,
      journeyId: danglingJourney._id, sourceStockItemId: ctx.stockItem._id,
      materials: { status: "pending", rawItems: [] },
    });
    const ambiguous = await WorkOrder.create({
      workOrderNumber: `WO-AMBIG-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      sampleStyleId: ambiguousStyle._id,
      quantity: 100, originalQuantity: 100, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Someone Else Ltd",
    });

    /* NO PARENT — a style with neither journey nor enquiry. */
    const orphanStyle = await SampleStyle.create({
      sampleStyleId: `SS-ORPH-${++seq}`, productName: "Tee", styleCode: `ST-ORPH-${seq}`,
      sourceStockItemId: ctx.stockItem._id, materials: { status: "pending", rawItems: [] },
    });
    const orphan = await WorkOrder.create({
      workOrderNumber: `WO-ORPHAN-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      sampleStyleId: orphanStyle._id,
      quantity: 100, originalQuantity: 100, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Someone Else Ltd",
    });

    /* FOREIGN — a style that belongs, provably, to somebody else. */
    const them = await released("WoForeign");
    const foreign = await WorkOrder.create({
      workOrderNumber: `WO-FOREIGN-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      sampleStyleId: them.style._id,
      quantity: 100, originalQuantity: 100, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Someone Else Ltd",
    });

    const i = (await impact(ctx)).body.impact;
    const by = new Map(i.workOrders.unprovable.map((u) => [u.workOrderId, u]));

    expect(i.workOrders.affected.map((a) => a.workOrderId)).toEqual([String(ctx.workOrder._id)]);
    expect(i.workOrders.examinedCount).toBe(5);
    expect(by.size).toBe(4);

    expect(by.get(String(legacy._id))).toMatchObject({
      reason: "NO_STYLE_LINK", candidateSource: "SHARED_STOCK_ITEM",
    });
    expect(by.get(String(ambiguous._id))).toMatchObject({
      reason: "DIFFERENT_STYLE", ownershipReason: "JOURNEY_UNPROVABLE",
    });
    expect(by.get(String(orphan._id))).toMatchObject({
      reason: "DIFFERENT_STYLE", ownershipReason: "NO_PARENT",
    });
    expect(by.get(String(foreign._id))).toMatchObject({ reason: "DIFFERENT_STYLE" });

    /* ── AND NOTHING ABOUT THE OTHER COMPANY LEAVES ──────────────────── */
    const wire = JSON.stringify(i.workOrders);
    expect(wire).not.toContain(String(them.co._id));
    expect(wire).not.toContain(String(them.style._id));
    expect(wire).not.toContain("Someone Else Ltd");
    expect(wire).not.toContain("Northwind Apparel Ltd");
    for (const row of [...i.workOrders.affected, ...i.workOrders.unprovable]) {
      expect(Object.keys(row)).not.toContain("companyId");
      expect(Object.keys(row)).not.toContain("sampleStyleId");
      expect(Object.keys(row)).not.toContain("customerName");
    }
  });

  test("a work order whose linked style no longer exists is reported, not hidden", async () => {
    const ctx = await released("WoMissingStyle");
    const ghost = await WorkOrder.create({
      workOrderNumber: `WO-GHOST-${++seq}`, stockItemId: ctx.stockItem._id,
      stockItemName: ctx.stockItem.name, stockItemReference: ctx.stockItem.reference,
      sampleStyleId: new mongoose.Types.ObjectId(),
      quantity: 100, originalQuantity: 100, status: "planned",
      timeline: { plannedStartDate: new Date("2026-10-01"), plannedEndDate: new Date("2026-10-20") },
      customerId: new mongoose.Types.ObjectId(), customerName: "Ghost Ltd",
    });
    const i = (await impact(ctx)).body.impact;
    const row = i.workOrders.unprovable.find((u) => u.workOrderId === String(ghost._id));
    expect(row).toMatchObject({ reason: "STYLE_NOT_FOUND", ownershipReason: "STYLE_RECORD_MISSING" });
  });

  test("the company the ORDER belongs to is the acting one, or it is unprovable", async () => {
    /* The release's own style moved to another company's journey after the
       release was issued: the order still links the style, and the company can
       no longer be proved to be this one. */
    const ctx = await released("WoCompanyMoved");
    const elsewhere = await Acc_Company.create({
      companyName: `Elsewhere ${++seq}`, booksFromDate: new Date("2026-04-01"),
    });
    await SalesJourney.updateOne({ _id: ctx.journey._id }, { $set: { companyId: elsewhere._id } });

    const i = (await impact(ctx)).body.impact;
    expect(i.workOrders.affected).toEqual([]);
    const row = i.workOrders.unprovable.find((u) => u.workOrderId === String(ctx.workOrder._id));
    expect(row).toMatchObject({ reason: "COMPANY_MISMATCH", candidateSource: "DIRECT_STYLE_LINK" });
    expect(JSON.stringify(i.workOrders)).not.toContain(String(elsewhere._id));
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
    expect(i.comparison.currentBulletin.bulletinVersionId).toBe(String(pointed._id));
    expect(i.comparison.currentBulletin.sourceFingerprint).toBe(pointed.sourceFingerprint);
    expect(i.digests.approval.current).toBe("c".repeat(64));
    expect(i.garmentSam.current).toBe(5.5);
    const row = rowFor({ impact: i }, ctx.version.rows[0].rowId);
    expect(row.current.timing.standardTimeMinutes).toBe(2);

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
